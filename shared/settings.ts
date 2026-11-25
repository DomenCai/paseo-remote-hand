import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_RELAY = "relay.paseo.sh:443";
export const RISKS_NOT_ACKNOWLEDGED =
  "RISKS_NOT_ACKNOWLEDGED: Confirm all current risks before adding this brain.";

const emptyInput = z.object({});
const noOutput = z.null();
const nonEmptyString = z.string().min(1);
const nameInput = z.string().trim().min(1);
const timestamp = z.iso.datetime();
const hostname = z.hostname();
const ipv4 = z.ipv4();
const ipv6 = z.ipv6();

export const RelayAddressSchema = z.string().trim().refine((address) => {
  const match = /^(?:([^:]+)|\[([^\]]+)\]):([0-9]{1,5})$/.exec(address);
  if (!match) return false;
  const [, host, literalIpv6, port] = match;
  if (Number(port) < 1 || Number(port) > 65535) return false;
  if (literalIpv6) return ipv6.safeParse(literalIpv6).success;
  if (!host) return false;
  return (/^[\d.]+$/.test(host) ? ipv4 : hostname).safeParse(host).success;
}, "Expected a relay address in host:port form (use [IPv6]:port for IPv6).");

/**
 * 配对码：`rh1.` + 无填充 base64url 编码的 UTF-8 JSON：
 * `{ v: 1, relay, serverId, publicKeyB64, inviteSecret, expiresAt }`。
 * `publicKeyB64` 是 32 字节的 X25519 公钥，使用 relay SDK 的标准带填充 base64；
 * `inviteSecret` 是 32 个随机字节，以无填充 base64url 编码；`expiresAt` 为 UTC ISO 8601 字符串。
 * 邀请短时有效且只能消费一次；整段码都是秘密，不写日志或设置，不放进 relay 路由 URL。
 * 格式解析、期限验证和邀请消费由服务端实现。
 */
const pairingCode = z.string().trim().min(1);

export const BrainOsSchema = z.enum(["darwin", "linux", "win32", "unknown"]);
export const BrainPolicySchema = z.enum(["restricted", "full"]);
export const BrainStatusSchema = z.enum([
  "connecting", "connected", "disconnected", "unverified", "revoked",
]);
export const RiskSchema = z.object({ code: nonEmptyString, message: nonEmptyString });

export const BrainPreviewSchema = z.object({
  brainName: nonEmptyString,
  os: BrainOsSchema,
  relay: RelayAddressSchema,
  risks: z.array(RiskSchema),
});

export const BrainSchema = z.object({
  brainId: nonEmptyString,
  name: nonEmptyString,
  os: BrainOsSchema,
  relay: RelayAddressSchema,
  status: BrainStatusSchema,
  transport: z.enum(["relay", "direct"]).nullable(),
  policy: BrainPolicySchema,
  projects: z.array(z.object({ root: nonEmptyString, grantedAt: timestamp })),
  lastError: z.string().optional(),
  // 直连回落 relay 后下次自动重试的时间（Unix 毫秒），已到时表示正在重试；省略且有 lastError 表示不会自动重试，
  // 原因见 lastError，等任一端改直连设置再试。
  directRetryAt: z.int().nonnegative().optional(),
  // 取自 brain；id 形如 <brainId>/<provider>/<model>。
  models: z.array(z.object({ id: nonEmptyString, label: nonEmptyString })).optional(),
});

export const EndpointSchema = z.object({
  relay: RelayAddressSchema,
  serverId: nonEmptyString,
  fingerprint: nonEmptyString,
  // 收到 relay 的首次同步后才算 connected。
  status: z.enum(["connecting", "connected", "disconnected"]),
  lastError: z.string().optional(),
  risks: z.array(RiskSchema),
});

export const DeviceSchema = z.object({
  deviceId: nonEmptyString,
  name: nonEmptyString,
  lastSeenAt: timestamp,
  online: z.boolean(),
  activeSessions: z.int().nonnegative(),
});

export const AccessSchema = z.object({
  // 空数组表示允许所有 provider。
  providers: z.array(nonEmptyString),
  maxConcurrentPerDevice: z.int().positive(),
});

export const DirectPeerSchema = z.string().trim().max(300).transform((value, ctx) => {
  const match = /^(tcp|udp):\/\/(.+)\/?$/.exec(value);
  const address = match && RelayAddressSchema.safeParse(match[2].replace(/\/$/, ""));
  if (match && address && address.success) return `${match[1]}://${address.data}`;
  ctx.addIssue({ code: "custom", message: "Expected tcp://host:port or udp://host:port." });
  return z.NEVER;
});

