import { stat } from "node:fs/promises";
import { handTools, type HandToolName, type HandToolResult } from "../../shared/hand-tools.ts";
import { mutateFile, readFile } from "./files.ts";
import { HandPaths, hasCode } from "./paths.ts";
import { globFiles, grepFilesOnHand } from "./search.ts";
import { runShell, type HandShell } from "./shell.ts";

export interface HandToolOptions {
  roots: string[] | null;
  allowShell: boolean;
  cwd?: string;
  shell?: HandShell;
  signal: AbortSignal;
  onOutput?: (chunk: string) => void;
}

export async function executeHandTool<N extends HandToolName>(name: N, input: unknown, options: HandToolOptions): Promise<HandToolResult<N>>;
export async function executeHandTool(name: string, input: unknown, options: HandToolOptions): Promise<HandToolResult>;
export async function executeHandTool(name: string, input: unknown, options: HandToolOptions): Promise<HandToolResult> {
  try {
    if (name === "hand_bash" && !options.allowShell) throw new Error("Shell execution is disabled by this hand's permissions. Use the file tools or ask the user to enable shell access.");
    const signal = options.signal;
    signal.throwIfAborted();
    const paths = new HandPaths(options.roots);
    const defaultPath = () => {
      const cwd = options.cwd ?? (options.roots === null ? process.cwd() : options.roots[0]);
      if (cwd === undefined) throw new Error("No workspace directory is authorized; ask the user to authorize the workspace.");
      return cwd;
    };
    switch (name) {
      case "hand_read":
        return await readFile(handTools[name].input.parse(input), paths, signal);
      case "hand_write":
        return await mutateFile(name, handTools[name].input.parse(input), paths, signal);
      case "hand_edit":
        return await mutateFile(name, handTools[name].input.parse(input), paths, signal);
      case "hand_glob": {
        const args = handTools[name].input.parse(input);
        const target = await paths.authorize(args.path ?? defaultPath());
        if (!(await stat(target)).isDirectory()) throw new Error(`Expected a search directory: ${target}`);
        return await globFiles(args, target, paths, signal);
      }
      case "hand_grep": {
        const args = handTools[name].input.parse(input);
        return await grepFilesOnHand(args, await paths.authorize(args.path ?? defaultPath()), paths, signal);
      }
      case "hand_bash": {
        const args = handTools[name].input.parse(input);
        // roots 只校验命令从哪里开始；启用 shell 就允许命令使用本机用户权限。
        const cwd = await paths.authorize(args.cwd ?? defaultPath());
        if (!(await stat(cwd)).isDirectory()) throw new Error(`Expected a working directory: ${cwd}`);
        return await runShell(args, cwd, options);
      }
      default:
        throw new Error(`Unknown hand tool: ${name}`);
    }
  } catch (error) {
    let text = error instanceof Error ? error.message : String(error);
    if (options.signal.aborted) text = "Hand tool cancelled.";
    else if (hasCode(error, "ENOENT", "ENOTDIR")) text += "\nCheck the absolute path and ensure its parent directory exists on the hand.";
    return { text, isError: true };
  }
}
