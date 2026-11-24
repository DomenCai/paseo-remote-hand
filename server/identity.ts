import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { importPublicKey } from "@getpaseo/relay/e2ee";
import { z } from "zod";
import { RelayAddressSchema } from "../shared/settings.ts";

export const INVITE_TTL_MS = 5 * 60_000;
export const randomToken = () => randomBytes(32).toString("base64url");
export const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const brainFingerprint = (publicKeyB64: string) => digest(importPublicKey(publicKeyB64));

function base64url(text: string, size: number): Buffer | undefined {
  const bytes = Buffer.from(text, "base64url");
  if (bytes.length === size && bytes.toString("base64url") === text) return bytes;
}

const pairCodeSchema = z.object({
  v: z.literal(1),
  relay: RelayAddressSchema,
  serverId: z.uuid(),
  publicKeyB64: z.string().length(44),
  inviteSecret: z.string().length(43),
  expiresAt: z.iso.datetime(),
});
export type PairCode = z.infer<typeof pairCodeSchema>;
export type Target = Pick<PairCode, "relay" | "serverId" | "publicKeyB64">;

export function encodePairCode(value: PairCode): string {
  return "rh1." + Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function parsePairCode(code: string): PairCode {
  let parsed: PairCode;
  try {
    if (!/^rh1\.[\w-]{1,2048}$/.test(code)) throw new Error();
    const encoded = code.slice(4);
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new Error();
    parsed = pairCodeSchema.parse(JSON.parse(bytes.toString("utf8")));
    importPublicKey(parsed.publicKeyB64);
    if (!base64url(parsed.inviteSecret, 32)) throw new Error();
  } catch {
    throw new Error("Invalid Remote hand pairing code.");
  }
  if (Date.parse(parsed.expiresAt) <= Date.now()) throw new Error("This invitation has expired.");
  return parsed;
}

export const DeviceProofSchema = z.object({
  publicKey: z.string().length(59),
  signature: z.string().length(86),
});
export type DeviceProof = z.infer<typeof DeviceProofSchema>;

export const DeviceKeySchema = z.object({
  publicKey: z.string().length(59),
  privateKey: z.string().length(64),
});
export type DeviceKey = z.infer<typeof DeviceKeySchema>;

export function newDeviceKey(): DeviceKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
  };
}

function transcript(fingerprint: string, challenge: string, invitation?: string): Buffer {
  return Buffer.from(JSON.stringify([
    "remote-hand/v1",
    invitation === undefined ? "reconnect" : "pair",
    fingerprint,
    challenge,
    ...(invitation === undefined ? [] : [digest(invitation)]),
  ]));
}

export function signDevice(key: DeviceKey, fingerprint: string, challenge: string, invitation?: string): DeviceProof {
  const privateKey = createPrivateKey({
    key: Buffer.from(key.privateKey, "base64url"), type: "pkcs8", format: "der",
  });
  const signature = sign(null, transcript(fingerprint, challenge, invitation), privateKey);
  return { publicKey: key.publicKey, signature: signature.toString("base64url") };
}

// 设备 ID 从验证过的公钥生成，不能通过提交别人的 ID 冒充。
export function verifyDevice(proof: DeviceProof, fingerprint: string, challenge: string, invitation?: string): string | undefined {
  const bytes = base64url(proof.publicKey, 44);
  const signature = base64url(proof.signature, 64);
  if (!bytes || !signature) return;
  try {
    const publicKey = createPublicKey({ key: bytes, type: "spki", format: "der" });
    if (publicKey.asymmetricKeyType === "ed25519" &&
        publicKey.export({ type: "spki", format: "der" }).equals(bytes) &&
        verify(null, transcript(fingerprint, challenge, invitation), publicKey, signature))
      return digest(bytes);
  } catch {
    // 对所有非法公钥和签名返回同一个认证结果。
  }
}
