import { test } from "node:test"
import { strict as assert } from "node:assert"

process.env.TAXLAW_MCP_TEST_MODE = "1"

const {
  extractEnforceDate,
  hangToSymbol,
  sliceHangBlock,
  parseJoSpec,
  extractAmendmentInventory,
  checkAmendmentBinding,
  extractJunyongTargets,
  fmtJunyong,
  extractJoClauses,
  targetYearApplicationNote,
  joMentioned,
  articleInfoFromXml,
  findArticleInXml,
  filterVersionsByName,
  filterVersionsByNameStrict,
  lawNameFallbackNote,
  capJunyongBlocks,
} = await import("../build/index.js")

// ── hangToSymbol ──
test("hangToSymbol: 제6항 → ⑥", () => {
  assert.equal(hangToSymbol("제6항"), "⑥")
})

test("hangToSymbol: 범위 밖이면 null", () => {
  assert.equal(hangToSymbol("제21항"), null)
  assert.equal(hangToSymbol("항"), null)
})

// ── sliceHangBlock ──
// 회귀: 직렬화 본문의 중복 항 마커("⑥⑥")에서 빈 블록("⑥" 1자)으로 절단돼
// 양쪽이 동일해지고 거짓 '변경 없음'이 나던 버그(0.10.0, 조특령 §26의8 실측).
test("sliceHangBlock: 중복 항 마커(①①…⑥⑥…⑦⑦) 본문에서 해당 항 블록만 절단", () => {
  const text = "제26조의8(통합고용세액공제)①① 1항 내용⑥⑥ 제11조의2제8항을 준용한다.⑦⑦ 7항 내용"
  const r = sliceHangBlock(text, "제6항")
  assert.equal(r.found, true)
  assert.ok(r.text.includes("준용한다"))
  assert.ok(!r.text.includes("1항 내용"))
  assert.ok(!r.text.includes("7항 내용"))
})

test("sliceHangBlock: 단일 마커 본문도 동일 동작", () => {
  const r = sliceHangBlock("① 일항 내용⑥ 육항 본문⑦ 칠항 내용", "제6항")
  assert.equal(r.found, true)
  assert.equal(r.text, "⑥ 육항 본문")
})

test("sliceHangBlock: 없는 항이면 found=false + 전체 유지", () => {
  const text = "① 일항 내용"
  const r = sliceHangBlock(text, "제6항")
  assert.equal(r.found, false)
  assert.equal(r.text, text)
})

// ── parseJoSpec ──
test("parseJoSpec: 조+항 결합 표기", () => {
  assert.deepEqual(parseJoSpec("제26조의8제6항"), { jo: "제26조의8", hang: "제6항" })
  assert.deepEqual(parseJoSpec("제26조의8 제6항"), { jo: "제26조의8", hang: "제6항" })
})

test("parseJoSpec: 조만 / 비정형은 null", () => {
  assert.deepEqual(parseJoSpec("제29조의8"), { jo: "제29조의8", hang: undefined })
  assert.equal(parseJoSpec("26조의8"), null)
})

// ── extractAmendmentInventory ──
// 조특령 §26의8 패턴 축약: ②는 2025.12.31 개정, ⑥은 2025.6.30 개정(35999호가 ⑥을 안 고친 상황 재현)
const SAMPLE_ARTICLE = [
  "제26조의8(통합고용세액공제)",
  "② 법 제29조의8제1항에서 \"대통령령으로 정하는 상시근로자\"란 근로계약을 체결한 내국인 근로자를 말한다. <개정 2025.12.31>",
  "③ 청년등상시근로자란 다음 각 호의 사람을 말한다. <개정 2025.2.28, 2025.6.30>",
  "⑥ 상시근로자 수는 다음 계산식에 따라 계산한 수로 한다. <개정 2025.6.30>",
].join("\n")

