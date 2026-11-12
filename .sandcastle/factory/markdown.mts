/**
 * The Markdown tracker, for a repository that is not on GitHub. Tickets are
 * files in the local Markdown format of the Matt Pocock skills:
 *
 *   <folder>/<feature>/spec.md            the spec of the feature (optional)
 *   <folder>/<feature>/issues/NN-<slug>.md one ticket
 *
 * A ticket file has a `Status:` line and a `Blocked by:` line near the top,
 * and comments under a `## Comments` heading at the end.
 *
 * A feature folder with a spec file is a spec. The runner merges each
 * finished ticket of a spec into the spec branch on `origin`. When every
 * ticket of the spec is done, the runner writes `pull-request.md` in the
 * feature folder, and a person opens the pull request of the spec branch.
 * For a feature folder with no spec file, the runner pushes the branch of
 * each finished ticket, and a person opens its pull request.
 *
 * The runner copies the evidence of each ticket to
 * `<folder>/<feature>/evidence/<ticket number>/`.
 */

import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FactoryConfig } from "./config.mts";
import { evidenceMarkdown, rewriteLinkTargets, type Evidence } from "./evidence.mts";
import * as git from "./git.mts";
import { blockedComment, specReport, workReport, type SpecPart } from "./report.mts";
import type { QueueView, Spec, Ticket } from "./tickets.mts";
import { specBranchName, splitByBlockers } from "./tickets.mts";
import type { ApprovedWork, Delivery, SpecDelivery, Tracker } from "./tracker.mts";

/**
 * The status that the runner writes when it pushes the branch of a ticket.
 * A blocker with this status no longer blocks other tickets.
 */
export const DONE_STATUS = "done";

/** The file name of the spec in a feature folder. */
const SPEC_FILE_NAME = "spec.md";

/** The folder of the ticket files in a feature folder. */
const TICKETS_FOLDER_NAME = "issues";

/** A ticket file name: a number, then an optional slug, such as `02-add-greeting.md`. */
const TICKET_FILE_PATTERN = /^(\d+)(?:-[^/]*)?\.md$/;

/** The heading that starts the comments of a ticket file. */
const COMMENTS_HEADING = "## Comments";

/** The heading text that starts each comment of the runner, before the time. */
const RUNNER_COMMENT_HEADING = "### Software factory";

/** The folder in a feature folder that holds the evidence of each ticket. */
const EVIDENCE_FOLDER_NAME = "evidence";

/** The file in a feature folder with the pull request text of a finished spec. */
const PULL_REQUEST_FILE_NAME = "pull-request.md";

/** Where the file of one ticket lives. */
interface TicketLocation {
  /** Absolute path of the ticket file. */
  readonly filePath: string;
  /** Absolute path of the feature folder. */
  readonly featureDir: string;
  /** The number at the start of the file name, as written, such as `02`. */
  readonly numberText: string;
}

/** One ticket file, read from disk. */
export interface TicketFile {
  /** The name of the feature folder, such as `greetings`. */
  readonly feature: string;
  /** The number at the start of the file name, as written, such as `02`. */
  readonly numberText: string;
  /** The file name, such as `02-add-greeting.md`. */
  readonly fileName: string;
  readonly text: string;
}

/**
 * Builds the queue from ticket files.
 *
 * A file is a ticket in the queue when its status is the queue status. A
 * blocker is open when its file is missing or its status is not
 * {@link DONE_STATUS}. Blocker numbers refer to tickets of the same feature.
 *
 * @param files Every ticket file of every feature.
 * @param queueStatus The status that marks a ticket as ready for an agent.
 * @param specs The spec of each feature that has a spec file, by feature name.
 * @returns The ready and the waiting tickets, sorted by feature and number.
 * @throws Error if two files of one feature have the same number.
 */
export function buildMarkdownQueue(
  files: readonly TicketFile[],
  queueStatus: string,
  specs: ReadonlyMap<string, Spec>,
): QueueView {
  const filesByKey = indexByFeatureAndNumber(files);
  const filesInOrder = [...files].sort(byFeatureAndNumber);

  const tickets: Ticket[] = [];
  for (const file of filesInOrder) {
    const status = readField(file.text, "Status");
    if (status === queueStatus) {
      const spec = specs.get(file.feature) ?? null;
      tickets.push(toTicket(file, filesByKey, spec));
    }
  }
  return splitByBlockers(tickets);
}

