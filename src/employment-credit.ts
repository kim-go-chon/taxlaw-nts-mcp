// 고용 세액공제 계산 엔진 — 고용증대(조특법 §29의7)·통합고용(§29의8 구법)·중소기업 사회보험료(§30의4).
// forward 공제 + 추징을 '한 출처'에서 산정(LLM 손계산·forward↔추징 모순 차단). 로컬 Python SSOT의 1:1 포팅.
//
// ⚠ 설계 원칙(design-tradeoff 리뷰 D안):
//   · 이 도구의 출력은 '저자 산식 기반 계산값'이며 1차 근거가 아니다 — 인용 전 조문·해석례 원문 확인(헤더 강제).
//   · 단가는 코드 상수(시행일 기준) — 개정 시 stale. 결과에 사용 단가·기준 시행일 동봉 + stale 경고.
//   · 신법 통합고용(2026 귀속~: 직전3년·단년공제·최소고용·A+B+C 구간식)은 NOT_SUPPORTED → build_application_timetable 라우팅.
//   · 법령 미규정/해석 미확인 구간(COVID fy+3 추징·3차 가목2·§30의4 forward)은 숫자 대신 ⚠ 수동 반환.
//
// 검증 근거(법제처 DRF 직접 회수 2026-06-15): §29의7·§29의8①②·§26의7⑤·§26의8④(이미지 판독)·§30의4·§27의4⑪⑫.

export interface EmpCreditArgs {
  credit_type?: string
  size?: string
  region?: string
  first_year?: number
  counts?: Record<string, { total: number; youth: number; youth_deemed?: number }>
  sinsung?: boolean
  si_youth?: number
  si_other?: number
}

interface RateSet {
  rate1: Record<string, number>
  rate1_special_2122_out: Record<string, number> | null
  rate2: Record<string, number>
  law: string
  youthAge: string
  rateEfYd: string // 단가 기준 시행일(stale 판정·표기용)
}

// 단가표(만원). 키 = `${size}|${region}`.
const RATES: Record<string, RateSet> = {
  고용증대: {
    rate1: { "대기업|수도권내": 400, "대기업|수도권밖": 400, "중견|수도권내": 800, "중견|수도권밖": 800, "중소|수도권내": 1100, "중소|수도권밖": 1200 },
    rate1_special_2122_out: { 대기업: 500, 중견: 900, 중소: 1300 }, // 2021·2022 수도권밖 청년 특례
    rate2: { "대기업|수도권내": 0, "대기업|수도권밖": 0, "중견|수도권내": 450, "중견|수도권밖": 450, "중소|수도권내": 700, "중소|수도권밖": 770 },
    law: "조특법 §29의7",
    youthAge: "15~29세",
    rateEfYd: "2023~2024 귀속 기준(법률 제18634호 등)",
  },
  통합고용: {
    rate1: { "대기업|수도권내": 400, "대기업|수도권밖": 400, "중견|수도권내": 800, "중견|수도권밖": 800, "중소|수도권내": 1450, "중소|수도권밖": 1550 },
    rate1_special_2122_out: null,
    rate2: { "대기업|수도권내": 0, "대기업|수도권밖": 0, "중견|수도권내": 450, "중견|수도권밖": 450, "중소|수도권내": 850, "중소|수도권밖": 950 },
    law: "조특법 §29의8(구법)",
    youthAge: "15~34세",
    rateEfYd: "2024·2025 귀속(구법) 기준",
  },
}

function rate1(ctype: string, size: string, region: string, year: number): number {
  const t = RATES[ctype]
  if (t.rate1_special_2122_out && region === "수도권밖" && (year === 2021 || year === 2022)) {
    return t.rate1_special_2122_out[size]
  }
  return t.rate1[`${size}|${region}`]
}
function rate2(ctype: string, size: string, region: string): number {
  return RATES[ctype].rate2[`${size}|${region}`]
}
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(x, hi))

class EmpCreditError extends Error {}

interface YearRow {
  year: number
  phase: number
  kind: "forward" | "recapture"
  amount: number | null
  manual?: boolean
  note: string
}
interface ComputeResult {
  params: Record<string, unknown>
  base: Record<string, number>
  years: YearRow[]
  warnings: string[]
  netByYear: Record<number, number | null>
  manualYears: number[]
}

