import { test } from "node:test"
import { strict as assert } from "node:assert"

process.env.TAXLAW_MCP_TEST_MODE = "1"

const { isAdminRuleRow } = await import("../build/index.js")

// v0.9.13 — 행정규칙(훈령·예규·고시·지침) 분류 라벨 감지 회귀 가드.
// 실측 케이스: 「모범납세자 관리규정」 통합검색 시 statute 컬렉션이 "분류: 훈령 / 납보·심사",
// 별표서식 컬렉션이 "분류: 훈령서식 / 납보·심사"로 회수됨 → stale 경고 트리거 대상.

test("isAdminRuleRow: 훈령 분류 라벨 감지", () => {
  assert.equal(isAdminRuleRow({ LBL1_NM: "훈령", LBL2_NM: "납보·심사" }), true)
})

test("isAdminRuleRow: 훈령서식(별표) 감지", () => {
  assert.equal(isAdminRuleRow({ STTT_CL_NM: "훈령서식" }), true)
})

test("isAdminRuleRow: 예규·고시·지침 감지", () => {
  assert.equal(isAdminRuleRow({ LBL1_NM: "예규" }), true)
  assert.equal(isAdminRuleRow({ LBL1_NM: "고시" }), true)
  assert.equal(isAdminRuleRow({ LBL1_NM: "지침" }), true)
})

test("isAdminRuleRow: 두 번째 라벨에 있어도 감지", () => {
  assert.equal(isAdminRuleRow({ LBL1_NM: "납보·심사", LBL2_NM: "훈령" }), true)
})

test("isAdminRuleRow: '고시서면질의'(해석례 docType)는 오탐 아님", () => {
  // 앵커(^…$) 덕에 '고시'로 시작하는 해석례 라벨은 매칭되지 않아야 함
  assert.equal(isAdminRuleRow({ LBL1_NM: "고시서면질의" }), false)
})

test("isAdminRuleRow: 일반 해석례·판례 라벨은 false", () => {
  assert.equal(isAdminRuleRow({ LBL1_NM: "서면질의", LBL2_NM: "법인세" }), false)
  assert.equal(isAdminRuleRow({ LBL1_NM: "심판청구", LBL2_NM: "국세기본" }), false)
  assert.equal(isAdminRuleRow({ LBL1_NM: "사전답변", LBL2_NM: "부가가치세" }), false)
})

test("isAdminRuleRow: 라벨 없는 행은 false", () => {
  assert.equal(isAdminRuleRow({}), false)
})
