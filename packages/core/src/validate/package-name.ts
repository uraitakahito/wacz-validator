/**
 * 検証する WACZ の名前 (パスの最後の段)。名前を照らす rule (`wacz/file-extension`・
 * `browserhive/wacz-name`) が読む。
 *
 * 名前は `WaczReader.source` から取る —— file はパス、s3 は鍵、http は query を落とした URL
 * (`stripUrlQuery`)。どれも `/` で区切った最後の段が名前。
 *
 * **http の URL は名前を持たないことがある。** `https://host/download?id=1` や `https://host/captures/42`
 * の最後の段は名前でなく、配る側が付けた道筋で、受け取った物の名前は `Content-Disposition` などが決める。
 * そこで、最後の段に `.` の無い http の URL は「名前が分からない」(`undefined`) として扱い、
 * 名前の rule は何も言わない。file と s3 の最後の段は、`.` が無くてもそれが名前。
 */
import type { ReportSource } from "./domain.js";

const lastSegment = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** WACZ の名前。名前が分からなければ `undefined`。 */
export const packageNameOf = (source: ReportSource): string | undefined => {
  switch (source.kind) {
    case "file":
      return lastSegment(source.path);
    case "s3":
      return lastSegment(source.uri);
    case "http": {
      const name = lastSegment(new URL(source.url).pathname);
      return name.includes(".") ? name : undefined;
    }
  }
};
