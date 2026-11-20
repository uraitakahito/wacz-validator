// @module-tag tui
/**
 * Header のバージョン表示テスト。
 *
 * Header は TUI 自身のビルド(`build.tui`)の短い git SHA を出し、daemon の
 * SHA(`build.daemon`、起動時の `wacz-validator/ping` 由来)と食い違うときだけ
 * `⚠ daemon ·<sha>` を警告色で添える。SHA 不一致 = どちらかが古いプロセス。
 */
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { AbsolutePath, WireReport } from "@wacz-validator/protocol";
import { App } from "../src/app.js";

const report: WireReport = {
  validatorVersion: "0.0.0",
  profile: { name: "spec" },
  source: { kind: "file", path: "/tmp/fixture.wacz" as AbsolutePath },
  summary: { passed: 1, failed: 0, warnings: 0, info: 0, durationMs: 1 },
  issues: [],
  entries: [],
  rules: [],
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

describe("Header version / git SHA", () => {
  it("shows the tui's short git SHA and no warning when tui and daemon match", async () => {
    const { lastFrame } = render(
      <App
        report={report}
        build={{
          tui: { version: "0.0.0", gitSha: "9f3c2a1" },
          daemon: { version: "0.0.0", gitSha: "9f3c2a1" },
        }}
      />,
    );
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("·9f3c2a1");
    expect(frame).not.toContain("⚠");
  });

  it("warns with the daemon SHA when tui and daemon git SHAs differ", async () => {
    const { lastFrame } = render(
      <App
        report={report}
        build={{
          tui: { version: "0.0.0", gitSha: "9f3c2a1" },
          daemon: { version: "0.0.0", gitSha: "1b8e4d0" },
        }}
      />,
    );
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("·9f3c2a1"); // tui 自身の SHA は常に出る
    expect(frame).toContain("⚠ daemon ·1b8e4d0"); // 不一致なので daemon を警告表示
  });
});
