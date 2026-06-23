import { test } from "node:test"
import { strict as assert } from "node:assert"

process.env.TAXLAW_MCP_TEST_MODE = "1"

const { isAdminRuleRow, statuteArticleSuffix, buildCreditEligibilityHint } = await import("../build/index.js")
const { classifyCreditEligibility, normalizeUpjongCode6, sogiupThreshold } = await import("../build/upjong.js")

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

test("classifyCreditEligibility: 922202 중특감 교정 반영(자동차전문정비업=터 아님) — 정확도 감사 회귀가드", () => {
  // 2026-06-23 정확도 감사 후 xlsx 교정→재빌드 반영: 922202(자동차전문정비업)는 자동차정비공장(터,
  // 조특칙§22=종합·소형종합정비업만) 아님 → 중특감 비적격. 창중감 14호(개인소비용품수리=KSIC95)는 유지.
  const r = classifyCreditEligibility("922202")
  assert.equal(r.found, true)
  assert.equal(r.jungteukgam.eligible, false)        // 터 삭제 반영
  assert.ok(!r.jungteukgam.ho.includes("터"))
  assert.ok(r.chojunggam.ho.includes("14"))          // 창중감 14호 유지
})

test("sogiupThreshold: 별표3 소기업 매출한도 도출(C/E 중분류·S 대분류·leading-zero)", () => {
  // 922202 자동차전문수리(KSIC S95) → S = 15억 / 011000 작물재배(A, strip 조회) → 80억
  assert.equal(classifyCreditEligibility("922202").sogiup.eok, 15)
  assert.equal(classifyCreditEligibility("011000").sogiup.eok, 80)
  // 제조 C 중분류 분기 + E36(수도)/E(하수)/대분류
  assert.equal(sogiupThreshold({ l1Code: "C", l2Code: "26" }).eok, 120) // 전자
  assert.equal(sogiupThreshold({ l1Code: "C", l2Code: "19" }).eok, 140) // 석유정제
  assert.equal(sogiupThreshold({ l1Code: "C", l2Code: "34" }).eok, 15)  // 산업용기계수리
  assert.equal(sogiupThreshold({ l1Code: "E", l2Code: "36" }).eok, 120) // 수도업
  assert.equal(sogiupThreshold({ l1Code: "E", l2Code: "37" }).eok, 40)  // 하수폐기물
  assert.equal(sogiupThreshold({ l1Code: "G" }).bylho, "G")             // 도소매 60억
  assert.equal(sogiupThreshold({ l1Code: null }), null)
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
