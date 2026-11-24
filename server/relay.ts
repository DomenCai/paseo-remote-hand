import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import { openClientSecureChannel, openDaemonSecureChannel, type SecureChannel, type SecureChannelEvents } from "@getpaseo/relay/e2ee";
import { WebSocket } from "ws";
import { z } from "zod";
import type { Target } from "./identity.ts";
import { MAX_FRAME_BYTES, Peer, ProtocolError } from "./protocol.ts";

type DaemonKey = Parameters<typeof openDaemonSecureChannel>[1]["daemonKeyPair"];
type Transport = Parameters<typeof openDaemonSecureChannel>[0];
type EndpointStatus = "connecting" | "connected" | "disconnected";

const CONTROL_STALE_MS = 30_000;
export const MAX_WIRE_BYTES = 2 * MAX_FRAME_BYTES;
const controlSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sync"), connectionIds: z.array(z.string().min(1)) }),
  z.object({ type: z.literal("connected"), connectionId: z.string().min(1) }),
  z.object({ type: z.literal("disconnected"), connectionId: z.string().min(1) }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("pong") }),
]);

export function reconnectDelay(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)) * (0.8 + Math.random() * 0.2);
}

function relaySocket(target: Target, role: "server" | "client", connectionId?: string): WebSocket {
  const url = buildRelayWebSocketUrl({
    endpoint: target.relay, useTls: true, serverId: target.serverId, role, connectionId, version: 2,
  });
  const options = {
    handshakeTimeout: 8_000, perMessageDeflate: false, maxPayload: MAX_WIRE_BYTES,
    autoSelectFamilyAttemptTimeout: 5_000,
  };
  const socket = new WebSocket(url, options);
  return socket;
}

export function protectedPeer(socket: WebSocket, key: { daemonKeyPair: DaemonKey } | { daemonPublicKeyB64: string }): Peer {
  socket.binaryType = "arraybuffer";
  let channel: SecureChannel | undefined;
  const early: string[] = [];
  const transport: Transport = {
    onmessage: null,
    onerror: null,
    onclose: null,
    send: (data) => new Promise<void>((resolve, reject) => {
      if (socket.bufferedAmount > 4 * MAX_WIRE_BYTES) {
        reject(new ProtocolError("busy"));
        return;
      }
      socket.send(data, (error) => error ? reject(error) : resolve());
    }),
    close: (code, reason) => socket.close(code, reason),
  };
  const peer = new Peer(
    (text) => channel!.send(text),
    () => {
      socket.close();
      if (socket.readyState !== WebSocket.CLOSED)
        setTimeout(() => socket.terminate(), 500).unref();
    },
  );
  socket.on("message", (data, isBinary) => {
    if (isBinary && !(data instanceof ArrayBuffer)) {
      peer.close(new ProtocolError("invalid"));
      return;
    }
    transport.onmessage?.({ data: isBinary ? data as ArrayBuffer : data.toString(), isBinary });
  });
  socket.on("error", (error) => {
    transport.onerror?.(error);
    peer.close();
  });
  socket.on("close", (code, reason) => {
    transport.onclose?.(code, reason.toString());
    peer.close();
  });

  const events: SecureChannelEvents = {
    onmessage(data) {
      if (typeof data !== "string") peer.close(new ProtocolError("invalid"));
      else if (channel) peer.receive(data);
      else if (early.length < 4) early.push(data);
      else peer.close(new ProtocolError("invalid"));
    },
    onerror() { peer.close(new ProtocolError("identity", "Protected transport handshake or record verification failed.")); },
  };
  const activate = (secure: SecureChannel) => {
    if (peer.failure) return;
    channel = secure;
    peer.start();
    for (const text of early) peer.receive(text);
    early.length = 0;
  };
  const rejectHandshake = () => peer.close(new ProtocolError("identity", "Could not verify the protected endpoint."));
  if ("daemonKeyPair" in key) {
    // relay 会在数据 socket 打开后立即转发缓存的 hello。先装接收器。
    void openDaemonSecureChannel(transport, { ...key, minimumMode: "protected", events })
      .then(activate, rejectHandshake);
  } else {
    socket.once("open", () => {
      let markOpen!: () => void;
      const opened = new Promise<void>((resolve) => { markOpen = resolve; });
      const setup = openClientSecureChannel(transport, {
        ...key, minimumMode: "protected", events: { ...events, onopen: markOpen },
      });
      void Promise.race([Promise.all([setup, opened]), peer.closed]).then((result) => {
        if (Array.isArray(result)) activate(result[0]);
      }, rejectHandshake);
    });
  }
  return peer;
}

export function connectBrain(target: Target, signal: AbortSignal): Peer {
  signal.throwIfAborted();
  const peer = protectedPeer(relaySocket(target, "client"), { daemonPublicKeyB64: target.publicKeyB64 });
  const abort = () => peer.close();
  signal.addEventListener("abort", abort, { once: true });
  void peer.closed.then(() => signal.removeEventListener("abort", abort));
  return peer;
}

export function startRelay(
  target: Target,
  daemonKeyPair: DaemonKey,
  accept: (peer: Peer) => void,
  status: (value: EndpointStatus) => void,
): () => void {
  const data = new Map<string, WebSocket>();
  let control: WebSocket | undefined;
  let retry: NodeJS.Timeout | undefined;
  let attempt = 0;
  let stopped = false;

  function attach(id: string) {
    if (data.has(id)) return;
    const socket = relaySocket(target, "server", id);
    data.set(id, socket);
    socket.once("close", () => { if (data.get(id) === socket) data.delete(id); });
    accept(protectedPeer(socket, { daemonKeyPair }));
  }

  function connect() {
    status("connecting");
    const socket = control = relaySocket(target, "server");
    let lastSeen = Date.now();
    const ready = setTimeout(() => socket.terminate(), 10_000);
    const keepalive = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastSeen > CONTROL_STALE_MS) socket.terminate();
      else socket.ping();
    }, 10_000);
    socket.on("error", () => socket.terminate());
    socket.on("pong", () => { lastSeen = Date.now(); });
    socket.on("message", (raw, binary) => {
      if (stopped || binary) return;
      let value: unknown;
      try { value = JSON.parse(raw.toString()); } catch { return; }
      const parsed = controlSchema.safeParse(value);
      if (!parsed.success) return;
      lastSeen = Date.now();
      const msg = parsed.data;
      if (msg.type === "sync") {
        clearTimeout(ready);
        attempt = 0;
        const live = new Set(msg.connectionIds);
        for (const [id, conn] of data) if (!live.has(id)) conn.terminate();
        for (const id of live) attach(id);
        status("connected");
      } else if (msg.type === "connected") {
        attach(msg.connectionId);
      } else if (msg.type === "disconnected") {
        data.get(msg.connectionId)?.terminate();
      } else if (msg.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
      }
    });
    socket.once("close", () => {
      clearInterval(keepalive);
      clearTimeout(ready);
      if (stopped) return;
      status("disconnected");
      retry = setTimeout(connect, reconnectDelay(attempt++));
    });
  }

  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    control?.terminate();
    for (const socket of data.values()) socket.terminate();
    data.clear();
  };
}
