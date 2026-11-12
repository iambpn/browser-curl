---
name: factory-setup
description: Set up the software factory for this project. Detects the Git host, the stack, and the check commands, asks the open questions in one round, and writes .sandcastle/factory.config.json. Use once per project after the factory template is installed, or when the user asks to set up, configure, or repair the software factory.
---

# Factory setup

The software factory turns tickets into pull requests. Tickets are GitHub issues, or Markdown files for a repository that is not on GitHub. Agents implement each ticket in a sandbox. The factory runner (`.sandcastle/factory.mts`) reads every project fact from `.sandcastle/factory.config.json`. Your job is to write that file so it is true for this project.

Find facts in the project before you ask the user. Ask only what the project cannot tell you.

## 1. Look at the project

Collect these facts. Do not ask the user for a fact that you can read.

- **Kind of project.** Does the folder hold code? An empty folder, or a folder with only a README, is a new project. Go to "New project" below first.
- **Git host and tracker.** Run `git remote -v`. The factory needs a remote named `origin`. If it is missing, stop and tell the user.
  - If `origin` points to GitHub, run `gh repo view --json nameWithOwner,defaultBranchRef`. If it works, use the `github` tracker. If it fails, stop and tell the user what is missing (`gh` or its login).
  - If `origin` points to another host, such as Bitbucket or GitLab, use the `markdown` tracker with the folder `.scratch`. Tickets are Markdown files. The runner pushes the branch of each finished ticket, and a person opens the pull request. Read the default branch with `git remote show origin`.
- **Stack.** Languages, package manager, and monorepo layout. Read manifests and lockfiles: `package.json`, `pnpm-workspace.yaml`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`, `pom.xml`, `composer.json`.
- **Check commands.** Tests, type check, lint, and build. Read the scripts in the manifest, the `Makefile`, the CI workflow files, and the README.
- **Install command.** The command that installs dependencies in a fresh checkout, such as `npm ci`.
- **Services.** Does a check need a database, a queue, or another service? Read `docker-compose.yml`, the CI workflow files, and the test setup.
- **System tools.** Does a check need a tool that an operating system package installs?
- **Project rules.** `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `CODING_STANDARDS.md`, and `docs/agents/`.
- **Earlier setup.** Is `.sandcastle/factory.config.json` already filled in? Then keep its values and change only what is wrong.

Never read or print a `.env` file of the project. Read `.env.example` to learn variable names.

## 2. Prove the checks

Run each check command once on a clean checkout of the base branch. Keep only commands that exit with code 0. The runner uses these commands as the gate for every ticket, so a command that fails today blocks every ticket.

- If a command fails, tell the user. Do not put it in the config.
- If the project has no working check, the factory cannot judge the work of an agent. Propose the smallest real check, such as one test that starts the app, and add it only if the user agrees.
- Checks run in the sandbox, in a fresh checkout. A check that needs a file outside the repository does not work there.

## 3. Ask the open questions in one round

Ask every open question in one message. Give each question a recommended answer. Leave out a question when the project already answers it.

- **Sandbox.** Recommend `native` (Bubblewrap on Linux, Seatbelt on macOS): no image, and it uses the tools of this machine. Recommend `docker` when a check needs a service, a system package, or root. Say this limit of `native`: the network stays open, so an agent can reach services on `localhost`.
- **Agents.** Which agent implements and which agent reviews: `claude` or `codex`, and which model. Recommend a different model for the review than for the implementation. For a Codex role, read the model name from the `model` line of `~/.codex/config.toml`. Both agents can use a subscription in place of an API key: Claude through `claude setup-token`, and Codex through the ChatGPT login of `codex login`.
- **Merge mode.** Only for the `github` tracker. Recommend `manual`: the factory opens pull requests and a person merges. `auto` merges a pull request when its GitHub checks pass. The `markdown` tracker always uses `manual`.
- **Branch names.** Show the default: `feat/<ticket id>-<title words>`, with the prefix `bugfix`, `refactor`, or `chore` for tickets with that label. The ticket id is the issue number for GitHub, and `<feature>-<number>` for Markdown tickets, such as `feat/greetings-02-add-farewell`. Ask only if the project uses another convention.
- **Parallel tickets.** Recommend 3.

## 4. Write the files

1. **`.sandcastle/factory.config.json`.** Fill in every field. The field list is at the end of this skill.
2. **`.sandcastle/Dockerfile`**, only for the `docker` sandbox. Add the runtimes and tools that the checks need. Then build the image: `npx --prefix .sandcastle sandcastle docker build-image --image-name <sandbox.imageName>`.
3. **`.sandcastle/.env`.** If the file is missing, copy `.sandcastle/.env.example` to it. Tell the user which login each configured agent needs. The user fills in the values. Never ask the user to paste a token into the chat, and never read `.sandcastle/.env`. A Codex role needs no value if the user ran `codex login` with a ChatGPT account on this machine.
4. **Labels.** For the `github` tracker only: create the queue label and the blocked label if GitHub lacks them: `gh label create <name>`. The `markdown` tracker uses these names as values of the `Status` line.
5. **`docs/agents/verification.md`.** Write how to start the app, how to exercise it the way a user does, and what proof an agent can capture (test output, HTTP responses, screenshots, logs). Agents read this file before each ticket. Keep it short and exact.
6. **Agent instructions.** Add the section below to `CLAUDE.md` if it exists, else to `AGENTS.md`. If neither file exists, ask the user which one to create. Update the section in place if it already exists.

