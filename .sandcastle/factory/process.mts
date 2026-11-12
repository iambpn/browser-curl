/**
 * Runs programs on the host machine without a shell, so text from GitHub
 * issues can never become part of a shell command.
 */

import { spawn } from "node:child_process";

/** What a finished program returned. */
export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  /** The exit code. It is `-1` if a signal stopped the program. */
  readonly exitCode: number;
}

/** Options for {@link runCommand}. */
export interface CommandOptions {
  /** Text to send to the program on standard input. */
  readonly input?: string;
  /** Directory to run the program in. The default is the current directory. */
  readonly cwd?: string;
}

/**
 * Runs a program and collects its output. A non-zero exit code does not throw.
 *
 * @param program The program name, such as `gh`.
 * @param args The arguments, passed as they are with no shell parsing.
 * @param options Standard input and working directory.
 * @returns The output and exit code of the program.
 * @throws Error if the program cannot start, for example when it is not installed.
 */
export function runCommand(
  program: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise(function startProgram(resolve, reject) {
    const child = spawn(program, [...args], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    /** Keeps one chunk of standard output. */
    function collectStdout(chunk: Buffer): void {
      stdoutChunks.push(chunk);
    }

    /** Keeps one chunk of standard error. */
    function collectStderr(chunk: Buffer): void {
      stderrChunks.push(chunk);
    }

    /** Reports a program that could not start. */
    function failToStart(error: Error): void {
      reject(new Error(`Cannot run ${program}: ${error.message}`));
    }

    /** Returns the collected output when the program ends. */
    function finish(exitCode: number | null): void {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: exitCode ?? -1,
      });
    }

    child.stdout.on("data", collectStdout);
    child.stderr.on("data", collectStderr);
    child.on("error", failToStart);
    child.on("close", finish);

    // A program that exits before it reads its input must not crash the runner.
    child.stdin.on("error", ignoreClosedInput);
    child.stdin.end(options.input ?? "");
  });
}

/**
 * Runs a program and requires exit code 0.
 *
 * @param program The program name, such as `git`.
 * @param args The arguments, passed with no shell parsing.
 * @param options Standard input and working directory.
 * @returns The standard output of the program, without surrounding white space.
 * @throws Error with the standard error text if the exit code is not 0.
 */
export async function runRequired(
  program: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<string> {
  const result = await runCommand(program, args, options);
  if (result.exitCode !== 0) {
    const commandLine = [program, ...args].join(" ");
    const reason = result.stderr.trim() || result.stdout.trim();
    throw new Error(`Command failed (${result.exitCode}): ${commandLine}\n${reason}`);
  }
  return result.stdout.trim();
}

/**
 * Ignores the write error that Node reports when a program closes its input early.
 */
function ignoreClosedInput(): void {}
