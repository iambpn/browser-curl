/**
 * The ticket model that every tracker shares. Decides which GitHub issues are
 * tickets that an agent can start now, and names the branch for each ticket.
 * This module has no side effects.
 */

import type { FactoryConfig } from "./config.mts";

/** An open GitHub issue, in the shape that `gh issue list --json` returns. */
export interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly { readonly name: string }[];
  /** Issues that GitHub records as blockers of this issue. */
  readonly blockedBy?: { readonly nodes: readonly { readonly number: number }[] };
  /** Child issues of this issue. A spec has its tickets here. */
  readonly subIssues?: { readonly totalCount: number };
  /** The spec that this issue belongs to, if GitHub records one. */
  readonly parent?: { readonly number: number } | null;
}

/** A ticket from the queue, with what the runner needs to work on it. */
export interface Ticket {
  /**
   * The key of the ticket in branch names. For GitHub it is the issue number,
   * such as `42`. For Markdown it is the feature folder and the file number,
   * such as `greetings-02`.
   */
  readonly id: string;
  /** How people and agents name the ticket, such as `#42` or `greetings/02`. */
  readonly reference: string;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  /**
   * Where the tracker finds the spec of the ticket: the parent issue number
   * for GitHub, or the path of the spec file for Markdown. `null` if the
   * ticket has no spec.
   */
  readonly specLocation: string | null;
  /** The references of open tickets that must finish before an agent can start this ticket. */
  readonly waitingOn: readonly string[];
}

/** The queue, split by what the runner can do with each ticket. */
export interface QueueView {
  /** Tickets with no open blocker. */
  readonly ready: readonly Ticket[];
  /** Tickets that wait for another open issue. */
  readonly waiting: readonly Ticket[];
}

/**
 * Splits the open issues into ready tickets and waiting tickets.
 *
 * An issue is a ticket if it has the queue label and no child issues. An
 * issue with child issues is a spec, so the runner never implements it.
 *
 * @param openIssues Every open issue of the repository.
 * @param queueLabel The label that marks a ticket as ready for an agent.
 * @returns The ready and the waiting tickets, each sorted by issue number.
 */
export function buildQueue(openIssues: readonly GitHubIssue[], queueLabel: string): QueueView {
  const openNumbers = new Set(openIssues.map((issue) => issue.number));
  const specNumbers = collectSpecNumbers(openIssues);
  const issuesInOrder = [...openIssues].sort(byNumber);

  const tickets: Ticket[] = [];
  for (const issue of issuesInOrder) {
    const isTicket = hasLabel(issue, queueLabel) && !specNumbers.has(issue.number);
    if (isTicket) {
      tickets.push(toTicket(issue, openNumbers));
    }
  }
  return splitByBlockers(tickets);
}

/**
 * Splits tickets into those that can start now and those that wait.
 *
 * @param tickets The tickets of the queue, in the order to work on them.
 * @returns The tickets with no open blocker, and the others. Each list keeps the input order.
 */
export function splitByBlockers(tickets: readonly Ticket[]): QueueView {
  const ready = tickets.filter((ticket) => ticket.waitingOn.length === 0);
  const waiting = tickets.filter((ticket) => ticket.waitingOn.length > 0);
  return { ready, waiting };
}

/**
 * Builds the branch name for a ticket.
 *
 * The format is `<prefix>/<ticket id>-<title words>`. The prefix comes from
 * the first ticket label that `prefixByLabel` lists.
 *
 * @param ticket The ticket that needs a branch.
 * @param branchConfig The `branch` section of the factory config.
 * @returns A branch name such as `feat/42-add-login-form` or `feat/greetings-02-add-greeting`.
 */
export function branchNameFor(ticket: Ticket, branchConfig: FactoryConfig["branch"]): string {
  const matchingLabel = ticket.labels.find(
    (label) => branchConfig.prefixByLabel[label] !== undefined,
  );
  const prefix =
    matchingLabel === undefined
      ? branchConfig.defaultPrefix
      : branchConfig.prefixByLabel[matchingLabel];

  const slug = slugify(ticket.title);
  const description = slug === "" ? ticket.id : `${ticket.id}-${slug}`;
  return `${prefix}/${description}`;
}

