/**
 * Reads what agents report, and writes the text that people read: pull
 * request bodies, and comments on GitHub issues or in ticket files. This
 * module has no side effects.
 */

import { z } from "zod";
import type { Spec, Ticket } from "./tickets.mts";

/** The most characters of check output that the runner shows to a person or an agent. */
const OUTPUT_TAIL_LENGTH = 3000;

/** The verdict that the reviewer agent prints inside `<review>` tags. */
const reviewSchema = z.object({
  /** `approve` lets the ticket become a pull request. `reject` sends it back to the implementer. */
  verdict: z.enum(["approve", "reject"]),
  summary: z.string(),
  findings: z.array(z.string()),
});

/** A validated verdict of the reviewer agent. */
export type Review = z.infer<typeof reviewSchema>;

/** The result of one check command. */
export interface CheckResult {
  readonly name: string;
  readonly command: string;
  readonly passed: boolean;
  /** The end of the combined output of the command. */
  readonly outputTail: string;
}

/**
 * Reads the text inside the last pair of tags with a given name.
 *
 * Sandcastle supports typed agent output only for a run that owns its
 * sandbox. The reviewer runs in the sandbox of the implementer, so the
 * runner reads the tag from the agent output here.
 *
 * @param agentOutput Everything the agent printed.
 * @param tagName The tag name, such as `review`.
 * @returns The trimmed text between the tags, or `null` if the tags are missing.
 */
export function readTag(agentOutput: string, tagName: string): string | null {
  const openTag = `<${tagName}>`;
  const closeTag = `</${tagName}>`;
  const closeIndex = agentOutput.lastIndexOf(closeTag);
  if (closeIndex === -1) {
    return null;
  }
  const openIndex = agentOutput.lastIndexOf(openTag, closeIndex);
  if (openIndex === -1) {
    return null;
  }
  const contentStart = openIndex + openTag.length;
  return agentOutput.slice(contentStart, closeIndex).trim();
}

/**
 * Reads the verdict of the reviewer agent.
 *
 * @param agentOutput Everything the reviewer printed.
 * @returns The verdict, or `null` if the output has no valid `<review>` JSON.
 */
export function parseReview(agentOutput: string): Review | null {
  const json = readTag(agentOutput, "review");
  if (json === null) {
    return null;
  }
  try {
    const result = reviewSchema.safeParse(JSON.parse(json));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Keeps the end of a long text, where test tools print their failures.
 *
 * @param text The full output of a command.
 * @returns The last {@link OUTPUT_TAIL_LENGTH} characters, trimmed.
 */
export function tailOf(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= OUTPUT_TAIL_LENGTH) {
    return trimmed;
  }
  const tail = trimmed.slice(-OUTPUT_TAIL_LENGTH);
  return `[…]\n${tail}`;
}

/**
 * Describes failed checks for the agent that must repair them.
 *
 * @param results The results of the latest check round.
 * @returns One section for each failed check, with the command and its output.
 */
export function describeFailedChecks(results: readonly CheckResult[]): string {
  const failed = results.filter((result) => !result.passed);
  const sections = failed.map(
    (result) =>
      `Check "${result.name}" failed.\nCommand: ${result.command}\n\n${result.outputTail}`,
  );
  return sections.join("\n\n---\n\n");
}

/** What an approved ticket produced, for the text that people read. */
export interface WorkSummary {
  /** The approving verdict of the reviewer. */
  readonly review: Review;
  /** The results of the final check round. */
  readonly checks: readonly CheckResult[];
  /** The Markdown of the Evidence section, from `evidenceMarkdown` in `evidence.mts`. */
  readonly evidenceText: string;
}

/**
 * One finished ticket of a spec, for the final pull request of the spec.
 */
export interface SpecPart {
  /** The ticket title. */
  readonly title: string;
  /** The pull request of the ticket into the spec branch, or `null` if it has none. */
  readonly link: string | null;
  /** A text with Summary and Evidence sections, such as a ticket pull request body. */
  readonly report: string;
}

/**
 * Writes the body of the pull request for a finished ticket.
 *
 * A ticket on its own closes its issue when a person merges the pull
 * request. A ticket of a spec goes into the spec branch, which GitHub does
 * not treat as a merge that closes issues, so the runner closes the issue.
 *
 * @param ticket The ticket of the pull request.
 * @param work The review, the check results, and the evidence.
 * @returns Markdown that names the ticket, followed by the {@link workReport}.
 */
export function pullRequestBody(ticket: Ticket, work: WorkSummary): string {
  const report = workReport(work, 2);
  if (ticket.spec === null) {
    return `Closes ${ticket.reference}\n\n${report}`;
  }
  const opening = `Ticket ${ticket.reference} of the spec ${ticket.spec.reference}. The software factory merges this pull request into the spec branch \`${ticket.spec.branch}\`.`;
  return `${opening}\n\n${report}`;
}

/**
 * Writes the summary, the evidence, the proof, and the review notes of an approved ticket.
 *
 * @param work The review, the check results, and the evidence.
 * @param headingLevel The Markdown heading level of the sections, such as `2` for `##`.
 * @returns Markdown with the sections Summary, Evidence, Checks, and Review notes.
 */
export function workReport(work: WorkSummary, headingLevel: number): string {
  const { review, checks } = work;
  const headingMarks = "#".repeat(headingLevel);
  const checkLines = checks.map(checkLine);
  const proofSections = checks.map(proofSection);
  const findings = review.findings.length === 0 ? "None." : toBulletList(review.findings);

  return [
    `${headingMarks} Summary`,
    "",
    review.summary,
    "",
    `${headingMarks} Evidence`,
    "",
    work.evidenceText,
    "",
    `${headingMarks} Checks`,
    "",
    "The runner ran these commands in the sandbox after the last commit.",
    "",
    checkLines.join("\n"),
    "",
    proofSections.join("\n\n"),
    "",
    `${headingMarks} Review notes`,
    "",
    findings,
  ].join("\n");
}

/**
 * Writes the report of a finished spec: the summary and the evidence of each ticket.
 *
 * The runner reuses the evidence of the tickets, so it uploads no file again.
 *
 * @param spec The finished spec.
 * @param parts The finished tickets of the spec, in the order to show them.
 * @returns Markdown with one `##` section for each ticket.
 */
export function specReport(spec: Spec, parts: readonly SpecPart[]): string {
  const introduction = `The software factory built the spec ${spec.reference} (${spec.title}) on the branch \`${spec.branch}\`. Each ticket below passed the project checks and the review before it went into that branch.`;
  const sections = parts.map(specPartSection);
  return [introduction, ...sections].join("\n\n");
}

/**
 * Reads the text under a Markdown heading.
 *
 * @param text A Markdown text.
 * @param heading The heading text, such as `Summary`. The heading level does not matter.
 * @returns The trimmed text up to the next heading of the same or a higher level, or `null` if the heading is missing.
 */
export function markdownSection(text: string, heading: string): string | null {
  const lines = text.split("\n");
  const wantedHeading = heading.toLowerCase();
  let sectionLevel = 0;
  const sectionLines: string[] = [];

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    const level = headingMatch?.[1]?.length ?? 0;
    if (sectionLevel === 0) {
      const headingText = headingMatch?.[2]?.toLowerCase();
      sectionLevel = headingText === wantedHeading ? level : 0;
      continue;
    }
    if (level > 0 && level <= sectionLevel) {
      break;
    }
    sectionLines.push(line);
  }
  return sectionLevel === 0 ? null : sectionLines.join("\n").trim();
}

