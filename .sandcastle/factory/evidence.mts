/**
 * The proof that a ticket works, as screenshots, recordings, and command
 * output. The implementer saves the proof in a folder of its checkout that Git
 * ignores. It describes the proof in a Markdown file next to it. The trackers
 * show that Markdown in the pull request or the ticket file.
 */

import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import type * as sandcastle from "@ai-hero/sandcastle";

/** The folder in each ticket checkout where the implementer saves proof. Git ignores it. */
export const EVIDENCE_FOLDER = ".factory-evidence";

/** The Markdown file in the evidence folder that describes the proof. */
export const EVIDENCE_FILE = "evidence.md";

/** The largest image or GIF that GitHub accepts as an attachment. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** The largest video that GitHub accepts as an attachment, on a paid plan. A free plan accepts 10 MB. */
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

/**
 * The size limit of each file type that GitHub accepts as an attachment.
 *
 * - Images (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`): 10 MB.
 * - Videos (`.mp4`, `.mov`, `.webm`): 100 MB. GitHub plays them in the pull request.
 *
 * The runner leaves out every other file type and every larger file.
 */
const MAX_BYTES_BY_EXTENSION: Readonly<Record<string, number>> = {
  ".png": MAX_IMAGE_BYTES,
  ".jpg": MAX_IMAGE_BYTES,
  ".jpeg": MAX_IMAGE_BYTES,
  ".gif": MAX_IMAGE_BYTES,
  ".webp": MAX_IMAGE_BYTES,
  ".svg": MAX_IMAGE_BYTES,
  ".mp4": MAX_VIDEO_BYTES,
  ".mov": MAX_VIDEO_BYTES,
  ".webm": MAX_VIDEO_BYTES,
};

/** A Markdown image link, such as `![The login page](login.png)`. */
const IMAGE_LINK_PATTERN = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

/** The proof of one ticket, read from its checkout on the host. */
export interface Evidence {
  /** Absolute path of the evidence folder on the host. */
  readonly folder: string;
  /** The Markdown that the implementer wrote. Links are relative to {@link folder}. Empty if the file is missing. */
  readonly markdown: string;
  /** Absolute paths of the linked files that GitHub accepts. */
  readonly files: readonly string[];
  /** One line for each linked file that the runner left out, with the reason. */
  readonly skipped: readonly string[];
}

/**
 * Creates the evidence folder in the checkout of a sandbox. A `.gitignore`
 * file in the folder makes Git ignore every file in it, so the proof never
 * lands in a commit.
 *
 * @param sandbox The sandbox of a ticket.
 * @throws Error if the sandbox cannot create the folder.
 */
export async function prepareEvidenceFolder(sandbox: sandcastle.Sandbox): Promise<void> {
  const command = `mkdir -p ${EVIDENCE_FOLDER} && printf '*\\n' > ${EVIDENCE_FOLDER}/.gitignore`;
  const result = await sandbox.exec(command);
  if (result.exitCode !== 0) {
    throw new Error(`The runner cannot create the evidence folder:\n${result.stderr}`);
  }
}

/**
 * Reads the proof that the implementer saved in a ticket checkout.
 *
 * @param worktreePath Absolute path of the ticket checkout on the host.
 * @returns The Markdown, the files it links to, and the files the runner left out.
 */
export async function collectEvidence(worktreePath: string): Promise<Evidence> {
  const folder = path.join(worktreePath, EVIDENCE_FOLDER);
  let markdown: string;
  try {
    markdown = await readFile(path.join(folder, EVIDENCE_FILE), "utf8");
  } catch {
    return { folder, markdown: "", files: [], skipped: [] };
  }

  const files: string[] = [];
  const skipped: string[] = [];
  for (const target of localLinkTargets(markdown)) {
    const problem = await checkEvidenceFile(folder, target);
    if (problem === null) {
      files.push(path.join(folder, target));
    } else {
      skipped.push(`\`${target}\`: ${problem}`);
    }
  }
  return { folder, markdown: markdown.trim(), files, skipped };
}

