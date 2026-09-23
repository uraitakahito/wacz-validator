/**
 * @wacz-validator/daemon の public 面 — テスト / 組み込み用にハンドラとサーバを export。
 */
export {
  DaemonError,
  NotRasterError,
  readLine,
  readLines,
  readRecord,
  readRecordBody,
  readRecords,
  validate,
} from "./handlers.js";
export { createDaemon } from "./server.js";
