/**
 * Takes one ticket from the queue to its end: a pull request, a merged pull
 * request, a pushed branch, or a ticket handed back to a person.
 *
 * Agents work only inside the sandbox. This module runs the project checks
 * itself. The tracker does every action on the ticket, on the host machine.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { copyCodexLoginIn, saveRefreshedCodexLogin } from "./codexLogin.mts";
import type { CheckConfig, FactoryConfig } from "./config.mts";
import * as git from "./git.mts";
import {
  describeFailedChecks,
  parseReview,
  readTag,
  tailOf,
  type CheckResult,
  type Review,
} from "./report.mts";
import { createAgent } from "./sandbox.mts";
import { branchNameFor, type Ticket } from "./tickets.mts";
import type { ApprovedWork, Delivery, Tracker } from "./tracker.mts";

/** An agent prints this text when it finished its task. */
const COMPLETE_SIGNAL = "<promise>COMPLETE</promise>";

/** An agent prints this text when it cannot finish and a person must decide. */
const BLOCKED_SIGNAL = "<promise>BLOCKED</promise>";

/** Dependency installs can be slow, so the install hook gets ten minutes. */
const INSTALL_TIMEOUT_MS = 600_000;

/** What every ticket of one runner start shares. */
export interface PipelineContext {
  readonly config: FactoryConfig;
  /** The ref that new ticket branches start from, such as `origin/main`. */
  readonly baseRef: string;
  /** Absolute path of the project root. */
  readonly projectRoot: string;
  /** Absolute path of the folder with `implement.md`, `fix.md`, and `review.md`. */
  readonly promptsDir: string;
  /** The sandbox from {@link createSandboxProvider}. */
  readonly sandboxProvider: sandcastle.SandboxProvider;
  /** Where the tickets live. */
  readonly tracker: Tracker;
  /** The ChatGPT login file of Codex to copy into each sandbox, or `null`. */
  readonly codexLoginPath: string | null;
}

/**
 * How the work on one ticket ended.
 *
 * - `pull-request`, `merged`, `pushed`: the tracker delivered the approved work. See {@link Delivery}.
 * - `in-review`: an earlier run already opened a pull request, so the runner did nothing.
 * - `blocked`: the tracker recorded the reason on the ticket and took the ticket out of the queue.
 */
export type TicketOutcome =
  | ({ readonly ticket: Ticket } & Delivery)
  | { readonly status: "in-review"; readonly ticket: Ticket; readonly url: string }
  | { readonly status: "blocked"; readonly ticket: Ticket; readonly reason: string };

/** The result of the sandbox part of the pipeline. */
type SandboxWork =
  | ({ readonly approved: true } & ApprovedWork)
  | { readonly approved: false; readonly reason: string };

/**
 * Works on one ticket until it has an outcome.
 *
 * @param ticket A ticket with no open blocker.
 * @param context What every ticket of this runner start shares.
 * @returns The outcome. This function reports failures as a `blocked` outcome and does not throw for them.
 */
