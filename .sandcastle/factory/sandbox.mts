/**
 * Turns the `sandbox` and `agents` sections of the factory config into
 * Sandcastle objects, and checks the agent logins before a run starts.
 */

import { readFile } from "node:fs/promises";
import * as sandcastle from "@ai-hero/sandcastle";
import { bwrap } from "@ai-hero/sandcastle/sandboxes/bwrap";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { seatbelt } from "@ai-hero/sandcastle/sandboxes/seatbelt";
import { findHostCodexLogin } from "./codexLogin.mts";
import type { AgentConfig, FactoryConfig } from "./config.mts";

/**
 * The login variables that each agent accepts inside the sandbox. One
 * variable of the list is enough.
 *
 * - `claude`: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY`.
 * - `codex`: `CODEX_API_KEY`. Without it, the ChatGPT login file of the host also works.
 */
const LOGIN_VARIABLES: Record<AgentConfig["provider"], readonly string[]> = {
  claude: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  codex: ["CODEX_API_KEY"],
};

/**
 * Creates the sandbox that agents run in.
 *
 * @param sandboxConfig The `sandbox` section of the factory config.
 * @returns Bubblewrap on Linux or Seatbelt on macOS for `native`, else Docker.
 * @throws NativeSandboxUnavailableError if this machine cannot run the native sandbox.
 */
export function createSandboxProvider(sandboxConfig: FactoryConfig["sandbox"]) {
  if (sandboxConfig.type === "docker") {
    return docker({ imageName: sandboxConfig.imageName });
  }
  return process.platform === "darwin" ? seatbelt() : bwrap();
}

/**
 * Creates the coding agent for one role.
 *
 * Codex has no `max` effort, so `max` becomes `xhigh` for a Codex role.
 *
 * @param agentConfig The provider, model, and effort of the role.
 * @returns A Sandcastle agent provider for Claude Code or Codex.
 */
export function createAgent(agentConfig: AgentConfig) {
  const { effort } = agentConfig;
  if (agentConfig.provider === "codex") {
    const codexEffort = effort === "max" ? "xhigh" : effort;
    return sandcastle.codex(agentConfig.model, { effort: codexEffort });
  }
  return sandcastle.claudeCode(agentConfig.model, { effort });
}

/** How the agents of a run log in. */
export interface AgentLogins {
  /** One message for each agent provider that has no login. Empty if all can log in. */
  readonly problems: readonly string[];
  /**
   * The ChatGPT login file of Codex on the host, to copy into each sandbox.
   * `null` when no role uses Codex or when `CODEX_API_KEY` is set.
   */
  readonly codexLoginPath: string | null;
}

/**
 * Finds how each agent logs in, and the agents that have no login.
 *
 * Sandcastle passes a variable into the sandbox only if `.sandcastle/.env`
 * lists its name. The value comes from the file, or from the environment of
 * the runner when the file leaves it empty. The sandbox hides the home folder,
 * so an agent needs one of these variables. A Codex role can use the ChatGPT
 * login file of the host in place of `CODEX_API_KEY`.
 *
 * @param config The factory config.
 * @param envFilePath Absolute path of `.sandcastle/.env`. The file can be missing.
 * @returns The problems, and the Codex login file to copy into each sandbox.
 */
export async function checkLogins(
  config: FactoryConfig,
  envFilePath: string,
): Promise<AgentLogins> {
  const listedVariables = await readListedVariables(envFilePath);
  const providers = new Set([config.agents.implementer.provider, config.agents.reviewer.provider]);
  const problems: string[] = [];
  let codexLoginPath: string | null = null;

  /** Checks whether Sandcastle passes a variable with a value into the sandbox. */
  function isSet(name: string): boolean {
    const hasValueInFile = listedVariables.get(name);
    if (hasValueInFile === undefined) {
      return false;
    }
    const valueInEnvironment = process.env[name] ?? "";
    return hasValueInFile || valueInEnvironment !== "";
  }

  for (const provider of providers) {
    const accepted = LOGIN_VARIABLES[provider];
    if (accepted.some(isSet)) {
      continue;
    }
    if (provider === "codex") {
      codexLoginPath = findHostCodexLogin();
      if (codexLoginPath !== null) {
        continue;
      }
    }
    problems.push(loginProblem(provider, accepted));
  }
  return { problems, codexLoginPath };
}

/**
 * Describes the missing login of one agent provider.
 *
 * @param provider The agent provider with no login.
 * @param accepted The login variables that the provider accepts.
 * @returns A message that names the variables, and the Codex login file for Codex.
 */
function loginProblem(provider: AgentConfig["provider"], accepted: readonly string[]): string {
  const variables = accepted.join(" or ");
  if (provider === "codex") {
    return `The codex agent needs ${variables} in .sandcastle/.env, or a ChatGPT login: run \`codex login\` on this machine.`;
  }
  return `The ${provider} agent needs ${variables} in .sandcastle/.env.`;
}

/**
 * Reads which variables an env file lists, the way Sandcastle reads the file.
 *
 * @param envFilePath Absolute path of the env file.
 * @returns Each listed name, mapped to `true` if the file gives it a value. It
 * never returns the values. Empty if the file is missing.
 */
async function readListedVariables(envFilePath: string): Promise<Map<string, boolean>> {
  let text: string;
  try {
    text = await readFile(envFilePath, "utf8");
  } catch {
    return new Map();
  }

  const variables = new Map<string, boolean>();
  for (const line of text.split(/\r?\n/)) {
    const assignment = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (assignment === null || assignment[1] === undefined) {
      continue;
    }
    const value = assignment[2] ?? "";
    const isEmpty = /^\s*(?:""|'')?\s*$/.test(value);
    variables.set(assignment[1], !isEmpty);
  }
  return variables;
}
