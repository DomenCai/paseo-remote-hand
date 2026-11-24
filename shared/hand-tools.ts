import { z } from "zod";

// 共享层只描述协议；绝对路径按 hand 的平台在执行时校验。
const filePath = z.string().min(1).max(32767).describe("Absolute path on the hand machine.");
const line = z.number().int().positive();

export const handTools = {
  hand_read: {
    name: "hand_read",
    description: "Read a UTF-8 text file on the hand machine. Returns numbered lines and the SHA-256 of the entire file. Use offset and limit to read sections of a large text file.",
    input: z.strictObject({
      path: filePath,
      offset: line.optional().describe("First line to read, starting at 1."),
      limit: line.optional().describe("Maximum number of lines to return."),
    }),
  },
  hand_write: {
    name: "hand_write",
    description: "Write the complete UTF-8 contents of a file on the hand machine. To overwrite an existing file, call hand_read first and pass its SHA-256 as expectedSha256. Use hand_edit for targeted changes.",
    input: z.strictObject({
      path: filePath,
      content: z.string(),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
    }),
  },
  hand_edit: {
    name: "hand_edit",
    description: "Replace exact text in a file on the hand machine. Read it first, then copy old_string exactly, including whitespace and indentation. The old text must occur exactly once unless replace_all is true.",
    input: z.strictObject({
      path: filePath,
      old_string: z.string().min(1),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    }),
  },
  hand_glob: {
    name: "hand_glob",
    description: "Find files on the hand machine by a glob such as **/*.ts. The pattern is relative to the search directory and uses forward slashes. Returns matching absolute paths, newest modification time first.",
    input: z.strictObject({
      pattern: z.string().min(1).max(1024),
      path: filePath.optional().describe("Absolute search directory. Defaults to the workspace directory."),
    }),
  },
  hand_grep: {
    name: "hand_grep",
    description: "Search UTF-8 files on the hand machine with a line-based regular expression. Use an RE2 pattern; lookaround and backreferences are unsupported. Optionally filter by a glob such as **/*.ts. Returns matching file paths by default, or use content for numbered lines or count for the number of matching lines per file.",
    input: z.strictObject({
      pattern: z.string().min(1).max(1024),
      path: filePath.optional().describe("Absolute file or directory. Defaults to the workspace directory."),
      glob: z.string().min(1).max(1024).optional(),
      output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
      case_insensitive: z.boolean().optional(),
      context: z.number().int().min(0).max(20).optional().describe("Context lines before and after each match in content mode."),
    }),
  },
  hand_bash: {
    name: "hand_bash",
    description: "Run a shell command on the hand machine when shell access is enabled. Use the hand's shell syntax (PowerShell by default on Windows). Returns combined standard output and error, and the exit code. Prefer the dedicated hand file tools for reading, editing, and searching files.",
    input: z.strictObject({
      command: z.string().min(1).max(8192),
      cwd: filePath.optional().describe("Absolute working directory. Defaults to the workspace directory."),
      timeout_ms: z.number().int().positive().max(540_000).optional().describe("Timeout in milliseconds. Defaults to 120000, maximum 540000."),
      description: z.string().optional().describe("A short description of what the command does."),
    }),
  },
} as const;

export type HandToolName = keyof typeof handTools;
export type HandToolInput<N extends HandToolName> = z.infer<(typeof handTools)[N]["input"]>;
export type HandGrepMatch =
  | { path: string }
  | { path: string; count: number }
  | { path: string; line: number; text: string; match: boolean };

export interface HandToolOutputs {
  hand_read: { sha256: string; totalLines: number; offset: number; nextOffset?: number; binary?: true };
  hand_write: { path: string; sha256: string };
  hand_edit: { path: string; sha256: string; replacements: number };
  hand_glob: { paths: string[]; truncated: boolean };
  hand_grep: { matches: HandGrepMatch[]; truncated: boolean };
  hand_bash: {
    output: string;
    exitCode: number | null;
    signal: string | null;
    truncated: boolean;
    cancelled: boolean;
    timedOut: boolean;
    terminationError?: string;
  };
}

export type HandToolResult<N extends HandToolName = HandToolName> = {
  text: string;
  isError: boolean;
  structured?: HandToolOutputs[N];
};