test("extractAmendmentInventory: 항별 꼬리표 수집", () => {
  const inv = extractAmendmentInventory(SAMPLE_ARTICLE)
  assert.deepEqual(inv.byHang["②"], ["2025.12.31"])
  assert.deepEqual(inv.byHang["③"], ["2025.2.28", "2025.6.30"])
  assert.deepEqual(inv.byHang["⑥"], ["2025.6.30"])
  assert.equal(inv.article.includes("2025.12.31"), true)
  assert.equal(inv.article.includes("2025.6.30"), true)
})

test("extractAmendmentInventory: HTML 엔티티(&lt;개정&gt;)도 인식", () => {
  const inv = extractAmendmentInventory("⑥ 계산한 수로 한다. &lt;개정 2026.2.27&gt;")
  assert.deepEqual(inv.byHang["⑥"], ["2026.2.27"])
})

// ── checkAmendmentBinding ──
test("checkAmendmentBinding: 35999호(2025.12.31)는 ⑥(2025.6.30만)을 개정한 흔적 없음", () => {
  assert.equal(checkAmendmentBinding("20251231", ["2025.6.30"]), "개정 흔적 없음")
})

test("checkAmendmentBinding: 36127호(2026.2.27)는 ⑥(…2026.2.27)을 개정함", () => {
  assert.equal(checkAmendmentBinding("20260227", ["2025.6.30", "2026.2.27"]), "개정함")
})

test("checkAmendmentBinding: 꼬리표 미회수면 판정불가", () => {
  assert.equal(checkAmendmentBinding("20251231", []), "판정불가")
})

// ── extractJunyongTargets ──
test("extractJunyongTargets: §26의8⑥ → §11의2⑧ 준용 탐지(법률 조문 참조는 미탐지)", () => {
  const body =
    "⑥ 법 제29조의8제1항부터 제5항까지의 규정을 적용할 때 상시근로자 수 및 청년등상시근로자 수의 계산방법에 관하여는 제11조의2제8항을 준용한다."
  const targets = extractJunyongTargets(body, "제26조의8")
  assert.deepEqual(targets, [{ jo: "제11조의2", hang: "제8항" }])
})

test("extractJunyongTargets: 자기 자신 제외 + 복수 준용 수집", () => {
  const body = "⑦ 제26조의8 계산에 관하여는 제23조제11항 후단을 준용하며, ⑧ 창업의 경우에는 제23조제13항을 준용한다."
  const targets = extractJunyongTargets(body, "제26조의8")
  assert.deepEqual(targets, [
    { jo: "제23조", hang: "제11항" },
    { jo: "제23조", hang: "제13항" },
  ])
})

// ── v0.23.0(B): 범위 준용 "제N항부터 제M항까지" 전개 ──
test("extractJunyongTargets(B): 범위 준용 '제10항부터 제13항까지' → 각 항 전개", () => {
  const body = "⑦ 법 제7조제5항에 따른 상시근로자의 범위 및 계산방법에 관하여는 제23조제10항부터 제13항까지의 규정을 준용한다."
  const targets = extractJunyongTargets(body, "제6조")
  assert.deepEqual(targets, [
    { jo: "제23조", hang: "제10항" },
    { jo: "제23조", hang: "제11항" },
    { jo: "제23조", hang: "제12항" },
    { jo: "제23조", hang: "제13항" },
  ])
})

test("extractJunyongTargets(B): 다른 참조의 범위는 오삼키지 않음(anchor 항 불일치 시 단일)", () => {
  const body = "제7항부터 제9항까지의 규정을 적용할 때 상시근로자는 제23조제10항을 준용한다."
  const targets = extractJunyongTargets(body, "제6조")
  assert.deepEqual(targets, [{ jo: "제23조", hang: "제10항" }])
})

// ── v0.24.0(E1): 타법·별표 준용 귀속(오귀속 버그픽스) ──
test("extractJunyongTargets(E1): 타법 준용은 lawName 부착(현재 법령 제N조로 오귀속 방지)", () => {
  const body = "소기업이란 매출액이 「중소기업기본법 시행령」 제13조를 준용하여 산정한 규모 이내인 기업을 말한다."
  assert.deepEqual(extractJunyongTargets(body, "제6조"), [{ jo: "제13조", lawName: "중소기업기본법시행령" }])
})

