import type { TestTagDefinition } from "vitest/config";

/**
 * The vocabulary tests are filtered by, in one place.
 *
 * Shared rather than declared in the root config, because there are two ways
 * to run these tests and only one of them sees the root. `pnpm test:ui` goes
 * through `vitest.config.ts` and its `projects`; `pnpm test` is `pnpm -r test`,
 * which runs each package through its own config and never loads the root at
 * all. `strictTags` is on by default, so a vocabulary the per-package configs
 * cannot see stops those runs before a single test executes — which is the CI
 * path (`pnpm --filter @wacz-validator/core check`).
 *
 * No `timeout` or `retry` on any of these, which is half of what Vitest's tags
 * are for: no class of test here wants a different execution policy.
 * What these buy is being able to ask
 * "which tests cover this concern?" — a question neither file names nor
 * directories answer, because concerns overlap and the file naming does not
 * agree with itself (`frictionless-schema.test.ts` sits beside
 * `datapackage-frictionless-structure.test.ts`).
 *
 * Deliberately not one tag per rule. Not every rule has a test file named
 * after it: some share one with their neighbours
 * (`browserhive-settle.test.ts`), and the rest are covered inside broader
 * files (`validate.test.ts`) and the corpus suite, so a rule-level vocabulary
 * would carry names with no file of their own behind them. (Counts used to be
 * written here and rotted — 22 rules became 31 while the sentence stood
 * still — so this comment now states the shape, not the numbers.)
 */
export const TEST_TAGS: TestTagDefinition[] = [
  { name: "frictionless", description: "The Data Package base WACZ is built on" },
  { name: "wacz", description: "WACZ structure — required files, reserved directories" },
  { name: "cdxj", description: "The index format and wabac compatibility" },
  { name: "warc", description: "WARC records and digests" },
  { name: "engine", description: "The layer that runs rules and collects issues" },
  { name: "corpus", description: "Corpus-driven — opens real archives" },
  { name: "docs", description: "Documentation agreeing with the code" },
  { name: "i18n", description: "Messages and translations" },
  { name: "cli", description: "The command-line surface" },
  { name: "remote", description: "Reading an archive over S3" },
  { name: "daemon", description: "@wacz-validator/daemon" },
  { name: "tui", description: "@wacz-validator/tui" },
];
