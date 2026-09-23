/**
 * @wacz-validator/core の public API。
 *
 * downstream consumer が in-process で validation を駆動するのに
 * 必要なものを一通り export する。この package は library だけで、
 * bin を持たない — CLI (`wacz-validator-validate`) は @wacz-validator/validate-cli
 * に居り、commander もそちらの依存なので、library として使う分には
 * 引き込まれない。human-readable な rendering は @wacz-validator/tui 側。
 */
export { WaczReader } from "./wacz/reader.js";
export type { LineStream } from "./wacz/reader.js";
export type { Line } from "./wacz/lines.js";
export { explodeLine } from "./wacz/line-fields.js";
export type { Field } from "./wacz/line-fields.js";
export { httpHeader, mimeOf, parseRecord, summarizeMember } from "./wacz/records.js";
export type { HttpBlock, ParsedRecord, WarcRecordSummary } from "./wacz/records.js";
export { iterateWarcMembers } from "./wacz/warc-iter.js";
export type { WarcMember } from "./wacz/warc-iter.js";
export type { WarcHeader } from "./wacz/warc-header.js";
export { parseCdxj } from "./wacz/cdxj-parser.js";
export type { CdxjEntry } from "./wacz/cdxj-parser.js";
export { fileTransport, httpTransport, s3Transport } from "./wacz/transport.js";
export type { ResolvedHttpSource, ResolvedS3Source, WaczTransport } from "./wacz/transport.js";
export { DEFAULT_PROFILE, runValidation } from "./validate/engine.js";
export { DEFAULT_RULES, conformanceForRule, docsForRule } from "./validate/rules/index.js";
export { renderJson } from "./render/json.js";
export { SUPPORTED_LOCALES, resolveLocale, t } from "./i18n/translate.js";
export type { Locale, MsgParams } from "./i18n/translate.js";
export { SPEC_SECTIONS, specUrl } from "./validate/spec-sections.js";
export type {
  AbsolutePath,
  Conformance,
  DocLink,
  ExpectedBy,
  FileSource,
  Issue,
  IssueLocation,
  ParseSourceError,
  Report,
  ReportEntry,
  ResolvedDocLink,
  HttpSource,
  ReportSource,
  ReportStats,
  ReportSummary,
  RuleApplicability,
  RuleProfile,
  S3Source,
  S3Uri,
  Severity,
  ValidationRule,
} from "./validate/domain.js";
export {
  ALL_PROFILES,
  formatParseSourceError,
  parseHttpUrl,
  parseReportSource,
  s3UriToBucketKey,
} from "./validate/domain.js";