// 추징 산식(시행령 §26의7⑤/§26의8④, 2차/3차 공통, mult=직전2년 공제횟수). [amt|null, note, manual]
function recaptureAmt(o: {
  k: number; youthCap: number; r1: number; r2: number; totalDrop: number; youthDrop: number; mult: number
}): [number | null, string, boolean] {
  const { k, youthCap, r1, r2, totalDrop, youthDrop, mult } = o
  const tag = k === 1 ? "1호" : "2호"
  if (totalDrop === 0 && youthDrop === 0) return [0, `${k + 1}차: 전체·청년(간주후) 유지 → 추징 없음`, false]
  if (totalDrop === 0) {
    // 나목: 전체 미감소·청년 감소 = 청년감소(한도 최초청년증가) × (제1호−제2호)
    const yd = Math.min(youthDrop, youthCap)
    const amt = yd * (r1 - r2) * mult
    return [amt, `${k + 1}차 [§26의…⑤/④${tag} 나목] 청년감소 ${yd}(한도 최초청년증가=${youthCap}) × (제1호 ${r1}−제2호 ${r2})${k === 2 ? ` × 횟수 ${mult}` : ""} = ${amt}만원`, false]
  }
  if (youthDrop >= totalDrop) {
    // 가목 1): [청년감소(한도 최초청년증가)−전체감소]×(제1호−제2호) + 전체감소×제1호
    const yd = Math.min(youthDrop, youthCap)
    const amt = (yd - totalDrop) * (r1 - r2) * mult + totalDrop * r1 * mult
    return [amt, `${k + 1}차 [${tag} 가목1)] [청년감소 ${yd}(한도 ${youthCap})−전체감소 ${totalDrop}]×(제1호−제2호 ${r1 - r2}) + 전체감소 ${totalDrop}×제1호 ${r1}${k === 2 ? ` (×횟수 ${mult})` : ""} = ${amt}만원`, false]
  }
  // 가목 2)
  if (k === 1) {
    const yc = Math.min(youthDrop, totalDrop)
    const nyc = totalDrop - yc
    const amt = yc * r1 + nyc * r2
    return [amt, `2차 [1호 가목2)] 청년감소 ${yc}×제1호 ${r1} + 청년외감소 ${nyc}×제2호 ${r2} = ${amt}만원`, false]
  }
  return [null, "3차 [2호 가목2) '그 밖의 경우'] = 감소인원 직전 2년 공제세액 합계 — per-head 공제이력 필요 → 수동", true]
}

function validateCounts(counts: Record<number, { total: number; youth: number; youth_deemed?: number }>): void {
  for (const [yy, c] of Object.entries(counts)) {
    if (!Number.isInteger(c.total) || !Number.isInteger(c.youth)) throw new EmpCreditError(`${yy}년 total/youth는 정수여야 함`)
    if (c.total < 0 || c.youth < 0) throw new EmpCreditError(`${yy}년 인원은 음수 불가(total=${c.total}, youth=${c.youth})`)
    if (c.youth > c.total) throw new EmpCreditError(`${yy}년 youth(${c.youth})가 total(${c.total}) 초과`)
    const yd = c.youth_deemed
    if (yd !== undefined && (!Number.isInteger(yd) || yd < 0 || yd > c.total)) throw new EmpCreditError(`${yy}년 youth_deemed 범위 오류`)
  }
}

