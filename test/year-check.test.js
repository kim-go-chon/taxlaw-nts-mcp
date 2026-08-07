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

// 0.7.1 핫픽스 회귀 — 헌재 본문처럼 [심판대상조문] 헤더는 잡혔으나 citations 0건일 때
// 본문 전체에 '전부 개정' 단서가 있으면 repealed_or_superseded로 격상되어야 한다.
test("checkYearApplicability: body-wide '전부 개정' clue without citations → repealed_or_superseded (hotfix)", () => {
  const body = [
    "[심판대상조문]",
    "구 조세감면규제법 부칙 제23조 제1항",
    "",
    "[참조판례]",
    "당사자: 청구인 …",
    "",
    "결정요지: 법률 제4666호로 전부 개정된 것의 시행에도 불구하고 …",
  ].join("\n")
  const result = checkYearApplicability({ bodyText: body, targetYear: 2026, metadataCitations: "조세특례제한법" })
  assert.equal(result.classification, "repealed_or_superseded")
})

// 0.7.1 핫픽스 회귀 — citations가 있어도 본문 전체에 '폐지된 「법령」'이 별도 위치에 있으면
// supersession으로 격상 (citation chunk 분리 한계 보완).
test("checkYearApplicability: citations + body-wide '폐지된 [법령]' → repealed_or_superseded (hotfix)", () => {
  const body = [
    "본 건 처분은 토지초과이득세 결정일로부터 6년을 초과하여 …",
    "기 부과된 토지초과이득세는 폐지된「토지초과이득세법」부칙(1998.12.31. 법률 제5586호) 제2조에 따라 필요경비로 공제하는 것입니다.",
    "",
    "가. 관련 조세 법령",
    "○ 소득세법 제97조 (2009. 12. 31. 개정)",
  ].join("\n")
  const result = checkYearApplicability({ bodyText: body, targetYear: 2026 })
  assert.equal(result.classification, "repealed_or_superseded")
})

// ─── v0.9.0 신규 라벨 ─────────────────────────────────────────

test("v0.9.0: 인용 있음 + 시점 단서 없음 + 생산 3년 이내 → target_or_later_inferred", () => {
  const body = [
    "가. 관련 법령",
    "○ 부가가치세법 제26조 제1항 제15호",
    "○ 부가가치세법 시행령 제42조 제1호 파목",
    "○ 부가가치세법 시행규칙 제29조",
  ].join("\n")
  const result = checkYearApplicability({
    bodyText: body,
    targetYear: 2026,
    productionDate: "2024.03.27",
  })
  assert.equal(result.classification, "target_or_later_inferred")
})

test("v0.9.0: 인용 있음 + 시점 단서 없음 + 생산 5년 전 → citations_no_dates (3년 초과)", () => {
  const body = [
    "가. 관련 법령",
    "○ 부가가치세법 제26조 제1항 제15호",
    "○ 부가가치세법 시행령 제42조 제1호 파목",
  ].join("\n")
  const result = checkYearApplicability({
    bodyText: body,
    targetYear: 2026,
    productionDate: "2020.05.10",
  })
  assert.equal(result.classification, "citations_no_dates")
})

test("v0.9.0: 인용 0건 + 메타 없음 → no_citations (라벨 이름 유지)", () => {
  const result = checkYearApplicability({
    bodyText: "본문에 인용 없음.",
    targetYear: 2026,
    productionDate: "2024.01.01",
  })
  assert.equal(result.classification, "no_citations")
})

test("v0.9.0: 메타 fallback + 조 번호 있음 + 최근 → target_or_later_inferred (조 번호 hint로 인정)", () => {
  // v0.9.0 — 메타에 "법령명 + 조 번호"가 있으면 ARTICLE_HINT_PATTERN으로 인용 chunk 인정.
  // 생산일자가 recent면 신규 적극 라벨 'target_or_later_inferred' 적용.
  const result = checkYearApplicability({
    bodyText: "본문 인용 없음.",
    targetYear: 2026,
    metadataCitations: "부가가치세법 제26조, 부가가치세법 시행령 제42조",
    productionDate: "2024.01.01",
  })
  assert.equal(result.classification, "target_or_later_inferred")
  assert.ok(result.usedMetadataFallback)
})

test("v0.9.0: 메타에 법령명만 있고 조 번호 없음 → no_citations", () => {
  const result = checkYearApplicability({
    bodyText: "본문 인용 없음.",
    targetYear: 2026,
    metadataCitations: "부가가치세법",  // 조 번호 없음
    productionDate: "2024.01.01",
  })
  // 조 번호 hint도 시점 단서도 없으면 chunk 생성 안 됨 → citations.length=0 → no_citations.
  assert.equal(result.classification, "no_citations")
})