test("extractJunyongTargets(E1): 별표만 준용도 포착(종전 silent skip)", () => {
  const body = "매출액이 업종별로 「중소기업기본법 시행령」 별표3을 준용하여 산정한 규모 기준 이내"
  assert.deepEqual(extractJunyongTargets(body, "제6조"), [{ lawName: "중소기업기본법시행령", annex: "별표3" }])
})

test("extractJunyongTargets(E1): 같은 법령 준용은 lawName 없이(shape 하위호환)", () => {
  const body = "상시근로자 수의 계산방법에 관하여는 제23조제10항을 준용한다."
  assert.deepEqual(extractJunyongTargets(body, "제6조"), [{ jo: "제23조", hang: "제10항" }])
})

test("fmtJunyong: 타법=「법령명」 병기, 같은 법령=조항만, 별표", () => {
  assert.equal(fmtJunyong({ jo: "제23조", hang: "제10항" }), "제23조제10항")
  assert.equal(fmtJunyong({ jo: "제13조", lawName: "중소기업기본법시행령" }), "「중소기업기본법시행령」제13조")
  assert.equal(fmtJunyong({ lawName: "중소기업기본법시행령", annex: "별표3" }), "「중소기업기본법시행령」별표3")
})

// ── v0.25.0(E3): 순수함수 ──
const E3_ART_XML =
  "<법령><조문단위><조문내용><![CDATA[제26조의8(통합고용세액공제)" +
  "① 첫째 항 내용" +
  "② 상시근로자 수 계산. <개정 2025.12.31>" +
  "⑥ 상시근로자 수는 계산식에 따른다. <개정 2025.6.30>" +
  "]]></조문내용></조문단위></법령>"

test("articleInfoFromXml(E3): 항 지정 시 그 항 꼬리표만, 미지정 시 조 전체, 미발견 시 빈값", () => {
  assert.deepEqual(articleInfoFromXml(E3_ART_XML, "제26조의8", "제6항").dates, ["2025.6.30"])
  const all = articleInfoFromXml(E3_ART_XML, "제26조의8").dates
  assert.ok(all.includes("2025.12.31") && all.includes("2025.6.30"))
  assert.deepEqual(articleInfoFromXml(E3_ART_XML, "제99조"), { dates: [], body: "", status: "missing" })
})

// ── v0.25.0(리뷰 EF-2): 부칙 bare-CDATA 오매칭 차단 + 삭제 감지 ──
test("articleInfoFromXml(EF-2): 부칙 bare-CDATA는 조문으로 오매칭 금지 + 삭제 감지", () => {
  const xml = "<법령><조문단위><조문내용><![CDATA[제1조(목적) 내용]]></조문내용></조문단위>" +
    "<조문단위><조문내용><![CDATA[제2조 삭제 <2019.12.31>]]></조문내용></조문단위>" +
    "<부칙><부칙단위><부칙내용><![CDATA[제9조(자기관리 부동산투자회사) 부칙 본문 <개정 2020.1.1>]]></부칙내용></부칙단위></부칙></법령>"
  assert.equal(articleInfoFromXml(xml, "제9조").status, "missing")   // 구현 전엔 가짜 body+2020.1.1 반환(재현)
  assert.deepEqual(articleInfoFromXml(xml, "제9조").dates, [])
  const del = articleInfoFromXml(xml, "제2조")
  assert.equal(del.status, "deleted"); assert.match(del.deletedDate, /2019/)
  assert.equal(articleInfoFromXml(xml, "제1조").status, "found")
})

