# Agentia Gov Guard

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/node-%3E%3D18-blue.svg)](package.json)
[![Agentia 0.122](https://img.shields.io/badge/agentia-0.122.0--alpha.1-blue.svg)](https://developer.copado.com/docs)

**Gov Guard** is a pre-promotion policy gate for the Agentia CLI. Every
promotion runs through five checks, production targets demand a one time
human approval code, and every run emits JSON audit evidence.

No browser tab required. Built for the **Agentia Headless Virtual Hackathon**
as an oclif plugin on top of the public `agentia` CLI.

---

## Table of Contents

- [The Problem](#the-problem)
- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Live Demo Workflow](#live-demo-workflow)
- [Command Reference](#command-reference)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [How It Works](#how-it-works)
- [Security](#security)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Hackathon Fit](#hackathon-fit)
- [License](#license)

---

## The Problem

Salesforce teams promote without a consistent safety check. The Agentia docs
confirm the gaps: no data specific rollback, retry, resume, validation only
or deployment status commands, destructive operations always needing
confirmation, and large Profiles breaking commits. Without a shared gate, an
unsafe promotion is discovered only after it fails.

## Features

- **Five policy checks** — CICD credentials, CRT readiness with missing
  fields named, AI credentials, story context, and the environment gate.
- **PROD approval ceremony** — production targets generate a one time code
  (`AP-XXXXXX`) with 24 hour expiry. `gov approve` marks it approved, and a
  recheck with `--approve-code` consumes it. Single use, never reusable.
- **No code spam** — re-running a check while a code is still valid reprints
  the same code instead of minting new ones.
- **Self heal hint** — `--self-heal` prints the exact Operate agent
  diagnosis command for the failure instead of guessing. It prints, never
  executes, so there are no surprise costs.
- **Shift-left hook** — `gov install-hook` writes a git commit-msg hook
  that requires a story ID in every message plus a passing gate.
- **Dual output** — human checklist by default, `--json` audit document for
  agents and pipelines.
- **Zero private imports** — only shells out to public `agentia` commands.

## Installation

### Prerequisites

- Node 18 or newer.
- Agentia CLI beta: `npm install -g @copado/agentia-cli@beta`
- Authenticated machine: `agentia setup` (CICD at minimum).

### Install from source

```sh
git clone https://github.com/devkdas/agentia-gov-guard.git
cd agentia-gov-guard
npm install
npm run build
agentia plugins link .
```

Re-run `npm run build` after every change to the TypeScript files.

## Quick Start

### 1. Check a UAT promotion

```sh
agentia gov check --story US-0000024 --env UAT-SFP
```

### 2. Read the JSON audit output

```sh
agentia gov check --story US-0000024 --env UAT-SFP --json
```

### 3. Gate a production promotion

```sh
agentia gov check --story US-0000024 --env PROD
# Generates AP-XXXXXX, then:
agentia gov approve AP-XXXXXX --story US-0000024 --env PROD
agentia gov check --story US-0000024 --env PROD --approve-code AP-XXXXXX
```

### 4. Diagnose a failure

```sh
agentia gov check --env UAT-SFP --self-heal
```

## Live Demo Workflow

Verified live against a real Source Format pipeline:

```text
1. agentia gov check --story US-0000024 --env UAT-SFP --json
   -> status warn, auth-cicd pass, story pass, env gate pass
2. agentia gov check --story US-0000024 --env PROD --json
   -> status blocked, approvalRequired true, code AP-ZEJN5F issued
3. agentia gov approve AP-ZEJN5F --story US-0000024 --env PROD
   -> Approved, with the exact recheck command printed
4. agentia gov check --story US-0000024 --env PROD --approve-code AP-ZEJN5F
   -> env gate pass, code consumed and unusable again
```

## Command Reference

### `agentia gov check`

| Flag | Description |
|---|---|
| `-s, --story <id>` | User story ID under promotion |
| `-e, --env <name>` | Target environment (default `UAT-SFP`) |
| `--approve-code <code>` | One time approval code for PROD targets |
| `--self-heal` | Print the Operate diagnosis command on failure |
| `-j, --json` | Machine readable JSON audit document |

Exit code `0` on pass or warn, `1` on blocked.

### `agentia gov approve`

| Arg / Flag | Description |
|---|---|
| `CODE` | One time code from a prior check (required) |
| `-s, --story <id>` | Scope check: code must match this story |
| `-e, --env <name>` | Scope check: code must match this env |
| `-j, --json` | Machine readable output |

Approving twice is idempotent and reprints the recheck command. Wrong
story, wrong env, expired or unknown codes are rejected without consuming
anything.

### `agentia gov install-hook`

| Flag | Description |
|---|---|
| `-e, --env <name>` | Environment the gate checks (default `UAT-SFP`) |
| `--force` | Back up and replace an existing hook |
| `--uninstall` | Remove a hook this command installed |
| `-j, --json` | Machine readable output |

Installs a git `commit-msg` hook, since the `pre-commit` stage cannot see
the message. Every commit then needs a story ID like US-0000024 plus a
passing gov check. Refuses to overwrite foreign hooks without `--force`
and refuses to remove them at all.

### `agentia gov pr-check`

| Flag | Description |
|---|---|
| `-s, --story <id>` | Story ID, defaults to US-ID parsed from branch name |
| `-b, --base <ref>` | Base ref for the branch diff (default `origin/main`) |
| `-e, --env <name>` | Environment for the policy gate (default `UAT-SFP`) |
| `--credential-id/--org-id/--pipeline-id` | Scope IDs enabling blast radius lookups |
| `-j, --json` | Machine readable JSON verdict |

Quality gates a branch before promotion: story ID presence, profile
noise through trim, risky grants through FLS scan, blast radius when
scope IDs are given, and the policy gate itself. Companion checks
degrade to skipped with guidance when their plugins are absent. Exits
nonzero on any failing area with exact fixes.

### `agentia gov risk-score`

| Flag | Description |
|---|---|
| `-s, --story <id>` | User story name or ID (required) |
| `-e, --env <name>` | Target environment assessed (default `UAT-SFP`) |
| `--ai/--no-ai` | Release agent risk narrative (default on) |
| `-j, --json` | Machine readable JSON output |

Predicts deployment risk from live signals: story maturity, pipeline
blocks, target env weight, data commits and promotion history, each
graded low, medium or high with reasons, plus an overall advisory
estimate. Advisory only, never blocks. Pair with gov check for
enforcement.

## Configuration

Pending approvals live in `~/.agentia-gov-guard/pending.json` (created on
demand with restricted directory). Codes expire after 24 hours and expired
records are purged on every run. No flags or environment variables are
needed beyond the command line.

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| `BLOCK auth-cicd` | CICD credentials not stored | Run `agentia setup` |
| `WARN auth-crt` with missing fields | CRT trial keys incomplete | Complete the CRT step of setup until `ready:true` |
| Unknown approval code | Already consumed or mistyped | Run a fresh check to issue a new code |
| Code expired | Older than 24 hours | Run a fresh check |
| Code rejected for story or env | Issued for a different scope | Re-run approve scoping or issue a new code |
| `EEXIT: 1` after JSON | oclif exit code for blocked status | Parse stdout JSON, the trailer goes to stderr |
| ESM auto-transpile warning | Linked ESM plugin notice | Benign, compiled output is used; vanishes on packed install |

## How It Works

```text
agentia gov check
  -> agentia auth get --json (CICD set, CRT ready/missing/issues, AI set)
  -> scope checks for story plus environment
  -> PROD: issue, approve, consume single use code
  -> human checklist or JSON audit document
```

## Security

- No credentials read beyond what `auth get` already reports, and tokens
  are never printed.
- Production always needs an explicit human approval code. No force flags.
- Codes are random, scoped to story plus environment, expire in 24 hours,
  and are consumed on first use.

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript on Node 18+ |
| CLI Framework | oclif v4 (ESM, matching the host CLI) |
| Runtime calls | `node:child_process` to public `agentia` commands |
| Storage | Local JSON file for pending approvals only |

## Architecture

```text
Developer / Agent
       |
agentia gov check / approve
       |
Gov Guard (this plugin)
  |- auth reader  -> agentia auth get --json
  |- gate engine  -> pass / warn / block per check
  |- approval store (single use codes, 24h TTL)
  |- self heal hint -> agentia ai agent ask --agent operate
       |
JSON audit document / human checklist
```

## Hackathon Fit

Strengthens quality, security and governance through validation, policy
checks, safeguards and auditability. Extends an existing capability,
improves reliability, and combines policy plus approval plus AI diagnosis
in one gate.

## License

MIT License — see [LICENSE](LICENSE) for details.
