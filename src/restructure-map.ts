// v0.9.0 — 세법 구조개편 이력 사전 룩업.
// 인용 조문이 옛 위치(전부개정 전)인지 자동 검출해 현행 위치로 매핑한다.
// assess_doctrine_validity 가 본문에서 옛 §35를 발견하면 자동 격상 + 정정 안내.
//
// 데이터 소스: src/data/statute-restructures.json (검증된 매핑만 포함)
// 핵심 동작: lookupRestructure(lawName, articleRef) → 옛 위치면 현행 위치 반환

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import type { LawArticleRef } from "./citation-extract.js"

interface RestructureEntry {
  date: string
  type: string
  law_number?: string
  promulgated?: string
  note?: string
  mappings: Record<string, string>
}

interface LawRestructures {
  restructures: RestructureEntry[]
}

interface RestructureDB {
  version: string
  laws: Record<string, LawRestructures>
}

export interface RestructureHit {
  // 인용된 옛 표기 (예: "시행령.제35조제1호")
  oldRef: string
  // 매핑된 현행 표기 (예: "시행령.제42조제1호")
  newRef: string
  // 구조개편 시점
  restructureDate: string
  // 법령명 (예: "부가가치세법")
  lawName: string
  // "전부개정" / "일부개정"
  type: string
  // 사용자 안내용 노트
  note?: string
}

let cachedDB: RestructureDB | null = null

function loadDB(): RestructureDB {
  if (cachedDB) return cachedDB
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = dirname(__filename)
  const dataPath = resolve(__dirname, "data", "statute-restructures.json")
  try {
    const raw = readFileSync(dataPath, "utf-8")
    cachedDB = JSON.parse(raw) as RestructureDB
  } catch {
    // 데이터 파일이 없거나 파싱 실패 → 빈 DB (사문화 채점은 다른 신호로 계속 동작).
    cachedDB = { version: "", laws: {} }
  }
  return cachedDB
}

// 법령명에서 본법/시행령/시행규칙을 구분해 키 prefix로 변환.
//   "소득세법" → ["소득세법", "법"]
//   "소득세법 시행령" → ["소득세법", "시행령"]
//   "소득세법 시행규칙" → ["소득세법", "시행규칙"]
function splitLawName(name: string): { base: string; kind: "법" | "시행령" | "시행규칙" } | null {
  if (!name) return null
  if (name.endsWith(" 시행규칙")) return { base: name.slice(0, -" 시행규칙".length), kind: "시행규칙" }
  if (name.endsWith(" 시행령")) return { base: name.slice(0, -" 시행령".length), kind: "시행령" }
  // "소득세법시행령" 띄어쓰기 없는 표기도 허용.
  if (name.endsWith("시행규칙")) return { base: name.slice(0, -"시행규칙".length), kind: "시행규칙" }
  if (name.endsWith("시행령")) return { base: name.slice(0, -"시행령".length), kind: "시행령" }
  return { base: name, kind: "법" }
}

// "시행령.제35조제1호가목" 형태 키 생성.
// kind는 점으로 분리, 그 뒤 조·항·호·목은 점 없이 연결 (데이터 JSON 키 형식과 일치).
function buildRefKey(kind: "법" | "시행령" | "시행규칙", article: string, paragraph: string | null, item: string | null, sub: string | null = null): string {
  let ref = article
  if (paragraph) ref += paragraph
  if (item) ref += item
  if (sub) ref += sub
  return `${kind}.${ref}`.replace(/\s+/g, "")
}

/**
 * 단일 인용에 대해 옛 → 현행 매핑을 확인한다.
 * 매칭 우선순위: 가장 구체적인 키부터(조+항+호+목 → 조+항+호 → 조+항 → 조).
 * 매핑이 없으면 null (false-positive 차단).
 */
