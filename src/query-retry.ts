// v0.9.5 — 복합어 NOT_FOUND 자동 분해 재시도.
// v0.9.11 — 변형 규칙 확대.
//
// NTS 검색 엔진은 한국어 합성어 인덱싱이 약함:
//   "통합투자세액공제"  → NOT_FOUND (8음절 단일 토큰)
//   "영세율 외화획득"   → NOT_FOUND (두 토큰 모두 인덱스에는 있는데 AND 매칭 실패)
//   "연구·인력개발비"   → NOT_FOUND (가운뎃점 그대로 매칭 시도 실패)
//   "연구ㆍ인력개발비"  → NOT_FOUND (한글 가운뎃점 변형)
// 짧게 줄이거나, 가운뎃점·하이픈을 제거하거나, 공백을 collapse하면 회수됨.
// 사용자가 매번 키워드를 줄이는 부담을 덜기 위해 NOT_FOUND 직전에 자동으로
// 후보 키워드 1~5개를 만들어 순차 시도한다.
//
// 무한 루프 방지: 호출자가 1회만 사용. 응답에는 재시도 사실을 명시한다.

const TAX_SUFFIX_KEYWORDS = [
  // 자주 등장하는 후미 명사 (8자 이상 단일 토큰일 때 효과적)
  "세액공제",
  "필요경비",
  "비과세",
  "면세",
  "감면",
  "공제",
  "손금",
  "익금",
  "영세율",
  "원천징수",
  "양도소득",
  "사업소득",
  "기타소득",
  "근로소득",
  "퇴직소득",
  "종합소득",
  "신고",
  "특례",
  "과세표준",
  "이월결손금",
  "감가상각",
  "임대",
  "분리과세",
  "종합과세",
]

/**
 * 쿼리 토큰화 (공백·가운뎃점·구두점 분리, 중복 제거, 길이 2+ 토큰만 유지).
 */
export function splitQueryTokens(query: string): string[] {
  const lowered = String(query || "").toLowerCase()
  if (!lowered.trim()) return []
  return Array.from(
    new Set(
      lowered
        .split(/[\s·.,;:/+&()\[\]{}'"`~!?<>|•‧・ㆍ/\\-]+/u)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2),
    ),
  )
}

// 가운뎃점·하이픈·전각/반각 변형 제거. 공백은 보존(별도 변형 단계에서 collapse).
// ㆍ(U+318D Hangul Araea)는 NTS 자료에 자주 등장 — 별도 포함.
const SEPARATOR_CHARS_RE = /[·•‧・ㆍ/\\\-‐–—_+&]+/gu

/**
 * NOT_FOUND 후 재시도할 키워드 후보를 생성한다.
 * 결과는 원본과 다른 키워드만 포함하며, 변형 우선순위 → 분해 우선순위 → 최대 5개.
 *
 * 변형 우선순위 (가벼운 변형부터 — 회수 시 의도 보존 강함):
 *   (1) 가운뎃점·하이픈 제거 ("연구·인력개발비" → "연구인력개발비")
 *   (2) 공백 collapse ("영세율 외화획득" → "영세율외화획득")
 *   (3) 가운뎃점·하이픈·공백 모두 제거 (1+2 동시)
 *
 * 분해 우선순위 (의도 손실 큼 — 위 변형 실패 후 사용):
 *   (a) 다중 토큰 → 가장 긴 토큰 단독
 *   (b) 단일 토큰 6자+ → suffix 키워드 매칭 ("통합투자세액공제" → "세액공제" + "통합투자")
 *   (c) 단일 토큰 8자+ → 양끝 4자 slice
 */
export function buildRetryQueries(query: string): string[] {
  const original = String(query || "").trim()
  if (!original) return []
  const lowered = original.toLowerCase()
  const tokens = splitQueryTokens(original)
  const candidates: string[] = []

  // (1) 가운뎃점·하이픈 제거 — 공백은 유지
  const stripSep = original.replace(SEPARATOR_CHARS_RE, "")
  if (stripSep && stripSep !== original) candidates.push(stripSep)

  // (2) 공백 collapse — 가운뎃점은 유지
  const collapseSpace = original.replace(/\s+/g, "")
  if (collapseSpace && collapseSpace !== original) candidates.push(collapseSpace)

  // (3) 가운뎃점·하이픈·공백 동시 제거
  const fullCollapse = collapseSpace.replace(SEPARATOR_CHARS_RE, "")
  if (fullCollapse && fullCollapse !== original && fullCollapse !== stripSep && fullCollapse !== collapseSpace) {
    candidates.push(fullCollapse)
  }

  // (a) 다중 토큰: 가장 긴 토큰 단독
  if (tokens.length >= 2) {
    const longest = [...tokens].sort((a, b) => b.length - a.length)[0]
    if (longest && longest.length >= 2) candidates.push(longest)
  }

  // (b)(c) 단일 토큰 또는 다중 토큰의 합성어 분해
  const longTokens = tokens.filter((t) => t.length >= 6)
  for (const token of longTokens) {
    for (const suffix of TAX_SUFFIX_KEYWORDS) {
      if (token.endsWith(suffix) && token.length > suffix.length) {
        candidates.push(suffix)
        const prefix = token.slice(0, token.length - suffix.length)
        if (prefix.length >= 2) candidates.push(prefix)
      }
    }
    if (token.length >= 8) {
      candidates.push(token.slice(0, 4))
      candidates.push(token.slice(-4))
    }
  }

  // 원본과 동일 제거, 중복 제거, 변형 우선 순위 보존(stable order), 최대 5개
  const dedup: string[] = []
  for (const c of candidates) {
    const trimmed = c.trim()
    if (!trimmed || trimmed === original || trimmed.toLowerCase() === lowered) continue
    if (!dedup.includes(trimmed)) dedup.push(trimmed)
  }
  return dedup.slice(0, 5)
}

/**
 * 재시도 안내 문구 (NOT_FOUND 응답에 시도한 후보를 노출).
 */
export function describeRetryAttempt(originalQuery: string, retriedWith: string, totalHits: number): string {
  return `↻ 자동 재시도: 원본 쿼리 "${originalQuery}" 회수 0건 → 분해 키워드 "${retriedWith}"로 재시도 (회수 ${totalHits.toLocaleString()}건). 결과 일부가 원본 의도와 다를 수 있으니 본문 확인 권장.`
}
