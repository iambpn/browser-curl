/**
 * The Markdown tracker, for a repository that is not on GitHub. Tickets are
 * files in the local Markdown format of the Matt Pocock skills:
 *
 *   <folder>/<feature>/spec.md            the spec of the feature (optional)
 *   <folder>/<feature>/issues/NN-<slug>.md one ticket
 *
 * A ticket file has a `Status:` line and a `Blocked by:` line near the top,
 * and comments under a `## Comments` heading at the end. The runner pushes
 * the branch of each finished ticket and marks the ticket done. A person
 * opens the pull request on the Git host.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FactoryConfig } from "./config.mts";
import * as git from "./git.mts";
import { blockedComment, workReport } from "./report.mts";
import type { QueueView, Ticket } from "./tickets.mts";
import { splitByBlockers } from "./tickets.mts";
import type { ApprovedWork, Delivery, Tracker } from "./tracker.mts";

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
 * @param specPaths The spec file path of each feature that has one.
 * @returns The ready and the waiting tickets, sorted by feature and number.
 * @throws Error if two files of one feature have the same number.
 */
export function buildMarkdownQueue(
  files: readonly TicketFile[],
  queueStatus: string,
  specPaths: ReadonlyMap<string, string>,
): QueueView {
  const filesByKey = indexByFeatureAndNumber(files);
  const filesInOrder = [...files].sort(byFeatureAndNumber);

  const tickets: Ticket[] = [];
  for (const file of filesInOrder) {
    const status = readField(file.text, "Status");
    if (status === queueStatus) {
      const specPath = specPaths.get(file.feature) ?? null;
      tickets.push(toTicket(file, filesByKey, specPath));
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
  return `${content}\n\n${commentsHeading}### Software factory, ${time}\n\n${comment.trim()}\n`;
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
  /** The absolute file path of each ticket of the last queue read, by ticket id. */
  readonly #pathsById = new Map<string, string>();

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
    const specPaths = new Map<string, string>();

    for (const feature of features) {
      const featureDir = path.join(this.#ticketsRoot, feature);
      const featureFiles = await readTicketFiles(featureDir, feature);
      files.push(...featureFiles);
      for (const file of featureFiles) {
        const id = `${feature}-${file.numberText}`;
        const filePath = path.join(featureDir, TICKETS_FOLDER_NAME, file.fileName);
        this.#pathsById.set(id, filePath);
      }

      const specPath = path.join(featureDir, SPEC_FILE_NAME);
      if (existsSync(specPath)) {
        specPaths.set(feature, specPath);
      }
    }
    return buildMarkdownQueue(files, this.#config.labels.queue, specPaths);
  }

  /**
   * Reads the spec file of the feature of a ticket.
   *
   * @param ticket The ticket.
   * @returns The spec text, or a note that the ticket has no spec.
   */
  async readSpec(ticket: Ticket): Promise<string> {
    if (ticket.specLocation === null) {
      return "This ticket has no spec. The ticket text is the full request.";
    }
    return readFile(ticket.specLocation, "utf8");
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
   * Pushes the ticket branch, sets the ticket status to done, and adds the work report as a comment.
   *
   * @param ticket The approved ticket.
   * @param branch The local branch with the commits.
   * @param work The review and the check results.
   * @returns A `pushed` delivery.
   */
  async deliver(ticket: Ticket, branch: string, work: ApprovedWork): Promise<Delivery> {
    await git.pushBranch(branch);
    const report = workReport(work.review, work.checks, 4);
    const comment = `The software factory pushed the branch \`${branch}\` to \`origin\`. Open a pull request for it.\n\n${report}`;
    await this.#updateTicketFile(ticket, DONE_STATUS, comment);
    return { status: "pushed", branch };
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
    const filePath = this.#pathsById.get(ticket.id);
    if (filePath === undefined) {
      throw new Error(`The runner has no file for ticket ${ticket.reference}.`);
    }
    const text = await readFile(filePath, "utf8");
    const withStatus = setStatus(text, status);
    const updated = appendComment(withStatus, comment, currentTime());
    await writeFile(filePath, updated);
  }
}

/**
 * Converts a ticket file into a ticket and works out what it waits for.
 *
 * @param file A ticket file with the queue status.
 * @param filesByKey Every ticket file, by `<feature>/<number>`.
 * @param specPath The spec file of the feature, or `null`.
 * @returns The ticket. `waitingOn` holds the blockers that are not done.
 */
function toTicket(
  file: TicketFile,
  filesByKey: ReadonlyMap<string, TicketFile>,
  specPath: string | null,
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
    specLocation: specPath,
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
