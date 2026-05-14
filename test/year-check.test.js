import { test } from "node:test"
import { strict as assert } from "node:assert"

process.env.TAXLAW_MCP_TEST_MODE = "1"

const { checkYearApplicability, extractRelatedSection, extractCitations } = await import("../build/year-check.js")

test("extractRelatedSection: detects '가. 관련규정' header", () => {
  const body = [
    "1. 사실관계",
    "회사는 ...",
    "",
    "가. 관련규정",
    "조세특례제한법(2015. 12. 15. 법률 제13560호로 개정된 것) 제30조의5",
    "(1) ...",
    "",
    "나. 회신",
    "당사 의견과 같음.",
  ].join("\n")
  const text = extractRelatedSection(body)
  assert.ok(text)
  assert.match(text, /조세특례제한법/)
  assert.doesNotMatch(text, /회신/)
})

test("extractCitations: parses law number and dates", () => {
  const citations = extractCitations(
    "조세특례제한법(2015. 12. 15. 법률 제13560호로 개정된 것) 제30조의5",
  )
  assert.equal(citations.length, 1)
  assert.equal(citations[0].lawNumber, "법률 제13560호")
  assert.deepEqual(citations[0].dates, ["2015.12.15"])
})

test("checkYearApplicability: targetYear 2024 vs 2015 citation → before_target", () => {
  const body = [
    "가. 관련규정",
    "조세특례제한법(2015. 12. 15. 법률 제13560호로 개정된 것) 제30조의5",
    "",
    "나. 회신",
    "본 건은 ...",
  ].join("\n")
  const result = checkYearApplicability({ bodyText: body, targetYear: 2024 })
  assert.equal(result.hasRelatedSection, true)
  assert.equal(result.classification, "before_target")
  assert.ok(result.warnings.some((w) => /구법조문|targetYear/.test(w)))
})

test("checkYearApplicability: no targetYear → no_target classification", () => {
  const body = "가. 관련규정\n조세특례제한법(2015. 12. 15. 법률 제13560호) 제30조의5"
  const result = checkYearApplicability({ bodyText: body })
  assert.equal(result.classification, "no_target")
})

test("checkYearApplicability: no related section → classification no_citations", () => {
  const body = "회사는 ... 결정함."
  const result = checkYearApplicability({ bodyText: body, targetYear: 2024 })
  assert.equal(result.hasRelatedSection, false)
  assert.equal(result.classification, "no_citations")
})

test("checkYearApplicability: amendment clue surfaces warning", () => {
  const body = [
    "가. 관련규정",
    "구 조세특례제한법(2010. 1. 1. 법률 제9921호로 개정되기 전의 것) 제5조",
    "",
    "나. 회신",
    "...",
  ].join("\n")
  const result = checkYearApplicability({ bodyText: body, targetYear: 2024 })
  assert.ok(
    result.warnings.some((w) => /개정 단서|개정|구법/.test(w)),
    `warnings: ${result.warnings.join(" | ")}`,
  )
})
