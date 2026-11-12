/**
 * Loads and validates `.sandcastle/factory.config.json`.
 *
 * The config file holds every fact that differs between projects. The runner
 * and the prompts read project facts only from this file.
 */

import { readFile } from "node:fs/promises";
import { z } from "zod";

/** One agent role: which coding agent runs it, and with which model. */
const agentSchema = z.object({
  /** `claude` runs Claude Code. `codex` runs Codex. */
  provider: z.enum(["claude", "codex"]),
  model: z.string().min(1),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
});

/** One command that must exit with code 0 before a ticket can become a pull request. */
const checkSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
});

/**
 * Where the tickets live.
 *
 * - `github`: GitHub issues. The runner opens a pull request for each finished ticket.
 * - `markdown`: Markdown files in `folder`, for a repository that is not on
 *   GitHub. The runner pushes the branch of each finished ticket, and a person
 *   opens the pull request.
 */
const trackerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("github") }),
  z.object({
    type: z.literal("markdown"),
    /** The folder of the ticket files, relative to the project root, such as `.scratch`. */
    folder: z.string().min(1),
  }),
]);

/** The full shape of `.sandcastle/factory.config.json`. */
const configSchema = z.object({
  tracker: trackerSchema,
  /** The branch that pull requests target, such as `main`. */
  baseBranch: z.string().min(1),
  labels: z.object({
    /** Tickets with this label (GitHub) or status (Markdown) are ready for an agent. */
    queue: z.string().min(1),
    /** The runner moves a ticket to this label or status when an agent cannot finish it. */
    blocked: z.string().min(1),
  }),
  branch: z.object({
    /** Branch prefix for a ticket that has no label listed in `prefixByLabel`. */
    defaultPrefix: z.string().min(1),
    /** Maps an issue label to a branch prefix, such as `bug` to `bugfix`. */
    prefixByLabel: z.record(z.string(), z.string().min(1)),
  }),
  sandbox: z.object({
    /**
     * `native` uses Bubblewrap on Linux and Seatbelt on macOS.
     * `docker` uses the image named in `imageName`.
     */
    type: z.enum(["native", "docker"]),
    imageName: z.string().min(1).optional(),
  }),
  setup: z.object({
    /** Runs inside each new sandbox before the agent starts. Use `null` for none. */
    installCommand: z.string().min(1).nullable(),
    /** Paths in the project root to copy into each agent checkout, such as `node_modules`. */
    copyToWorktree: z.array(z.string().min(1)),
  }),
  /** The runner refuses to start without at least one check. */
  checks: z.array(checkSchema).min(1),
  agents: z.object({
    implementer: agentSchema,
    reviewer: agentSchema,
  }),
  limits: z.object({
    /** How many tickets the runner works on at the same time. */
    maxParallel: z.number().int().min(1),
    /** How many fresh sessions the implementer can use for one ticket. */
    implementIterations: z.number().int().min(1),
    /** How many times the implementer can repair failed checks or review findings. */
    fixRounds: z.number().int().min(0),
  }),
  merge: z.object({
    /**
     * Decides the merges into the base branch: of a ticket with no spec, and
     * of the final pull request of a spec. A ticket of a spec always goes into
     * the spec branch at once.
     *
     * `manual` leaves each pull request to the base branch open for a person to merge.
     * `auto` merges it when its GitHub checks pass. It needs the `github` tracker.
     */
    mode: z.enum(["manual", "auto"]),
    /** How the runner merges on GitHub, into the base branch and into spec branches. */
    method: z.enum(["squash", "merge", "rebase"]),
  }),
});

/** The validated factory config. */
export type FactoryConfig = z.infer<typeof configSchema>;

/** The `tracker` section of the config. */
export type TrackerConfig = z.infer<typeof trackerSchema>;

/** The config of one agent role. */
export type AgentConfig = z.infer<typeof agentSchema>;

/** One check command from the config. */
export type CheckConfig = z.infer<typeof checkSchema>;

/**
 * Turns parsed JSON into a validated config.
 *
 * @param raw The parsed content of the config file.
 * @returns The validated config.
 * @throws Error that names every invalid field.
 */
export function parseConfig(raw: unknown): FactoryConfig {
  const result = configSchema.safeParse(raw);
  if (result.success) {
    const config = result.data;
    requireImageNameForDocker(config);
    requireMergeSupport(config);
    return config;
  }

  const problems = result.error.issues.map(describeIssue);
  throw new Error(`Invalid factory config:\n${problems.join("\n")}`);
}

/**
 * Reads the config file from disk and validates it.
 *
 * @param configPath Absolute path of `factory.config.json`.
 * @returns The validated config.
 * @throws Error if the file is missing, is not JSON, or has invalid fields.
 */
export async function loadConfig(configPath: string): Promise<FactoryConfig> {
  const text = await readFile(configPath, "utf8");
  const raw: unknown = JSON.parse(text);
  return parseConfig(raw);
}

/**
 * Formats one validation problem as a list line.
 *
 * @param issue A problem reported by the schema.
 * @returns A line such as `- checks: Too small`.
 */
function describeIssue(issue: z.core.$ZodIssue): string {
  const fieldPath = issue.path.join(".") || "(root)";
  return `- ${fieldPath}: ${issue.message}`;
}

/**
 * Rejects a Docker sandbox that has no image name.
 *
 * @param config The config that passed the schema.
 * @throws Error if `sandbox.type` is `docker` and `sandbox.imageName` is missing.
 */
function requireImageNameForDocker(config: FactoryConfig): void {
  const usesDocker = config.sandbox.type === "docker";
  if (usesDocker && config.sandbox.imageName === undefined) {
    throw new Error(
      "Invalid factory config:\n- sandbox.imageName: required when sandbox.type is docker",
    );
  }
}

/**
 * Rejects a merge mode that the tracker cannot do.
 *
 * Only the `github` tracker opens pull requests, so only it can merge them.
 * The runner also calls this after `--merge` replaces the config value.
 *
 * @param config A config that passed the schema.
 * @throws Error if `merge.mode` is `auto` and the tracker is not `github`.
 */
export function requireMergeSupport(config: FactoryConfig): void {
  const mergesAutomatically = config.merge.mode === "auto";
  if (mergesAutomatically && config.tracker.type !== "github") {
    throw new Error(
      "Invalid factory config:\n- merge.mode: auto needs the github tracker. Use manual with Markdown tickets.",
    );
  }
}