/**
 * Reads the value of a field line, such as `**Status:** ready-for-agent`.
 *
 * The search covers only the part before `## Comments`. Bold marks and code
 * marks around the name and the value do not matter. If the line has no value,
 * the list items on the next lines are the value, joined by commas.
 *
 * @param text The text of a ticket file.
 * @param fieldName The field name, such as `Status` or `Blocked by`.
 * @returns The trimmed value, or `null` if the file has no such line.
 */
export function readField(text: string, fieldName: string): string | null {
  const lines = text.split("\n");
  const lineIndex = findFieldLine(lines, fieldName);
  if (lineIndex === -1) {
    return null;
  }

  const fieldLine = withoutMarks(lines[lineIndex] ?? "");
  const colonIndex = fieldLine.indexOf(":");
  const value = fieldLine.slice(colonIndex + 1).trim();
  if (value !== "") {
    return value;
  }

  const listItems: string[] = [];
  for (const line of lines.slice(lineIndex + 1)) {
    const listItem = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (listItem === null) {
      break;
    }
    const itemText = listItem[1] ?? "";
    listItems.push(withoutMarks(itemText));
  }
  return listItems.join(", ");
}

/**
 * Reads the ticket numbers of a `Blocked by` value.
 *
 * Text in parentheses is skipped, so a title such as `01 (Add 2 buttons)`
 * gives only `1`. A reference to another feature, such as `billing/01`, is skipped.
 *
 * @param value The value of the `Blocked by` field, such as `01, 03` or `None (can start immediately)`.
 * @returns The ticket numbers.
 */
export function blockerNumbers(value: string): number[] {
  const withoutTitles = value.replace(/\([^)]*\)/g, " ");
  const numbers: number[] = [];
  for (const reference of withoutTitles.matchAll(/(?<![\w/])#?(\d+)(?![\w/])/g)) {
    numbers.push(Number(reference[1]));
  }
  return numbers;
}

/**
 * Reads the title of a ticket from its first `#` heading.
 *
 * @param text The text of a ticket file.
 * @param fileName The file name, used when the file has no heading.
 * @returns The heading without the ticket number, such as `Add greeting` for `# 02: Add greeting`.
 */
export function ticketTitle(text: string, fileName: string): string {
  const heading = /^#\s+(.+)$/m.exec(text);
  if (heading !== null) {
    const headingText = heading[1] ?? "";
    return headingText.replace(/^\d+\s*[:.)-]?\s*/, "").trim();
  }
  const slug = fileName.replace(/\.md$/, "").replace(/^\d+-?/, "");
  return slug.replaceAll("-", " ");
}

/**
 * Replaces the value of the `Status` line.
 *
 * @param text The text of a ticket file.
 * @param status The new status, such as `done`.
 * @returns The text with the new status. The rest of the file stays the same.
 * @throws Error if the file has no `Status` line.
 */
export function setStatus(text: string, status: string): string {
  const lines = text.split("\n");
  const lineIndex = findFieldLine(lines, "Status");
  const statusLine = lines[lineIndex];
  if (statusLine === undefined) {
    throw new Error("The ticket file has no Status line.");
  }

  const namePartMatch = /^.*?status[\s*_:]*/i.exec(statusLine);
  const namePart = namePartMatch?.[0] ?? "Status: ";
  const lineEnd = statusLine.endsWith("\r") ? "\r" : "";
  lines[lineIndex] = `${namePart}${status}${lineEnd}`;
  return lines.join("\n");
}

/**
 * Adds a comment at the end of a ticket file, under `## Comments`.
 *
 * @param text The text of a ticket file.
 * @param comment The Markdown text of the comment. Its headings must start at level 4.
 * @param time When the runner wrote the comment, such as `2026-11-11 14:03 UTC`.
 * @returns The text with the comment. The heading `## Comments` is added if it is missing.
 */
export function appendComment(text: string, comment: string, time: string): string {
  const lines = text.split("\n");
  const hasComments = findCommentsLine(lines) !== -1;
  const commentsHeading = hasComments ? "" : `${COMMENTS_HEADING}\n\n`;
  const content = text.trimEnd();
  return `${content}\n\n${commentsHeading}${RUNNER_COMMENT_HEADING}, ${time}\n\n${comment.trim()}\n`;
}

