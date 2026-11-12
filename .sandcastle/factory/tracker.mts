/**
 * The place where tickets live. The runner reads the queue from a tracker and
 * reports every result back to it. Two trackers exist: GitHub issues and
 * Markdown files.
 */

import type { FactoryConfig } from "./config.mts";
import { createGitHubTracker } from "./github.mts";
import { createMarkdownTracker } from "./markdown.mts";
import type { Evidence } from "./evidence.mts";
import type { CheckResult, Review } from "./report.mts";
import type { QueueView, Spec, Ticket } from "./tickets.mts";

/** The proof that a ticket passed the checks and the review. */
export interface ApprovedWork {
  readonly review: Review;
  /** The results of the final check round. */
  readonly checks: readonly CheckResult[];
  /** The screenshots, recordings, and notes that the implementer saved. */
  readonly evidence: Evidence;
}

/**
 * What the tracker did with an approved ticket or a finished spec.
 *
 * - `pull-request`: a new pull request waits for a person to merge it (GitHub).
 * - `merged`: the runner merged the work into `target`: a ticket of a spec
 *   into the spec branch, or a pull request into the base branch with
 *   `merge.mode` set to `auto`. `url` is `null` when no pull request exists (Markdown).
 * - `pushed`: the branch is on `origin`. A person opens the pull request (Markdown).
 */
export type Delivery =
  | {
      readonly status: "pull-request";
      readonly url: string;
      /** Why a merge did not happen. Empty if the runner did not try to merge. */
      readonly note: string;
    }
  | { readonly status: "merged"; readonly url: string | null; readonly target: string }
  | {
      readonly status: "pushed";
      readonly branch: string;
      /** What the person does next. Empty for the default advice. */
      readonly note: string;
    };

/** What the tracker did with a spec whose tickets are all closed. */
export type SpecDelivery = { readonly spec: Spec } & Delivery;

/** The actions that the runner needs from a ticket tracker. */
export interface Tracker {
  /** Names the tracker for the first line of the runner output, such as `GitHub repository owner/project`. */
  readonly description: string;

  /**
   * Reads the tickets of the queue.
   *
   * @returns The ready and the waiting tickets.
   */
  readQueue(): Promise<QueueView>;

  /**
   * Reads the spec that a ticket belongs to.
   *
   * @param ticket The ticket.
   * @returns The spec text, or a note that the ticket has no spec.
   */
  readSpec(ticket: Ticket): Promise<string>;

  /**
   * Looks for a review that an earlier run already started for a branch.
   *
   * @param branch The ticket branch.
   * @returns The pull request URL, or `null` if no review is open.
   */
  findOpenReview(branch: string): Promise<string | null>;

  /**
   * Publishes an approved ticket and records the result on the ticket.
   *
   * A ticket of a spec goes into the spec branch at once, whatever the merge
   * mode. The runner checks before this call that it merges with no conflict.
   *
   * @param ticket The approved ticket.
   * @param branch The local branch with the commits.
   * @param work The review, the check results, and the evidence.
   * @returns What happened to the ticket.
   */
  deliver(ticket: Ticket, branch: string, work: ApprovedWork): Promise<Delivery>;

  /**
   * Finds each spec whose tickets are all closed and whose spec branch has
   * work, and delivers the spec branch: a pull request to the base branch
   * with the evidence of every ticket (GitHub), or a pull request text for a
   * person (Markdown). `merge.mode` decides if the runner merges it.
   *
   * @returns One delivery for each spec that was ready. Empty if none was.
   */
  deliverFinishedSpecs(): Promise<SpecDelivery[]>;

  /**
   * Records that an agent could not finish a ticket, and takes the ticket out of the queue.
   *
   * @param ticket The ticket.
   * @param branch The local branch that can hold partial work.
   * @param reason Why the work stopped.
   */
  handBack(ticket: Ticket, branch: string, reason: string): Promise<void>;
}

/**
 * Creates the tracker that the config names.
 *
 * @param config The factory config.
 * @param projectRoot Absolute path of the project root.
 * @returns The GitHub tracker or the Markdown tracker.
 * @throws Error if the GitHub tracker cannot reach the repository with `gh`.
 */
export async function createTracker(config: FactoryConfig, projectRoot: string): Promise<Tracker> {
  if (config.tracker.type === "markdown") {
    return createMarkdownTracker(config, config.tracker.folder, projectRoot);
  }
  return createGitHubTracker(config);
}
