# Agent instructions

## Software factory

This project uses a software factory. GitHub issues with the `ready-for-agent` label are tickets for sandboxed agents.

- Start a request: use the `factory-request` skill.
- Run the factory: use the `factory-run` skill.
- Config: `.sandcastle/factory.config.json`. How to verify a change: `docs/agents/verification.md`.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues of `iambpn/browser-curl`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
