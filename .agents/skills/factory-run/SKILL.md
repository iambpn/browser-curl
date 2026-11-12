---
name: factory-run
description: Run the software factory on the ticket queue and report the result. Shows which tickets are ready, starts the sandboxed agents, and reports pull requests and blocked tickets. Use when the user asks to run or start the factory, to work the queue, or to check what the factory can do next.
---

# Factory run

The factory runner takes each ready ticket through these steps: an agent implements it in a sandbox, the runner runs the project checks, a second agent reviews it, and the runner delivers the work. With the `github` tracker, the runner opens a pull request. With the `markdown` tracker, the runner pushes the branch, sets the ticket file to `Status: done`, and a person opens the pull request. You start the runner and report what it did. You do not implement tickets yourself.

Run every command from the project root.

## 1. Show the queue

```bash
npm --prefix .sandcastle run factory -- --dry-run
```

This command starts no agent. It prints each ticket as `ready` or `waiting`, and what a waiting ticket waits for.

- If the command fails, read the error. A config error means the `factory-setup` skill must run. Do not edit the runner code to make an error go away.
- If no ticket is ready, tell the user why and stop. Waiting tickets start after their blockers finish: a merged pull request on GitHub, or `Status: done` in a Markdown ticket.

## 2. Confirm

A run uses paid model time. Tell the user which tickets will start and in which merge mode. Start without asking only if the user already told you to run the factory.

## 3. Start the runner

```bash
npm --prefix .sandcastle run factory
```

Options, after `--`:

| Option | Effect |
|---|---|
| `--issue <ticket>` | Work only on this ticket, such as `42` for GitHub or `greetings/02` for Markdown. |
| `--merge auto` | Merge each pull request when its GitHub checks pass, for this run only. Only for the `github` tracker. |
| `--merge manual` | Leave each pull request open, for this run only. |

A run can take a long time. Start it in the background if you can, and wait for it to end. Do not start a second run in the same project while one is in progress.

If the runner stops with a missing login, tell the user which variable to put in `.sandcastle/.env`. For Codex, `codex login` with a ChatGPT account on this machine also works. Never ask the user to paste a token into the chat, and never read `.sandcastle/.env`.

## 4. Report the result

The runner prints one outcome for each ticket. Report each one to the user:

| Outcome | Meaning | What to tell the user |
|---|---|---|
| `pull request` | The checks and the review passed. | Give the link. A person must review and merge it. |
| `merged` | The runner merged the pull request (auto mode). | Give the link. |
| `in review` | An earlier run already opened a pull request. | Give the link. The runner did nothing. |
| `pushed` | The checks and the review passed (Markdown tickets). The branch is on `origin`, and the ticket file says `done`. | Give the branch name. A person must open the pull request and merge it. |
| `blocked` | An agent could not finish. | Give the reason. The runner wrote it on the ticket and moved the ticket to the blocked label or status. |

For a blocked ticket, read the comment on the issue, or the `## Comments` section at the end of the ticket file. Also read the newest files in `.sandcastle/logs/`. Tell the user what the agent needs. When the ticket is updated, the queue label or status goes back on and the next run tries again. The earlier commits stay on the local branch, and the next run continues from them.

In manual mode, tickets that waited for a blocker stay waiting in this run. Tell the user: merge the pull requests, then run the factory again. With Markdown tickets, the next run starts the waiting tickets from the base branch, so the user must merge the blocker branches first.

## Rules

- Do not merge a pull request yourself in manual mode.
- Do not change a ticket branch by hand while a run is in progress.
- Report the outcomes as the runner printed them. If a ticket is blocked, say so plainly.
