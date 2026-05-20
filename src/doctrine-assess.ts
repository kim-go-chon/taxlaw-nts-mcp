// 단일 예규/판례/심판례의 현행법령 적용 가능성을 종합 평가한다.
// year-check(시점 비교) + citation-extract(조문 구조) + 휴리스틱 신호를 합쳐
// 사용자(=LLM)가 답변에 그대로 붙일 수 있는 채점표와 next-action queue를 만든다.
//
// 본 모듈은 외부 MCP(korean-law-mcp)를 직접 호출하지 않는다. 대신 호출자(LLM)가 다음에
// 실행해야 할 명시적 prompts(nextActions)를 반환해 멀티-MCP 오케스트레이션을 가이드한다.

import type { YearCheckResult, YearCheckClassification } from "./year-check.js"
import type { LawArticleRef } from "./citation-extract.js"
import { detectPreRestructureCitations, formatRestructureHits, type RestructureHit } from "./restructure-map.js"

export interface DoctrineMeta {
  id: string
  title: string
  docNumber: string
  productionDate: string  // YYYY.MM.DD
  type: string             // 질의회신/심판청구/판례 등
  taxLawCode: string
  relatedLawsMeta: string  // dcmRltnStttList join
}

export type FinalValidity =
  | "valid_current"          // 별 문제 없이 적용 가능
  | "needs_current_check"    // 자동 신호상 유효해 보이나 현행 조문 대조 권장
  | "partially_outdated"     // 부분 사문화 — 일부 결론만 적용 가능
  | "likely_outdated"        // 전반적 사문화 가능성
  | "superseded_or_repealed" // 인용 법령 폐지/전부개정 — 사실상 사용 금지
  | "unverified"             // 자동 검증 실패 — 사용자 직접 판단 필요

export type NextActionPriority = "required" | "recommended" | "optional"

export interface NextAction {
  // korean-law-mcp / search_taxlaw_documents 등 다음 단계 도구.
  tool: string
  // 그 도구에 그대로 전달할 추천 인자.
  args: Record<string, unknown>
  // 호출 목적.
  purpose: string
  // 결과를 사용자 답변에 어떻게 반영할지.
  expectedUse: string
  // v0.9.5 — 실행 우선순위. LLM이 큐를 모두 실행하지 않아도 required만으로 핵심 검증 가능.
  //   required    = 핵심 검증. 답변 전 반드시 실행.
  //   recommended = 권장. 정확도 향상에 도움.
  //   optional    = 부가. 시간/맥락 여유 시.
  priority: NextActionPriority
}

export interface DoctrineAssessment {
  meta: DoctrineMeta
  targetYear: number | null
  yearCheck: {
    classification: YearCheckClassification
    classificationLabel: string
    hasRelatedSection: boolean
    usedMetadataFallback: boolean
    citationCount: number
    latestCitationDate: string | null
    earliestCitationDate: string | null
    supersessionDetected: boolean
    amendmentClueDetected: boolean
  }
  citedArticles: LawArticleRef[]
  // v0.9.0 — 구조개편 사전 룩업 결과. 옛 위치 인용이 매핑된 경우만 채워짐.
  restructureHits: RestructureHit[]
  // 사문화 위험 신호 (signalList) — 사람이 채점표로 답변에 옮기기 좋은 형식.
  signals: DoctrineSignal[]
  // 최종 판정 + 한 줄 라벨.
  finalValidity: FinalValidity
  finalLabel: string
  // 권장 후속 호출 큐 (LLM이 순서대로 실행).
  nextActions: NextAction[]
  // 답변 채점표(matrix)에 그대로 옮길 수 있는 라인들.
  scorecardLines: string[]
  warnings: string[]
}

