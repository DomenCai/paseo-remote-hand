import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { resume } from "../hand.ts";
import type { DeviceKey } from "../identity.ts";
import type { Peer } from "../protocol.ts";
import { MAX_WIRE_BYTES, protectedPeer } from "../relay.ts";

const loopback = "127.0.0.1";
const endpoint = "/remote-hand/direct";
const options = { maxPayload: MAX_WIRE_BYTES, perMessageDeflate: false } as const;
type BrainKeys = Extract<Parameters<typeof protectedPeer>[1], { daemonKeyPair: unknown }>["daemonKeyPair"];

/** accept 应走现有 BrainService.accept，以沿用设备授权、撤销和协议。 */
export async function listenDirect(
  daemonKeyPair: BrainKeys, accept: (peer: Peer) => void, signal: AbortSignal,
): Promise<{ port: number; close: () => Promise<void> }> {
  signal.throwIfAborted();
  const http = createServer((_req, res) => { res.writeHead(404).end(); });
  const sockets = new Set<Socket>();
  const peers = new Set<Peer>();
  http.maxConnections = 8;
  http.setTimeout(10_000);
  http.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const ws = new WebSocketServer({ ...options, server: http, path: endpoint });
  ws.on("connection", (socket) => {
    const peer = protectedPeer(socket, { daemonKeyPair });
    peers.add(peer);
    void peer.closed.then(() => peers.delete(peer));
    try { accept(peer); } catch { peer.close(); }
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= new Promise<void>((resolve) => {
    signal.removeEventListener("abort", abort);
    ws.close(() => {});
    for (const peer of peers) peer.close();
    for (const socket of sockets) socket.destroy();
    http.close(() => resolve());
  });
  const abort = () => { void close(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      // ws 会转发 HTTP 监听错误。
      ws.once("error", reject);
      http.listen(0, loopback, resolve);
    });
    ws.removeAllListeners("error");
    ws.on("error", abort);
    signal.throwIfAborted();
    return { port: (http.address() as AddressInfo).port, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** 转发端口由本机 EasyTier 提供；返回前验证 brain Noise 密钥，并完成 M0 设备认证。 */
export async function connectDirect(
  forwardPort: number, brain: { publicKeyB64: string; key: DeviceKey }, signal: AbortSignal,
): Promise<Peer> {
  signal.throwIfAborted();
  if (!Number.isInteger(forwardPort) || forwardPort < 1 || forwardPort > 65535) throw new Error("Invalid EasyTier forwarding port.");
  const socket = new WebSocket(`ws://${loopback}:${forwardPort}${endpoint}`, { ...options, handshakeTimeout: 8_000 });
  const peer = protectedPeer(socket, { daemonPublicKeyB64: brain.publicKeyB64 });
  const abort = () => peer.close();
  signal.addEventListener("abort", abort, { once: true });
  void peer.closed.then(() => signal.removeEventListener("abort", abort));
  try {
    await resume(peer, brain);
    signal.throwIfAborted();
    return peer;
  } catch (error) {
    peer.close();
    throw error;
  }
}
