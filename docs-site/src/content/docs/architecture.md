---
title: Architecture
description: Why wacz-validator is seven packages and a stateless daemon.
---

## The seven packages

| Package | bin | Role |
| ------- | --- | ---- |
| `@wacz-validator/contract` | — | The vocabulary every surface agrees on: rule profiles, locales, and the CLI exit-code contract. Depends on nothing, so a browser client can use it without pulling in the engine. |
| `@wacz-validator/core` | — | The validation engine. Reads a WACZ, runs the rules, produces a machine-readable report. A library: it carries no bin and no `commander`. |
| `@wacz-validator/validate-cli` | `wacz-validator-validate` | The non-interactive command over core. Parses the arguments, writes the JSON report, sets the exit code. Usable directly from CI without the rest. |
| `@wacz-validator/daemon` | `wacz-validator-daemon` | A stateless HTTP/WS daemon that owns core and answers with a resolved report (message, spec URL and conformance inlined). It also serves an archive's contents in windows — a range of lines, one line split into fields, the WARC records, one record. |
| `@wacz-validator/tui` | `wacz-validator` | The interactive terminal UI — a thin client of the daemon. |
| `@wacz-validator/protocol` | — | The wire types and CLI contract the clients and the daemon share: `validate`, `readLines`, `readLine`, `readRecords`, `readRecord`, `ping`. Runtime-independent of core, so it is browser-safe. |
| `@wacz-validator/devtools` | `wacz-validator-break` | Development only, never published (`private`). Breaks a WACZ on purpose so you can watch a rule turn red — a validator's green means nothing until you have seen it go red. |

`wacz-validator` starts `wacz-validator-daemon` as a child process by default. Point it at a
long-running one with `--server ws://127.0.0.1:7333`, using the port that daemon
printed when it started — see [Quickstart](/wacz-validator/quickstart/).

## Why a daemon at all

A validator could be a single binary. The split exists so that **more than one
frontend can present the same report**:

```mermaid
flowchart LR
    tui["@wacz-validator/tui"] ==>|"WS / JSON-RPC"| daemon["@wacz-validator/daemon"]
    browser["dashboard (a browser client)"] -->|"REST"| daemon
    cli["@wacz-validator/validate-cli"] -->|validates with| core["@wacz-validator/core"]
    daemon -->|validates with| core
    tui -->|import| protocol["@wacz-validator/protocol"]
    daemon -->|import| protocol
    protocol -.->|"import type only"| core
    core -->|import| shared["@wacz-validator/contract"]
    protocol -->|import| shared
    cli -->|import| shared

    classDef shared fill:#fff3cd,stroke:#d4a72c,color:#5c4500;
    class shared,protocol shared;
```

The daemon holding no state is what makes that cheap: a second frontend is a new
client, not a new copy of the engine. The second frontend exists — the crawler's
[dashboard](https://github.com/uraitakahito/dashboard) talks to the same handlers over
plain HTTP (`POST /validate`, `/lines`, `/line`, `/records`, `/record`, `/record/body`)
and never imports core. Where the TUI walks an archive's contents over the
WebSocket, the dashboard walks them over REST; both draw the tree from the same
report and the same fields the daemon split.

## Why core carries no prose

`@wacz-validator/core` never produces a human-readable sentence. An issue carries a
message **key** and its runtime parameters; the renderer resolves them against a
locale catalogue.

That is what keeps a single report presentable in more than one language, and it
is why `@wacz-validator/protocol` can depend on core's types without pulling in core
itself — the wire format is data, not text.

## Rules are data too

Each rule declares its `name`, `severity`, `conformance` and any per-profile
overrides, and the engine reads that declaration rather than special-casing
rules. The [Rules](/wacz-validator/rules/) table on this site is generated from the same
declarations, which is why it cannot drift from what actually runs.

A rule becomes active only when it is both defined in
`packages/core/src/validate/rules/` **and** listed in that directory's
`index.ts`. The docs build checks the two counts agree.

## Development

```sh
pnpm install --frozen-lockfile   # workspace deps + symlinks
pnpm check                       # audit + each workspace's checks
pnpm build
```

The documentation site under `docs-site/` is deliberately **outside** the pnpm
workspace and installs with npm. Adding it to `pnpm-workspace.yaml` would mean
adding Astro's build scripts to the `allowBuilds` allowlist, putting the main
install at risk for no benefit.
