/**
 * The GitHub tracker: tickets are GitHub issues, and each finished ticket
 * becomes a pull request. Every GitHub action runs on the host machine with
 * the GitHub login of the person who started the runner. The agents in the
 * sandbox never receive a GitHub token.
 */

import type { FactoryConfig } from "./config.mts";
import * as git from "./git.mts";
import { runCommand, runRequired } from "./process.mts";
import { blockedComment, pullRequestBody } from "./report.mts";
import { buildQueue, type GitHubIssue, type QueueView, type Ticket } from "./tickets.mts";
import type { ApprovedWork, Delivery, Tracker } from "./tracker.mts";

/** The issue fields that the runner reads. */
const ISSUE_FIELDS = "number,title,body,labels,blockedBy,subIssues,parent";

/** The highest number of open issues that one runner start reads. */
const ISSUE_LIMIT = "1000";

/** What happened when the runner waited for the checks of a pull request. */
interface MergeResult {
  readonly merged: boolean;
  /** Why the runner did not merge. Empty when `merged` is `true`. */
  readonly reason: string;
}

/**
 * Confirms that `gh` works for this repository.
 *
 * @returns The repository name, such as `owner/project`.
 * @throws Error if `gh` is missing, is not logged in, or finds no GitHub repository here.
 */
async function requireRepository(): Promise<string> {
  return runRequired("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
}

/**
 * Reads every open issue of the repository.
 *
 * @returns The open issues with labels, blockers, child issues, and parent.
 */
async function listOpenIssues(): Promise<GitHubIssue[]> {
  const output = await runRequired("gh", [
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    ISSUE_LIMIT,
    "--json",
    ISSUE_FIELDS,
  ]);
  return JSON.parse(output) as GitHubIssue[];
}

/**
 * Reads the body of one issue. The runner uses it to give an agent the spec of a ticket.
 *
 * @param issueNumber The issue to read.
 * @returns The Markdown body.
 */
async function readIssueBody(issueNumber: number): Promise<string> {
  return runRequired("gh", [
    "issue",
    "view",
    String(issueNumber),
    "--json",
    "body",
    "--jq",
    ".body",
  ]);
}

/**
 * Looks for an open pull request from a branch.
 *
 * @param branch The head branch of the pull request.
 * @returns The pull request URL, or `null` if there is none.
 */
async function findOpenPullRequest(branch: string): Promise<string | null> {
  const output = await runRequired("gh", [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "url",
    "--jq",
    ".[0].url // empty",
  ]);
  return output === "" ? null : output;
}

/**
 * Opens a pull request.
 *
 * @param pullRequest The base branch, head branch, title, and Markdown body.
 * @returns The URL of the new pull request.
 */
async function createPullRequest(pullRequest: {
  readonly base: string;
  readonly head: string;
  readonly title: string;
  readonly body: string;
}): Promise<string> {
  const output = await runRequired(
    "gh",
    [
      "pr",
      "create",
      "--base",
      pullRequest.base,
      "--head",
      pullRequest.head,
      "--title",
      pullRequest.title,
      "--body-file",
      "-",
    ],
    { input: pullRequest.body },
  );
  // `gh pr create` prints the URL on the last line.
  const lines = output.split("\n");
  return lines[lines.length - 1] ?? output;
}

/**
 * Adds a comment to an issue.
 *
 * @param issueNumber The issue to comment on.
 * @param body The Markdown text of the comment.
 */
async function commentOnIssue(issueNumber: number, body: string): Promise<void> {
  await runRequired("gh", ["issue", "comment", String(issueNumber), "--body-file", "-"], {
    input: body,
  });
}

/**
 * Takes a ticket out of the agent queue and hands it to a person.
 *
 * @param issueNumber The ticket.
 * @param queueLabel The label to remove.
 * @param blockedLabel The label to add.
 */
async function moveToBlocked(
  issueNumber: number,
  queueLabel: string,
  blockedLabel: string,
): Promise<void> {
  await runRequired("gh", [
    "issue",
    "edit",
    String(issueNumber),
    "--remove-label",
    queueLabel,
    "--add-label",
    blockedLabel,
  ]);
}

/**
 * Waits for the GitHub checks of a pull request, then merges it.
 *
 * A pull request with no checks merges at once, because the runner already
 * passed the project checks in the sandbox.
 *
 * @param pullRequestUrl The pull request to merge.
 * @param method How to merge: `squash`, `merge`, or `rebase`.
 * @returns Whether the merge happened, and the reason if it did not.
 */
async function mergeWhenChecksPass(
  pullRequestUrl: string,
  method: "squash" | "merge" | "rebase",
): Promise<MergeResult> {
  const checks = await runCommand("gh", ["pr", "checks", pullRequestUrl, "--watch"]);
  const checkOutput = `${checks.stdout}\n${checks.stderr}`;
  const hasNoChecks = /no checks reported/i.test(checkOutput);
  if (checks.exitCode !== 0 && !hasNoChecks) {
    return { merged: false, reason: `GitHub checks did not pass:\n${checkOutput.trim()}` };
  }

  const merge = await runCommand("gh", [
    "pr",
    "merge",
    pullRequestUrl,
    `--${method}`,
    "--delete-branch",
  ]);
  if (merge.exitCode !== 0) {
    return { merged: false, reason: `GitHub refused the merge:\n${merge.stderr.trim()}` };
  }
  return { merged: true, reason: "" };
}

/**
 * Creates the GitHub tracker for the repository in the current directory.
 *
 * @param config The factory config.
 * @returns The tracker.
 * @throws Error if `gh` is missing, is not logged in, or finds no GitHub repository here.
 */
export async function createGitHubTracker(config: FactoryConfig): Promise<Tracker> {
  const repository = await requireRepository();
  return new GitHubTracker(config, repository);
}

/** Reads tickets from GitHub issues and turns finished tickets into pull requests. */
class GitHubTracker implements Tracker {
  /** Names the repository for the first line of the runner output. */
  readonly description: string;
  /** The factory config. */
  readonly #config: FactoryConfig;

  /**
   * Creates the tracker for a repository that `gh` can reach.
   *
   * @param config The factory config.
   * @param repository The repository name, such as `owner/project`.
   */
  constructor(config: FactoryConfig, repository: string) {
    this.#config = config;
    this.description = `GitHub repository ${repository}`;
  }

  /**
   * Reads the open issues and builds the queue from them.
   *
   * @returns The ready and the waiting tickets.
   */
  async readQueue(): Promise<QueueView> {
    const openIssues = await listOpenIssues();
    return buildQueue(openIssues, this.#config.labels.queue);
  }

  /**
   * Reads the body of the parent issue of a ticket.
   *
   * @param ticket The ticket.
   * @returns The body of the spec issue, or a note that the ticket has no spec.
   */
  async readSpec(ticket: Ticket): Promise<string> {
    if (ticket.specLocation === null) {
      return "This ticket has no spec. The ticket text is the full request.";
    }
    return readIssueBody(Number(ticket.specLocation));
  }

  /**
   * Looks for an open pull request from the ticket branch.
   *
   * @param branch The ticket branch.
   * @returns The pull request URL, or `null` if there is none.
   */
  findOpenReview(branch: string): Promise<string | null> {
    return findOpenPullRequest(branch);
  }

  /**
   * Pushes the ticket branch and opens its pull request. With `merge.mode`
   * set to `auto`, it also waits for the GitHub checks and merges.
   *
   * @param ticket The approved ticket.
   * @param branch The local branch with the commits.
   * @param work The review and the check results.
   * @returns A `pull-request` or `merged` delivery.
   */
  async deliver(ticket: Ticket, branch: string, work: ApprovedWork): Promise<Delivery> {
    const { baseBranch, merge } = this.#config;
    await git.pushBranch(branch);
    const url = await createPullRequest({
      base: baseBranch,
      head: branch,
      title: ticket.title,
      body: pullRequestBody(ticket, work.review, work.checks),
    });

    if (merge.mode === "manual") {
      return { status: "pull-request", url, note: "" };
    }

    const mergeResult = await mergeWhenChecksPass(url, merge.method);
    if (mergeResult.merged) {
      return { status: "merged", url };
    }
    return { status: "pull-request", url, note: mergeResult.reason };
  }

  /**
   * Comments the reason on the issue and moves the issue from the queue label to the blocked label.
   *
   * @param ticket The ticket.
   * @param branch The local branch that can hold partial work.
   * @param reason Why the work stopped.
   */
  async handBack(ticket: Ticket, branch: string, reason: string): Promise<void> {
    const { queue, blocked } = this.#config.labels;
    const issueNumber = Number(ticket.id);
    const retryHint = `The ticket now has the \`${blocked}\` label. Update the ticket, then put the \`${queue}\` label back to try again.`;
    const comment = blockedComment(reason, branch, retryHint, 2);
    await commentOnIssue(issueNumber, comment);
    await moveToBlocked(issueNumber, queue, blocked);
  }
}