/**
 * Lists the local files that the image links of a Markdown text point to.
 *
 * @param markdown The text of `evidence.md`.
 * @returns Each link target that is not a web address, once, in order.
 */
export function localLinkTargets(markdown: string): string[] {
  const targets: string[] = [];
  for (const link of markdown.matchAll(IMAGE_LINK_PATTERN)) {
    const target = link[2] ?? "";
    if (isLocalTarget(target) && !targets.includes(target)) {
      targets.push(target);
    }
  }
  return targets;
}

/**
 * Changes the targets of the local image links of a Markdown text.
 *
 * @param markdown A Markdown text.
 * @param newTarget Returns the new target for a local link target, such as `login.png`.
 * @returns The text with new link targets. Links to web addresses stay the same.
 */
export function rewriteLinkTargets(
  markdown: string,
  newTarget: (target: string) => string,
): string {
  /** Replaces the target of one local image link. */
  function rewriteLink(link: string, altText: string, target: string): string {
    if (!isLocalTarget(target)) {
      return link;
    }
    const rewrittenTarget = newTarget(target);
    return `![${altText}](${rewrittenTarget})`;
  }

  return markdown.replace(IMAGE_LINK_PATTERN, rewriteLink);
}

/**
 * Checks whether a link target is a file path and not a web address.
 *
 * @param target A link target, such as `login.png` or `https://example.com/a.png`.
 * @returns `true` for a path with no scheme such as `https:`.
 */
function isLocalTarget(target: string): boolean {
  return !/^[a-z]+:/i.test(target);
}

/**
 * Writes the Evidence section text for a pull request or a ticket comment.
 *
 * @param evidence The proof of a ticket.
 * @param linkPrefix The path from the place of the text to the evidence files, such as `../evidence/01/`. Empty if the text sits next to them.
 * @returns The Markdown of the implementer with new link targets, and a note for each file that the runner left out.
 */
export function evidenceMarkdown(evidence: Evidence, linkPrefix: string): string {
  if (evidence.markdown === "") {
    return "The implementer saved no evidence.";
  }
  const skippedFiles = new Set(evidence.skipped.map(skippedTarget));

  /** Points a link to the evidence file, or leaves a link to a skipped file as it is. */
  function newTarget(target: string): string {
    const plainTarget = target.replace(/^\.\//, "");
    return skippedFiles.has(target) ? target : `${linkPrefix}${plainTarget}`;
  }

  const text = rewriteLinkTargets(evidence.markdown, newTarget);
  if (evidence.skipped.length === 0) {
    return text;
  }
  const notes = evidence.skipped.map((line) => `- ${line}`).join("\n");
  return `${text}\n\nThe runner left out these files:\n\n${notes}`;
}

/**
 * Reads the link target from a line of {@link Evidence.skipped}.
 *
 * @param line A line such as `` `big.mp4`: larger than 100 MB ``.
 * @returns The target, such as `big.mp4`.
 */
function skippedTarget(line: string): string {
  const targetMatch = /^`([^`]+)`/.exec(line);
  return targetMatch?.[1] ?? "";
}

/**
 * Checks that a linked file exists in the evidence folder and that GitHub accepts it.
 *
 * @param folder Absolute path of the evidence folder.
 * @param target The link target, relative to the folder.
 * @returns Why the runner leaves the file out, or `null` if the file is good.
 */
async function checkEvidenceFile(folder: string, target: string): Promise<string | null> {
  const filePath = path.resolve(folder, target);
  const relativePath = path.relative(folder, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return "the file is outside the evidence folder";
  }

  const extension = path.extname(filePath).toLowerCase();
  const maxBytes = MAX_BYTES_BY_EXTENSION[extension];
  if (maxBytes === undefined) {
    return "GitHub accepts only PNG, JPEG, GIF, WebP, SVG, MP4, MOV, and WebM files";
  }

  let size: number;
  try {
    const fileStats = await stat(filePath);
    size = fileStats.size;
  } catch {
    return "the file does not exist";
  }
  if (size > maxBytes) {
    const limitInMegabytes = maxBytes / (1024 * 1024);
    return `the file is larger than ${limitInMegabytes} MB`;
  }
  return null;
}