/**
 * Formats one finished ticket for the report of its spec.
 *
 * @param part The finished ticket.
 * @returns A `##` section with the link, the summary, and the evidence of the ticket.
 */
function specPartSection(part: SpecPart): string {
  const summary = markdownSection(part.report, "Summary") ?? "No summary.";
  const evidence = markdownSection(part.report, "Evidence") ?? "No evidence.";
  const lines = [`## ${part.title}`, ""];
  if (part.link !== null) {
    lines.push(`Pull request with the checks and the review: ${part.link}`, "");
  }
  lines.push("### Summary", "", summary, "", "### Evidence", "", evidence);
  return lines.join("\n");
}

/**
 * Writes the comment for a ticket that an agent could not finish.
 *
 * @param reason Why the ticket stopped.
 * @param branch The local branch that holds any commits of the agent.
 * @param retryHint What a person changes on the ticket to put it back in the queue.
 * @param headingLevel The Markdown heading level of the sections, such as `2` for `##`.
 * @returns Markdown that tells a person what happened and what to do.
 */
export function blockedComment(
  reason: string,
  branch: string,
  retryHint: string,
  headingLevel: number,
): string {
  const headingMarks = "#".repeat(headingLevel);
  return [
    "The software factory stopped work on this ticket.",
    "",
    `${headingMarks} Reason`,
    "",
    reason,
    "",
    `${headingMarks} Next step`,
    "",
    `Any commits of the agent are on the local branch \`${branch}\`, on the machine that ran the factory.`,
    retryHint,
  ].join("\n");
}

/**
 * Formats one check as a Markdown list line.
 *
 * @param result The result of a check.
 * @returns A line such as `- ✅ test: \`npm test\``.
 */
function checkLine(result: CheckResult): string {
  const mark = result.passed ? "✅" : "❌";
  return `- ${mark} ${result.name}: \`${result.command}\``;
}

/**
 * Formats the output of one check as a collapsed Markdown section.
 *
 * @param result The result of a check.
 * @returns A `<details>` block with the end of the output.
 */
function proofSection(result: CheckResult): string {
  const output = result.outputTail === "" ? "(no output)" : result.outputTail;
  return [
    `<details><summary>Output of ${result.name}</summary>`,
    "",
    "````text",
    output,
    "````",
    "",
    "</details>",
  ].join("\n");
}

/**
 * Formats texts as a Markdown bullet list.
 *
 * @param items The texts.
 * @returns One line for each text, each starting with `- `.
 */
function toBulletList(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}