export interface DoctrineSignal {
  kind:
    | "vintage"            // 생산일자가 오래됨
    | "vintage_recent"     // 생산일자가 비교적 최근
    | "citation_vintage"   // 인용 조문 시점이 오래됨
    | "amendment_clue"     // 본문에 개정/구법 단서
    | "supersession_clue"  // 폐지/전부개정 단서
    | "restructured_location"  // v0.9.0 — 옛 위치 인용 (전부개정으로 조 번호 이전)
    | "recent_doctrine_inferred"  // v0.9.0 — 최근 심판례·해석례 적극 라벨링
    | "no_target"          // targetYear 미지정
    | "no_citations"       // 인용 추출 실패 (진짜 0건)
    | "citations_no_dates" // v0.9.0 — 인용은 있으나 시점 단서 없음
    | "missing_metadata"   // 문서 메타데이터 비어있음
  severity: "ok" | "info" | "warn" | "high"
  message: string
}

const FINAL_LABELS: Record<FinalValidity, string> = {
  valid_current: "✅ 완전 유효 (자동 신호상)",
  needs_current_check: "🟡 자동 신호상 유효 — 현행 조문과 1:1 대조 권장",
  partially_outdated: "⚠️ 부분 사문화 가능 — 결론 중 일부만 적용",
  likely_outdated: "⚠️ 사문화 가능성 — 적용 전 현행 조문 + 후속 결정 확인 필수",
  superseded_or_repealed: "🔴 인용 법령 폐지·전부개정 — 사실상 사용 금지",
  unverified: "❓ 자동 검증 실패 — 사용자 직접 본문 확인 필요",
}

function yearsBetween(dateStr: string | null, year: number | null): number | null {
  if (!dateStr || !year) return null
  const y = Number(dateStr.slice(0, 4))
  if (!y) return null
  return year - y
}

function determineFinalValidity(
  yearCheck: YearCheckResult,
  productionYear: number | null,
  targetYear: number | null,
  restructureHits: RestructureHit[] = [],
): FinalValidity {
  // 1) 가장 강한 신호: 폐지/전부개정.
  if (yearCheck.classification === "repealed_or_superseded") return "superseded_or_repealed"

  // 1b) v0.9.0 — 구조개편 사전에 매칭되면 위치 이전 = 사실상 superseded_or_repealed로 격상.
  // 결론은 살아있을 수 있으나 답변에 옮길 때 조 번호 정정 필수이므로 강한 신호 부여.
  if (restructureHits.length > 0) return "superseded_or_repealed"

  // 2) 자동 검증 실패 — no_citations (진짜 0건) / uncertain.
  if (yearCheck.classification === "no_citations" || yearCheck.classification === "uncertain") {
    return "unverified"
  }

  // 2b) v0.9.0 — citations_no_dates: 인용은 있으나 시점 단서 없음. 보수적으로 unverified.
  if (yearCheck.classification === "citations_no_dates") return "unverified"

  // 3) targetYear 미지정 — 시점 비교 자체가 불가하므로 보수적으로 needs_current_check.
  if (yearCheck.classification === "no_target") return "needs_current_check"

  // 4) before_target / partially_outdated — 부분/전반 사문화.
  if (yearCheck.classification === "partially_outdated") return "partially_outdated"
  if (yearCheck.classification === "before_target") {
    // v0.9.1 — 최근 심판례·해석례(생산 3년 이내)는 인용 법령 시점이 형식상 과거 일자라도
    // 본문 자체가 최근 시점에서 작성된 것이므로 partially_outdated 격상 회피.
    // 예: 조심-2026-서-0581 (2026.04.08)이 조특법 "(2021.12.28. 개정된 것)"을 인용한 경우.
    // 시점 비교만으로 사문화 처리하면 false-positive 발생.
    if (productionYear && targetYear && targetYear - productionYear <= 3) {
      return "needs_current_check"
    }
    // 생산일자가 매우 오래된 경우(>15년)는 likely_outdated.
    if (productionYear && targetYear && targetYear - productionYear > 15) return "likely_outdated"
    return "partially_outdated"
  }

  // 5) target_or_later — 인용 시점은 targetYear 이상이지만 개정 단서가 있는 경우.
  // year-check.ts는 target_or_later를 amendment clue가 있을 때만 사용하므로,
  // 통상 현행 조문 대조가 필요하다고 본다.
  if (yearCheck.classification === "target_or_later") return "needs_current_check"

  // 5b) v0.9.0 — target_or_later_inferred: 최근 심판례·해석례 적극 라벨링.
  // 사문화 의심 신호가 아니므로 needs_current_check로 분류 (적극 ✅ + ⚠ 동시).
  if (yearCheck.classification === "target_or_later_inferred") return "needs_current_check"

  // 6) valid_current — 인용 시점이 target 이상 + 개정 단서 없음.
  if (yearCheck.classification === "valid_current") {
    if (productionYear && targetYear && targetYear - productionYear > 10) return "needs_current_check"
    return "valid_current"
  }

  return "needs_current_check"
}

