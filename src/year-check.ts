// 질의회신/해석례 본문에서 "관련규정/관련법령" 섹션을 파싱해 인용 법조문의
// 개정·시행 시점을 추출하고, 사용자가 요청한 적용 연도(targetYear)와 비교한다.
//
// 핵심 책임:
//   1) 본문에서 "관련규정", "가. 관련규정", "관련 법령", "관련 조세법령" 등의 헤더를 찾아
//      그 아래 인용된 법조문 텍스트를 추출.
//   2) 본문에서 헤더를 못 찾으면 문서 메타데이터의 관련법령 목록(metadataCitations)으로 fallback.
//   3) 텍스트에서 "법률 제XXX호, YYYY.MM.DD" / "(YYYY.MM.DD 개정 전)" / "(YYYY.MM.DD 신설)"
//      등 시점·개정 단서 패턴을 모두 수집.
//   4) targetYear와 비교해 8단계 분류(valid_current / before_target / partially_outdated /
//      repealed_or_superseded / target_or_later / no_citations / no_target / uncertain) 반환.
//   5) 항상 korean-law-mcp의 search_law / get_law_text로 현행 법조문과 직접 대조하라는 가이드 동봉.

export interface YearCheckInput {
  bodyText: string
  // 사용자가 적용하려는 연도. 예: 2024 → 해당 연도 귀속 / 거래 / 시행 시점.
  targetYear?: number
  // 문서 메타데이터에서 추출한 관련법령 목록(쉼표·공백 구분). 본문 섹션이 비었을 때 fallback.
  metadataCitations?: string | string[]
  // 문서 생산일자(YYYY.MM.DD). v0.9.0 — '최근 심판례 적극 라벨링' 분기에 사용.
  // 본문에 시점 단서가 없어도 생산일자가 targetYear 근처면 target_or_later_inferred로 격상.
  productionDate?: string
}

export interface CitedLawRef {
  rawSnippet: string
  lawNumber: string | null
  dates: string[]    // YYYY.MM.DD 모두
  earliestDate: string | null
  latestDate: string | null
  hasAmendmentClue: boolean
  amendmentClues: string[]
  // 단서 중 "폐지" / "전부개정" 등 법령 자체가 갈음됐을 가능성을 의미하는 강신호.
  hasSupersessionClue: boolean
}

export type YearCheckClassification =
  | "valid_current"           // 인용 시점이 targetYear 이상이고 개정 단서 없음
  | "target_or_later"         // 인용 시점이 targetYear 이상 (정상)
  | "target_or_later_inferred" // v0.9.0 — 인용은 있으나 시점 단서 없고 생산이 최근 N년 이내. 적극 라벨링.
  | "before_target"           // 인용 시점이 targetYear보다 앞섬 (구법 가능성)
  | "partially_outdated"      // before_target + 개정 단서 (부분 사문화 가능성↑)
  | "repealed_or_superseded"  // 인용 법령 폐지·전부개정 단서 감지 (전면 사문화 가능성)
  | "no_citations"            // 인용 0건 (메타·본문 모두 비어 자동검증 불가)
  | "citations_no_dates"      // v0.9.0 — 인용 ≥1건이지만 시점 단서(YYYY.MM.DD) 추출 실패. 진짜 no_citations와 분리.
  | "no_target"               // targetYear 미지정
  | "uncertain"               // 인용은 있으나 시점 추출 실패 (호환 유지 — 신규 분기에서는 사용 안 함)

export interface YearCheckResult {
  hasRelatedSection: boolean
  relatedSectionText: string | null
  // 본문에서 헤더를 못 찾고 metadataCitations로 fallback한 경우 true.
  usedMetadataFallback: boolean
  citations: CitedLawRef[]
  targetYear: number | null
  classification: YearCheckClassification
  // 분류에 따른 한 줄 사용자 친화 라벨.
  classificationLabel: string
  warnings: string[]
  guidance: string[]
}