test("v0.9.0: 생산 미지정 + 인용 있음 + 시점 없음 → citations_no_dates", () => {
  const body = [
    "가. 관련 법령",
    "○ 부가가치세법 시행령 제42조 제1호 파목",
  ].join("\n")
  const result = checkYearApplicability({
    bodyText: body,
    targetYear: 2026,
    // productionDate 의도적 미지정
  })
  assert.equal(result.classification, "citations_no_dates")
})

test("v0.9.0: TAXLAW_RECENT_THRESHOLD_YEARS=5 env override → 5년까지 inferred", () => {
  const body = [
    "가. 관련 법령",
    "○ 부가가치세법 시행령 제42조 제1호 파목",
  ].join("\n")
  process.env.TAXLAW_RECENT_THRESHOLD_YEARS = "5"
  try {
    const result = checkYearApplicability({
      bodyText: body,
      targetYear: 2026,
      productionDate: "2022.05.10", // 4년차
    })
    assert.equal(result.classification, "target_or_later_inferred")
  } finally {
    delete process.env.TAXLAW_RECENT_THRESHOLD_YEARS
  }
})

test("v0.9.0: 시점 단서 있음 → 기존 분류 (inferred 미경유)", () => {
  // 시점 있는 경우는 기존 before_target/valid_current 등으로 흘러가야 함.
  const body = [
    "가. 관련 법령",
    "○ 부가가치세법 시행령 제42조 (2013. 6. 28. 대통령령 제24638호)",
  ].join("\n")
  const result = checkYearApplicability({
    bodyText: body,
    targetYear: 2026,
    productionDate: "2024.05.10", // 최근이지만 시점 단서가 있으면 기존 분류 사용
  })
  assert.equal(result.classification, "before_target")
})

// ─── v0.9.1 hotfix ───────────────────────────────────────────

test("v0.9.1: 관련규정 헤더 없는 본문 + 조 번호만 인용 → 본문 직접 추출로 citations 수집", () => {
  // self-review 발견 갭: 메타 fallback이 동작했어도 본문에 "법령명 + 제N조"가 있으면 잡아야.
  const body = [
    "사회정화국민운동 추진협의회 및 동 지부는 법인세법 제18조 제2항에 규정한",
    "국가 또는 지방자치단체로 볼 수 없으며, 동 협의회 및 지부에 제공한 기부금은",
    "법인세법 시행령 제42조 및 동법 시행규칙 제17조에 열거되지 아니한 기부금으로서",
    "손금용인이 되지 아니하는 것임.",
  ].join("\n")
  const result = checkYearApplicability({
    bodyText: body,
    targetYear: 2026,
    productionDate: "1982.04.15",
    // metadataCitations 의도적 미지정 — 본문 직접 추출 패스가 동작해야 함.
  })
  // 본문에 시점 단서 없으므로 분류는 citations_no_dates 또는 target_or_later_inferred (생산 1982년이라 not recent)
  assert.equal(result.classification, "citations_no_dates")
  assert.ok(result.citations.length > 0, "본문 직접 추출 패스가 citations를 수집해야 함")
})

// ── v0.27.0 리뷰 반영 (P1 3건) ──────────────────────────────────────────

// P1: 최댓값 1건이 구법 인용을 은폐하던 것 차단(혼재 시점).
test("v0.27.0: 최신 인용 + 구법 인용 혼재 → 분류는 유지하되 구법 인용을 경고로 노출", () => {
  const r = checkYearApplicability({
    bodyText: [
      "관련규정",
      "소득세법 제1조(2015.1.1. 법률 제12345호로 개정된 것)",
      "법인세법 제2조(2026.1.1. 법률 제99999호로 개정된 것)",
    ].join("\n"),
    targetYear: 2026,
  })
  assert.equal(r.citations.length, 2)
  // 분류 라벨은 기존 계약 유지(doctrine-assess가 값별 분기)
  assert.ok(["valid_current", "target_or_later"].includes(r.classification), r.classification)
  // 핵심: 구법 인용이 있으면 더 이상 침묵하지 않는다
  const mixed = r.warnings.find((w) => w.includes("혼재 시점"))
  assert.ok(mixed, `혼재 시점 경고 누락: ${JSON.stringify(r.warnings)}`)
  assert.ok(mixed.includes("2015.01.01"), `구법 일자 미표기: ${mixed}`)
})