// ── v0.25.0(리뷰 EF-3): 비인접 「타법」 오귀속 강등 + 인접 체인 유지 ──
test("extractJunyongTargets(EF-3): 정의목적 비인접 「타법」은 오귀속 금지(자기법+lawHint)", () => {
  const body = "「소득세법」에 따른 양도소득과세표준의 계산에 관하여는 제95조를 준용한다."
  assert.deepEqual(extractJunyongTargets(body, "제100조의32"), [{ jo: "제95조", lawHint: "소득세법" }])
})
test("extractJunyongTargets(EF-3): 인접 연쇄(제N조 및 제M조)는 타법 귀속 유지", () => {
  // v0.27.0 — 이 테스트의 의도는 '연결사(및)를 넘어 「소득세법」 귀속이 유지되는가'(EF-3 over-reject 방지)다.
  //   종전 기대값이 1건이었던 것은 열거 추출 버그(마지막 참조만 채택)를 그대로 굳혀둔 것으로,
  //   제95조도 정당한 준용 대상이라 무경고로 소실되고 있었다. 귀속 검증 의도는 그대로 두고 건수만 정정.
  const body = "「소득세법」 제95조 및 제97조를 준용한다."
  assert.deepEqual(extractJunyongTargets(body, "제55조"), [
    { jo: "제95조", lawName: "소득세법" },
    { jo: "제97조", lawName: "소득세법" },
  ])
})

// ── v0.26.0(리뷰 완결성): EF-3 whitelist 'ㆍ'(U+318D) + EF-2 앵커 attr 관용 ──
test("extractJunyongTargets(EF-3 v0.26.0): 인접 연쇄 구분자 'ㆍ'(U+318D)도 타법 귀속 유지(over-reject 방지)", () => {
  // 실 법문 다빈도 가운뎃점(U+318D)이 whitelist에 없어 "제95조ㆍ제97조"를 자기법으로 과강등하던 것 수정.
  const body = "「소득세법」 제95조ㆍ제97조를 준용한다."
  // v0.27.0 — 위와 동일: whitelist 'ㆍ' 귀속 유지 검증은 그대로, 열거 건수만 정정(제95조 소실 수정).
  assert.deepEqual(extractJunyongTargets(body, "제55조"), [
    { jo: "제95조", lawName: "소득세법" },
    { jo: "제97조", lawName: "소득세법" },
  ])
})
test("findArticleInXml(EF-2 v0.26.0): <조문내용>에 속성(<조문내용 ...>)이 있어도 조문·삭제 감지", () => {
  const xml = '<법령><조문단위><조문내용 lang="ko"><![CDATA[제5조(정의) 본문]]></조문내용></조문단위></법령>'
  assert.equal(findArticleInXml(xml, "제5조").status, "found")
  assert.equal(articleInfoFromXml(xml, "제5조").status, "found")
  const delXml = '<법령><조문단위><조문내용 x="1"><![CDATA[제9조 삭제 <2019.12.31>]]></조문내용></조문단위></법령>'
  assert.equal(findArticleInXml(delXml, "제9조").status, "deleted")
})

// ── v0.26.1(리뷰 라이브): 조-범위 준용 라벨(조특령 §100의16⑥ → 법인세법 §14~54 실사례) ──
test("extractJunyongTargets(v0.26.1): 조-범위 '제N조부터 제M조까지'는 대표 조+joRange 라벨", () => {
  const body = "준청산소득금액을 계산할 때 「법인세법」 제14조부터 제54조까지를 준용한다."
  assert.deepEqual(extractJunyongTargets(body, "제100조의16"), [{ jo: "제54조", lawName: "법인세법", joRange: "제14조~제54조" }])
})
test("fmtJunyong(v0.26.1): joRange 있으면 범위 준용 명시", () => {
  assert.match(fmtJunyong({ jo: "제54조", lawName: "법인세법", joRange: "제14조~제54조" }), /범위 준용 제14조~제54조/)
  // joRange 없으면 종전 포맷 불변(하위호환)
  assert.equal(fmtJunyong({ jo: "제54조", lawName: "법인세법" }), "「법인세법」제54조")
})

