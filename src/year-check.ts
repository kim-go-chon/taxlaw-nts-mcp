// 질의회신/해석례 본문에서 "관련규정/관련법령" 섹션을 파싱해 인용 법조문의
// 개정·시행 시점을 추출하고, 사용자가 요청한 적용 연도(targetYear)와 비교한다.
//
// 핵심 책임:
//   1) 본문에서 "관련규정", "가. 관련규정", "관련 법령", "관계 법령" 등의 헤더를 찾아
//      그 아래 인용된 법조문 텍스트를 추출.
//   2) 텍스트에서 "법률 제XXX호, YYYY.MM.DD" / "(YYYY.MM.DD 개정 전)" / "(YYYY.MM.DD 신설)"
//      등 시점 패턴을 모두 수집.
//   3) targetYear와 비교해서: 인용 법령이 (a) 시행 전, (b) 시행 중, (c) 이후 개정/폐지된
//      구법조문인지 신호로 반환.
//   4) 항상 korean-law-mcp의 search_law / get_law_text로 현행 법조문과 직접 대조하라는 가이드를 동봉.

export interface YearCheckInput {
  bodyText: string
  // 사용자가 적용하려는 연도. 예: 2024 → 해당 연도 귀속 / 거래 / 시행 시점.
  targetYear?: number
}

export interface CitedLawRef {
  rawSnippet: string
  lawNumber: string | null
  dates: string[]    // YYYY.MM.DD 모두
  earliestDate: string | null
  latestDate: string | null
  hasAmendmentClue: boolean
  amendmentClues: string[]
}

export interface YearCheckResult {
  hasRelatedSection: boolean
  relatedSectionText: string | null
  citations: CitedLawRef[]
  targetYear: number | null
  // 인용 법령의 가장 늦은 일자(latestDate) 기준 분류.
  classification: "no_citations" | "before_target" | "target_or_later" | "no_target" | "uncertain"
  warnings: string[]
  guidance: string[]
}

const RELATED_HEADER_PATTERNS = [
  /(?:^|\n)\s*(?:[가-힣]\.\s*)?관련\s*규정\s*[:：]?/,
  /(?:^|\n)\s*(?:[가-힣]\.\s*)?관련\s*법령\s*[:：]?/,
  /(?:^|\n)\s*(?:[가-힣]\.\s*)?관계\s*법령\s*[:：]?/,
  /(?:^|\n)\s*(?:[가-힣]\.\s*)?적용\s*법령\s*[:：]?/,
]

const STOP_HEADER_PATTERNS = [
  /\n\s*(?:[가-힣]\.\s*)?질의\s*[:：]?/,
  /\n\s*(?:[가-힣]\.\s*)?회신\s*[:：]?/,
  /\n\s*(?:[가-힣]\.\s*)?답변\s*[:：]?/,
  /\n\s*(?:[가-힣]\.\s*)?사실관계\s*[:：]?/,
  /\n\s*(?:[가-힣]\.\s*)?쟁점\s*[:：]?/,
  /\n\s*(?:[가-힣]\.\s*)?결정\s*(?:내용|요지)?\s*[:：]?/,
  /\n\s*\d+\.\s*[가-힣]/,
]

export function extractRelatedSection(body: string): string | null {
  if (!body) return null
  let startIdx = -1
  for (const re of RELATED_HEADER_PATTERNS) {
    const m = body.search(re)
    if (m >= 0 && (startIdx < 0 || m < startIdx)) startIdx = m
  }
  if (startIdx < 0) return null

  // 헤더 길이만큼 진행해서 본문 시작 위치 찾기
  const rest = body.slice(startIdx)
  const headerMatch = rest.match(/(?:[가-힣]\.\s*)?(?:관련\s*규정|관련\s*법령|관계\s*법령|적용\s*법령)\s*[:：]?/)
  const bodyStart = startIdx + (headerMatch ? headerMatch[0].length : 0)
  let endIdx = body.length
  for (const re of STOP_HEADER_PATTERNS) {
    const m = body.slice(bodyStart).search(re)
    if (m >= 0) {
      const abs = bodyStart + m
      if (abs < endIdx) endIdx = abs
    }
  }
  const text = body.slice(bodyStart, endIdx).trim()
  return text || null
}

const DATE_PATTERN = /(\d{4})\.\s?(\d{1,2})\.\s?(\d{1,2})\.?/g
const LAW_NUMBER_PATTERN = /법률\s*제\s*(\d{1,6})\s*호/
const AMENDMENT_CLUE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /개정\s*전/, label: "개정 전 조문 인용" },
  { re: /구\s*법|구\s*조문/, label: "구법/구조문 표기" },
  { re: /삭제\s*\)/, label: "삭제 조문" },
  { re: /폐지\s*\)/, label: "폐지 조문" },
  { re: /신설/, label: "신설" },
  { re: /일부개정/, label: "일부개정" },
  { re: /전부개정/, label: "전부개정" },
]

export function extractCitations(text: string): CitedLawRef[] {
  if (!text) return []
  // 단순 휴리스틱: 줄 단위 또는 괄호 단위로 분리 후 각 조각마다 일자/법률번호 추출.
  // 너무 짧은 토막은 합쳐서 살펴본다.
  const chunks = text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  const out: CitedLawRef[] = []
  for (const chunk of chunks) {
    const dates: string[] = []
    let match: RegExpExecArray | null
    DATE_PATTERN.lastIndex = 0
    while ((match = DATE_PATTERN.exec(chunk))) {
      const y = match[1]
      const m = match[2].padStart(2, "0")
      const d = match[3].padStart(2, "0")
      dates.push(`${y}.${m}.${d}`)
    }
    const lawNum = chunk.match(LAW_NUMBER_PATTERN)
    const clues: string[] = []
    for (const c of AMENDMENT_CLUE_PATTERNS) {
      if (c.re.test(chunk)) clues.push(c.label)
    }
    if (dates.length === 0 && !lawNum && clues.length === 0) continue
    dates.sort()
    out.push({
      rawSnippet: chunk.slice(0, 400),
      lawNumber: lawNum ? `법률 제${lawNum[1]}호` : null,
      dates,
      earliestDate: dates[0] || null,
      latestDate: dates[dates.length - 1] || null,
      hasAmendmentClue: clues.length > 0,
      amendmentClues: clues,
    })
  }
  return out
}