function buildSignals(
  yearCheck: YearCheckResult,
  meta: DoctrineMeta,
  productionYear: number | null,
  targetYear: number | null,
  citedArticles: LawArticleRef[],
  restructureHits: RestructureHit[] = [],
): DoctrineSignal[] {
  const signals: DoctrineSignal[] = []

  // Vintage.
  if (productionYear && targetYear) {
    const gap = targetYear - productionYear
    if (gap > 15) {
      signals.push({
        kind: "vintage",
        severity: "high",
        message: `생산일자 ${meta.productionDate} — targetYear(${targetYear})와 ${gap}년 차이. 그 사이 다수 세법 개정이 있었을 가능성 매우 높음.`,
      })
    } else if (gap > 10) {
      signals.push({
        kind: "vintage",
        severity: "warn",
        message: `생산일자 ${meta.productionDate} — targetYear(${targetYear})와 ${gap}년 차이. 중간 개정 여부 점검 필요.`,
      })
    } else if (gap >= 5) {
      signals.push({
        kind: "vintage",
        severity: "info",
        message: `생산일자 ${meta.productionDate} — targetYear(${targetYear})와 ${gap}년 차이. 통상 점검 권장.`,
      })
    } else {
      signals.push({
        kind: "vintage_recent",
        severity: "ok",
        message: `생산일자 ${meta.productionDate} — 비교적 최근 (${gap}년차).`,
      })
    }
  }

  // Citation vintage.
  if (yearCheck.citations.length > 0) {
    const latest = yearCheck.citations
      .map((c) => c.latestDate)
      .filter((d): d is string => !!d)
      .sort()
      .slice(-1)[0]
    if (latest && targetYear) {
      const gap = targetYear - Number(latest.slice(0, 4))
      if (gap > 10) {
        signals.push({
          kind: "citation_vintage",
          severity: "warn",
          message: `인용 법령의 최신 시점 ${latest} — targetYear(${targetYear})와 ${gap}년 차이. 구법 가능성↑.`,
        })
      }
    }
  } else if (yearCheck.usedMetadataFallback) {
    signals.push({
      kind: "citation_vintage",
      severity: "info",
      message: "본문 관련규정 섹션이 없어 문서 메타데이터의 관련법령 목록으로 fallback. 시점 단서가 부족할 수 있음.",
    })
  }

  // Amendment / supersession clues.
  const supersession = yearCheck.citations.some((c) => c.hasSupersessionClue)
  const amendment = yearCheck.citations.some((c) => c.hasAmendmentClue)
  if (supersession) {
    signals.push({
      kind: "supersession_clue",
      severity: "high",
      message: "인용 법령에 '폐지/전부개정/삭제' 단서 감지. 인용 조문이 현행에서 사실상 다른 법령으로 갈음됐을 가능성.",
    })
  } else if (amendment) {
    signals.push({
      kind: "amendment_clue",
      severity: "warn",
      message: "인용 법령에 '개정 전/구법/일부개정' 단서 감지. 결론 중 숫자·요건은 현행과 다를 수 있음.",
    })
  }

  // targetYear missing.
  if (!targetYear) {
    signals.push({
      kind: "no_target",
      severity: "info",
      message: "targetYear가 지정되지 않아 시점 비교를 수행하지 못함. 호출 시 targetYear=YYYY 지정 권장.",
    })
  }

  // No citations / citations_no_dates / restructured_location / recent_doctrine_inferred — v0.9.0 신규 분기.
  if (yearCheck.classification === "no_citations") {
    signals.push({
      kind: "no_citations",
      severity: "warn",
      message: "관련규정 섹션과 메타데이터 양쪽 모두에서 인용 법령을 자동 추출하지 못함. 본문 직접 확인 필요.",
    })
  } else if (yearCheck.classification === "citations_no_dates") {
    signals.push({
      kind: "citations_no_dates",
      severity: "info",
      message: `인용 조문 ${yearCheck.citations.length}건 추출됐으나 시점 단서(YYYY.MM.DD)가 없어 자동 시점 비교 불가. korean-law-mcp.get_law_text로 직접 대조.`,
    })
  } else if (yearCheck.classification === "target_or_later_inferred") {
    signals.push({
      kind: "recent_doctrine_inferred",
      severity: "ok",
      message: `최근 심판례·해석례 + 인용 ${yearCheck.citations.length}건 → 현행 적용 가능성 높음. 단, 인용 법령 현행 본문은 직접 대조 권장.`,
    })
  }

  // v0.9.0 — 구조개편 이력 사전 매칭. 옛 위치 인용이면 강한 격상 신호.
  for (const hit of restructureHits) {
    signals.push({
      kind: "restructured_location",
      severity: "high",
      message: `🔴 ${hit.lawName} ${hit.oldRef} → 현행 ${hit.newRef} (${hit.restructureDate} ${hit.type}). 옛 조 번호를 답변에 그대로 옮기지 말 것. 결론은 살아있을 수 있으나 현행 조문 번호로 정정 필수.`,
    })
  }

  // Metadata missing.
  if (!meta.relatedLawsMeta) {
    signals.push({
      kind: "missing_metadata",
      severity: "info",
      message: "문서 기본정보의 관련법령 메타데이터가 비어 있음. 인용 조문 자동 추출 정확도가 떨어질 수 있음.",
    })
  }

  return signals
}