export async function runTicket(ticket: Ticket, context: PipelineContext): Promise<TicketOutcome> {
  const { config, tracker } = context;
  const existingBranch = await git.findTicketBranch(ticket.id);
  const branch = existingBranch ?? branchNameFor(ticket, config.branch);

  const openReview = await tracker.findOpenReview(branch);
  if (openReview !== null) {
    return { status: "in-review", ticket, url: openReview };
  }

  let work: SandboxWork;
  try {
    const spec = await tracker.readSpec(ticket);
    work = await workInSandbox(ticket, branch, spec, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    work = { approved: false, reason: `The runner hit an error:\n\n${message}` };
  }

  if (!work.approved) {
    await tracker.handBack(ticket, branch, work.reason);
    return { status: "blocked", ticket, reason: work.reason };
  }
  const delivery = await tracker.deliver(ticket, branch, work);
  return { ...delivery, ticket };
}

/**
 * Runs the implementer and the reviewer in one sandbox on the ticket branch.
 *
 * The loop is: run the checks, review if they pass, and send every problem
 * back to the implementer. It ends on an approval or when the repair rounds
 * are used up.
 *
 * @param ticket The ticket to implement.
 * @param branch The branch that receives the commits.
 * @param spec The text of the spec, for context.
 * @param context What every ticket of this runner start shares.
 * @returns The approval with its proof, or the reason the work stopped.
 */
async function workInSandbox(
  ticket: Ticket,
  branch: string,
  spec: string,
  context: PipelineContext,
): Promise<SandboxWork> {
  const { config, baseRef } = context;
  const implementer = createAgent(config.agents.implementer);
  const reviewer = createAgent(config.agents.reviewer);
  const checkCommands = config.checks.map((check) => `- \`${check.command}\``).join("\n");
  const ticketArgs = {
    TICKET_REFERENCE: ticket.reference,
    TICKET_TITLE: ticket.title,
    TICKET_BODY: ticket.body,
    SPEC: spec,
  };

  const sandbox = await sandcastle.createSandbox({
    branch,
    baseBranch: baseRef,
    sandbox: context.sandboxProvider,
    hooks: installHooks(config),
    copyToWorktree: existingPaths(config.setup.copyToWorktree, context.projectRoot),
  });

  let copiedCodexLogin: string | null = null;
  try {
    if (context.codexLoginPath !== null) {
      copiedCodexLogin = await copyCodexLoginIn(sandbox, context.codexLoginPath);
    }

    const implementation = await sandbox.run({
      agent: implementer,
      name: `implement-${ticket.id}`,
      promptFile: path.join(context.promptsDir, "implement.md"),
      promptArgs: { ...ticketArgs, CHECK_COMMANDS: checkCommands },
      maxIterations: config.limits.implementIterations,
      completionSignal: [COMPLETE_SIGNAL, BLOCKED_SIGNAL],
    });

    const stopReason = reasonImplementerStopped(implementation, config);
    if (stopReason !== null) {
      return { approved: false, reason: stopReason };
    }

    for (let round = 0; ; round++) {
      const checks = await runChecks(sandbox, config.checks);
      let problem = describeFailedChecks(checks);

      if (problem === "") {
        const commitCount = await git.countCommitsAhead(baseRef, branch);
        if (commitCount === 0) {
          return { approved: false, reason: "The implementer finished but made no commits." };
        }

        const reviewRun = await sandbox.run({
          agent: reviewer,
          name: `review-${ticket.id}`,
          promptFile: path.join(context.promptsDir, "review.md"),
          promptArgs: { ...ticketArgs, BASE_REF: baseRef },
        });
        const review = parseReview(reviewRun.stdout);
        if (review === null) {
          return { approved: false, reason: "The reviewer did not return a valid verdict." };
        }
        if (review.verdict === "approve") {
          return { approved: true, review, checks };
        }
        problem = describeRejection(review);
      }

      if (round === config.limits.fixRounds) {
        return {
          approved: false,
          reason: `The work still has problems after ${round} repair rounds.\n\n${problem}`,
        };
      }

      await sandbox.run({
        agent: implementer,
        name: `fix-${ticket.id}`,
        promptFile: path.join(context.promptsDir, "fix.md"),
        promptArgs: { ...ticketArgs, PROBLEM: problem, CHECK_COMMANDS: checkCommands },
        completionSignal: [COMPLETE_SIGNAL, BLOCKED_SIGNAL],
      });
    }
  } finally {
    await closeSandbox(sandbox, context.codexLoginPath, copiedCodexLogin);
  }
}

/**
 * Saves a refreshed Codex login on the host, then closes the sandbox.
 *
 * @param sandbox The sandbox of the ticket.
 * @param codexLoginPath The Codex login file on the host, or `null`.
 * @param copiedCodexLogin The login text that the runner copied into the sandbox, or `null` if it copied none.
 */
async function closeSandbox(
  sandbox: sandcastle.Sandbox,
  codexLoginPath: string | null,
  copiedCodexLogin: string | null,
): Promise<void> {
  try {
    if (codexLoginPath !== null && copiedCodexLogin !== null) {
      await saveRefreshedCodexLogin(sandbox, codexLoginPath, copiedCodexLogin);
    }
  } finally {
    await sandbox.close();
  }
}

/**
 * Explains why the implementer stopped without finishing.
 *
 * @param implementation The result of the implementer run.
 * @param config The factory config.
 * @returns The reason, or `null` if the implementer reported that it finished.
 */
function reasonImplementerStopped(
  implementation: { readonly completionSignal?: string; readonly stdout: string },
  config: FactoryConfig,
): string | null {
  if (implementation.completionSignal === COMPLETE_SIGNAL) {
    return null;
  }
  if (implementation.completionSignal === BLOCKED_SIGNAL) {
    const explanation = readTag(implementation.stdout, "blocked");
    return explanation ?? "The implementer reported a blocker and gave no reason.";
  }
  return `The implementer used all ${config.limits.implementIterations} sessions and did not finish.`;
}

/**
 * Runs every project check in the sandbox, one after another.
 *
 * The first result reports uncommitted files, because a pull request holds
 * only commits. The runner looks before it runs the project checks, so files
 * that the checks create do not count.
 *
 * @param sandbox The sandbox of the ticket.
 * @param checks The check commands from the config.
 * @returns One result for the uncommitted files test and one for each check.
 */
async function runChecks(
  sandbox: sandcastle.Sandbox,
  checks: readonly CheckConfig[],
): Promise<CheckResult[]> {
  const statusCommand = "git status --porcelain";
  const status = await sandbox.exec(statusCommand);
  const uncommittedFiles = status.stdout.trim();
  const results: CheckResult[] = [
    {
      name: "all work is committed",
      command: statusCommand,
      passed: status.exitCode === 0 && uncommittedFiles === "",
      outputTail: tailOf(`${uncommittedFiles}\n${status.stderr}`),
    },
  ];

  for (const check of checks) {
    const execution = await sandbox.exec(check.command);
    results.push({
      name: check.name,
      command: check.command,
      passed: execution.exitCode === 0,
      outputTail: tailOf(`${execution.stdout}\n${execution.stderr}`),
    });
  }
  return results;
}

/**
 * Describes a rejecting review for the implementer.
 *
 * @param review A verdict with `verdict` set to `reject`.
 * @returns The summary and the findings as text.
 */
function describeRejection(review: Review): string {
  const findings = review.findings.map((finding) => `- ${finding}`).join("\n");
  return `The reviewer rejected the change.\n\n${review.summary}\n\n${findings}`;
}

/**
 * Builds the sandbox hooks that install the project dependencies.
 *
 * @param config The factory config.
 * @returns A hook for `setup.installCommand`, or `undefined` if the config has no install command.
 */
function installHooks(config: FactoryConfig): sandcastle.SandboxHooks | undefined {
  const installCommand = config.setup.installCommand;
  if (installCommand === null) {
    return undefined;
  }
  return {
    sandbox: {
      onSandboxReady: [{ command: installCommand, timeoutMs: INSTALL_TIMEOUT_MS }],
    },
  };
}

/**
 * Drops configured copy paths that this checkout does not have.
 *
 * @param relativePaths Paths from `setup.copyToWorktree`, relative to the project root.
 * @param projectRoot Absolute path of the project root.
 * @returns The paths that exist on disk.
 */
function existingPaths(relativePaths: readonly string[], projectRoot: string): string[] {
  return relativePaths.filter((relativePath) => {
    const absolutePath = path.join(projectRoot, relativePath);
    return existsSync(absolutePath);
  });
}