/**
 * Reads the last comment that the runner added to a ticket file.
 *
 * @param text The text of a ticket file.
 * @returns The text after the last runner comment heading, or `null` if the file has none.
 */
export function lastRunnerComment(text: string): string | null {
  const headingIndex = text.lastIndexOf(`\n${RUNNER_COMMENT_HEADING}, `);
  if (headingIndex === -1) {
    return null;
  }
  const headingEnd = text.indexOf("\n", headingIndex + 1);
  return headingEnd === -1 ? "" : text.slice(headingEnd + 1).trim();
}

/**
 * Reads the title of a spec from its first `#` heading.
 *
 * @param text The text of a spec file.
 * @param feature The feature folder name, used when the file has no heading.
 * @returns The heading text, such as `Greetings`.
 */
export function specTitle(text: string, feature: string): string {
  const heading = /^#\s+(.+)$/m.exec(text);
  const headingText = heading?.[1]?.trim() ?? "";
  return headingText === "" ? feature : headingText;
}

/**
 * Creates the Markdown tracker.
 *
 * @param config The factory config.
 * @param folder The folder of the ticket files, relative to the project root.
 * @param projectRoot Absolute path of the project root.
 * @returns The tracker.
 */
export function createMarkdownTracker(
  config: FactoryConfig,
  folder: string,
  projectRoot: string,
): Tracker {
  return new MarkdownTracker(config, folder, projectRoot);
}

/** Reads tickets from Markdown files and records results in those files. */
class MarkdownTracker implements Tracker {
  /** Names the ticket folder for the first line of the runner output. */
  readonly description: string;
  /** The factory config. */
  readonly #config: FactoryConfig;
  /** Absolute path of the ticket folder. */
  readonly #ticketsRoot: string;
  /** Where the file of each ticket of the last queue read lives, by ticket id. */
  readonly #locationsById = new Map<string, TicketLocation>();

  /**
   * Creates the tracker. It reads no file until the runner asks for the queue.
   *
   * @param config The factory config.
   * @param folder The folder of the ticket files, relative to the project root.
   * @param projectRoot Absolute path of the project root.
   */
  constructor(config: FactoryConfig, folder: string, projectRoot: string) {
    this.#config = config;
    this.#ticketsRoot = path.join(projectRoot, folder);
    this.description = `Markdown tickets in ${folder}/`;
  }