// ── 고용증대/통합고용(§29의7·§29의8 구법) ──
function computeJobCredit(args: EmpCreditArgs): ComputeResult {
  const ctype = args.credit_type || "고용증대"
  const size = String(args.size || "")
  const region = String(args.region || "")
  const fy = Number(args.first_year)
  if (!(size in { 중소: 1, 중견: 1, 대기업: 1 })) throw new EmpCreditError("size는 중소/중견/대기업")
  if (region !== "수도권내" && region !== "수도권밖") throw new EmpCreditError("region은 수도권내/수도권밖")
  if (!Number.isInteger(fy)) throw new EmpCreditError("first_year(정수) 필요")
  const counts: Record<number, { total: number; youth: number; youth_deemed?: number }> = {}
  for (const [k, v] of Object.entries(args.counts || {})) counts[Number(k)] = v
  if (!(fy - 1 in counts) || !(fy in counts)) throw new EmpCreditError(`counts에 직전연도(${fy - 1})와 최초공제연도(${fy})가 모두 있어야 함`)
  validateCounts(counts)

  const r1 = rate1(ctype, size, region, fy)
  const r2 = rate2(ctype, size, region)
  const base = counts[fy], prev = counts[fy - 1]
  const dTotal = base.total - prev.total
  const dYouth = base.youth - prev.youth
  const n1 = clamp(dYouth, 0, dTotal)
  const n2 = dTotal - n1
  const credit1 = n1 * r1 + n2 * r2

  // COVID §29의7⑤⑥⑦ — 데이터 게이트(fy∈{2018,2019}만, 통합고용 제외)
  const covid = ctype === "고용증대" && (fy === 2018 || fy === 2019)
  const isSme = size === "중소" || size === "중견"
  const c20 = counts[2020], c21 = counts[2021]
  const applied5 = !!(covid && c20 && (c20.total < base.total || (c20.youth_deemed ?? c20.youth) < base.youth))
  const resumed6 = !!(applied5 && c21 && c21.total >= base.total && (c21.youth_deemed ?? c21.youth) >= base.youth)
  const nFwd = (isSme ? 3 : 2) + (resumed6 ? 1 : 0)
  const followups = [fy + 1, fy + 2, ...(applied5 ? [fy + 3] : [])]

  const res: ComputeResult = {
    params: { credit_type: ctype, law: RATES[ctype].law, youth_age: RATES[ctype].youthAge, size, region, first_year: fy, rate1: r1, rate2: r2, premium: r1 - r2, rate_efYd: RATES[ctype].rateEfYd, covid, covid_applied_5: applied5, covid_resumed_6: resumed6 },
    base: { dTotal, dYouth, n1, n2, credit_1cha_manwon: credit1 },
    years: [], warnings: [], netByYear: {}, manualYears: [],
  }
  if (dTotal <= 0) {
    res.warnings.push(`⚠ 최초공제연도(${fy}) 전체 증가 없음(ΔTotal=${dTotal}) → 공제 없음.`)
    return res
  }
  if (covid) {
    res.warnings.push(`⚠ COVID 특례(§29의7⑤⑥⑦, 최초공제연도 ${fy}): ⑤(2020 감소)=${applied5 ? "적용" : "미적용"} → 2020 추징 면제·사후관리 fy+3 연장 / ⑥(2021 회복→재개)=${resumed6 ? "적용" : "미적용"}(대기업 fy+2/중소·중견 fy+3). fy+3 추징은 시행령 미규정 → 수동.`)
  }

  const fwdBy: Record<number, number> = {}
  const recBy: Record<number, number> = {}
  const manual = new Set<number>()

  for (let k = 0; k < nFwd; k++) {
    const y = fy + k
    if (!(y in counts)) continue
    let fwd: number, note: string
    if (k === 0) {
      fwd = credit1
      note = `1차: 제1호 ${n1}×${r1} + 제2호 ${n2}×${r2} = ${credit1}만원`
    } else {
      const tot = counts[y].total, yth = counts[y].youth
      if (tot < base.total) { fwd = 0; note = `${k + 1}차: 전체 ${tot}<최초 ${base.total} → 제1항 전체 미적용 → 0` }
      else if (yth < base.youth) { fwd = (n1 + n2) * r2; note = `${k + 1}차: 전체 유지(청년 ${yth}<${base.youth}) → 제1호 미적용 → 전체 증가 ${n1 + n2} 전부 제2호 ${r2} = ${fwd}만원 (기재부 215)` }
      else { fwd = credit1; note = `${k + 1}차: 전체·청년 유지 → 1차와 동일 ${fwd}만원` }
    }
    fwdBy[y] = fwd
    res.years.push({ year: y, phase: k + 1, kind: "forward", amount: fwd, note })
  }

  for (const y of followups) {
    if (!(y in counts)) continue
    if (covid && y === 2020) { recBy[y] = 0; res.years.push({ year: y, phase: y - fy + 1, kind: "recapture", amount: 0, manual: false, note: "코로나 특례 §29의7⑤ 단서 — 2020년 귀속 감소분 추징 면제(② 후단 미적용)" }); continue }
    if (covid && y === fy + 3) { recBy[y] = 0; manual.add(y); res.years.push({ year: y, phase: y - fy + 1, kind: "recapture", amount: null, manual: true, note: "최초+3년차 추징: 시행령 §26의7⑤가 제1호(+1년)·제2호(+2년)만 규정 → 3년차 산식 미규정(§29의7⑤/⑦ 위임 공백) → 수동" }); continue }
    const k = Math.min(y - fy, 2)
    const tot = counts[y].total
    const ydeem = counts[y].youth_deemed ?? counts[y].youth
    const totalDrop = Math.max(0, base.total - tot)
    const youthDrop = Math.max(0, base.youth - ydeem)
    const mult = k === 2 ? [fy, fy + 1].filter((yy) => (fwdBy[yy] ?? 0) > 0).length : 1
    let [amt, note, isManual] = recaptureAmt({ k, youthCap: Math.max(0, dYouth), r1, r2, totalDrop, youthDrop, mult })
    if (!isManual) {
      let a = Math.max(0, amt as number)
      let cap: number
      if (k === 1) cap = fwdBy[fy] ?? 0
      else {
        const prior = recBy[fy + 1] ?? 0
        cap = (fwdBy[fy] ?? 0) + (fwdBy[fy + 1] ?? 0) // 직전2년 공제세액 합계(prior 차감 X)
        a = Math.max(0, a - prior) // 제1호 추징분 제외(산식값에만)
        if (prior > 0 && a > 0) res.warnings.push(`⚠ ${y}(3차): 2차 추징분 제외 적용(산식값에서 차감).`)
      }
      const capped = Math.min(a, cap)
      if (capped < a) res.warnings.push(`⚠ ${y} 추징 한도(${cap}만원) 제한(산식값 ${a}→${capped}).`)
      recBy[y] = capped
      res.years.push({ year: y, phase: y - fy + 1, kind: "recapture", amount: capped, manual: false, note })
    } else {
      recBy[y] = 0; manual.add(y)
      res.years.push({ year: y, phase: y - fy + 1, kind: "recapture", amount: null, manual: true, note })
    }
  }

  const yset = [...new Set([...Object.keys(fwdBy), ...Object.keys(recBy)].map(Number))].sort((a, b) => a - b)
  for (const y of yset) res.netByYear[y] = manual.has(y) ? null : (fwdBy[y] ?? 0) - (recBy[y] ?? 0)
  res.manualYears = [...manual].sort((a, b) => a - b)
  return res
}

