/**
 * The GitHub tracker: tickets are GitHub issues, and each finished ticket
 * becomes a pull request. A ticket on its own gets a pull request to the base
 * branch. A ticket of a spec gets a pull request to the spec branch, which the
 * runner merges at once. When every ticket of a spec is closed, the spec
 * branch gets one pull request to the base branch.
 *
 * Every GitHub action runs on the host machine with the GitHub login of the
 * person who started the runner. The agents in the sandbox never receive a
 * GitHub token.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { FactoryConfig } from "./config.mts";
import { evidenceMarkdown, type Evidence } from "./evidence.mts";
import * as git from "./git.mts";
import { runCommand, runRequired } from "./process.mts";
import { blockedComment, pullRequestBody, specReport, type SpecPart } from "./report.mts";
import {
  buildQueue,
  findSpecBranch,
  parentNumberOf,
  type GitHubIssue,
  type QueueView,
  type Spec,
  type Ticket,
} from "./tickets.mts";
import type { ApprovedWork, Delivery, SpecDelivery, Tracker } from "./tracker.mts";

/** The issue fields that the runner reads. */
const ISSUE_FIELDS = "number,title,body,labels,blockedBy,subIssues,parent";

/** The highest number of open issues that one runner start reads. */
const ISSUE_LIMIT = "1000";

/** The highest number of merged pull requests that the runner reads for one spec. */
const PULL_REQUEST_LIMIT = "1000";

/** The file name of the pull request body in the evidence folder. */
const PULL_REQUEST_BODY_FILE = "pull-request.md";

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

/** A pull request that GitHub reports in a list. */
interface ListedPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly body: string;
}

/** What the runner sends to GitHub to open a pull request. */
interface PullRequestDraft {
  readonly base: string;
  readonly head: string;
  readonly title: string;
  readonly body: string;
  /** The proof to upload with the pull request. `null` for a pull request with no files to upload. */
  readonly evidence: Evidence | null;
}

/**
 * Opens a pull request. GitHub CLI uploads the evidence files and replaces
 * each link to a file in the body with the address of the upload.
 *
 * If the upload fails, the runner opens the pull request without the files
 * and adds the reason to the body.
 *
 * @param draft The branches, the title, the body, and the evidence.
 * @returns The URL of the new pull request.
 */
async function createPullRequest(draft: PullRequestDraft): Promise<string> {
  const baseArgs = [
    "pr",
    "create",
    "--base",
    draft.base,
    "--head",
    draft.head,
    "--title",
    draft.title,
  ];
  const evidence = draft.evidence;
  if (evidence === null || evidence.files.length === 0) {
    const output = await runRequired("gh", [...baseArgs, "--body-file", "-"], {
      input: draft.body,
    });
    return lastLine(output);
  }

  // Links in a body file are relative to its folder, so the body sits next to the evidence files.
  const bodyPath = path.join(evidence.folder, PULL_REQUEST_BODY_FILE);
  await writeFile(bodyPath, draft.body);
  const attachArgs = evidence.files.flatMap((filePath) => ["--attach", filePath]);
  const upload = await runCommand("gh", [...baseArgs, "--body-file", bodyPath, ...attachArgs]);
  if (upload.exitCode === 0) {
    return lastLine(upload.stdout.trim());
  }

  const reason = upload.stderr.trim() || upload.stdout.trim();
  const note = `The software factory could not upload the evidence files, so the links above do not work:\n\n\`\`\`text\n${reason}\n\`\`\``;
  const bodyWithNote = `${draft.body}\n\n${note}`;
  const output = await runRequired("gh", [...baseArgs, "--body-file", "-"], {
    input: bodyWithNote,
  });
  return lastLine(output);
}

/**
 * Reads the last line of a text. `gh pr create` prints the URL on the last line.
 *
 * @param output The output of a command.
 * @returns The last line, or the whole output if it has one line.
 */
function lastLine(output: string): string {
  const lines = output.split("\n");
  return lines[lines.length - 1] ?? output;
}

/**
 * Lists the merged pull requests into a branch.
 *
 * @param base The branch that the pull requests merged into.
 * @returns The pull requests, sorted by number.
 */
