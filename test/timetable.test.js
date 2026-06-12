import { test } from "node:test"
import { strict as assert } from "node:assert"

process.env.TAXLAW_MCP_TEST_MODE = "1"

const {
  hangToSymbol,
  sliceHangBlock,
  parseJoSpec,
  extractAmendmentInventory,
  checkAmendmentBinding,
  extractJunyongTargets,
  extractJoClauses,
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

// ── extractJoClauses: "같은 조 제N항" 표기 회수(부칙 제36127호 제11조① 패턴) ──
test('extractJoClauses: hang 필터가 "같은 조 제6항" 표기도 회수', () => {
  const addenda =
    "제11조(통합고용세액공제에 관한 적용례 등) ① 제26조의8제4항제1호 및 같은 조 제6항의 개정규정은 2025년 1월 1일 이후 개시하는 과세연도를 최초 공제연도로 하여 통합고용세액공제를 신청하는 경우부터 적용한다."
  const clauses = extractJoClauses(addenda, "제26조의8", "제6항")
  assert.equal(clauses.length, 1)
  assert.match(clauses[0].clause, /최초 공제연도/)
})