export function lookupRestructure(lawName: string, articleRef: { article: string | null; paragraph: string | null; item: string | null }): RestructureHit | null {
  if (!articleRef.article) return null
  const split = splitLawName(lawName)
  if (!split) return null
  const db = loadDB()
  const lawData = db.laws[split.base]
  if (!lawData) return null

  // 구체적인 키부터 시도.
  const candidates: string[] = [
    buildRefKey(split.kind, articleRef.article, articleRef.paragraph, articleRef.item),
    buildRefKey(split.kind, articleRef.article, articleRef.paragraph, null),
    buildRefKey(split.kind, articleRef.article, null, null),
  ]

  for (const entry of lawData.restructures) {
    for (const key of candidates) {
      const mapped = entry.mappings[key]
      if (mapped) {
        return {
          oldRef: key,
          newRef: mapped,
          restructureDate: entry.date,
          lawName: split.base,
          type: entry.type,
          note: entry.note,
        }
      }
    }
  }
  return null
}

// v0.9.2 — citation-extract의 ARTICLE_PATTERN이 80자 윈도우로 매칭하다 보니
// 본문에 "조세특례제한법 제6조"가 있고 같은 줄에 "부가가치세법"이 있으면
// "부가가치세법 + 제6조"로 잘못 페어링하는 false-positive 발생.
// substring 재확인으로 본문에 실제로 "{법령명} 제N조" 또는 "{법령명}제N조"가
// 등장하는지 검증해 노이즈 차단.
function citationAppearsInBody(lawName: string, article: string, bodyText: string): boolean {
  if (!bodyText) return true  // 본문이 없으면 검증 생략 (하위호환).
  // "부가가치세법 제6조" / "부가가치세법제6조" / "부가가치세법시행령 제35조" 등
  // 공백·NBSP 모두 허용.
  const lawNoSpace = lawName.replace(/\s+/g, "")
  const articleNoSpace = article.replace(/\s+/g, "")
  const bodyNoSpace = bodyText.replace(/\s+/g, "")
  return bodyNoSpace.includes(lawNoSpace + articleNoSpace)
}

/**
 * 추출된 인용 목록 전체를 스캔해 옛 위치 인용을 모두 찾는다.
 * 중복 제거: 같은 oldRef→newRef는 1건만.
 *
 * v0.9.2 — bodyText 파라미터가 전달되면 매핑된 인용이 본문에 실제 substring으로
 * 등장하는지 재확인. citation-extract의 80자 윈도우 노이즈 차단용.
 */
export function detectPreRestructureCitations(citations: LawArticleRef[], bodyText?: string): RestructureHit[] {
  const hits: RestructureHit[] = []
  const seen = new Set<string>()
  for (const c of citations) {
    const hit = lookupRestructure(c.lawName, { article: c.article, paragraph: c.paragraph, item: c.item })
    if (!hit) continue
    // v0.9.2 — 본문 substring 재확인 (옵션). 노이즈 매칭 차단.
    if (bodyText !== undefined && c.article && !citationAppearsInBody(c.lawName, c.article, bodyText)) {
      continue
    }
    const key = `${hit.lawName}|${hit.oldRef}→${hit.newRef}`
    if (seen.has(key)) continue
    seen.add(key)
    hits.push(hit)
  }
  return hits
}

/**
 * RestructureHit 목록을 사용자 답변용 라인으로 포맷.
 */
export function formatRestructureHits(hits: RestructureHit[]): string[] {
  if (hits.length === 0) return []
  const lines: string[] = []
  lines.push("── 구조개편 이력 자동 검출 ──")
  lines.push(`⚠ 옛 위치 인용 ${hits.length}건 감지. 본 예규는 ${hits[0].restructureDate} ${hits[0].type} 이전 조문 체계를 인용. 답변에 옮길 때 현행 조문 번호로 정정 필수.`)
  for (const h of hits) {
    lines.push(`  - ${h.lawName} ${h.oldRef} → 현행 ${h.newRef} (${h.restructureDate} ${h.type})`)
  }
  if (hits[0].note) {
    lines.push(`참고: ${hits[0].note}`)
  }
  return lines
}
