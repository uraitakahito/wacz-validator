/**
 * `gen-dcmi-terms.mjs` の関数の試験。手で書いた N-Triples を渡し、網には出ない。
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { NAMESPACE, propertyNames, renderModule } from "./gen-dcmi-terms.mjs";

const RDF_TYPE = "<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>";
const PROPERTY = "<http://www.w3.org/1999/02/22-rdf-syntax-ns#Property>";
const CLASS = "<http://www.w3.org/2000/01/rdf-schema#Class>";

describe("propertyNames", () => {
  it("/terms/ の rdf:Property の主語だけを、重なりなく文字コードの順に抜く", () => {
    const nt = [
      `<${NAMESPACE}title> ${RDF_TYPE} ${PROPERTY} .`,
      `<${NAMESPACE}conformsTo> ${RDF_TYPE} ${PROPERTY} .`,
      `<${NAMESPACE}title> ${RDF_TYPE} ${PROPERTY} .`,
      `<${NAMESPACE}Agent> ${RDF_TYPE} ${CLASS} .`,
      `<http://purl.org/dc/elements/1.1/creator> ${RDF_TYPE} ${PROPERTY} .`,
      `<${NAMESPACE}title> <http://www.w3.org/2000/01/rdf-schema#label> "Title"@en .`,
      "",
    ].join("\n");
    assert.deepEqual(propertyNames(nt), ["conformsTo", "title"]);
  });

  it("行末の CR があっても読む", () => {
    assert.deepEqual(propertyNames(`<${NAMESPACE}format> ${RDF_TYPE} ${PROPERTY} .\r\n`), ["format"]);
  });
});

describe("renderModule", () => {
  it("同じ並びからは同じ中身になり、名前を 1 行ずつ並べる", () => {
    const a = renderModule(["conformsTo", "title"]);
    assert.equal(a, renderModule(["conformsTo", "title"]));
    assert.match(a, /export const DCMI_TERMS_NAMESPACE = "http:\/\/purl\.org\/dc\/terms\/";/);
    assert.match(a, /\n {2}"conformsTo",\n {2}"title",\n\];\n$/);
  });
});
