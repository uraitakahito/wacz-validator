---
title: Terminology
description: The WACZ vocabulary this project uses, and where it comes from.
---

wacz-validator uses the vocabulary defined by
[WACZ 1.1.1 §Terminology](https://specs.webrecorder.net/wacz/1.1.1/#terminology)
without paraphrasing it. This page collects the terms that appear throughout
these docs, so that a word means one thing here and the same thing in the spec.

| Term | What it means here |
| ---- | ------------------ |
| `ZIP file` | The container. The format is `ZIP`; the archive as a whole is a WACZ, not "a zip". |
| `WACZ` | *Web Archive Collection Zipped* — WARC data plus its metadata packaged as a `ZIP file`. |
| `WARC` | The record format inside `archive/`. |
| `Web Archive` | The captured material as a whole — not the `archive/` directory, which is one part of it. |
| `Page` | An entry in `pages/pages.jsonl`. Not any web page in general. |
| `Media Type` | The value classifying content. Distinct from the HTTP header name `Content-Type`. |
| `Collection` | The grouping a WACZ represents. |
| `Package` | The Frictionless Data Package that `datapackage.json` describes. Unrelated to an npm package. |
| `Context` | As used by the spec. |

## Terms the spec uses but does not define

Everything above is defined in WACZ §Terminology. The spec also leans on words it
never defines there, and this is the one that carries real weight.

| Term | What it means here |
| ---- | ------------------ |
| `CDXJ` | The index format inside `indexes/`. One line per captured response: a sort-friendly key ([SURT](#surt)), a 14-digit capture timestamp, and a JSON object carrying `filename`, `offset` and `length` — the byte range of the matching record in `archive/`. §5.2.2 requires index files to contain CDXJ data and cites [pywb's CDXJ format](https://pywb.readthedocs.io/en/latest/manual/indexing.html#cdxj-index) rather than defining it. |

<a id="surt"></a>
**SURT** (Sort-friendly URI Reordering Transform) is the key form: the host is
reversed and comma-separated, so `https://upload.wikimedia.org/…/icon.png`
becomes `org,wikimedia,upload)/…/icon.png`. Reversing the host puts everything
under one domain next to each other in sort order, which is what makes a binary
search over the index possible.

The index is why a replay tool does not have to download a whole WACZ: it reads
the index, then fetches only the byte ranges it needs. If the index is wrong the
archive is intact but unplayable, which is why the
[rules](/wacz-validator/rules/) whose names start with `cdxj/` check it.

## A WARC 1.1 term the `warc/*` rules lean on

| Term | What it means here |
| ---- | ------------------ |
| `payload` | The part of a WARC record's block that the record is about ([WARC 1.1 §Terms and definitions](https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#terms-and-definitions)). Which part depends on the record type: the entity body of an HTTP `response` or `request`, the whole block of a `resource` or `conversion`, and for a `revisit` the payload of the content it revisits. `warcinfo` and `metadata` records have **no** payload, so they do not carry `WARC-Payload-Digest` ([§WARC-Payload-Digest](https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#warc-payload-digest)); the digest of their block goes in `WARC-Block-Digest`. |

## Scope

The vocabulary applies to **prose** — this site and source comments. Code
identifiers (variables, functions, types, rule names) follow the codebase's own
conventions and are out of scope.

Where a word is being used in its ordinary sense rather than as a spec concept,
it is just that word: a "spec page" is a page on a website, and an "npm package"
is not a Data Package.

## For Japanese readers

The Japanese version of this page carries an additional rule that has no
counterpart here: spec terms stay **in English inside Japanese prose**, rather
than being translated. The point is to remove the choice — and therefore the
inconsistency — between a translated term and the original.

A Japanese translation of the specification itself is published separately at
[uraitakahito.github.io/specs](https://uraitakahito.github.io/specs/wacz/1.1.1/#terminology).