// ── 중소기업 사회보험료(§30의4) — 단위: 원 ──
function computeSocialInsurance(args: EmpCreditArgs): ComputeResult {
  const fy = Number(args.first_year)
  if (!Number.isInteger(fy)) throw new EmpCreditError("first_year(정수) 필요")
  const sinsung = !!args.sinsung
  const siY = Number(args.si_youth), siO = Number(args.si_other)
  if (!Number.isFinite(siY) || !Number.isFinite(siO)) throw new EmpCreditError("si_youth/si_other(1인당 사회보험료, 원) 필요")
  if (siY < 0 || siO < 0) throw new EmpCreditError("1인당 사회보험료는 음수 불가")
  // 단위 가드: 1인당 사회보험료는 통상 수십~수백만원 → 만원급(<100,000) 입력은 '원/만원 혼동' 의심
  if ((siY > 0 && siY < 100000) || (siO > 0 && siO < 100000)) throw new EmpCreditError("si_youth/si_other는 '원' 단위(1인당 사회보험료). 만원급 입력 의심 — 원 단위로 입력하세요.")
  const counts: Record<number, { total: number; youth: number; youth_deemed?: number }> = {}
  for (const [k, v] of Object.entries(args.counts || {})) counts[Number(k)] = v
  if (!(fy - 1 in counts) || !(fy in counts)) throw new EmpCreditError(`counts에 직전연도(${fy - 1})와 최초공제연도(${fy})가 모두 있어야 함`)
  validateCounts(counts)

  const rate2v = sinsung ? 0.75 : 0.5
  const eff1 = siY * 1.0
  const eff2 = siO * rate2v
  const base = counts[fy], prev = counts[fy - 1]
  const dTotal = base.total - prev.total
  const dYouth = base.youth - prev.youth
  const n1 = clamp(dYouth, 0, dTotal)
  const n2 = dTotal - n1
  const credit1 = n1 * eff1 + n2 * eff2

  const res: ComputeResult = {
    params: { credit_type: "사회보험료", law: "조특법 §30의4", first_year: fy, sinsung, rate2: rate2v, si_youth: siY, si_other: siO, eff1, eff2 },
    base: { dTotal, dYouth, n1, n2, credit_1cha_won: credit1 },
    years: [], warnings: [], netByYear: {}, manualYears: [],
  }
  if (dTotal <= 0) { res.warnings.push(`⚠ 최초공제연도(${fy}) 전체 증가 없음(ΔTotal=${dTotal}) → 공제 없음.`); return res }

  const fwdBy: Record<number, number> = {}, recBy: Record<number, number> = {}
  for (let k = 0; k <= 1; k++) {
    const y = fy + k
    if (!(y in counts)) continue
    let fwd: number, note: string
    if (k === 0) { fwd = credit1; note = `1차: 청년 ${n1}×${eff1.toLocaleString()} + 청년외 ${n2}×${eff2.toLocaleString()} = ${credit1.toLocaleString()}원` }
    else {
      const tot = counts[y].total, yth = counts[y].youth
      if (tot < base.total) { fwd = 0; note = `2차: 전체 ${tot}<최초 ${base.total} → §30의4② 제1항 전체 미적용 → 0` }
      else if (yth < base.youth) { fwd = (n1 + n2) * eff2; note = `2차: 전체 유지(청년 ${yth}<${base.youth}) → 제1호 미적용 → 전체 증가 ${n1 + n2} 전부 제2호 ${eff2.toLocaleString()} = ${fwd.toLocaleString()}원 (기재부215 준용·§30의4 직접해석 미확인)`; res.warnings.push("⚠ 2차 '전체유지·청년감소' forward는 기재부 215(§29의7) 준용 — §30의4 직접 유권해석 미확인.") }
      else { fwd = credit1; note = `2차: 전체·청년 유지 → 1차와 동일 ${fwd.toLocaleString()}원` }
    }
    fwdBy[y] = fwd
    res.years.push({ year: y, phase: k + 1, kind: "forward", amount: fwd, note })
  }

  const y = fy + 1
  if (y in counts) {
    const tot = counts[y].total
    const ydeem = counts[y].youth_deemed ?? counts[y].youth
    const totalDrop = Math.max(0, base.total - tot)
    const youthDrop = Math.max(0, base.youth - ydeem)
    const youthCap = Math.max(0, dYouth)
    let amt: number, note: string
    if (totalDrop === 0 && youthDrop === 0) { amt = 0; note = "2차: 전체·청년(간주후) 유지 → 추징 없음" }
    else if (totalDrop === 0) { const yd = Math.min(youthDrop, youthCap); amt = yd * (eff1 - eff2); note = `2차 [§27의4⑪2호 A−B] 청년감소 ${yd}(한도 ${youthCap}) × (eff1 ${eff1.toLocaleString()}−eff2 ${eff2.toLocaleString()}) = ${amt.toLocaleString()}원` }
    else if (youthDrop >= totalDrop) {
      const cha = Math.max(0, Math.min(youthDrop, youthCap) - totalDrop) // 음수 floor
      amt = cha * (eff1 - eff2) + totalDrop * eff1
      if (Math.min(youthDrop, youthCap) < totalDrop) res.warnings.push("⚠ 가목 차감인원 음수(청년증가 한도<상시감소) → 0 floor. 나목 재성격화 여지 — 케이스별 확인.")
      note = `2차 [⑪1호 가목 A−B+C] 차감 ${cha}×(eff1−eff2) + 전체감소 ${totalDrop}×eff1 = ${amt.toLocaleString()}원`
    } else {
      const ya = Math.min(youthDrop, youthCap); const nyc = totalDrop - Math.min(youthDrop, totalDrop)
      amt = ya * eff1 + nyc * eff2
      note = `2차 [⑪1호 나목 A+B] 청년감소 ${ya}×eff1 + 청년외감소 ${nyc}×eff2 = ${amt.toLocaleString()}원`
    }
    amt = Math.max(0, amt)
    const cap = fwdBy[fy] ?? 0
    const capped = Math.min(amt, cap)
    if (capped < amt) res.warnings.push(`⚠ 추징이 한도(${cap.toLocaleString()}원=1차 공제) 제한(산식값 ${amt.toLocaleString()}→${capped.toLocaleString()}).`)
    recBy[y] = capped
    res.years.push({ year: y, phase: 2, kind: "recapture", amount: capped, manual: false, note })
  }
  const yset = [...new Set([...Object.keys(fwdBy), ...Object.keys(recBy)].map(Number))].sort((a, b) => a - b)
  for (const yy of yset) res.netByYear[yy] = (fwdBy[yy] ?? 0) - (recBy[yy] ?? 0)
  return res
}

