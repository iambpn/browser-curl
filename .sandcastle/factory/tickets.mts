/**
 * The ticket model that every tracker shares. Decides which GitHub issues are
 * tickets that an agent can start now, and names the branch of each ticket
 * and of each spec. This module has no side effects.
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
  readonly parent?: { readonly number: number; readonly title?: string } | null;
}

/**
 * A spec: a feature that several tickets build together. The tickets of a
 * spec merge into the spec branch. When every ticket of the spec is closed,
 * the spec branch becomes one final pull request to the base branch.
 */
export interface Spec {
  /** The key of the spec in branch names: the issue number, such as `1`, or the feature folder, such as `greetings`. */
  readonly id: string;
  /** How people name the spec, such as `#1` or `greetings`. */
  readonly reference: string;
  readonly title: string;
  /** Where the tracker reads the spec text: the issue number for GitHub, or the path of the spec file for Markdown. */
  readonly location: string;
  /** The branch on `origin` that collects the work of every ticket of the spec, such as `feat/spec-1-greetings`. */
  readonly branch: string;
}

/** The `branch` section of the factory config. */
export type BranchConfig = FactoryConfig["branch"];

/** What {@link buildQueue} needs besides the open issues. */
export interface QueueOptions {
  /** The label that marks a ticket as ready for an agent. */
  readonly queueLabel: string;
  readonly branch: BranchConfig;
  /** The names of every branch on `origin`. An existing spec branch keeps its name when the spec title changes. */
  readonly remoteBranches: readonly string[];
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
  /** The spec that the ticket belongs to, or `null` for a ticket on its own. */
  readonly spec: Spec | null;
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
 * An issue is a ticket if it has the queue label and is not a spec. An issue
 * is a spec if it has child issues, if an open issue names it as its parent,
 * or if `origin` has a spec branch for it. The runner never implements a spec.
 *
 * @param openIssues Every open issue of the repository.
 * @param options The queue label, the branch config, and the branches on `origin`.
 * @returns The ready and the waiting tickets, each sorted by issue number.
 */
export function buildQueue(openIssues: readonly GitHubIssue[], options: QueueOptions): QueueView {
  const openNumbers = new Set(openIssues.map((issue) => issue.number));
  const specNumbers = collectSpecNumbers(openIssues, options.remoteBranches);
  const issuesInOrder = [...openIssues].sort(byNumber);

  const tickets: Ticket[] = [];
  for (const issue of issuesInOrder) {
    const isTicket = hasLabel(issue, options.queueLabel) && !specNumbers.has(issue.number);
    if (isTicket) {
      const spec = specOf(issue, openIssues, options);
      tickets.push(toTicket(issue, openNumbers, spec));
    }
  }
  return splitByBlockers(tickets);
}

/**
 * Names the branch that collects the work of the tickets of a spec.
 *
 * The format is `<default prefix>/spec-<spec id>-<title words>`. The `spec-`
 * part keeps spec branches apart from ticket branches.
 *
 * @param specId The issue number or the feature folder name.
 * @param title The spec title. Use an empty title for no title words.
 * @param branchConfig The `branch` section of the factory config.
 * @returns A branch name such as `feat/spec-1-greetings` or `feat/spec-greetings`.
 */
export function specBranchName(specId: string, title: string, branchConfig: BranchConfig): string {
  const slug = slugify(title);
  const description = slug === "" ? `spec-${specId}` : `spec-${specId}-${slug}`;
  return `${branchConfig.defaultPrefix}/${description}`;
}

/**
 * Finds the spec branch of a GitHub spec among the branches on `origin`.
 *
 * @param remoteBranches The names of every branch on `origin`.
 * @param issueNumber The issue number of the spec.
 * @returns The first branch named `<prefix>/spec-<number>` or `<prefix>/spec-<number>-<words>`, or `null`.
 */
export function findSpecBranch(
  remoteBranches: readonly string[],
  issueNumber: number,
): string | null {
  const pattern = new RegExp(`^[^/]+/spec-${issueNumber}(?:-|$)`);
  return remoteBranches.find((branch) => pattern.test(branch)) ?? null;
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
export function branchNameFor(ticket: Ticket, branchConfig: BranchConfig): string {
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
 * @param remoteBranches The names of every branch on `origin`.
 * @returns The numbers of issues that have child issues, that an open issue
 * names as its parent, or that have a spec branch.
 */
function collectSpecNumbers(
  openIssues: readonly GitHubIssue[],
  remoteBranches: readonly string[],
): Set<number> {
  const specNumbers = new Set<number>();
  for (const issue of openIssues) {
    const childCount = issue.subIssues?.totalCount ?? 0;
    const hasSpecBranch = findSpecBranch(remoteBranches, issue.number) !== null;
    if (childCount > 0 || hasSpecBranch) {
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
export function parentNumberOf(issue: GitHubIssue): number | null {
  if (issue.parent) {
    return issue.parent.number;
  }
  const writtenParents = issueNumbersUnderHeading(issue.body, "Parent");
  return writtenParents[0] ?? null;
}

/**
 * Builds the spec of a ticket from its parent issue.
 *
 * @param issue An open issue that has the queue label.
 * @param openIssues Every open issue, to read the title of the parent.
 * @param options The branch config and the branches on `origin`.
 * @returns The spec, or `null` if the issue has no parent.
 */
function specOf(
  issue: GitHubIssue,
  openIssues: readonly GitHubIssue[],
  options: QueueOptions,
): Spec | null {
  const parentNumber = parentNumberOf(issue);
  if (parentNumber === null) {
    return null;
  }
  const parentIssue = openIssues.find((candidate) => candidate.number === parentNumber);
  const title = parentIssue?.title ?? issue.parent?.title ?? `Spec ${parentNumber}`;
  const existingBranch = findSpecBranch(options.remoteBranches, parentNumber);
  const id = String(parentNumber);
  return {
    id,
    reference: `#${parentNumber}`,
    title,
    location: id,
    branch: existingBranch ?? specBranchName(id, title, options.branch),
  };
}

/**
 * Converts an issue into a ticket and works out what it waits for.
 *
 * @param issue An open issue that has the queue label.
 * @param openNumbers The numbers of every open issue.
 * @param spec The spec of the issue, or `null`.
 * @returns The ticket. `waitingOn` holds only blockers that are still open.
 */
function toTicket(issue: GitHubIssue, openNumbers: ReadonlySet<number>, spec: Spec | null): Ticket {
  const nativeBlockers = issue.blockedBy?.nodes.map((node) => node.number) ?? [];
  const writtenBlockers = issueNumbersUnderHeading(issue.body, "Blocked by");
  const allBlockers = new Set([...nativeBlockers, ...writtenBlockers]);
  allBlockers.delete(issue.number);

  const openBlockers = [...allBlockers].filter((blocker) => openNumbers.has(blocker));
  openBlockers.sort((first, second) => first - second);

  return {
    id: String(issue.number),
    reference: `#${issue.number}`,
    title: issue.title,
    body: issue.body,
    labels: issue.labels.map((label) => label.name),
    spec,
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
