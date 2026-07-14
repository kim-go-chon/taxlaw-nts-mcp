import { test } from "node:test"
import { strict as assert } from "node:assert"

process.env.TAXLAW_MCP_TEST_MODE = "1"

const {
  resolveExecStdLaw,
  normalizeExecNo,
  parseExecTitleNo,
  matchExecNumber,
} = await import("../build/index.js")

// ── v0.24.0(F-min): 세법집행기준 순수 헬퍼 ──
test("resolveExecStdLaw: 별칭·정확·'집행기준' 접미·부분 매칭", () => {
  assert.equal(resolveExecStdLaw("조특법")?.ntstBscId, "100000000000001584")
  assert.equal(resolveExecStdLaw("조세특례제한법")?.ntstBscId, "100000000000001584")
  assert.equal(resolveExecStdLaw("법인세 집행기준")?.ntstBscId, "100000000000001563")
  assert.equal(resolveExecStdLaw("상증세")?.ntstNm, "상속증여세")
  assert.equal(resolveExecStdLaw("양도세")?.ntstBscId, "200000000000001565")
  assert.equal(resolveExecStdLaw("없는세목"), undefined)
})

test("resolveExecStdLaw: 합본 4건(개소·인지·주세·주류면허)은 ntstPlcnBkId 공유·ntstBscId 유일", () => {
  const list = ["개별소비세", "인지세", "주세", "주류면허법"].map(resolveExecStdLaw)
  assert.ok(list.every((e) => e && e.ntstPlcnBkId === "511100000000000009"))
  const ids = new Set(list.map((e) => e.ntstBscId))
  assert.equal(ids.size, 4, "ntstBscId는 4건 모두 달라야 함")
})

test("normalizeExecNo: 제/조/공백 제거, '의N' 리터럴 유지", () => {
  assert.equal(normalizeExecNo("제24조-제21조-1"), "24-21-1")
  assert.equal(normalizeExecNo("7의4-6의4-2"), "7의4-6의4-2")
  assert.equal(normalizeExecNo(" 24 - 21 - 1 "), "24-21-1")
})

test("parseExecTitleNo: 번호+제목 분리(개행·다중공백 정규화)", () => {
  assert.deepEqual(parseExecTitleNo(" 24-21-1  통합투자세액공제 개요"), { no: "24-21-1", title: "통합투자세액공제 개요" })
  assert.deepEqual(parseExecTitleNo(" 18의2-16의2-2  과세특례\n적용"), { no: "18의2-16의2-2", title: "과세특례 적용" })
  assert.deepEqual(parseExecTitleNo("번호없는 제목"), { no: "", title: "번호없는 제목" })
})

test("matchExecNumber: 정확 + 하이픈경계 prefix, 부분숫자 오매칭 방지", () => {
  assert.equal(matchExecNumber("24-21-1", "24-21-1"), true)
  assert.equal(matchExecNumber("24-21", "24-21-1"), true) // prefix(하이픈 경계)
  assert.equal(matchExecNumber("제24조-제21조-1", "24-21-1"), true)
  assert.equal(matchExecNumber("2-0-1", "20-0-1"), false) // "2"가 "20"을 삼키지 않음
  assert.equal(matchExecNumber("24-21-1", "24-21-10"), false)
  assert.equal(matchExecNumber("", "24-21-1"), false)
})
