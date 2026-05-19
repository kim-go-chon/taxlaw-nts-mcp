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

// ─── v0.9.0 신규 신호 ─────────────────────────────────────────

test("v0.9.0: 옛 부가세법 시행령 §35 인용 → restructured_location 신호 + superseded_or_repealed 격상", () => {
  const body = [
    "가. 관련 조세 법령",
    "○ 부가가치세법시행령 제35조 제1호 (인적용역의 범위)",
  ].join("\n")
  const yc = checkYearApplicability({
    bodyText: body,
    targetYear: 2026,
    productionDate: "2003.10.14",
  })
  const refs = extractLawArticleRefs(body)
  const a = assessDoctrineValidity({
    meta: makeMeta({ productionDate: "2003.10.14" }),
    yearCheck: yc,
    citedArticles: refs,
    targetYear: 2026,
  })
  assert.ok(a.restructureHits.length >= 1, "restructureHits 1건 이상")
  assert.equal(a.restructureHits[0].oldRef, "시행령.제35조제1호")
  assert.equal(a.restructureHits[0].newRef, "시행령.제42조제1호")
  assert.ok(a.signals.some((s) => s.kind === "restructured_location"), "restructured_location 신호 부착")
  assert.equal(a.finalValidity, "superseded_or_repealed")
})

test("v0.9.0: 최근 심판례 + 시점 단서 없음 → recent_doctrine_inferred 신호", () => {
  const body = [
    "가. 관련 법령",
    "○ 부가가치세법 제26조 제1항 제15호",
    "○ 부가가치세법 시행령 제42조 제1호 파목",
  ].join("\n")
  const yc = checkYearApplicability({
    bodyText: body,
    targetYear: 2026,
    productionDate: "2024.03.27",
  })
  const refs = extractLawArticleRefs(body)
  const a = assessDoctrineValidity({
    meta: makeMeta({ productionDate: "2024.03.27" }),
    yearCheck: yc,
    citedArticles: refs,
    targetYear: 2026,
  })
  assert.equal(yc.classification, "target_or_later_inferred")
  assert.ok(a.signals.some((s) => s.kind === "recent_doctrine_inferred"), "recent_doctrine_inferred 신호 부착")
  assert.equal(a.finalValidity, "needs_current_check")
})

test("v0.9.1: 최근 심판례 + before_target → needs_current_check (partially_outdated 회피)", () => {
  // self-review 발견 갭: 조심-2026-서-0581 같은 최근 심판례가 조특법 "(2021.12.28 개정된 것)"
  // 형식 시점 단서 때문에 partially_outdated로 떨어지는 false-positive 차단.
  const body = [
    "가. 관련 법령",
    "○ 조세특례제한법(2021.12.28. 법률 제186434호로 일부 개정 된 것) 제6조",
  ].join("\n")
  const yc = checkYearApplicability({
    bodyText: body,
    targetYear: 2026,
    productionDate: "2026.04.08", // 0년차 (최근)
  })
  assert.equal(yc.classification, "before_target", "year-check는 before_target 유지")
  const refs = extractLawArticleRefs(body)
  const a = assessDoctrineValidity({
    meta: makeMeta({ productionDate: "2026.04.08" }),
    yearCheck: yc,
    citedArticles: refs,
    targetYear: 2026,
  })
  // v0.9.1 — 생산 3년 이내면 partially_outdated 회피.
  assert.equal(a.finalValidity, "needs_current_check", "최근 심판례는 needs_current_check로 격상 회피")
})

test("v0.9.1: 오래된 예규 + before_target → 기존대로 partially_outdated", () => {
  // 회귀 검증: 생산 3년 초과면 기존 partially_outdated 동작 유지.
  const body = [
    "가. 관련 법령",
    "○ 조세특례제한법 제6조 (2010.12.31. 개정)",
  ].join("\n")
  const yc = checkYearApplicability({
    bodyText: body,
    targetYear: 2026,
    productionDate: "2012.05.10", // 14년차
  })
  const refs = extractLawArticleRefs(body)
  const a = assessDoctrineValidity({
    meta: makeMeta({ productionDate: "2012.05.10" }),
    yearCheck: yc,
    citedArticles: refs,
    targetYear: 2026,
  })
  assert.equal(a.finalValidity, "partially_outdated", "오래된 케이스는 기존대로 partially_outdated")
})

test("v0.9.0: citations_no_dates → citations_no_dates 신호 + unverified", () => {
  const body = [
    "가. 관련 법령",
    "○ 부가가치세법 시행령 제42조 제1호 파목",
  ].join("\n")
  const yc = checkYearApplicability({
    bodyText: body,
    targetYear: 2026,
    productionDate: "2018.05.10", // 8년차 → not recent
  })
  const refs = extractLawArticleRefs(body)
  const a = assessDoctrineValidity({
    meta: makeMeta({ productionDate: "2018.05.10" }),
    yearCheck: yc,
    citedArticles: refs,
    targetYear: 2026,
  })
  assert.equal(yc.classification, "citations_no_dates")
  assert.ok(a.signals.some((s) => s.kind === "citations_no_dates"), "citations_no_dates 신호 부착")
  assert.equal(a.finalValidity, "unverified")
})
