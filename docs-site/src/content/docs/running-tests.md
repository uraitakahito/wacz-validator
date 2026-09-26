---
title: Running the tests
description: What `pnpm check` covers, the corpus tests it deliberately skips, and what CI runs
---

Everything routine is behind one command:

```sh
pnpm check
```

It runs `pnpm audit`, the root scripts' own tests, and then, package by package,
`typecheck → lint → build → test`. Seven packages, in dependency order, so a break
surfaces in the package that caused it rather than three packages downstream.

**Nothing here needs a network, a container, or a WACZ file on disk.** The one
suite that does is skipped unless you ask for it — see below.

## Commands

| Command | Scope |
| --- | --- |
| `pnpm check` | audit + the root scripts' tests + all seven packages. **What CI runs.** |
| `pnpm test` | tests only, all packages, then the root scripts' |
| `pnpm test:scripts` | the root scripts' own tests (`node --test`) |
| `pnpm --filter @wacz-validator/core test` | one package |
| `pnpm --filter @wacz-validator/core test:watch` | one package, watching |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | one stage across all packages |
| `pnpm test:ui` | every package in a browser UI (watch) |
| `pnpm test:report` | a static report into `html/` |

`--filter` takes the package name, not the directory: `@wacz-validator/contract`,
`@wacz-validator/core`, `@wacz-validator/validate-cli`, `@wacz-validator/daemon`, `@wacz-validator/protocol`,
`@wacz-validator/tui`.

`@wacz-validator/protocol` has no tests — it is the wire contract, and its `check` stops
after `build`. That is not an omission: there is nothing there to run.

## Filtering by concern

Tests carry **concern tags**. They let you ask what a test covers, rather than
where its file happens to live.

```bash
pnpm exec vitest --listTags                        # the vocabulary
pnpm exec vitest run --tagsFilter frictionless     # 13 tests
pnpm exec vitest run --tagsFilter 'docs && i18n'   # 2
pnpm exec vitest run --tagsFilter '!corpus'
pnpm test:ui --tagsFilter frictionless             # open the UI already filtered
```

Once the UI is open, typing `tag:frictionless` in its search box does the same.

| Tag | Covers |
| --- | --- |
| `frictionless` | The Data Package base WACZ is built on |
| `wacz` | WACZ structure — required files, reserved directories |
| `cdxj` | The index format and wabac compatibility |
| `warc` | WARC records and digests |
| `engine` | The layer that runs rules and collects issues |
| `corpus` | Corpus-driven — opens real archives |
| `docs` | Documentation agreeing with the code |
| `i18n` | Messages and translations |
| `cli` | The command-line surface |
| `remote` | Reading an archive over S3 |
| `daemon` / `tui` | The respective package |

:::caution[Not for speed]
All 203 tests finish in 3.5s. Filtering here buys **findability, not time**.
Vitest's tags can also carry `timeout` and `retry` for the tests they mark;
this repository does not use that half, because no class of test here wants a
different execution policy.
:::

### Adding a tag

**The order matters.**

1. Declare the name in **`test-tags.ts`** at the repository root
2. Write `// @module-tag <name>` at the top of the test file

The other way round, `strictTags` (on by default) stops the run before a single
test executes.

The vocabulary sits in its own file rather than in `vitest.config.ts` because
there are **two ways to run these tests**: `pnpm test:ui` goes through the root
config, while `pnpm test` (`pnpm -r test`) and `pnpm check` read only the
per-package configs. `test-tags.ts` is imported by the root and all three
package configs, so both paths see the same vocabulary.

To tag one test rather than a whole file, use the test's own options:
`it("…", { tags: ["frictionless"] }, () => {…})`. `rule-docs.test.ts` is the
worked example — the file is `docs`, but one test in it is also `frictionless`.

`packages/core/test/test-tags.test.ts` fails on a file with no tag and on a
declared tag nothing uses. `strictTags` catches only the opposite direction —
using a tag that was never declared.

## Watching it in a UI

```bash
pnpm test:ui
```

It can open already filtered by concern:

```bash
pnpm test:ui --tagsFilter frictionless        # only frictionless
pnpm test:ui --tagsFilter 'docs && i18n'
```

