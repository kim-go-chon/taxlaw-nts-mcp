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

test("extractRelatedSection: detects '가. 관련 조세법령(법률, 시행령, …)' header (new)", () => {
  const body = [
    "1. 질의내용 요약",
    "사실관계 …",
    "",
    "2. 질의내용에 대한 자료",
    "가. 관련 조세법령(법률, 시행령, 시행규칙, 기본통칙)",
    "Ο 소득세법 제52조 【특별공제】",
    "Ο 조세특례제한법 제18조의2 (2003. 12. 30. 개정)",
    "",
    "나. 관련사례(판례, 심판례, 심사례, 예규)",
    "해당사항 없음",
  ].join("\n")
  const text = extractRelatedSection(body)
  assert.ok(text)
  assert.match(text, /소득세법/)
  assert.match(text, /조세특례제한법/)
  assert.doesNotMatch(text, /관련사례/)
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

test("checkYearApplicability: no related section AND no metadata → no_citations", () => {
  const body = "회사는 ... 결정함."
  const result = checkYearApplicability({ bodyText: body, targetYear: 2024 })
  assert.equal(result.hasRelatedSection, false)
  assert.equal(result.classification, "no_citations")
})

test("checkYearApplicability: metadata fallback when no header in body (new)", () => {
  const body = "회사는 ... 결정함."
  const result = checkYearApplicability({
    bodyText: body,
    targetYear: 2024,
    metadataCitations: "소득세법 제14조, 조세특례제한법 제18조",
  })
  assert.equal(result.hasRelatedSection, true)
  assert.equal(result.usedMetadataFallback, true)
  // 시점이 없으므로 uncertain or no_target 계열로 빠지지만, no_citations은 피해야 한다.
  assert.notEqual(result.classification, "no_citations")
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

test("checkYearApplicability: amendment clue + before_target → partially_outdated (new)", () => {
  const body = [
    "가. 관련규정",
    "구 조세특례제한법(2010. 1. 1. 법률 제9921호로 개정되기 전의 것) 제5조",
    "",
    "나. 회신",
    "...",
  ].join("\n")
  const result = checkYearApplicability({ bodyText: body, targetYear: 2024 })
  assert.equal(result.classification, "partially_outdated")
})

test("checkYearApplicability: supersession clue → repealed_or_superseded (new)", () => {
  const body = [
    "가. 관련규정",
    "구 토지초과이득세법 제5조 (1998. 12. 28. 폐지)",
    "조세특례제한법 (2010. 1. 1. 전부개정 법률 제9921호)",
    "",
    "나. 회신",
    "...",
  ].join("\n")
  const result = checkYearApplicability({ bodyText: body, targetYear: 2024 })
  assert.equal(result.classification, "repealed_or_superseded")
  assert.ok(
    result.warnings.some((w) => /폐지|전부개정|갈음/.test(w)),
    `warnings: ${result.warnings.join(" | ")}`,
  )
})

test("checkYearApplicability: target_or_later + amendment clue → target_or_later (not valid_current) (new)", () => {
  const body = [
    "가. 관련규정",
    "조세특례제한법 (2025. 12. 31. 법률 제20001호로 일부개정) 제18조의2",
    "",
    "나. 회신",
    "...",
  ].join("\n")
  const result = checkYearApplicability({ bodyText: body, targetYear: 2024 })
  assert.equal(result.classification, "target_or_later")
})

test("checkYearApplicability: target_or_later + no amendment clue → valid_current (new)", () => {
  const body = [
    "가. 관련규정",
    "조세특례제한법 (2024. 12. 31. 법률 제20001호) 제18조의2",
    "",
    "나. 회신",
    "...",
  ].join("\n")
  const result = checkYearApplicability({ bodyText: body, targetYear: 2024 })
  assert.equal(result.classification, "valid_current")
  assert.match(result.classificationLabel, /현행 유효 추정/)
})