const RELATED_HEADER_PATTERNS = [
  /(?:^|\n)\s*(?:[가-힣]\.\s*)?관련\s*규정\s*[:：]?/,
  /(?:^|\n)\s*(?:[가-힣]\.\s*)?관련\s*법령\s*[:：]?/,
  /(?:^|\n)\s*(?:[가-힣]\.\s*)?관련\s*조세\s*법령\s*(?:\([^)]*\))?\s*[:：]?/,
  /(?:^|\n)\s*(?:[가-힣]\.\s*)?관련\s*세법\s*[:：]?/,
  /(?:^|\n)\s*(?:[가-힣]\.\s*)?관계\s*법령\s*[:：]?/,
  /(?:^|\n)\s*(?:[가-힣]\.\s*)?적용\s*법령\s*[:：]?/,
  /(?:^|\n)\s*(?:[가-힣]\.\s*)?근거\s*법령\s*[:：]?/,
  /(?:^|\n)\s*(?:[가-힣]\.\s*)?참고\s*법령\s*[:：]?/,
  /(?:^|\n)\s*(?:[가-힣]\.\s*)?인용\s*법령\s*[:：]?/,
  // 헌재/판례 양식 — 대괄호로 감싸진 섹션 헤더
  /(?:^|\n)\s*\[\s*심판대상\s*조문\s*\]/,
  /(?:^|\n)\s*\[\s*심판\s*의?\s*대상\s*\]/,
  /(?:^|\n)\s*\[\s*참조\s*조문\s*\]/,
  /(?:^|\n)\s*\[\s*참조\s*법령\s*\]/,
  /(?:^|\n)\s*\[\s*적용\s*법령\s*\]/,
]

const RELATED_HEADER_INLINE = /(?:[가-힣]\.\s*)?(?:관련\s*조세\s*법령\s*(?:\([^)]*\))?|관련\s*규정|관련\s*법령|관련\s*세법|관계\s*법령|적용\s*법령|근거\s*법령|참고\s*법령|인용\s*법령)\s*[:：]?|\[\s*(?:심판대상\s*조문|심판\s*의?\s*대상|참조\s*조문|참조\s*법령|적용\s*법령)\s*\]/

const STOP_HEADER_PATTERNS = [
  /\n\s*(?:[가-힣]\.\s*)?질의\s*[:：]?/,
  /\n\s*(?:[가-힣]\.\s*)?회신\s*[:：]?/,
  /\n\s*(?:[가-힣]\.\s*)?답변\s*[:：]?/,
  /\n\s*(?:[가-힣]\.\s*)?사실관계\s*[:：]?/,
  /\n\s*(?:[가-힣]\.\s*)?쟁점\s*[:：]?/,
  /\n\s*(?:[가-힣]\.\s*)?결정\s*(?:내용|요지)?\s*[:：]?/,
  /\n\s*(?:나|다|라|마|바|사|아|자|차|카|타|파|하)\.\s*(?:관련\s*사례|관련사례|관련\s*판례|관련판례|관련\s*예규|관련예규)/,
  /\n\s*\[\s*(?:참조\s*판례|판\s*결\s*요지|결정\s*요지|이\s*유|당\s*사\s*자|주\s*문)\s*\]/,
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
  const headerMatch = rest.match(RELATED_HEADER_INLINE)
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
// v0.9.0 — 조 번호 hint. 시점·법률번호·개정단서가 없어도 "법령명 + 제N조"만 있어도
// 인용으로 간주하기 위한 신호. citations_no_dates / target_or_later_inferred 분기 활성화용.
const ARTICLE_HINT_PATTERN = /제\s?\d+\s?조/
// 약한 단서: 단순 개정/신설 등은 살아있는 조문일 수도 있음.
const AMENDMENT_CLUE_PATTERNS: Array<{ re: RegExp; label: string; supersession: boolean }> = [
  { re: /개정\s*전|개정되기\s*전/, label: "개정 전 조문 인용", supersession: false },
  { re: /(?:^|[^가-힣])구\s+[가-힣]+법(?:령|률)?|구법|구\s*조문/, label: "구법/구조문 표기", supersession: false },
  { re: /삭제\s*\)/, label: "삭제 조문", supersession: true },
  { re: /폐지\s*\)/, label: "폐지 조문", supersession: true },
  { re: /폐지된\s*[「『]?\s*[가-힣]+(?:법|규정|령)/, label: "법령 폐지 표기", supersession: true },
  { re: /\(\s*구\s*\)\s*[가-힣]+법/, label: "(구) 법령 표기 — 폐지·대체 가능성", supersession: true },
  { re: /전부\s*개정/, label: "전부개정", supersession: true },
  { re: /신설/, label: "신설", supersession: false },
  { re: /일부개정/, label: "일부개정", supersession: false },
]