function buildNextActions(
  meta: DoctrineMeta,
  yearCheck: YearCheckResult,
  citedArticles: LawArticleRef[],
  targetYear: number | null,
  finalValidity: FinalValidity,
): NextAction[] {
  const actions: NextAction[] = []

  // v0.9.5 — 사문화 가능성 신호 강도에 따라 priority 등급화.
  // required 등급은 처음 2개 인용 조문(핵심)에만 부착해 큐 폭증 방지.
  const isUnsafeValidity =
    finalValidity === "partially_outdated" ||
    finalValidity === "likely_outdated" ||
    finalValidity === "superseded_or_repealed"

  // 1) 인용 조문 현행 대조 — 처음 2개는 required, 나머지는 recommended.
  const articlesWithArticleNum = citedArticles.filter((c) => c.article)
  for (let i = 0; i < Math.min(articlesWithArticleNum.length, 8); i++) {
    const ref = articlesWithArticleNum[i]
    const priority: NextActionPriority = i < 2 ? "required" : "recommended"
    actions.push({
      tool: "korean-law-mcp.search_law",
      args: { query: ref.lawName, display: 3 },
      purpose: `${ref.lawName} 현행 법령 식별자(mst/lawId) 확보`,
      expectedUse: `다음 단계 get_law_text(mst=..., jo='${ref.article}')에 사용`,
      priority,
    })
    actions.push({
      tool: "korean-law-mcp.get_law_text",
      args: {
        lawId: `(search_law 결과의 lawId)`,
        jo: ref.article,
        ...(targetYear ? { efYd: `${targetYear}0101` } : {}),
      },
      purpose: `${ref.lawName} ${ref.article}${ref.paragraph ? ` ${ref.paragraph}` : ""} 현행 본문 확보`,
      expectedUse: "예규 본문의 인용 문구와 1:1 대조해 동일/차이를 줄단위로 분리. 차이 부분은 부분 사문화로 표시.",
      priority,
    })
  }

  // 2) 후속 결정(대법원/헌재) — 사문화 가능성 있을 때만. 대법원은 recommended, 헌재는 optional.
  if (
    isUnsafeValidity ||
    finalValidity === "needs_current_check"
  ) {
    actions.push({
      tool: "korean-law-mcp.search_decisions",
      args: {
        query: meta.title.slice(0, 40),
        court: "대법원",
      },
      purpose: "동일 쟁점에 대한 대법원 판결로 행정해석이 갈음됐는지 확인",
      expectedUse: "더 권위 있는 후속 판단이 있으면 본 예규 대신 그것을 1차 인용",
      // 사문화 신호 강하면 required로 격상 (위헌 가능성 즉시 확인).
      priority: isUnsafeValidity ? "required" : "recommended",
    })
    actions.push({
      tool: "korean-law-mcp.search_decisions",
      args: {
        query: meta.title.slice(0, 40),
        court: "헌법재판소",
      },
      purpose: "인용 법조문에 위헌·헌법불합치 결정이 있는지 확인",
      expectedUse: "위헌 결정이 있으면 해당 조문 기반 예규 전부 사문화 처리",
      priority: isUnsafeValidity ? "recommended" : "optional",
    })
  }

  // 3) NTS 후속 해석례 검색 — 후일자 행정해석이 우선 갈음할 수 있음.
  actions.push({
    tool: "taxlaw-nts-mcp.search_taxlaw_documents",
    args: {
      query: meta.title.slice(0, 30),
      docType: "reply",
      sort: "date_desc",
      display: 10,
      ...(targetYear ? { fromDate: `${targetYear - 5}0101` } : {}),
    },
    purpose: "같은 쟁점·후일자 NTS 해석례 검색 (행정해석 내부에서도 후행이 선행을 갈음)",
    expectedUse: "더 최근 해석례가 본 예규와 결론이 다르면 그것을 1차 인용",
    priority: "optional",
  })

  // v0.9.6 — (tool, args) 기준 dedupe. 인용 조문에 "제24조 제1항 제1호"와 "제24조"가
  // 별개 ref로 들어와 동일 search_law/get_law_text가 중복 push되는 패턴 제거. priority가
  // 다르면 더 강한 쪽(required > recommended > optional)을 유지.
  const priorityRank: Record<NextActionPriority, number> = { required: 0, recommended: 1, optional: 2 }
  const seen = new Map<string, NextAction>()
  for (const action of actions) {
    const key = `${action.tool}::${JSON.stringify(action.args)}`
    const prior = seen.get(key)
    if (!prior || priorityRank[action.priority] < priorityRank[prior.priority]) {
      seen.set(key, action)
    }
  }
  const deduped = Array.from(seen.values())

  // v0.9.5 — required → recommended → optional 순으로 정렬해 LLM이 최소한 required만으로도 핵심 검증 가능.
  return deduped.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority])
}

