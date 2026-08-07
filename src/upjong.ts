// 업종코드(국세청) ↔ KSIC(통계청 표준산업분류) 매핑 + 분류수준 식별 유틸.
//
// 핵심 책임:
//   1) 업종코드 → KSIC 매핑을 정확히 반환 (대/중/소/세/세세 5단계 모두 노출)
//   2) 임의 분류명(법조문에 등장하는 표기)을 받아 KSIC/업종코드 5단계 중
//      어느 레벨과 일치하는지 식별. 띄어쓰기·괄호·중복 공백을 무시한 정규화 비교.
//   3) 법조문이 가리키는 분류 레벨을 자동 추론 (대분류명만 일치하면 대분류, 등)
//      → LLM이 "(수의업 제외)" 같은 단서를 정확히 해석할 수 있도록 보조.

import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export interface UpjongRecord {
  seq: number | null
  upjong: string
  up: ClassPath
  ksic: ClassPath & { code: string | null }
  note: string | null
}

export interface ClassPath {
  l1Code: string | null
  l1Name: string | null
  l2Code: string | null
  l2Name: string | null
  l3Code: string | null
  l3Name: string | null
  l4Code: string | null
  l4Name: string | null
  l5Name: string | null
  code?: string | null
}

export type ClassLevel = "l1" | "l2" | "l3" | "l4" | "l5"

export const CLASS_LEVEL_KR: Record<ClassLevel, string> = {
  l1: "대분류",
  l2: "중분류",
  l3: "소분류",
  l4: "세분류",
  l5: "세세분류",
}

interface UpjongDb {
  generatedAt: string
  source: string | null
  year: number | null
  count: number
  records: UpjongRecord[]
}

let cachedDb: UpjongDb | null = null

function dataPath(): string {
  // build/upjong.js 기준 build/data/upjong-ksic.json. tsconfig가 src/data를 build/data로 복사한다.
  const here = __dirname
  return resolve(here, "data", "upjong-ksic.json")
}

export function loadUpjongDb(): UpjongDb {
  if (cachedDb) return cachedDb
  const path = dataPath()
  if (!existsSync(path)) {
    cachedDb = { generatedAt: new Date(0).toISOString(), source: null, year: null, count: 0, records: [] }
    return cachedDb
  }
  const text = readFileSync(path, "utf8")
  const parsed = JSON.parse(text) as UpjongDb
  cachedDb = parsed
  return parsed
}

export function dbInfo(): { generatedAt: string; source: string | null; year: number | null; count: number } {
  const db = loadUpjongDb()
  return { generatedAt: db.generatedAt, source: db.source, year: db.year, count: db.count }
}