  /**
   * Reads every ticket file and builds the queue from them.
   *
   * @returns The ready and the waiting tickets. Empty if the ticket folder does not exist.
   */
  async readQueue(): Promise<QueueView> {
    const features = await listFolders(this.#ticketsRoot);
    const files: TicketFile[] = [];
    const specs = new Map<string, Spec>();

    for (const feature of features) {
      const featureDir = path.join(this.#ticketsRoot, feature);
      const featureFiles = await readTicketFiles(featureDir, feature);
      files.push(...featureFiles);
      for (const file of featureFiles) {
        const id = `${feature}-${file.numberText}`;
        const filePath = path.join(featureDir, TICKETS_FOLDER_NAME, file.fileName);
        this.#locationsById.set(id, { filePath, featureDir, numberText: file.numberText });
      }

      const spec = await this.#readFeatureSpec(feature);
      if (spec !== null) {
        specs.set(feature, spec);
      }
    }
    return buildMarkdownQueue(files, this.#config.labels.queue, specs);
  }

  /**
   * Reads the spec file of the feature of a ticket.
   *
   * @param ticket The ticket.
   * @returns The spec text, or a note that the ticket has no spec.
   */
  async readSpec(ticket: Ticket): Promise<string> {
    if (ticket.spec === null) {
      return "This ticket has no spec. The ticket text is the full request.";
    }
    return readFile(ticket.spec.location, "utf8");
  }

  /**
   * Markdown tickets have no pull requests to look for.
   *
   * @returns Always `null`.
   */
  async findOpenReview(): Promise<string | null> {
    return null;
  }

  /**
   * Delivers an approved ticket, copies its evidence next to the ticket
   * file, sets the ticket status to done, and adds the work report as a comment.
   *
   * A ticket of a spec: the runner merges the ticket branch into the spec
   * branch on `origin`. A ticket on its own: the runner pushes the ticket branch.
   *
   * @param ticket The approved ticket.
   * @param branch The local branch with the commits.
   * @param work The review, the check results, and the evidence.
   * @returns `merged` for a ticket of a spec, else `pushed`.
   */
  async deliver(ticket: Ticket, branch: string, work: ApprovedWork): Promise<Delivery> {
    const location = this.#locationOf(ticket);
    let delivery: Delivery;
    let opening: string;
    if (ticket.spec === null) {
      await git.pushBranch(branch);
      delivery = { status: "pushed", branch, note: "" };
      opening = `The software factory pushed the branch \`${branch}\` to \`origin\`. Open a pull request for it.`;
    } else {
      const message = `Merge ${ticket.reference}: ${ticket.title}`;
      await git.mergeIntoRemoteBranch(branch, ticket.spec.branch, message);
      delivery = { status: "merged", url: null, target: ticket.spec.branch };
      opening = `The software factory merged the branch \`${branch}\` into the spec branch \`${ticket.spec.branch}\` on \`origin\`.`;
    }

    const evidenceText = await copyEvidence(work.evidence, location);
    const report = workReport({ ...work, evidenceText }, 4);
    await this.#updateTicketFile(ticket, DONE_STATUS, `${opening}\n\n${report}`);
    return delivery;
  }

  /**
   * Writes `pull-request.md` for each spec whose tickets are all done.
   *
   * A spec is finished when its feature folder has a spec file and at least
   * one ticket, every ticket is done, `origin` has its spec branch, and the
   * folder has no `pull-request.md` yet.
   *
   * @returns A `pushed` delivery for each finished spec.
   */
  async deliverFinishedSpecs(): Promise<SpecDelivery[]> {
    const features = await listFolders(this.#ticketsRoot);
    const remoteBranches = await git.listRemoteBranches();
    const deliveries: SpecDelivery[] = [];

    for (const feature of features) {
      const spec = await this.#readFeatureSpec(feature);
      if (spec === null || !remoteBranches.includes(spec.branch)) {
        continue;
      }
      const featureDir = path.join(this.#ticketsRoot, feature);
      const pullRequestPath = path.join(featureDir, PULL_REQUEST_FILE_NAME);
      const files = await readTicketFiles(featureDir, feature);
      const allDone = files.every(isDone);
      if (files.length === 0 || !allDone || existsSync(pullRequestPath)) {
        continue;
      }

      const sortedFiles = [...files].sort(byFeatureAndNumber);
      const parts = sortedFiles.map(specPartOf);
      const report = specReport(spec, parts);
      await writeFile(pullRequestPath, `# ${spec.title}\n\n${report}\n`);

      const relativePath = path.relative(process.cwd(), pullRequestPath);
      const note = `Open a pull request from ${spec.branch} to ${this.#config.baseBranch} with the text of ${relativePath}. Attach the files of its evidence folder.`;
      deliveries.push({ spec, status: "pushed", branch: spec.branch, note });
    }
    return deliveries;
  }

  /**
   * Sets the ticket status to the blocked status and adds the reason as a comment.
   *
   * @param ticket The ticket.
   * @param branch The local branch that can hold partial work.
   * @param reason Why the work stopped.
   */
  async handBack(ticket: Ticket, branch: string, reason: string): Promise<void> {
    const { queue, blocked } = this.#config.labels;
    const retryHint = `The ticket status is now \`${blocked}\`. Update the ticket, then set the status back to \`${queue}\` to try again.`;
    const comment = blockedComment(reason, branch, retryHint, 4);
    await this.#updateTicketFile(ticket, blocked, comment);
  }

  /**
   * Sets the status of a ticket file and adds a comment. It reads the file
   * again first, so changes that a person made during the run stay.
   *
   * @param ticket The ticket.
   * @param status The new status.
   * @param comment The Markdown text of the comment.
   * @throws Error if the ticket was not in the last queue read.
   */
  async #updateTicketFile(ticket: Ticket, status: string, comment: string): Promise<void> {
    const { filePath } = this.#locationOf(ticket);
    const text = await readFile(filePath, "utf8");
    const withStatus = setStatus(text, status);
    const updated = appendComment(withStatus, comment, currentTime());
    await writeFile(filePath, updated);
  }

  /**
   * Finds the file of a ticket from the last queue read.
   *
   * @param ticket The ticket.
   * @returns Where the ticket file lives.
   * @throws Error if the ticket was not in the last queue read.
   */
  #locationOf(ticket: Ticket): TicketLocation {
    const location = this.#locationsById.get(ticket.id);
    if (location === undefined) {
      throw new Error(`The runner has no file for ticket ${ticket.reference}.`);
    }
    return location;
  }

  /**
   * Reads the spec of a feature folder.
   *
   * @param feature The feature folder name.
   * @returns The spec, or `null` if the folder has no spec file.
   */
  async #readFeatureSpec(feature: string): Promise<Spec | null> {
    const specPath = path.join(this.#ticketsRoot, feature, SPEC_FILE_NAME);
    if (!existsSync(specPath)) {
      return null;
    }
    const specText = await readFile(specPath, "utf8");
    return {
      id: feature,
      reference: feature,
      title: specTitle(specText, feature),
      location: specPath,
      branch: specBranchName(feature, "", this.#config.branch),
    };
  }
}

/**
 * Copies the evidence files of a ticket to `<feature>/evidence/<number>/`.
 *
 * @param evidence The proof of the ticket.
 * @param location Where the ticket file lives.
 * @returns The Evidence section text, with links relative to the ticket file.
 */
async function copyEvidence(evidence: Evidence, location: TicketLocation): Promise<string> {
  const targetDir = path.join(location.featureDir, EVIDENCE_FOLDER_NAME, location.numberText);
  for (const filePath of evidence.files) {
    const relativePath = path.relative(evidence.folder, filePath);
    const targetPath = path.join(targetDir, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await cp(filePath, targetPath);
  }
  const linkPrefix = `../${EVIDENCE_FOLDER_NAME}/${location.numberText}/`;
  return evidenceMarkdown(evidence, linkPrefix);
}

/**
 * Builds the part of one ticket for the pull request text of its spec.
 *
 * The links of the ticket comment are relative to the `issues/` folder.
 * The pull request text sits one folder higher, so the runner removes the leading `../`.
 *
 * @param file A done ticket file.
 * @returns The title and the last runner comment of the ticket.
 */
function specPartOf(file: TicketFile): SpecPart {
  const comment = lastRunnerComment(file.text) ?? "";
  const report = rewriteLinkTargets(comment, withoutParentStep);
  const title = ticketTitle(file.text, file.fileName);
  return { title: `${file.numberText}: ${title}`, link: null, report };
}

/**
 * Checks whether a ticket file has the done status.
 *
 * @param file A ticket file.
 * @returns `true` if its status is {@link DONE_STATUS}.
 */
function isDone(file: TicketFile): boolean {
  const status = readField(file.text, "Status");
  return status === DONE_STATUS;
}

/**
 * Removes a leading `../` from a link target.
 *
 * @param target A link target, such as `../evidence/01/shot.png`.
 * @returns The target one folder higher, such as `evidence/01/shot.png`.
 */
function withoutParentStep(target: string): string {
  return target.replace(/^\.\.\//, "");
}

/**
 * Converts a ticket file into a ticket and works out what it waits for.
 *
 * @param file A ticket file with the queue status.
 * @param filesByKey Every ticket file, by `<feature>/<number>`.
 * @param spec The spec of the feature, or `null`.
 * @returns The ticket. `waitingOn` holds the blockers that are not done.
 */
function toTicket(
  file: TicketFile,
  filesByKey: ReadonlyMap<string, TicketFile>,
  spec: Spec | null,
): Ticket {
  const ownNumber = Number(file.numberText);
  const blockedBy = readField(file.text, "Blocked by") ?? "";
  const blockers = new Set(blockerNumbers(blockedBy));
  blockers.delete(ownNumber);

  const sortedBlockers = [...blockers].sort((first, second) => first - second);
  const waitingOn: string[] = [];
  for (const blockerNumber of sortedBlockers) {
    const blockerFile = filesByKey.get(`${file.feature}/${blockerNumber}`);
    const blockerStatus = blockerFile === undefined ? null : readField(blockerFile.text, "Status");
    if (blockerStatus !== DONE_STATUS) {
      const paddedNumber = String(blockerNumber).padStart(2, "0");
      const blockerNumberText = blockerFile?.numberText ?? paddedNumber;
      waitingOn.push(`${file.feature}/${blockerNumberText}`);
    }
  }

  const labelsValue = readField(file.text, "Labels") ?? "";
  const labels = labelsValue
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label !== "");

  return {
    id: `${file.feature}-${file.numberText}`,
    reference: `${file.feature}/${file.numberText}`,
    title: ticketTitle(file.text, file.fileName),
    body: file.text,
    labels,
    spec,
    waitingOn,
  };
}

/**
 * Indexes ticket files by feature and number.
 *
 * @param files Every ticket file.
 * @returns The files by `<feature>/<number>`, with the number as a plain integer.
 * @throws Error if two files of one feature have the same number.
 */
function indexByFeatureAndNumber(files: readonly TicketFile[]): Map<string, TicketFile> {
  const filesByKey = new Map<string, TicketFile>();
  for (const file of files) {
    const key = `${file.feature}/${Number(file.numberText)}`;
    const otherFile = filesByKey.get(key);
    if (otherFile !== undefined) {
      throw new Error(
        `Two tickets of the feature "${file.feature}" have the number ${file.numberText}: ${otherFile.fileName} and ${file.fileName}.`,
      );
    }
    filesByKey.set(key, file);
  }
  return filesByKey;
}

/**
 * Sort order for ticket files: by feature name, then by number.
 *
 * @param first A ticket file.
 * @param second Another ticket file.
 * @returns A negative number if `first` sorts before `second`.
 */
function byFeatureAndNumber(first: TicketFile, second: TicketFile): number {
  const featureOrder = first.feature.localeCompare(second.feature);
  if (featureOrder !== 0) {
    return featureOrder;
  }
  return Number(first.numberText) - Number(second.numberText);
}

/**
 * Finds the line of a field before `## Comments`.
 *
 * @param lines The lines of a ticket file.
 * @param fieldName The field name, such as `Status`.
 * @returns The line index, or `-1` if the field is missing.
 */
function findFieldLine(lines: readonly string[], fieldName: string): number {
  const commentsLine = findCommentsLine(lines);
  const searchEnd = commentsLine === -1 ? lines.length : commentsLine;
  const fieldPattern = new RegExp(`^${fieldName}\\s*:`, "i");

  for (let index = 0; index < searchEnd; index++) {
    const line = withoutMarks(lines[index] ?? "");
    if (fieldPattern.test(line)) {
      return index;
    }
  }
  return -1;
}

/**
 * Finds the `## Comments` heading.
 *
 * @param lines The lines of a ticket file.
 * @returns The line index, or `-1` if the file has no comments heading.
 */
function findCommentsLine(lines: readonly string[]): number {
  return lines.findIndex((line) => line.trim().toLowerCase() === COMMENTS_HEADING.toLowerCase());
}

/**
 * Removes bold marks, code marks, list marks, and quote marks from a line.
 *
 * @param line A line of a ticket file.
 * @returns The plain text of the line, trimmed.
 */
function withoutMarks(line: string): string {
  const plain = line.replace(/[*`]/g, "");
  return plain.replace(/^[\s>-]+/, "").trim();
}

/**
 * Lists the subfolders of a folder.
 *
 * @param folder Absolute path of the folder.
 * @returns The subfolder names, sorted. Empty if the folder does not exist.
 */
async function listFolders(folder: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
  const folderNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  return folderNames.sort();
}

/**
 * Reads the ticket files of one feature.
 *
 * @param featureDir Absolute path of the feature folder.
 * @param feature The feature folder name.
 * @returns The ticket files in `issues/`. Empty if the folder has no `issues/`.
 */
async function readTicketFiles(featureDir: string, feature: string): Promise<TicketFile[]> {
  const ticketsDir = path.join(featureDir, TICKETS_FOLDER_NAME);
  let fileNames: string[];
  try {
    fileNames = await readdir(ticketsDir);
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }

  const files: TicketFile[] = [];
  for (const fileName of fileNames) {
    const nameMatch = TICKET_FILE_PATTERN.exec(fileName);
    if (nameMatch === null) {
      continue;
    }
    const text = await readFile(path.join(ticketsDir, fileName), "utf8");
    files.push({ feature, numberText: nameMatch[1] ?? "", fileName, text });
  }
  return files;
}

/**
 * Checks whether an error means that a file or folder does not exist.
 *
 * @param error An error from a file system call.
 * @returns `true` for `ENOENT`.
 */
function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Formats the current time for a comment heading.
 *
 * @returns A time such as `2026-11-11 14:03 UTC`.
 */
function currentTime(): string {
  const isoTime = new Date().toISOString();
  const minutes = isoTime.slice(0, 16);
  return `${minutes.replace("T", " ")} UTC`;
}