export const DirectSettingsSchema = z.object({
  enabled: z.boolean(),
  peers: z.array(DirectPeerSchema).max(16).transform((peers) => [...new Set(peers)]),
});

export type DirectSettings = z.infer<typeof DirectSettingsSchema>;
export const DEFAULT_DIRECT: DirectSettings = { enabled: false, peers: [] };

// 每台机器的一份配置，同时用于 hand 和 brain。两端都启用并配置会合地址才尝试直连。
export const direct = {
  get: defineRpc({ name: "direct.get", input: emptyInput, output: DirectSettingsSchema }),
  set: defineRpc({ name: "direct.set", input: DirectSettingsSchema, output: noOutput }),
  watch: defineSubscription({ name: "direct.watch", input: emptyInput, event: DirectSettingsSchema }),
};

export type BrainOs = z.infer<typeof BrainOsSchema>;
export type BrainPolicy = z.infer<typeof BrainPolicySchema>;
export type BrainStatus = z.infer<typeof BrainStatusSchema>;
export type Risk = z.infer<typeof RiskSchema>;
export type BrainPreview = z.infer<typeof BrainPreviewSchema>;
export type Brain = z.infer<typeof BrainSchema>;
export type Endpoint = z.infer<typeof EndpointSchema>;
export type Device = z.infer<typeof DeviceSchema>;
export type Access = z.infer<typeof AccessSchema>;

const brainIdentity = z.object({ brainId: nonEmptyString });

export const brains = {
  // 验证配对码中的公钥并读取 brain 的自我描述；不提交邀请秘密，也不消费邀请。
  preview: defineRpc({
    name: "brains.preview",
    input: z.object({ pairingCode }),
    output: BrainPreviewSchema,
  }),
  // 提交前核对当前风险；若有遗漏，以 Error(RISKS_NOT_ACKNOWLEDGED) 拒绝，且不消费邀请。
  add: defineRpc({
    name: "brains.add",
    input: z.object({ pairingCode, name: nameInput, acknowledgedRiskCodes: z.array(nonEmptyString) }),
    output: brainIdentity,
  }),
  rename: defineRpc({
    name: "brains.rename",
    input: brainIdentity.extend({ name: nameInput }),
    output: noOutput,
  }),
  // 始终移除本地身份；remoteRevoked 表示 brain 已确认远端身份不再有效。
  remove: defineRpc({
    name: "brains.remove",
    input: brainIdentity,
    output: z.object({ remoteRevoked: z.boolean() }),
  }),
  setPolicy: defineRpc({
    name: "brains.set-policy",
    input: brainIdentity.extend({ policy: BrainPolicySchema }),
    output: noOutput,
  }),
  // 保留 brain 公钥和本机设备身份，仅替换 relay 并重连。
  setRelay: defineRpc({
    name: "brains.set-relay",
    input: brainIdentity.extend({ relay: RelayAddressSchema }),
    output: noOutput,
  }),
  // 跳过直连退避等待，立即重新协商；没有在等待的自动重试时不做任何事。
  retryDirect: defineRpc({
    name: "brains.retry-direct",
    input: brainIdentity,
    output: noOutput,
  }),
  revokeProject: defineRpc({
    name: "brains.revoke-project",
    input: brainIdentity.extend({ root: nonEmptyString }),
    output: noOutput,
  }),
  // 订阅开始时和每次变化时都发送完整列表。
  watch: defineSubscription({
    name: "brains.watch",
    input: emptyInput,
    event: z.array(BrainSchema),
  }),
};

export const endpoint = {
  get: defineRpc({ name: "endpoint.get", input: emptyInput, output: EndpointSchema }),
  watch: defineSubscription({ name: "endpoint.watch", input: emptyInput, event: EndpointSchema }),
  setRelay: defineRpc({
    name: "endpoint.set-relay",
    input: z.object({ relay: RelayAddressSchema }),
    output: noOutput,
  }),
};

export const devices = {
  // 配对码仅出现在本次响应，不出现在设备快照。
  invite: defineRpc({
    name: "devices.invite",
    input: z.object({ label: nameInput.optional() }),
    output: z.object({ pairingCode, expiresAt: timestamp }),
  }),
  // 成功时撤销已生效。
  revoke: defineRpc({
    name: "devices.revoke",
    input: z.object({ deviceId: nonEmptyString }),
    output: noOutput,
  }),
  // 订阅开始时和每次变化时都发送完整列表。
  watch: defineSubscription({
    name: "devices.watch",
    input: emptyInput,
    event: z.array(DeviceSchema),
  }),
};

export const access = {
  get: defineRpc({ name: "access.get", input: emptyInput, output: AccessSchema }),
  set: defineRpc({ name: "access.set", input: AccessSchema, output: noOutput }),
};
