/**
 * The software factory runner.
 *
 * It reads the ticket queue from the tracker (GitHub issues or Markdown
 * files), gives each ready ticket to sandboxed agents, and delivers each
 * ticket that passes the project checks and the review: a pull request on
 * GitHub, or a pushed branch for Markdown tickets.
 *
 * Usage, from the project root:
 *
 *   npm --prefix .sandcastle run factory -- [options]
 *
 * Options:
 *   --dry-run          Print the queue and stop. No agent starts.
 *   --issue <ticket>   Work only on this ticket, such as `42` or `greetings/02`.
 *   --merge <mode>     Use `manual` or `auto` for this run, in place of the config value.
 */

import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, requireMergeSupport, type FactoryConfig } from "./factory/config.mts";
import * as git from "./factory/git.mts";
import { runTicket, type PipelineContext, type TicketOutcome } from "./factory/pipeline.mts";
import { checkLogins, createSandboxProvider } from "./factory/sandbox.mts";
import type { QueueView, Ticket } from "./factory/tickets.mts";
import { createTracker } from "./factory/tracker.mts";

/** How many lines of a blocked reason the terminal shows. The ticket comment holds the full reason. */
const MAX_REASON_LINES = 3;

/** The command line options of one runner start. */
interface RunOptions {
  readonly dryRun: boolean;
  /** The id or reference of the only ticket to work on, such as `42` or `greetings/02`. `null` for the whole queue. */
  readonly onlyTicket: string | null;
  /** A merge mode that replaces `merge.mode` of the config, or `null`. */
  readonly mergeMode: FactoryConfig["merge"]["mode"] | null;
}

/**
 * Reads the command line options.
 *
 * @returns The options of this runner start.
 * @throws Error for an unknown option, an empty `--issue` value, or an unknown merge mode.
 */
function readOptions(): RunOptions {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      issue: { type: "string" },
      merge: { type: "string" },
    },
  });

  const onlyTicket = values.issue ?? null;
  if (onlyTicket !== null && onlyTicket.trim() === "") {
    throw new Error("--issue needs a ticket, such as 42 or greetings/02.");
  }

  const mergeMode = values.merge ?? null;
  if (mergeMode !== null && mergeMode !== "manual" && mergeMode !== "auto") {
    throw new Error(`--merge needs "manual" or "auto", but got "${mergeMode}".`);
  }

  return { dryRun: values["dry-run"], onlyTicket, mergeMode };
}

/**
 * Runs a task for every item, with a limit on how many run at the same time.
 *
 * @param items The inputs.
 * @param limit The highest number of tasks in progress at once.
 * @param task The work for one item.
 * @returns The results, in the order of `items`.
 */
async function mapWithLimit<Item, Result>(
  items: readonly Item[],
  limit: number,
  task: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let nextIndex = 0;

  /** Takes items one by one until none are left. */
  async function work(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index] as Item);
    }
  }

  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, work);
  await Promise.all(workers);
  return results;
}

/**
 * Prints the tickets of the queue and what each one waits for.
 *
 * @param queue The ready and the waiting tickets.
 * @param queueLabel The label or status that marks a ticket as ready for an agent.
 */
function printQueue(queue: QueueView, queueLabel: string): void {
  console.log(`Queue (tickets marked "${queueLabel}"):`);
  if (queue.ready.length === 0 && queue.waiting.length === 0) {
    console.log("  The queue is empty.");
    return;
  }
  for (const ticket of queue.ready) {
    console.log(`  ready    ${ticket.reference} ${ticket.title}`);
  }
  for (const ticket of queue.waiting) {
    const blockers = ticket.waitingOn.join(", ");
    console.log(`  waiting  ${ticket.reference} ${ticket.title} (waits for ${blockers})`);
  }
}

/**
 * Describes the outcome of one ticket in one line.
 *
 * @param outcome How the work on the ticket ended.
 * @returns A line for the terminal.
 */
function describeOutcome(outcome: TicketOutcome): string {
  const ticketName = `${outcome.ticket.reference} ${outcome.ticket.title}`;
  switch (outcome.status) {
    case "pull-request": {
      const note = outcome.note === "" ? "" : `\n      Not merged: ${outcome.note}`;
      return `  pull request  ${ticketName}\n      ${outcome.url}${note}`;
    }
    case "merged":
      return `  merged        ${ticketName}\n      ${outcome.url}`;
    case "pushed":
      return `  pushed        ${ticketName}\n      Open a pull request for the branch ${outcome.branch}.`;
    case "in-review":
      return `  in review     ${ticketName}\n      An open pull request exists: ${outcome.url}`;
    case "blocked": {
      const reasonLines = outcome.reason.split("\n").filter((line) => line.trim() !== "");
      const shownLines = reasonLines.slice(0, MAX_REASON_LINES);
      return `  blocked       ${ticketName}\n      ${shownLines.join("\n      ")}`;
    }
  }
}

