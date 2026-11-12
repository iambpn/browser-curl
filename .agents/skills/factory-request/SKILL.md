---
name: factory-request
description: Turn a request of the user into tickets for the software factory. Understands the request, asks the open questions in one round, and gets the work into tickets (GitHub issues or Markdown files) that sandboxed agents can implement. Use when the user wants the factory to build, fix, or change something, or says "factory request".
---

# Factory request

The software factory implements tickets that have the queue label or status (`labels.queue` in `.sandcastle/factory.config.json`). The `tracker` field of that file says where tickets live:

- `github`: GitHub issues with the queue label.
- `markdown`: Markdown files in the `tracker.folder` folder, for a repository that is not on GitHub. A ticket is ready when its `Status` line has the queue status.
 Agents in a sandbox cannot ask questions. Every decision must be in the ticket before an agent starts. Your job is to get the request of the user into tickets of that quality.

If `.sandcastle/factory.config.json` has an empty `checks` list, the factory is not set up. Tell the user to run the `factory-setup` skill and stop.

## 1. Understand the request

1. Restate the request in one or two sentences: the goal, and the problem behind it.
2. Read the code that the request touches. Read `GLOSSARY.md` and `docs/adr/` if they exist, and use their words.
3. Choose the kind of request. It decides the path:

| Kind | Sign | Path |
|---|---|---|
| Bug | Something worked or should work, and does not | Reproduce it first. Usually one ticket. |
| Small change | One behavior, one place, clear result | One ticket. |
| Feature | New behavior across several parts | Spec, then tickets. |
| Refactor | Same behavior, better structure | Spec, then tickets in safe steps. |
| Unclear | You cannot tell what "done" means | Ask first. Do not write tickets yet. |

For a bug, try to reproduce it now. A bug that you reproduced gives the agent a failing case to start from. If you cannot reproduce it, say so in the ticket and list what you tried.

## 2. Ask the open questions in one round

List every decision that the request leaves open. Answer from the code and the project documents where you can. Ask the user only the rest, all in one message.

- Give each question a recommended answer, so the user can accept it in one word.
- Ask what each option changes for the user. Do not ask about internal details.
- If a question has a fact for an answer, find the fact. Do not ask the user.

Wait for the answers. After this round, do not ask again. If a new decision appears later, choose from the answers and the project context, and report your choice.

## 3. Write the work down

**One ticket (bug or small change), `github` tracker.** Create the issue yourself:

```bash
gh issue create --title "<short title>" --label "<queue label>" --body-file -
```

Add the label `bug`, `refactor`, or `chore` when it fits. The runner uses it for the branch prefix. Use this body:

```markdown
## What to build

The behavior that this ticket makes work, from the point of view of the user.
For a bug: the steps to reproduce it, what happens now, and what must happen.

## Acceptance criteria

- [ ] A result that a test or a command can prove
- [ ] ...

## Blocked by

None (can start immediately)
```

**One ticket (bug or small change), `markdown` tracker.** Create the file yourself at `<tracker.folder>/<feature>/issues/01-<title words>.md`. Choose a short `<feature>` folder name in lowercase words joined by hyphens. If the feature folder already has tickets, use the next free number. Use this content:

```markdown
# 01: <short title>

**Status:** <queue status>

**Labels:** bug

**What to build:** The behavior that this ticket makes work, from the point of view of the user.
For a bug: the steps to reproduce it, what happens now, and what must happen.

**Blocked by:** None (can start immediately)

## Acceptance criteria

- [ ] A result that a test or a command can prove
- [ ] ...
```

Keep the `Labels` line only for `bug`, `refactor`, or `chore`. The runner uses it for the branch prefix. Under `Blocked by`, write only the numbers of tickets in the same feature folder, such as `01, 02`.

**Several tickets (feature or refactor).** The spec and the tickets come from the Matt Pocock skills. Only the user can start those skills. Tell the user to run them in this conversation, in this order:

1. `to-spec`: writes the spec from this conversation. With GitHub it publishes the spec as an issue. With local Markdown it writes `<feature>/spec.md`.
2. `to-tickets`: splits the spec into small tickets, shows the list for approval, and publishes each ticket with the queue label or status and its blockers. With local Markdown it writes one file for each ticket in `<feature>/issues/`.

These skills read the tracker from `docs/agents/issue-tracker.md`. For the `markdown` tracker, it must say "Local markdown" and use the same folder as `tracker.folder`.

If these skills are not installed, give the install command from the `factory-setup` skill.

## 4. Rules for a good ticket

Check each ticket against these rules before it gets the queue label.

- **Complete alone.** An agent that reads only the ticket and its spec can finish it. No decision is left open.
- **Thin and whole.** The ticket cuts through every layer that the behavior needs, and a person can verify the result alone.
- **Provable.** Each acceptance criterion names a result that a test or a command can show.
- **Honest blockers.** `Blocked by` lists only tickets that must merge first. Two tickets that change the same files block each other. Put them in an order.
- **No file paths or code**, unless a snippet states a decision more exactly than words.

## 5. Hand over

Show the user the list of tickets with their numbers, links or file paths, and blockers. Then say:

- The factory starts tickets that have no open blocker. With GitHub, a ticket with a blocker waits until the pull request of the blocker is merged. With Markdown tickets, it waits until the runner pushes the branch of the blocker and sets the blocker to `done`. Merge that branch before the next run, because the waiting ticket starts from the base branch.
- The next step is the `factory-run` skill.

Do not start the factory yourself unless the user asked for it.