// ── v0.25.0(리뷰 TK-1): 준용 체인 블록 공유상한 ──
test("capJunyongBlocks(TK-1): 상한 이하 배열은 원본 그대로", () => {
  const blocks = ["a", "b", "c"]
  assert.deepEqual(capJunyongBlocks(blocks, false), blocks)
})
test("capJunyongBlocks(TK-1): 비full 8000자 초과 시 절단 + 명시 생략 라벨", () => {
  const blocks = ["x".repeat(3000), "x".repeat(3000), "x".repeat(3000), "x".repeat(3000)]
  const out = capJunyongBlocks(blocks, false)
  assert.equal(out.length, 3)   // block0, block1, 라벨(합계 9003 > 8000에서 i=2 절단)
  assert.ok(out[out.length - 1].includes("출력 상한"))
  assert.ok(out[out.length - 1].includes("8,000"))
})
test("capJunyongBlocks(TK-1): full=true는 캡 24000 — 8000 초과분도 유지", () => {
  const blocks = ["x".repeat(3000), "x".repeat(3000), "x".repeat(3000)]  // 합계 ~9002 > 8000 but < 24000
  assert.deepEqual(capJunyongBlocks(blocks, true), blocks)
})

test("filterVersionsByNameStrict(E3): 정확 제명만(공백무관), 0건 시 폴백 없이 빈 배열", () => {
  const versions = [
    { mst: "1", enforceDate: "20250101", lawName: "조세특례제한법 시행령" },
    { mst: "2", enforceDate: "20240101", lawName: "조세특례제한법" },
    { mst: "3", enforceDate: "20230101", lawName: "조세특례제한법 시행규칙" },
  ]
  assert.deepEqual(filterVersionsByNameStrict(versions, "조세특례제한법시행령").map((v) => v.mst), ["1"])
  // strict: 미일치면 빈 배열(오해소 방지)
  assert.deepEqual(filterVersionsByNameStrict(versions, "없는법"), [])
  // 대조: 기존 #G2 필터는 0건 시 원본 폴백(self-law용, cross엔 부적합)
  assert.equal(filterVersionsByName(versions, "없는법").length, 0)
})

// ── extractJoClauses: "같은 조 제N항" 표기 회수(부칙 제36127호 제11조① 패턴) ──
test('extractJoClauses: hang 필터가 "같은 조 제6항" 표기도 회수', () => {
  const addenda =
    "제11조(통합고용세액공제에 관한 적용례 등) ① 제26조의8제4항제1호 및 같은 조 제6항의 개정규정은 2025년 1월 1일 이후 개시하는 과세연도를 최초 공제연도로 하여 통합고용세액공제를 신청하는 경우부터 적용한다."
  const clauses = extractJoClauses(addenda, "제26조의8", "제6항")
  assert.equal(clauses.length, 1)
  assert.match(clauses[0].clause, /최초 공제연도/)
})

// ── joMentioned (v0.21.0#X-11): jo 부분문자열 오매칭 방지 ──
test("joMentioned(#X-11): '제2조'는 '제2조의2'를 삼키지 않고 '제2조제1항'은 매칭", () => {
  assert.equal(joMentioned("제2조의2제1항", "제2조"), false)
  assert.equal(joMentioned("제2조제1항이후개시", "제2조"), true)
  assert.equal(joMentioned("제2조", "제2조"), true)
})

test("joMentioned(#X-11): 의-포함 joKey는 정확 매칭 유지", () => {
  assert.equal(joMentioned("제26조의8제6항", "제26조의8"), true)
  assert.equal(joMentioned("제2조의2제3항", "제2조의2"), true)
  assert.equal(joMentioned("빈 텍스트", ""), false)
})

test("extractJoClauses(#X-11): '제2조'가 '제2조의2'만 언급된 조항을 오매칭하지 않음", () => {
  const onlyOf2 = "제5조(적용례) ① 제2조의2제1항의 개정규정은 2025년 1월 1일 이후 개시하는 과세연도부터 적용한다."
  const real2 = "제5조(적용례) ① 제2조제1항의 개정규정은 2025년 1월 1일 이후 개시하는 과세연도부터 적용한다."
  assert.equal(extractJoClauses(onlyOf2, "제2조").length, 0)
  assert.equal(extractJoClauses(real2, "제2조").length, 1)
  assert.equal(extractJoClauses(onlyOf2, "제2조의2").length, 1)
})