```markdown
## Software factory

This project uses a software factory. <For GitHub: GitHub issues with the `<queue label>` label> <For Markdown: Markdown files in `.scratch/<feature>/issues/` with `Status: <queue label>`> are tickets for sandboxed agents.

- Start a request: use the `factory-request` skill.
- Run the factory: use the `factory-run` skill.
- Config: `.sandcastle/factory.config.json`. How to verify a change: `docs/agents/verification.md`.
```

## 5. Check the setup

1. Run `npm --prefix .sandcastle install` if `.sandcastle/node_modules` is missing.
2. Run `npm --prefix .sandcastle run factory -- --dry-run`. It must print the queue with no error. This run starts no agent.
3. For the `native` sandbox on Linux, run `bwrap --ro-bind / / true`. If it fails, show the user the error. Ubuntu 24.04 and later need an AppArmor profile for Bubblewrap. The first real run prints the exact command.

## 6. Hand over

Tell the user:

- What you detected and what you wrote.
- Which logins the user must put in `.sandcastle/.env`.
- That agents see only files that are on the base branch of `origin`. The user must commit and push `docs/agents/verification.md` and the agent instructions. Do not commit or push unless the user asks.
- If the Matt Pocock skills are not installed (no `to-spec` and `to-tickets` skills are available), give the install command for the agent in use. Claude Code: `claude plugin install mattpocock-skills@claude-plugins-official`. Codex: `codex plugin marketplace add mattpocock/skills`, then `codex plugin add mattpocock-skills@mattpocock`.
- If `docs/agents/issue-tracker.md` is missing, the user must run the `setup-matt-pocock-skills` skill with the default labels. For the `github` tracker, the user chooses GitHub. For the `markdown` tracker, the user chooses "Local markdown". An agent cannot start that skill for the user.
- The next step: the `factory-request` skill.

## New project

Use this path when the folder holds no code.

1. In the question round, also ask what the user wants to build and which stack to use. Recommend a stack and say why.
2. Create the smallest working project: one entry point, one real test, and the check commands. Run the checks.
3. Run `git init` if the folder is not a repository.
4. The factory needs a remote repository named `origin`. Ask the user where the repository must live. For GitHub, ask before you create one, and ask if it must be private: `gh repo create <name> --private --source . --remote origin`. For another host, the user creates the repository and gives you its URL for `git remote add origin <url>`. Push the first commit only after the user agrees.
5. Continue with step 1 of this skill.

## Config fields

| Field | Meaning |
|---|---|
| `tracker.type` | `github` (GitHub issues) or `markdown` (Markdown files, for a repository that is not on GitHub). |
| `tracker.folder` | The folder of the Markdown tickets, such as `.scratch`. Required for `markdown`. |
| `baseBranch` | The branch that pull requests target. Use the default branch of the `origin` repository. |
| `labels.queue` | Tickets with this label (GitHub) or status (Markdown) are ready for an agent. Default: `ready-for-agent`. |
| `labels.blocked` | The runner moves a ticket to this label or status when an agent cannot finish it. Default: `ready-for-human`. |
| `branch.defaultPrefix` | Branch prefix for a ticket with no matching label. |
| `branch.prefixByLabel` | Maps an issue label to a branch prefix. |
| `sandbox.type` | `native` or `docker`. |
| `sandbox.imageName` | The Docker image name. Required for `docker`. |
| `setup.installCommand` | Runs in each new sandbox before the agent starts. `null` for none. |
| `setup.copyToWorktree` | Paths to copy from the project root into each agent checkout, such as `node_modules`. This makes the install command fast. |
| `checks` | The commands that gate every ticket. Each has a `name` and a `command`. At least one. |
| `agents.implementer`, `agents.reviewer` | `provider` (`claude` or `codex`), `model`, and optional `effort` (`low`, `medium`, `high`, `xhigh`, `max`). |
| `limits.maxParallel` | How many tickets run at the same time. |
| `limits.implementIterations` | How many fresh sessions the implementer can use for one ticket. |
| `limits.fixRounds` | How many times the implementer can repair failed checks or review findings. |
| `merge.mode` | `manual` or `auto`. `auto` needs the `github` tracker. |
| `merge.method` | `squash`, `merge`, or `rebase`. Used only by `auto`. |