/**
 * Stops the runner before any agent starts if an agent has no login.
 *
 * @param config The factory config.
 * @param projectRoot Absolute path of the project root.
 * @returns The ChatGPT login file of Codex to copy into each sandbox, or `null`.
 * @throws Error that lists each agent with no login.
 */
async function requireLogins(config: FactoryConfig, projectRoot: string): Promise<string | null> {
  const envFilePath = path.join(projectRoot, ".sandcastle", ".env");
  const logins = await checkLogins(config, envFilePath);
  if (logins.problems.length > 0) {
    throw new Error(logins.problems.join("\n"));
  }
  if (logins.codexLoginPath !== null) {
    console.log(`Codex uses the ChatGPT login in ${logins.codexLoginPath}.`);
  }
  return logins.codexLoginPath;
}

/**
 * Picks the ready tickets that this runner start has not worked on yet.
 *
 * @param queue The current queue.
 * @param attempted The ids of tickets that already have an outcome in this start.
 * @param options The command line options.
 * @returns The tickets for the next round.
 */
function selectCandidates(
  queue: QueueView,
  attempted: ReadonlySet<string>,
  options: RunOptions,
): Ticket[] {
  return queue.ready.filter((ticket) => {
    const isWanted = options.onlyTicket === null || isTicketNamed(ticket, options.onlyTicket);
    return isWanted && !attempted.has(ticket.id);
  });
}

/**
 * Checks whether a name from the command line means a ticket.
 *
 * @param ticket A ticket.
 * @param name The `--issue` value, such as `42`, `#42`, or `greetings/02`.
 * @returns `true` if the name is the id or the reference of the ticket.
 */
function isTicketNamed(ticket: Ticket, name: string): boolean {
  return name === ticket.id || name === ticket.reference;
}

/**
 * Runs the factory: reads the queue, works on ready tickets in rounds, and prints the outcomes.
 *
 * A new round starts only after a merge, because only a merged ticket can
 * unblock the tickets that wait for it.
 */
async function main(): Promise<void> {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  // Sandcastle and `gh` both work on the repository in the current directory.
  process.chdir(projectRoot);

  const options = readOptions();
  const configPath = path.join(projectRoot, ".sandcastle", "factory.config.json");
  const loadedConfig = await loadConfig(configPath);
  const mergeMode = options.mergeMode ?? loadedConfig.merge.mode;
  const config: FactoryConfig = {
    ...loadedConfig,
    merge: { ...loadedConfig.merge, mode: mergeMode },
  };
  requireMergeSupport(config);

  const tracker = await createTracker(config, projectRoot);
  console.log(`Software factory for ${tracker.description} (merge mode: ${config.merge.mode})\n`);

  let queue = await tracker.readQueue();
  printQueue(queue, config.labels.queue);
  if (options.dryRun) {
    return;
  }

  const attempted = new Set<string>();
  const outcomes: TicketOutcome[] = [];
  let sandboxProvider: PipelineContext["sandboxProvider"] | null = null;
  let codexLoginPath: string | null = null;

  for (;;) {
    const candidates = selectCandidates(queue, attempted, options);
    if (candidates.length === 0) {
      break;
    }

    if (sandboxProvider === null) {
      codexLoginPath = await requireLogins(config, projectRoot);
      sandboxProvider = createSandboxProvider(config.sandbox);
    }
    const roundContext: PipelineContext = {
      config,
      baseRef: await git.fetchBase(config.baseBranch),
      projectRoot,
      promptsDir: path.join(projectRoot, ".sandcastle", "prompts"),
      sandboxProvider,
      tracker,
      codexLoginPath,
    };

    console.log(`\nStarting ${candidates.length} ticket(s). Logs are in .sandcastle/logs/.`);
    const roundOutcomes = await mapWithLimit(candidates, config.limits.maxParallel, (ticket) =>
      runTicket(ticket, roundContext),
    );

    for (const outcome of roundOutcomes) {
      attempted.add(outcome.ticket.id);
      outcomes.push(outcome);
    }

    const mergedSomething = roundOutcomes.some((outcome) => outcome.status === "merged");
    if (!mergedSomething) {
      break;
    }
    queue = await tracker.readQueue();
  }

  console.log("\nResult:");
  if (outcomes.length === 0) {
    console.log("  No ticket was ready.");
  }
  for (const outcome of outcomes) {
    console.log(describeOutcome(outcome));
  }
}

/**
 * Prints a fatal error and makes the process exit with code 1.
 *
 * @param error What `main` threw.
 */
function reportFatalError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nThe factory stopped: ${message}`);
  process.exitCode = 1;
}

main().catch(reportFatalError);
