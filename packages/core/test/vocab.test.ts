// @module-tag warc
/**
 * `vocab/` の試験。warcinfo の欄の名前を、DCMI の語・WARC 1.1 の欄・どちらでもない、に分ける。
 */
import { describe, expect, it } from "vitest";
import { classifyWarcinfoField } from "../src/vocab/classify.js";
import { DCMI_TERM_NAMES, DCMI_TERMS_NAMESPACE } from "../src/vocab/dcmi-terms.js";
import { WARCINFO_FIELD_NAMES, WARCINFO_SPEC_URL } from "../src/vocab/warcinfo-fields.js";
import { WARC11_SPEC_BASE } from "../src/validate/warc11-fields.js";

describe("classifyWarcinfoField", () => {
  it("DCMI の語は dcterms。ref は DCMI の綴りで組んだ語の URI", () => {
    expect(classifyWarcinfoField("format")).toEqual({ vocabulary: "dcterms", ref: `${DCMI_TERMS_NAMESPACE}format` });
    expect(classifyWarcinfoField("conformsTo")).toEqual({
      vocabulary: "dcterms",
      ref: "http://purl.org/dc/terms/conformsTo",
    });
    expect(classifyWarcinfoField("isPartOf").vocabulary).toBe("dcterms");
    expect(classifyWarcinfoField("description").vocabulary).toBe("dcterms");
  });

  it("名前の大文字小文字は区別しないが、ref は DCMI の綴りにする", () => {
    expect(classifyWarcinfoField("CONFORMSTO")).toEqual({
      vocabulary: "dcterms",
      ref: "http://purl.org/dc/terms/conformsTo",
    });
    expect(classifyWarcinfoField("Format").vocabulary).toBe("dcterms");
    expect(classifyWarcinfoField("Software").vocabulary).toBe("warc");
  });

  it("WARC 1.1 が warcinfo のために決めた欄は warc。ref はその節", () => {
    for (const name of ["operator", "software", "robots", "hostname", "ip", "http-header-user-agent", "http-header-from"]) {
      expect(classifyWarcinfoField(name), name).toEqual({ vocabulary: "warc", ref: WARCINFO_SPEC_URL });
    }
  });

  it("どちらでもない名前は null で、ref は無い", () => {
    expect(classifyWarcinfoField("robots-policy")).toEqual({ vocabulary: null });
    expect(classifyWarcinfoField("wget-arguments")).toEqual({ vocabulary: null });
  });
});

describe("語の一覧", () => {
  it("WARC 1.1 の 7 欄は、どれも DCMI の名前と重ならない", () => {
    const dcmi = new Set(DCMI_TERM_NAMES.map((n) => n.toLowerCase()));
    expect(WARCINFO_FIELD_NAMES.filter((n) => dcmi.has(n.toLowerCase()))).toEqual([]);
  });

  it("DCMI の一覧は重なりが無く、文字コードの順で、基本の 15 語と warcinfo によく出る語を含む", () => {
    expect(new Set(DCMI_TERM_NAMES).size).toBe(DCMI_TERM_NAMES.length);
    expect([...DCMI_TERM_NAMES].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual([...DCMI_TERM_NAMES]);
    for (const name of DCMI_TERM_NAMES) expect(name).toMatch(/^[a-z][A-Za-z]*$/);
    const classic = ["contributor", "coverage", "creator", "date", "description", "format", "identifier", "language"];
    const more = ["publisher", "relation", "rights", "source", "subject", "title", "type"];
    for (const name of [...classic, ...more, "conformsTo", "isPartOf", "audience", "license"]) {
      expect(DCMI_TERM_NAMES, name).toContain(name);
    }
  });

  it("WARC 1.1 の節は、規則の docs と同じ基底の warcinfo の錨", () => {
    expect(WARCINFO_SPEC_URL).toBe(`${WARC11_SPEC_BASE}#warcinfo`);
  });
});
