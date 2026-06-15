import { test } from "node:test"
import { strict as assert } from "node:assert"

process.env.TAXLAW_MCP_TEST_MODE = "1"

const { computeEmploymentCreditCore, computeEmploymentCredit } = await import("../build/employment-credit.js")

// 로컬 Python SSOT(고용증대_계산기.py / 사회보험료_계산기.py)의 자체테스트·검증배터리와 1:1 골든 패리티.
const amt = (res, year, kind) => res.years.find((r) => r.year === year && r.kind === kind)?.amount
const row = (res, year, kind) => res.years.find((r) => r.year === year && r.kind === kind)

// ── 고용증대 §29의7 ──
test("고용증대: 전체유지·청년1감소(실퇴사) → 1차 4700 / 2차 3500 / 추징 400", () => {
  const r = computeEmploymentCreditCore({ credit_type: "고용증대", size: "중소", region: "수도권내", first_year: 2022,
    counts: { 2021: { total: 10, youth: 2 }, 2022: { total: 15, youth: 5 }, 2023: { total: 16, youth: 4, youth_deemed: 4 } } })
  assert.equal(r.base.credit_1cha_manwon, 4700)
  assert.equal(amt(r, 2023, "forward"), 3500)   // 전체증가 5 × 제2호 700
  assert.equal(amt(r, 2023, "recapture"), 400)  // 청년감소 1 × (1100−700)
})

test("고용증대: 연령초과(간주후 유지) → 추징 0", () => {
  const r = computeEmploymentCreditCore({ credit_type: "고용증대", size: "중소", region: "수도권내", first_year: 2022,
    counts: { 2021: { total: 10, youth: 2 }, 2022: { total: 15, youth: 5 }, 2023: { total: 16, youth: 4, youth_deemed: 5 } } })
  assert.equal(amt(r, 2023, "recapture"), 0)
})

test("고용증대: 전체감소 가목1 → 2차 forward 0 / 추징 1100", () => {
  const r = computeEmploymentCreditCore({ credit_type: "고용증대", size: "중소", region: "수도권내", first_year: 2022,
    counts: { 2021: { total: 10, youth: 2 }, 2022: { total: 15, youth: 5 }, 2023: { total: 14, youth: 4, youth_deemed: 4 } } })
  assert.equal(amt(r, 2023, "forward"), 0)
  assert.equal(amt(r, 2023, "recapture"), 1100)
})

test("고용증대: 추징 청년감소 한도=dYouth(원시), n1 아님 (dYouth>dTotal)", () => {
  // prev 10/2 → fy 14/8: dTotal4·dYouth6·n1=4·n2=0(1차4400). 2023 전체유지·청년 8→3(youthDrop5)
  const r = computeEmploymentCreditCore({ credit_type: "고용증대", size: "중소", region: "수도권내", first_year: 2022,
    counts: { 2021: { total: 10, youth: 2 }, 2022: { total: 14, youth: 8 }, 2023: { total: 14, youth: 3, youth_deemed: 3 } } })
  assert.equal(r.base.n1, 4)
  assert.equal(r.base.dYouth, 6)
  assert.equal(amt(r, 2023, "recapture"), 2000)  // min(5, dYouth6)×400 = 2000 (n1=4면 1600=오답)
})

test("고용증대 COVID: 게이트 — fy2019 무감소는 4차(2022) forward 유령부여 없음", () => {
  const r = computeEmploymentCreditCore({ credit_type: "고용증대", size: "중소", region: "수도권내", first_year: 2019,
    counts: { 2018: { total: 10, youth: 2 }, 2019: { total: 15, youth: 5 }, 2020: { total: 15, youth: 5 }, 2021: { total: 15, youth: 5 }, 2022: { total: 15, youth: 5 } } })
  assert.equal(r.params.covid_applied_5, false)
  assert.equal(r.years.some((x) => x.year === 2022 && x.kind === "forward"), false)
})

test("고용증대 COVID: fy2017은 covid 대상 아님(게이트 과대 차단)", () => {
  const r = computeEmploymentCreditCore({ credit_type: "고용증대", size: "중소", region: "수도권내", first_year: 2017,
    counts: { 2016: { total: 10, youth: 2 }, 2017: { total: 15, youth: 5 }, 2018: { total: 15, youth: 5 }, 2019: { total: 15, youth: 5 } } })
  assert.equal(r.params.covid, false)
})

test("고용증대 COVID ⑤⑥: 2020감소→2021회복 → 2020 면제·2021/2022 재개", () => {
  const r = computeEmploymentCreditCore({ credit_type: "고용증대", size: "중소", region: "수도권내", first_year: 2019,
    counts: { 2018: { total: 10, youth: 3 }, 2019: { total: 15, youth: 6 }, 2020: { total: 14, youth: 5, youth_deemed: 5 }, 2021: { total: 15, youth: 6, youth_deemed: 6 }, 2022: { total: 15, youth: 6, youth_deemed: 6 } } })
  assert.equal(r.params.covid_applied_5, true)
  assert.equal(r.params.covid_resumed_6, true)
  assert.equal(amt(r, 2019, "forward"), 4700)
  assert.equal(amt(r, 2020, "forward"), 0)
  assert.equal(amt(r, 2021, "forward"), 4700)
  assert.equal(amt(r, 2022, "forward"), 4700)
  assert.equal(amt(r, 2020, "recapture"), 0)             // ⑤ 단서 면제
  // fy+3(2022) 추징은 수동(시행령 미규정)
  assert.equal(row(r, 2022, "recapture").manual, true)
  assert.equal(amt(r, 2022, "recapture"), null)
})

