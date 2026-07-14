import { test } from "node:test"
import { strict as assert } from "node:assert"

process.env.TAXLAW_MCP_TEST_MODE = "1"

const { buildDelegationGuard } = await import("../build/index.js")

// ── 고시·행정규칙 위임 감지 (오늘의 실측 사고: 중기령 §3의3④) ──
test("고시 위임: '…장관이 정하여 고시한다' → 발동 + 행정규칙 경로 안내", () => {
  const body = "제1항부터 제3항까지에서 규정한 사항 외에 중소기업 여부의 판단 등에 관한 세부적인 사항은 중소벤처기업부장관이 정하여 고시한다."
  const out = buildDelegationGuard(body, "제3조의3")
  assert.ok(out.length >= 2, "가드가 발동해야 함")
  assert.match(out[0], /하위 위임 감지/)
  assert.match(out[0], /제3조의3/, "헤더에 jo가 포함되어야 함")
  assert.ok(out.some((l) => /행정규칙|search_admin_rule|get_admin_rule/.test(l)), "행정규칙 조회 경로를 안내해야 함")
})

test("고시 위임: '국세청장이 정하는 바에 따라' → 발동", () => {
  const out = buildDelegationGuard("그 계산방법은 국세청장이 정하는 바에 따라 계산한다.", "제100조")
  assert.ok(out.length >= 2)
  assert.ok(out.some((l) => /집행기준|기본통칙/.test(l)), "국세 소관 위임이면 집행기준·기본통칙 병행 안내")
})

// ── 시행규칙(부령·총리령) 위임 감지 ──
test("시행규칙 위임: '기획재정부령으로 정한다' → 발동 + 시행규칙 안내", () => {
  const out = buildDelegationGuard("필요한 사항은 기획재정부령으로 정한다.", "제25조")
  assert.ok(out.length >= 2)
  assert.ok(out.some((l) => /시행규칙/.test(l)), "시행규칙 확인을 안내해야 함")
})

test("시행규칙 위임: '총리령으로 정하는' → 발동", () => {
  const out = buildDelegationGuard("서식은 총리령으로 정하는 바에 따른다.", "제3조")
  assert.ok(out.length >= 2)
})

// ── 과발동 방지 ──
test("과발동 방지: '대통령령으로 정한다'는 발동하지 않음(에이전트가 통상 시행령으로 하강)", () => {
  const out = buildDelegationGuard("이 법에서 정하는 사항 외에 필요한 사항은 대통령령으로 정한다.", "제10조")
  assert.equal(out.length, 0)
})

test("과발동 방지: 위임 문구 없는 일반 본문은 발동하지 않음", () => {
  const out = buildDelegationGuard("중소기업 여부의 적용기간은 직전 사업연도 말일에서 3개월이 경과한 날부터 1년간으로 한다.", "제3조의3")
  assert.equal(out.length, 0)
})

test("빈 본문/누락 입력 안전", () => {
  assert.equal(buildDelegationGuard("", "제1조").length, 0)
  assert.equal(buildDelegationGuard(undefined, "제1조").length, 0)
})

// ── v0.23.0(C): 종결형·조사 확장 + 서식/실체 강등 ──
test("고시 위임(종결형): '국세청장이 정한다' → 발동", () => {
  const out = buildDelegationGuard("세부 판정기준은 국세청장이 정한다.", "제10조")
  assert.ok(out.length >= 2)
  assert.ok(out.some((l) => /행정규칙|집행기준|기본통칙/.test(l)))
})

test("시행규칙 위임(조사 '이'): '기획재정부령이 정하는' → 발동", () => {
  const out = buildDelegationGuard("그 계산방법은 기획재정부령이 정하는 바에 따른다.", "제5조")
  assert.ok(out.length >= 2)
  assert.ok(out.some((l) => /시행규칙/.test(l)))
})

test("과발동 완화: 서식(신청서)뿐인 부령 위임 → 강등(멈추지 말고 없음)", () => {
  const out = buildDelegationGuard("감면받으려는 자는 재정경제부령으로 정하는 세액감면신청서를 제출하여야 한다.", "제6조")
  assert.ok(out.length >= 2)
  assert.ok(out.some((l) => /통상 불필요/.test(l)), "서식 위임은 강등 문구여야 함")
  assert.ok(!out.some((l) => /멈추지 말고/.test(l)), "강한 경고 문구는 없어야 함")
})

test("실체 위임 유지: 계산·범위 부령 위임은 강한 경고", () => {
  const out = buildDelegationGuard("매출액 및 자산총액의 계산에 관하여 필요한 사항은 재정경제부령으로 정한다.", "제2조")
  assert.ok(out.some((l) => /멈추지 말고/.test(l)), "실체 위임은 강한 경고 유지")
})

test("혼재: 서식+실체 부령 위임이 함께면 강한 경고 유지", () => {
  const body = "재정경제부령으로 정하는 사업용자산에 대한 투자로 한다. 신청은 재정경제부령으로 정하는 세액공제신청서를 제출한다."
  const out = buildDelegationGuard(body, "제23조")
  assert.ok(out.some((l) => /멈추지 말고/.test(l)), "하나라도 실체면 강한 경고")
})

// ── v0.25.0(리뷰 O2-7): 고시 위임 종결형 보강 ──
test("O2-7 고시 위임(종결형): '…장관이 고시한다' → 발동", () => {
  assert.ok(buildDelegationGuard("적용 기간은 환경부장관이 고시한다.", "제5조").length >= 2)
})
test("O2-7 고시 위임: '고시로 정하는 바에 따라' → 발동", () => {
  assert.ok(buildDelegationGuard("그 기준은 고시로 정하는 바에 따라 적용한다.", "제5조").length >= 2)
})
test("O2-7 과발동 방지: 단순 '고시된 가격' 언급은 비발동", () => {
  assert.equal(buildDelegationGuard("고시된 분양가격을 기준으로 계산한다.", "제5조").length, 0)
})