function buildScorecardLines(
  meta: DoctrineMeta,
  yearCheck: YearCheckResult,
  finalValidity: FinalValidity,
  signals: DoctrineSignal[],
  targetYear: number | null,
): string[] {
  const lines: string[] = []
  lines.push("┌─ 예규 현행 유효성 채점표 ─────────────────")
  lines.push(`│ 문서: ${meta.docNumber || meta.id} (${meta.productionDate || "일자 미상"})`)
  lines.push(`│ 제목: ${meta.title || "(제목 없음)"}`)
  lines.push(`│ targetYear: ${targetYear ?? "(미지정)"}`)
  lines.push(`│ 자동 검증: ${yearCheck.classification} — ${yearCheck.classificationLabel}`)
  lines.push(`│ 인용 조문 추출: ${yearCheck.citations.length}건${yearCheck.usedMetadataFallback ? " (메타 fallback)" : ""}`)
  lines.push(`│`)
  lines.push(`│ 신호:`)
  for (const s of signals) {
    const sev = s.severity === "high" ? "🔴" : s.severity === "warn" ? "⚠️" : s.severity === "info" ? "ℹ️" : "✅"
    lines.push(`│   ${sev} [${s.kind}] ${s.message}`)
  }
  lines.push(`│`)
  lines.push(`│ ▶ 최종 판정: ${FINAL_LABELS[finalValidity]}`)
  lines.push("└──────────────────────────────────────────")
  return lines
}