export function extractCitations(text: string): CitedLawRef[] {
  if (!text) return []
  // 단순 휴리스틱: 줄 단위로 분리 후 각 조각마다 일자/법률번호/개정단서 추출.
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
    let hasSupersessionClue = false
    for (const c of AMENDMENT_CLUE_PATTERNS) {
      if (c.re.test(chunk)) {
        clues.push(c.label)
        if (c.supersession) hasSupersessionClue = true
      }
    }
    // v0.9.0 — 시점·법률번호·단서가 모두 없어도 "제N조" 조 번호 hint가 있으면 chunk 생성.
    // 이후 신규 라벨(citations_no_dates / target_or_later_inferred) 분기에서 활용.
    if (dates.length === 0 && !lawNum && clues.length === 0 && !ARTICLE_HINT_PATTERN.test(chunk)) continue
    dates.sort()
    out.push({
      rawSnippet: chunk.slice(0, 400),
      lawNumber: lawNum ? `법률 제${lawNum[1]}호` : null,
      dates,
      earliestDate: dates[0] || null,
      latestDate: dates[dates.length - 1] || null,
      hasAmendmentClue: clues.length > 0,
      amendmentClues: clues,
      hasSupersessionClue,
    })
  }
  return out
}

function normalizeMetadataInput(meta?: string | string[]): string {
  if (!meta) return ""
  if (Array.isArray(meta)) return meta.filter(Boolean).join("\n")
  return meta
}

const CLASSIFICATION_LABELS: Record<YearCheckClassification, string> = {
  valid_current: "✅ 현행 유효 추정 (인용 시점 ≥ targetYear, 개정 단서 없음)",
  target_or_later: "🟢 targetYear 이후 시점 (정상)",
  target_or_later_inferred: "✅⚠️ 최근 심판례·해석례 (시점 단서 없으나 생산 N년 이내 + 인용 추출 — 현행 적용 가능성 높음, 단 직접 대조 권장)",
  before_target: "⚠️ 구법조문 기반 (사문화 가능성 — 현행 조문 대조 필수)",
  partially_outdated: "⚠️ 부분 사문화 가능성 (구법 + 개정 단서 — 결론 일부만 유효할 수 있음)",
  repealed_or_superseded: "🔴 폐지·전부개정 단서 감지 (전면 사문화 가능성 매우 높음)",
  no_citations: "❓ 인용 0건 — 본문·메타 모두 비어 자동검증 불가",
  citations_no_dates: "❓ 인용은 있으나 시점 단서 없음 — 인용 법령명 기준으로 직접 대조 필요",
  no_target: "ℹ️ targetYear 미지정 — 시점 비교 미수행",
  uncertain: "❓ 인용은 있으나 시점 추출 실패",
}

// v0.9.0 — '최근' 문턱값. 환경변수 TAXLAW_RECENT_THRESHOLD_YEARS로 override 가능.
// 기본 3년 — targetYear=2026이면 2023.01 이후 생산이 적극 라벨링 대상.
function getRecentThresholdYears(): number {
  const env = process.env.TAXLAW_RECENT_THRESHOLD_YEARS
  if (!env) return 3
  const n = Number(env)
  return Number.isFinite(n) && n > 0 ? n : 3
}