// ── targetYearApplicationNote (v0.21.0#G8): 순수 함수 단위테스트 ──
test("targetYearApplicationNote(#G8): 1.1 anchor·year-only는 순연도비교(기존 동작 회귀)", () => {
  const a = targetYearApplicationNote("과세연도개시기준", "제6항의 개정규정은 2025년 1월 1일 이후 개시하는 과세연도부터 적용한다.", 2025, "2025.1.1", 3)
  assert.match(a, /기준: 2025 이후 개시 과세연도/)
  assert.match(a, /≥ → 개정규정 적용/)
  const b = targetYearApplicationNote("과세연도개시기준", "2024년 이후 개시하는 과세연도부터 적용한다.", 2023, "", 3)
  assert.match(b, /기준: 2024 이후 개시 과세연도/)
  assert.match(b, /< → 종전규정/)
})

test("targetYearApplicationNote(#G8): 연중(7.1) anchor는 단정 대신 ⚠ 강등", () => {
  const a = targetYearApplicationNote("과세연도개시기준", "2024년 7월 1일 이후 개시하는 과세연도부터 적용한다.", 2024, "", 3)
  assert.match(a, /⚠ 연중 시행\(7\.1\) 기준/)
  assert.match(a, /과세연도 개시일과 대조 필요/)
  assert.equal(/→ 개정규정 적용/.test(a), false)
})

test("targetYearApplicationNote(#G8): 연도 미파싱 + enforceDate fallback(1.1 / 연중 / 미상)", () => {
  const clause = "개정규정은 이후 개시하는 과세연도부터 적용한다." // 연도 없음
  const jan1 = targetYearApplicationNote("과세연도개시기준", clause, 2026, "2025.1.1", 3)
  assert.match(jan1, /시행일 fallback/)
  assert.match(jan1, /2025 이후 개시 과세연도 추정/)
  const mid = targetYearApplicationNote("과세연도개시기준", clause, 2026, "2025.7.1", 3)
  assert.match(mid, /⚠ 연중 시행\(7\.1, 시행일 fallback\)/)
  const none = targetYearApplicationNote("과세연도개시기준", clause, 2026, "", 3)
  assert.match(none, /시행일 미확정.*판정 유보/)
})

test("targetYearApplicationNote(#G8): 경과조치 범위 문언은 정확일치 대신 ⚠ 강등, 순수 연도는 기존 동작", () => {
  const range = targetYearApplicationNote("경과조치(종전규정)", "2021년 이전에 투자한 경우에는 개정규정에도 불구하고 종전의 규정에 따른다.", 2020, "", 3)
  assert.match(range, /⚠ 범위 문언/)
  assert.match(range, /원문 대조 필요/)
  const exact = targetYearApplicationNote("경과조치(종전규정)", "2024년 개시 과세연도분은 개정규정에도 불구하고 종전의 규정에 따른다.", 2024, "", 3)
  assert.match(exact, /포함 → 원칙 종전규정/)
  assert.equal(/범위 문언/.test(exact), false)
})

// v0.27.0(리뷰 P1) — 제명 정확일치 0건 폴백의 '무경고' 제거.
// filterVersionsByName은 미일치 후보를 제외하며,
// 그 사실을 호출부가 사용자에게 알릴 수 있어야 한다.
test("lawNameFallbackNote: 정확일치 0건이면 경고 문자열 반환", () => {
  const rows = [{ mst: "111", lawName: "요청법 시행령", enforceDate: "20250101", promDate: "20241231" }]
  const note = lawNameFallbackNote(rows, "요청법")
  assert.ok(note, "정확일치 0건인데 경고가 없음")
  assert.match(note, /제명 정확일치 0건/)
  assert.match(note, /요청법 시행령/, "실제 검색된 제명을 보여줘야 함")
  // 미일치 후보는 제외한다.
  assert.equal(filterVersionsByName(rows, "요청법").length, 0)
})