export interface AssessDoctrineInput {
  meta: DoctrineMeta
  yearCheck: YearCheckResult
  citedArticles: LawArticleRef[]
  targetYear?: number
  // v0.9.2 — restructure 룩업 시 본문 substring 재확인용. citation-extract의 80자
  // 윈도우 노이즈 차단. 비어 있으면 yearCheck.relatedSectionText로 fallback.
  bodyText?: string
}

export function assessDoctrineValidity(input: AssessDoctrineInput): DoctrineAssessment {
  const { meta, yearCheck, citedArticles } = input
  const targetYear = input.targetYear ?? null
  const productionYear = meta.productionDate ? Number(meta.productionDate.slice(0, 4)) || null : null

  // v0.9.0 — 인용 조문에 옛 위치(전부개정 전) 매핑이 있는지 사전 룩업.
  // v0.9.2 — bodyText 전달로 본문 substring 재확인 활성화 (false-positive 차단).
  const bodyForVerify = input.bodyText ?? yearCheck.relatedSectionText ?? ""
  const restructureHits = detectPreRestructureCitations(citedArticles, bodyForVerify)

  const finalValidity = determineFinalValidity(yearCheck, productionYear, targetYear, restructureHits)
  const signals = buildSignals(yearCheck, meta, productionYear, targetYear, citedArticles, restructureHits)
  const nextActions = buildNextActions(meta, yearCheck, citedArticles, targetYear, finalValidity)
  const scorecardLines = buildScorecardLines(meta, yearCheck, finalValidity, signals, targetYear)

  const warnings: string[] = []
  warnings.push(...yearCheck.warnings)

  const latestCitationDate = yearCheck.citations
    .map((c) => c.latestDate)
    .filter((d): d is string => !!d)
    .sort()
    .slice(-1)[0] ?? null
  const earliestCitationDate = yearCheck.citations
    .map((c) => c.earliestDate)
    .filter((d): d is string => !!d)
    .sort()[0] ?? null

  return {
    meta,
    targetYear,
    yearCheck: {
      classification: yearCheck.classification,
      classificationLabel: yearCheck.classificationLabel,
      hasRelatedSection: yearCheck.hasRelatedSection,
      usedMetadataFallback: yearCheck.usedMetadataFallback,
      citationCount: yearCheck.citations.length,
      latestCitationDate,
      earliestCitationDate,
      supersessionDetected: yearCheck.citations.some((c) => c.hasSupersessionClue),
      amendmentClueDetected: yearCheck.citations.some((c) => c.hasAmendmentClue),
    },
    citedArticles,
    restructureHits,
    signals,
    finalValidity,
    finalLabel: FINAL_LABELS[finalValidity],
    nextActions,
    scorecardLines,
    warnings,
  }
}

