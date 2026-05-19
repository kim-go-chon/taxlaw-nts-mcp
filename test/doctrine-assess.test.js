import { test } from "node:test"
import { strict as assert } from "node:assert"

process.env.TAXLAW_MCP_TEST_MODE = "1"

const { checkYearApplicability } = await import("../build/year-check.js")
const { extractLawArticleRefs } = await import("../build/citation-extract.js")
const { assessDoctrineValidity, formatAssessment } = await import("../build/doctrine-assess.js")

function makeMeta(overrides = {}) {
  return {
    id: "010000000000044350",
    title: "외국인근로자의 근로소득에 대한 과세특례 적용시 표준공제",
    docNumber: "서면인터넷방문상담1팀-1219",
    productionDate: "2007.09.03",
    type: "질의회신",
    taxLawCode: "305",
    relatedLawsMeta: "소득세법 제14조, 소득세법 제52조, 조세특례제한법 제18조의2",
    ...overrides,
  }
}

test("assessDoctrineValidity: 2007 doctrine vs 2026 → likely_outdated (vintage > 15y)", () => {
  const body = [
    "가. 관련 조세법령(법률, 시행령, 시행규칙, 기본통칙)",
    "Ο 소득세법 제52조 (2006. 12. 30. 개정) 표준공제",
    "Ο 조세특례제한법 제18조의2 (2003. 12. 30. 개정)",
    "",
    "나. 관련사례(판례, 심판례, 심사례, 예규)",
  ].join("\n")
  const yc = checkYearApplicability({ bodyText: body, targetYear: 2026, metadataCitations: "" })
  const refs = extractLawArticleRefs(body)
  const a = assessDoctrineValidity({
    meta: makeMeta(),
    yearCheck: yc,
    citedArticles: refs,
    targetYear: 2026,
  })
  // 인용 시점 2006 (before_target) + 생산일자 2007 (gap 19) → likely_outdated.
  assert.equal(a.finalValidity, "likely_outdated")
  assert.ok(a.signals.some((s) => s.kind === "vintage" && s.severity === "high"))
  assert.ok(a.nextActions.some((n) => n.tool.startsWith("korean-law-mcp")))
})

test("assessDoctrineValidity: repealed clue → superseded_or_repealed", () => {
  const body = [
    "가. 관련규정",
    "구 토지초과이득세법 제5조 (1998. 12. 28. 폐지)",
    "",
    "나. 회신",
  ].join("\n")
  const yc = checkYearApplicability({ bodyText: body, targetYear: 2026 })
  const refs = extractLawArticleRefs(body)
  const a = assessDoctrineValidity({
    meta: makeMeta({ productionDate: "1999.05.01", docNumber: "심사-1999-XXXX" }),
    yearCheck: yc,
    citedArticles: refs,
    targetYear: 2026,
  })
  assert.equal(a.finalValidity, "superseded_or_repealed")
  assert.ok(a.signals.some((s) => s.kind === "supersession_clue"))
})

test("assessDoctrineValidity: recent doctrine + valid_current citation → valid_current", () => {
  const body = [
    "가. 관련규정",
    "조세특례제한법 (2024. 12. 31. 법률 제20001호) 제18조의2",
    "",
    "나. 회신",
  ].join("\n")
  const yc = checkYearApplicability({ bodyText: body, targetYear: 2024 })
  const refs = extractLawArticleRefs(body)
  const a = assessDoctrineValidity({
    meta: makeMeta({ productionDate: "2025.01.10", docNumber: "기재부-2025-1" }),
    yearCheck: yc,
    citedArticles: refs,
    targetYear: 2024,
  })
  assert.equal(a.finalValidity, "valid_current")
})

test("assessDoctrineValidity: no targetYear → needs_current_check", () => {
  const body = "가. 관련규정\n조세특례제한법 (2024. 12. 31. 법률 제20001호) 제18조의2"
  const yc = checkYearApplicability({ bodyText: body })
  const refs = extractLawArticleRefs(body)
  const a = assessDoctrineValidity({
    meta: makeMeta({ productionDate: "2024.03.01" }),
    yearCheck: yc,
    citedArticles: refs,
  })
  assert.equal(a.finalValidity, "needs_current_check")
  assert.ok(a.signals.some((s) => s.kind === "no_target"))
})

test("assessDoctrineValidity: no body and no metadata → unverified", () => {
  const body = "본 건은 거주자 갑에 대한 처분이다."
  const yc = checkYearApplicability({ bodyText: body, targetYear: 2026 })
  const refs = extractLawArticleRefs(body)
  const a = assessDoctrineValidity({
    meta: makeMeta({ relatedLawsMeta: "" }),
    yearCheck: yc,
    citedArticles: refs,
    targetYear: 2026,
  })
  assert.equal(a.finalValidity, "unverified")
})

test("formatAssessment: scorecard contains final verdict and next-action queue", () => {
  const body = [
    "가. 관련규정",
    "조세특례제한법 제18조의2 (2003. 12. 30. 개정)",
  ].join("\n")
  const yc = checkYearApplicability({ bodyText: body, targetYear: 2026 })
  const refs = extractLawArticleRefs(body)
  const a = assessDoctrineValidity({
    meta: makeMeta(),
    yearCheck: yc,
    citedArticles: refs,
    targetYear: 2026,
  })
  const text = formatAssessment(a).join("\n")
  assert.match(text, /최종 판정/)
  assert.match(text, /권장 후속 호출 큐/)
  assert.match(text, /korean-law-mcp/)
})
