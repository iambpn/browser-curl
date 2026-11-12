# Your task

Repair the work on ticket {{TICKET_REFERENCE}}: {{TICKET_TITLE}}

An earlier session implemented this ticket on the branch `{{SOURCE_BRANCH}}`. The factory runner then found the problem below. You work alone in a sandbox. No person can answer questions during this run.

<problem>
{{PROBLEM}}
</problem>

<ticket>
{{TICKET_BODY}}
</ticket>

<spec>
{{SPEC}}
</spec>

# How to work

1. Read `AGENTS.md` and `CLAUDE.md` in the project root if they exist. Their rules apply to you.
2. Run `git log --oneline -15` and read the commits for this ticket.
3. Reproduce the problem before you change code. Find its cause.
4. Repair the cause. Do not hide the symptom.
5. Keep the change small. Do not rewrite work that has no problem.

# Rules of the sandbox

- Commit to `{{SOURCE_BRANCH}}` only. Do not create or switch branches.
- Do not push. Do not run `gh`. Do not open a pull request.
- Do not weaken a check to make it pass. Do not delete or skip a test unless the ticket asks for that.
- If the problem lists uncommitted files, commit the files that belong to the ticket. Remove the others or add them to `.gitignore`.

# Before you finish

The factory runner runs these commands again after you finish. Each one must exit with code 0:

{{CHECK_COMMANDS}}

Run them yourself. Then commit all your work. Mention `{{TICKET_REFERENCE}}` in each commit message. Do not add co-author lines or tool credits.

# How to end the run

If the problem is repaired, every command passes, and everything is committed, print:

<promise>COMPLETE</promise>

If you cannot repair the problem because a decision or a resource is missing, print the reason for a person, and the signal:

<blocked>
Say what is missing and what the person must decide or provide.
</blocked>
<promise>BLOCKED</promise>
