---
title: Profiles
description: What --profile changes, and what it never changes.
---

`--profile <name>` picks how strictly producer-specific and stylistic findings
are graded. The default is `spec`.

A profile does two things. It **re-grades severities**, and it **decides which
rules run**: a rule can name profiles it does not run under. The rules for
BrowserHive's own conventions (`browserhive/*`, and `warc/recording-complete`,
which reads the metadata records BrowserHive adds) run only under `browserhive`,
and the two Data Package rules (`datapackage/frictionless-structure`, a `MUST`,
and `datapackage/frictionless-schema`, a `SHOULD`) do not run under `lenient`.
Every other rule runs under every profile, so any other `MUST` violation is
still reported, even where `lenient` prints it as `info`.

## The three profiles

### `spec` (default)

What the specifications ask, plus wabac.js loader compatibility. The
specifications are [WACZ 1.1.1](https://specs.webrecorder.net/wacz/1.1.1/), the
[Data Package](https://uraitakahito.github.io/datapackage/) specification that
`datapackage.json` follows,
[WARC 1.1](https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/)
for the records inside the WARC files, and
[wacz-auth 0.1.0](https://specs.webrecorder.net/wacz-auth/0.1.0/) for the
signature. An archive that exits 0 here is
expected to replay correctly in [ReplayWeb.page](https://replayweb.page/), bugs
in wabac.js itself aside.

This is the profile to use when the question is "is this archive correct?"

### `browserhive`

`spec` plus the stricter producer conventions of
BrowserHive — for example that
`indexes/index.cdxj` is stored plain, so a `.cdxj.gz` is rejected even when
paired with a `.idx`.

Use it when the archive is known to come from BrowserHive and you want its house
rules enforced too. On a WACZ that is not a BrowserHive WACZ it will report
conventions that archive never agreed to follow.

#### Pinning the producer version

A BrowserHive WACZ changes between BrowserHive versions. Append `@<x.y.z>` and only the
rules known to be correct for that version run.

```sh
wacz-validator-validate --profile browserhive@2.1.0 archive.wacz
```

Without a version, every rule runs, including the version-conditional ones —
that is the previous behaviour, kept as the default.

A rule held back by the version you name is reported in `skipped`. It is **not
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

#### The version the archive names

Some `browserhive/*` rules check what a later version of the BrowserHive WACZ
Profile introduced. Whether that applies is decided by the archive itself — by
the WACZ Profile version its `browserhive:capture.conformsTo` names — and not by
`--profile`, so it holds with or without `@<x.y.z>`. An archive that names an
earlier version, or none, gets nothing from such a rule: the rule runs, finds
nothing to apply, and counts as passed.

Such a rule is **not** listed in `skipped`, and the report does not say that it
left the archive alone: `skipped` records only what the version in `--profile`
held back. The version a rule applies from is written in its source, under
`packages/core/src/validate/rules/`. Where a later version changed a
requirement rather than adding one, a rule can also check an archive against
the version it names.

### `lenient`

Demotes every producer-specific and stylistic finding to `info`, leaving only
the hard errors that break replay. The two Data Package rules do not run at all
under it.

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
`warning`. BrowserHive declares a BrowserHive WARC file to be a WARC 1.1 file, so
`browserhive` makes the same finding an `error`.

## Exit codes

The profile affects the exit code only through severity: what counts as a
failure is unchanged, but a rule demoted to `info` no longer contributes one.
The mapping from report to exit code lives in `@wacz-validator/protocol`
(`exitCodeFor`), shared by the CLI and the TUI so both agree.
