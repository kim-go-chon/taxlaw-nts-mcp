// 본문(또는 관련규정 발췌) 텍스트에서 인용된 법령명·조·항·호를 추출한다.
// 출력은 assess_doctrine_validity 도구가 korean-law-mcp.get_law_text 호출 prompt를 만들 때 쓴다.
//
// 사용 예:
//   extractLawArticleRefs("「조세특례제한법」 제18조의2 제2항 ... 소득세법 제52조 제11항")
//   → [
//       { lawName: "조세특례제한법", article: "제18조의2", paragraph: "제2항", item: null, ... },
//       { lawName: "소득세법", article: "제52조", paragraph: "제11항", item: null, ... },
//     ]

export interface LawArticleRef {
  // 정규화된 법령명 (예: "조세특례제한법"). 사용자 한자/약칭은 풀어쓰기.
  lawName: string
  // 원문 그대로의 법령명 표기.
  lawNameRaw: string
  // "제N조" 또는 "제N조의M". 조 번호가 없으면 null.
  article: string | null
  // "제N항". 항이 없으면 null.
  paragraph: string | null
  // "제N호" 또는 "N호". 호가 없으면 null.
  item: string | null
  // 추출된 원본 스니펫 (디버그/검증용).
  rawSnippet: string
}

// 약칭·구표기 → 정식 법령명 매핑.
const LAW_NAME_ALIAS: Record<string, string> = {
  "조특법": "조세특례제한법",
  "조특": "조세특례제한법",
  "법인세": "법인세법",
  "소득세": "소득세법",
  "부가세": "부가가치세법",
  "부가법": "부가가치세법",
  "상증세법": "상속세 및 증여세법",
  "상증법": "상속세 및 증여세법",
  "증여세법": "상속세 및 증여세법",
  "국기법": "국세기본법",
  "국징법": "국세징수법",
  "조심법": "조세범 처벌법",
  "지방세": "지방세법",
}

const LAW_NAMES = [
  "조세특례제한법",
  "법인세법",
  "소득세법",
  "부가가치세법",
  "상속세 및 증여세법",
  "국세기본법",
  "국세징수법",
  "조세범 처벌법",
  "지방세법",
  "지방세특례제한법",
  "농어촌특별세법",
  "교육세법",
  "주세법",
  "개별소비세법",
  "교통ㆍ에너지ㆍ환경세법",
  "관세법",
  "종합부동산세법",
  "조세특례제한법 시행령",
  "조세특례제한법 시행규칙",
  "법인세법 시행령",
  "법인세법 시행규칙",
  "소득세법 시행령",
  "소득세법 시행규칙",
  "부가가치세법 시행령",
  "부가가치세법 시행규칙",
  "상속세 및 증여세법 시행령",
  "국세기본법 시행령",
]

// 약칭들도 함께 인식. 가장 긴 매칭이 우선.
const LAW_PATTERN_ENTRIES: Array<{ raw: string; canonical: string }> = [
  ...LAW_NAMES.map((n) => ({ raw: n, canonical: n })),
  ...Object.entries(LAW_NAME_ALIAS).map(([raw, canonical]) => ({ raw, canonical })),
]
LAW_PATTERN_ENTRIES.sort((a, b) => b.raw.length - a.raw.length)

const ARTICLE_PATTERN = /제\s?(\d+)\s?조(?:\s?의\s?(\d+))?/
const PARAGRAPH_PATTERN = /제\s?(\d+)\s?항/
const ITEM_PATTERN = /제\s?(\d+)\s?호/

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// "「조세특례제한법」제18조의2 제2항" 또는 "조세특례제한법 제18조의 2 제2항 제3호" 등 다양한 표기에 대응.
// 추출 알고리즘: 본문을 순회하며 LAW_PATTERN_ENTRIES의 raw 토큰을 찾고, 그 위치로부터
// 최대 80자 이내에서 조/항/호 패턴을 탐색해 묶는다.
export function extractLawArticleRefs(text: string): LawArticleRef[] {
  if (!text) return []
  const out: LawArticleRef[] = []
  const seen = new Set<string>()

  // 본문을 줄단위로 끊되, 매우 짧은 줄(< 6자)은 합쳐서 검사 (괄호 깨짐 방지).
  const lines = text.split(/\n+/).map((s) => s.trim()).filter(Boolean)

  for (const line of lines) {
    // 한 줄 안에서 이미 더 긴 법령명에 흡수된 위치는 짧은 토큰이 다시 매치하지 않도록
    // [start, end) range를 마킹한다. LAW_PATTERN_ENTRIES가 긴 것부터 정렬돼 있으므로
    // 긴 토큰 먼저 매치되어 range를 차지한다.
    const claimed: Array<[number, number]> = []
    for (const entry of LAW_PATTERN_ENTRIES) {
      const escaped = escapeRegExp(entry.raw)
      const re = new RegExp(escaped, "g")
      let m: RegExpExecArray | null
      while ((m = re.exec(line))) {
        const start = m.index
        const end = start + entry.raw.length
        const overlapped = claimed.some(([cs, ce]) => start < ce && end > cs)
        if (overlapped) continue
        claimed.push([start, end])
        const tail = line.slice(start, start + 80)
        const art = tail.match(ARTICLE_PATTERN)
        const par = tail.match(PARAGRAPH_PATTERN)
        const it = tail.match(ITEM_PATTERN)
        // 법령명만 떨어져 있고 조문 인용이 아예 없는 경우는 제외 (메타 헤더 노이즈 방지).
        if (!art && !par && !it) continue
        const article = art ? (art[2] ? `제${art[1]}조의${art[2]}` : `제${art[1]}조`) : null
        const paragraph = par ? `제${par[1]}항` : null
        const item = it ? `제${it[1]}호` : null
        const key = `${entry.canonical}|${article || ""}|${paragraph || ""}|${item || ""}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          lawName: entry.canonical,
          lawNameRaw: entry.raw,
          article,
          paragraph,
          item,
          rawSnippet: tail.slice(0, 120),
        })
      }
    }
  }

  return out
}

export function formatLawArticleRef(ref: LawArticleRef): string {
  const parts = [ref.lawName, ref.article, ref.paragraph, ref.item].filter(Boolean)
  return parts.join(" ")
}
