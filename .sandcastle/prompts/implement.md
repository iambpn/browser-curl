# Your task

Implement ticket {{TICKET_REFERENCE}}: {{TICKET_TITLE}}

You work alone in a sandbox on the branch `{{SOURCE_BRANCH}}`. No person can answer questions during this run.

<ticket>
{{TICKET_BODY}}
</ticket>

The ticket belongs to this spec. Use the spec for context. Implement only the ticket.

<spec>
{{SPEC}}
</spec>

# Before you write code

1. Read `AGENTS.md` and `CLAUDE.md` in the project root if they exist. Their rules apply to you.
2. Read the files in `docs/agents/` if the folder exists. `docs/agents/verification.md` explains how to run this project and how to prove that a change works.
3. Read `GLOSSARY.md` if it exists. Use its words in names and messages.
4. Run `git log --oneline -15` to see earlier work on this branch. If the branch already has commits for this ticket, continue from them.
5. Read the code and the tests around the change before you edit.

# How to work

- Reproduce a bug before you fix it. Write a test that fails because of the bug.
- For new behavior, work test first: write one failing test, make it pass, then repeat. Refactor when the tests pass.
- Test behavior through public interfaces. Do not test private details.
- Make the smallest change that meets every acceptance criterion of the ticket.
- Follow the style and the structure of the code around your change.
- Do not change files that the ticket does not need.

# Rules of the sandbox

- Commit to `{{SOURCE_BRANCH}}` only. Do not create or switch branches.
- Do not push. Do not run `gh`. Do not open a pull request. The factory runner does this for you.
- Do not read or write files outside this repository.
- Do not weaken a check to make it pass. Do not delete or skip a test unless the ticket asks for that.

# Evidence

The person who merges your work wants to see that it works without running it. Save the proof in the folder `.factory-evidence/`, and describe it in `{{EVIDENCE_FILE}}`. Git ignores that folder, so the proof never goes into a commit.

- For a change that a user can see, such as a page, a form, or a message: start the app as `docs/agents/verification.md` explains. Take a screenshot for each acceptance criterion. Record a short video of each flow with several steps. Use Playwright or the browser tool that the project uses.
- For a change with no screen, such as an API or a command: show the request and the response, or the command and its output, in a code block.
- Save screenshots as PNG files and videos as MP4 or WebM files. Keep each file under 10 MB.
- In `{{EVIDENCE_FILE}}`, write one short paragraph for each proof: what it shows, and which acceptance criterion it proves. Link each file with an image link relative to the folder, such as `![The login form shows the error](login-error.png)`. Put each video link alone in its own paragraph, such as `![](checkout-flow.webm)`, so that GitHub shows a player. Do not use headings.
- Show only real results. Never edit a screenshot or invent output.

If the app cannot run in the sandbox, say so in `{{EVIDENCE_FILE}}`, and show the test output that proves the change.

# Before you finish

The factory runner runs these commands after you finish. Each one must exit with code 0:

{{CHECK_COMMANDS}}

Run them yourself and repair every failure. Then commit all your work. The runner rejects uncommitted files.

Write commit messages that say what changed and why. Mention `{{TICKET_REFERENCE}}` in each message. Do not add co-author lines or tool credits.

# How to end the run

If the ticket is done, every command above passes, and everything is committed, print:

<promise>COMPLETE</promise>

If you cannot finish because a decision or a resource is missing, do not guess. Commit any useful work, then print the reason for a person, and the signal:

<blocked>
Say what is missing and what the person must decide or provide.
</blocked>
<promise>BLOCKED</promise>

If you run out of room before the ticket is done, commit your progress and stop without a signal. A fresh session continues from your commits.