// 정규화: 띄어쓰기·괄호·중복 공백·구두점 제거, 한글/영문/숫자만 남김 + 소문자화.
// 법조문에는 "기타 전문, 과학 및 기술 서비스업", KSIC에는 "기타 전문, 과학 및 기술 서비스업"처럼
// 미세한 표기 차이가 자주 있어 정규화 없이는 비교가 불안정하다.
export function normalizeName(value: string | null | undefined): string {
  if (!value) return ""
  return String(value)
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[(){}\[\]<>,，、.·•‧·:：;；!?'"`~―\-—–_/\\]/g, "")
}

export function findByUpjong(code: string): UpjongRecord | null {
  const target = String(code || "").replace(/\s+/g, "").trim()
  if (!/^\d{4,6}$/.test(target)) return null
  const db = loadUpjongDb()
  return db.records.find((r) => r.upjong === target) || null
}

// v0.27.5(라이브 루프) — 업종코드 : KSIC 는 1:N이다(실측 79종). findByUpjong은 .find()로 첫 건만
//   돌려주고 렌더러도 그것만 표시해, 나머지 매핑이 '있다는 사실조차' 안 알려졌다.
//   예: 143107(조광권자) → KSIC 7110/7121/7122/7210/7290 5건인데 7110만 노출.
//   업종코드가 여러 KSIC 세세분류에 걸치면 §7①1호 목 판정이 갈릴 수 있어 조용한 누락은 결론을 바꾼다.
export function findAllByUpjong(code: string): UpjongRecord[] {
  const target = String(code || "").replace(/\s+/g, "").trim()
  if (!/^\d{4,6}$/.test(target)) return []
  return loadUpjongDb().records.filter((r) => r.upjong === target)
}

export function findByKsic(code: string): UpjongRecord[] {
  const target = String(code || "").replace(/\s+/g, "").trim()
  const db = loadUpjongDb()
  return db.records.filter((r) => r.ksic.code === target)
}

// KSIC 코드 prefix로 검색. prefix 길이에 따라 매칭 분류수준이 결정된다:
//   1자리(영문 대분류)는 ksic.l1Code, 2자리=중분류, 3자리=소분류, 4자리=세분류, 5자리=세세분류 코드 prefix.
// 자주 쓰는 예: "681" (부동산임대업), "4791" (통신판매업), "7421" (청소업), "612" (전기통신업).
export function findByKsicPrefix(prefix: string, limit = 200): { record: UpjongRecord; matchedLevel: ClassLevel | "l1Letter" }[] {
  const p = String(prefix || "").replace(/\s+/g, "").trim()
  if (!p) return []
  const db = loadUpjongDb()
  const out: { record: UpjongRecord; matchedLevel: ClassLevel | "l1Letter" }[] = []
  // 영문 한 글자는 l1Code (예: B, C, M)
  const isLetter = /^[A-Z]$/.test(p)
  for (const r of db.records) {
    if (isLetter) {
      if (r.ksic.l1Code === p) {
        out.push({ record: r, matchedLevel: "l1Letter" })
      }
    } else {
      const code5 = r.ksic.code || ""
      if (code5.startsWith(p)) {
        // 분류수준 추정
        const lv: ClassLevel = p.length >= 5 ? "l5" : p.length === 4 ? "l4" : p.length === 3 ? "l3" : "l2"
        out.push({ record: r, matchedLevel: lv })
      }
    }
    if (out.length >= limit) break
  }
  return out
}

export interface NameMatch {
  record: UpjongRecord
  side: "up" | "ksic"
  level: ClassLevel
  matchedName: string
}

// 분류명을 받아서 어느 레벨/사이드에 일치하는지 모두 찾는다.
// 결과는 (record, side, level) 튜플 리스트. 동일한 분류명이 여러 레벨에 등장할 수 있으므로
// 호출자가 후속 판단을 한다. levels로 검색 분류수준을 한정 가능.
export function findByName(name: string, levels: ClassLevel[] = ["l1", "l2", "l3", "l4", "l5"]): NameMatch[] {
  const norm = normalizeName(name)
  if (!norm) return []
  const db = loadUpjongDb()
  const out: NameMatch[] = []
  for (const r of db.records) {
    for (const side of ["up", "ksic"] as const) {
      const path = side === "up" ? r.up : r.ksic
      for (const lv of levels) {
        const v = (path as unknown as Record<string, string | null>)[`${lv}Name`]
        if (v && normalizeName(v) === norm) {
          out.push({ record: r, side, level: lv, matchedName: v })
        }
      }
    }
  }
  return out
}

export interface ResolvedClass {
  name: string
  candidates: Array<{
    side: "up" | "ksic"
    level: ClassLevel
    levelKr: string
    code: string | null
    sampleRecords: number
    sampleUpjongCodes: string[]
  }>
}

// 분류명 하나에 대해 후보 레벨을 요약한다. (조특법시행령 27-3 16호 "기타 전문, 과학 및 기술 서비스업"
// 같은 문구를 받았을 때 어떤 레벨인지 한눈에 보여준다.)
export function resolveClassName(name: string, levels?: ClassLevel[]): ResolvedClass {
  const matches = findByName(name, levels)
  // 키: side|level|levelCode (code는 첫 레코드의 해당 레벨 코드)
  const buckets = new Map<string, { side: "up" | "ksic"; level: ClassLevel; code: string | null; records: UpjongRecord[] }>()
  for (const m of matches) {
    const path = m.side === "up" ? m.record.up : m.record.ksic
    const code = (path as unknown as Record<string, string | null>)[`${m.level}Code`] ?? null
    const key = `${m.side}|${m.level}|${code ?? "-"}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { side: m.side, level: m.level, code, records: [] }
      buckets.set(key, bucket)
    }
    bucket.records.push(m.record)
  }
  const candidates = [...buckets.values()].map((b) => ({
    side: b.side,
    level: b.level,
    levelKr: CLASS_LEVEL_KR[b.level],
    code: b.code,
    sampleRecords: b.records.length,
    sampleUpjongCodes: b.records.slice(0, 8).map((r) => r.upjong),
  }))
  candidates.sort((a, b) => {
    const order: ClassLevel[] = ["l1", "l2", "l3", "l4", "l5"]
    const al = order.indexOf(a.level)
    const bl = order.indexOf(b.level)
    if (al !== bl) return al - bl
    if (a.side !== b.side) return a.side === "ksic" ? -1 : 1
    return 0
  })
  return { name, candidates }
}

export interface ArticleClassificationInput {
  // 법조문이 가리키는 산업명 (예: "기타 전문, 과학 및 기술 서비스업").
  industryName: string
  // 평가 대상 업종코드.
  upjongCode: string
  // 본문에서 "~~은 제외한다" 식 단서가 있으면 함께 전달.
  excludeNames?: string[]
  // 제외 단서를 검색할 분류수준 한정. 예: ["l3","l4","l5"]
  // — 음식점업에서 '주점' 차감 시 l2 '음식점 및 주점업'에 휘말리는 것을 방지.
  excludeLevels?: ClassLevel[]
}

export interface ArticleClassificationResult {
  upjong: string
  found: boolean
  upjongRecord: UpjongRecord | null
  industryResolution: ResolvedClass
  excludeResolutions: ResolvedClass[]
  matchedLevel: { side: "up" | "ksic"; level: ClassLevel; code: string | null } | null
  excluded: boolean
  excludedBy: Array<{ name: string; side: "up" | "ksic"; level: ClassLevel; code: string | null }>
  verdict: "match" | "excluded" | "out_of_scope" | "ambiguous"
  reasoning: string[]
}

// "법조문이 산업명 X를 가리키는데, 업종코드 Y가 그 산업에 해당하는가?" 판정.
// 자동 판단을 강제하지 않고 LLM이 최종 판단을 내릴 수 있도록 후보·근거를 풍부히 반환한다.
export function classifyIndustryForArticle(input: ArticleClassificationInput): ArticleClassificationResult {
  const upjong = findByUpjong(input.upjongCode)
  const industryResolution = resolveClassName(input.industryName)
  const excludeResolutions = (input.excludeNames || []).map((n) => resolveClassName(n, input.excludeLevels))
  const reasoning: string[] = []

  if (!upjong) {
    return {
      upjong: input.upjongCode,
      found: false,
      upjongRecord: null,
      industryResolution,
      excludeResolutions,
      matchedLevel: null,
      excluded: false,
      excludedBy: [],
      verdict: "out_of_scope",
      reasoning: [`업종코드 ${input.upjongCode}는 DB에서 찾을 수 없습니다.`],
    }
  }

  // 업종코드의 5단계 경로 (KSIC와 업종 양쪽 모두). 산업명 후보가 어느 레벨과 일치하면 그 레벨의 코드와 비교.
  const upjongPath = {
    up: upjong.up,
    ksic: upjong.ksic,
  }

  // 매칭 조건: 평가 업종코드의 해당 분류수준의 *분류명*이 input.industryName과 정규화 일치해야 한다.
  // (CSV에서 동일 업종측 중분류 코드가 여러 명칭으로 등장하는 경우가 있어, 단순 코드 일치로는
  // 잘못 매칭될 수 있다. 분류명을 1차 기준으로 본다.)
  let matchedLevel: ArticleClassificationResult["matchedLevel"] = null
  const targetNorm = normalizeName(input.industryName)
  const seen = new Set<string>()
  for (const c of industryResolution.candidates) {
    const side = c.side
    const lv = c.level
    const sig = `${side}|${lv}`
    if (seen.has(sig)) continue
    seen.add(sig)
    const path = upjongPath[side] as unknown as Record<string, string | null>
    const codeAtLevel = path[`${lv}Code`] ?? null
    const nameAtLevel = path[`${lv}Name`] ?? null
    if (nameAtLevel && normalizeName(nameAtLevel) === targetNorm) {
      matchedLevel = { side, level: lv, code: codeAtLevel }
      reasoning.push(
        `'${input.industryName}'은 ${side === "ksic" ? "KSIC" : "업종코드"} ${CLASS_LEVEL_KR[lv]}와 명칭이 일치하며 업종코드 ${input.upjongCode}의 ${CLASS_LEVEL_KR[lv]}(${codeAtLevel ?? "-"} ${nameAtLevel})와 일치합니다.`,
      )
      break
    }
  }

  if (!matchedLevel) {
    reasoning.push(
      `'${input.industryName}'은 업종코드 ${input.upjongCode}의 어떤 분류 레벨과도 일치하지 않습니다. 법조문 산업명이 다른 분류를 가리키거나, 본 업종코드는 적용 범위 밖일 수 있습니다.`,
    )
  }

  // 제외 단서 평가: 분류명 정규화 일치 기준.
  const excludedBy: ArticleClassificationResult["excludedBy"] = []
  for (let i = 0; i < excludeResolutions.length; i++) {
    const exName = (input.excludeNames || [])[i]
    const exNorm = normalizeName(exName)
    const exSeen = new Set<string>()
    for (const c of excludeResolutions[i].candidates) {
      const side = c.side
      const lv = c.level
      const sig = `${side}|${lv}`
      if (exSeen.has(sig)) continue
      exSeen.add(sig)
      const path = upjongPath[side] as unknown as Record<string, string | null>
      const codeAtLevel = path[`${lv}Code`] ?? null
      const nameAtLevel = path[`${lv}Name`] ?? null
      if (nameAtLevel && normalizeName(nameAtLevel) === exNorm) {
        excludedBy.push({ name: exName, side, level: lv, code: codeAtLevel })
        reasoning.push(
          `제외 단서 '${exName}'은 ${side === "ksic" ? "KSIC" : "업종코드"} ${CLASS_LEVEL_KR[lv]}(${codeAtLevel ?? "-"} ${nameAtLevel})와 일치 → 본 업종코드의 ${CLASS_LEVEL_KR[lv]}와 일치하므로 제외 대상.`,
        )
        break
      }
    }
  }

  let verdict: ArticleClassificationResult["verdict"]
  if (matchedLevel && excludedBy.length > 0) verdict = "excluded"
  else if (matchedLevel) verdict = "match"
  else if (industryResolution.candidates.length === 0) verdict = "ambiguous"
  else verdict = "out_of_scope"

  if (verdict === "ambiguous") {
    reasoning.push(
      `'${input.industryName}' 분류명을 DB에서 찾지 못했습니다. 띄어쓰기·괄호를 다르게 시도하거나 KSIC 11차 명칭과 다른 표기일 수 있습니다.`,
    )
  }

  return {
    upjong: input.upjongCode,
    found: true,
    upjongRecord: upjong,
    industryResolution,
    excludeResolutions,
    matchedLevel,
    excluded: excludedBy.length > 0,
    excludedBy,
    verdict,
    reasoning,
  }
}

export function formatClassPath(path: ClassPath, side: "up" | "ksic"): string[] {
  const out: string[] = []
  const levels: ClassLevel[] = ["l1", "l2", "l3", "l4", "l5"]
  const prefix = side === "up" ? "업종" : "KSIC"
  for (const lv of levels) {
    const code = (path as unknown as Record<string, string | null>)[`${lv}Code`] ?? null
    const name = (path as unknown as Record<string, string | null>)[`${lv}Name`] ?? null
    if (!name && !code) continue
    out.push(`  ${prefix} ${CLASS_LEVEL_KR[lv]}: ${code ?? "-"} ${name ?? ""}`.trimEnd())
  }
  if (side === "ksic" && path.code) {
    out.push(`  KSIC 코드(5자리): ${path.code}`)
  }
  return out
}

export function searchUpjongByKeyword(
  keyword: string,
  limit = 30,
  levels: ClassLevel[] = ["l1", "l2", "l3", "l4", "l5"],
): UpjongRecord[] {
  const norm = normalizeName(keyword)
  if (!norm) return []
  const db = loadUpjongDb()
  const hits: UpjongRecord[] = []
  for (const r of db.records) {
    const cells: Array<string | null | undefined> = []
    for (const side of ["up", "ksic"] as const) {
      const path = side === "up" ? r.up : r.ksic
      for (const lv of levels) {
        cells.push((path as unknown as Record<string, string | null>)[`${lv}Name`])
      }
    }
    cells.push(r.note)
    const haystack = cells.map((v) => normalizeName(v || ""))
    if (haystack.some((h) => h.includes(norm))) {
      hits.push(r)
      if (hits.length >= limit) break
    }
  }
  return hits
}

// ──────────────────────────────────────────────────────────────────────────
// 창중감(조특법 §6③)·중특감(조특법 §7①1호) 업종 적격표 (credit-eligibility.json)
// SSOT = 「창중감,중특감 판정기.xlsx [연계표]」 → build_mcp_credit_data.py 파생. provisional(미검증).
// 연계표의 §6③ 호(B열)·§7①1호 호/목(AE열)을 충실 전사한 값 — 적격 판단의 1차 신호이되,
// 단서업종(자동차정비공장=종합·소형종합정비업만 등)은 법령으로 재확인해야 한다.
// ──────────────────────────────────────────────────────────────────────────

export interface CreditCell {
  eligible: boolean
  ho: string[] // 6조3항 호 / 7조1항 호·목 (멀티 가능)
  note: string | null
}
export interface CreditRecord {
  chojunggam: CreditCell // 조특법 §6③ 창업중소기업
  jungteukgam: CreditCell // 조특법 §7①1호 중소기업특별
}
interface CreditDb {
  generatedAt: string
  source: string | null
  sourceFile?: string | null
  provisional?: boolean
  note?: string | null
  count: number
  records: Record<string, CreditRecord>
}

let cachedCreditDb: CreditDb | null = null

export function loadCreditDb(): CreditDb {
  if (cachedCreditDb) return cachedCreditDb
  const path = resolve(__dirname, "data", "credit-eligibility.json")
  if (!existsSync(path)) {
    cachedCreditDb = { generatedAt: new Date(0).toISOString(), source: null, provisional: true, count: 0, records: {} }
    return cachedCreditDb
  }
  cachedCreditDb = JSON.parse(readFileSync(path, "utf8")) as CreditDb
  return cachedCreditDb
}

// 업종코드를 적격표 키(6자리 zero-pad)로 정규화. 4~6자리 숫자만 허용.
export function normalizeUpjongCode6(code: string): string | null {
  const t = String(code || "").replace(/\s+/g, "").trim()
  if (!/^\d{4,6}$/.test(t)) return null
  return t.length < 6 ? t.padStart(6, "0") : t
}

// 중기본법 시행령 [별표3] 소기업 매출한도(억원). 분류기호=KSIC 대분류(C는 중분류 C10~C34, E는 E36/E, S는 S). <개정 2025.10.1>
const SOGIUP_BYL3_EOK: Record<string, number> = {
  C19: 140, C24: 140,
  C10: 120, C11: 120, C14: 120, C15: 120, C20: 120, C21: 120, C23: 120, C25: 120,
  C26: 120, C28: 120, C29: 120, C30: 120, C32: 120, D: 120, E36: 120,
  H: 100, K: 100,
  A: 80, B: 80, C12: 80, C13: 80, C16: 80, C17: 80, C18: 80, C22: 80, C27: 80, C31: 80, C33: 80, F: 80,
  G: 60, J: 50, E: 40, L: 40, M: 30, N: 30, R: 30,
  C34: 15, I: 15, P: 15, Q: 15, S: 15,
}

export interface SogiupThreshold {
  bylho: string // 별표3 분류기호 (예: C26, A, S, E36)
  eok: number // 매출한도(억원)
  eokwon: number // 매출한도(원)
}

// 업종 KSIC(대분류 l1·중분류 l2)로 별표3 소기업 매출한도 도출. 매출 ≤ 한도 = 소기업(조특령§6④). l2는 strip 저장 → 2자리 복원.
export function sogiupThreshold(ksic: ClassPath | null | undefined): SogiupThreshold | null {
  const dae = ksic?.l1Code || ""
  if (!dae) return null
  const jung = (ksic?.l2Code || "").padStart(2, "0")
  let bylho: string
  if (dae === "C") bylho = "C" + jung
  else if (dae === "E") bylho = jung === "36" ? "E36" : "E"
  else if (dae === "S") bylho = "S"
  else bylho = dae
  const eok = SOGIUP_BYL3_EOK[bylho] ?? SOGIUP_BYL3_EOK[dae]
  if (eok === undefined) return null
  return { bylho, eok, eokwon: eok * 100_000_000 }
}

export interface CreditLookupResult {
  upjong: string
  found: boolean
  chojunggam: CreditCell | null
  jungteukgam: CreditCell | null
  sogiup: SogiupThreshold | null // 별표3 소기업 매출한도(중특감 감면율 판정용)
  source: string | null
  provisional: boolean
  note: string | null
}

export function classifyCreditEligibility(code: string): CreditLookupResult {
  const db = loadCreditDb()
  const key = normalizeUpjongCode6(code)
  const rec = key ? db.records[key] : undefined
  // upjong-ksic는 leading-zero strip 저장 → strip형으로 조회해 KSIC 대/중분류 회수
  const ksicRec = key ? findByUpjong(key.replace(/^0+/, "") || "0") : null
  return {
    upjong: key || String(code || "").trim(),
    found: !!rec,
    chojunggam: rec ? rec.chojunggam : null,
    jungteukgam: rec ? rec.jungteukgam : null,
    sogiup: ksicRec ? sogiupThreshold(ksicRec.ksic) : null,
    source: db.source,
    provisional: db.provisional !== false,
    note: db.note || null,
  }
}