test("lawNameFallbackNote: 정확일치가 있으면 침묵", () => {
  const rows = [
    { mst: "111", lawName: "요청법", enforceDate: "20250101", promDate: "20241231" },
    { mst: "222", lawName: "요청법 시행령", enforceDate: "20250101", promDate: "20241231" },
  ]
  assert.equal(lawNameFallbackNote(rows, "요청법"), null)
})

test("lawNameFallbackNote: 빈 목록·제명 미상은 침묵(과발동 방지)", () => {
  assert.equal(lawNameFallbackNote([], "요청법"), null)
  assert.equal(lawNameFallbackNote([{ mst: "1", lawName: "", enforceDate: "", promDate: "" }], "요청법"), null)
})

// ── v0.27.0(리뷰 P1) 열거형 준용 ────────────────────────────────────────
// 종전: 준용 앵커마다 '가장 가까운 참조' 1건만 채택 → 열거 대상이 무경고로 소실.
test("extractJunyongTargets(v0.27.0): 자기법 열거 3건 전부 추출", () => {
  assert.deepEqual(extractJunyongTargets("제10조, 제11조 및 제12조를 준용한다.", "제99조"), [
    { jo: "제10조" }, { jo: "제11조" }, { jo: "제12조" },
  ])
})

test("extractJunyongTargets(v0.27.0): 가운뎃점(ㆍ) 열거도 전부 추출", () => {
  assert.deepEqual(extractJunyongTargets("제95조ㆍ제97조를 준용한다.", "제99조"), [
    { jo: "제95조" }, { jo: "제97조" },
  ])
})

test("extractJunyongTargets(v0.27.0): 타법 열거는 각자 법령명 귀속", () => {
  const r = extractJunyongTargets("「가법」제11조, 「나법」제12조를 준용한다.", "제99조")
  assert.equal(r.length, 2)
  assert.deepEqual(r.map((t) => t.lawName), ["가법", "나법"])
})

test("extractJunyongTargets(v0.27.0): 산문이 끼면 체인 중단(과확장 방지)", () => {
  // 제10조는 별개 문장 성분 — 준용 대상 집합이 아니다.
  const r = extractJunyongTargets("제10조에 불구하고 제20조를 준용한다.", "제99조")
  assert.deepEqual(r, [{ jo: "제20조" }])
})

test("extractJunyongTargets(v0.27.0): 조-범위 준용은 대표 1건 유지(회귀)", () => {
  assert.deepEqual(extractJunyongTargets("제14조부터 제54조까지를 준용한다.", "제99조"), [
    { jo: "제54조", joRange: "제14조~제54조" },
  ])
})

test("extractJunyongTargets(v0.27.0): 상한 초과 시 마지막 대상에 capped 라벨", () => {
  const text = "「가법」제11조, 「가법」제12조, 「가법」제13조, 「가법」제14조, 「가법」제15조, 「가법」제16조, 「가법」제17조, 「가법」제18조를 준용한다."
  const r = extractJunyongTargets(text, "제99조")
  assert.equal(r.length, 6, `상한 6건 초과: ${JSON.stringify(r)}`)
  assert.equal(r[r.length - 1].capped, true, "상한 도달이 무라벨로 절단됨")
  assert.match(fmtJunyong(r[r.length - 1]), /상한 도달/)
})

test("addenda article boundary preserves parenthetical body references", () => {
  const text = "제1조(시행일) 이 법은 2026년 1월 1일부터 시행한다.\n제2조(적용례) 제76조(종전 제7항을 삭제하는 부분에 한정한다)의 개정규정은 시행 이후부터 적용한다.\n제3조(경과조치) 제80조에 관하여 종전의 규정에 따른다."
  const rows = extractJoClauses(text, "제76조")
  assert.equal(rows.length, 1)
  assert.equal(rows[0].title, "제2조(적용례)")
  assert.match(rows[0].clause, /종전 제7항/)
})