test("v0.27.0: 모든 인용이 targetYear 이후면 혼재 경고 없음(과발동 방지)", () => {
  const r = checkYearApplicability({
    bodyText: "관련규정\n법인세법 제2조(2026.1.1. 법률 제99999호로 개정된 것)",
    targetYear: 2026,
  })
  assert.ok(!r.warnings.some((w) => w.includes("혼재 시점")), JSON.stringify(r.warnings))
})

// P1: 사건일·지급일을 법령 개정일로 오인하던 것 차단(날짜 결박).
test("v0.27.0: 법령 시점 표지 없는 날짜(지급일)는 법령 시점으로 채택하지 않는다", () => {
  const r = checkYearApplicability({
    bodyText: "관련규정\n2026.1.1. 지급한 소득은 소득세법 제12조에 따른다",
    targetYear: 2026,
  })
  assert.equal(r.citations.length, 1)
  assert.equal(r.citations[0].datesAreLawVintage, false, "지급일이 법령 시점으로 결박됨")
  assert.equal(r.citations[0].latestDate, null)
  assert.equal(r.classification, "citations_no_dates", `분류: ${r.classification}`)
})

test("v0.27.0: 법령번호·개정 표지가 있으면 날짜를 법령 시점으로 결박(회귀)", () => {
  const c = extractCitations("조세특례제한법(2015. 12. 15. 법률 제13560호로 개정된 것) 제30조의5")
  assert.equal(c.length, 1)
  assert.equal(c[0].datesAreLawVintage, true)
  assert.equal(c[0].latestDate, "2015.12.15")
})

// 검증 중 발견: 헤더 매치 위치 미반영으로 섹션 본문에 헤더 꼬리가 남던 버그.
test("v0.27.0: extractRelatedSection이 헤더 꼬리를 남기지 않는다", () => {
  const sec = extractRelatedSection("질의내용 요약\n\n관련 법령:\n소득세법 제1조")
  assert.ok(sec, "섹션 추출 실패")
  assert.ok(sec.startsWith("소득세법"), `헤더 잔재: ${JSON.stringify(sec)}`)
})

// ── v0.27.3(라이브 검증에서 발견) 구법 경계 오탐 ─────────────────────────
// 심판례 본문은 '청구법인'이 수십~수백 회 등장한다. 종전 패턴은 교체(|) 사정거리가
// 첫 대안에만 걸려 '구법'이 substring 매칭되어, 사실상 모든 결정례가 '구법 기반'으로
// 오분류되고 경고 라벨이 수십 회 반복되어 신호가 무력화됐다.
test("v0.27.3: '청구법인'을 구법 표기로 오탐하지 않는다", () => {
  const c = extractCitations("청구법인은 2023사업연도 법인세 신고시 소득세법 제12조를 적용하였다")
  assert.equal(c.length, 1)
  assert.ok(!c[0].amendmentClues.includes("구법/구조문 표기"), `오탐: ${JSON.stringify(c[0].amendmentClues)}`)
})

test("v0.27.3: '연구법인'·'요구법령'·'청구조문'도 오탐하지 않는다", () => {
  for (const t of ["연구법인 제10조", "요구법령 제10조", "청구조문 제10조"]) {
    const c = extractCitations(t)
    assert.ok(!c[0].amendmentClues.includes("구법/구조문 표기"), `오탐(${t}): ${JSON.stringify(c[0].amendmentClues)}`)
  }
})

test("v0.27.3: 진짜 구법 표기는 계속 감지(회귀)", () => {
  for (const t of ["구 조세특례제한법 제6조", "이는 구법 제10조 규정이다", "개정 전 구 조문 제10조"]) {
    const c = extractCitations(t)
    assert.ok(c[0].amendmentClues.includes("구법/구조문 표기"), `미감지(${t}): ${JSON.stringify(c[0].amendmentClues)}`)
  }
})

test("v0.27.3: 심판례 본문에서 partially_outdated 오분류가 사라진다", () => {
  const body = [
    "관련규정",
    "조세특례제한법 제6조(2023.1.1. 법률 제19199호로 개정된 것)",
    "청구법인은 이에 불복하여 심판청구를 제기하였다",
    "청구법인의 대표이사는 동생업체를 승계하였다",
  ].join("\n")
  const r = checkYearApplicability({ bodyText: body, targetYear: 2023 })
  const clues = r.citations.flatMap((c) => c.amendmentClues)
  assert.ok(!clues.includes("구법/구조문 표기"), `오탐 잔존: ${JSON.stringify(clues)}`)
})
