/**
 * The Git actions of the runner. They run on the host machine and work with
 * any Git host, because they use only the `origin` remote.
 */

import { runRequired } from "./process.mts";

/**
 * Downloads the newest commits of the base branch.
 *
 * @param baseBranch The branch name on the `origin` remote.
 * @returns The ref that new ticket branches start from, such as `origin/main`.
 */
export async function fetchBase(baseBranch: string): Promise<string> {
  await runRequired("git", ["fetch", "origin", baseBranch]);
  return `origin/${baseBranch}`;
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