async function listMergedPullRequests(base: string): Promise<ListedPullRequest[]> {
  const output = await runRequired("gh", [
    "pr",
    "list",
    "--base",
    base,
    "--state",
    "merged",
    "--limit",
    PULL_REQUEST_LIMIT,
    "--json",
    "number,title,url,body",
  ]);
  const pullRequests = JSON.parse(output) as ListedPullRequest[];
  return pullRequests.sort((first, second) => first.number - second.number);
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
 * Closes an issue with a comment.
 *
 * @param issueNumber The issue to close.
 * @param comment The Markdown text of the closing comment.
 */
async function closeIssue(issueNumber: number, comment: string): Promise<void> {
  await runRequired("gh", ["issue", "close", String(issueNumber), "--comment", comment]);
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
 * Waits for the GitHub checks of a pull request.
 *
 * A pull request with no checks passes at once, because the runner already
 * passed the project checks in the sandbox.
 *
 * @param pullRequestUrl The pull request.
 * @returns Why the checks did not pass, or an empty text if they passed.
 */
async function waitForChecks(pullRequestUrl: string): Promise<string> {
  const checks = await runCommand("gh", ["pr", "checks", pullRequestUrl, "--watch"]);
  const checkOutput = `${checks.stdout}\n${checks.stderr}`;
  const hasNoChecks = /no checks reported/i.test(checkOutput);
  if (checks.exitCode !== 0 && !hasNoChecks) {
    return `GitHub checks did not pass:\n${checkOutput.trim()}`;
  }
  return "";
}

/**
 * Merges a pull request and deletes its branch on `origin`.
 *
 * The local branch stays, because the sandbox of the ticket can still use it.
 *
 * @param pullRequestUrl The pull request to merge.
 * @param head The branch of the pull request.
 * @param method How to merge: `squash`, `merge`, or `rebase`.
 * @returns Why GitHub refused the merge, or an empty text if the merge happened.
 */
async function mergePullRequest(
  pullRequestUrl: string,
  head: string,
  method: FactoryConfig["merge"]["method"],
): Promise<string> {
  const merge = await runCommand("gh", ["pr", "merge", pullRequestUrl, `--${method}`]);
  if (merge.exitCode !== 0) {
    return `GitHub refused the merge:\n${merge.stderr.trim()}`;
  }
  // A failed delete leaves only an extra branch on origin, so the runner ignores it.
  await runCommand("git", ["push", "origin", "--delete", head]);
  return "";
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
   * Reads the open issues and the branches on `origin`, and builds the queue from them.
   *
   * @returns The ready and the waiting tickets.
   */
  async readQueue(): Promise<QueueView> {
    const openIssues = await listOpenIssues();
    const remoteBranches = await git.listRemoteBranches();
    return buildQueue(openIssues, {
      queueLabel: this.#config.labels.queue,
      branch: this.#config.branch,
      remoteBranches,
    });
  }

  /**
   * Reads the body of the parent issue of a ticket.
   *
   * @param ticket The ticket.
   * @returns The body of the spec issue, or a note that the ticket has no spec.
   */
  async readSpec(ticket: Ticket): Promise<string> {
    if (ticket.spec === null) {
      return "This ticket has no spec. The ticket text is the full request.";
    }
    return readIssueBody(Number(ticket.spec.location));
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
   * Pushes the ticket branch and opens its pull request with the evidence.
   *
   * A ticket of a spec: the runner merges the pull request into the spec
   * branch at once and closes the issue. A ticket on its own: with
   * `merge.mode` set to `auto`, the runner waits for the GitHub checks and merges.
   *
   * @param ticket The approved ticket.
   * @param branch The local branch with the commits.
   * @param work The review, the check results, and the evidence.
   * @returns A `pull-request` or `merged` delivery.
   */
  async deliver(ticket: Ticket, branch: string, work: ApprovedWork): Promise<Delivery> {
    const { baseBranch, merge } = this.#config;
    await git.pushBranch(branch);
    const evidenceText = evidenceMarkdown(work.evidence, "");
    const url = await createPullRequest({
      base: ticket.spec?.branch ?? baseBranch,
      head: branch,
      title: ticket.title,
      body: pullRequestBody(ticket, { ...work, evidenceText }),
      evidence: work.evidence,
    });

    if (ticket.spec !== null) {
      return this.#mergeIntoSpec(ticket, ticket.spec, branch, url);
    }
    if (merge.mode === "manual") {
      return { status: "pull-request", url, note: "" };
    }
    return this.#mergeWhenChecksPass(url, branch);
  }

  /**
   * Opens the final pull request of each spec whose tickets are all closed.
   *
   * A spec is finished when its issue is open, `origin` has its spec branch
   * with work that the base branch lacks, no open issue names it as its
   * parent, and no pull request from the spec branch is open.
   *
   * @returns One delivery for each finished spec.
   */
  async deliverFinishedSpecs(): Promise<SpecDelivery[]> {
    const openIssues = await listOpenIssues();
    const remoteBranches = await git.listRemoteBranches();
    const openParents = new Set(openIssues.map(parentNumberOf));
    const deliveries: SpecDelivery[] = [];

    for (const issue of openIssues) {
      const specBranch = findSpecBranch(remoteBranches, issue.number);
      const hasOpenTickets = openParents.has(issue.number);
      if (specBranch === null || hasOpenTickets) {
        continue;
      }
      const spec: Spec = {
        id: String(issue.number),
        reference: `#${issue.number}`,
        title: issue.title,
        location: String(issue.number),
        branch: specBranch,
      };
      const isReady = await this.#isReadyForFinalPullRequest(spec);
      if (isReady) {
        const delivery = await this.#deliverSpec(spec);
        deliveries.push({ ...delivery, spec });
      }
    }
    return deliveries;
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

  /**
   * Merges the pull request of a ticket into its spec branch and closes the ticket.
   *
   * @param ticket The ticket.
   * @param spec The spec of the ticket.
   * @param branch The ticket branch.
   * @param url The pull request into the spec branch.
   * @returns `merged`, or `pull-request` with the reason if GitHub refused the merge.
   */
  async #mergeIntoSpec(ticket: Ticket, spec: Spec, branch: string, url: string): Promise<Delivery> {
    const refusal = await mergePullRequest(url, branch, this.#config.merge.method);
    if (refusal !== "") {
      return { status: "pull-request", url, note: refusal };
    }
    const comment = `The software factory merged ${url} into the spec branch \`${spec.branch}\`. The final pull request of the spec ${spec.reference} opens when every ticket of the spec is closed.`;
    await closeIssue(Number(ticket.id), comment);
    return { status: "merged", url, target: spec.branch };
  }

  /**
   * Waits for the GitHub checks of a pull request to the base branch, then merges it.
   *
   * @param url The pull request.
   * @param branch The branch of the pull request.
   * @returns `merged`, or `pull-request` with the reason the merge did not happen.
   */
  async #mergeWhenChecksPass(url: string, branch: string): Promise<Delivery> {
    const { baseBranch, merge } = this.#config;
    const checkProblem = await waitForChecks(url);
    if (checkProblem !== "") {
      return { status: "pull-request", url, note: checkProblem };
    }
    const refusal = await mergePullRequest(url, branch, merge.method);
    if (refusal !== "") {
      return { status: "pull-request", url, note: refusal };
    }
    return { status: "merged", url, target: baseBranch };
  }

  /**
   * Checks that a spec branch has work for a final pull request and has no open one.
   *
   * @param spec A spec whose tickets are all closed.
   * @returns `true` if the runner opens the final pull request now.
   */
  async #isReadyForFinalPullRequest(spec: Spec): Promise<boolean> {
    const openPullRequest = await findOpenPullRequest(spec.branch);
    if (openPullRequest !== null) {
      return false;
    }
    const baseRef = await git.fetchBranch(this.#config.baseBranch);
    const specRef = await git.fetchBranch(spec.branch);
    const commitCount = await git.countCommitsAhead(baseRef, specRef);
    return commitCount > 0;
  }

  /**
   * Opens the final pull request of a spec, with the summary and the evidence of each ticket.
   *
   * @param spec The finished spec.
   * @returns `pull-request`, or `merged` with `merge.mode` set to `auto`.
   */
  async #deliverSpec(spec: Spec): Promise<Delivery> {
    const mergedTickets = await listMergedPullRequests(spec.branch);
    const parts: SpecPart[] = mergedTickets.map((pullRequest) => ({
      title: pullRequest.title,
      link: pullRequest.url,
      report: pullRequest.body,
    }));
    const report = specReport(spec, parts);
    const url = await createPullRequest({
      base: this.#config.baseBranch,
      head: spec.branch,
      title: spec.title,
      body: `Closes ${spec.reference}\n\n${report}`,
      evidence: null,
    });

    if (this.#config.merge.mode === "manual") {
      return { status: "pull-request", url, note: "" };
    }
    return this.#mergeWhenChecksPass(url, spec.branch);
  }
}
