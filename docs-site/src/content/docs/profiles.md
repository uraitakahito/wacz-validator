---
title: Profiles
description: What --profile changes, and what it never changes.
---

`--profile <name>` picks how strictly producer-specific and stylistic findings
are graded. The default is `spec`.

A profile **re-grades severities. It never suppresses a check the spec
requires** — a `MUST` violation is still reported under every profile, even if
`lenient` prints it as `info`.

## The three profiles

### `spec` (default)

WACZ spec plus wabac.js loader compatibility. An archive that exits 0 here is
expected to replay correctly in [ReplayWeb.page](https://replayweb.page/), bugs
in wabac.js itself aside.

This is the profile to use when the question is "is this archive correct?"

### `browserhive`

`spec` plus the stricter producer conventions of
BrowserHive — for example that
`indexes/index.cdxj` is stored plain, so a `.cdxj.gz` is rejected even when
paired with a `.idx`.

Use it when the archive is known to come from BrowserHive and you want its house
rules enforced too. On any other producer's output it will report conventions
that archive never agreed to follow.

#### Pinning the producer version

BrowserHive's output changes between versions. Append `@<x.y.z>` and only the
rules known to be correct for that version run.

```sh
wacz-validator-validate --profile browserhive@2.1.0 archive.wacz
```

Without a version, every rule runs, including the version-conditional ones —
that is the previous behaviour, kept as the default.

A rule held back by a version mismatch is reported in `skipped`. It is **not
dropped silently**: a reader who cannot tell "nothing wrong" from "not looked
at" is being misled.

```json
"skipped": [
  {
    "rule": "warc/recording-complete",
    "reason": "profile-version",
    "range": ">=1.11.0"
  }
]
```

:::caution[The version is not checked against the archive]
`--profile browserhive@1.0.0` is taken at face value; nothing verifies that the
archive was really produced by 1.0.0. `datapackage.json` carries a `software`
field naming the producer and its version, but wacz-validator does not read it yet.
**The version is the operator's claim.**
:::

### `lenient`

Demotes every producer-specific and stylistic finding to `info`, leaving only
the hard errors that break replay.

Use it to triage legacy archives, where the question is not "is this correct?"
but "is this salvageable?"

## Which rules a profile actually changes

In the [Rules](/wacz-validator/rules/) table, the severity column shows, under
each rule's default, exactly which profiles re-grade it and to what. A rule with
nothing under its default behaves identically under all three profiles.

Those lines are generated from each rule's `applicability` declaration, so they
are the authoritative answer — not a summary of one.

## How the WARC 1.1 rules are graded

The `warc/*` rules that check what WARC 1.1 asks of a record run under every
profile. A profile changes only how a finding is graded, and the grade follows
the kind of finding:

| Finding | `spec` | `browserhive` | `lenient` |
| --- | --- | --- | --- |
| The record's shape is broken (no version line, LF instead of CRLF, a `Content-Length` that does not match the block, no closing CRLF CRLF) | `error` | `error` | `error` |
| The version line is not `WARC/1.1` | `warning` | `error` | `info` |
| A field WARC 1.1 requires is missing, a field it forbids is present, or a value has the wrong form (*shall*, *shall not*) | `warning` | `error` | `info` |
| A recommendation is not followed (*should*, and the community recommendations in the annotated text) | `info` | `warning` | `info` |
| Something the standard leaves open: an unknown record type, an unknown truncation reason, an unknown `revisit` profile | `info` | `info` | `info` |

A broken shape is an `error` everywhere because a reader loses the boundaries
between records, and with them the index and replay. A field that breaks a
*shall* rarely stops wabac.js from replaying, so `spec` reports it as a
`warning`. BrowserHive declares its WARC files to be WARC 1.1 files, so
`browserhive` makes the same finding an `error`.

## Exit codes

The profile affects the exit code only through severity: what counts as a
failure is unchanged, but a rule demoted to `info` no longer contributes one.
The mapping from report to exit code lives in `@wacz-validator/protocol`
(`exitCodeFor`), shared by the CLI and the TUI so both agree.
