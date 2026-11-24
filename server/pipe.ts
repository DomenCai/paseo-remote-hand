import type { Socket } from "node:net";

export const OPEN = 1, DATA = 2, FIN = 3, RST = 4, CREDIT = 5;
export const WINDOW = 512 * 1024;
const CHUNK = 64 * 1024, MAX_IN_FLIGHT = 24, HEADER = 25;

export type Frame = { id: number; seq: number; flag: number; data: Buffer };
export type Send = (frame: Buffer) => Promise<unknown>;
type Log = (event: string, fields?: object) => void;

export function encode(token: Buffer, id: number, seq: number, flag: number, data?: Buffer) {
  const frame = Buffer.allocUnsafe(HEADER + (data?.length ?? 0));
  token.copy(frame);
  frame.writeUInt32BE(id, 16);
  frame.writeUInt32BE(seq, 20);
  frame[24] = flag;
  data?.copy(frame, HEADER);
  return frame;
}

export function decode(token: Buffer, input: Uint8Array): Frame {
  const frame = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (frame.length < HEADER || !frame.subarray(0, 16).equals(token))
    throw new Error("Invalid frame generation");
  const id = frame.readUInt32BE(16), seq = frame.readUInt32BE(20), flag = frame[24];
  const data = frame.subarray(HEADER);
  const valid = flag === DATA ? data.length > 0 && data.length <= CHUNK :
    flag === FIN ? !data.length :
    flag === CREDIT ? !seq && data.length === 4 :
    (flag === OPEN || flag === RST) && !seq && !data.length;
  if (!id || !valid) throw new Error("Invalid stream frame");
  return { id, seq, flag, data };
}

export function bridge(
  socket: Socket, id: number, token: Buffer, send: Send,
  remove: () => void, transportError: () => void, log: Log,
) {
  let txSeq = 0, rxSeq = 0, txCredit = WINDOW, rxCredit = WINDOW;
  let readEnded = false, sentFin = false, gotFin = false, closed = false, stopped = false;
  let pending: Buffer | undefined, inFlight = 0, drained = 0;
  let creditTask: ReturnType<typeof setImmediate> | undefined;
  let sent = 0, received = 0, pauses = 0, peakOutstanding = 0, waitingForCredit = false;

  function finish(reason: string, notify = false) {
    if (stopped) return;
    stopped = true;
    if (creditTask) clearImmediate(creditTask);
    remove();
    if (reason !== "fin") {
      socket.destroy(new Error(reason));
      if (notify) void send(encode(token, id, 0, RST)).catch(transportError);
    }
    if (reason !== "fin" || sent + received >= 1024 * 1024)
      log("stream-close", { id, reason, sent, received, pauses, peakOutstanding });
  }

  function emit(flag: number, seq = 0, data?: Buffer) {
    inFlight++;
    void send(encode(token, id, seq, flag, data)).then(() => {
      inFlight--;
      pump();
    }, transportError);
  }

  function pump() {
    if (stopped) return;
    while (pending?.length && txCredit && inFlight < MAX_IN_FLIGHT) {
      const n = Math.min(CHUNK, txCredit, pending.length);
      const data = pending.subarray(0, n);
      pending = pending.length === n ? undefined : pending.subarray(n);
      txCredit -= n;
      sent += n;
      peakOutstanding = Math.max(peakOutstanding, WINDOW - txCredit);
      emit(DATA, txSeq++, data);
    }
    const blocked = !txCredit && !readEnded;
    if (blocked && !waitingForCredit) pauses++;
    waitingForCredit = blocked;
    if (pending || blocked || inFlight >= MAX_IN_FLIGHT) {
      socket.pause();
      return;
    }
    if (readEnded && !sentFin) {
      sentFin = true;
      emit(FIN, txSeq++);
    } else if (!readEnded) socket.resume();
    if (closed && sentFin && inFlight === 0) finish("fin");
  }

  function grant() {
    creditTask = undefined;
    if (stopped || gotFin || !drained) return;
    const data = Buffer.allocUnsafe(4);
    data.writeUInt32BE(drained);
    rxCredit += drained;
    drained = 0;
    // 对端拿到 credit 才能继续读；目标 socket 的写回调是补发依据。
    void send(encode(token, id, 0, CREDIT, data)).catch(transportError);
  }

  socket.pause();
  socket.on("data", (chunk: Buffer) => {
    pending = chunk;
    pump();
  });
  socket.once("end", () => {
    readEnded = true;
    pump();
  });
  socket.on("error", () => finish("socket-error", true));
  socket.once("close", () => {
    closed = true;
    if (!readEnded || !gotFin) finish("socket-closed", true);
    else pump();
  });

  return {
    start: pump,
    stop: finish,
    receive({ seq, flag, data }: Frame) {
      if (stopped) return;
      if (flag === RST) return finish("peer-reset");
      if (flag === CREDIT) {
        const amount = data.readUInt32BE();
        if (!amount || amount > WINDOW - txCredit) return finish("invalid-credit", true);
        txCredit += amount;
        return pump();
      }
      if (flag === OPEN || gotFin || seq !== rxSeq++)
        return finish("invalid-sequence", true);
      if (flag === FIN) {
        gotFin = true;
        socket.end();
        return;
      }
      if (data.length > rxCredit) return finish("credit-exceeded", true);
      rxCredit -= data.length;
      received += data.length;
      socket.write(data, (error) => {
        if (error) return finish("socket-write-error", true);
        if (stopped || gotFin) return;
        drained += data.length;
        creditTask ??= setImmediate(grant);
      });
    },
  };
}