To switch once it is open, type **`tag:frictionless`** in the sidebar's search
box — anything after `tag:` is the same expression `--tagsFilter` takes. For
what tags exist, see the table under [Filtering by concern](#filtering-by-concern)
or run `pnpm exec vitest --listTags`.

Shows `core`, `daemon` and `tui` **in one screen**. The root `vitest.config.ts`
does nothing but point `projects` at the per-package configs, so `include` and
`environment` stay defined in one place each — the UI does not fork the
configuration.

`pnpm test` is unchanged and still goes through `pnpm -r test`. **Both run the
same set**, which was checked by comparing the totals (190 passed / 10 skipped
either way).

`pnpm test:report` writes a static report into `html/`. It **cannot be opened
over `file://`** — serve it, e.g. `npx vite preview --outDir html`.

:::note
`@wacz-validator/protocol` is deliberately absent from `projects`. With no tests, it
would appear in the UI as an **empty project**, which reads as "tests missing"
rather than "nothing to run".
:::

## Why `build` comes before `test`

Each package's `check` is `typecheck && lint && build && test`, and the order is
deliberate. `@wacz-validator/validate-cli`, `@wacz-validator/daemon` and `@wacz-validator/tui`
generate `build-info.ts` as part of their build; running their tests against a stale or
missing one tests the wrong thing. Type errors and lint failures also cost seconds, while a build costs
longer — cheap gates first.

## The corpus tests

`@wacz-validator/core` carries a second kind of test: it validates **real WACZ archives**
from the [wacz-validator-corpus](https://uraitakahito.github.io/wacz-validator-corpus/) repository rather than fixtures built inline.
Those need the archives, so they read `CORPUS_DIR` and **skip when it is unset**:

```
Test Files  20 passed | 2 skipped (22)
      Tests  113 passed | 4 skipped (117)
```

That is what a normal `pnpm check` looks like. The skip is why the routine
command stays hermetic.

To run them, clone the corpus beside this repository **at the pinned version**,
then point at it with an **absolute** path:

```sh
git clone --branch "$(cat .corpus-version)" \
  https://github.com/uraitakahito/wacz-validator-corpus.git ../wacz-validator-corpus
git -C ../wacz-validator-corpus lfs pull

CORPUS_DIR="$(cd ../wacz-validator-corpus && pwd)" pnpm --filter @wacz-validator/core test:corpus
```

`.corpus-version` at the repository root holds a single tag — the corpus release
this checkout is tested against. CI reads the same file, so a green pipeline and
a green local run mean the same thing. **Hand it a different revision and the
suite refuses to run**, naming what it got rather than failing later with
expectations that do not match:

```
CORPUS_DIR は 28bcc70 を指していますが、この wacz-validator は v0.1.0 に固定されています。
```

An unpacked release tarball is not a git checkout, so its version cannot be read
— that case is allowed through rather than blocked.

The `$(cd … && pwd)` is not decoration. `pnpm --filter` runs the script with its
working directory set to `packages/core`, and a relative `CORPUS_DIR` is resolved
there, not in your shell — so `../wacz-validator-corpus` looks for
`packages/wacz-validator-corpus`, finds nothing, and the suite **skips while telling you
it found no manifest**. Resolving to an absolute path in the shell first sidesteps
the question.

| Script | What it does |
| --- | --- |
| `test:corpus` | validate every archive in the corpus, compare against `manifest.json` |
| `corpus:docs:check` | fail if the corpus catalogue has drifted from `manifest.json` |
| `corpus:build` | **regenerate** the archives and the manifest |

### Moving to a newer corpus

Merging something into the corpus changes nothing here — this checkout keeps
testing against the tag in `.corpus-version`. Following it is a deliberate act,
in three steps:

1. land the change in wacz-validator-corpus and **cut a release** there
2. edit `.corpus-version` to the new tag
3. open one wacz-validator PR carrying that edit **and** whatever code has to change
   with it

The last point is why the pin exists: the PR is judged against a corpus that
cannot move underneath it, so it is green or red on its own terms.

`corpus:build` and `corpus:docs` deliberately skip the version check — they are
how the *next* corpus release gets produced, so they have to run against
something other than the pin.

:::danger[`corpus:build` deletes before it writes]
It removes `$CORPUS_DIR/fixtures` **entirely** and rebuilds it. Anything in there
that the corpus repository does not track is gone, with no way back — this has
cost real work at least once.

Check `git status` in the corpus repository before running it, and never point
`CORPUS_DIR` at a directory holding archives you cannot regenerate.
:::

## What CI runs

Five workflows, and only the first is the one you reproduce locally with
`pnpm check`.

| Workflow | Runs |
| --- | --- |
| `check` | `pnpm check` — the whole routine suite |
| `corpus` | clones wacz-validator-corpus **at `.corpus-version`**, then `corpus:docs:check` and `test:corpus` |
| `pack-smoke` | `npm pack` for `@wacz-validator/contract`, `@wacz-validator/core`, `@wacz-validator/validate-cli` and `@wacz-validator/tui`, then installs them into a clean directory and runs the binaries |
| `site` | builds the documentation and verifies its references |
| `docs` | publishes the site |

`pack-smoke` is the one that catches what the others cannot: a package that
builds and tests fine here but ships a broken tarball, because `files` missed
something or a binary lost its executable bit.
