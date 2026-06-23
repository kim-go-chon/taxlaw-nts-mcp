import { test } from "node:test"
import { strict as assert } from "node:assert"

process.env.TAXLAW_MCP_TEST_MODE = "1"

const { isAdminRuleRow, statuteArticleSuffix, buildCreditEligibilityHint } = await import("../build/index.js")
const { classifyCreditEligibility, normalizeUpjongCode6 } = await import("../build/upjong.js")

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

// v0.16.2 — statute(조세법령) 행의 조번호·조제목 노출 회귀 가드.
// 실측 케이스: "자동차정비공장 공장의 범위 조세특례제한법 시행규칙" statute 검색 결과 행이
// NM="조세특례제한법 시행규칙", TEXT_UQNM="제22조", TEXT_KRN_NM="자동차정비공장의 범위"로
// 회수됨 → 제목에 "제22조(자동차정비공장의 범위)"가 결합되어야 함(조번호 사냥 방지).

test("statuteArticleSuffix: 조세법령 행은 제N조(조제목) 반환", () => {
  assert.equal(
    statuteArticleSuffix({ LBL1_TTL: "조세법령", TEXT_UQNM: "제22조", TEXT_KRN_NM: "자동차정비공장의 범위" }),
    "제22조(자동차정비공장의 범위)",
  )
})

test("statuteArticleSuffix: <!HS> 하이라이트 마커 제거", () => {
  assert.equal(
    statuteArticleSuffix({ LBL1_NM: "법령", TEXT_UQNM: "제22조", TEXT_KRN_NM: "<!HS>자동차<!HE>정비공장의 범위" }),
    "제22조(자동차정비공장의 범위)",
  )
})

test("statuteArticleSuffix: 조제목 없으면 조번호만", () => {
  assert.equal(statuteArticleSuffix({ LBL1_TTL: "일반법령", TEXT_UQNM: "제22조" }), "제22조")
})

test("statuteArticleSuffix: 조의2 형식 허용", () => {
  assert.equal(
    statuteArticleSuffix({ LBL1_TTL: "조세법령", TEXT_UQNM: "제29조의8", TEXT_KRN_NM: "통합고용세액공제" }),
    "제29조의8(통합고용세액공제)",
  )
})

test("statuteArticleSuffix: 법령 행이 아니면 빈 문자열(해석례·판례·별표)", () => {
  assert.equal(statuteArticleSuffix({ LBL1_TTL: "질의회신", TEXT_UQNM: "제22조" }), "")
  assert.equal(statuteArticleSuffix({ LBL1_TTL: "심판청구", TEXT_KRN_NM: "쟁점" }), "")
})

test("statuteArticleSuffix: 통칙형 번호(2-1-3)는 제외", () => {
  assert.equal(statuteArticleSuffix({ LBL1_TTL: "조세법령", TEXT_UQNM: "2-1-3", TEXT_KRN_NM: "통칙" }), "")
})

test("statuteArticleSuffix: 복합·항단위 TEXT_UQNM은 제외(단일 조 토큰만)", () => {
  assert.equal(statuteArticleSuffix({ LBL1_TTL: "조세법령", TEXT_UQNM: "제22조 및 제23조", TEXT_KRN_NM: "제목" }), "")
  assert.equal(statuteArticleSuffix({ LBL1_TTL: "조세법령", TEXT_UQNM: "제22조제1항", TEXT_KRN_NM: "제목" }), "")
})

test("statuteArticleSuffix: 조번호 없으면 빈 문자열", () => {
  assert.equal(statuteArticleSuffix({ LBL1_TTL: "조세법령", TEXT_KRN_NM: "어떤 제목" }), "")
})

// v0.17.0 — 창중감(§6③)·중특감(§7①1호) 업종 적격 판정 + §6/§7 라우팅 힌트 회귀 가드.

test("normalizeUpjongCode6: 6자리 zero-pad / 비숫자 null", () => {
  assert.equal(normalizeUpjongCode6("922202"), "922202")
  assert.equal(normalizeUpjongCode6("11000"), "011000")
  assert.equal(normalizeUpjongCode6(" 940909 "), "940909")
  assert.equal(normalizeUpjongCode6("abc"), null)
  assert.equal(normalizeUpjongCode6(""), null)
})

test("classifyCreditEligibility: 922202는 연계표상 중특감 적격(터)으로 전사 — provisional", () => {
  // ★실측 부정확 케이스: 연계표가 922202(자동차전문정비업)를 중특감 '터'로 잘못 표기.
  // 플러밍은 충실 전사가 정상 — 정확도 교정은 xlsx(SSOT) 수정 후 재빌드로 반영.
  const r = classifyCreditEligibility("922202")
  assert.equal(r.found, true)
  assert.equal(r.jungteukgam.eligible, true)
  assert.ok(r.jungteukgam.ho.includes("터"))
  assert.equal(r.provisional, true)
})

test("classifyCreditEligibility: 미수록 코드는 found=false", () => {
  const r = classifyCreditEligibility("000000")
  assert.equal(r.found, false)
  assert.equal(r.chojunggam, null)
})

test("buildCreditEligibilityHint: 조특법 법률 §6/§7만 힌트, 시행령/타 조문 제외", () => {
  assert.ok(buildCreditEligibilityHint("조세특례제한법", "제6조").join("").includes("창중감"))
  assert.ok(buildCreditEligibilityHint("조세특례제한법", "제7조").join("").includes("중특감"))
  assert.deepEqual(buildCreditEligibilityHint("조세특례제한법 시행령", "제7조"), []) // 시행령 제외
  assert.deepEqual(buildCreditEligibilityHint("조세특례제한법", "제5조"), []) // 무관 조문
})