/**
 * Turns a title into lowercase words joined by hyphens.
 *
 * @param title Free text, such as an issue title.
 * @returns At most six words. The result is empty if the title has no letters or digits.
 */
export function slugify(title: string): string {
  const maxWords = 6;
  const words = title.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.slice(0, maxWords).join("-");
}

/**
 * Finds the issue numbers written under one Markdown heading.
 *
 * Tickets from the `to-tickets` skill list blockers under `## Blocked by` and
 * the spec under `## Parent`. GitHub repositories without native issue
 * dependencies use only this text.
 *
 * @param body The Markdown body of an issue.
 * @param heading The heading text, without the `#` marks.
 * @returns Every `#123` reference between that heading and the next heading.
 */
export function issueNumbersUnderHeading(body: string, heading: string): number[] {
  const lines = body.split(/\r?\n/);
  const wantedHeading = heading.toLowerCase();
  const numbers: number[] = [];
  let insideSection = false;

  for (const line of lines) {
    const headingMatch = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (headingMatch !== null) {
      const headingText = headingMatch[1] ?? "";
      insideSection = headingText.trim().toLowerCase() === wantedHeading;
      continue;
    }
    if (!insideSection) {
      continue;
    }
    for (const reference of line.matchAll(/#(\d+)/g)) {
      numbers.push(Number(reference[1]));
    }
  }
  return numbers;
}

/**
 * Finds every issue that is a spec.
 *
 * @param openIssues Every open issue of the repository.
 * @returns The numbers of issues that have child issues, or that an open issue names as its parent.
 */
function collectSpecNumbers(openIssues: readonly GitHubIssue[]): Set<number> {
  const specNumbers = new Set<number>();
  for (const issue of openIssues) {
    const childCount = issue.subIssues?.totalCount ?? 0;
    if (childCount > 0) {
      specNumbers.add(issue.number);
    }
    const parentNumber = parentNumberOf(issue);
    if (parentNumber !== null) {
      specNumbers.add(parentNumber);
    }
  }
  return specNumbers;
}

/**
 * Finds the spec of an issue.
 *
 * @param issue An open issue.
 * @returns The parent that GitHub records, else the first reference under `## Parent`, else `null`.
 */
function parentNumberOf(issue: GitHubIssue): number | null {
  if (issue.parent) {
    return issue.parent.number;
  }
  const writtenParents = issueNumbersUnderHeading(issue.body, "Parent");
  return writtenParents[0] ?? null;
}

/**
 * Converts an issue into a ticket and works out what it waits for.
 *
 * @param issue An open issue that has the queue label.
 * @param openNumbers The numbers of every open issue.
 * @returns The ticket. `waitingOn` holds only blockers that are still open.
 */
function toTicket(issue: GitHubIssue, openNumbers: ReadonlySet<number>): Ticket {
  const nativeBlockers = issue.blockedBy?.nodes.map((node) => node.number) ?? [];
  const writtenBlockers = issueNumbersUnderHeading(issue.body, "Blocked by");
  const allBlockers = new Set([...nativeBlockers, ...writtenBlockers]);
  allBlockers.delete(issue.number);

  const openBlockers = [...allBlockers].filter((blocker) => openNumbers.has(blocker));
  openBlockers.sort((first, second) => first - second);
  const parentNumber = parentNumberOf(issue);

  return {
    id: String(issue.number),
    reference: `#${issue.number}`,
    title: issue.title,
    body: issue.body,
    labels: issue.labels.map((label) => label.name),
    specLocation: parentNumber === null ? null : String(parentNumber),
    waitingOn: openBlockers.map((blocker) => `#${blocker}`),
  };
}

/**
 * Checks whether an issue carries a label.
 *
 * @param issue An open issue.
 * @param labelName The label to look for.
 * @returns `true` if the issue has that label.
 */
function hasLabel(issue: GitHubIssue, labelName: string): boolean {
  return issue.labels.some((label) => label.name === labelName);
}

/**
 * Sort order for issues: lowest issue number first.
 *
 * @param first An issue.
 * @param second Another issue.
 * @returns A negative number if `first` sorts before `second`.
 */
function byNumber(first: GitHubIssue, second: GitHubIssue): number {
  return first.number - second.number;
}
