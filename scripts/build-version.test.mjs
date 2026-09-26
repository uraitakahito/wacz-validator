/**
 * build が名乗る版の試験。`node --test` で走る (root の `test:scripts`)。
 *
 * 3 段で見る:
 *   1. `versionOf` —— `git describe` の出力から版を組む規則 (git を触らない)
 *   2. `readBuild` —— **本物の git** で。捨ての repo にタグと commit を積む
 *   3. `gen-build-info.mjs` —— 書き出した build-info.ts が、package.json の
 *      `0.0.0` ではなくタグの版を名乗ること。2026-09-26 まで daemon の `/healthz` と
 *      報告の `validatorVersion` は、どの build でも `"0.0.0"` だった
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { readBuild, versionOf } from "./build-version.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// 手元の git の設定 (署名・既定の branch 名など) を持ち込まない。readBuild が
// 呼ぶ git もこの process の env を継ぐので、同じく素の設定で走る。
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

describe("versionOf —— describe の出力から版を組む", () => {
  test("タグの上で、未コミットの変更が無ければ、タグの版そのもの", () => {
    assert.equal(versionOf("v0.30.0-0-g81c2368", false), "0.30.0");
  });

  test("タグの上でも、未コミットの変更があれば +dirty を付ける", () => {
    assert.equal(versionOf("v0.30.0-0-g81c2368", true), "0.30.0+dirty");
  });

  test("タグより先の build は、隔たりと commit を build metadata に書く", () => {
    // `-` で書くと SemVer の prerelease になり、0.30.0 **より前** を意味してしまう。
    assert.equal(versionOf("v0.30.0-3-gabcdef1", false), "0.30.0+3.gabcdef1");
    assert.equal(versionOf("v0.30.0-3-gabcdef1", true), "0.30.0+3.gabcdef1.dirty");
  });

  test("prerelease のタグも、右から割るので崩れない", () => {
    assert.equal(versionOf("v1.0.0-rc.1-2-gabcdef1", false), "1.0.0-rc.1+2.gabcdef1");
  });

  test("タグが 1 本も見えない (浅い clone・git の無い所) なら unknown と認める", () => {
    assert.equal(versionOf(undefined, false), "unknown");
    assert.equal(versionOf(undefined, true), "unknown");
  });
});

/** 捨ての repo で git を打つ。 */
const gitIn = (root) => (args) =>
  execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();

/** 空の commit を 1 つ積み、その短い SHA を返す。 */
const commit = (git, message) => {
  git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", message]);
  return git(["rev-parse", "--short", "HEAD"]);
};
const tag = (git, name) =>
  git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "tag", "-a", name, "-m", name]);

describe("readBuild —— 本物の git で", () => {
  let root;
  let git;
  before(() => {
    root = mkdtempSync(join(tmpdir(), "wacz-validator-build-version-"));
    git = gitIn(root);
    git(["init", "-q"]);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  // 1 つの repo に順に積むので、試験は上から順に走る (node:test の既定)。
  test("タグが無ければ版は unknown。commit は名乗る", () => {
    const sha = commit(git, "first");
    assert.deepEqual(readBuild(root), { version: "unknown", gitSha: sha });
  });

  test("タグの上なら、タグの版", () => {
    const sha = commit(git, "release");
    tag(git, "v1.2.0");
    assert.deepEqual(readBuild(root), { version: "1.2.0", gitSha: sha });
  });

  test("タグの後に 2 commit 積むと、+2.g<SHA>", () => {
    commit(git, "a");
    const sha = commit(git, "b");
    assert.deepEqual(readBuild(root), { version: `1.2.0+2.g${sha}`, gitSha: sha });
  });

  test("v で始まらないタグは版として読まない", () => {
    const sha = commit(git, "c");
    tag(git, "corpus-7");
    assert.deepEqual(readBuild(root), { version: `1.2.0+3.g${sha}`, gitSha: sha });
  });

  test("未追跡のファイルも未コミットの変更に数える —— tsc は拾って build に入れる", () => {
    const sha = git(["rev-parse", "--short", "HEAD"]);
    writeFileSync(join(root, "new-rule.ts"), "export {};\n");
    try {
      assert.deepEqual(readBuild(root), {
        version: `1.2.0+3.g${sha}.dirty`,
        gitSha: `${sha}-dirty`,
      });
    } finally {
      rmSync(join(root, "new-rule.ts"));
    }
  });
});

describe("gen-build-info.mjs —— package.json の 0.0.0 を名乗らない", () => {
  let root;
  before(() => {
    // 本物と同じ並び (scripts/ と packages/<pkg>/) を捨ての repo に組み、script を写す。
    root = mkdtempSync(join(tmpdir(), "wacz-validator-gen-build-info-"));
    mkdirSync(join(root, "scripts"));
    for (const file of ["gen-build-info.mjs", "build-version.mjs"]) {
      copyFileSync(join(here, file), join(root, "scripts", file));
    }
    for (const pkg of ["daemon", "tui", "validate-cli"]) {
      mkdirSync(join(root, "packages", pkg), { recursive: true });
      writeFileSync(join(root, "packages", pkg, "package.json"), '{ "version": "0.0.0" }\n');
    }
    writeFileSync(join(root, ".gitignore"), "packages/*/src/generated/\n");
    const git = gitIn(root);
    git(["init", "-q"]);
    git(["add", "."]);
    commit(git, "release");
    tag(git, "v9.8.7");
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  for (const pkg of ["daemon", "tui", "validate-cli"]) {
    test(`${pkg} の build-info.ts はタグの版を名乗る`, () => {
      execFileSync(process.execPath, [join(root, "scripts", "gen-build-info.mjs"), pkg], {
        cwd: join(root, "packages", pkg),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const written = readFileSync(
        join(root, "packages", pkg, "src", "generated", "build-info.ts"),
        "utf8",
      );
      assert.match(written, /version: "9\.8\.7",/);
    });
  }
});
