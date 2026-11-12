/**
 * The Git actions of the runner. They run on the host machine and work with
 * any Git host, because they use only the `origin` remote.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand, runRequired } from "./process.mts";

/** `git ls-remote --exit-code` exits with this code when no ref matches. */
const NO_MATCHING_REF_EXIT_CODE = 2;

/** `git merge-tree --write-tree` exits with this code when the merge has conflicts. */
const MERGE_CONFLICT_EXIT_CODE = 1;

/**
 * Downloads the newest commits of a branch of `origin`.
 *
 * @param branch The branch name on the `origin` remote, such as `main`.
 * @returns The remote-tracking ref of the branch, such as `origin/main`.
 */
export async function fetchBranch(branch: string): Promise<string> {
  await runRequired("git", [
    "fetch",
    "origin",
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]);
  return `origin/${branch}`;
}

/**
 * Lists the branches of `origin`.
 *
 * @returns The branch names, such as `main` and `feat/spec-1-greetings`.
 */
export async function listRemoteBranches(): Promise<string[]> {
  const output = await runRequired("git", ["ls-remote", "--heads", "origin"]);
  const branches: string[] = [];
  for (const line of output.split("\n")) {
    const refMatch = /\srefs\/heads\/(.+)$/.exec(line);
    if (refMatch?.[1] !== undefined) {
      branches.push(refMatch[1]);
    }
  }
  return branches;
}

/**
 * Creates a branch on `origin` if it does not exist yet.
 *
 * @param branch The branch name to create, such as `feat/spec-1-greetings`.
 * @param startRef The commit of the new branch, such as `origin/main`.
 */
export async function ensureRemoteBranch(branch: string, startRef: string): Promise<void> {
  const lookup = await runCommand("git", ["ls-remote", "--exit-code", "--heads", "origin", branch]);
  if (lookup.exitCode === 0) {
    return;
  }
  if (lookup.exitCode !== NO_MATCHING_REF_EXIT_CODE) {
    throw new Error(`git ls-remote failed:\n${lookup.stderr.trim()}`);
  }
  const startCommit = await runRequired("git", ["rev-parse", "--verify", `${startRef}^{commit}`]);
  await runRequired("git", ["push", "origin", `${startCommit}:refs/heads/${branch}`]);
}

/**
 * Checks whether a branch merges into another ref with no conflict.
 *
 * @param targetRef The ref that receives the merge, such as `origin/feat/spec-1-greetings`.
 * @param branch The branch to merge.
 * @returns `true` if Git can merge the two with no conflict.
 * @throws Error if Git cannot compute the merge.
 */
export async function mergesCleanly(targetRef: string, branch: string): Promise<boolean> {
  const merge = await runCommand("git", ["merge-tree", "--write-tree", targetRef, branch]);
  if (merge.exitCode === MERGE_CONFLICT_EXIT_CODE) {
    return false;
  }
  if (merge.exitCode !== 0) {
    throw new Error(`git merge-tree failed:\n${merge.stderr.trim()}`);
  }
  return true;
}

/**
 * Merges a local branch into a branch of `origin` and pushes the result.
 *
 * The merge happens in a temporary checkout, so the working tree of the
 * person who started the runner does not change.
 *
 * @param branch The local branch to merge.
 * @param targetBranch The branch on `origin` that receives the merge.
 * @param message The message of the merge commit.
 * @throws Error if the merge has a conflict or the push fails.
 */
export async function mergeIntoRemoteBranch(
  branch: string,
  targetBranch: string,
  message: string,
): Promise<void> {
  const targetRef = await fetchBranch(targetBranch);
  const temporaryParent = path.join(os.tmpdir(), "factory-merge-");
  const checkoutDir = await mkdtemp(temporaryParent);
  await runRequired("git", ["worktree", "add", "--quiet", "--detach", checkoutDir, targetRef]);
  try {
    await runRequired("git", ["merge", "--no-ff", "--quiet", "-m", message, branch], {
      cwd: checkoutDir,
    });
    await runRequired("git", ["push", "origin", `HEAD:refs/heads/${targetBranch}`], {
      cwd: checkoutDir,
    });
  } finally {
    await runCommand("git", ["worktree", "remove", "--force", checkoutDir]);
    await rm(checkoutDir, { recursive: true, force: true });
  }
}

/**
 * Uploads a ticket branch to the `origin` remote.
 *
 * @param branch The local branch to push.
 */
export async function pushBranch(branch: string): Promise<void> {
  await runRequired("git", ["push", "--set-upstream", "origin", branch]);
}

/**
 * Finds a local branch that an earlier run created for a ticket.
 *
 * The runner reuses that branch, so a changed ticket title does not hide earlier commits.
 *
 * @param ticketId The ticket id, such as `42` or `greetings-02`.
 * @returns The branch name, or `null` if no local branch belongs to the ticket.
 */
export async function findTicketBranch(ticketId: string): Promise<string | null> {
  const output = await runRequired("git", [
    "branch",
    "--list",
    "--format=%(refname:short)",
    `*/${ticketId}`,
    `*/${ticketId}-*`,
  ]);
  const branches = output.split("\n").filter((name) => name !== "");
  return branches[0] ?? null;
}

/**
 * Counts the commits that a branch has and the base does not.
 *
 * @param baseRef The ref the branch started from, such as `origin/main`.
 * @param branch The ticket branch.
 * @returns The number of commits ahead of the base.
 */
export async function countCommitsAhead(baseRef: string, branch: string): Promise<number> {
  const output = await runRequired("git", ["rev-list", "--count", `${baseRef}..${branch}`]);
  return Number(output);
}
