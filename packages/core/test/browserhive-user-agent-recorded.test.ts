// @module-tag engine
/**
 * `browserhive/user-agent-recorded` のテスト。
 *
 * 守っている主張は WACZ Profile 1.20.0 の settings。`WARC-Target-URI` が `mainPageURL` である `request` レコードは、
 * どれも `settings.userAgent` を `User-Agent` ヘッダに持つ。
 *
 * 入力は「主文書だけ違う」「部品だけ違う」「2 本目だけ違う」「別の本で違う」を分ける。どれか 1 つでも同じ形なら、
 * 「最初の 1 本だけ見る」「全部のレコードを見る」のような誤った実装が緑で通る。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseReportSource, type Issue } from "../src/validate/domain.js";
import { runValidation } from "../src/validate/engine.js";
import { DEFAULT_RULES } from "../src/validate/rules/index.js";
import { fileTransport } from "../src/wacz/transport.js";
import { WaczReader } from "../src/wacz/reader.js";
import { buildWacz, type FixtureOptions, type WarcRequestSpec } from "./fixtures/generator.js";

const RULE = "browserhive/user-agent-recorded";
const PROFILE_1_19 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.19.0/";
const PROFILE_1_20 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.20.0/";
const MAIN = "https://site.test/";
const PART = "https://site.test/app.css";
const UA = "Mozilla/5.0 (X11; Linux x86_64) Chrome/156.0.0.0 Safari/537.36 BrowserHive";
const OTHER = "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/156.0.0.0 Safari/537.36";

const request = (uri: string, userAgent: string, name = "User-Agent"): WarcRequestSpec => ({
  uri,
  httpHeaders: [[name, userAgent]],
});

const archive = (requests: WarcRequestSpec[], over: FixtureOptions = {}): FixtureOptions => ({
  pageUrl: MAIN,
  software: "browserhive/27.0.0",
  conformsTo: PROFILE_1_20,
  settings: { userAgent: UA },
  warcResponses: [{ uri: MAIN, mime: "text/html", body: "<title>t</title>" }],
  warcRequests: requests,
  ...over,
});

describe("browserhive/user-agent-recorded", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-user-agent-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const run = async (options: FixtureOptions): Promise<Issue[]> => {
    const { bytes } = await buildWacz(options);
    const path = join(tmpDir, "fixture.wacz");
    await writeFile(path, bytes);
    const source = parseReportSource(path);
    if (!source.ok || source.value.kind !== "file") throw new Error("unreachable");
    const reader = await WaczReader.open(fileTransport(source.value.path));
    try {
      const result = await runValidation(reader, {
        validatorVersion: "0.0.0",
        rules: DEFAULT_RULES,
        profile: { name: "browserhive", version: { major: 27, minor: 0, patch: 0 } },
      });
      if (!result.ok) throw new Error("runValidation returned err — unreachable");
      return result.value.issues.filter((i) => i.rule === RULE);
    } finally {
      await reader.close();
    }
  };

  it("主文書も部品も同じ字なら何も言わない", async () => {
    expect(await run(archive([request(MAIN, UA), request(PART, UA)]))).toEqual([]);
  });

  it("主文書の字が違えば、URL と 2 つの字を言う（部品は合っている）", async () => {
    const issues = await run(archive([request(MAIN, OTHER), request(PART, UA)]));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.messageKey).toBe(`${RULE}.mismatch`);
    expect(issues[0]?.params).toEqual({ url: MAIN, recorded: UA, sent: OTHER });
  });

  it("部品の字だけ違うなら何も言わない（頁のスクリプトが替えられる）", async () => {
    expect(await run(archive([request(MAIN, UA), request(PART, OTHER)]))).toEqual([]);
  });

  it("主文書の 2 本目だけ違っても言う（読み込みが 2 回ある取り込み）", async () => {
    const issues = await run(archive([request(MAIN, UA), request(MAIN, OTHER)]));
    expect(issues.map((i) => i.params?.["sent"])).toEqual([OTHER]);
  });

  it("別の本にある主文書の要求も見る", async () => {
    const issues = await run(
      archive([request(MAIN, UA)], {
        warcName: "data-000.warc.gz",
        warcinfoFilename: "data-000.warc.gz",
        extraWarcs: [
          { name: "data-001.warc.gz", warcinfoFilename: "data-001.warc.gz", requests: [request(MAIN, OTHER)] },
        ],
      }),
    );
    expect(issues.map((i) => [i.params?.["sent"], i.location?.entry])).toEqual([[OTHER, "archive/data-001.warc.gz"]]);
  });

  it("見出しの綴りが小文字でも同じ字として読む", async () => {
    expect(await run(archive([request(MAIN, UA, "user-agent")]))).toEqual([]);
  });

  it("主文書の要求に User-Agent が無ければ言う", async () => {
    const issues = await run(archive([{ uri: MAIN }]));
    expect(issues.map((i) => i.messageKey)).toEqual([`${RULE}.absent`]);
    expect(issues[0]?.params).toEqual({ url: MAIN, recorded: UA });
  });

  it("主文書の request レコードが無ければ何も言わない（記録しなかったのは別の話）", async () => {
    expect(await run(archive([request(PART, OTHER)]))).toEqual([]);
  });

  it("1.19.0 を名乗る archive には当てない", async () => {
    expect(await run(archive([request(MAIN, OTHER)], { conformsTo: PROFILE_1_19 }))).toEqual([]);
  });

  it("settings.userAgent が無ければ何も言わない（settings-shape の役目）", async () => {
    expect(await run(archive([request(MAIN, OTHER)], { settings: {} }))).toEqual([]);
  });
});
