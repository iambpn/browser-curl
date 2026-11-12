/**
 * Lets Codex use the ChatGPT login of the host machine in a sandbox.
 *
 * The sandbox hides the home folder of the host, so Codex cannot read
 * `~/.codex/auth.json` there. The runner copies that file into the home
 * folder of each sandbox. Codex refreshes its tokens during a run and can
 * write a new login file. When the sandbox closes, the runner saves the new
 * file on the host, so the login on the host stays valid.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type * as sandcastle from "@ai-hero/sandcastle";

/** The login file inside the sandbox, as a shell word. */
const SANDBOX_LOGIN_FILE = '"$HOME/.codex/auth.json"';

/**
 * Finds the ChatGPT login file of Codex on the host.
 *
 * @returns The path `$CODEX_HOME/auth.json`, or `~/.codex/auth.json` without
 * `CODEX_HOME`. `null` if the file does not exist.
 */
export function findHostCodexLogin(): string | null {
  const defaultCodexHome = path.join(os.homedir(), ".codex");
  const codexHome = process.env.CODEX_HOME || defaultCodexHome;
  const loginPath = path.join(codexHome, "auth.json");
  return existsSync(loginPath) ? loginPath : null;
}

/**
 * Copies the login file of the host into the home folder of a sandbox.
 *
 * The content goes through standard input, so it never appears in a command
 * line or an environment variable.
 *
 * @param sandbox The sandbox of a ticket.
 * @param hostLoginPath The login file on the host.
 * @returns The copied text. Pass it to {@link saveRefreshedCodexLogin}.
 * @throws Error if the sandbox cannot write the file.
 */
export async function copyCodexLoginIn(
  sandbox: sandcastle.Sandbox,
  hostLoginPath: string,
): Promise<string> {
  const loginText = await readFile(hostLoginPath, "utf8");
  const writeCommand = `umask 077 && mkdir -p "$HOME/.codex" && cat > ${SANDBOX_LOGIN_FILE}`;
  const result = await sandbox.exec(writeCommand, { stdin: loginText });
  if (result.exitCode !== 0) {
    throw new Error(`The runner cannot copy the Codex login into the sandbox:\n${result.stderr}`);
  }
  return loginText;
}

/**
 * Saves the login file of a sandbox on the host if Codex refreshed it.
 *
 * The runner keeps the host file when the sandbox file did not change, is not
 * a Codex login, or when the host file changed since the copy. A changed host
 * file is newer, for example from another ticket of the same run.
 *
 * @param sandbox The sandbox of a ticket, before it closes.
 * @param hostLoginPath The login file on the host.
 * @param copiedText The text that {@link copyCodexLoginIn} copied into the sandbox.
 */
export async function saveRefreshedCodexLogin(
  sandbox: sandcastle.Sandbox,
  hostLoginPath: string,
  copiedText: string,
): Promise<void> {
  const result = await sandbox.exec(`cat ${SANDBOX_LOGIN_FILE}`);
  const sandboxText = result.stdout.trim();
  const isUnchanged = sandboxText === copiedText.trim();
  if (result.exitCode !== 0 || isUnchanged || !isCodexLogin(sandboxText)) {
    return;
  }

  // Synchronous calls: no other ticket can write the file between the read and the write.
  const hostText = readFileSync(hostLoginPath, "utf8");
  if (hostText !== copiedText) {
    return;
  }
  writeFileSync(hostLoginPath, `${sandboxText}\n`, { mode: 0o600 });
}

/**
 * Checks that a text looks like a Codex login file.
 *
 * @param text The content of a login file from a sandbox.
 * @returns `true` if the text is a JSON object with a `tokens` object or an `OPENAI_API_KEY` field.
 */
function isCodexLogin(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return false;
  }
  const hasTokens = "tokens" in parsed && typeof parsed.tokens === "object";
  return hasTokens || "OPENAI_API_KEY" in parsed;
}