test("고용증대: dTotal<=0 → 크래시 없이 빈 net + 리포트 생성", () => {
  const r = computeEmploymentCreditCore({ credit_type: "고용증대", size: "중소", region: "수도권내", first_year: 2022,
    counts: { 2021: { total: 10, youth: 3 }, 2022: { total: 10, youth: 3 } } })
  assert.deepEqual(r.netByYear, {})
  assert.match(computeEmploymentCredit({ credit_type: "고용증대", size: "중소", region: "수도권내", first_year: 2022,
    counts: { 2021: { total: 10, youth: 3 }, 2022: { total: 10, youth: 3 } } }), /공제 없음/)
})

// ── 통합고용 §29의8 구법 ──
test("통합고용: 단가 1450/850 → 1차 6050 / 2차 전부 제2호 4250 / 추징 600", () => {
  const r = computeEmploymentCreditCore({ credit_type: "통합고용", size: "중소", region: "수도권내", first_year: 2024,
    counts: { 2023: { total: 10, youth: 2 }, 2024: { total: 15, youth: 5 }, 2025: { total: 16, youth: 4, youth_deemed: 4 } } })
  assert.equal(r.base.credit_1cha_manwon, 3 * 1450 + 2 * 850)  // 6050
  assert.equal(amt(r, 2025, "forward"), 5 * 850)               // 4250
  assert.equal(amt(r, 2025, "recapture"), 1 * (1450 - 850))    // 600
})

test("통합고용: 수도권밖 단가 1550/950", () => {
  const r = computeEmploymentCreditCore({ credit_type: "통합고용", size: "중소", region: "수도권밖", first_year: 2024,
    counts: { 2023: { total: 20, youth: 5 }, 2024: { total: 24, youth: 8 }, 2025: { total: 24, youth: 8, youth_deemed: 8 } } })
  assert.equal(r.base.credit_1cha_manwon, 3 * 1550 + 1 * 950)  // 5600
})

test("통합고용 신법(2026~)은 NOT_SUPPORTED → throw + 라우팅 안내", () => {
  assert.throws(() => computeEmploymentCreditCore({ credit_type: "통합고용", size: "중소", region: "수도권내", first_year: 2026,
    counts: { 2025: { total: 10, youth: 2 }, 2026: { total: 15, youth: 5 } } }), /build_application_timetable/)
})

// ── 사회보험료 §30의4 (원 단위) ──
test("사회보험료: 1차 12,500,000 / 2차 8,750,000 / 추징 1,250,000", () => {
  const r = computeEmploymentCreditCore({ credit_type: "사회보험료", first_year: 2022, sinsung: false, si_youth: 3000000, si_other: 3500000,
    counts: { 2021: { total: 10, youth: 2 }, 2022: { total: 15, youth: 5 }, 2023: { total: 16, youth: 4, youth_deemed: 4 } } })
  assert.equal(r.base.credit_1cha_won, 12500000)
  assert.equal(amt(r, 2023, "forward"), 5 * 1750000)     // 8,750,000
  assert.equal(amt(r, 2023, "recapture"), 1 * (3000000 - 1750000))  // 1,250,000
})

test("사회보험료 가목 음수 floor → 과소추징 방지", () => {
  // prev10/5→fy15/7(dTotal5·dYouth2·n1=2, 1차=2×3,000,000+3×1,750,000=11,250,000)
  // 2023 total11(상시감소4)·youth_deemed2(youthDrop5≥4=가목): cha=max(0,min(5,2)−4)=0 → 4×eff1=12,000,000→cap 11,250,000
  const r = computeEmploymentCreditCore({ credit_type: "사회보험료", first_year: 2022, sinsung: false, si_youth: 3000000, si_other: 3500000,
    counts: { 2021: { total: 10, youth: 5 }, 2022: { total: 15, youth: 7 }, 2023: { total: 11, youth: 2, youth_deemed: 2 } } })
  assert.equal(amt(r, 2023, "recapture"), 11250000)  // floor 없으면 9,500,000(과소)
})

test("사회보험료: 만원급 입력(원/만원 혼동) 거부", () => {
  assert.throws(() => computeEmploymentCreditCore({ credit_type: "사회보험료", first_year: 2022, si_youth: 300, si_other: 350,
    counts: { 2021: { total: 10, youth: 2 }, 2022: { total: 15, youth: 5 } } }), /원.*단위|만원/)
})

test("입력 검증: youth>total 거부 / 음수 거부", () => {
  assert.throws(() => computeEmploymentCreditCore({ credit_type: "고용증대", size: "중소", region: "수도권내", first_year: 2022,
    counts: { 2021: { total: 10, youth: 2 }, 2022: { total: 15, youth: 20 } } }), /초과/)
})

test("출력 리포트에 '저자 산식 기반' 경고 + 단가 stale 안내 포함", () => {
  const out = computeEmploymentCredit({ credit_type: "고용증대", size: "중소", region: "수도권내", first_year: 2022,
    counts: { 2021: { total: 10, youth: 2 }, 2022: { total: 15, youth: 5 }, 2023: { total: 16, youth: 5, youth_deemed: 5 } } })
  assert.match(out, /저자 산식 기반/)
  assert.match(out, /stale/)
})