export function checkYearApplicability(input: YearCheckInput): YearCheckResult {
  const warnings: string[] = []
  const guidance: string[] = [
    "이 도구는 본문 텍스트의 휴리스틱 파싱 결과입니다. 인용 법령의 정확한 시행일·개정여부·현행 적용가능성은 반드시 korean-law-mcp의 search_law + get_law_text(jo=…)로 직접 확인하세요.",
    "구법조문 기반 예규는 현행법령과 동일한 문구가 유지되었는지(=예규 효력 존속) 확인 필요. 문구·범위가 달라졌다면 예규는 사실상 사문화된 것으로 보아야 합니다.",
  ]

  let usedMetadataFallback = false
  let related: string | null = extractRelatedSection(input.bodyText)
  if (!related) {
    const metaText = normalizeMetadataInput(input.metadataCitations)
    if (metaText) {
      // 메타데이터 fallback: 본문에서 헤더를 못 찾았어도 문서 기본정보의 관련법령 필드를
      // 줄단위로 분리해 인용 텍스트로 간주한다. 시점·법률번호 단서가 메타에는 거의 없지만,
      // 인용 법령명 목록만으로도 현행 대조가 가능하다.
      related = metaText.split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean).join("\n")
      usedMetadataFallback = true
    }
  }

  // v0.9.1 — related 섹션이 없고 메타도 없어도 본문 자체에서 직접 ARTICLE_HINT 매칭 시도.
  // 이전엔 여기서 early return으로 no_citations 처리됐지만, self-review에서 본문에
  // "법령명 + 제N조" 형태로 인용이 있는데도 헤더가 없으면 잡지 못하는 갭 발견.
  let citations = related ? extractCitations(related) : []
  if (citations.length === 0 && input.bodyText) {
    const bodyCitations = extractCitations(input.bodyText)
    if (bodyCitations.length > 0) {
      citations = bodyCitations
    }
  }

  if (!related && citations.length === 0) {
    warnings.push("본문에서 '관련규정/관련법령' 섹션을 찾지 못했고 문서 메타데이터의 관련법령 목록도 비어 있어 인용 법령의 시점을 자동 확인할 수 없습니다.")
    return {
      hasRelatedSection: false,
      relatedSectionText: null,
      usedMetadataFallback: false,
      citations: [],
      targetYear: input.targetYear ?? null,
      classification: "no_citations",
      classificationLabel: CLASSIFICATION_LABELS.no_citations,
      warnings,
      guidance,
    }
  }

  if (citations.length === 0) {
    warnings.push(
      usedMetadataFallback
        ? "관련법령 메타데이터는 있지만 시점(YYYY.MM.DD)·법률번호 단서가 없어 자동 비교가 어렵습니다. 인용 법령명 기준으로 korean-law-mcp의 get_law_text로 직접 대조하세요."
        : "관련규정 섹션은 있지만 법령 시점(YYYY.MM.DD)·법률번호를 추출하지 못했습니다.",
    )
  }

  let classification: YearCheckClassification = "uncertain"
  const year = input.targetYear

  // v0.9.0 — 생산일자 기반 'recency' 계산. 본문 시점 추출 실패 시 적극 라벨링용.
  const productionYear = input.productionDate ? Number(input.productionDate.slice(0, 4)) || null : null
  const recentThreshold = getRecentThresholdYears()
  const isRecentProduction = productionYear && year && (year - productionYear) <= recentThreshold && (year - productionYear) >= 0

  // 본문 전체에서도 supersession 단서를 별도로 grep. citation chunk별 분리 한계로
  // 누락되는 케이스(예: 본문에는 '(구)토지초과이득세법' 표기가 있지만 같은 줄에 시점 단서가
  // 없어 추출되지 않은 경우)를 보완한다. "폐지된" 단어는 통상 법령 폐지 컨텍스트로만 등장하므로
  // 단독 매치도 강한 신호로 본다.
  const bodyHasSupersession = /전부\s*개정|폐지된|폐지\s*\)|\(\s*구\s*\)\s*[가-힣]+법/.test(input.bodyText || "")

  const anySupersession = citations.some((c) => c.hasSupersessionClue) || bodyHasSupersession
  const anyAmendmentClue = citations.some((c) => c.hasAmendmentClue)

  if (!year) {
    classification = "no_target"
    guidance.unshift("targetYear가 주어지지 않아 적용연도 비교를 수행하지 않았습니다. 호출 시 targetYear=YYYY를 지정하세요.")
  } else if (citations.length === 0) {
    if (bodyHasSupersession) {
      classification = "repealed_or_superseded"
      warnings.push("관련규정 섹션에서 인용 시점은 추출 못했으나, 본문 전체에 '전부 개정 / 폐지된 [법령] / (구) [법령]' 등 강한 사문화 단서가 감지됨. 인용 법령이 현행에서 갈음됐을 가능성 매우 높음.")
    } else {
      // v0.9.0 — fallback이 동작했어도 시점 단서까지 0건이면 진짜 no_citations로 분류.
      // 본문·메타 양쪽 fallback 모두 실패한 케이스는 동일하게 no_citations.
      classification = "no_citations"
    }
  } else {
    // 모든 인용 일자 중 가장 늦은 일자(latestDate)와 targetYear 비교.
    const allLatest = citations
      .map((c) => c.latestDate)
      .filter((d): d is string => !!d)
    if (allLatest.length === 0) {
      // v0.9.0 — 인용 chunk는 있지만 시점 추출 실패. 신규 라벨 분기:
      //   (a) 본문 supersession 단서 → repealed_or_superseded (최강 신호 유지)
      //   (b) 생산일자가 targetYear 근처 (≤ N년) → target_or_later_inferred (적극 라벨링)
      //   (c) 그 외 → citations_no_dates (이전엔 uncertain으로 묶였던 케이스)
      if (bodyHasSupersession) {
        classification = "repealed_or_superseded"
      } else if (isRecentProduction) {
        classification = "target_or_later_inferred"
        warnings.push(
          `최근 ${recentThreshold}년 이내 생산 (${input.productionDate}) + 인용 조문 ${citations.length}건 추출 → 현행 적용 가능성 높음. 단, 본문에 시점 단서(YYYY.MM.DD)가 없으므로 인용 법령의 현행 본문은 korean-law-mcp.get_law_text로 직접 대조 필수.`,
        )
      } else {
        classification = "citations_no_dates"
        warnings.push(
          `인용 조문 ${citations.length}건 추출됐으나 시점 단서(YYYY.MM.DD)가 없어 자동 시점 비교 불가. 인용 법령명을 기준으로 korean-law-mcp.get_law_text로 직접 대조 필요.`,
        )
      }
    } else {
      const maxYear = allLatest.reduce((max, d) => Math.max(max, Number(d.slice(0, 4))), 0)
      if (maxYear < year) {
        if (anySupersession) {
          classification = "repealed_or_superseded"
          warnings.push(
            `인용 법령에 '폐지/전부개정' 단서가 있고 인용 시점(${allLatest.sort().slice(-1)[0]})이 targetYear(${year})보다 앞섭니다. 이 예규는 현행법령에서 사실상 갈음됐을 가능성이 매우 높습니다.`,
          )
          guidance.unshift(
            `korean-law-mcp으로 (a) 인용 법령명의 현행 존속 여부, (b) 전부개정/폐지 이후 후속 입법을 확인하세요. 후속 법령 인용 예규를 search_taxlaw_documents(sort=date_desc)로 재검색하세요.`,
          )
        } else if (anyAmendmentClue) {
          classification = "partially_outdated"
          warnings.push(
            `인용 법령에 개정 단서('${citations.flatMap((c) => c.amendmentClues).join(", ")}')가 있고 인용 시점(${allLatest.sort().slice(-1)[0]})이 targetYear(${year})보다 앞섭니다. 결론 중 숫자·요건이 바뀐 부분은 사문화 가능성이 있고, 구조적 결론(예: 분리과세 여부)만 유지될 수 있습니다.`,
          )
          guidance.unshift(
            `korean-law-mcp으로 ${year}년 시점의 동일 법조문 문구를 끌어와 (1) 어떤 부분이 동일하고(예규 유지), (2) 어떤 부분이 달라졌는지(부분 사문화) 줄단위로 분리해 보고하세요.`,
          )
        } else {
          classification = "before_target"
          warnings.push(
            `인용 법령의 가장 늦은 일자(${allLatest.sort().slice(-1)[0]})가 targetYear(${year})보다 앞섭니다. 본 예규는 구법조문 기반일 가능성이 있으며 ${year}년 적용 가능여부는 추가 검증이 필요합니다.`,
          )
          guidance.unshift(
            `korean-law-mcp으로 ${year}년 시점의 동일 법조문 문구를 조회해 (1) 문구가 동일하면 예규의 결론은 유지될 가능성, (2) 문구가 달라졌으면 예규는 ${year}년에 적용되기 어려움을 명확히 사용자에게 고지하세요.`,
          )
        }
      } else {
        classification = anyAmendmentClue ? "target_or_later" : "valid_current"
      }
    }

    if (anyAmendmentClue && classification !== "repealed_or_superseded") {
      warnings.push("본문에 '개정 전', '구법', '삭제', '신설' 등 개정 단서가 포함되어 있어 인용 조문이 현행과 다를 가능성이 있습니다.")
    }
  }

  // v0.9.1 — related가 null이라도 본문 직접 추출로 citations를 잡은 경우 hasRelatedSection=false로 표기.
  const finalRelatedText = related ? (related.length > 4000 ? related.slice(0, 4000) + " …(truncated)" : related) : null
  return {
    hasRelatedSection: !!related,
    relatedSectionText: finalRelatedText,
    usedMetadataFallback,
    citations,
    targetYear: year ?? null,
    classification,
    classificationLabel: CLASSIFICATION_LABELS[classification],
    warnings,
    guidance,
  }
}

export function formatYearCheck(result: YearCheckResult): string[] {
  const lines: string[] = []
  lines.push("── 관련규정 연도 적용여부 검증 ──")
  lines.push(`적용 대상 연도(targetYear): ${result.targetYear ?? "N/A"}`)
  lines.push(`관련규정 섹션 발견: ${result.hasRelatedSection ? "예" : "아니오"}${result.usedMetadataFallback ? " (메타데이터 fallback)" : ""}`)
  lines.push(`분류: ${result.classification}`)
  lines.push(`판정: ${result.classificationLabel}`)
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