export function formatAssessment(a: DoctrineAssessment): string[] {
  const lines: string[] = []
  lines.push(...a.scorecardLines)
  lines.push("")
  if (a.restructureHits.length > 0) {
    lines.push(...formatRestructureHits(a.restructureHits))
    lines.push("")
  }
  if (a.citedArticles.length > 0) {
    lines.push("인용 조문 (자동 추출):")
    for (const c of a.citedArticles.slice(0, 20)) {
      const parts = [c.lawName, c.article, c.paragraph, c.item].filter(Boolean).join(" ")
      lines.push(`  - ${parts}`)
    }
    lines.push("")
  }
  if (a.nextActions.length > 0) {
    const requiredCount = a.nextActions.filter((n) => n.priority === "required").length
    const recommendedCount = a.nextActions.filter((n) => n.priority === "recommended").length
    const optionalCount = a.nextActions.filter((n) => n.priority === "optional").length
    lines.push(
      `권장 후속 호출 큐 (priority 순 실행 — required ${requiredCount}건 / recommended ${recommendedCount}건 / optional ${optionalCount}건):`,
    )
    const priorityIcon: Record<NextActionPriority, string> = {
      required: "🔴",
      recommended: "🟡",
      optional: "⚪",
    }

    // v0.9.6 — tool 종류별 그룹 헤더화. 동일 패턴(인용 조문 본문 대조)에서 매 항목 반복되던
    // `목적`/`활용` 보일러플레이트를 그룹 헤더 1회로 압축.
    type Group = {
      title: string
      header?: string  // 그룹 공통 활용 한 줄. 없으면 그룹별 항목에 인라인.
      actions: Array<{ idx: number; action: NextAction }>
    }
    const groupFor = (tool: string): string => {
      if (tool === "korean-law-mcp.search_law" || tool === "korean-law-mcp.get_law_text") {
        return "citation_check"
      }
      if (tool === "korean-law-mcp.search_decisions") return "follow_decisions"
      if (tool === "taxlaw-nts-mcp.search_taxlaw_documents") return "follow_nts"
      return "other"
    }
    const groupMeta: Record<string, { title: string; header?: string }> = {
      citation_check: {
        title: "인용 조문 본문 확보 + 1:1 대조",
        header: "예규 본문의 인용 문구와 현행 조문 차이를 줄단위로 분리. 차이 부분은 부분 사문화로 표시.",
      },
      follow_decisions: {
        title: "후속 결정 검색",
        header: "더 권위 있는 후속 판단(대법원/헌재)이 있으면 본 예규 대신 그것을 1차 인용.",
      },
      follow_nts: {
        title: "후일자 NTS 해석례",
        header: "행정해석 내부에서도 후행이 선행을 갈음. 더 최근 결론이 본 예규와 다르면 그것을 1차 인용.",
      },
      other: { title: "기타" },
    }
    const groupOrder = ["citation_check", "follow_decisions", "follow_nts", "other"]
    const groups: Record<string, Group> = {}
    for (let i = 0; i < a.nextActions.length; i++) {
      const action = a.nextActions[i]
      const gid = groupFor(action.tool)
      if (!groups[gid]) groups[gid] = { ...groupMeta[gid], actions: [] }
      groups[gid].actions.push({ idx: i + 1, action })
    }

    for (const gid of groupOrder) {
      const g = groups[gid]
      if (!g || g.actions.length === 0) continue
      lines.push(`  ■ ${g.title}${g.header ? ` — ${g.header}` : ""}`)
      for (const { idx, action } of g.actions) {
        const argsInline = JSON.stringify(action.args)
        lines.push(`    [${idx}] ${priorityIcon[action.priority]} ${action.tool}(${argsInline})`)
        // 그룹 헤더로 활용을 일반화한 그룹은 항목별 purpose만 한 줄(▸). 그 외엔 purpose+활용 인라인.
        if (g.header) {
          lines.push(`        ▸ ${action.purpose}`)
        } else {
          lines.push(`        ▸ ${action.purpose} → ${action.expectedUse}`)
        }
      }
    }
    lines.push("")
  }
  if (a.warnings.length > 0) {
    lines.push("⚠️ 경고:")
    for (const w of a.warnings) lines.push(`  - ${w}`)
    lines.push("")
  }
  lines.push("동반 호출 필수: 위 자동 평가는 휴리스틱입니다. 인용 법조문 현행 적용가능성은 반드시 korean-law-mcp의 search_law + get_law_text(jo=...)로 직접 대조 후 사용자에게 보고하세요.")
  return lines
}
