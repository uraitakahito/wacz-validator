/**
 * DCMI Metadata Terms の property の名前（`http://purl.org/dc/terms/` の名前空間）。
 *
 * `scripts/gen-dcmi-terms.mjs` が、DCMI の配る N-Triples
 * （https://www.dublincore.org/specifications/dublin-core/dcmi-terms/dublin_core_terms.nt）から、
 * `rdf:type rdf:Property` の主語の名前を抜いて作った。手で直さない。直すときは script を走らせる。
 *
 * 持つのは名前だけで、URI は名前空間に名前を足したもの。定義や label は持たない（DCMI の文書の文は
 * CC BY 4.0 で、名前と URI だけなら写す必要が無い）。WARC 1.1 は warcinfo と metadata の本文に
 * 「DCMI のすべての語」を使ってよいとしている（[DCMI] は DCMI Metadata Terms）。
 */
export const DCMI_TERMS_NAMESPACE = "http://purl.org/dc/terms/";

export const DCMI_TERM_NAMES: readonly string[] = [
  "abstract",
  "accessRights",
  "accrualMethod",
  "accrualPeriodicity",
  "accrualPolicy",
  "alternative",
  "audience",
  "available",
  "bibliographicCitation",
  "conformsTo",
  "contributor",
  "coverage",
  "created",
  "creator",
  "date",
  "dateAccepted",
  "dateCopyrighted",
  "dateSubmitted",
  "description",
  "educationLevel",
  "extent",
  "format",
  "hasFormat",
  "hasPart",
  "hasVersion",
  "identifier",
  "instructionalMethod",
  "isFormatOf",
  "isPartOf",
  "isReferencedBy",
  "isReplacedBy",
  "isRequiredBy",
  "isVersionOf",
  "issued",
  "language",
  "license",
  "mediator",
  "medium",
  "modified",
  "provenance",
  "publisher",
  "references",
  "relation",
  "replaces",
  "requires",
  "rights",
  "rightsHolder",
  "source",
  "spatial",
  "subject",
  "tableOfContents",
  "temporal",
  "title",
  "type",
  "valid",
];
