# Your task

Review the change for ticket {{TICKET_REFERENCE}}: {{TICKET_TITLE}}

Another agent wrote the change on the branch `{{SOURCE_BRANCH}}`. The project checks already pass. You decide if the change can become a pull request. You did not write this code, so do not trust its commit messages. Check the code itself.

Do not edit, commit, or push anything. You only read and run commands.

<ticket>
{{TICKET_BODY}}
</ticket>

<spec>
{{SPEC}}
</spec>

# What to read

1. Run `git log {{BASE_REF}}..HEAD --oneline` to list the commits.
2. Run `git diff {{BASE_REF}}...HEAD` to read the full change.
3. Read `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, and `CODING_STANDARDS.md` in the project root if they exist. These are the standards of the project.
4. Open the changed files when the diff does not show enough context.

# Review on two axes

**Ticket.** Does the change do what the ticket asks?

- Check each acceptance criterion of the ticket. Find the code and the test that meet it.
- Look for behavior that the ticket did not ask for.
- Look for cases that the tests miss: empty input, errors, limits.
- Where you can, prove behavior yourself. Run the relevant test or the command from `docs/agents/verification.md`.

**Standards.** Does the change follow the project?

- Compare the change with the standards that you read. A written project standard wins over your own taste.
- Look for unclear names, duplicated logic, code that nothing uses, and abstractions that the ticket does not need.
- Look for a weakened check: a deleted test, a skipped test, a loosened assertion, or a disabled lint rule.
- Look for secrets, unsafe handling of input, and changes to files that the ticket does not need.

# Your verdict

Reject the change if an acceptance criterion is not met, if a check was weakened, or if you found a defect. Do not reject for taste alone. Put small remarks in `findings` and approve.

Print your verdict as JSON inside `<review>` tags. Print the tags one time, at the end.

- `verdict`: `"approve"` or `"reject"`.
- `summary`: for an approval, describe the change for the person who will merge it: what changed and why, in two to five sentences. For a rejection, say what is wrong.
- `findings`: a list of strings. For a rejection, each string is one problem that the implementer must repair, with the file and the reason. For an approval, each string is one remark for the person who merges. Use an empty list if you have none.

<review>
{"verdict": "approve", "summary": "…", "findings": []}
</review>
