/**
 * check-test-hosts.mjs が読むファイルの試験。`node --test` で走る (root の `test:scripts`)。
 *
 * 捨ての repo を本物の git で組み、その根で script を走らせる。読んだかどうかは、ファイルに
 * example 名を書いておき、script がそのファイルを名指すかで見る。
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";

const script = join(import.meta.dirname, "check-test-hosts.mjs");

// 手元の git の設定 (署名・既定の branch 名など) を持ち込まない。script が呼ぶ git も
// この process の env を継ぐので、同じく素の設定で走る。
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

// この試験も script が見る場所 (scripts/*.test.mjs) に在るので、example 名を続けて書かない。
const NAMED = `const url = "https://${["example", "com"].join(".")}/";\n`;
const CLEAN = `const url = "https://site.test/";\n`;

/**
 * 捨ての repo を組む。tracked は commit し、untracked は置くだけ (add しない)。
 * deleted は commit した後に消す (git rm はしない)。
 */
const makeRepo = (t, { tracked, untracked, deleted }) => {
  const root = mkdtempSync(join(tmpdir(), "wacz-validator-check-test-hosts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const put = (files) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
  };
  git("init", "-q");
  // ignore するのはこの repo の .gitignore だけ。既定のままだと手元の ~/.config/git/ignore も効く。
  git("config", "core.excludesFile", "/dev/null");
  // CI の runner と同じ git の既定。ASCII でない名前は引用符つきで一覧に出る。
  git("config", "core.quotePath", "true");
  put(tracked);
  git("add", "--", ...Object.keys(tracked));
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "fixture");
  put(untracked);
  for (const file of deleted) rmSync(join(root, file));
  return root;
};

const run = (root) => spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });

describe("check-test-hosts.mjs が読むファイル", () => {
  test("追跡済みと、まだ add していない新しいファイルを読む。ignore したもの・見る場所の外は読まない", (t) => {
    const root = makeRepo(t, {
      tracked: {
        ".gitignore": "test/ignored.test.ts\n",
        "test/tracked.test.ts": NAMED,
        "test/deleted.test.ts": NAMED,
        "docs/tracked.md": NAMED, // 見る場所の外
      },
      untracked: {
        "test/new.test.ts": NAMED,
        "test/日本語.test.ts": NAMED, // -z で読まないと、引用符つきの名前になって飛ばされる
        "packages/pkg/test/new.test.ts": NAMED,
        "packages/pkg/test/fixtures/new.json": NAMED, // packages/*/test/* の * は / もまたぐ
        "scripts/new.test.mjs": NAMED,
        "test/ignored.test.ts": NAMED, // ignore した
        "packages/pkg/src/new.ts": NAMED, // 見る場所の外
        "scripts/new.mjs": NAMED, // 見る場所の外
      },
      deleted: ["test/deleted.test.ts"],
    });
    const { status, stderr } = run(root);
    // 名指した行からファイルを抜く。ほかの形の行 (落ちたときの stack など) は、そのまま差に出す。
    const named = stderr
      .split("\n")
      .filter(Boolean)
      .map((line) => /^(.+?):\d+: example 名が残っています/.exec(line)?.[1] ?? line);
    assert.deepEqual(
      named.sort(),
      [
        "packages/pkg/test/fixtures/new.json",
        "packages/pkg/test/new.test.ts",
        "scripts/new.test.mjs",
        "test/new.test.ts",
        "test/tracked.test.ts",
        "test/日本語.test.ts",
      ].sort(),
    );
    assert.equal(status, 1);
  });

  test("消したがまだ追跡しているファイルは飛ばし、数にも入れない", (t) => {
    const root = makeRepo(t, {
      tracked: { "test/kept.test.ts": CLEAN, "test/deleted.test.ts": CLEAN },
      untracked: { "test/new.test.ts": CLEAN },
      deleted: ["test/deleted.test.ts"],
    });
    const { status, stdout, stderr } = run(root);
    assert.equal(stderr, "");
    assert.equal(stdout, "試験の場所に example 名はありません（2 ファイル）\n");
    assert.equal(status, 0);
  });
});
