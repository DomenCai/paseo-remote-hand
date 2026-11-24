import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { exportPublicKey, exportSecretKey, generateKeyPair } from "@getpaseo/relay/e2ee";
import { z } from "zod";
import { AccessSchema, BrainOsSchema, BrainPolicySchema, BrainSchema, DEFAULT_RELAY, RelayAddressSchema } from "../shared/settings.ts";
import { DeviceKeySchema } from "./identity.ts";

const StateSchema = z.object({
  version: z.literal(1),
  endpoint: z.object({
    relay: RelayAddressSchema,
    serverId: z.uuid(),
    publicKeyB64: z.string().length(44),
    secretKeyB64: z.string().length(44),
  }),
  devices: z.record(z.string(), z.object({ name: z.string(), lastSeenAt: z.iso.datetime() })),
  invites: z.record(z.string(), z.object({ label: z.string().optional(), expiresAt: z.iso.datetime() })),
  access: AccessSchema,
  brains: z.record(z.string(), z.object({
    relay: RelayAddressSchema,
    serverId: z.uuid(),
    publicKeyB64: z.string().length(44),
    name: z.string(),
    os: BrainOsSchema,
    policy: BrainPolicySchema,
    projects: BrainSchema.shape.projects,
    key: DeviceKeySchema,
    revoked: z.boolean(),
  })),
});

type State = z.infer<typeof StateSchema>;
export type StoredBrain = State["brains"][string];

export function pluginStateDir(): string {
  const raw = process.env.PASEO_HOME ?? "~/.paseo";
  const home = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  return resolve(home, "plugin-data", "remote-hand");
}

export class StateStore {
  #state: State;
  readonly #file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.#file = join(dir, "state.json");
    if (process.platform !== "win32") chmodSync(dir, 0o700);
    if (existsSync(this.#file)) {
      if (process.platform !== "win32") chmodSync(this.#file, 0o600);
      try {
        this.#state = StateSchema.parse(JSON.parse(readFileSync(this.#file, "utf8")));
      } catch {
        throw new Error("Invalid Remote hand state file.");
      }
    } else {
      const keys = generateKeyPair();
      this.#state = {
        version: 1,
        endpoint: {
          relay: DEFAULT_RELAY, serverId: randomUUID(),
          publicKeyB64: exportPublicKey(keys.publicKey), secretKeyB64: exportSecretKey(keys.secretKey),
        },
        devices: {}, invites: {}, brains: {},
        access: { providers: [], maxConcurrentPerDevice: 1 },
      };
      this.#save(this.#state);
    }
  }

  get current(): Readonly<State> {
    return this.#state;
  }

  // 同一插件进程内没有 await：消费邀请、登记设备、更新内存是同一次提交。
  update(change: (state: State) => void): void {
    const next = structuredClone(this.#state);
    change(next);
    this.#save(next);
    this.#state = next;
  }

  #save(next: State) {
    const temp = `${this.#file}.${randomUUID()}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      try {
        writeFileSync(fd, JSON.stringify(next) + "\n", "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.#file);
    } catch (error) {
      unlinkSync(temp);
      throw error;
    }
  }
}