test("enforcement dates: explicit law/decree/rule only, uncertain dates stay unknown", () => {
  for (const kind of ["법", "영", "규칙"]) {
    assert.equal(extractEnforceDate(`제1조(시행일) 이 ${kind}은 2026년 1월 1일부터 시행한다.`, "20251231"), "2026.1.1")
    assert.equal(extractEnforceDate(`제1조(시행일) 이 ${kind}은 공포한 날부터 시행한다.`, "20251231"), "2025.12.31(공포일)")
  }
  for (const text of [
    "제1조(시행일) 이 법은 공포 후 6개월이 경과한 날부터 시행한다.",
    "제1조(시행일) 이 법은 2026년 1월 1일부터 시행한다. 다만, 제76조는 2027년 1월 1일부터 시행한다.",
    "제1조(시행일) 이 법은 2026년 1월 1일부터 시행한다.\n제2조(다른 시행일) 제76조는 2027년 1월 1일부터 시행한다.",
    "제2조(적용례) 제76조는 2026년부터 적용한다.",
    "제1조(시행일) 이 법은 2026년 1월 1일부터 시행하고, 제76조는 2027년 1월 1일부터 시행한다.",
  ]) assert.equal(extractEnforceDate(text, "20251231"), "")
  for (const type of ["신고시점기준", "행위시점기준", "소득·기간기준", "과세연도개시기준"]) {
    assert.match(targetYearApplicationNote(type, "이 법 시행 이후 개시하는 과세연도부터 적용한다.", 2026, "", 3), /판정 유보/)
  }
  assert.match(targetYearApplicationNote("과세연도개시기준", "2026년 1월 1일 이후 개시하는 과세연도부터 적용한다.", 2026, "", 3), /개정규정 적용/)
})

test("single-line addenda retains separate article titles", () => {
  const text = "제1조(시행일) 이 영은 공포한 날부터 시행한다. 제2조(적용례) 제76조의 개정규정은 이후부터 적용한다. 제3조(경과조치) 제80조에 관하여 종전의 규정에 따른다."
  assert.equal(extractJoClauses(text, "제76조")[0].title, "제2조(적용례)")
  assert.equal(extractJoClauses(text, "제80조")[0].title, "제3조(경과조치)")
})

test("enforcement date rejects impossible dates and malformed publication dates", () => {
  assert.equal(extractEnforceDate("제1조(시행일) 이 법은 2027년 2월 30일부터 시행한다.", "20261231"), "")
  assert.equal(extractEnforceDate("제1조(시행일) 이 법은 2028년 2월 29일부터 시행한다."), "2028.2.29")
  for (const ymd of ["20270230", "20271301", "2027011", "not-a-date"]) {
    assert.equal(extractEnforceDate("제1조(시행일) 이 법은 공포한 날부터 시행한다.", ymd), "")
  }
})

test("explicit application date is not replaced by general enforcement date", () => {
  for (const type of ["행위시점기준", "소득·기간기준", "신고시점기준"]) {
    const note = targetYearApplicationNote(type, "제76조의 개정규정은 2027년 1월 1일 이후 취득하는 분부터 적용한다.", 2026, "2026.1.1", 3)
    assert.match(note, /명시 기준시점.*원문.*유보/)
    assert.doesNotMatch(note, /이후면 개정규정|소급 적용/)
  }
})

test("dated transitional range does not exclude an earlier target year", () => {
  const note = targetYearApplicationNote("경과조치(종전규정)", "제76조의 개정규정에도 불구하고 2025년 12월 31일까지 취득한 자산에는 종전의 규정에 따른다.", 2024, "2026.1.1", 3)
  assert.match(note, /범위 문언.*원문 대조/)
  assert.doesNotMatch(note, /미포함|포함 →/)
})
