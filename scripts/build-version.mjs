/**
 * build が名乗る版と commit を、git から決める。
 *
 * ## 版は package.json ではなくタグから
 *
 * この repo の版は **タグにしか無い**。どの package.json も `0.0.0` のままで、リリースで
 * 上げる決まりも無い (タグが唯一の版)。以前は gen-build-info.mjs が package.json を
 * 読んでいたので、daemon の `/healthz` の `version` も、報告の `validatorVersion` も、
 * どの build でも `"0.0.0"` だった。2026-09-26 に見たとき、dashboard の検証を受ける
 * daemon は v0.28.1 のまま 2 日動いていて、v0.29.0 と v0.30.0 の rule はどれも
 * 画面に出ていなかった —— 版を訊いても `0.0.0` としか答えないので、誰も気づけなかった。
 *
 * ## `git describe` で足りる理由
 *
 * browserhive は describe を使わない (scripts/generate-version.mjs)。あちらはタグを main の
 * merge commit に打ち、開発は develop で進むので、develop からタグが見えない。
 * **この repo は main で開発し、タグも main に打つ** —— タグはどれも main の HEAD から
 * 辿れる (2026-09-26 に `git tag --no-merged main` が空なのを確かめた)。describe が
 * 返すのは「HEAD から辿れる最も近いタグ」で、それがそのまま
 * 「この build はどのリリースの上に在るか」の答えになる。古い commit を建てたときも
 * その commit から見た最も近いタグを返すので、版が未来へずれない。
 *
 * (次に打つ版を決めるのに describe を使ってはいけない、という戒めは別の問い ——
 * あちらが欲しいのは repo 全体で最も新しいタグ。)
 *
 * ## 形
 *
 *   0.30.0                    タグの上で、未コミットの変更が無い —— リリースそのもの
 *   0.30.0+3.gabcdef1         タグより 3 commit 先
 *   0.30.0+dirty              タグの上だが、未コミットの変更がある
 *   0.30.0+3.gabcdef1.dirty   その両方
 *   unknown                   タグが見えない (CI の浅い clone、git の無い所)
 *
 * `+` は SemVer の build metadata。`-` で書くと prerelease になり、0.30.0 **より前** を
 * 意味してしまう。**素の `X.Y.Z` を名乗れるのは、中身がそのリリースと同じ build だけ。**
 */
import { execFileSync } from "node:child_process";

/**
 * `git describe --tags --long` の出力から版を組む。**git を触らない** —— だから試験できる。
 *
 * `--long` は タグの上でも `v0.30.0-0-g81c2368` と隔たりを書くので、形が 1 つに揃う。
 * 右から割るので、prerelease のタグ (`v1.0.0-rc.1`) の `-` と混ざらない。
 *
 * @param {string | undefined} described `git describe` の出力。タグが見えなければ undefined
 * @param {boolean} dirty 未コミットの変更があるか
 */
export const versionOf = (described, dirty) => {
  const parts = described?.match(/^v?(.+)-(\d+)-g([0-9a-f]+)$/);
  if (!parts) return "unknown";
  const [, release, ahead, sha] = parts;
  const metadata = [...(ahead === "0" ? [] : [ahead, `g${sha}`]), ...(dirty ? ["dirty"] : [])];
  return metadata.length === 0 ? release : `${release}+${metadata.join(".")}`;
};

/**
 * `root` の checkout から、版と短い commit を読む。
 *
 * 未コミットの変更は **未追跡のファイルも数える** (`git status --porcelain`)。tsc は
 * include に当たるファイルを拾うので、add していない rule も build に入る。
 *
 * git が答えない (`.git` が無い、公開した tarball) ときは、commit を
 * `WACZ_VALIDATOR_GIT_SHA` か `"nogit"` に、版を `"unknown"` にする。
 *
 * @param {string} root repo の根
 * @returns {{ version: string, gitSha: string }}
 */
export const readBuild = (root) => {
  const git = (args) => {
    try {
      return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
    } catch {
      return undefined;
    }
  };
  const sha = git(["rev-parse", "--short", "HEAD"]) ?? process.env.WACZ_VALIDATOR_GIT_SHA ?? "nogit";
  const dirty = (git(["status", "--porcelain"]) ?? "") !== "";
  const described = git(["describe", "--tags", "--long", "--match", "v[0-9]*"]);
  return { version: versionOf(described, dirty), gitSha: sha + (dirty ? "-dirty" : "") };
};