export function computeEmploymentCreditCore(args: EmpCreditArgs): ComputeResult {
  const ctype = args.credit_type || "고용증대"
  // 신법 하드가드: 통합고용 2026 귀속~(직전3년·단년공제·A+B+C 구간식)은 별구조 → 미지원
  if (ctype === "통합고용" && Number(args.first_year) >= 2026) {
    throw new EmpCreditError("통합고용세액공제 2026 귀속~(신법: 직전3년·단년공제·최소고용증가인원·A+B+C 구간식)은 이 도구 범위 밖입니다. build_application_timetable(조특법 시행령 §26의8, 해당 귀속연도)로 적용본·산식을 확인하세요.")
  }
  if (!(ctype in { 고용증대: 1, 통합고용: 1, 사회보험료: 1 })) throw new EmpCreditError("credit_type은 고용증대/통합고용/사회보험료")
  return ctype === "사회보험료" ? computeSocialInsurance(args) : computeJobCredit(args)
}

function formatReport(res: ComputeResult): string {
  const p = res.params, b = res.base
  const won = "credit_1cha_won" in b
  const unit = won ? "원" : "만원"
  const L: string[] = []
  L.push("⚠ [저자 산식 기반 계산값 — 1차 근거 아님] 인용·신고 전 조문·해석례 원문 및 사용 단가를 확인하세요. 검증된 법령값이 아니라 산식 대입 결과입니다.")
  L.push("═".repeat(60))
  if (won) {
    L.push(`중소기업 사회보험료 세액공제(§30의4) 산정  최초공제연도 ${p.first_year}  [${p.sinsung ? "신성장75%" : "일반50%"}]`)
    L.push(`1인당 청년SI ${Number(p.si_youth).toLocaleString()} / 청년외SI ${Number(p.si_other).toLocaleString()}원 → eff1 ${Number(p.eff1).toLocaleString()} / eff2 ${Number(p.eff2).toLocaleString()}`)
  } else {
    L.push(`${p.law} 산정  [${p.credit_type}·${p.size}·${p.region}] (청년 ${p.youth_age})${p.covid ? "  ★COVID" : ""}`)
    L.push(`최초공제연도 ${p.first_year} | 제1호 ${p.rate1}만 / 제2호 ${p.rate2}만 / 프리미엄 ${p.premium}만  (단가 기준: ${p.rate_efYd} — 이후 개정 시 stale)`)
  }
  L.push("═".repeat(60))
  L.push(`[최초연도 증가] ΔTotal=${b.dTotal} ΔYouth=${b.dYouth} → 제1호인원 n1=${b.n1} 제2호인원 n2=${b.n2}`)
  L.push("")
  for (const r of res.years) {
    if (r.kind === "forward") L.push(`● ${r.year} ${r.phase}차 공제 = ${r.amount === null ? "(수동)" : `${r.amount.toLocaleString()}${unit}`}\n    ${r.note}`)
    else L.push(`  ↳ ${r.year} 추징 = ${r.manual ? "(수동)" : `${(r.amount as number).toLocaleString()}${unit}`}\n      ${r.note}`)
  }
  L.push("")
  L.push("[연도별 순효과]")
  for (const [y, net] of Object.entries(res.netByYear)) {
    L.push(net === null ? `  ${y}: (수동 — 추징액 별도 산정 필요, 순효과 미상)` : `  ${y}: ${net >= 0 ? "+" : ""}${(net as number).toLocaleString()}${unit}`)
  }
  if (res.warnings.length) { L.push(""); L.push("[경고]"); for (const w of res.warnings) L.push("  " + w) }
  L.push("═".repeat(60))
  L.push("근거: §29의7·§29의8①②·§30의4 / 시행령 §26의7⑤·§26의8④·§27의4⑪⑫(법제처 DRF). 단가·산식은 코드 상수 — 개정 추종 필요. 인용 전 get_law_article(full=true)로 현행 단가 대조.")
  return L.join("\n")
}

// MCP 도구 핸들러 — 문자열(리포트) 반환. 예외는 호출부에서 textResponse(isError)로 래핑.
export function computeEmploymentCredit(args: EmpCreditArgs): string {
  const res = computeEmploymentCreditCore(args)
  return formatReport(res)
}
