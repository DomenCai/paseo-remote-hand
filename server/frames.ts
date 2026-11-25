import { z } from "zod";

const errorMessages = {
  invalid: "Invalid Remote hand protocol message.",
  version: "Incompatible Remote hand protocol version.",
  busy: "Too many Remote hand requests or streams in flight.",
  timeout: "The Remote hand connection timed out.",
  disconnected: "The Remote hand connection closed.",
  identity: "Remote hand could not verify the device signature.",
  invite: "The invitation has expired, has already been used, or is invalid.",
  risks: "Confirm all current risks before adding this brain.",
  revoked: "This device is no longer authorized by the brain.",
  failure: "The peer could not complete the Remote hand operation.",
  canceled: "The Remote hand operation was canceled.",
  limit: "The Remote hand stream event exceeds the size limit.",
} as const;
type ErrorCode = keyof typeof errorMessages;

export const ErrorCodeSchema = z.enum(Object.keys(errorMessages) as ErrorCode[]);
export const JsonSchema = z.json();
export type Json = z.infer<typeof JsonSchema>;

export const RequestIdSchema = z.int().positive();
export const MethodSchema = z.string().min(1).max(64);

export class ProtocolError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string = errorMessages[code]) {
    super(message);
    this.code = code;
  }
}

export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ProtocolError("invalid");
  return result.data;
}
