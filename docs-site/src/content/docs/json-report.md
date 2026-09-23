---
title: JSON report
description: The shape of what wacz-validator-validate prints, and what is promised about it.
---

`wacz-validator-validate` prints one JSON object to stdout. **That is its only output
format** — there is no flag to switch (to read the same report interactively,
use the separate `wacz-validator` binary from `@wacz-validator/tui`). It is the interface for
CI scripts and for anything downstream of wacz-validator, so its shape is deliberate
rather than incidental.

```sh
wacz-validator-validate samples/wikipedia.wacz | jq '.summary'
```

## Top level

```ts file="packages/core/src/validate/domain.ts#report"
```

**"Is this archive usable?" is `summary.failed === 0`.** That answer used to be
cached in a separate field; it only created room to disagree with `summary`, so
it is gone.

```sh
wacz-validator-validate a.wacz | jq '.summary.failed == 0'
```

`issues` are in rule registration order, which means the structural checks come
first and the most likely producer bug tends to be near the top.

### `source` — which archive this was

It takes one of three shapes.

| `kind` | field | example |
| --- | --- | --- |
| `file` | `path` | `/var/archives/a.wacz` (an **absolute** path) |
| `s3` | `uri` | `s3://bucket/key.wacz` |
| `http` | `url` | `https://example.com/a.wacz` |

**The `http` form has its query stripped.** When a signed URL
(`?X-Amz-Signature=…`) was validated, leaving that signature in the report would
let anyone who can read the report read the archive until it expires. A
signature is a credential, not an answer to "which archive is this" — the same
reason `s3` carries no connection settings (`forcePathStyle`) in its `uri`.

## Summary

```ts file="packages/core/src/validate/domain.ts#report-summary"
```

`durationMs` measures the validation run, not process startup.

## Issues

Each issue names the rule that raised it, so a report can be filtered or diffed
by rule without parsing prose:

- `rule` — the stable `<area>/<short-name>` identifier, the same string used in
  the [Rules](/wacz-validator/rules/) table. Never localised, never reformatted between
  versions.
- `severity` — after profile re-grading, so this is what the run actually
  decided rather than the rule's default.
- `messageKey` + `params` — the message is **not** pre-rendered prose. core
  keeps an i18n key and the runtime values; the renderer resolves them against a
  locale catalogue. That is what lets the TUI and a future browser frontend
  present the same report in different languages.
- `location` — where in the archive, when the rule can say.
- `details` — rule-specific extras: a hash diff, a hex dump. Deliberately
  untyped; a renderer formats it per rule.
- `docs` — links to the clause in the source specification, so a reader can go
  from a finding to the text that motivates it.
- `conformance` — how strongly the **specification** demands it: `MUST`,
  `MUST NOT`, `SHOULD`, `SHOULD NOT`, `MAY`. Resolved from the rule name rather
  than written by the rule, so the rule definition stays the single source.

### `severity` and `conformance` answer different questions

`severity` is what wacz-validator does about a violation; `conformance` is what the
specification asks for. **Filtering on one is not a substitute for the other.**

Across the 30 corpus specimens:

| conformance | error | warning | info |
| --- | ---: | ---: | ---: |
| `MUST` | 20 | **10** | 0 |
| `SHOULD` | **1** | 8 | 0 |
| `MAY` / `MUST NOT` | 0 | 4 | 1 |

The two bold cells are why neither column predicts the other.
`datapackage/resources-complete` is a `MUST` reported as a `warning` — an
undeclared file in the ZIP does not stop replay. `datapackage/digest` runs the
other way: the spec only says `SHOULD`, but a hash that does not match may mean
the archive was altered, so wacz-validator calls it an `error`.

Note that **`summary.failed` counts `severity` alone** — it never looks at
conformance. An archive can have `failed: 0` and still violate a `MUST`. If you
need the conformance view, read it off the issues:

```sh
# What wacz-validator judges to be broken
wacz-validator archive.wacz | jq '[.issues[] | select(.severity == "error")]'

# What the specification requires
wacz-validator archive.wacz | jq '[.issues[] | select(.conformance == "MUST" or .conformance == "MUST NOT")]'

# Where the two disagree — usually the most informative list
wacz-validator archive.wacz | jq '[.issues[]
  | select((.conformance == "MUST" and .severity != "error")
        or (.conformance != "MUST" and .severity == "error"))]'
```

There is no CLI flag for this yet; the report carries both axes and the
filtering is left to the caller.

## What is promised

`validatorVersion` mirrors `package.json#version` and exists so a consumer can
detect schema drift rather than guess at it.

Within a major version:

- Existing fields keep their meaning and type.
- `rule` identifiers are stable — they are the thing to key on.
- New optional fields may appear. Consumers should ignore what they do not know
  rather than reject the document.

`stats` is best-effort and optional by design: a WARC broken enough to defeat
statistics must not block the report that says so.

## `profile` — the conditions the report was produced under

`profile` is an object with a name and an optional version. Without a pinned
version the `version` key is absent, which is what "any version" looks like.

```json
"profile": { "name": "browserhive", "version": "2.1.0" }
"profile": { "name": "spec" }
```

It is an object rather than a string so that **`name` alone is enough to match
on**. A single string like `"browserhive@2.1.0"` breaks every equality check the
moment someone pins a version.

```sh
jq -r '.profile.name'                    # "browserhive", pinned or not
jq -r '.profile.version // "unpinned"'   # when only the version matters
```

`version` is **what `--profile` claimed**, not something checked against the
archive — see [Profiles](/wacz-validator/profiles/).

## `skipped` — recording what was not looked at

Append a producer version to `--profile` (`browserhive@1.10.0`) and any rule
that cannot judge that version correctly does not run. **That omission is
written down**, in `skipped`:

```json
"skipped": [
  {
    "rule": "warc/recording-complete",
    "reason": "profile-version",
    "range": ">=1.11.0"
  }
]
```

Like `stats`, the key is absent when there is nothing to report, so a run
without a version produces byte-identical JSON to before.

It is explicit rather than omitted because an empty `issues` has two possible
meanings — "looked, found nothing" and "never looked". A consumer that assumes
the first is being misled.

## Exit codes


The exit code is derived from the report by `exitCodeFor` in
`@wacz-validator/protocol`, shared by the CLI and the TUI so the two cannot disagree.
Deciding from `summary.failed` in your own script is equivalent for the common
case; use the shared helper when the distinction between failure kinds matters.