export function checkYearApplicability(input: YearCheckInput): YearCheckResult {
  const related = extractRelatedSection(input.bodyText)
  const warnings: string[] = []
  const guidance: string[] = [
    "이 도구는 본문 텍스트의 휴리스틱 파싱 결과입니다. 인용 법령의 정확한 시행일·개정여부·현행 적용가능성은 반드시 korean-law-mcp의 search_law + get_law_text(jo=…)로 직접 확인하세요.",
    "구법조문 기반 예규는 현행법령과 동일한 문구가 유지되었는지(=예규 효력 존속) 확인 필요. 문구·범위가 달라졌다면 예규는 사실상 사문화된 것으로 보아야 합니다.",
  ]
  if (!related) {
    warnings.push("본문에서 '관련규정/관련법령' 섹션을 찾지 못했습니다. 인용 법령의 시점을 자동 확인할 수 없습니다.")
    return {
      hasRelatedSection: false,
      relatedSectionText: null,
      citations: [],
      targetYear: input.targetYear ?? null,
      classification: "no_citations",
      warnings,
      guidance,
    }
  }
  const citations = extractCitations(related)
  if (citations.length === 0) {
    warnings.push("관련규정 섹션은 있지만 법령 시점(YYYY.MM.DD)·법률번호를 추출하지 못했습니다.")
  }

  let classification: YearCheckResult["classification"] = "uncertain"
  const year = input.targetYear
  if (!year) {
    classification = "no_target"
    guidance.unshift("targetYear가 주어지지 않아 적용연도 비교를 수행하지 않았습니다. 호출 시 targetYear=YYYY를 지정하세요.")
  } else if (citations.length === 0) {
    classification = "no_citations"
  } else {
    // 모든 인용 일자 중 가장 늦은 일자(latestDate)와 targetYear 비교.
    const allLatest = citations
      .map((c) => c.latestDate)
      .filter((d): d is string => !!d)
    if (allLatest.length === 0) {
      classification = "uncertain"
    } else {
      const maxYear = allLatest.reduce((max, d) => Math.max(max, Number(d.slice(0, 4))), 0)
      if (maxYear < year) {
        classification = "before_target"
        warnings.push(
          `인용 법령의 가장 늦은 일자(${allLatest.sort().slice(-1)[0]})가 targetYear(${year})보다 앞섭니다. 본 예규는 구법조문 기반일 가능성이 있으며 ${year}년 적용 가능여부는 추가 검증이 필요합니다.`,
        )
        guidance.unshift(
          `korean-law-mcp으로 ${year}년 시점의 동일 법조문 문구를 조회해 (1) 문구가 동일하면 예규의 결론은 유지될 가능성, (2) 문구가 달라졌으면 예규는 ${year}년에 적용되기 어려움을 명확히 사용자에게 고지하세요.`,
        )
      } else {
        classification = "target_or_later"
      }
    }

    // 개정 단서가 보이면 강한 경고.
    const anyClue = citations.some((c) => c.hasAmendmentClue)
    if (anyClue) {
      warnings.push("본문에 '개정 전', '구법', '삭제', '신설' 등 개정 단서가 포함되어 있어 인용 조문이 현행과 다를 가능성이 있습니다.")
    }
  }

  return {
    hasRelatedSection: true,
    relatedSectionText: related.length > 4000 ? related.slice(0, 4000) + " …(truncated)" : related,
    citations,
    targetYear: year ?? null,
    classification,
    warnings,
    guidance,
  }
}

export function formatYearCheck(result: YearCheckResult): string[] {
  const lines: string[] = []
  lines.push("── 관련규정 연도 적용여부 검증 ──")
  lines.push(`적용 대상 연도(targetYear): ${result.targetYear ?? "N/A"}`)
  lines.push(`관련규정 섹션 발견: ${result.hasRelatedSection ? "예" : "아니오"}`)
  lines.push(`분류: ${result.classification}`)
  if (result.relatedSectionText) {
    lines.push("관련규정 발췌:")
    lines.push(result.relatedSectionText.split("\n").map((l) => `  ${l}`).join("\n"))
  }
  if (result.citations.length > 0) {
    lines.push("인용 법령 시점:")
    for (const c of result.citations) {
      const parts = [
        c.lawNumber || "",
        c.earliestDate ? `최초일자 ${c.earliestDate}` : "",
        c.latestDate && c.latestDate !== c.earliestDate ? `최종일자 ${c.latestDate}` : "",
        c.amendmentClues.length > 0 ? `단서: ${c.amendmentClues.join(", ")}` : "",
      ].filter(Boolean).join(" / ")
      lines.push(`  - ${parts || "(시점 단서 없음)"}`)
      lines.push(`    snippet: ${c.rawSnippet.slice(0, 200)}`)
    }
  }
  if (result.warnings.length > 0) {
    lines.push("⚠️ 경고:")
    for (const w of result.warnings) lines.push(`  - ${w}`)
  }
  lines.push("가이드:")
  for (const g of result.guidance) lines.push(`  - ${g}`)
  return lines
}
