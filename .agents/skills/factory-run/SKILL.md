---
name: factory-run
description: Run the software factory on the ticket queue and report the result. Shows which tickets are ready, starts the sandboxed agents, and reports pull requests and blocked tickets. Use when the user asks to run or start the factory, to work the queue, or to check what the factory can do next.
---

# Factory run

The factory runner takes each ready ticket through these steps: an agent implements it in a sandbox and saves evidence (screenshots, videos, or command output), the runner runs the project checks, a second agent reviews the change and the evidence, and the runner delivers the work.

- **A ticket of a spec** goes into the spec branch at once, in every merge mode. With the `github` tracker, the runner opens a pull request into the spec branch, merges it, and closes the ticket. With the `markdown` tracker, the runner merges the branch into the spec branch on `origin` and sets the ticket file to `Status: done`. When every ticket of the spec is closed, the runner opens one final pull request from the spec branch to the base branch, with the evidence of every ticket. With the `markdown` tracker, it writes the text of that pull request into `pull-request.md` in the feature folder, and a person opens the pull request.
- **A ticket on its own**: with the `github` tracker, the runner opens a pull request to the base branch. With the `markdown` tracker, the runner pushes the branch, sets the ticket file to `Status: done`, and a person opens the pull request.

`merge.mode` decides only the merges into the base branch: of a ticket on its own, and of the final pull request of a spec. You start the runner and report what it did. You do not implement tickets yourself.

Run every command from the project root.

## 1. Show the queue

```bash
npm --prefix .sandcastle run factory -- --dry-run
```

This command starts no agent. It prints each ticket as `ready` or `waiting`, and what a waiting ticket waits for.

- If the command fails, read the error. A config error means the `factory-setup` skill must run. Do not edit the runner code to make an error go away.
- If no ticket is ready, tell the user why and stop. Waiting tickets start after their blockers finish: a blocker of the same spec finishes when it is in the spec branch. A ticket on its own finishes with a merged pull request on GitHub, or `Status: done` in a Markdown ticket. A run with no ready ticket still opens the final pull request of a spec whose tickets are all closed.

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
| `--merge auto` | Merge each pull request to the base branch when its GitHub checks pass, for this run only. Only for the `github` tracker. |
| `--merge manual` | Leave each pull request to the base branch open, for this run only. Tickets of a spec still go into the spec branch. |

A run can take a long time. Start it in the background if you can, and wait for it to end. Do not start a second run in the same project while one is in progress.

If the runner stops with a missing login, tell the user which variable to put in `.sandcastle/.env`. For Codex, `codex login` with a ChatGPT account on this machine also works. Never ask the user to paste a token into the chat, and never read `.sandcastle/.env`.

## 4. Report the result

The runner prints one outcome for each ticket and for each finished spec. A spec line starts with `spec`, such as `spec #1 Greetings`. Report each one to the user:

| Outcome | Meaning | What to tell the user |
|---|---|---|
| `pull request` | The checks and the review passed. For a spec: every ticket is closed, and the final pull request is open. A `Not merged` line says why a merge did not happen. | Give the link. A person must review and merge it. |
| `merged` | The `Into` line names where the work went: the spec branch for a ticket of a spec, or the base branch in auto mode. | Give the target, and the link if there is one. |
| `in review` | An earlier run already opened a pull request. | Give the link. The runner did nothing. |
| `pushed` | The checks and the review passed (Markdown tickets). The branch is on `origin`. For a spec: the next line says which `pull-request.md` to use. | Give the branch name and the next step. A person must open the pull request and merge it. |
| `blocked` | An agent could not finish. | Give the reason. The runner wrote it on the ticket and moved the ticket to the blocked label or status. |

For a blocked ticket, read the comment on the issue, or the `## Comments` section at the end of the ticket file. Also read the newest files in `.sandcastle/logs/`. Tell the user what the agent needs. When the ticket is updated, the queue label or status goes back on and the next run tries again. The earlier commits stay on the local branch, and the next run continues from them.

In manual mode, a ticket on its own that waits for another ticket on its own stays waiting in this run. Tell the user: merge the pull requests, then run the factory again. With Markdown tickets, the next run starts such a ticket from the base branch, so the user must merge the blocker branch first. Tickets of a spec do not wait for a person: they start in the same run.

## Rules

- Do not merge a pull request yourself in manual mode.
- Do not change a ticket branch by hand while a run is in progress.
- Report the outcomes as the runner printed them. If a ticket is blocked, say so plainly.
