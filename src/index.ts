#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { AsyncLocalStorage } from "node:async_hooks"
import {
  classifyIndustryForArticle,
  dbInfo as upjongDbInfo,
  findByKsic,
  findByKsicPrefix,
  findByUpjong,
  findAllByUpjong,
  formatClassPath,
  resolveClassName,
  searchUpjongByKeyword,
  classifyCreditEligibility,
  CLASS_LEVEL_KR,
  type ClassLevel,
  type UpjongRecord,
  type CreditLookupResult,
} from "./upjong.js"
import { checkYearApplicability, formatYearCheck, getRecentThresholdYears } from "./year-check.js"
import { extractLawArticleRefs, extractBasicRulingRefs, formatBasicRulingRef } from "./citation-extract.js"
import { assessDoctrineValidity, formatAssessment, type DoctrineMeta, type DoctrineSignal } from "./doctrine-assess.js"
import { detectPreRestructureCitations, formatRestructureHits } from "./restructure-map.js"
import {
  describeTaxLawCode,
  formatTaxLawCellCompact,
  formatTaxLawCodeHeader,
  taxLawCodeMatches,
  taxLawCodeReference,
} from "./tax-law-code-map.js"
import { buildRetryQueries, describeRetryAttempt } from "./query-retry.js"
import { diffArticleTexts, type ChangeKind } from "./text-diff.js"

const TAXLAW_BASE = "https://taxlaw.nts.go.kr"
// 법제처 국가법령정보 Open API(DRF). 부칙(시행일·적용례·경과조치)은 NTS DB에 노출되지 않아 이쪽에서 보완 조회한다.
const MOLEG_BASE = "https://www.law.go.kr"
const VERSION = "0.27.8"

// v0.9.11 — 도구 description마다 ~210자 반복하던 동반 호출 안내를 축약(~50자).
// 전체 워크플로는 INSTRUCTIONS 첫 단락 "korean-law-mcp(법제처 Open API)와 항상 짝으로 호출"에서 1회 안내.
const COMPANION_NOTICE =
  "법령 1차=korean-law; NTS 해석례·시점 보완. 확인한 동일 조문은 재사용."

// v0.9.13 — 행정규칙(훈령·예규·고시·지침) stale 경고.
// NTS statute/별표 컬렉션은 행정규칙 개정 후 색인 갱신이 지연될 수 있다(실측: 「모범납세자 관리규정」이
// 법제처는 2026.5.19 제2742호 현행본인데 NTS는 2022.9.30 구버전을 보유 → 조문 번호 전면 불일치).
// 두 MCP는 자동 교차검증이 아니라 상호보완 DB이므로, 행정규칙 결과에는 법제처 현행본 교차확인을 명시 안내한다.
const ADMIN_RULE_LABEL_RE = /^(훈령|예규|고시|지침)(서식)?$|행정규칙/
const ADMIN_RULE_STALE_NOTICE =
  "⚠ 행정규칙(훈령·예규·고시·지침) 결과 포함 — 본 NTS 컬렉션은 행정규칙 개정 후 갱신이 지연될 수 있습니다(stale 가능). " +
  "현행본은 법제처 국가법령정보센터 행정규칙에서 교차 확인하세요: korean-law-mcp.discover_tools(intent=\"행정규칙\") → search_admin_rule(knd=\"1\"훈령/\"2\"예규/\"3\"고시) → get_admin_rule. " +
  "공포일·시행일·문서번호가 NTS 결과와 다르면 법제처 현행본을 1차로 채택하세요."

// v0.12.0 — 치명도순 재배치: 호스트가 instructions를 ~2,000자 부근에서 절단하는 실측에 따라
// 환각 방지 강제 절차를 앞에, 응답 포맷·워크플로를 뒤에 둔다. 내용은 압축만, 의미 변경 없음.
// v0.21.0(#G12-T4) — 전체 2,000자 이하로 재압축(절단 방지): 강제 절차·적용시기·응답 5단은 문장 압축만(실질 유지),
// [저빈도 도구]·[중복 처리]는 1문장, [워크플로]는 요지만.
const INSTRUCTIONS = `taxlaw-nts-mcp: 한국 국세법령정보시스템(NTS) 검색·조회. 세법·법령 질의는 korean-law-mcp(법제처)와 짝으로 호출. 분담: 현행 조문·법원 판례 전문·행정규칙 현행본=korean-law 1차 / 해석례·기본통칙·시점본(year/efYd)·부칙·조문 diff·심판례=본 MCP. ⚠ 계산식 든 조문(조특법 고용공제류 등)은 텍스트에 이미지 수식이 빠질 수 있으므로 get_law_article(full=true)의 이미지 출처까지 확인.

[강제 절차 — 응답 내 ⚠ 무시 금지]
1. 후행 개정(get_law_article): "후행 개정 확인" 블록의 "본문이 변경"/"삭제됨"/"찾지 못함" → 결론 작성 전 diff_article_versions(mstA/mstB) 또는 get_law_article(mst=현행MST, full=true) 1콜로 직접 확인. "공포-미시행" → 미래 귀속 결론 전 그 시행본의 이 조문 확인. "대조 실패" → 제시된 호출 수행. hedge로 결론 대체 금지.
2. 연도 검증: 특정 귀속연도 질문이면 get_taxlaw_document_text(targetYear=YYYY) 필수. 구법조문 기반 예규는 ⚠ 사문화 가능성 경고 동봉.
3. 기본통칙: 해석례 본문 속 "기본통칙 N-N"은 옛 번호 — list_taxlaw_basic_ruling_laws→get_taxlaw_basic_ruling_text(인접 번호대 수집)로 현행 번호 확인. 미확인 시 "현행 번호 미확인" ⚠, 통칙 도구 NOT_FOUND면 통칙 인용 제거.
4. 행정규칙(훈령·예규·고시·지침) stale 가능 — korean-law discover_tools(intent="행정규칙")→search_admin_rule(knd 1훈령/2예규/3고시)→get_admin_rule로 현행본 확인, 공포일·시행일·문서번호 3종 대조 후 다르면 법제처 채택.
5. NOT_FOUND: [RETRY_CANDIDATES] L1(쿼리)→L2(도구)→L3(외부 MCP) 순 재시도. 판례·심판례는 두 MCP 모두 NOT_FOUND여도 공개DB 미수록 가능 — "미존재/할루시네이션" 단정 금지, 외부 교차확인 전까지 "공개DB 미발견"까지만.
6. 인용 실존 검증: 산출물(문서·표)에 해석례·심판례·판례 번호 인용 전 verify_nts_citations(text)로 일괄 실존 확인.

[적용시기 — 타임테이블 우선] 귀속연도 제시 법령·세액공제 질문은 본문 단정 전 build_application_timetable(다조문×다연도) 또는 trace_article_application(단일 조문)부터. 해석 공리: ①신구 문구 나란히 대조(단일 시점본 단정 금지) ②부칙 "개정규정"=그 개정령이 실제 바꾼 문구 단위만 ③경과조치는 자기 개정령만 사정거리 ④후행·특정 적용례>일반 경과조치 ⑤적극 문언 우선(fallback 창작 금지) ⑥서식·별지<부칙·법령 문언. 적용례 anchor가 '최초공제연도'·'신고시점'형이면 차수(1차/추가공제)·신고시점을 질문(통합고용 §29의8 등 다년 사이클은 귀속연도만으로 판정 불가).

[워크플로] korean-law 조문 1차(search_law+get_law_text) → 본 MCP 해석례·통칙 보완(문서번호를 알면 get_taxlaw_document_by_number로 직접조회) → 연도 검증 → 출처를 보존한 간결한 응답.

[응답] 사용자 형식을 우선하고 결론·근거·불확실성을 간결하게 답하라. 각 인용은 문서번호·일자·출처 URL을 보존하고, NTS 원문 링크는 반환 URL 그대로 사용(임의 생성 금지). 직접 사실과 AI 추론(미검증)을 구분하라. 비교가 필요할 때만 표를 쓰고 빈 섹션·관행적 후속 질문은 생략한다.

[중복 처리] 두 MCP 동일 사건=문서번호(공백·하이픈 제거)·생산일자·제목으로 병합+양쪽 출처 ID 병기.

[저빈도 도구] 목록·호출법은 call_taxlaw_extra 설명 참조.`

export const ErrorCodes = {
  NOT_FOUND: "NOT_FOUND",
  INVALID_PARAM: "INVALID_PARAMETER",
  API_ERROR: "EXTERNAL_API_ERROR",
  PARSE_ERROR: "PARSE_ERROR",
} as const

// MCP 호출자가 텍스트를 파싱하지 않고도 결과 상태를 분기할 수 있도록 하는 최소 계약.
// 기존 오류 마커·isError는 하위 호환을 위해 그대로 유지하고, structuredContent에만 추가한다.
export type ToolStatus =
  | "OK"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "UPSTREAM_ERROR"
  | "PARSE_ERROR"
  | "AUTH_ERROR"
  | "BUDGET_EXCEEDED"

export interface ToolStructuredContent {
  status: ToolStatus
}

const FAILURE_GUARD =
  "⚠️ 이 도구는 신뢰 가능한 세법 데이터를 반환하지 못했습니다. LLM은 세법 정보, 문서, 판례를 추측하거나 생성하지 말고 오류/검색 실패와 재시도 필요성을 사용자에게 명시하세요."

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]

export class TaxlawMcpError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode = ErrorCodes.API_ERROR,
    readonly suggestions: string[] = [],
  ) {
    super(message)
    this.name = "TaxlawMcpError"
  }
}

interface ToolResponse {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
  structuredContent?: ToolStructuredContent
}

interface TaxlawActionResponse<T> {
  status: string
  message: string | null
  data: T | null
}

interface IntegratedSearchArgs {
  query?: string
  collections?: string[] | string
  displayPerCollection?: number
  page?: number
  sort?: string
  fromDate?: string
  toDate?: string
  taxLawCode?: string
  synonym?: boolean
  verbose?: boolean
}

interface DocumentSearchArgs {
  query?: string
  docType?: string
  display?: number
  page?: number
  sort?: string
  fromDate?: string
  toDate?: string
  taxLawCode?: string
  verbose?: boolean
}

interface DocumentDetailArgs {
  id?: string
  docType?: string
  full?: boolean
  // 사용자가 적용하려는 연도 (예: 2024). 본문 '관련규정/관련법령' 섹션을 파싱해
  // 인용 법조문의 시점과 비교하고, 구법 기반이면 사문화 가능성 경고를 함께 반환한다.
  targetYear?: number
}

interface DocumentNumberArgs {
  docNo?: string
  docType?: string
  full?: boolean
  targetYear?: number
}

interface AssessDoctrineArgs {
  id?: string
  docType?: string
  targetYear?: number
  full?: boolean
}

interface UpjongLookupArgs {
  code?: string
}

interface KsicLookupArgs {
  code?: string
}

interface KsicPrefixArgs {
  prefix?: string
  limit?: number
}

interface IndustrySearchArgs {
  keyword?: string
  limit?: number
  levels?: string[]
}

interface ResolveClassArgs {
  name?: string
  levels?: string[]
}

interface ClassifyArticleArgs {
  industryName?: string
  upjongCode?: string
  excludeNames?: string[]
  excludeLevels?: string[]
}

interface BasicRulingLawArgs {
  query?: string
}

interface BasicRulingTextArgs {
  lawId?: string
  year?: string
  query?: string
  display?: number
  full?: boolean
  verbose?: boolean
}

interface FormsSearchArgs {
  query?: string
  kind?: string
  lawId?: string
  display?: number
  page?: number
}

interface RawActionArgs {
  actionId?: string
  paramData?: unknown
  refererPath?: string
  full?: boolean
}

interface TaxlawPageTextArgs {
  path?: string
  full?: boolean
}

interface LawAddendaArgs {
  mst?: string
  lawName?: string
  promulgationNo?: string
  query?: string
  oc?: string
  full?: boolean
}

interface LawRevisionArgs {
  mst?: string
  lawName?: string
  promulgationNo?: string
  promulgationDate?: string
  query?: string
  oc?: string
  full?: boolean
}

interface TraceArticleArgs {
  mst?: string
  lawName?: string
  jo?: string
  hang?: string
  targetYear?: number
  filingMonth?: number
  oc?: string
  full?: boolean
}

interface LawArticleArgs {
  jo?: string
  mst?: string
  lawName?: string
  efYd?: string
  year?: number
  oc?: string
  full?: boolean
}

interface TimetableArgs {
  mst?: string
  lawName?: string
  articles?: string[] | string
  targetYears?: number[] | number
  firstCreditYear?: number
  filingMonth?: number
  oc?: string
  full?: boolean
}

interface SiteMenuArgs {
  query?: string
}

interface PublicationSearchArgs {
  query?: string
  categoryCode?: string
  display?: number
  page?: number
}

interface HometaxCounselArgs {
  id?: string
}

interface TaxlawSearchData {
  ASIPDI002PR01: {
    top?: Array<{
      categoryMap?: {
        SUB_ID_CATEGORY?: Array<{ name: string; count: string | number }>
      }
    }>
    body?: Array<{ dcm?: TaxlawDcm }>
  }
}

interface TaxlawDetailData {
  ASIQTB002PR01: {
    dcmDVO?: TaxlawDcm | null
    dcmHwpEditorDVOList?: Array<{ dcmFleByte?: string; dcmFleTy?: string }> | null
    dcmRltnStttList?: Array<{ ntstTextNm?: string }> | null
    dcmRfrnPrtsList?: Array<{ ntstDcmTtl?: string; ntstDcmDscmCntn?: string }> | null
    dcmQutPrtsList?: Array<{ ntstDcmTtl?: string; ntstDcmDscmCntn?: string }> | null
  }
}

interface TaxlawDcm {
  DOC_ID?: string
  DOCID?: string
  TTL?: string
  NTST_DCM_DSCM_CNTN?: string
  NTST_DCM_RPLY_CNTN?: string
  NTST_TLAW_CL_NM?: string
  NTST_TLAW_CL_CD?: string
  NTST_DCM_CL_NM?: string
  LBL1_TTL?: string
  LBL2_TTL?: string
  LBL1_NM?: string
  LBL2_NM?: string
  NTST_DCM_CL_CD?: string
  NTST_DCM_DCS_CL_NM?: string
  DCM_RGT_DTM?: string
  DCM_RGT_DTM_S?: string
  FRS_RGT_DTM?: string
  GIST_CNTN?: string
  CNTN?: string
  FILE_CN?: string
  ntstDcmId?: string
  ntstDcmTtl?: string
  ntstDcmDscmCntn?: string
  ntstDcmRplyCntn?: string
  ntstTlawClCd?: string
  ntstDcmClCd?: string
  ntstDcmClNm?: string
  ntstDcmDcsClNm?: string
  ntstDcmRgtDt?: string
  frsRgtDtm?: string
  ntstDcmGistCntn?: string
  ntstDcmCntn?: string
}

type AnyRecord = Record<string, unknown>

interface IntegratedSearchData {
  ASEISA001MR01: {
    searchResultVO?: {
      wnKey?: string
      errorMsg?: string
      collectionList?: Array<{
        nameKr?: string
        nameEn?: string
        totalCount?: string | number
        resultCount?: string | number
        resultList?: AnyRecord[]
      }>
    }
  }
}

interface BasicRulingData {
  ASISTD001MR01?: {
    bscExrDVOList?: BasicRulingItem[]
  }
  ASISTD001MR02?: {
    bscExrDVOList?: BasicRulingItem[]
    bscExrDVOArList?: BasicRulingItem[]
  }
  ASISTD001MR03?: {
    bscExrDVOList?: BasicRulingItem[]
  }
}

interface BasicRulingItem {
  ntstBscId?: string
  ntstNm?: string
  rgtYr?: string
  ntstExrBaseSn?: string
  ntstTextNm?: string
  ntstTextCntn?: string
  lawClCd?: string
}

interface FormsData {
  ASIAFE001MR01?: FormSearchResult
  ASIAFA001MR01?: FormSearchResult
  ASIAFB001MR01?: FormSearchResult
  ASIAFC001MR01?: FormSearchResult
  ASIAFD001MR01?: FormSearchResult
}

interface FormSearchResult {
  pageIndex?: number
  recordCount?: number
  recordCountPerPage?: number
  allFrmlDVOList?: FormItem[]
  atDVOList?: FormItem[]
  stttFrmlDVOList?: FormItem[]
  innsFrmlDVOList?: FormItem[]
  bkmrFrmlDVOList?: FormItem[]
}

interface FormItem {
  ntstBscId?: string
  ntstBrkdId?: string
  ntstNm?: string
  ntstSysClCd?: string
  ntstPmgDt?: string
  ntstAtFrmlSn?: number | string
  ntstAtFrmlClCd?: string
  ntstAtFrmlAtNo?: string
  ntstAtFrmlNo?: string
  ntstAtFrmlNm?: string
  ntstClNm?: string
  ntar?: string
  ntarBscId?: string
  ntarBrkdId?: string
  ntarClCd?: string
  ntarNm?: string
  ntarPmgNo?: string
  ntarPmgDt?: string
  ntarFrmlSn?: string
  ntarFrmlNo?: string
  ntarFrmlNm?: string
  frmlNm?: string
  ntstBkmrFrmlClCd?: string
  ntstBkmrFrmlDetailClNm?: string
  ntstSjtClNm?: string
  stttInfpClCd?: string
  fleId?: string
}

interface PublicationData {
  ASIELA001MR01?: {
    pageIndex?: number
    recordCount?: number
    recordCountPerPage?: number
    plcnBkDVOList?: PublicationItem[]
  }
  ASIELA001MR02?: {
    plcnBkDVOList?: PublicationItem[]
  }
  ASIELA002MR02?: {
    plcnBkDVOList?: PublicationItem[]
  }
}

interface PublicationItem {
  ntstPlcnBkId?: string
  ntstSjtClCd?: string
  ntstSjtClNm?: string
  ntstPlcnBkTtl?: string
  ntstJrsdDnoNm?: string
  ntstPlcnBkDscmCntn?: string | null
  plcnDt?: string
  fleId?: string
  fleSn?: number
  elctBkFleId?: string
  elctBkFleSn?: number
}

interface HometaxCounselData {
  ASEISA004MR01?: HometaxCounselItem
}

interface HometaxCounselItem {
  reqStdId?: string
  regstDt?: string
  reqTpNm?: string
  stdTitle?: string
  answerStdContent?: string
}

const DOC_TYPE_LABELS: Record<string, string> = {
  "01": "사전답변",
  "02": "질의회신",
  "03": "과세기준자문",
  "04": "고시서면질의",
  "05": "과세전적부심사",
  "06": "이의신청",
  "07": "심사청구",
  "08": "심판청구",
  "09": "판례",
  "10": "헌법재판소",
}

const DOC_TYPE_ORDER = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"] as const

const DOC_TYPE_CODES: Record<string, string[]> = {
  all: [...DOC_TYPE_ORDER],
  interpretations: ["01", "02", "03", "04"],
  interpretation: ["01", "02", "03", "04"],
  disputes: ["05", "06", "07", "08", "09", "10"],
  decisions: ["05", "06", "07", "08", "09", "10"],
  advance: ["01"],
  reply: ["02"],
  tax_standard: ["03"],
  written: ["04"],
  tax_pre_review: ["05"],
  pre_assessment: ["05"],
  objection: ["06"],
  review: ["07"],
  tribunal: ["08"],
  precedent: ["09"],
  constitutional: ["10"],
  "01": ["01"],
  "02": ["02"],
  "03": ["03"],
  "04": ["04"],
  "05": ["05"],
  "06": ["06"],
  "07": ["07"],
  "08": ["08"],
  "09": ["09"],
  "10": ["10"],
}

const QUESTION_CODES = new Set(["01", "02", "03", "04"])
const PRECEDENT_CODES = new Set(["05", "06", "07", "08", "09", "10"])

const SORT_FIELD_MAP: Record<string, string> = {
  date_desc: "DCM_RGT_DTM/DESC",
  date_asc: "DCM_RGT_DTM/ASC",
  reg_desc: "FRS_RGT_DTM/DESC",
  reg_asc: "FRS_RGT_DTM/ASC",
}

const INTEGRATED_COLLECTIONS = [
  "appendForm",
  "statute",
  "question",
  "precedent",
  "formerLibrary",
  "hometaxCnslThan",
] as const

const INTEGRATED_SORT_MAP: Record<string, string> = {
  score: "SCORE/DESC",
  date_desc: "DATE/DESC",
}

type FormKind = "all_forms" | "annex" | "legal_form" | "instruction_form" | "favorite_form"

interface SiteMenuAction {
  key: string
  section: string
  label: string
  path: string
  actionId?: string
  defaultParamData?: unknown
  highLevelTool?: string
  note?: string
}

const SITE_MENU_ACTIONS: SiteMenuAction[] = [
  { key: "tax_statutes", section: "법령", label: "조세법령", path: "/st/USESTA001M.do", actionId: "ASISTA001MR01", defaultParamData: {} },
  { key: "general_statutes", section: "법령", label: "일반법령", path: "/st/USESTB001M.do", actionId: "ASISTB001MR01", defaultParamData: { searchKeyword: "", recordCountPerPage: "10" } },
  { key: "tax_treaties", section: "법령", label: "조세조약", path: "/st/USESTC001M.do", actionId: "ASISTC001MR01", defaultParamData: { txaAgrmClCd: "01" } },
  { key: "amended_law_notice", section: "법령", label: "개정법령 안내", path: "/zz/USEZZB001M.do", actionId: "ASEZZB001MR01", defaultParamData: { searchKeyword: "", recordCountPerPage: "10" } },
  { key: "notices", section: "법령", label: "고시", path: "/st/USESTF001M.do", actionId: "ASISTF001MR01", defaultParamData: { ntarClCd: "01", searchKeyword: "", ntstSjtClCd: "All", recordCountPerPage: "10" } },
  { key: "directives", section: "법령", label: "훈령", path: "/st/USESTG001M.do", actionId: "ASISTF001MR01", defaultParamData: { ntarClCd: "03", searchKeyword: "", ntstSjtClCd: "All", recordCountPerPage: "10" } },
  { key: "basic_rulings", section: "법령", label: "국세 기본통칙", path: "/st/USESTD001M.do", actionId: "ASISTD001MR01", defaultParamData: {}, highLevelTool: "list_taxlaw_basic_ruling_laws/get_taxlaw_basic_ruling_text" },
  { key: "execution_standards", section: "법령", label: "세법집행기준", path: "/st/USESTE002M.do", note: "페이지 HTML에 법령 목록이 포함됩니다. get_taxlaw_page_text로 조회하세요." },
  { key: "latest_revised_statutes", section: "법령", label: "최신개정법령", path: "/st/USESTI001M.do", actionId: "ASISTI001MR01", defaultParamData: { searchltstRvsnNm: "", recordCountPerPage: "10" } },
  { key: "latest_directives_notices", section: "법령", label: "최신 훈령·고시", path: "/st/USESTI002M.do", actionId: "ASISTI002MR01", defaultParamData: { searchKeyword: "", recordCountPerPage: "10" } },
  { key: "amended_tax_explanations", section: "법령", label: "조문별 개정세법해설", path: "/st/USESTH001M.do", actionId: "ASISTH001MR01", defaultParamData: { ntstSysClCd: "01" } },
  { key: "interpretations_all", section: "세법해석례", label: "전체 해석례", path: "/qt/USEQTJ001M.do", highLevelTool: "search_taxlaw_documents" },
  { key: "advance_answers", section: "세법해석례", label: "사전답변", path: "/qt/USEQTA001M.do?ntstDcmClCd=01", highLevelTool: "search_taxlaw_documents(docType=advance)" },
  { key: "replies", section: "세법해석례", label: "질의회신", path: "/qt/USEQTA001M.do?ntstDcmClCd=02", highLevelTool: "search_taxlaw_documents(docType=reply)" },
  { key: "tax_standard_advice", section: "세법해석례", label: "과세기준자문", path: "/qt/USEQTA001M.do?ntstDcmClCd=03", highLevelTool: "search_taxlaw_documents(docType=tax_standard)" },
  { key: "written_questions", section: "세법해석례", label: "고시서면질의", path: "/qt/USEQTA001M.do?ntstDcmClCd=04", highLevelTool: "search_taxlaw_documents(docType=written)" },
  { key: "moleg_interpretations", section: "세법해석례", label: "법제처 해석례", path: "/qt/USEQTM001M.do", actionId: "ASIBGE004MR03", defaultParamData: { searchKeyword: "", bltnStrtDt: "", bltnEndDt: "", pageIndex: "1", searchCondition: "title", recordCountPerPage: "10", ntstDcmClCdList: ["41"] } },
  { key: "interpretation_cleanup", section: "세법해석례", label: "세법해석정비", path: "/qt/USEQTE001M.do", actionId: "ASIQTF001MR01", defaultParamData: { ntstTlawClCd: "", ntstItrpMntcNdYn: "", ntstItrpMntcRsnClCd: "", ntstItrpMntcCntn: "", ntstItrpMntcClCd: "01", bltnStrtDt: "", bltnEndDt: "", cntsPrtsNo: "", stttInfpClCdList: ["01", "06"], recordCountPerPage: "10" } },
  { key: "frequent_issue_cases", section: "세법해석례", label: "자주찾는쟁점별사례", path: "/qt/USEQTH001M.do", actionId: "ASIQTH001MR01", defaultParamData: { ntstDcmClCd: "", ntstTlawClCd: "", ntstDcmPntClCd: "", schNtstDcmTtl: "", schNtstDcmGistCntn: "", schNtstDcmDscmCntn: "", recordCountPerPage: "10" } },
  { key: "major_interpretations", section: "세법해석례", label: "주요 해석사례", path: "/qt/USEQTI001M.do", actionId: "ASIPRC022MR22", defaultParamData: { searchType: "_selectAll_", searchKeyword: "", ntstDcmClCdList: ["01", "02", "03"], ntstTlawClCdList: [], recordCountPerPage: "10", ntstCtgrClCd: "ZZ" } },
  { key: "decisions_all", section: "판례·결정례", label: "전체 판례·결정례", path: "/pd/USEPDI001M.do", highLevelTool: "search_taxlaw_documents(docType=disputes)" },
  { key: "audit_review", section: "판례·결정례", label: "감사원 심사청구", path: "/pd/USEPDM001M.do", actionId: "ASIPDM001MR01", defaultParamData: { ntstDcmDscmCntn: "", ntstDcmTtl: "", bltnStrtDt: "", bltnEndDt: "", lnkClCd: "02", recordCountPerPage: "10" } },
  { key: "major_supreme_court", section: "판례·결정례", label: "주요대법원판결", path: "/pd/USEPDG001M.do", actionId: "ASIPDG001MR01", defaultParamData: { searchYearList: null, searchMonthList: null, searchTlawClCdList: "", searchDocNum: "", searchKeyword: "", ntstDcmClCd: "20", ntstDcmClCdList: ["09"], recordCountPerPage: "10" } },
  { key: "major_decisions", section: "판례·결정례", label: "주요 판례결정례", path: "/qt/USEQTR001M.do", actionId: "ASIPRC022MR22", defaultParamData: { searchType: "_selectAll_", searchKeyword: "", ntstDcmClCdList: ["07", "08", "09"], ntstTlawClCdList: [], recordCountPerPage: "10", ntstCtgrClCd: "ZZ" } },
  { key: "all_forms", section: "별표·서식", label: "전체 서식", path: "/af/USEAFE001M.do", actionId: "ASIAFE001MR01", defaultParamData: { searchFrmlNm: "", recordCountPerPage: "10" }, highLevelTool: "search_taxlaw_forms(kind=all_forms)" },
  { key: "annexes", section: "별표·서식", label: "별표", path: "/af/USEAFA001M.do", actionId: "ASIAFA001MR01", defaultParamData: { searchFrmlNm: "", searchNtstBscId: "stttAll", pageIndex: 1, recordCountPerPage: 10, srtFeld: "btn_sortPmgDt", srtMthd: "desc" }, highLevelTool: "search_taxlaw_forms(kind=annex)" },
  { key: "legal_forms", section: "별표·서식", label: "법령서식", path: "/af/USEAFB001M.do", actionId: "ASIAFB001MR01", defaultParamData: { searchFrmlNm: "", searchNtstBscId: "stttAll", pageIndex: 1, recordCountPerPage: 10, srtFeld: "btn_sortPmgDt", srtMthd: "desc" }, highLevelTool: "search_taxlaw_forms(kind=legal_form)" },
  { key: "instruction_forms", section: "별표·서식", label: "훈령서식", path: "/af/USEAFC001M.do", actionId: "ASIAFC001MR01", defaultParamData: { searchNtarTlawClCd: "all", searchFrmlNm: "", pageIndex: 1, recordCountPerPage: 10, srtFeld: "btn_sortPmgDt", srtMthd: "desc" }, highLevelTool: "search_taxlaw_forms(kind=instruction_form)" },
  { key: "favorite_forms", section: "별표·서식", label: "자주찾는서식", path: "/af/USEAFD001M.do", actionId: "ASIAFD001MR01", defaultParamData: { searchBkmrTlawClCd: "all", searchFrmlNm: "", ntstBkmrFrmlClCd: "10", pageIndex: 1, recordCountPerPage: 10 }, highLevelTool: "search_taxlaw_forms(kind=favorite_form)" },
  { key: "publications", section: "전자도서관", label: "발간책자", path: "/el/USEELA001M.do", actionId: "ASIELA001MR01", defaultParamData: { ntstSjtClCd: "All", searchKeyword: "", ntarClCd: "01", recordCountPerPage: "10" }, highLevelTool: "search_taxlaw_publications" },
  { key: "summary_info", section: "전자도서관", label: "세목별요약정보", path: "/bg/USEBGG001M.do", note: "정적 HTML 자료입니다. 예: get_taxlaw_page_text(path=/html/U_0101.html)" },
  { key: "customer_notices", section: "고객센터", label: "공지사항", path: "/br/USEBRC001M.do", actionId: "ACMCMB001MR01", defaultParamData: { tbbsTtl: "", tbbsCtgrClCd: "01", cmnTbbsBrkdDVO: {}, recordCountPerPage: "10" } },
  { key: "site_guide", section: "고객센터", label: "누리집이용안내", path: "/br/USEBRA001M.do", actionId: "ACMCMB001MR01", defaultParamData: { tbbsTtl: "", tbbsCtgrClCd: "03", cmnTbbsBrkdDVO: {}, recordCountPerPage: "10" } },
  { key: "videos", section: "고객센터", label: "시스템 활용 동영상", path: "/br/USEBRB001M.do", actionId: "ASEBRC001MR01", defaultParamData: { tbbsTtl: "", tbbsCtgrClCd: "02", recordCountPerPage: "10" } },
  { key: "interpretation_guide", section: "고객센터", label: "세법해석질의안내", path: "/br/USEBRD001M.do", actionId: "ACMCMB001MR01", defaultParamData: { tbbsTtl: "", tbbsCtgrClCd: "04", cmnTbbsBrkdDVO: {}, recordCountPerPage: "10" } },
  { key: "taxpayer_protection_cases", section: "고객센터", label: "납세자보호위원회심의사례", path: "/bg/USEBGF001M.do", actionId: "ASIPRC019MR02", defaultParamData: { searchCondition: "", searchKeyword: "", bltnStrtDt: "", bltnEndDt: "", ntstDcmClCd: "14", recordCountPerPage: "10" } },
  { key: "valuation_review_cases", section: "고객센터", label: "평가심의사례", path: "/bg/USEBGI001M.do", actionId: "ASIBGH004MR01", defaultParamData: { tbbsTtl: "", wrtrMemNm: "", bltnStrtDt: "", bltnEndDt: "991231", tbbsCtgrClCd: "12", recordCountPerPage: "10" } },
  { key: "dictionary", section: "기타", label: "용어사전", path: "/st/USESTJ001M.do", actionId: "ASISTJ001MR01", defaultParamData: { searchNtstTrgyDictCntn: "", recordCountPerPage: "10" } },
  { key: "tax_calendar", section: "기타", label: "세무일정", path: "/cm/USECMC001M.do", actionId: "ASECMC001MR01", defaultParamData: { year: "", month: "" }, note: "year=YYYY, month=MM을 지정하면 해당 월 세무일정을 조회합니다. 빈 값은 빈 목록을 반환할 수 있습니다." },
  { key: "tax_law_suggestions", section: "기타", label: "세법개정건의", path: "/cm/USECMJ001M.do", note: "안내/서식 중심 정적 페이지입니다. get_taxlaw_page_text로 본문을 조회하세요." },
]

const tools = [
  {
    name: "search_taxlaw_all",
    description: `국세법령정보시스템 통합검색. 별표서식, 국세법령, 세법해석/질의, 판례·결정례, 발간책자, 홈택스 상담사례. ${COMPANION_NOTICE} 법조문 본문은 korean-law-mcp의 get_law_text가 정확하고, 본 도구의 statute 컬렉션은 메타·인용 위주. 행정규칙(훈령·예규·고시) 결과에는 stale 경고 + 법제처 행정규칙(search_admin_rule/get_admin_rule) 교차확인 안내가 자동 부착됨.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "검색어. 예: 업무용승용차, 법인세 접대비" },
        collections: {
          oneOf: [
            { type: "string", enum: ["all", ...INTEGRATED_COLLECTIONS] },
            { type: "array", items: { type: "string", enum: ["all", ...INTEGRATED_COLLECTIONS] } },
          ],
          default: "all",
          description: "검색 컬렉션. all=전체, appendForm=별표서식, statute=국세법령, question=세법해석/질의, precedent=판례·결정례, formerLibrary=발간책자, hometaxCnslThan=홈택스 상담사례",
        },
        displayPerCollection: { type: "number", minimum: 1, maximum: 10, default: 3 },
        page: { type: "number", minimum: 1, default: 1 },
        sort: { type: "string", enum: ["score", "date_desc"], default: "score" },
        fromDate: { type: "string", pattern: "^\\d{8}$", description: "검색 시작일 YYYYMMDD" },
        toDate: { type: "string", pattern: "^\\d{8}$", description: "검색 종료일 YYYYMMDD" },
        taxLawCode: { type: "string", description: `NTS 세목 코드. ${taxLawCodeReference()}. NTS API 코드 필터링이 strict하지 않아 다른 코드가 섞이면 ⚠ taxLawCode_mismatch 라벨 자동 부착.` },
        synonym: { type: "boolean", default: true, description: "동의어 검색 사용 여부 (기본값 true: 가운뎃점·띄어쓰기 변형 자동 보정. 정확매칭만 원하면 false 명시)" },
        verbose: { type: "boolean", default: true, description: "v0.9.9 — false 시 각 항목의 내용(요약) 생략하고 ID/분류/문서번호/일자만 반환. 검증·헬스체크 등 메타데이터만 필요 시 사용해 응답 토큰 ~60% 절감." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "search_taxlaw_documents",
    description: `국세법령정보시스템 문서 검색. 세법해석례/질의회신(01-04)과 과세전적부·이의·심사·심판·판례·헌재(05-10)를 검색. 최신 조세심판원 결정례는 NTS가 강세. ${COMPANION_NOTICE} 결과는 본 검색 + korean-law-mcp.search_decisions를 함께 호출해 양쪽 출처 병기.

⚠️ 세목 코드 명시 강력 권장(코드표·quirk·mismatch 규칙은 taxLawCode 파라미터 설명 참조).

⚠️ '검색근거' 스니펫은 query 토큰 매칭 단편이라 사건의 실제 쟁점(제목·요지·관련법령)과 다를 수 있습니다 — 키워드가 겹친다고 곧 그 쟁점의 결정이 아닙니다. 산출물에 넣을 인용은 핵심·보조 가리지 말고(티어 금지) 전부 동일하게 제목/요지/관련법령으로 쟁점 일치를 확인하고, 결론·분류 인용은 full=true 본문(주문·판단)을 대조하세요. 마지막에 verify_nts_citations로 일괄 실존·메타 확인.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "검색어. 비우면 선택 문서유형의 최신순 목록 조회" },
        docType: {
          type: "string",
          enum: ["all", "interpretations", "disputes", "advance", "reply", "tax_standard", "written", "tax_pre_review", "objection", "review", "tribunal", "precedent", "constitutional", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10"],
          default: "reply",
        },
        display: { type: "number", minimum: 1, maximum: 50, default: 10, description: "v0.12.0 — 기본 10(토큰 절감, 건당 평균 ~480자). 더 필요하면 명시 지정." },
        page: { type: "number", minimum: 1, default: 1 },
        sort: { type: "string", enum: ["date_desc", "date_asc", "reg_desc", "reg_asc"], default: "date_desc" },
        fromDate: { type: "string", pattern: "^\\d{8}$", description: "검색 시작일 YYYYMMDD" },
        toDate: { type: "string", pattern: "^\\d{8}$", description: "검색 종료일 YYYYMMDD" },
        taxLawCode: { type: "string", description: `NTS 세목 코드 (검색 정확도 향상에 강력 권장). ${taxLawCodeReference()}. NTS API의 코드 필터링이 strict하지 않아 다른 코드가 섞이면 ⚠ taxLawCode_mismatch 자동 부착. quirk: 305(종합소득세)↔312(원천세) 양방향 cross-bleed 잦음 — 식대·자가운전보조금·기타소득 등 원천징수 분야는 두 코드 어느 쪽으로 호출해도 다른 쪽 케이스가 mismatch로 섞이는 게 정상. 312 단독 호출은 NOT_FOUND 빈번하므로 305로 호출 후 mismatch까지 함께 검토 권장.` },
        verbose: { type: "boolean", default: true, description: "v0.9.9 — false 시 각 항목의 요지·검색근거 생략하고 ID/구분/세목/문서번호/일자만 반환. 검증·헬스체크 등 메타데이터만 필요 시 사용해 응답 토큰 ~60% 절감." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "get_taxlaw_document_text",
    description: `국세법령정보시스템 문서 상세 조회. search_taxlaw_documents/search_taxlaw_all 결과의 DOC_ID/id를 사용. ${COMPANION_NOTICE}\n⚠️ 사용자가 특정 연도(예: 2024년) 적용여부를 확인하려는 경우 반드시 targetYear를 지정하세요. 본문 '관련규정' 섹션을 파싱해 인용 법조문의 시점(법률번호·일자·개정단서)을 추출하고 targetYear와 비교하여, 구법조문 기반 예규이면 사문화 가능성을 함께 경고합니다. 그래도 현행 법령과의 최종 대조는 반드시 korean-law-mcp의 get_law_text로 직접 확인해야 합니다.\n⚠️ 판례·결정례(05~10: 과세전적부·이의·심사·심판·판례·헌재)의 결론·판단·결정구분을 인용하거나 분류(인용/기각/에누리/장려금 등)할 때는 full=true로 주문+'심리 및 판단' 결론부를 직접 확인하세요. 기본(false)은 8000자에서 잘려 결론부가 누락될 수 있고, 요지가 실제 주문/결과와 어긋날 수 있습니다.`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "검색 결과의 DOC_ID 또는 DOCID. 예: 001_200000000000019482 또는 200000000000019482" },
        docType: { type: "string", enum: ["advance", "reply", "tax_standard", "written", "tax_pre_review", "objection", "review", "tribunal", "precedent", "constitutional", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10"], description: "알고 있는 경우 문서유형. 미입력 시 질의/판례 상세를 순차 시도" },
        full: { type: "boolean", default: false, description: "true면 HTML 원문 변환 텍스트를 더 길게 포함. 판례·결정례(05~10)의 주문·판단(결론부)은 기본(false)에서 8000자 truncate로 잘릴 수 있으니, 결론·판단을 인용/분류할 때는 true 권장." },
        targetYear: { type: "number", minimum: 1990, maximum: 2100, description: "사용자가 적용하려는 연도(예: 2024). 본문 관련규정 섹션을 파싱해 인용 법조문 시점과 비교하고, targetYear보다 앞선 시점의 구법조문 기반이면 경고를 함께 반환합니다." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_taxlaw_document_by_number",
    description: `국세법령정보시스템 문서번호 또는 회신번호로 문서를 직접 조회합니다. 검색 결과의 DOC_ID를 먼저 찾지 않아도 되며, 공백·하이픈 표기는 정규화한 뒤 완전일치로 확인합니다. ${COMPANION_NOTICE} 반환 본문은 get_taxlaw_document_text와 동일하게 full·targetYear를 지원합니다.`,
    inputSchema: {
      type: "object",
      properties: {
        docNo: { type: "string", description: "문서번호 또는 회신번호. 예: 서면-2024-법규부가-4804, 부가-1" },
        docType: { type: "string", enum: ["all", "interpretations", "disputes", "advance", "reply", "tax_standard", "written", "tax_pre_review", "objection", "review", "tribunal", "precedent", "constitutional", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10"], default: "all", description: "알고 있는 문서유형을 지정하면 검색 범위를 줄일 수 있습니다." },
        full: { type: "boolean", default: false, description: "true면 HTML 원문 변환 텍스트를 더 길게 포함" },
        targetYear: { type: "number", minimum: 1990, maximum: 2100, description: "적용하려는 연도. 관련규정의 조문 시점과 비교해 구법 경고를 붙입니다." },
      },
      required: ["docNo"],
      additionalProperties: false,
    },
  },
  {
    name: "assess_doctrine_validity",
    description: `세법해석례·심판례·판례 단일 문서의 **현행 유효성**을 자동 채점한다. ${COMPANION_NOTICE}\n호출 한 번으로: (1) 본문/메타데이터에서 인용 법조문 시점 파싱, (2) targetYear 대비 사문화 위험 신호 점수화, (3) 최종 판정(valid_current / needs_current_check / partially_outdated / likely_outdated / superseded_or_repealed / unverified) 한 줄 라벨, (4) 권장 후속 호출 큐(korean-law-mcp.search_law/get_law_text/search_decisions + 본 MCP의 후일자 해석례 검색)를 반환. LLM은 next-action 큐를 순서대로 실행해서 답변의 채점표에 결과를 채우세요.`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "평가할 문서의 DOC_ID/DOCID. search_taxlaw_documents/search_taxlaw_all 결과에서 획득." },
        docType: { type: "string", enum: ["advance", "reply", "tax_standard", "written", "tax_pre_review", "objection", "review", "tribunal", "precedent", "constitutional", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10"], description: "알고 있는 경우 문서유형. 미입력 시 질의/판례 상세를 순차 시도." },
        targetYear: { type: "number", minimum: 1990, maximum: 2100, description: "적용하려는 연도 (예: 2026). 시점 비교의 기준. 미지정 시 needs_current_check로 분류." },
        full: { type: "boolean", default: false, description: "true면 출력 말미에 본문 발췌 부착." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_taxlaw_hometax_counsel_text",
    description: "국세법령정보시스템 홈택스 상담사례 상세 조회. search_taxlaw_all의 hometaxCnslThan 결과 ID/REQ_STD_ID를 사용.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "통합검색 홈택스 상담사례 결과의 ID 또는 REQ_STD_ID. 예: 369" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_taxlaw_site_menus",
    description: "국세법령정보시스템 주요 메뉴별 접근 경로와 확인된 action.do 호출 정보를 나열합니다. 고수준 도구가 없는 메뉴는 call_taxlaw_action 또는 get_taxlaw_page_text로 접근합니다.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "메뉴명/섹션/키/액션ID 필터. 예: 훈령서식, ASIPDM, 세목별" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "call_taxlaw_action",
    description: "국세법령정보시스템 action.do 원시 호출. list_taxlaw_site_menus의 actionId/defaultParamData 또는 브라우저에서 확인한 actionId를 사용할 수 있습니다.",
    inputSchema: {
      type: "object",
      properties: {
        actionId: { type: "string", description: "action.do actionId. 예: ASIPDM001MR01" },
        paramData: { type: "object", description: "action.do paramData JSON 객체. 미입력 시 {}" },
        refererPath: { type: "string", description: "같은 사이트 내 referer 경로. 예: /pd/USEPDM001M.do" },
        full: { type: "boolean", default: false, description: "true면 JSON 응답을 더 길게 반환" },
      },
      required: ["actionId", "refererPath"],
      additionalProperties: false,
    },
  },
  {
    name: "get_taxlaw_page_text",
    description: "국세법령정보시스템 HTML/텍스트 페이지를 같은 사이트 경로로 조회해 텍스트로 변환합니다. 정적 자료(예: 세목별요약정보 /html/U_0101.html) 확인용입니다.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "같은 사이트 내 경로. 예: /bg/USEBGG001M.do, /html/U_0101.html" },
        full: { type: "boolean", default: false },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "get_law_addenda",
    description: "법령 부칙(시행일·적용례·경과조치)을 법제처 국가법령정보 Open API(DRF)에서 조회한다. ⚠ NTS 국세법령정보시스템 DB에는 부칙 본문이 노출되지 않으므로(전용 컬렉션 없음) 이 도구로 보완한다. 부칙 '적용례'는 '○○ 개정규정은 …부터 적용한다'로 구조문(개정 전 본문)과 짝이므로, 계산식·정의·요건의 연도별(귀속) 적용시기를 따질 때 필수. 구조문 자체는 korean-law-mcp의 compare_old_new([개정 전])로 확인. mst는 korean-law-mcp의 search_law/search_historical_law로 확보(현행 MST면 과거 개정 부칙까지 모두 누적 포함). 인증키(OC)는 환경변수 LAW_GO_KR_OC 또는 oc 파라미터.",
    inputSchema: {
      type: "object",
      properties: {
        mst: { type: "string", description: "법령일련번호(MST). korean-law-mcp search_law/search_historical_law로 확보. 현행 MST를 넣으면 과거 개정 부칙까지 누적 포함됨." },
        lawName: { type: "string", description: "법령명. mst가 없을 때 DRF lawSearch로 현행 MST를 1차 해소. 예: 조세특례제한법 시행령" },
        promulgationNo: { type: "string", description: "공포번호 필터. 특정 개정령 부칙만. 예: 36342" },
        query: { type: "string", description: "부칙 본문 키워드 필터(해당 문자열을 포함하는 부칙단위만). 예: 상시근로자, 제11조의2" },
        oc: { type: "string", description: "법제처 OC 인증키(미입력 시 env LAW_GO_KR_OC)." },
        full: { type: "boolean", default: false, description: "true면 부칙단위·각 본문을 더 길게 반환." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "get_law_revision_text",
    description:
      "특정 개정령(공포번호/공포일자)의 '개정문'(개정 지시문 원문)을 법제처 DRF에서 회수한다. 개정문은 그 개정령이 실제 수행한 문구 수술의 원문('…를 …로 한다')으로 ① 부칙 적용례의 '개정규정'이 가리키는 문구 단위 확정 ② 부칙-of-부칙 자구개정 확인(예: 제36342호가 제36127호 부칙 §11①을 개정 — 통합본 부칙에는 <개정 2026.5.22> 꼬리표만 남고 지시문 원문은 개정문에만 있음)에 필수. get_law_addenda/build_application_timetable/trace_article_application의 [부칙개정⚠] 플래그가 뜨면 그 개정일을 promulgationDate로 지정해 이 도구로 무엇이 어떻게 바뀌었는지 원문 대조하라. ⚠ 개정문은 '그 공포번호 시행본'의 XML에만 있다 — lawName+promulgationNo(또는 promulgationDate)면 최근 시행본에서 자동 해소, 오래된 개정령은 korean-law-mcp legal_research(task=amendment_track) 또는 discover_tools로 연혁 조회 도구를 확인해 MST를 확보해 mst로 직접 전달.",
    inputSchema: {
      type: "object",
      properties: {
        lawName: { type: "string", description: "법령명. promulgationNo/promulgationDate와 조합해 해당 개정령 시행본을 자동 선택. 예: 조세특례제한법 시행령" },
        promulgationNo: { type: "string", description: "개정령 공포번호. 예: 36342" },
        promulgationDate: { type: "string", description: "개정령 공포일자 YYYYMMDD(부칙개정⚠ 플래그의 개정일). 예: 20260522" },
        mst: { type: "string", description: "그 개정령 시행본의 MST 직접 지정(최근 시행본 window 밖의 오래된 개정령용)." },
        query: { type: "string", description: "지시문 키워드 필터(일치 줄 ±1줄만 표시). 예: 부칙, 제26조의8" },
        oc: { type: "string", description: "법제처 OC 인증키(미입력 시 env LAW_GO_KR_OC)." },
        full: { type: "boolean", default: false, description: "true면 개정문을 더 길게 반환." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "trace_article_application",
    description: "특정 조문의 '연도별(귀속) 적용시점'을 부칙 적용례 기준으로 추적한다. ⚠ 핵심 원칙: 어느 과세연도 신고에 적용되는 조문은 '그 해에 시행 중이던 본문'이 아니라 '부칙 적용례'가 정한다. 특히 '시행 이후 신고하는 경우부터' 같은 신고시점 기준 적용례는 직전 과세연도에 소급 적용된다(예: 2026.2.27 시행·신고기준 → 2025 귀속 신고분에 신법 적용). 이 도구는 해당 조문을 언급하는 모든 개정 부칙의 적용례·경과조치를 원문 그대로 모아 ① 유형(과세연도개시/신고시점/행위시점/최초공제연도/경과조치)으로 태깅하고 ② targetYear에 대한 소급 적용 판단노트와 ③ 부칙 충돌(경과조치 vs 후행 특정 적용례) 경고를 붙인다. 계산방식·정의·요건의 귀속연도별 적용시기를 따질 때 본문/이미지 단정 전에 먼저 호출. 결론은 자동 단정이 아니라 부칙 verbatim과 함께 판단하라.",
    inputSchema: {
      type: "object",
      properties: {
        jo: { type: "string", description: "추적할 조문. 예: 제26조의8 (필수)" },
        hang: { type: "string", description: "항으로 더 좁힘. 예: 제6항" },
        mst: { type: "string", description: "법령일련번호(현행 MST). korean-law-mcp search_law로 확보. 현행 MST면 과거 개정 부칙 누적 포함." },
        lawName: { type: "string", description: "법령명. mst 없을 때 현행 MST 1차 해소. 예: 조세특례제한법 시행령" },
        targetYear: { type: "number", description: "적용하려는 과세연도/귀속(예: 2025). 각 적용례에 대한 소급 판단노트 생성." },
        filingMonth: { type: "number", description: "신고시점 기준 적용례 판단용 신고 월(말일 기준). 법인세=3, 종합소득세=5(기본 3). targetYear+1년의 해당 월로 추정." },
        oc: { type: "string", description: "법제처 OC 인증키(미입력 시 env LAW_GO_KR_OC)." },
        full: { type: "boolean", default: false, description: "true면 조문 본문 발췌·부칙 적용례를 더 길게." },
      },
      required: ["jo"],
      additionalProperties: false,
    },
  },
  {
    name: "get_law_article",
    description: "특정 시점(연도/시행일/MST)의 조문 본문과 '수식 이미지 URL'을 법제처 국가법령정보 DRF에서 회수한다. korean-law의 현행 조문 조회에 시점본·수식 이미지 출처를 보완한다. year(예: 2025) 또는 efYd(YYYYMMDD)를 주면 그 시점에 시행 중이던 버전을 자동 선택(시행일 ≤ 기준 중 최신). 수식(계산식)은 flDownload.do 이미지 URL로 반환 — 다운로드 후 Read/브라우저로 확인. 주의: 이 본문은 '그 시점 시행 중이던' 조문일 뿐, 어느 과세연도 신고에 적용되는지는 trace_article_application(부칙)으로 따로 판정. v0.11.0: 과거본 회수 시 '── 후행 개정 확인 ──' 블록 자동 부착 — 현행본의 같은 조문을 자동 대조해 변경/삭제/동일을 판정하고 공포-미시행(시행예정) 개정도 경고한다. 이 블록의 ⚠는 무시 금지: 변경·삭제 경고가 있으면 현재·미래 귀속 결론 전에 현행본을 확인하라('별도 확인 필요' hedge 금지). ★위임·준용 하강 신호(하위 위임 감지·준용 감지 가드)는 본 도구에만 부착 — 조문 본문을 korean-law get_law_text로 읽었더라도 그 조문의 시행규칙·고시·준용 하강 여부 판정 시 본 도구를 1콜 병행하라(korean-law 경로엔 이 신호가 없다).",
    inputSchema: {
      type: "object",
      properties: {
        jo: { type: "string", description: "조회할 조문. 예: 제26조의8 (필수)" },
        year: { type: "number", description: "그 해 말(12.31) 시점에 시행 중이던 버전 자동 선택. 예: 2025" },
        efYd: { type: "string", description: "기준 시행일 YYYYMMDD. year보다 우선. 예: 20250101" },
        mst: { type: "string", description: "특정 시행본 MST를 직접 지정(연혁 목록에서 고른 값)." },
        lawName: { type: "string", description: "법령명. year/efYd로 시점 해소 또는 현행 해소에 사용. 예: 조세특례제한법 시행령" },
        oc: { type: "string", description: "법제처 OC 인증키(미입력 시 env LAW_GO_KR_OC)." },
        full: { type: "boolean", default: false, description: "true면 본문·연혁 목록을 더 길게." },
      },
      required: ["jo"],
      additionalProperties: false,
    },
  },
  {
    name: "build_application_timetable",
    description: "법령 적용 타임테이블 생성 — 사용자가 귀속연도를 제시한 법령·세액공제 질문의 1차 진입점. 대상 조문(들)에 대해 ① 개정 인벤토리(현행본 <개정> 꼬리표 = 그 조항을 '실제' 고친 개정일 목록) ② 부칙 적용례·경과조치 유형 태깅(최초공제연도/신고시점/과세연도개시/경과조치) ③ 결박검증(각 부칙의 개정령이 그 조항을 실제 개정했는지 — 경과조치 사정거리 점검: 경과조치는 자기 개정령의 개정규정만 유예하며 미래 개정 선제유예 불가) ④ 준용 체인 자동 추적('제N조…준용' 탐지 → 준용 대상 조문의 부칙·인벤토리 동반 회수 = 2층 타임라인) ⑤ 귀속연도×조문 매트릭스(연도별 판단노트)를 한 번에 조립한다. ⚠ 적용례에 '최초공제연도' 기준이 검출되면 귀속연도만으로 판정 불가 — 사용자에게 차수(1차공제/추가공제)를 질문한 뒤 firstCreditYear를 지정해 재호출하라. 출력은 부칙 verbatim의 기계적 조립이지 자동 단정이 아니다 — 결론은 근거 조항 원문과 함께 판단하라.",
    inputSchema: {
      type: "object",
      properties: {
        articles: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4, description: "대상 조문(항 결합 표기 가능, 1~4개). 예: [\"제26조의8제6항\", \"제26조의8제4항\"]" },
        targetYears: { type: "array", items: { type: "number" }, minItems: 1, maxItems: 6, description: "귀속(과세)연도들(1~6개). 예: [2024, 2025, 2026]" },
        firstCreditYear: { type: "number", description: "최초공제연도(1차공제 연도). 다년 사이클 공제(통합고용 §29의8 등)는 이 값에 따라 적용 버전이 갈림 — 미지정 시 차수 확인 플래그 출력." },
        mst: { type: "string", description: "법령일련번호(현행 MST). korean-law-mcp search_law로 확보." },
        lawName: { type: "string", description: "법령명. mst 없을 때 현행 MST 1차 해소. 예: 조세특례제한법 시행령" },
        filingMonth: { type: "number", description: "신고시점 기준 적용례 판단용 신고 월. 법인세=3(기본), 종합소득세=5." },
        oc: { type: "string", description: "법제처 Open API 인증키(OC). 미입력 시 환경변수 LAW_GO_KR_OC." },
        full: { type: "boolean", default: false, description: "true면 적용례 원문·매트릭스를 더 길게." },
      },
      required: ["articles", "targetYears"],
      additionalProperties: false,
    },
  },
  {
    name: "diff_article_versions",
    description:
      "두 시점 시행본의 같은 조문을 단어단위로 기계 대조(diff)해 변경 hunk만 반환한다 — 타임테이블 해석 공리 ①(신구 문구 나란히 대조)·②(개정규정=실제 바뀐 문구 단위)의 기계화 도구. 각 hunk는 【삭제】【신설】 마커+앞뒤 문맥으로 표시하고 실질변경/자구정비/번호이동을 결정적 휴리스틱으로 분류한다(LLM 추정 아님). 용법: build_application_timetable의 개정 인벤토리에서 개정일 2개를 고른 뒤 이 도구로 '그 사이 실제 바뀐 문구'를 확정하고, get_law_revision_text(개정문 '…를 …로 한다')와 교차검증. '변경 없음' 응답은 그 구간 해당 조문 무개정의 적극 신호로 그 자체가 근거가 된다. ⚠ 변경 문구의 개정령 귀속은 개정문·부칙으로 확정 후 단정.",
    inputSchema: {
      type: "object",
      properties: {
        jo: { type: "string", description: "대조할 조문. 예: 제26조의8 (필수)" },
        hang: { type: "string", description: "항으로 더 좁힘(①~⑳ 블록 절단). 예: 제6항" },
        lawName: { type: "string", description: "법령명(yearA/B·efYdA/B 시점 해소용). 예: 조세특례제한법 시행령" },
        yearA: { type: "number", description: "[구]측 연도 — 그 해 말(12.31) 시행본 자동 선택. 예: 2024" },
        efYdA: { type: "string", description: "[구]측 기준 시행일 YYYYMMDD. yearA보다 우선." },
        mstA: { type: "string", description: "[구]측 시행본 MST 직접 지정(eflaw 최근 40건 window 밖의 과거본용)." },
        yearB: { type: "number", description: "[신]측 연도. 예: 2026" },
        efYdB: { type: "string", description: "[신]측 기준 시행일 YYYYMMDD. yearB보다 우선." },
        mstB: { type: "string", description: "[신]측 시행본 MST 직접 지정." },
        oc: { type: "string", description: "법제처 OC 인증키(미입력 시 env LAW_GO_KR_OC)." },
        full: { type: "boolean", default: false, description: "true면 hunk 12→40건까지 표시." },
      },
      required: ["jo"],
      additionalProperties: false,
    },
  },
  {
    name: "research_taxlaw_topic",
    description:
      "체인 매크로: search_taxlaw_documents → 관련성 상위 K건(기본 2, 최대 3)의 get_taxlaw_document_text(full, targetYear) 본문 첨부를 1콜로 수행한다(검색→본문→연도검증 다턴 왕복 절감). 첨부는 항상 full 본문 기반(요지만으로 결론 단정 금지 가드 유지)이며 연도검증·통칙검증·결론부 가드가 그대로 부착된다. targetYear 지정 시 픽별 유효성 자동 채점 1줄 첨부(assess_doctrine_validity 요약). ⚠ 첨부가 [truncated]로 잘렸으면 결론 인용 전 get_taxlaw_document_text(full=true) 개별 재조회. 복합어 자동 분해 재시도는 search_taxlaw_documents에만 있으므로 결과 없음 시 그쪽으로 재검색. korean-law-mcp 동반 호출(법조문 1차 권위)은 여전히 필수.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "검색 키워드 (필수). 1~3개 핵심 단어 권장." },
        targetYear: { type: "number", description: "적용하려는 귀속(과세)연도 — 첨부 본문의 연도검증에 사용. 예: 2025" },
        topK: { type: "number", default: 2, description: "본문 첨부 건수(1~3). 기본 2." },
        docType: { type: "string", description: "search_taxlaw_documents와 동일(all/interpretations/disputes/reply/tribunal/precedent 등). 기본 all." },
        taxLawCode: { type: "string", description: "세목 코드 필터(search_taxlaw_documents와 동일)." },
        fromDate: { type: "string", description: "생산일자 시작 YYYYMMDD." },
        toDate: { type: "string", description: "생산일자 종료 YYYYMMDD." },
        full: { type: "boolean", default: false, description: "true면 첨부당 9000→20000자." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "search_taxlaw_interpretations",
    description: "하위호환용: 세법해석례/질의회신 검색. 내부적으로 search_taxlaw_documents를 사용.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        docType: { type: "string", enum: ["all", "interpretations", "advance", "reply", "tax_standard", "written", "01", "02", "03", "04"], default: "reply" },
        display: { type: "number", minimum: 1, maximum: 50, default: 10 },
        page: { type: "number", minimum: 1, default: 1 },
        sort: { type: "string", enum: ["date_desc", "date_asc", "reg_desc", "reg_asc"], default: "date_desc" },
        fromDate: { type: "string", pattern: "^\\d{8}$" },
        toDate: { type: "string", pattern: "^\\d{8}$" },
        taxLawCode: { type: "string" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "get_taxlaw_interpretation_text",
    description: "하위호환용: 세법해석례/질의회신 상세 조회. 내부적으로 get_taxlaw_document_text를 사용.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        full: { type: "boolean", default: false },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_taxlaw_basic_ruling_laws",
    description: "국세법령정보시스템 기본통칙 법령 목록 조회. get_taxlaw_basic_ruling_text의 lawId 확보용.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "법령명 필터. 예: 법인세, 소득세" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "get_taxlaw_basic_ruling_text",
    description: "국세법령정보시스템 기본통칙 본문 조회. list_taxlaw_basic_ruling_laws 결과의 lawId 사용.",
    inputSchema: {
      type: "object",
      properties: {
        lawId: { type: "string", description: "기본통칙 법령 ID(ntstBscId)" },
        year: { type: "string", pattern: "^\\d{4}$", description: "연도. 미입력 시 최신 연도" },
        query: { type: "string", description: "통칙 제목/본문 내 필터" },
        display: { type: "number", minimum: 1, maximum: 200, default: 30 },
        full: { type: "boolean", default: false },
        verbose: { type: "boolean", default: true, description: "v0.9.11 — false 시 본문 텍스트 생략, 헤더·항목명·번호만 반환. 인접 번호 군집 스캔용." },
      },
      required: ["lawId"],
      additionalProperties: false,
    },
  },
  {
    name: "search_taxlaw_forms",
    description: "국세법령정보시스템 별표/서식 검색. 전체 서식, 별표, 법령서식, 훈령서식, 자주찾는서식을 탐색.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "별표/서식명 검색어" },
        kind: { type: "string", enum: ["all", "all_forms", "annex", "form", "legal_form", "instruction_form", "favorite_form"], default: "all" },
        lawId: { type: "string", description: "특정 법령 ID(ntstBscId). 미입력 시 전체" },
        display: { type: "number", minimum: 1, maximum: 50, default: 20 },
        page: { type: "number", minimum: 1, default: 1 },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "search_taxlaw_publications",
    description: "국세법령정보시스템 발간책자 검색. 세무안내, 신고안내 등 전자도서관 자료 탐색.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "제목 검색어" },
        categoryCode: { type: "string", description: "분야 코드. list_taxlaw_publication_categories로 확인. 미입력/All=전체" },
        display: { type: "number", minimum: 1, maximum: 50, default: 20 },
        page: { type: "number", minimum: 1, default: 1 },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "list_taxlaw_publication_categories",
    description: "국세법령정보시스템 발간책자 분야 코드 목록 조회.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "lookup_upjong_code",
    description: "국세청 업종코드(6자리)를 받아 KSIC(통계청 표준산업분류)와의 매핑·대중소세세세 5단계 분류명·코드를 반환합니다. 사용자가 업종코드를 묻거나 법조문이 특정 업종을 가리킬 때 1차로 호출하세요. 추정 금지 — DB에 없는 코드는 not found로 반환됩니다.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "업종코드. 예: 749942, 852000" },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "classify_credit_eligibility",
    description:
      "업종코드(6자리)로 창업중소기업 세액감면(창중감, 조특법 §6③ 각 호)·중소기업특별세액감면(중특감, 조특법 §7①1호 각 목) 적격 업종 여부를 한 번에 판정합니다. '이 업종코드가 창중감/중특감 되나?' 질문 시 1차 호출. 출처=사용자 「창중감,중특감 판정기」 연계표(§6③ 호·§7①1호 호/목 전사) — provisional(미검증). ⚠ 단서업종은 본 결과로 단정 금지: 자동차정비공장(§7터목)=자동차종합·소형자동차종합정비업만(조특칙§22, 자동차전문정비업 922202 등 제외), 의료업=요양급여 비율·소득 요건, 부동산임대·소비성서비스 제외 등은 조특법·조특령·조특칙 본문으로 재확인. 비적격(호 비어 있음)도 연계표 누락일 수 있으니 법령 교차확인.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "업종코드(6자리). 예: 922202, 300100" },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "lookup_ksic_code",
    description: "KSIC(통계청 표준산업분류) 코드를 받아 매핑된 국세청 업종코드 목록과 분류수준 정보를 반환합니다.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "KSIC 코드. 예: 71600, 73100" },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "lookup_ksic_prefix",
    description: "KSIC 코드 prefix로 매핑된 NTS 업종코드를 모두 반환합니다. prefix 길이에 따라 분류수준 자동 식별: 1자리 영문(B/C/M 등)=대분류, 2자리=중분류, 3자리=소분류, 4자리=세분류, 5자리=세세분류. 예: 681(부동산임대업), 4791(통신판매업), 7421(청소업). lookup_ksic_code(5자리 정확)와 다릅니다.",
    inputSchema: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "KSIC 코드 prefix. 예: B, 12, 681, 4791, 7421" },
        limit: { type: "number", minimum: 1, maximum: 500, default: 200 },
      },
      required: ["prefix"],
      additionalProperties: false,
    },
  },
  {
    name: "search_industry_by_keyword",
    description: "업종코드/KSIC DB를 분류명 키워드로 검색합니다. 띄어쓰기·괄호 차이를 무시한 정규화 매칭. levels로 검색 분류수준 한정 가능 (예: 제외 단서를 l3~l5에만 적용해 상위 레벨에 휘말리는 것 방지). 결과의 분류수준을 보고 법조문이 가리키는 수준을 판단할 수 있습니다.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "검색어. 예: '수의업', '기타 전문, 과학 및 기술 서비스업'" },
        limit: { type: "number", minimum: 1, maximum: 100, default: 30 },
        levels: {
          type: "array",
          items: { type: "string", enum: ["l1", "l2", "l3", "l4", "l5"] },
          description: "검색 분류수준 한정. 미지정 시 l1~l5 모두. 예: ['l3','l4','l5']로 좁히면 상위 레벨 분류명 매칭 방지.",
        },
      },
      required: ["keyword"],
      additionalProperties: false,
    },
  },
  {
    name: "resolve_industry_class",
    description: "법조문에 등장한 산업명 한 줄을 받아 KSIC/업종코드의 어느 분류수준(대/중/소/세/세세)과 일치하는지 후보를 반환합니다. 예: '기타 전문, 과학 및 기술 서비스업' → KSIC 중분류 73 + 업종 중분류 85 둘 다. levels로 검색 분류수준 한정 가능. 법조문이 가리키는 분류 레벨을 식별하는 데 필수입니다.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "법조문에 적힌 산업명. 예: '기타 전문, 과학 및 기술 서비스업'" },
        levels: {
          type: "array",
          items: { type: "string", enum: ["l1", "l2", "l3", "l4", "l5"] },
          description: "검색 분류수준 한정. 미지정 시 l1~l5 모두.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "classify_industry_for_article",
    description: "법조문(예: 조세특례제한법 시행령 제27조 제3항 16호, 조특법 §6③, §7①)이 가리키는 산업명·제외 단서와 평가하려는 업종코드를 받아, 해당 업종코드가 본 조항 적용 대상인지 판정합니다. 5단계 분류수준을 자동 식별해 비교하므로 LLM이 '대분류만 보고 잘못 매칭'하는 실수를 차단. verdict ∈ {match, excluded, out_of_scope, ambiguous}. ※ excludeLevels로 제외 단서 검색 분류수준 한정 가능 — 음식점업에서 '주점' 차감 시 l2 '음식점 및 주점업'에 휘말리는 것 방지.",
    inputSchema: {
      type: "object",
      properties: {
        industryName: { type: "string", description: "법조문이 가리키는 산업명. 예: '기타 전문, 과학 및 기술 서비스업'" },
        upjongCode: { type: "string", description: "평가할 업종코드. 예: 749942" },
        excludeNames: {
          type: "array",
          items: { type: "string" },
          description: "법조문 내 제외 단서. 예: ['수의업', '주점업']",
        },
        excludeLevels: {
          type: "array",
          items: { type: "string", enum: ["l1", "l2", "l3", "l4", "l5"] },
          description: "제외 단서 검색 분류수준 한정. 권장: ['l3','l4','l5']. 미지정 시 l1~l5 모두.",
        },
      },
      required: ["industryName", "upjongCode"],
      additionalProperties: false,
    },
  },
  {
    name: "upjong_db_info",
    description: "내장된 업종코드↔KSIC 매핑 DB의 생성 시각, 원본 CSV 경로, 귀속연도, 레코드 수를 반환합니다. DB 신선도 확인용.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "verify_nts_citations",
    description:
      "v0.12.0 — 산출물 텍스트에서 해석례·질의회신 문서번호(서면-2024-법규부가-4804, 부가46015-2833, 서면법규과-1284 등)·심판례 청구번호(조심2013서1471 등)·법원 사건번호(2021두39997 등)를 일괄 추출해 NTS 공개DB 실존 여부를 검색으로 확인한다. docx·표·메모에 인용을 넣기 전 마지막 게이트. 결과: ✓ 실존 확인(제목·생산일자·ID 병기) / ✗ 공개DB 미발견(⚠ 미존재 단정 금지 — 외부 DB 교차확인 안내) / 기본통칙 번호는 현행번호 확인 경로 안내. ⚠ 실존 확인 ≠ 명제 적합성 — 그 문서가 결론을 지지하는지는 full 본문으로 별도 대조 필요.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "검증할 본문/인용 목록(초안 전체를 넣어도 됨 — 번호 패턴만 추출)" },
        maxCitations: { type: "number", minimum: 1, maximum: 20, default: 12, description: "검증할 최대 인용 수(추출 순)" },
        claims: {
          type: "array",
          description: "v0.15.0 — 인용별 '명제 결박'(권장). 각 인용이 산출물에서 뒷받침하려는 주장을 함께 제출하면, 그 주장 핵심어가 문서 본문/요지에 실제 등장하는지 ACTIVE 검사(불일치 시 ⚠⚠ 오귀속 의심). 미제출 시 실존만 확인.",
          items: {
            type: "object",
            properties: {
              citation: { type: "string", description: "인용 번호(text의 것과 동일 표기). 예: 조심-2024-인-2328" },
              proposition: { type: "string", description: "이 인용으로 뒷받침하려는 주장(한 문장). 예: 공동경비를 §48 매출액 비율로 안분한다" },
              basis: { type: "string", enum: ["direct", "inference"], description: "직접근거(direct)인지 추론(inference)인지" },
            },
            required: ["citation", "proposition"],
            additionalProperties: false,
          },
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "call_taxlaw_extra",
    description:
      "v0.12.0 — 저빈도 도구 게이트웨이(목록 비노출로 세션 토큰 절감). name에 다음 중 하나, args에 그 도구의 인자 객체. [업종코드·KSIC 매핑] lookup_upjong_code(code) / lookup_ksic_code(code) / lookup_ksic_prefix(prefix, levels?) / search_industry_by_keyword(keyword, levels?) / resolve_industry_class(name, levels?) / classify_industry_for_article(industryName, upjongCode, excludeNames?, excludeLevels?) / upjong_db_info(). [별칭] search_taxlaw_interpretations(=search_taxlaw_documents) / get_taxlaw_interpretation_text(=get_taxlaw_document_text). [고용공제계산] 내장 계산기 제거됨(v0.20.0) — 계산은 외부 전용 계산기로, 단가·산식·적용시기는 get_law_article(full=true)·build_application_timetable로 조문 직접 확인. [세법집행기준] get_execution_standard(law, number?, query?, year?, full?) — 국세청 세법집행기준(행정해석·법규성 없음)을 번호('24-21-1')/제목/연도판본으로 조회. 번호·수록페이지 반환, 본문은 PDF 다운로드(Read pages) 또는 formerLibrary 스니펫. law=국세기본·국세징수·법인세·국제조세·종합소득세·양도소득세·종합부동산세·상속증여세·개별소비세·인지세·주세·주류면허법·증권거래세·부가가치세·조세특례제한법. [기타] get_taxlaw_hometax_counsel_text(id) / search_taxlaw_publications(query) / list_taxlaw_publication_categories() / list_taxlaw_site_menus() / get_taxlaw_page_text(path) / call_taxlaw_action(actionId, paramData, refererPath).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "호출할 저빈도 도구명" },
        args: { type: "object", description: "그 도구의 인자 객체", additionalProperties: true },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
]

// v0.12.0 — 저빈도 도구 15종은 tools/list에서 비노출(세션 고정 토큰 ~6.9K chars 절감).
// call_taxlaw_extra(name, args) 게이트웨이로 여전히 호출 가능. 환경변수 TAXLAW_EXPOSE_ALL=1이면 전부 노출.
export const HIDDEN_TOOL_NAMES = new Set([
  "lookup_upjong_code",
  "lookup_ksic_code",
  "lookup_ksic_prefix",
  "search_industry_by_keyword",
  "resolve_industry_class",
  "classify_industry_for_article",
  "upjong_db_info",
  "search_taxlaw_interpretations",
  "get_taxlaw_interpretation_text",
  "get_taxlaw_hometax_counsel_text",
  "search_taxlaw_publications",
  "list_taxlaw_publication_categories",
  "list_taxlaw_site_menus",
  "get_taxlaw_page_text",
  "get_execution_standard",
  "call_taxlaw_action",
  // v0.20.0(#7) — compute_employment_credit는 v0.20.0에서 계산기능 제거·라우터 응답만 남김. HIDDEN에 유지해야
  // call_taxlaw_extra(name="compute_employment_credit") 게이트가 라우터(전용 계산기 안내)에 도달한다(미등록 시 generic 오류 = CHANGELOG와 모순). tools 배열엔 미등록이라 tools/list 비노출은 유지.
  "compute_employment_credit",
])

export function visibleTools(): typeof tools {
  if (process.env.TAXLAW_EXPOSE_ALL === "1") return tools
  return tools.filter((t) => !HIDDEN_TOOL_NAMES.has(t.name))
}

// v0.15.0(보안 하드닝) — 모든 도구 출력에서 법제처 OC(API키) 누출 방어심층.
// v0.21.0(#G11) — 주석 정정: '누출 경로 없음'은 사실이 아니었다. DRF fetch용 url(OC 포함)이 여러
// 도구의 `출처: ${url}` 라인에 그대로 실려 왔고, redactSecrets가 최종 출력에서 이를 마스킹하는 실질
// 방어선이었다(장식이 아님). 이제 표시용 URL은 displayLawServiceUrl로 OC를 애초에 배제하고,
// redactSecrets는 에러·미래 경로용 최후 방어선으로 존치한다.
export function redactSecrets(text: string): string {
  // gi: 대소문자(Oc/oC)·URL인코딩(%4F%43) 변형까지 마스킹(Codex v0.16.1 재대조 반영).
  // v0.27.0(리뷰 P2) — 우회 형태 3종 보강(실측): HTML 엔티티 '&amp;OC=', 선행 구분자 없는 'OC=',
  //   JSON 표기 '"OC":"..."'. 종전엔 ?/& 직후 형태만 마스킹돼 "모든 출력의 최후 방어선" 계약에 미달했다.
  return String(text || "")
    .replace(/((?:^|[?&;\s]|&amp;)(?:oc|%4f%43)\s*=\s*)[^&\s"'<>]+/gi, "$1***")
    .replace(/(["']oc["']\s*:\s*["'])[^"']+/gi, "$1***")
}

// 텍스트 응답의 기존 첫 줄 오류 마커를 기계 판독 가능한 상태로 정규화한다.
// 마커가 없는 정상 응답은 OK로, 마커가 없는 오류 응답은 안전 측으로 UPSTREAM_ERROR로 분류한다.
export function toolStatusFromText(text: string, isError = false): ToolStatus {
  const firstLine = String(text || "").trimStart().split(/\r?\n/, 1)[0]
  const marker = firstLine.match(/^\[([A-Z_]+)\]/)?.[1]
  switch (marker) {
    case "NOT_FOUND":
      return "NOT_FOUND"
    case "INVALID_PARAMETER":
    case "INVALID_INPUT":
      return "INVALID_INPUT"
    case "EXTERNAL_API_ERROR":
    case "UPSTREAM_ERROR":
    case "UPSTREAM_CIRCUIT_OPEN":
      return "UPSTREAM_ERROR"
    case "PARSE_ERROR":
      return "PARSE_ERROR"
    case "AUTH_ERROR":
      return "AUTH_ERROR"
    case "BUDGET_EXCEEDED":
      return "BUDGET_EXCEEDED"
    default:
      return isError ? "UPSTREAM_ERROR" : "OK"
  }
}

function textResponse(text: string, isError = false, status?: ToolStatus): ToolResponse {
  const redacted = redactSecrets(text)
  return {
    content: [{ type: "text", text: redacted }],
    ...(isError ? { isError: true } : {}),
    structuredContent: { status: status || toolStatusFromText(redacted, isError) },
  }
}

function lookupSiteActions(keys: string[]): SiteMenuAction[] {
  const out: SiteMenuAction[] = []
  for (const key of keys) {
    const found = SITE_MENU_ACTIONS.find((a) => a.key === key)
    if (found) out.push(found)
  }
  return out
}

// 도구별로 NOT_FOUND 시 다음에 시도할만한 NTS 사이트 actionId 후보.
// SITE_MENU_ACTIONS와 일치하는 key만 추천한다. (call_taxlaw_action으로 직접 호출 가능)
const NOT_FOUND_ACTION_HINTS: Record<string, string[]> = {
  search_taxlaw_all: ["moleg_interpretations", "interpretation_cleanup", "audit_review", "taxpayer_protection_cases", "valuation_review_cases", "major_supreme_court"],
  search_taxlaw_documents: ["moleg_interpretations", "audit_review", "taxpayer_protection_cases", "valuation_review_cases", "major_supreme_court", "major_decisions"],
  search_taxlaw_interpretations: ["moleg_interpretations", "interpretation_cleanup", "major_interpretations", "frequent_issue_cases"],
  get_taxlaw_basic_ruling_text: ["basic_rulings", "execution_standards", "amended_tax_explanations"],
  list_taxlaw_basic_ruling_laws: ["basic_rulings"],
  search_taxlaw_publications: ["publications", "summary_info"],
  search_taxlaw_forms: ["all_forms", "annexes", "legal_forms", "instruction_forms", "favorite_forms"],
  get_taxlaw_document_text: ["moleg_interpretations", "audit_review", "major_supreme_court"],
  get_taxlaw_document_by_number: ["moleg_interpretations", "audit_review", "major_supreme_court"],
  get_taxlaw_hometax_counsel_text: ["interpretations_all"],
}

// v0.9.9 — NOT_FOUND 응답 토큰 압축. 반복되는 LLM 가드·재시도 제안·actionId 리스트를
// 보일러플레이트 압축 (도구별 ~500토큰 → ~120토큰).
// v0.9.11 — [RETRY_CANDIDATES] 명시 marker + 단계별 라벨로 LLM이 self-recover 순서대로
// 실행하도록 신호. suggestions를 단순 배열 또는 단계별 객체로 받음.
function notFoundResponse(
  message: string,
  suggestions: string[] | { L1?: string[]; L2?: string[]; L3?: string[] } = [],
  options: { toolName?: string; relatedActions?: SiteMenuAction[] } = {},
): ToolResponse {
  const lines = [
    `[${ErrorCodes.NOT_FOUND}] ${message}`,
    "⚠ 데이터 없음 — LLM은 결과 추측·생성 금지.",
  ]
  const isLeveled = !Array.isArray(suggestions)
  if (isLeveled) {
    const levels = suggestions as { L1?: string[]; L2?: string[]; L3?: string[] }
    const groups: Array<[string, string[]]> = [
      ["L1 (쿼리·파라미터 조정)", levels.L1 || []],
      ["L2 (도구·범위 변경)", levels.L2 || []],
      ["L3 (외부 MCP 병행)", levels.L3 || []],
    ].filter(([, items]) => items.length > 0) as Array<[string, string[]]>
    if (groups.length > 0) {
      lines.push("[RETRY_CANDIDATES] 다음 순서로 재시도:")
      groups.forEach(([label, items]) => {
        items.forEach((s) => lines.push(`  ${label}: ${s}`))
      })
    }
  } else if (suggestions.length > 0) {
    lines.push("[RETRY_CANDIDATES] 다음 순서로 재시도:")
    suggestions.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`))
  }
  const actions = options.relatedActions
    || (options.toolName ? lookupSiteActions(NOT_FOUND_ACTION_HINTS[options.toolName] || []) : [])
  if (actions.length > 0) {
    const ids = actions.map((a) => `[${a.actionId || "N/A"}] ${a.label}`).join(" | ")
    lines.push(`🔗 actionId(call_taxlaw_action): ${ids}`)
  }
  return textResponse(lines.join("\n"), true)
}

function formatToolError(error: unknown, context: string): ToolResponse {
  if (error instanceof TaxlawMcpError) {
    const lines = [`[${error.code}] ${error.message}`, `도구: ${context}`, "", FAILURE_GUARD]
    if (error.suggestions.length > 0) {
      lines.push("제안:")
      error.suggestions.forEach((suggestion, idx) => lines.push(`  ${idx + 1}. ${suggestion}`))
    }
    return textResponse(lines.join("\n"), true)
  }

  const message = error instanceof Error ? error.message : String(error)
  return textResponse(`[${ErrorCodes.API_ERROR}] ${message}\n도구: ${context}\n\n${FAILURE_GUARD}`, true)
}

export function truncate(text: string, max = 50000): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[truncated to ${max.toLocaleString()} chars]`
}

// v0.27.1(리뷰 P1) — '경고 우선' 예산 배분. 안전 경고(guard)를 먼저 확보하고 본문(head)을 남은 예산으로 자른다.
//   종전처럼 [본문 + 경고]를 이어붙여 마지막에 한 번 자르면 경고가 꼬리라서 통째로 사라진다.
//   비대칭이 핵심: 본문 절단은 truncate가 "[truncated…]"를 남기지만, 경고 소실은 흔적이 없어
//   '경고 없음 = 안전'으로 오독된다. guard가 cap을 통째로 넘기는 병리적 경우만 guard를 자른다.
export function budgetedJoin(head: string[], guard: string[], cap: number, minHead = 4000): string {
  const guardText = guard.join("\n")
  if (!guardText) return truncate(head.join("\n"), cap)
  const headBudget = Math.max(minHead, cap - guardText.length - 200)
  const headText = truncate(head.join("\n"), headBudget)
  return `${headText}\n${truncate(guardText, Math.max(0, cap - headText.length - 1))}`
}

// v0.27.1(리뷰 P2) — 블록 목록을 문자 예산에 맞춰 채우고 '실제 렌더 개수'와 '생략 개수'를 함께 돌려준다.
//   종전처럼 전부 조립한 뒤 마지막에 자르면 헤더의 "표시 N개"가 실제와 어긋나고
//   꼬리의 "… 외 N개 생략" 안내까지 함께 잘려 '전부 봤다'는 오인을 만든다.
//   최소 1건은 예산을 넘겨도 렌더한다(빈 응답 금지).
export function fitBlocks(blocks: string[], budget: number): { kept: string[]; omitted: number } {
  const kept: string[] = []
  let left = budget
  for (const b of blocks) {
    if (kept.length > 0 && b.length > left) break
    kept.push(b)
    left -= b.length
  }
  return { kept, omitted: blocks.length - kept.length }
}

// 한국 세법 용어는 가운뎃점("·"), 공백, 하이픈 변형이 흔함.
// "연구·인력개발비" vs "연구 인력개발비" vs "연구인력개발비" 같은 패턴을 모두 잡기 위해
// 쿼리를 토큰으로 쪼개 AND 매칭 + 정규화 폼을 함께 검사한다.
export function tokenizeQuery(query: string): string[] {
  const lowered = String(query || "").toLowerCase()
  if (!lowered.trim()) return []
  const tokens = lowered
    .split(/[\s·.,;:/+&()\[\]{}'"`~!?<>|·•‧・/\\-]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  return Array.from(new Set(tokens))
}

// 토큰화한 쿼리 전체가 본문에 포함되는지 확인.
// 비어 있는 쿼리는 항상 true(필터 미적용).
// 공백·구두점을 제거한 collapsed form에서도 검사해 "연구·인력" vs "연구인력" 모두 잡는다.
export function matchesAllTokens(text: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true
  const haystack = String(text || "").toLowerCase()
  const collapsed = haystack.replace(/[\s·.,;:/+&()\[\]{}'"`~!?<>|·•‧・/\\-]+/gu, "")
  return tokens.every((token) => {
    if (haystack.includes(token)) return true
    const compactToken = token.replace(/[\s·.,;:/+&()\[\]{}'"`~!?<>|·•‧・/\\-]+/gu, "")
    return compactToken.length > 0 && collapsed.includes(compactToken)
  })
}

function asPositiveInt(value: unknown, fallback: number, max?: number): number {
  const n = Number(value ?? fallback)
  if (!Number.isFinite(n) || n < 1) return fallback
  return max ? Math.min(Math.floor(n), max) : Math.floor(n)
}

function requireString(name: string, value: unknown): string {
  const str = String(value ?? "").trim()
  if (!str) throw new TaxlawMcpError(`${name} is required`, ErrorCodes.INVALID_PARAM)
  return str
}

function validateDate(name: string, value: unknown): void {
  if (value !== undefined && value !== null && value !== "" && !/^\d{8}$/.test(String(value))) {
    throw new TaxlawMcpError(`${name} must be YYYYMMDD`, ErrorCodes.INVALID_PARAM)
  }
}

function validateDateRange(fromDate: unknown, toDate: unknown): void {
  validateDate("fromDate", fromDate)
  validateDate("toDate", toDate)
  if (fromDate && toDate && String(fromDate) > String(toDate)) {
    throw new TaxlawMcpError("fromDate must be earlier than or equal to toDate", ErrorCodes.INVALID_PARAM)
  }
}

function validateYear(value: unknown): void {
  if (value !== undefined && value !== null && value !== "" && !/^\d{4}$/.test(String(value))) {
    throw new TaxlawMcpError("year must be YYYY", ErrorCodes.INVALID_PARAM)
  }
}

function documentCodes(docTypeRaw: unknown, fallback = "reply"): string[] {
  const key = String(docTypeRaw || fallback)
  const codes = DOC_TYPE_CODES[key]
  if (!codes) throw new TaxlawMcpError(`Unknown docType: ${key}`, ErrorCodes.INVALID_PARAM)
  return codes
}

function sortField(sortRaw: unknown): string {
  const key = String(sortRaw || "date_desc")
  const field = SORT_FIELD_MAP[key]
  if (!field) throw new TaxlawMcpError(`Unknown sort: ${key}`, ErrorCodes.INVALID_PARAM)
  return field
}

function integratedCollections(raw: unknown): string[] {
  const values = Array.isArray(raw)
    ? raw.map(String)
    : raw
      ? [String(raw)]
      : ["all"]
  if (values.includes("all")) return [...INTEGRATED_COLLECTIONS]

  const allowed = new Set<string>(INTEGRATED_COLLECTIONS)
  const invalid = values.filter((value) => !allowed.has(value))
  if (invalid.length > 0) {
    throw new TaxlawMcpError(`Unknown collection: ${invalid.join(", ")}`, ErrorCodes.INVALID_PARAM)
  }
  return [...new Set(values)]
}

function integratedSort(raw: unknown): string {
  const key = String(raw || "score")
  const field = INTEGRATED_SORT_MAP[key]
  if (!field) throw new TaxlawMcpError(`Unknown sort: ${key}`, ErrorCodes.INVALID_PARAM)
  return field
}

export function normalizeDetailId(id: string): string {
  const trimmed = id.trim()
  const prefixed = trimmed.match(/^001_(\d+)$/)
  return prefixed ? prefixed[1] : trimmed
}

// NTS 문서번호·회신번호는 공백·하이픈·가운뎃점 표기가 섞여 노출될 수 있다.
// 직접조회는 부분일치가 아니라 정규화 후 완전일치만 허용해 오인 문서 회수를 막는다.
export function normalizeDocumentNumber(value: unknown): string {
  return cleanText(value).replace(/[\s\-–—.·]/gu, "").toLowerCase()
}

export type DocumentNumberMatch = "document" | "reply"

export function matchDocumentNumber(item: Record<string, unknown>, value: unknown): DocumentNumberMatch | null {
  const wanted = normalizeDocumentNumber(value)
  if (!wanted) return null
  const documentNumber = normalizeDocumentNumber(item.NTST_DCM_DSCM_CNTN ?? item.ntstDcmDscmCntn)
  if (documentNumber && documentNumber === wanted) return "document"
  const replyNumber = normalizeDocumentNumber(item.NTST_DCM_RPLY_CNTN ?? item.ntstDcmRplyCntn)
  if (replyNumber && replyNumber === wanted) return "reply"
  return null
}

export function normalizeTaxlawPath(value: unknown, fallback = "/index.do"): string {
  // 제어문자(C0·DEL) 제거 — 경로 주입 심화방어.
  const path = String(value || fallback).trim().replace(/[\x00-\x1f\x7f]/g, "")
  if (!path || !path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
    throw new TaxlawMcpError("path/refererPath must be a relative taxlaw.nts.go.kr path starting with /", ErrorCodes.INVALID_PARAM)
  }
  return path
}

// null·""·빈 배열·빈 객체를 재귀 제거(0/false는 보존). NTS 원시 JSON은 null 필드가 대다수라
// 비-full 응답의 신호밀도를 높인다(추가 호출 없는 인메모리 변환). full 모드는 원시 그대로.
export function pruneEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    const arr = value.map(pruneEmpty).filter((v) => v !== undefined)
    return arr.length ? arr : undefined
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const pv = pruneEmpty(v)
      if (pv !== undefined) out[k] = pv
    }
    return Object.keys(out).length ? out : undefined
  }
  if (value === null || value === "") return undefined
  return value
}

function stringifyJson(value: unknown, full = false): string {
  const json = JSON.stringify(full ? value : pruneEmpty(value) ?? {}, null, 2)
  return truncate(json, full ? 50000 : 15000)
}

function getSetCookieHeaders(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] }
  const cookies = extended.getSetCookie?.()
  if (cookies && cookies.length > 0) return cookies

  const single = headers.get("set-cookie")
  if (!single) return []
  return single.split(/,(?=\s*[^;,=\s]+=[^;,]+;)/g).map((s) => s.trim())
}

const SESSION_TTL_MS = 5 * 60 * 1000
let cachedSession: { cookie: string; fetchedAt: number } | null = null

async function fetchTaxlawSession(refererPath: string, force = false): Promise<string> {
  if (!force && cachedSession && Date.now() - cachedSession.fetchedAt < SESSION_TTL_MS) {
    return cachedSession.cookie
  }
  const response = await fetchWithRetry(`${TAXLAW_BASE}${refererPath}`, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "user-agent": userAgent(),
    },
  })
  if (!response.ok) {
    await consume(response)
    throw new TaxlawMcpError(`Taxlaw session init failed (${response.status})`, ErrorCodes.API_ERROR)
  }

  const cookie = getSetCookieHeaders(response.headers)
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ")
  if (!cookie) throw new TaxlawMcpError("Taxlaw session cookie was not returned.", ErrorCodes.API_ERROR)
  cachedSession = { cookie, fetchedAt: Date.now() }
  return cookie
}

async function postTaxlawAction<T>(actionId: string, paramData: unknown, refererPath: string): Promise<T> {
  const cacheKey = `nts:${actionId}:${JSON.stringify(paramData ?? null)}`
  const cached = cacheGet(cacheKey)
  if (cached !== null) return JSON.parse(cached) as T
  const data = await postTaxlawActionAttempt<T>(actionId, paramData, refererPath, true)
  try {
    cacheSet(
      cacheKey,
      JSON.stringify(data),
      NTS_DETAIL_ACTION_IDS.has(actionId) ? NTS_DETAIL_CACHE_TTL_MS : NTS_DEFAULT_CACHE_TTL_MS,
    )
  } catch { /* 직렬화 불가 응답은 캐시 생략 */ }
  return data
}

async function postTaxlawActionAttempt<T>(
  actionId: string,
  paramData: unknown,
  refererPath: string,
  allowRefresh: boolean,
): Promise<T> {
  const cookie = await fetchTaxlawSession(refererPath)
  const form = new URLSearchParams()
  form.set("actionId", actionId)
  form.set("paramData", JSON.stringify(paramData))

  const { response, text: rawBody } = await fetchTextWithRetry(`${TAXLAW_BASE}/action.do`, {
    method: "POST",
    headers: {
      accept: "application/json, text/javascript, */*; q=0.01",
      "content-type": "application/x-www-form-urlencoded",
      origin: TAXLAW_BASE,
      referer: `${TAXLAW_BASE}${refererPath}`,
      cookie,
      "user-agent": userAgent(),
    },
    body: form.toString(),
  })

  if (!response.ok) {
    // v0.27.2 — body는 fetchTextWithRetry가 이미 deadline 안에서 읽었다(consume 불필요).
    if (allowRefresh && (response.status === 401 || response.status === 403)) {
      cachedSession = null
      return postTaxlawActionAttempt<T>(actionId, paramData, refererPath, false)
    }
    throw new TaxlawMcpError(`Taxlaw action.do failed (${response.status})`, ErrorCodes.API_ERROR)
  }

  let payload: TaxlawActionResponse<T>
  try {
    payload = JSON.parse(rawBody) as TaxlawActionResponse<T>
  } catch (error) {
    if (allowRefresh) {
      cachedSession = null
      return postTaxlawActionAttempt<T>(actionId, paramData, refererPath, false)
    }
    throw new TaxlawMcpError(
      `Taxlaw action.do JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
      ErrorCodes.PARSE_ERROR,
    )
  }

  if (payload.status !== "SUCCESS" || !payload.data) {
    throw new TaxlawMcpError(
      `Taxlaw action.do returned ${payload.status}: ${payload.message || "no message"}`,
      ErrorCodes.API_ERROR,
    )
  }
  return payload.data
}

async function consume(response: Response): Promise<void> {
  try { await response.text() } catch { /* ignore */ }
}

const FETCH_TIMEOUT_MS = 15000
// v0.27.2 — 개별 fetch 타임아웃을 env로 조정 가능(기본 15초). 기존 튜너블(TAXLAW_TOOL_BUDGET_MS,
//   TAXLAW_RECENT_THRESHOLD_YEARS)과 동일한 함수형 패턴. 단위테스트가 짧은 타임아웃으로
//   'body 정지 시 abort가 실제로 끊는지'를 검증하는 데도 쓴다.
export function fetchTimeoutMs(): number {
  const raw = Number(process.env.TAXLAW_FETCH_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : FETCH_TIMEOUT_MS
}

// v0.21.0(#G14) — 도구 콜 단위 시간예산(tail-latency 방어, CHANGELOG DEFER #6 해소).
// CallTool 디스패치 진입점에서 store를 설정하고, 모든 네트워크 왕복(fetchWithRetry)이 매 시도 전 남은 예산을
// 확인한다. store 부재(테스트·직접 함수 호출) = 무제한(기존 동작 보존). ALS라 병렬 fetch도 같은 deadline을 공유.
interface ToolBudget { deadlineAt: number; budgetMs: number }
const toolBudgetStore = new AsyncLocalStorage<ToolBudget>()
const DEFAULT_TOOL_BUDGET_MS = 90000

// 남은 예산(ms) 순수 계산 — deadlineAt 미지정(=store 부재)이면 Infinity(무제한). 테스트 표면.
export function remainingBudgetMs(deadlineAt: number | undefined, now = Date.now()): number {
  if (deadlineAt === undefined) return Infinity
  return deadlineAt - now
}

function currentBudget(): ToolBudget | undefined {
  return toolBudgetStore.getStore()
}

// env(TAXLAW_TOOL_BUDGET_MS) 파싱 — 기본 90000, 0/음수/비수치는 아래 runWithToolBudget에서 무제한 처리.
function parseToolBudgetMs(): number {
  const raw = process.env.TAXLAW_TOOL_BUDGET_MS
  if (raw === undefined || raw.trim() === "") return DEFAULT_TOOL_BUDGET_MS
  const n = Number(raw)
  return Number.isFinite(n) ? n : DEFAULT_TOOL_BUDGET_MS
}

// 도구 실행을 시간예산 store로 감싼다. budget<=0이면 store 없이 실행(무제한 = 기존 동작).
function runWithToolBudget<T>(fn: () => Promise<T>): Promise<T> {
  const budgetMs = parseToolBudgetMs()
  if (budgetMs <= 0) return fn()
  return toolBudgetStore.run({ deadlineAt: Date.now() + budgetMs, budgetMs }, fn)
}

// v0.27.2(리뷰 P1) — fetch와 body 읽기를 하나의 AbortController/타이머 아래로 묶는다.
//   종전: 헤더 수신 직후 clearTimeout하고 Response를 반환 → 호출부의 .json()/.text()는
//   15초 fetch 타임아웃도 90초 도구 예산도 적용받지 못했다. 서버가 헤더만 보내고 본문 스트림을
//   끝내지 않으면 도구 호출이 사실상 무한 대기하고, 에이전트가 영구히 막힌다(최악의 실패 모드).
//   read를 넘기면 body를 타이머 안에서 읽고, 중단 시 abort가 스트림까지 실제로 끊는다.
//   read=null(세션 초기화처럼 헤더만 쓰는 경로)은 종전 동작 그대로.
// ── v0.27.7 상류 서킷 브레이커 ────────────────────────────────────────────
// 계기(실사고 2026-08-07): 대량 검증 루프 중 NTS가 느려지기 시작했는데, 이 코드가 호출마다
//   최대 4회 재시도(연결 타임아웃 10s×4 + 백오프)를 계속 던져 트래픽을 4배로 증폭했다.
//   결과: 스로틀링이 IP 차단으로 승격(taxlaw/hometax/www.nts 전부 차단, 남들은 정상 접속).
//   사용자 입장에서도 호출 1건당 47초를 기다린 뒤 실패를 받았다(실측).
// 설계:
//   · 호스트별로 격리 — NTS가 죽어도 법제처 경로는 영향 없음(실측으로 확인된 격리 특성 유지).
//   · '연결 실패'만 집계 — HTTP 4xx/5xx는 서버가 응답한 것이므로 건강 신호로 취급하지 않는다.
//   · 1회 실패부터 재시도를 0으로 낮추고(빠른 실패), threshold회 연속 실패면 회로를 연다.
//   · 쿨다운은 지수 증가(상한 10분). 성공 1회면 즉시 닫힌다(half-open 성공).
interface CircuitState { fails: number; openUntil: number; cooldownMs: number }
const circuits = new Map<string, CircuitState>()
const envNum = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d }
const circuitThreshold = () => envNum("TAXLAW_CIRCUIT_THRESHOLD", 3)
const circuitBaseMs = () => envNum("TAXLAW_CIRCUIT_COOLDOWN_MS", 60000)
const CIRCUIT_MAX_MS = 10 * 60 * 1000

function hostOf(url: string): string { try { return new URL(url).host } catch { return "unknown" } }
function circuitOf(host: string): CircuitState {
  let c = circuits.get(host)
  if (!c) { c = { fails: 0, openUntil: 0, cooldownMs: circuitBaseMs() }; circuits.set(host, c) }
  return c
}
// 연결 실패(네트워크 도달 불가·타임아웃)만 카운트. HTTP 상태 실패는 제외.
function isConnectFailure(err: unknown): boolean {
  const m = err instanceof Error ? `${err.name} ${err.message}${(err as Error & { cause?: Error }).cause?.message ?? ""}` : String(err)
  return /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|Connect Timeout|AbortError|aborted|socket hang up|network/i.test(m)
}
function circuitOpenMs(host: string): number {
  const c = circuits.get(host)
  if (!c || !c.openUntil) return 0
  const left = c.openUntil - Date.now()
  if (left <= 0) { c.openUntil = 0; return 0 }   // 쿨다운 종료 → half-open(1회 시도 허용)
  return left
}
function circuitRecordFailure(host: string): void {
  const c = circuitOf(host)
  c.fails++
  if (c.fails >= circuitThreshold()) {
    c.cooldownMs = Math.min(c.openUntil ? c.cooldownMs * 2 : circuitBaseMs(), CIRCUIT_MAX_MS)
    c.openUntil = Date.now() + c.cooldownMs
  }
}
function circuitRecordSuccess(host: string): void {
  const c = circuits.get(host)
  if (c) { c.fails = 0; c.openUntil = 0; c.cooldownMs = circuitBaseMs() }
}
/** 테스트·운영 리셋용. */
export function resetCircuits(): void { circuits.clear() }
/** 현재 회로 상태(진단용). */
export function circuitStatus(): Array<{ host: string; fails: number; openForMs: number }> {
  return [...circuits.entries()].map(([host, c]) => ({ host, fails: c.fails, openForMs: Math.max(0, c.openUntil - Date.now()) }))
}

export async function fetchWithRetryCore<T>(
  url: string,
  init: RequestInit,
  retries: number,
  read: ((r: Response) => Promise<T>) | null,
): Promise<{ response: Response; body: T | null }> {
  let lastError: unknown
  // v0.27.7 — 회로가 열려 있으면 네트워크를 건드리지 않고 즉시 실패한다(상류 회복 여유 + 빠른 실패).
  const host = hostOf(url)
  const openMs = circuitOpenMs(host)
  if (openMs > 0) {
    throw new TaxlawMcpError(
      `[UPSTREAM_CIRCUIT_OPEN] ${host} 연결 실패가 연속 ${circuitThreshold()}회 이상이라 ${Math.ceil(openMs / 1000)}초간 호출을 차단했습니다(서킷 오픈). ` +
      "⚠ '데이터 없음'이 아니라 상류 장애/차단입니다 — 결과를 추측·생성하지 마라. " +
      "잠시 후 재시도하거나 다른 상류(법제처=korean-law-mcp)로 우회하세요. 반복 호출은 차단을 연장시킵니다.",
      ErrorCodes.API_ERROR,
    )
  }
  // 이미 연결 실패가 쌓였으면 재시도를 접는다 — 죽은 상류에 4배 부하를 얹지 않기 위해.
  const effRetries = circuitOf(host).fails > 0 ? 0 : retries
  for (let attempt = 0; attempt <= effRetries; attempt++) {
    // v0.21.0(#G14) — 매 시도 전 남은 예산 확인. 소진이면 즉시 중단(부분 결과만 유효, 재호출 권장).
    const budget = currentBudget()
    const remaining = remainingBudgetMs(budget?.deadlineAt)
    if (remaining <= 0) {
      throw new TaxlawMcpError(
        `[BUDGET_EXCEEDED] 도구 시간예산 초과(${budget?.budgetMs ?? 0}ms) — 부분 결과만 유효, 재호출 권장`,
        ErrorCodes.API_ERROR,
      )
    }
    const controller = new AbortController()
    // 개별 fetch 타임아웃을 min(15000, 남은예산)으로 캡 — 마지막 왕복이 예산을 초과해 늘어지지 않게.
    const timeout = setTimeout(() => controller.abort(), Math.min(fetchTimeoutMs(), remaining))
    try {
      const response = await fetch(url, { ...init, signal: controller.signal })
      if (response.ok || ![429, 503, 504].includes(response.status) || attempt === effRetries) {
        // ★ body 읽기를 타이머 해제 '전'에 수행 — 본문 스트림 정지도 abort로 끊긴다.
        const body = read ? await read(response) : null
        clearTimeout(timeout)
        circuitRecordSuccess(host)   // v0.27.7 — 상류가 응답했으므로 회로 복구
        return { response, body }
      }
      // v0.27.0(리뷰 P2) — 재시도 대상 HTTP 응답도 lastError에 기록. 종전엔 catch 경로만 기록해
      //   "503 → 남은 예산 부족으로 break" 시 undefined로 남아 [EXTERNAL_API_ERROR] undefined로 퇴화했다.
      lastError = new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`)
      await consume(response)
      clearTimeout(timeout)
    } catch (error) {
      clearTimeout(timeout)
      lastError = error
      // 연결 장애는 첫 실패부터 빠르게 종료해 같은 호출의 재시도 증폭을 막는다.
      if (isConnectFailure(error)) break
      if (attempt === effRetries) break
    }
    // v0.21.0(#G14) — 재시도 백오프도 남은 예산이 백오프보다 적으면 중단(대기 후 다시 소진 확인의 낭비 제거).
    const backoff = 700 * Math.pow(2, attempt)
    if (remainingBudgetMs(currentBudget()?.deadlineAt) <= backoff) break
    await sleep(backoff)
  }

  const err = lastError instanceof Error ? lastError : new Error(String(lastError))
  const cause = (err as Error & { cause?: unknown }).cause
  const causeText = cause instanceof Error ? `: ${cause.message}` : ""
  // v0.27.7 — 연결 실패만 회로에 기록(HTTP 상태 실패는 상류가 살아있다는 뜻이므로 제외).
  if (isConnectFailure(err)) circuitRecordFailure(host)
  throw new TaxlawMcpError(`${err.message}${causeText}`, ErrorCodes.API_ERROR)
}

// 헤더만 쓰는 경로(세션 초기화) — body를 읽지 않으므로 종전 동작과 동일.
async function fetchWithRetry(url: string, init: RequestInit, retries = 3): Promise<Response> {
  return (await fetchWithRetryCore<never>(url, init, retries, null)).response
}

// v0.27.2 — body까지 deadline 보호가 필요한 경로(전 호출부 기본). 본문 정지 시 abort로 끊긴다.
async function fetchTextWithRetry(
  url: string,
  init: RequestInit,
  retries = 3,
): Promise<{ response: Response; text: string }> {
  const { response, body } = await fetchWithRetryCore<string>(url, init, retries, (r) => r.text())
  return { response, text: body ?? "" }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(concurrency, items.length))
  const worker = async (): Promise<void> => {
    while (true) {
      const i = nextIndex++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

function userAgent(): string {
  return process.env.TAXLAW_USER_AGENT ||
    `taxlaw-nts-mcp/${VERSION} (+https://github.com/kim-go-chon/taxlaw-nts-mcp)`
}

// v0.10.0 — 도구결과 캐시(LRU+TTL). 같은 자원을 요지→full=true→targetYear로 2~3회 재조회하는
// 패턴이 잦은데 법제처 법령 XML·NTS 문서 응답은 세션 내 사실상 불변이라 fetch 관문에서 캐시한다.
// 성공 응답만 캐시(쿠키 갱신·재시도 경로와 충돌 없음). lawName→MST 해소도 lawSearch URL 캐시로 함께 커버.
const CACHE_MAX_ENTRIES = 200
const CACHE_MAX_TOTAL_CHARS = 64_000_000
const CACHE_MAX_ENTRY_CHARS = 8_000_000
const MOLEG_CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 법령 XML — 사실상 불변
const NTS_DETAIL_CACHE_TTL_MS = 12 * 60 * 60 * 1000 // 문서 상세 본문
const NTS_DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000 // 검색 등 — 신규 문서 유입 여지
const NTS_DETAIL_ACTION_IDS = new Set(["ASIQTB002PR01"])

const responseCache = new Map<string, { value: string; expiresAt: number }>()
let responseCacheChars = 0

function cacheGet(key: string): string | null {
  const hit = responseCache.get(key)
  if (!hit) return null
  if (Date.now() > hit.expiresAt) {
    responseCache.delete(key)
    responseCacheChars -= hit.value.length
    return null
  }
  responseCache.delete(key) // LRU 갱신(재삽입으로 최신화)
  responseCache.set(key, hit)
  return hit.value
}

function cacheSet(key: string, value: string, ttlMs: number): void {
  if (value.length > CACHE_MAX_ENTRY_CHARS) return
  const prev = responseCache.get(key)
  if (prev) {
    responseCache.delete(key)
    responseCacheChars -= prev.value.length
  }
  responseCache.set(key, { value, expiresAt: Date.now() + ttlMs })
  responseCacheChars += value.length
  while (responseCache.size > CACHE_MAX_ENTRIES || responseCacheChars > CACHE_MAX_TOTAL_CHARS) {
    const oldest = responseCache.keys().next().value
    if (oldest === undefined) break
    const entry = responseCache.get(oldest)
    responseCache.delete(oldest)
    if (entry) responseCacheChars -= entry.value.length
  }
}

export function decodeHtml(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num: string) => String.fromCodePoint(parseInt(num, 10)))
    .replace(/&amp;/g, "&")
}

// v0.25.0(리뷰 SEC-4b) — <script>/<style> 블록 제거를 선형 스캔으로. 종전 /<tag[\s\S]*?<\/tag>/ lazy 정규식은
// 무종결 '<script' 다수(악성·파손 응답)에서 O(n²) ReDoS — 실측 1M자 68s 동기 블록. 닫는 태그가 없으면
// 그 지점 이후를 폐기한다(종전엔 미매칭 방치로 스크립트 원문이 텍스트로 누출 — 폐기가 더 안전).
function stripTagBlocks(html: string, tag: string): string {
  const lower = html.toLowerCase()
  const openTok = `<${tag}`
  const closeTok = `</${tag}`
  let out = ""
  let i = 0
  while (i < html.length) {
    const s = lower.indexOf(openTok, i)
    if (s === -1) { out += html.slice(i); break }
    out += html.slice(i, s)
    const c = lower.indexOf(closeTok, s + openTok.length)
    if (c === -1) break
    const gt = lower.indexOf(">", c + closeTok.length)
    i = gt === -1 ? html.length : gt + 1
  }
  return out
}

export function htmlToText(html: string): string {
  const prepared = stripTagBlocks(stripTagBlocks(html, "script"), "style")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")

  return decodeHtml(prepared)
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
}

export function cleanText(value: unknown): string {
  const raw = String(value ?? "")
  const withoutHighlights = raw.replace(/<!HS>|<!HE>/g, "")
  const text = /<[^>]+>/.test(withoutHighlights) ? htmlToText(withoutHighlights) : decodeHtml(withoutHighlights)
  return text.replace(/\s+/g, " ").trim()
}

function queryTerms(query: unknown): string[] {
  const cleaned = cleanText(query).toLowerCase()
  if (!cleaned) return []
  return [...new Set([cleaned, ...cleaned.split(/\s+/)].filter((term) => term.length >= 2))]
}

function firstMatchIndex(text: string, query: unknown): number {
  const lowered = text.toLowerCase()
  for (const term of queryTerms(query)) {
    const index = lowered.indexOf(term)
    if (index >= 0) return index
  }
  return -1
}

function highlightedSnippet(value: unknown, query: unknown, radius = 140): string {
  const raw = String(value ?? "")
  if (!raw) return ""
  const text = cleanText(raw)
  if (!text) return ""

  const highlightIndex = raw.indexOf("<!HS>")
  const index = highlightIndex >= 0 ? cleanText(raw.slice(0, highlightIndex)).length : firstMatchIndex(text, query)
  if (index < 0) return ""

  const start = Math.max(0, index - radius)
  const end = Math.min(text.length, index + radius)
  const prefix = start > 0 ? "..." : ""
  const suffix = end < text.length ? "..." : ""
  return `${prefix}${text.slice(start, end).trim()}${suffix}`
}

function firstValue(row: AnyRecord, keys: string[]): unknown {
  for (const key of keys) {
    const value = row[key]
    if (value !== undefined && value !== null && String(value).trim() !== "") return value
  }
  return undefined
}

export function normalizeDate(value: unknown): string {
  const digits = String(value ?? "").replace(/\D/g, "")
  if (digits.length < 8) return "N/A"
  return `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6, 8)}`
}

export function compactBodyText(text: string, full = false, code?: string): string {
  if (full) return truncate(text, 45000)
  const relatedLawIndex = text.search(/\n?3\.\s*관련\s*법령/)
  // v0.25.0(리뷰 O2-1) — '관련 법령' 절 절단을 무언 손실 대신 명시 마커로(인용 조문 원문이 조용히 사라지는 것 방지).
  const compact = relatedLawIndex >= 0
    ? `${text.slice(0, relatedLawIndex).trim()}\n…[이하 '관련 법령' 절 ${(text.length - relatedLawIndex).toLocaleString()}자 생략 — 전문은 full=true]`
    : text
  // v0.10.0 — 판례·결정례(05~10)는 '주문·판단(결론부)'이 본문 뒤쪽에 있어 head-only 압축이
  // 결론부를 항상 자른다(→ full=true 45000자 재조회 강제). head+tail 분할로 결론부를 요약본에
  // 보존해 트리아지 단계의 재조회를 줄인다. 인용 전 full=true 검증 의무는 그대로(가드 유지).
  if (code && PRECEDENT_CODES.has(String(code).padStart(2, "0")) && compact.length > 8000) {
    const head = compact.slice(0, 5000)
    const tail = compact.slice(-2500)
    const omitted = compact.length - head.length - tail.length
    return `${head}\n…[중략 ${omitted.toLocaleString()}자 — 전문은 full=true]…\n${tail}`
  }
  return truncate(compact, 8000)
}

// v0.9.14 — 판례·결정례(05~10: 과세전적부·이의·심사·심판·판례·헌재)의 '판단·주문(결론부)'은
// 본문 뒤쪽에 위치해 기본(full=false) 8000자 truncate에 자주 잘린다. 요지·처분개요만 보고 결론을
// 단정하면 요지와 실제 주문/판단이 어긋나는 오류가 발생한다(예: 요지 '에누리 해당'↔판결 '에누리 아님·과세').
// 잘림 시 full=true 재조회를 강제 안내하고, 요지-결과 정합성·결정구분 표기 가드를 함께 부착한다.
// v0.16.0(G3) — 결정/판결의 '결과 방향'을 명시 결론어로 분류(국승=과세유지 / 국패=납세자유리). 모호하면 "".
// 요지(gist)와 주문(결론부)의 분류가 충돌하면 요지≠holding 능동 경고에 사용. 복합주문 오탐 방지 위해 명시어만.
export function classifyVerdict(text: string): "win" | "lose" | "" {
  const t = String(text || "")
  const win = /기각한다|각하한다|심판청구를 기각|청구를 기각|국승|처분은 (?:정당|적법)|잘못이 없는 것으로 판단/.test(t)
  const lose = /취소한다|취소합니다|인용한다|일부 인용|국패|경정한다|경정합니다|처분은 (?:부당|위법)/.test(t)
  if (win && !lose) return "win"
  if (lose && !win) return "lose"
  return ""
}

export function detectHoldingTruncation(opts: { code?: string; fullBody: string; shownBody: string; isFull: boolean; gist?: string; structuredReply?: string }): string[] {
  const { code, fullBody, shownBody, isFull, gist, structuredReply } = opts
  if (!fullBody) return []
  // v0.21.0(#G5) — 해석례(01~04) 회신 tail 소실 가드(판례 05~10 경로와 분리). 구조화 회신 필드(CNTN 등)가
  //   비어 결론이 오직 잘린 본문에만 있을 때만 능동 경고 — 회신 필드가 채워졌으면 결론은 이미 전량 표시돼 무경고.
  if (code && QUESTION_CODES.has(code.padStart(2, "0"))) {
    if (isFull) return []
    const wasCut = shownBody.length < fullBody.length || /\[truncated to/.test(shownBody)
    if (wasCut && !String(structuredReply || "").trim()) {
      return [
        "── 회신·결론부 확인 (해석례) ──",
        "⚠ 회신·결정 결론부가 잘렸을 수 있음(해석례 tail 소실 가능) → full=true로 재조회",
      ]
    }
    return []
  }
  if (!code || !PRECEDENT_CODES.has(code.padStart(2, "0"))) return []
  if (isFull) {
    // v0.16.0(G3) — full=true에도 요지≠holding 능동 검사: 요지 결론어와 주문(결론부) 결과가 '달라 보이면'만 ⚠
    //   (모순 신호 없으면 full 응답은 깨끗이 — 평시 노이즈 0). full을 받고도 요지만 읽는 위험 구간 차단.
    const gv = classifyVerdict(gist || "")
    const hv = classifyVerdict(fullBody.slice(-1600))
    if (gv && hv && gv !== hv) {
      return [
        "── 요지·주문 결과 불일치 ⚠⚠ (판례·결정례) ──",
        "요지의 결론 방향과 주문(결론부)이 달라 보입니다 — 분류·결론은 반드시 주문(holding) 기준으로 표기하고 요지만으로 단정하지 마세요(요지≠holding).",
        `(감지: 요지=${gv === "win" ? "기각·과세유지 취지" : "취소·인용 취지"} / 주문=${hv === "win" ? "기각·과세유지" : "취소·인용"})`,
      ]
    }
    return []
  }
  const wasCut = shownBody.length < fullBody.length || /\[truncated to/.test(shownBody)
  const lines = ["── 판단·결론부 확인 (판례·결정례) ──"]
  if (wasCut) {
    lines.push(
      "⚠ 본문이 잘려 '주문·판단(결론부)'이 이번 응답(요약본)에 누락됐을 수 있습니다. 요지·처분개요만으로 결론을 단정하지 마세요.",
      "  → 결론·판단근거를 인용/분류하기 전 반드시 full=true로 재조회하여 주문 + '3. 심리 및 판단'의 결론 문단을 직접 확인하세요.",
    )
  }
  lines.push(
    "[요지-결과 정합성] 요지는 손실 요약이라 주문·판단과 어긋날 수 있습니다. 요지가 '에누리/인정' 취지인데 결과가 기각·국승(과세)이거나 그 반대이면 모순 신호 → full=true 본문 필독.",
    "[결정구분 표기] 인용/기각/각하/재조사는 결정문의 국세기본법 제65조제1항(또는 판결 주문) 기준으로 표기하고, 목록 메타데이터(결정 칸)에만 의존하지 마세요.",
  )
  return lines
}

function detailTextFromHtmlList(list?: TaxlawDetailData["ASIQTB002PR01"]["dcmHwpEditorDVOList"]): string {
  const item = list?.find((entry) => entry.dcmFleTy === "html" && entry.dcmFleByte) ||
    list?.find((entry) => entry.dcmFleByte)
  return item?.dcmFleByte ? htmlToText(item.dcmFleByte) : ""
}

function docLabel(code: string | undefined, fallback?: string): string {
  if (!code) return fallback || "문서"
  return DOC_TYPE_LABELS[code.padStart(2, "0")] || fallback || "문서"
}

function docCodeFromType(raw: unknown): string | undefined {
  if (!raw) return undefined
  const codes = documentCodes(raw, "reply")
  return codes.length === 1 ? codes[0] : undefined
}

export function refererForDoc(code: string | undefined, id: string): string {
  const normalizedCode = code?.padStart(2, "0")
  // v0.20.0(#7) — 표시 원문 URL의 id를 내부 조회 경로(getTaxlawDocumentText·research_taxlaw_topic)와 동일하게 정규화(001_ 접두 제거).
  // 정규화 없으면 001_ 접두 DOC_ID 행의 링크가 서버 canonical id와 어긋남. normalizeDetailId는 멱등이라 이미 정규화된 콜러엔 무해.
  const nid = normalizeDetailId(id)
  if (normalizedCode && PRECEDENT_CODES.has(normalizedCode)) {
    return `/pd/USEPDA002P.do?ntstDcmId=${encodeURIComponent(nid)}`
  }
  return `/qt/USEQTA002P.do?ntstDcmId=${encodeURIComponent(nid)}`
}

function totalCount(data: TaxlawSearchData["ASIPDI002PR01"], codes: string[]): number {
  const categories = data.top?.[0]?.categoryMap?.SUB_ID_CATEGORY || []
  return categories
    .filter((c) => codes.includes(c.name.replace(/^001_/, "")))
    .reduce((sum, c) => sum + Number(c.count || 0), 0)
}

function formatIntegratedTitle(row: AnyRecord): string {
  return cleanText(firstValue(row, [
    "TTL",
    "FRML_NM",
    "NM",
    "TEXT_KRN_NM",
    "TEXT_UQNM",
    "NTST_PLCN_BK_TTL",
    "STD_TITLE",
    "SJT_CL_NM",
  ])) || "(제목 없음)"
}

function formatIntegratedSummary(row: AnyRecord): string {
  return cleanText(firstValue(row, [
    "GIST_CNTN",
    "CNTN",
    "TEXT_KRN_CNTN",
    "FILE_CN",
    "ANSWER_STD_CONTENT",
    "NTST_PLCN_BK_DSCM_CNTN",
  ]))
}

function formatIntegratedId(row: AnyRecord): string {
  return cleanText(firstValue(row, ["DOC_ID", "DOCID", "REQ_STD_ID", "NTST_PLCN_BK_ID"])) || "N/A"
}

// v0.16.2 — statute(조세법령/일반법령) 행은 raw 응답에 조번호(TEXT_UQNM="제22조")와
// 조제목(TEXT_KRN_NM="자동차정비공장의 범위")이 들어 있으나, formatIntegratedTitle이
// NM(법령명)을 먼저 잡아 둘 다 버린다. 그 결과 위임조문(영→칙) 추적 시 본문은 잡혀도
// "어느 조인지"를 결과만으로 알 수 없어 조번호 사냥(조문 1개씩 더듬기)을 유발한다.
// 법령 행에 한해 제목에 "제N조(조제목)"를 결합해 한 줄로 조 위치를 노출한다.
export function statuteArticleSuffix(row: AnyRecord): string {
  const label = cleanText(firstValue(row, ["LBL1_TTL", "LBL1_NM"]))
  if (!/법령/.test(label)) return "" // 해석례·판례·별표·통칙(2-1-3형)·행정규칙 행은 제외
  const joNo = cleanText(firstValue(row, ["TEXT_UQNM"]))
  // 단일 조 토큰만("제N조" 또는 "제N조의M"). 통칙형(2-1-3)·복합("제22조 및 제23조")·항 단위는 배제.
  if (!joNo || !/^제\d+조(의\d+)?$/.test(joNo)) return ""
  const joTitle = cleanText(firstValue(row, ["TEXT_KRN_NM"]))
  return joTitle && joTitle !== joNo ? `${joNo}(${joTitle})` : joNo
}

// v0.9.13 — 통합검색 결과 행이 행정규칙(훈령·예규·고시·지침)인지 분류 라벨로 판별.
// formatIntegratedRow와 동일한 라벨 필드를 사용. "고시서면질의" 같은 해석례 docType 라벨은
// ADMIN_RULE_LABEL_RE의 앵커(^…$) 덕에 오탐되지 않는다.
export function isAdminRuleRow(row: AnyRecord): boolean {
  const firstLabel = cleanText(firstValue(row, ["LBL1_TTL", "LBL1_NM", "STTT_CL_NM", "NTST_DCM_CL_NM", "REQ_TP_NM"]))
  const secondLabel = cleanText(firstValue(row, ["LBL2_TTL", "LBL2_NM", "SJT_CL_NM", "NTST_TLAW_CL_NM", "MAIN_CATEGORY"]))
  return ADMIN_RULE_LABEL_RE.test(firstLabel) || ADMIN_RULE_LABEL_RE.test(secondLabel)
}

function formatIntegratedRow(row: AnyRecord, collectionName: string, verbose = true): string {
  const id = formatIntegratedId(row)
  const title = formatIntegratedTitle(row)
  const firstLabel = cleanText(firstValue(row, ["LBL1_TTL", "LBL1_NM", "STTT_CL_NM", "NTST_DCM_CL_NM", "REQ_TP_NM"]))
  const secondLabel = cleanText(firstValue(row, ["LBL2_TTL", "LBL2_NM", "SJT_CL_NM", "NTST_TLAW_CL_NM", "MAIN_CATEGORY"]))
  const docNo = cleanText(firstValue(row, ["NTST_DCM_DSCM_CNTN", "DOCU_NO_STR1", "PMG_NO", "FRML_SN"]))
  const replyNo = cleanText(firstValue(row, ["NTST_DCM_RPLY_CNTN"]))
  const date = normalizeDate(firstValue(row, ["DCM_RGT_DTM_S", "DCM_RGT_DTM", "PMG_DT", "ENFR_DT", "PLCN_DT", "REGST_DT", "FRS_RGT_DTM", "DATE"]))
  const summary = formatIntegratedSummary(row)

  const statuteSuffix = statuteArticleSuffix(row)
  const titleWithJo = statuteSuffix ? `${title} ${statuteSuffix}`.trim() : title
  const lines = [`[${id}] ${titleWithJo || "(제목 없음)"}`]
  const labels = [firstLabel, secondLabel].filter(Boolean).join(" / ")
  if (labels) lines.push(`  분류: ${labels}`)
  if (docNo || replyNo) lines.push(`  문서번호: ${docNo || "N/A"}${replyNo ? ` / 회신번호: ${replyNo}` : ""}`)
  lines.push(`  일자: ${date}`)
  // v0.9.9 — verbose=false 시 내용(요약) 생략(메타데이터만). 검증·헬스체크용.
  if (verbose) {
    if (summary) {
      lines.push(`  내용: ${truncate(summary, collectionName === "hometaxCnslThan" ? 600 : 500)}`)
    } else if (!title && !labels && !docNo && !replyNo) {
      lines.push("  내용: (메타데이터 부족 — 본문 없음. 추가 조회 도구로 확인 필요)")
    }
  }
  if ((collectionName === "question" || collectionName === "precedent") && id !== "N/A") {
    // v0.20.0 — 해석례·심판례·판결 제시 시 원문 링크 병기 강제. 실제 DOC_ID로 NTS 원문 URL 조립(임의 생성 아님).
    const nid = normalizeDetailId(id) // v0.20.0(#7) — 검색·조회 경로와 동일 정규화(001_ 접두 제거)
    const detailPath = collectionName === "precedent"
      ? `/pd/USEPDA002P.do?ntstDcmId=${encodeURIComponent(nid)}`
      : `/qt/USEQTA002P.do?ntstDcmId=${encodeURIComponent(nid)}`
    lines.push(`  원문: ${TAXLAW_BASE}${detailPath}`)
  }
  if (collectionName === "hometaxCnslThan" && id !== "N/A") {
    lines.push("  상세: get_taxlaw_hometax_counsel_text에 위 ID 사용")
  }
  return lines.join("\n")
}

async function searchTaxlawAll(
  args: IntegratedSearchArgs,
  retryContext: { originalQuery?: string } = {},
): Promise<ToolResponse> {
  const query = requireString("query", args.query)
  validateDateRange(args.fromDate, args.toDate)

  const collections = integratedCollections(args.collections)
  const display = asPositiveInt(args.displayPerCollection, 3, 10)
  const page = asPositiveInt(args.page, 1)
  const sort = integratedSort(args.sort)
  const params: AnyRecord = {
    schVcb: query,
    startCount: page,
    collection: collections.join(","),
    wnKey: "",
    searchType: "",
    sortField: sort,
    viewCount: String(display),
    ntstTlawClCdList: args.taxLawCode ? [args.taxLawCode] : [],
    icldVcbCtl: [],
    exclVcbCtl: [],
    rltnStttCtl: [],
    schDtBase: "",
    prtsSprcChiefJdgmYn: "",
    prtsAttrYrCtl: [],
    prtsPrgrStatCtl: [],
    prtsLwsDfntYn: "",
    mainIdCtl: [],
    useSynonymYn: args.synonym === false ? "N" : "Y",
  }
  if (args.fromDate) params.bltnStrtDtm = `${args.fromDate}000000`
  if (args.toDate) params.bltnEndDtm = `${args.toDate}999999`

  const data = await postTaxlawAction<IntegratedSearchData>(
    "ASEISA001MR01",
    params,
    `/is/USEISA001M.do?schVcb=${encodeURIComponent(query)}`,
  )
  const search = data.ASEISA001MR01.searchResultVO
  const list = search?.collectionList || []
  const total = list.reduce((sum, col) => sum + Number(col.totalCount || 0), 0)

  if (total === 0) {
    // v0.9.5 — 복합어 NOT_FOUND 자동 분해 재시도 (1회만)
    if (!retryContext.originalQuery) {
      const retryQueries = buildRetryQueries(query)
      for (const retryQuery of retryQueries) {
        try {
          const retryResult = await searchTaxlawAll(
            { ...args, query: retryQuery },
            { originalQuery: query },
          )
          if (!retryResult.isError) {
            return retryResult
          }
        } catch {
          // 재시도 실패 시 다음 후보 시도
        }
      }
    }
    const triedNotice = retryContext.originalQuery
      ? ` (자동 재시도 분해 키워드: "${query}")`
      : ""
    return notFoundResponse(
      `국세법령정보시스템 통합검색 '${retryContext.originalQuery || query}' 결과가 없습니다${triedNotice}.`,
      {
        L1: [
          "쿼리를 더 짧게/핵심 키워드로 줄여 재검색.",
          "synonym=true(기본값) 유지하여 가운뎃점·띄어쓰기 변형 허용.",
        ],
        L2: [
          "세법해석/판례만 필요하면 search_taxlaw_documents.",
          "법제처 해석례·감사원 심사청구·납세자보호위원회 등은 통합검색에 미포함 — 아래 actionId를 call_taxlaw_action으로 호출.",
        ],
        L3: [
          "법조문 본문은 korean-law-mcp.search_law + get_law_text(jo=...)가 1차.",
          "판례·해석례·조세심판은 korean-law-mcp.search_decisions(domain=precedent/interpretation/tax_tribunal) 병행 시도.",
        ],
      },
      { toolName: "search_taxlaw_all" },
    )
  }

  const estimatedPagesAll = total > 0 ? Math.ceil(total / (display * collections.length)) : 0
  const lines = [
    `국세법령정보시스템 통합검색 결과: "${query}"`,
    `출처: ${TAXLAW_BASE}/is/USEISA001M.do`,
    `검색 컬렉션: ${collections.join(", ")} / 총 ${total.toLocaleString()}건 / page=${page}/${estimatedPagesAll.toLocaleString()} (displayPerCollection=${display}) — 다음 페이지: page=${page + 1}`,
    "주의: 아래 결과는 국세법령정보시스템 action.do 응답에서 온 실제 항목만 표시합니다. 각 행의 [ID]를 get_taxlaw_document_text(full=true)에 넣으면 전문.",
    "",
  ]
  // v0.9.5 — 복합어 자동 분해 재시도로 회수된 결과에 대한 안내
  if (retryContext.originalQuery && retryContext.originalQuery !== query) {
    lines.push(describeRetryAttempt(retryContext.originalQuery, query, total), "")
  }

  // v0.9.9 — 동적 세목 코드 헤더 (search_taxlaw_documents와 동일 로직 이식).
  // 응답에 등장한 unique 세목 코드 묶음 안내를 헤더 1줄로 압축.
  const headerItems: Array<{ code?: string; name?: string }> = []
  let hasAdminRule = false
  for (const collection of list) {
    for (const row of (collection.resultList || []).slice(0, display)) {
      const r = row as AnyRecord
      headerItems.push({
        code: cleanText(String(r.NTST_TLAW_CL_CD || "")),
        name: cleanText(String(r.NTST_TLAW_CL_NM || "")),
      })
      if (!hasAdminRule && isAdminRuleRow(r)) hasAdminRule = true
    }
  }
  const codeHeader = formatTaxLawCodeHeader(headerItems)
  if (codeHeader) lines.push(codeHeader, "")
  // v0.9.13 — 행정규칙(훈령·예규·고시) 결과면 법제처 현행본 교차확인 안내(stale 방지).
  if (hasAdminRule) lines.push(ADMIN_RULE_STALE_NOTICE, "")
  // v0.24.0(F) — 발간책자·집행기준(formerLibrary) 행은 get_taxlaw_document_text로 전문 회수 불가(PDF 전용, 라이브 NOT_FOUND 실증).
  if (list.some((c) => c.nameEn === "formerLibrary" && (c.resultList || []).length > 0)) {
    lines.push(
      "⚠ 발간책자·집행기준(formerLibrary) 행은 get_taxlaw_document_text로 전문 회수 불가(PDF 전용) — 집행기준은 call_taxlaw_extra(name=\"get_execution_standard\", args={law, number}), 기타 발간책자는 search_taxlaw_publications 사용.",
      "",
    )
  }

  for (const collection of list) {
    const nameKr = collection.nameKr || collection.nameEn || "컬렉션"
    const nameEn = collection.nameEn || ""
    const count = Number(collection.totalCount || 0)
    lines.push(`## ${nameKr}${nameEn ? ` (${nameEn})` : ""}: ${count.toLocaleString()}건`)
    const rows = collection.resultList || []
    if (rows.length === 0) {
      lines.push("[NOT_FOUND] 이 컬렉션의 표시 가능한 결과가 없습니다.", "")
      continue
    }
    const verbose = args.verbose !== false
    rows.slice(0, display).forEach((row) => {
      lines.push(formatIntegratedRow(row, nameEn, verbose), "")
    })
  }

  return textResponse(truncate(lines.join("\n"), 50000))
}

function splitDocumentCodes(codes: string[]): Array<{ kind: "question" | "precedent"; codes: string[] }> {
  const question = codes.filter((code) => QUESTION_CODES.has(code))
  const precedent = codes.filter((code) => PRECEDENT_CODES.has(code))
  const groups: Array<{ kind: "question" | "precedent"; codes: string[] }> = []
  if (question.length > 0) groups.push({ kind: "question", codes: question })
  if (precedent.length > 0) groups.push({ kind: "precedent", codes: precedent })
  return groups
}

async function searchDocumentGroup(
  group: { kind: "question" | "precedent"; codes: string[] },
  args: DocumentSearchArgs,
): Promise<{ group: "question" | "precedent"; codes: string[]; result: TaxlawSearchData["ASIPDI002PR01"] }> {
  const display = asPositiveInt(args.display, 10, 50) // v0.12.0 — 기본 20→10

  const page = asPositiveInt(args.page, 1)
  const sort = sortField(args.sort)
  const params = {
    startCount: page,
    viewCount: display,
    schDtBase: sort.startsWith("FRS_") ? "FRS_RGT_DTM" : "DCM_RGT_DTM",
    bltnStrtDt: args.fromDate || "",
    bltnEndDt: args.toDate || "",
    collectionName: group.kind === "question" ? "question,question_gr" : "precedent,precedent_gr",
    dcmClCdCtl: group.codes.map((code) => `001_${code}`),
    exclVcbCtl: [],
    icldVcbCtl: args.query ? [args.query] : [],
    ntstTlawClCdList: args.taxLawCode ? [args.taxLawCode] : [],
    sortField: sort,
  }
  const firstCode = group.codes[0]
  const referer = group.kind === "question"
    ? `/qt/USEQTA001M.do?ntstDcmClCd=${firstCode}`
    : `/pd/USEPDA001M.do?ntstDcmClCd=${firstCode}`
  const data = await postTaxlawAction<TaxlawSearchData>("ASIPDI002PR01", params, referer)
  return { group: group.kind, codes: group.codes, result: data.ASIPDI002PR01 }
}

export function documentDateValue(item: TaxlawDcm): number {
  const digits = String(item.DCM_RGT_DTM_S || item.DCM_RGT_DTM || item.FRS_RGT_DTM || "").replace(/\D/g, "")
  return Number(digits.slice(0, 14) || 0)
}

export function documentDedupKey(item: TaxlawDcm): string {
  const code = String(item.NTST_DCM_CL_CD || "").padStart(2, "0")
  const tax = cleanText(item.NTST_TLAW_CL_NM)
  const title = cleanText(item.TTL)
  const docNo = cleanText(item.NTST_DCM_DSCM_CNTN)
  const replyNo = cleanText(item.NTST_DCM_RPLY_CNTN)
  const gist = cleanText(item.GIST_CNTN || item.CNTN || item.FILE_CN)
  const stableKey = [code, tax, docNo, replyNo, title].filter(Boolean).join("|")
  return (stableKey || item.DOC_ID || item.DOCID || gist || title || "unknown").toLowerCase()
}

function uniqueDocuments(items: TaxlawDcm[]): { items: TaxlawDcm[]; duplicatesRemoved: number } {
  const seen = new Set<string>()
  const unique: TaxlawDcm[] = []
  for (const item of items) {
    const key = documentDedupKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(item)
  }
  return { items: unique, duplicatesRemoved: items.length - unique.length }
}

// v0.12.0 — 인용 번호 일괄 추출(verify_nts_citations용). 기존 검증기 간극(korean-law
// verify_citations=조문만, cite_check=법원 판례만)을 메우는 1차 패턴 레이어 — 해석례 문서번호·
// 심판례 청구번호·법원 사건번호·기본통칙 번호를 텍스트에서 뽑는다. 순수함수(단위테스트 대상).
export interface NtsCitation {
  raw: string
  normalized: string // 공백·하이픈·마침표 제거 소문자
  kind: "interpretation" | "tribunal" | "court" | "basic_rule"
}
const DEPT_FALSE_PREFIXES = new Set(["결과", "효과", "성과", "통과", "초과", "경과", "부과"])
export function extractNtsCitations(text: string): NtsCitation[] {
  const src = String(text || "")
  const out: NtsCitation[] = []
  const seen = new Set<string>()
  const norm = (s: string) => s.replace(/[\s\-–—.·]/g, "").toLowerCase()
  const push = (raw: string, kind: NtsCitation["kind"]) => {
    const trimmed = raw.trim()
    const key = `${kind}:${norm(trimmed)}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ raw: trimmed, normalized: norm(trimmed), kind })
  }
  // 신형 해석례: 서면-2024-법규부가-4804 / 사전-2023-법규법인-123 / 기준-2020-법령해석소득-67
  for (const m of src.matchAll(/(?:서면|사전|기준)\s?-\s?\d{4}\s?-\s?[가-힣]{2,12}\s?-\s?\d{1,6}(?!\d)/g)) push(m[0], "interpretation")
  // 구형 해석례: 부가46015-2833, 법인46012-123, 소득22601-1234
  for (const m of src.matchAll(/[가-힣]{2,6}\d{4,5}\s?-\s?\d{1,6}(?!\d)/g)) {
    // v0.20.0(#3) — 감심/심사(쟁송) 접두어는 아래 tribunal 루프가 처리 — 여기서 interpretation으로도 잡으면 이중분류(검출수 2배·cap 조기소진·NTS 중복왕복).
    if (/^(?:감심|심사|조심|국심)/.test(m[0])) continue
    push(m[0], "interpretation")
  }
  // 부서형: 서면법규과-1284, 부가가치세제과-456, 법인세과-789 (일반어 '결과-12' 류는 차단)
  for (const m of src.matchAll(/([가-힣]{2,14}(?:과|팀))\s?-\s?\d{1,6}(?!\d)/g)) {
    if (DEPT_FALSE_PREFIXES.has(m[1])) continue
    push(m[0], "interpretation")
  }
  // 심판·심사: 조심2013서1471 / 조심-2024-서-5990(하이픈 공식표기) / 국심2005서1234
  // v0.13.x(P1) — 구분자 [\s-]?로 통일. 하이픈형 조심/국심 누락 수정(오인용 사고 조심-2024-인-2328 미추출 재발방지).
  for (const m of src.matchAll(/(?:조심|국심)[\s-]?\d{4}[\s-]?[가-힣]{1,2}[\s-]?\d{1,5}(?!\d)/g)) push(m[0], "tribunal")
  // 감심·심사청구: 감심2010-123 / 심사소득2019-0012 / 심사-2020-1234
  // v0.20.0(#2) — '감심 제2023-56호'(감사원 공식표기: 공백+'제'…'호')가 본추출·백스톱 양쪽을 침묵 통과하던 누락 수정. 선택적 '제'·'호'·공백 허용.
  for (const m of src.matchAll(/(?:감심|심사[가-힣]{0,4})[\s-]?제?\s?\d{4}[\s-]?\d{1,5}(?!\d)\s?호?/g)) push(m[0], "tribunal")
  // 이의신청: 이의-부산청-2024-0108 / 이의-중부청-2023-12 (지방청 단위 문서번호)
  for (const m of src.matchAll(/이의(?:신청)?[\s-]?[가-힣]{2,7}청[\s-]?\d{4}[\s-]?\d{1,5}(?!\d)/g)) push(m[0], "tribunal")
  // 법원: 2021두39997, 2023누15045, 2020구합1234, 2019헌바73
  // v0.21.0(#E8) — "2021두39997, 39998" 병합사건 표기: 종전 정규식이 뒤 번호(39998)를 침묵 드롭했다.
  //   꼬리 ",\s*번호"를 흡수해 각 번호를 동일 연도·접두(두/누/구합 등)로 재구성해 개별 court로 push.
  //   합성 raw는 "2021두39998" 형태(원 표기는 ", 39998"). 꼬리 번호는 직후가 court 접두(한글)면 새 인용의 연도이므로
  //   흡수하지 않도록 (?![0-9가-힣])로 경계 고정(예: "…, 2020구합1234"의 2020은 미흡수). 중복·이중플래그는 push의 seen이 흡수.
  // v0.27.4(라이브 검증) — 구분자 [\s-]? 로 통일. 종전엔 공백만 허용해 '대법원-2006-두-18652',
  //   '서울행정법원-2018-구합-62461' 같은 하이픈 표기를 침묵 드롭했다. 이 표기는 다름 아닌
  //   본 MCP search_taxlaw_documents가 '문서번호:'로 출력하는 형식이라, 검색 결과를 그대로
  //   산출물에 옮기면 인용 게이트가 통과시켜 버리는 라운드트립 구멍이었다(검출 0건=경고 없음).
  //   조심/국심은 v0.13.x에서 같은 이유로 이미 [\s-]?로 고쳤는데 법원 패턴만 남아 있었다.
  for (const m of src.matchAll(/(?<!\d)(\d{4})[\s-]?(두|누|구합|구단|헌바|헌가|헌마)[\s-]?(\d{2,7}(?!\d))((?:\s*,\s*\d{2,7}(?!\d)(?![0-9가-힣]))+)?/g)) {
    const [, year, prefix, first, tail] = m
    push(`${year}${prefix}${first}`, "court")
    if (tail) for (const t of tail.matchAll(/\d{2,7}(?!\d)/g)) push(`${year}${prefix}${t[0]}`, "court")
  }
  // 기본통칙: "기본통칙 10-0…5" / 옛 "기본통칙 10-0-5"
  for (const m of src.matchAll(/기본통칙\s?\d{1,3}\s?-\s?\d{1,3}(?:\s?(?:…|\.\.\.|-)\s?\d{1,3})?/g)) push(m[0], "basic_rule")
  return out
}

// 제목이나 본문 속 참조 번호는 해당 문서의 식별자가 아니다.
// 법원명 접두·병합 사건은 번호 필드에서 추출하되 전체 번호로 비교한다.
export function matchesCitationIdentity(item: Record<string, unknown>, cit: NtsCitation): boolean {
  return [item.NTST_DCM_DSCM_CNTN, item.NTST_DCM_RPLY_CNTN].some((value) =>
    normalizeDocumentNumber(value) === cit.normalized ||
    extractNtsCitations(cleanText(value)).some((candidate) =>
      candidate.kind === cit.kind && candidate.normalized === cit.normalized),
  )
}

// v0.13.x(P2) — 정밀 추출기가 놓친 '인용처럼 보이는' 토큰을 찾아 침묵 누락을 가시화한다.
// "N건 중 N건 검증" 거짓안심 방지: 미인식 포맷(신형 하이픈·지방청 이의신청 등)을 ⚠로 노출한다.
const CITATION_SHAPED =
  /(?:조심|국심|감심|심사|이의|적부|과세전적부|서면|사전|기준)[가-힣·\-]{0,9}\d{4}[가-힣·\-]{0,5}\d{1,6}/g
export function findUnparsedCitationTokens(text: string, extracted: NtsCitation[]): string[] {
  const src = String(text || "")
  const norm = (s: string) => s.replace(/[\s\-–—.·]/g, "").toLowerCase()
  const extractedNorm = extracted.map((c) => c.normalized).filter((n) => n.length >= 6)
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of src.matchAll(CITATION_SHAPED)) {
    const raw = m[0].trim().replace(/[\s.,]+$/, "")
    const n = norm(raw)
    if (n.length < 6) continue
    if (extractedNorm.some((e) => n.includes(e) || e.includes(n))) continue
    if (seen.has(n)) continue
    seen.add(n)
    out.push(raw)
  }
  return out
}

// v0.13.x(L1) — 인용 검증 결과를 원장(jsonl)에 적재. 빌드/마감 게이트가 "검증을 실제로 돌렸는가"를 대조하는 근거.
// 경로는 TAXLAW_CITATION_LEDGER로 재지정 가능(기본: 홈디렉터리). 기록 실패는 검증을 막지 않는다(가용성 우선).
const CITATION_LEDGER_PATH = process.env.TAXLAW_CITATION_LEDGER || join(homedir(), ".taxlaw-nts-citation-ledger.jsonl")
function appendCitationLedger(entry: Record<string, unknown>): void {
  try {
    appendFileSync(CITATION_LEDGER_PATH, JSON.stringify({ ...entry, ts: new Date().toISOString() }) + "\n")
  } catch {
    /* 원장 기록 실패 무시 */
  }
}

// v0.13.x(P5) — 확정 인용의 '관련법령'을 상세조회로 보강(명제적합성 자가검증 신호). 실패 시 생략.
// v0.21.0(#W-6) — 호출부가 문서코드(dcmClCd)를 알면 해당 상세 경로를 먼저 시도해 헛왕복 제거:
//   판례군(05~10)=/pd, 해석례군(01~04)=/qt 우선. 1차 미스 시 나머지 경로 폴백(기존 순회 유지). 코드 미지정=기존 순서.
async function fetchRelatedLawsForCitation(id: string, dcmClCd?: string): Promise<string> {
  const qt = `/qt/USEQTA002P.do?ntstDcmId=${encodeURIComponent(id)}`
  const pd = `/pd/USEPDA002P.do?ntstDcmId=${encodeURIComponent(id)}`
  const code = String(dcmClCd || "").padStart(2, "0")
  const attempts = /^(0[5-9]|10)$/.test(code) ? [pd, qt] : [qt, pd]
  for (const referer of attempts) {
    try {
      const data = await postTaxlawAction<TaxlawDetailData>("ASIQTB002PR01", { dcmDVO: { ntstDcmId: id } }, referer)
      const detail = data.ASIQTB002PR01
      if (!detail?.dcmDVO) continue
      return (detail.dcmRltnStttList || []).map((it) => cleanText(it.ntstTextNm)).filter(Boolean).join(", ")
    } catch {
      /* 상세조회 실패 시 관련법령 생략(제목·요지·결정만으로도 신호 충분) */
    }
  }
  return ""
}

// v0.15.0(G1 — 명제 결박 ACTIVE 게이트) — proposition 핵심 토큰이 문서 본문/요지에 실제 등장하는지로
// 명제 적합성을 휴리스틱 측정. "실존≠명제적합"이라는 PASSIVE 권고를 호출시점 ACTIVE 신호로 승격
// (이번 세션 오귀속 사고: 사용료 사건을 §48 공동경비 배부 근거로 오인용 재발 차단). 조사 제거 후 길이≥2 토큰.
const JOSA_SUFFIX = /(으로서|으로|에서|에게서|에게|까지|부터|이라|라고|와의|과의|에는|에도|을|를|이|가|은|는|의|에|와|과|로|도|만|및|등|또는)$/
export function propTokens(s: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (let t of String(s || "").split(/[^가-힣A-Za-z0-9]+/)) {
    // v0.20.0(#4) — 어간이 2자 이상 남을 때만 조사 절삭. '제도/온도/결과/효과/평가/증가' 등 조사 동형 종성(도·과·가)
    // 명사가 1글자로 뭉개져 명제결박 토큰에서 탈락하던 blind spot 방지(공동경비를→공동경비·비율로→비율은 기존대로 절삭).
    const stem = t.replace(JOSA_SUFFIX, "")
    if (stem.length >= 2) t = stem
    if (t.length < 2) continue
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  return out
}
// 초고빈도 비핵심 토큰 — 명제 적합성 점수를 부풀려 false negative를 내므로 제외(Codex v0.16.1 재대조 반영).
const PROP_STOP = new Set(["여부", "해당", "관련", "근거", "적용", "한다", "되는", "대한", "경우", "이상", "있는", "없는", "또는"])
export function propositionFit(proposition: string, hay: string): number {
  const toks = propTokens(proposition).filter((t) => !PROP_STOP.has(t) && !/^\d+$/.test(t))
  // v0.21.0(#G4) — 핵심어가 전부 불용어·숫자로 비어버리면 종전 1(=100% 적합) 반환이 오귀속을
  // '완벽 일치'로 둔갑시켰다. -1(판정불가 sentinel)로 바꿔 호출부가 [명제 판정불가]로 분기하게 한다.
  if (!toks.length) return -1
  const h = String(hay || "").toLowerCase()
  return toks.filter((t) => h.includes(t.toLowerCase())).length / toks.length
}
// v0.21.0(#E7) — 주장이 부정·배제형인지 판정. 부정어 하나 차이로 정반대 판시와 토큰겹침이 100% 나오는
// 함정을 경보하기 위한 순수 predicate(호출부 인라인 정규식을 추출해 테스트 표면화·문구 확장).
export function isNegativeProposition(prop: string): boolean {
  return /(아니|않|못한|없|제외|배제|해당(하|되)지|부인|불인정|비과세|면제|보기\s*어렵|어렵다|무관|다르다|부정(?!당)|반한다|위반)/.test(String(prop || ""))
}
// v0.21.0(#G1) — 무히트(hit 없음) 상황에서 검색그룹 실패 수로 판정 결과를 결정하는 순수 분기(테스트 표면).
// NTS 장애로 전 그룹이 reject되면 '미발견'이 아니라 '판정불가'(exists:false 오기록 금지). 일부만 실패해도
// 불완전 증거이므로 원장 기록을 생략한다. Promise.allSettled는 throw하지 않아 종전 catch로는 이 경로가 안 잡혔다.
export function classifyNoHitOutcome(rejected: number, groupCount: number): {
  tally: "notFound" | "failed"
  writeLedger: boolean
  incomplete: boolean
} {
  if (groupCount > 0 && rejected >= groupCount) return { tally: "failed", writeLedger: false, incomplete: true }
  if (rejected > 0) return { tally: "notFound", writeLedger: false, incomplete: true }
  return { tally: "notFound", writeLedger: true, incomplete: false }
}
type NtsClaim = { citation?: string; proposition?: string; basis?: string }

// v0.21.0(#G3) — text에서 추출·처리된 어떤 인용(정규화 키)과도 매칭 안 된 claim을 수집(역방향 침묵 소실 차단).
// 오타·미지원 포맷으로 애초에 미추출됐거나 maxCitations 캡 초과로 처리 대상에서 빠진 claim은 그 명제가 미검증인데
// 종전엔 조용히 증발했다. norm2(citation)는 verifyNtsCitations의 claimsByCit 키·main loop의 claimsByCit.get(cit.normalized)
// 매칭과 동일한 정규화라 processedNorms(=처리된 cit.normalized 집합)와 일관 비교된다.
export function findUnmatchedClaims(claims: NtsClaim[] | undefined, processedNorms: Set<string>): string[] {
  const norm2 = (s: unknown) => cleanText(String(s || "")).replace(/[\s\-–—.·]/g, "").toLowerCase()
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of claims || []) {
    if (!c || !c.citation) continue
    const key = norm2(c.citation)
    if (processedNorms.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push(String(c.citation))
  }
  return out
}

// v0.12.0 — NTS 인용 실존 일괄 검증 도구. 산출물에 들어갈 번호의 실존을 검색으로 확인.
// ⚠ 실존 확인 ≠ 명제 적합성(그 문서가 결론을 지지하는가) — claims 제출 시 ACTIVE 결박 검사, 미제출 시 실존만.
export async function verifyNtsCitations(args: { text?: string; maxCitations?: number; claims?: NtsClaim[] }): Promise<ToolResponse> {
  const text = requireString("text", args.text)
  const cap = asPositiveInt(args.maxCitations, 12, 20)
  const all = extractNtsCitations(text)
  const unparsed = findUnparsedCitationTokens(text, all)
  if (all.length === 0) {
    if (unparsed.length) {
      return textResponse(
        [
          "── NTS 인용 실존 일괄 검증 ──",
          `⚠ 정밀 추출 0건이나, 인용처럼 보이는 미인식 토큰 ${unparsed.length}건 발견 — 패턴 미지원 가능. 수동 확인 필수:`,
          ...unparsed.map((u) => `  • ${u}`),
        ].join("\n"),
      )
    }
    return textResponse(
      "인용 번호 패턴이 검출되지 않았습니다(해석례 문서번호·심판례 청구번호·법원 사건번호·기본통칙). 번호 표기를 확인하거나 인용 목록만 따로 전달하세요.",
    )
  }
  const cits = all.slice(0, cap)
  const hasClaims = Array.isArray(args.claims) && args.claims.length > 0
  const lines = [
    "── NTS 인용 실존 일괄 검증 ──",
    // v0.27.6(부분장애 검증) — 이 줄은 결과가 나오기 전 조립되므로 cits.length는 '시도 건수'다.
    //   NTS 장애로 3건 전부 조회 실패인데도 "검출 3건 중 3건 검증"으로 찍혀, 상세·요약을 안 읽으면
    //   통과로 오독됐다(v0.27.1 '表示 N개' 불일치와 동형). 실제 결과 확정 후 아래에서 이 줄을 교체한다.
    "__VERIFY_HEADER__",
    "⚠ 실존 확인 ≠ 명제 적합성 — 결론 인용 전 full 본문(주문·판단)으로 그 문서가 명제를 실제 지지하는지 별도 대조하라.",
    hasClaims
      ? "✓ claims 제출됨 → 명제 결박 ACTIVE 검사 수행(주장 핵심어↔본문 매칭률)."
      : "ℹ claims[{citation, proposition, basis:'direct'|'inference'}] 제출 시 명제 적합성을 ACTIVE 검사(미제출=실존만 확인). 산출물 인용은 claims 동반 권장.",
    "",
  ]
  // v0.12.1 — 인용별 처리를 동시성 상한(4) 청크 병렬로(종전 순차 for: N건=N회 직렬 왕복).
  //   순서 보존: 각 인용을 인덱스 그대로 결과 배열에 채운 뒤 합산. NTS API 과부하 방지로 상한 절제.
  const GROUPS = [
    { kind: "question" as const, codes: ["01", "02", "03", "04"] },
    { kind: "precedent" as const, codes: ["05", "06", "07", "08", "09", "10"] },
  ]
  type CitResult = { tally: "confirmed" | "notFound" | "failed" | "basic"; line: string; titleOnly?: boolean; claimMiss?: boolean; claimMismatch?: boolean }
  const norm2 = (s: unknown) => cleanText(String(s || "")).replace(/[\s\-–—.·]/g, "").toLowerCase()
  // claims는 인용당 선형탐색 대신 정규화 키 Map(Codex v0.16.1 재대조 반영 — 대량 입력 성능).
  const claimsByCit = new Map<string, NtsClaim>((args.claims || []).filter((c) => c && c.citation).map((c) => [norm2(c.citation), c]))

  async function processCit(cit: NtsCitation): Promise<CitResult> {
    if (cit.kind === "basic_rule") {
      return {
        tally: "basic",
        line: `◇ ${cit.raw} [기본통칙] — 본 도구의 검색 대상 아님. list_taxlaw_basic_ruling_laws→get_taxlaw_basic_ruling_text(주제 키워드)로 현행 번호("N-N…M") 확인 필수(옛 "N-N" 표기 가능성).`,
      }
    }
    try {
      const settled = await Promise.allSettled(
        GROUPS.map((g) => searchDocumentGroup(g, { query: cit.raw, display: 10 } as DocumentSearchArgs)),
      )
      // v0.21.0(#G1) — Promise.allSettled는 throw하지 않아 그룹 reject가 catch로 안 잡힌다.
      // reject 수를 직접 세어 무히트 시 '미발견'(exists:false 오기록)이 아니라 '판정불가/불완전'으로 분기한다.
      const rejected = settled.filter((s) => s.status === "rejected").length
      const items: TaxlawDcm[] = settled
        .filter((s): s is PromiseFulfilledResult<Awaited<ReturnType<typeof searchDocumentGroup>>> => s.status === "fulfilled")
        .flatMap((s) => (s.value.result.body || []).map((row) => row.dcm).filter((d): d is TaxlawDcm => !!d))
      const hit = items.find((d) => matchesCitationIdentity(d as Record<string, unknown>, cit))
      if (hit) {
        const date = cleanText(String(hit.DCM_RGT_DTM_S || hit.DCM_RGT_DTM || "")).slice(0, 12)
        const id = String(hit.DOC_ID || hit.DOCID || "?")
        const title = cleanText(hit.TTL).slice(0, 70)
        const gist = cleanText(String(hit.GIST_CNTN || "")).replace(/\s+/g, " ").slice(0, 80)
        const decision = cleanText(String(hit.NTST_DCM_DCS_CL_NM || ""))
        const tax = cleanText(String(hit.NTST_TLAW_CL_NM || ""))
        const related = id !== "?" ? await fetchRelatedLawsForCitation(id, String(hit.NTST_DCM_CL_CD || "")) : ""
        appendCitationLedger({ raw: cit.raw, normalized: cit.normalized, kind: cit.kind, exists: true, title, gist, decision, relatedLaws: related, id })
        const metaBits = [tax && `세목 ${tax}`, decision && `결정 ${decision}`, related && `관련법령 ${related.slice(0, 70)}`]
          .filter(Boolean)
          .join(" · ")
        const ln: string[] = [`✓ ${cit.raw} — 실존 확인: ${title} (생산 ${date || "?"}, ID ${id})`]
        // v0.20.0(#1) — 인용 직전 최종 게이트(verify)의 확인행에도 원문 URL을 붙여, verify 출력만으로 citation_table을 채울 때 모델의 URL 창작을 차단(검색 포맷터와 동일 데이터계층 조립).
        const code = String(hit.NTST_DCM_CL_CD || "").padStart(2, "0")
        if (id !== "?") ln.push(`    └ 원문: ${TAXLAW_BASE}${refererForDoc(code, id)}`)
        if (metaBits) ln.push(`    └ ${metaBits}`)
        if (gist) ln.push(`    └ 요지: ${gist}…`)
        // G2 — 번호가 제목(TTL)에만 매칭되고 본문(문서번호·요지)에는 없으면 강등(제목≠본문, 이의-부산청 류). 실존✓은 유지.
        const bodyHay = norm2(`${hit.NTST_DCM_DSCM_CNTN || ""}${hit.NTST_DCM_RPLY_CNTN || ""}${hit.GIST_CNTN || ""}${hit.CNTN || ""}${hit.FILE_CN || ""}`)
        const titleOnly = !bodyHay.includes(cit.normalized) && norm2(hit.TTL).includes(cit.normalized)
        if (titleOnly) ln.push("    └ △ 번호가 제목(TTL)에만 매칭·본문(문서번호/요지) 미확인 — 제목≠본문 가능, full로 사건 동일성 확인")
        // G1 — 명제 결박: claims 제출 시 주장 핵심어↔본문 매칭률로 ACTIVE 검사.
        const claim = claimsByCit.get(cit.normalized)
        let claimMiss = false
        let claimMismatch = false
        if (hasClaims && !claim) {
          claimMiss = true
          ln.push("    └ ⚠ [명제 미결박] 이 인용의 proposition·basis 미제출 — 주장 적합성 미검증. 산출물 인용 전 claims로 재호출.")
        } else if (claim) {
          const prop = String(claim.proposition || "")
          const fit = propositionFit(prop, `${bodyHay}${norm2(hit.TTL)}${norm2(gist)}${norm2(related)}`)
          // v0.20.0(#1) — propositionFit은 순수 토큰겹침이라 '…아니다' vs '…이다'(부정어/방향)를 구분 못 한다.
          // 부정어 하나만 다른 정반대 판시도 매칭 100%가 나오므로, 결박 라벨을 '토큰겹침'으로 약화하고 주장이 부정·배제형이면 방향(주문 결과) 확인을 강제한다.
          if (fit < 0) {
            // v0.21.0(#G4) — 주장 핵심어가 전부 불용어·숫자로 비어 propositionFit이 판정불가(-1)를 반환한 경우.
            // 종전 100%(오귀속을 완벽일치로 둔갑) 대신 판정불가만 부착하고 불일치로 세지 않는다.
            ln.push("    └ ℹ [명제 판정불가] 주장 핵심어가 전부 불용어·숫자 — 구체 명제로 재호출 권장.")
          } else {
            const pct = Math.round(fit * 100)
            const negProp = isNegativeProposition(prop)
            if (fit < 0.4) {
              claimMismatch = true
              ln.push(`    └ ⚠⚠ [명제 불일치 의심] 주장 핵심어 본문 매칭 ${pct}% — 오귀속(표현·쟁점 오귀속) 의심. full 본문(주문·판단)으로 직접 대조 필수, 불일치 시 인용 제외.`)
            } else {
              ln.push(`    └ [명제 결박(토큰겹침)] 주장 핵심어 본문 매칭 ${pct}%${claim.basis === "inference" ? " · [추론] 라벨(직접근거 아님)" : " · [직접근거]"} — ⚠ 토큰 존재만 확인(부정어·방향·주문 결과 미검증). 결론 인용 전 full 본문(주문·판단)으로 긍정/부정 극성까지 대조.`)
              if (negProp) ln.push(`    └ ⚠⚠ [부정형 주장] '…아니다/제외' 류 — 토큰겹침은 정반대(긍정) 판시와도 100% 일치하므로 주문의 인용/기각 방향을 full 본문으로 반드시 확인.`)
            }
          }
        } else {
          ln.push("    └ ⚠ 실존 ≠ 명제적합 — 위 제목·요지·관련법령이 인용 '주장'과 일치하는지 full 본문(주문·판단)으로 확인")
        }
        return { tally: "confirmed", line: ln.join("\n"), titleOnly, claimMiss, claimMismatch }
      }
      // v0.21.0(#G1) — 무히트 처리: 전 그룹 실패=판정불가(원장 기록 금지), 일부 실패=미발견이나 불완전(원장 기록 금지).
      const outcome = classifyNoHitOutcome(rejected, GROUPS.length)
      if (outcome.tally === "failed") {
        return { tally: "failed", line: `? ${cit.raw} — 검색그룹 전체 조회 실패(NTS 장애 가능) — 실존 판정 불가. 재시도 필요.` }
      }
      if (outcome.writeLedger) {
        appendCitationLedger({ raw: cit.raw, normalized: cit.normalized, kind: cit.kind, exists: false })
      }
      const notFoundBase = `✗ ${cit.raw} — NTS 공개DB 미발견. ⚠ 미존재/할루시네이션 단정 금지 — 공개DB는 선별·익명화 수록이므로 외부 DB(casenote 등) 교차확인 전까지 산출물에는 "공개DB 미발견"으로만 기재.${cit.kind === "court" ? " 법원 판례는 korean-law-mcp search_decisions(domain=precedent)·legal_analysis(mode=cite_check) 병행." : ""}`
      return {
        tally: "notFound",
        line: outcome.incomplete
          ? `${notFoundBase} ⚠ ${rejected}/${GROUPS.length} 검색그룹 조회 실패 — 미발견 판정 불완전(재시도 권장).`
          : notFoundBase,
      }
    } catch (e) {
      return { tally: "failed", line: `? ${cit.raw} — 검색 실패(${e instanceof Error ? e.message : String(e)}). 재시도 필요.` }
    }
  }

  const CONCURRENCY = 4
  const results: CitResult[] = new Array(cits.length)
  for (let i = 0; i < cits.length; i += CONCURRENCY) {
    const chunk = cits.slice(i, i + CONCURRENCY)
    const settled = await Promise.all(chunk.map(processCit))
    settled.forEach((r, j) => (results[i + j] = r))
  }
  let confirmed = 0
  let notFound = 0
  let failed = 0
  let titleOnly = 0
  let claimMiss = 0
  let claimMismatch = 0
  for (const r of results) {
    if (r.tally === "confirmed") confirmed++
    else if (r.tally === "notFound") notFound++
    else if (r.tally === "failed") failed++
    if (r.titleOnly) titleOnly++
    if (r.claimMiss) claimMiss++
    if (r.claimMismatch) claimMismatch++
    lines.push(r.line)
  }
  if (unparsed.length) {
    lines.push("", `⚠ 추출 실패(미인식 패턴) ${unparsed.length}건 — verify 대상에서 누락됨(침묵 누락 방지 경고). 포맷 확인 후 개별 인용 또는 수동 검증 필수:`)
    unparsed.forEach((u) => lines.push(`  • ${u}`))
  }
  if (claimMismatch) lines.push("", `⚠⚠ 명제 불일치 의심 ${claimMismatch}건 — 산출물 인용 전 full 본문(주문·판단)으로 오귀속 여부 직접 대조 필수.`)
  if (claimMiss) lines.push(claimMismatch ? "" : "", `⚠ 명제 미결박 ${claimMiss}건 — proposition·basis 없이는 적합성 미검증. 산출물 인용 전 claims 동반 재호출.`)
  // v0.21.0(#G3) — text에서 추출·처리된 어떤 인용과도 매칭 안 된 claim(오타·미지원 포맷·maxCitations 캡 초과)을
  // 말미에 노출해 역방향 침묵 소실을 차단. 해당 명제는 실존·적합성 어느 것도 검증되지 않았다.
  const claimOrphans = hasClaims ? findUnmatchedClaims(args.claims, new Set(cits.map((c) => c.normalized))) : []
  const claimUnmatched = claimOrphans.length
  if (claimUnmatched) {
    lines.push("", `⚠ claims 미대응 ${claimUnmatched}건 — text에서 미추출(오타·미지원 포맷·maxCitations 캡): [${claimOrphans.join(", ")}]. 해당 명제는 미검증.`)
  }
  // v0.27.6 — 헤더를 실제 결과로 교체(시도 건수 → 확인/실패 분해). 조회 실패가 섞이면 헤더에서부터 경고.
  const overflowNote = all.length > cap ? ` (초과 ${all.length - cap}건은 maxCitations 확대 후 재호출)` : ""
  const headerIdx = lines.indexOf("__VERIFY_HEADER__")
  if (headerIdx >= 0) {
    lines[headerIdx] = failed === cits.length && cits.length > 0
      ? `⚠ 검출 ${all.length}건 — ${failed}건 전부 조회 실패(상류 장애 가능)로 실존 미검증${overflowNote}. 이 결과로 인용 게이트를 통과시키지 마라.`
      : failed > 0
        ? `검출 ${all.length}건 중 ${confirmed}건 확인 / ${notFound}건 미발견 / ⚠ ${failed}건 조회 실패(미검증)${overflowNote}.`
        : `검출 ${all.length}건 중 ${cits.length}건 검증${overflowNote}.`
  }
  lines.push("", `요약: ✓ 확인 ${confirmed} / ✗ 미발견 ${notFound} / ? 실패 ${failed} / 검출 ${all.length}` +
    `${unparsed.length ? ` / ⚠추출실패 ${unparsed.length}` : ""}` +
    `${titleOnly ? ` / △제목만매칭 ${titleOnly}` : ""}` +
    `${claimMiss ? ` / ⚠명제미결박 ${claimMiss}` : ""}` +
    `${claimMismatch ? ` / ⚠⚠명제불일치 ${claimMismatch}` : ""}` +
    `${claimUnmatched ? ` / ⚠claims미대응 ${claimUnmatched}` : ""}`)
  return textResponse(
    truncate(lines.join("\n"), 20000),
    false,
    failed === cits.length && cits.length > 0 ? "UPSTREAM_ERROR" : "OK",
  )
}

// v0.9.3 — 검색 결과의 query 관련성 판정. NTS 검색 엔진이 query 토큰 중 일부만
// 매칭되어도 결과를 반환하는 경우가 잦아, 사용자가 결과를 본문 클릭 없이 신뢰성
// 판단할 수 있도록 ⚠ tag 부착.
// v0.9.5 — 어떤 토큰이 매칭/누락됐는지 tag에 노출해 사용자가 즉시 진단 가능.
function judgeRelevance(query: string, haystack: string): {
  tag: string
  matchedRatio: number
  matched: string[]
  missing: string[]
} {
  const tokens = query.split(/\s+/).filter((t) => t.length > 1)
  if (tokens.length === 0) return { tag: "", matchedRatio: 1, matched: [], missing: [] }
  const matched = tokens.filter((t) => haystack.includes(t))
  const missing = tokens.filter((t) => !haystack.includes(t))
  const ratio = matched.length / tokens.length
  const fmtList = (arr: string[]) =>
    arr.length === 0 ? "[]" : `[${arr.map((s) => `"${s}"`).join(", ")}]`
  if (ratio === 0) {
    return {
      tag: ` ⚠ relevance_low (matched: ${fmtList(matched)}, missing: ${fmtList(missing)})`,
      matchedRatio: 0,
      matched,
      missing,
    }
  }
  if (ratio < 0.5 && tokens.length >= 2) {
    return {
      tag: ` ⚠ relevance_partial (matched: ${fmtList(matched)}, missing: ${fmtList(missing)})`,
      matchedRatio: ratio,
      matched,
      missing,
    }
  }
  return { tag: "", matchedRatio: ratio, matched, missing }
}

function formatDocumentSearchItem(item: TaxlawDcm, query?: string, requestedTaxLawCode?: string, verbose = true): string {
  const id = item.DOC_ID || item.DOCID || "N/A"
  const code = String(item.NTST_DCM_CL_CD || "").padStart(2, "0")
  const type = item.NTST_DCM_CL_NM || item.LBL1_TTL || docLabel(code)
  const tax = item.NTST_TLAW_CL_NM || item.LBL2_TTL || "N/A"
  const taxCode = cleanText(item.NTST_TLAW_CL_CD || "")
  const title = cleanText(item.TTL)
  const gist = cleanText(item.GIST_CNTN || item.CNTN || item.FILE_CN)
  const snippet = query ? highlightedSnippet(item.FILE_CN || item.CNTN || item.GIST_CNTN || item.TTL, query) : ""

  // v0.9.3 — query 토큰 vs 본문(제목+요지+발췌) 관련성 ⚠ 표시
  const haystack = [title, gist, snippet, cleanText(item.FILE_CN || "")].join(" ")
  const relevance = query ? judgeRelevance(query, haystack) : { tag: "", matchedRatio: 1, matched: [], missing: [] }

  // v0.16.0(G4) — '쟁점일치' 축: query가 본문(발췌·검색근거)에는 매칭되나 제목·요지(쟁점)에는 약하면,
  // 같은 단어·다른 쟁점일 수 있음(검색근거≠쟁점, 축약 오인용 방지). judgeRelevance가 토큰겹침만 보던 사각 보강.
  const issueRel = query ? judgeRelevance(query, [title, gist].join(" ")) : { matchedRatio: 1 }
  const issueTag = query && relevance.matchedRatio >= 0.5 && issueRel.matchedRatio < 0.3 && relevance.matched.length >= 2
    ? " ⚠ 본문어 매칭O·쟁점(제목/요지)X — 같은 단어 다른 쟁점 의심"
    : ""

  // v0.9.5 — NTS API의 taxLawCode 필터링이 strict하지 않아 응답에 다른 세목 코드가 섞일 수 있음.
  // 요청 코드와 응답 코드가 다르면 ⚠ 라벨 부착.
  const codeMismatchTag = requestedTaxLawCode && !taxLawCodeMatches(requestedTaxLawCode, taxCode)
    ? ` ⚠ taxLawCode_mismatch (요청=${requestedTaxLawCode} / 응답=${taxCode || "N/A"})`
    : ""

  const lines = [
    `[${id}] ${title}${relevance.tag}${codeMismatchTag}${issueTag}`,
    `  구분: ${type} / 세목: ${formatTaxLawCellCompact(tax, taxCode)}`,
    `  문서번호: ${cleanText(item.NTST_DCM_DSCM_CNTN) || "N/A"} / 회신번호: ${cleanText(item.NTST_DCM_RPLY_CNTN) || "N/A"}`,
    `  생산일자: ${normalizeDate(item.DCM_RGT_DTM_S || item.DCM_RGT_DTM)} / 등록일자: ${normalizeDate(item.FRS_RGT_DTM)}`,
  ]
  if (item.NTST_DCM_DCS_CL_NM) lines.push(`  결정: ${item.NTST_DCM_DCS_CL_NM}`)
  // v0.10.0 — 생산일자 staleness 플래그. 검색 단계에서 구법 기반 위험을 조기 신호(시점검증은 상세조회 몫).
  const prodDigits = String(item.DCM_RGT_DTM_S || item.DCM_RGT_DTM || "").replace(/\D/g, "")
  if (prodDigits.length >= 4) {
    const age = new Date().getFullYear() - Number(prodDigits.slice(0, 4))
    if (Number.isFinite(age) && age > getRecentThresholdYears()) {
      lines.push(`  ⚠ 생산 ${age}년 경과 — 구법 기반 가능성. 인용 전 get_taxlaw_document_text(targetYear=귀속연도) 시점검증 필수`)
    }
  }
  // v0.9.9 — verbose=false 시 요지·검색근거 생략(메타데이터만). 검증·헬스체크용.
  // v0.10.0 — 요지 700→450자·검색근거 500→300자(목록은 트리아지용 — 인용 판단은 상세 본문에서).
  if (verbose) {
    if (gist) lines.push(`  요지: ${truncate(gist, 450)}`)
    if (snippet && !gist.includes(snippet)) lines.push(`  검색근거: ${truncate(snippet, 300)}`)
  }
  // v0.20.0 — 해석례·심판례·판결을 사용자에게 제시할 때 반드시 원문 링크를 병기하도록 검색 행에 실제 NTS 원문 URL을 노출.
  // 링크는 API가 반환한 실제 DOC_ID로 조립(임의 생성 아님) — 모델이 URL을 창작하지 않도록 데이터 계층에서 제공.
  if (id !== "N/A") lines.push(`  원문: ${TAXLAW_BASE}${refererForDoc(code, id)}`)
  return lines.join("\n")
}

async function searchTaxlawDocuments(
  args: DocumentSearchArgs,
  fallbackDocType = "reply",
  retryContext: { originalQuery?: string } = {},
): Promise<ToolResponse> {
  validateDateRange(args.fromDate, args.toDate)

  const codes = documentCodes(args.docType, fallbackDocType)
  const groups = splitDocumentCodes(codes)
  if (groups.length === 0) {
    throw new TaxlawMcpError("No supported document type selected.", ErrorCodes.INVALID_PARAM)
  }

  const settled = await Promise.allSettled(groups.map((group) => searchDocumentGroup(group, args)))
  const results = settled
    .filter((s): s is PromiseFulfilledResult<{ group: "question" | "precedent"; codes: string[]; result: TaxlawSearchData["ASIPDI002PR01"] }> => s.status === "fulfilled")
    .map((s) => s.value)
  const failedGroups = settled
    .map((s, idx) => ({ status: s.status, group: groups[idx], reason: s.status === "rejected" ? s.reason : undefined }))
    .filter((entry) => entry.status === "rejected")

  if (results.length === 0) {
    throw failedGroups[0]?.reason ?? new TaxlawMcpError("Taxlaw document search failed.", ErrorCodes.API_ERROR)
  }

  const total = results.reduce((sum, entry) => sum + totalCount(entry.result, entry.codes), 0)
  const rawItems = results
    .flatMap((entry) => (entry.result.body || []).map((row) => row.dcm).filter((d): d is TaxlawDcm => !!d))
    .sort((a, b) => documentDateValue(b) - documentDateValue(a))
  const { items: uniqueItems, duplicatesRemoved } = uniqueDocuments(rawItems)
  const items = uniqueItems.slice(0, asPositiveInt(args.display, 10, 50))

  if (total === 0 || items.length === 0) {
    // v0.9.5 — 복합어 NOT_FOUND 자동 분해 재시도 (1회만)
    if (!retryContext.originalQuery && args.query) {
      const retryQueries = buildRetryQueries(args.query)
      for (const retryQuery of retryQueries) {
        try {
          const retryResult = await searchTaxlawDocuments(
            { ...args, query: retryQuery },
            fallbackDocType,
            { originalQuery: args.query },
          )
          if (!retryResult.isError) {
            return retryResult
          }
        } catch {
          // 재시도 실패 시 다음 후보 시도
        }
      }
    }
    const label = codes.map((code) => docLabel(code)).join(", ")
    const triedQueries = retryContext.originalQuery
      ? ` (자동 재시도 분해 키워드: "${args.query}")`
      : ""
    return notFoundResponse(
      `국세법령정보시스템 '${retryContext.originalQuery || args.query || "(전체)"}' ${label} 검색 결과가 없습니다${triedQueries}.`,
      {
        L1: [
          "키워드를 짧게 줄이거나 가운뎃점·공백 제거 (예: '연구·인력개발비' → '연구개발비').",
          "docType을 all 또는 interpretations/disputes로 확대.",
        ],
        L2: [
          "통합 컬렉션이 필요하면 search_taxlaw_all.",
          "본 도구는 01–10 코드만 지원 — 그 밖의 자료는 아래 actionId를 call_taxlaw_action으로 호출.",
        ],
        L3: [
          "korean-law-mcp.search_decisions(domain=precedent/interpretation/tax_tribunal/constitutional) 병행 — 최신 조세심판원은 NTS, 일부 대법원·헌재는 법제처가 강세.",
        ],
      },
      { toolName: "search_taxlaw_documents" },
    )
  }

  const title = codes.length === 1 ? docLabel(codes[0]) : codes.map((code) => docLabel(code)).join(", ")
  const currentPage = asPositiveInt(args.page, 1)
  const pageSize = asPositiveInt(args.display, 10, 50)
  const estimatedPages = total > 0 ? Math.ceil(total / pageSize) : 0
  const lines = [
    `국세법령정보시스템 문서 검색 결과: ${title}`,
    `출처: ${TAXLAW_BASE}/action.do (ASIPDI002PR01)`,
    `검색어: ${args.query || "(전체)"} / 총 ${total.toLocaleString()}건 / page=${currentPage}/${estimatedPages.toLocaleString()} (display=${pageSize}) — 다음 페이지: page=${currentPage + 1}`,
    "주의: 아래 결과는 국세법령정보시스템 응답에 존재한 항목만 표시합니다. 각 행의 [ID]를 get_taxlaw_document_text(full=true)에 넣으면 전문(판례·결정례는 주문·판단 포함).",
    "",
  ]
  // v0.9.5 — 복합어 자동 분해 재시도로 회수된 결과에 대한 안내
  if (retryContext.originalQuery && retryContext.originalQuery !== args.query) {
    lines.push(describeRetryAttempt(retryContext.originalQuery, args.query || "", total), "")
  }
  if (duplicatesRemoved > 0) {
    lines.push(`중복 제거: 같은 문서번호/회신번호/제목으로 보이는 ${duplicatesRemoved.toLocaleString()}건은 표시에서 제외했습니다.`, "")
  }
  if (failedGroups.length > 0) {
    const labels = failedGroups.map((entry) => entry.group.kind === "question" ? "세법해석례/질의회신" : "판례·결정례").join(", ")
    const reasons = failedGroups.map((entry) => entry.reason instanceof Error ? entry.reason.message : String(entry.reason)).join("; ")
    lines.push(`⚠️ 일부 그룹 조회 실패(표시되지 않음): ${labels} — ${reasons}`, "")
  }

  // v0.9.5 — post-fetch 필터링 통계: NTS API가 taxLawCode를 strict하게 필터링하지 않아
  // 응답에 다른 코드 케이스가 섞이는 빈도를 사용자/LLM에게 알림.
  if (args.taxLawCode) {
    const mismatchCount = items.filter(
      (item) => !taxLawCodeMatches(args.taxLawCode, cleanText(item.NTST_TLAW_CL_CD || "")),
    ).length
    if (mismatchCount > 0) {
      lines.push(
        `⚠️ taxLawCode 불일치: 요청 코드 ${args.taxLawCode}(${describeTaxLawCode(args.taxLawCode)})와 응답이 다른 항목 ${mismatchCount}건 — 각 결과 줄에 ⚠ taxLawCode_mismatch 라벨 부착. NTS API의 코드 필터 한계로 인한 정상 동작이며, 다른 코드 케이스를 그대로 인용하려면 본문 확인 후 사용하세요.`,
        "",
      )
    }
  }

  // v0.9.6 — 응답에 등장한 unique 세목 코드의 묶음세 안내를 헤더 1회로 압축.
  // 매 결과 항목에 반복되던 `(부가가치세·개별소비세·주세·인지세)` 같은 부가설명을 헤더로 이동.
  // v0.9.7 — 매핑표 외 코드(310 국제조세, 309 조세특례 등)도 헤더에 포함하기 위해 NTS 분류명 동반 전달.
  const codeHeader = formatTaxLawCodeHeader(items.map((it) => ({
    code: cleanText(it.NTST_TLAW_CL_CD || ""),
    name: cleanText(it.NTST_TLAW_CL_NM || ""),
  })))
  if (codeHeader) lines.push(codeHeader, "")

  // v0.16.0(G9) — citationBound 인용게이트 칩: INSTRUCTIONS/COMPANION_NOTICE의 PASSIVE 라우팅을 결과시점 ACTIVE 1줄로.
  // 검색→산출물 인용이 곧 실패 경로(검색근거≠쟁점·요지≠holding)이므로, 인용 절차를 결과 헤더에 직접 들이민다.
  if (items.length > 0 && args.verbose !== false) {
    lines.push(
      "[COMPANION·인용게이트] 결론·분류로 인용할 땐: 제목/요지/관련법령으로 쟁점 확인(검색근거≠쟁점) → get_taxlaw_document_text(full=true) 주문·판단 대조(요지≠holding) → 조문은 korean-law get_law_text 동반 → 작성 후 verify_nts_citations(claims=[{citation,proposition,basis}])로 실존+명제 게이트. 핵심/보조 티어 금지.",
      "",
    )
  }

  // v0.9.12 — relevance_low overflow 경고. 멀티 키워드(2개+) 쿼리에서 회수 항목의 80% 이상이
  // query 토큰을 하나도 매칭하지 않으면 "사실상 매칭 실패" 시그널. NTS 검색 엔진이 OR로 빠진
  // 결과를 반환하지만 본문은 사용자 의도와 무관한 경우(예: "신성장원천기술 R&D 세액공제" → 변형
  // 분해로 "R&D"만 매칭된 무관 회신). 자동 변형 재시도 결과에 특히 잦으므로 사용자/LLM이
  // 본문 클릭 전에 "다른 키워드 조합으로 재시도" 판단을 빠르게 하도록 헤더 1줄로 안내.
  //
  // 자동 재시도로 들어온 호출은 args.query가 분해 후 단일 토큰일 수 있으므로(예: "R&D"),
  // 원본 쿼리(retryContext.originalQuery)가 있으면 그쪽 토큰을 기준으로 판정.
  const relevanceQuery = retryContext.originalQuery || args.query
  if (relevanceQuery && items.length >= 3) {
    const tokens = relevanceQuery.split(/\s+/).filter((t) => t.length > 1)
    if (tokens.length >= 2) {
      const lowCount = items.reduce((cnt, item) => {
        const haystack = [
          cleanText(item.TTL),
          cleanText(item.GIST_CNTN || item.CNTN || ""),
          cleanText(item.FILE_CN || ""),
        ].join(" ")
        const r = judgeRelevance(relevanceQuery, haystack)
        return cnt + (r.matchedRatio === 0 ? 1 : 0)
      }, 0)
      if (lowCount / items.length >= 0.8) {
        lines.push(
          `⚠️ relevance_low overflow: ${lowCount}/${items.length}건이 원본 query 토큰을 본문에 포함하지 않음 — 사실상 매칭 실패. 키워드를 1~2개 핵심 단어로 줄이거나, 합성어를 분리(예: "신성장원천기술 R&D 세액공제" → "신성장원천기술" 또는 "통합투자세액공제")해서 재시도 권장.`,
          "",
        )
      }
    }
  }

  const verbose = args.verbose !== false
  items.forEach((item) => lines.push(formatDocumentSearchItem(item, args.query, args.taxLawCode, verbose), ""))
  return textResponse(truncate(lines.join("\n"), 50000))
}

async function getTaxlawDocumentText(args: DocumentDetailArgs): Promise<ToolResponse> {
  const rawId = requireString("id", args.id)
  const id = normalizeDetailId(rawId)
  const knownCode = docCodeFromType(args.docType)
  const attempts = knownCode
    ? [refererForDoc(knownCode, id)]
    : [`/qt/USEQTA002P.do?ntstDcmId=${encodeURIComponent(id)}`, `/pd/USEPDA002P.do?ntstDcmId=${encodeURIComponent(id)}`]

  let lastError: unknown
  for (const referer of attempts) {
    try {
      const data = await postTaxlawAction<TaxlawDetailData>(
        "ASIQTB002PR01",
        { dcmDVO: { ntstDcmId: id } },
        referer,
      )
      const detail = data.ASIQTB002PR01
      const dcm = detail.dcmDVO
      if (!dcm) continue
      return textResponse(formatDocumentDetail(id, dcm, detail, args.full === true, referer, args.targetYear))
    } catch (error) {
      lastError = error
    }
  }

  if (lastError instanceof TaxlawMcpError) {
    if (attempts.length === 1) throw lastError
    if (lastError.code !== ErrorCodes.NOT_FOUND && lastError.code !== ErrorCodes.PARSE_ERROR) {
      throw lastError
    }
  }
  return notFoundResponse(`국세법령정보시스템 문서 상세를 찾을 수 없습니다: ${rawId}`, [
    "search_taxlaw_documents로 DOC_ID를 다시 확인하세요.",
    "docType을 알고 있으면 함께 입력하세요.",
  ], { toolName: "get_taxlaw_document_text" })
}

async function getTaxlawDocumentByNumber(args: DocumentNumberArgs): Promise<ToolResponse> {
  const rawDocNo = requireString("docNo", args.docNo)
  const codes = documentCodes(args.docType, "all")
  const groups = splitDocumentCodes(codes)
  if (groups.length === 0) {
    throw new TaxlawMcpError("No supported document type selected.", ErrorCodes.INVALID_PARAM)
  }

  const searchArgs: DocumentSearchArgs = {
    query: rawDocNo,
    display: 50,
    page: 1,
    sort: "date_desc",
    verbose: false,
  }
  const settled = await Promise.allSettled(groups.map((group) => searchDocumentGroup(group, searchArgs)))
  const results = settled
    .filter((s): s is PromiseFulfilledResult<{ group: "question" | "precedent"; codes: string[]; result: TaxlawSearchData["ASIPDI002PR01"] }> => s.status === "fulfilled")
    .map((s) => s.value)
  const failedGroups = settled.filter((s) => s.status === "rejected")

  if (results.length === 0) {
    throw failedGroups[0]?.reason ?? new TaxlawMcpError("Taxlaw document-number search failed.", ErrorCodes.API_ERROR)
  }

  const candidates = results.flatMap((entry) => (entry.result.body || [])
    .map((row) => row.dcm)
    .filter((item): item is TaxlawDcm => !!item))
  const hit = candidates.find((item) => matchDocumentNumber(item as Record<string, unknown>, rawDocNo))
  if (!hit) {
    if (failedGroups.length > 0) {
      throw new TaxlawMcpError(
        `문서번호 "${rawDocNo}" 직접조회가 일부 검색그룹 실패로 불완전합니다(공개DB 미발견으로 단정하지 않음).`,
        ErrorCodes.API_ERROR,
        ["docType을 지정해 검색 범위를 좁혀 재호출하세요.", "잠시 후 다시 시도하거나 korean-law-mcp의 판례·결정례 검색을 병행하세요."],
      )
    }
    return notFoundResponse(
      `국세법령정보시스템 문서번호·회신번호 "${rawDocNo}"를 찾을 수 없습니다.`,
      [
        "공백·하이픈을 제외한 정확한 문서번호를 확인하세요.",
        "docType을 알고 있으면 함께 입력해 검색 범위를 좁혀 재시도하세요.",
      ],
      { toolName: "get_taxlaw_document_by_number" },
    )
  }

  const id = cleanText(hit.DOC_ID || hit.DOCID || hit.ntstDcmId)
  if (!id) {
    throw new TaxlawMcpError(
      `문서번호 "${rawDocNo}" 검색 결과에 상세조회용 DOC_ID가 없습니다.`,
      ErrorCodes.PARSE_ERROR,
    )
  }

  const codeRaw = cleanText(hit.NTST_DCM_CL_CD || hit.ntstDcmClCd).replace(/^001_/, "")
  const code = codeRaw.padStart(2, "0")
  const detailType = DOC_TYPE_LABELS[code] ? code : args.docType
  return getTaxlawDocumentText({
    id,
    docType: detailType,
    full: args.full,
    targetYear: args.targetYear,
  })
}

// v0.27.4(라이브 루프) — capOverride 추가. 호출부가 결과를 다시 truncate하면 꼬리의 guardLines가
//   통째로 잘린다(v0.27.1에서 이 함수 내부만 "경고 우선 예산"으로 고치고 호출부를 놓친 누락).
//   research_taxlaw_topic이 9,000/20,000자로 재절단해 판단·결론부 확인·요지-결과 정합성·연도검증이
//   전부 사라지고 있었다(실측 3/3). cap을 내부로 넘겨 budgetedJoin이 경고를 먼저 확보하게 한다.
function formatDocumentDetail(id: string, dcm: TaxlawDcm, detail: TaxlawDetailData["ASIQTB002PR01"], full: boolean, referer: string, targetYear?: number, capOverride?: number): string {
  const relatedLaws = (detail.dcmRltnStttList || [])
    .map((item) => cleanText(item.ntstTextNm))
    .filter(Boolean)
    .join(", ")
  const referencePrecedents = (detail.dcmRfrnPrtsList || [])
    .map((item) => [cleanText(item.ntstDcmDscmCntn), cleanText(item.ntstDcmTtl)].filter(Boolean).join(" "))
    .filter(Boolean)
  const quotedPrecedents = (detail.dcmQutPrtsList || [])
    .map((item) => [cleanText(item.ntstDcmDscmCntn), cleanText(item.ntstDcmTtl)].filter(Boolean).join(" "))
    .filter(Boolean)
  const bodyText = detailTextFromHtmlList(detail.dcmHwpEditorDVOList)
  const code = dcm.ntstDcmClCd || dcm.NTST_DCM_CL_CD
  const type = dcm.ntstDcmClNm || dcm.NTST_DCM_CL_NM || docLabel(code)
  const title = cleanText(dcm.ntstDcmTtl || dcm.TTL)

  const lines = [
    `=== ${title || "(제목 없음)"} ===`,
    "",
    "기본 정보:",
    `  ID: ${dcm.ntstDcmId || id}`,
    `  구분: ${type}`,
    `  세목코드: ${dcm.ntstTlawClCd || "N/A"}`,
    `  문서번호: ${cleanText(dcm.ntstDcmDscmCntn || dcm.NTST_DCM_DSCM_CNTN) || "N/A"}`,
    `  회신번호: ${cleanText(dcm.ntstDcmRplyCntn || dcm.NTST_DCM_RPLY_CNTN) || "N/A"}`,
    `  결정: ${cleanText(dcm.ntstDcmDcsClNm || dcm.NTST_DCM_DCS_CL_NM) || "N/A"}`,
    `  생산일자: ${normalizeDate(dcm.ntstDcmRgtDt || dcm.DCM_RGT_DTM)} / 등록일자: ${normalizeDate(dcm.frsRgtDtm || dcm.FRS_RGT_DTM)}`,
    `  출처: ${TAXLAW_BASE}${referer}`,
  ]
  if (relatedLaws) lines.push(`  관련법령: ${relatedLaws}`)
  lines.push("")

  const gist = cleanText(dcm.ntstDcmGistCntn || dcm.GIST_CNTN)
  const answer = cleanText(dcm.ntstDcmCntn || dcm.CNTN)
  if (gist) lines.push("요지:", gist, "")
  if (answer) lines.push("본문/회신/결정내용:", answer, "")
  if (bodyText) lines.push(full ? "원문 변환 텍스트:" : "원문 변환 텍스트(일부 생략 가능):", compactBodyText(bodyText, full, code), "")
  if (referencePrecedents.length > 0) {
    lines.push("참조 판례:", ...referencePrecedents.slice(0, 20).map((item) => `  - ${item}`), "")
  }
  if (quotedPrecedents.length > 0) {
    lines.push("인용 판례:", ...quotedPrecedents.slice(0, 20).map((item) => `  - ${item}`), "")
  }

  // 연도 적용여부 검증 (관련규정 섹션 파싱). 본문이 없으면 답변 텍스트를 사용.
  // v0.27.1(리뷰 P1) — 안전 경고를 본문과 분리 조립한다.
  //   종전: 본문(full이면 45,000자)+판례 목록을 lines에 먼저 쌓고, 연도검증·구조개편·기본통칙·holding
  //   경고를 뒤에 붙인 뒤 전체를 50,000/30,000자로 잘랐다. full=true면 여유가 ~5,000자뿐이라
  //   회신문이 조금만 길어도 경고 전체가 통째로 사라졌다 — 그런데 full=true는 인용을 진지하게
  //   검증할 때 쓰는 옵션이라, 가장 필요한 순간에 가드가 사라지는 역전이 발생했다.
  const guardLines: string[] = []
  // 본문에서 헤더를 못 찾으면 문서 메타데이터의 관련법령 목록(relatedLaws)으로 fallback.
  const sourceForYearCheck = [gist, answer, bodyText].filter(Boolean).join("\n\n")
  if (sourceForYearCheck || relatedLaws) {
    const productionDateForCheck = normalizeDate(dcm.ntstDcmRgtDt || dcm.DCM_RGT_DTM)
    const result = checkYearApplicability({
      bodyText: sourceForYearCheck,
      targetYear,
      metadataCitations: relatedLaws,
      productionDate: productionDateForCheck,
    })
    guardLines.push("", ...formatYearCheck(result), "")

    // v0.9.0 — 본문·메타에서 추출한 인용 조문에 옛 위치(전부개정 전) 매핑이 있으면 추가 안내.
    // v0.9.2 — bodyText 전달로 본문 substring 재확인 (citation 80자 윈도우 노이즈 차단).
    const citedRefs = extractLawArticleRefs([gist, answer, bodyText, relatedLaws].filter(Boolean).join("\n"))
    const verifyBody = [gist, answer, bodyText].filter(Boolean).join("\n")
    const restructureHits = detectPreRestructureCitations(citedRefs, verifyBody)
    if (restructureHits.length > 0) {
      guardLines.push("", ...formatRestructureHits(restructureHits), "")
    }

    guardLines.push(
      "동반 호출 필수: 위 검증은 본문 휴리스틱입니다. 인용 법조문의 현행 적용가능성은 반드시 korean-law-mcp의 search_law + get_law_text(mst=..., jo=...)로 직접 대조 후 사용자에게 보고하세요.",
      "",
    )
  }

  // 기본통칙 인용 검증 — 본문에 "기본통칙 N-N" 또는 "N-N…M"가 있으면 LLM에게 직접 조회를 강제.
  // 옛 번호 형식("N-N")이 검출되면 답변에 그대로 옮기지 말도록 ⚠ 강제 경고.
  const sourceForRulingCheck = [gist, answer, bodyText].filter(Boolean).join("\n\n")
  if (sourceForRulingCheck) {
    const rulingRefs = extractBasicRulingRefs(sourceForRulingCheck)
    if (rulingRefs.length > 0) {
      const legacy = rulingRefs.filter((r) => r.format === "legacy_candidate")
      const current = rulingRefs.filter((r) => r.format === "current")
      guardLines.push("── 기본통칙 인용 검증 ──")
      if (legacy.length > 0) {
        guardLines.push(
          `⚠ 옛 번호 형식("N-N") 통칙 인용 ${legacy.length}건 검출 — 현행 번호 체계는 "N-N…M". 답변에 그대로 옮기지 말 것:`,
        )
        for (const ref of legacy) {
          guardLines.push(`  - ${formatBasicRulingRef(ref)} → 현행 번호 미확인. get_taxlaw_basic_ruling_text 호출 필수`)
        }
      }
      if (current.length > 0) {
        guardLines.push(`현행 형식 통칙 인용 ${current.length}건:`)
        for (const ref of current) {
          guardLines.push(`  - ${formatBasicRulingRef(ref)}`)
        }
      }
      guardLines.push("강제 절차:")
      guardLines.push("  1) list_taxlaw_basic_ruling_laws(query=세법명)로 lawId 확보")
      guardLines.push("  2) get_taxlaw_basic_ruling_text(lawId, query=주제어)로 현행 본문/번호 직접 확인")
      guardLines.push("  3) 단건이 아닌 주제어로 호출 → 인접 번호대 일괄 수집 (관련 통칙 군집 누락 방지)")
      guardLines.push("")
    }
  }

  // v0.9.14 — 판례·결정례 결론부(판단·주문) 잘림 경고 + 요지-결과 정합성 가드
  if (bodyText) {
    const holdingWarn = detectHoldingTruncation({
      code,
      fullBody: bodyText,
      shownBody: compactBodyText(bodyText, full, code),
      isFull: full,
      gist,
      structuredReply: answer, // v0.21.0(#G5) — 구조화 회신 필드(CNTN). 채워졌으면 결론이 전량 표시돼 해석례 tail 가드 무발화.
    })
    if (holdingWarn.length > 0) guardLines.push(...holdingWarn, "")
  }

  // v0.27.1 — 경고 우선 예산 배분(budgetedJoin). 안전 경고는 잘리지 않고 본문이 남은 예산으로 잘린다.
  return budgetedJoin(lines, guardLines, capOverride ?? (full ? 50000 : 30000))
}

async function assessDoctrineValidityTool(args: AssessDoctrineArgs): Promise<ToolResponse> {
  const rawId = requireString("id", args.id)
  const id = normalizeDetailId(rawId)
  const knownCode = docCodeFromType(args.docType)
  const attempts = knownCode
    ? [refererForDoc(knownCode, id)]
    : [`/qt/USEQTA002P.do?ntstDcmId=${encodeURIComponent(id)}`, `/pd/USEPDA002P.do?ntstDcmId=${encodeURIComponent(id)}`]

  let lastError: unknown
  for (const referer of attempts) {
    try {
      const data = await postTaxlawAction<TaxlawDetailData>(
        "ASIQTB002PR01",
        { dcmDVO: { ntstDcmId: id } },
        referer,
      )
      const detail = data.ASIQTB002PR01
      const dcm = detail.dcmDVO
      if (!dcm) continue

      const relatedLaws = (detail.dcmRltnStttList || [])
        .map((item) => cleanText(item.ntstTextNm))
        .filter(Boolean)
        .join(", ")
      const bodyText = detailTextFromHtmlList(detail.dcmHwpEditorDVOList)
      const gist = cleanText(dcm.ntstDcmGistCntn || dcm.GIST_CNTN)
      const answer = cleanText(dcm.ntstDcmCntn || dcm.CNTN)
      const title = cleanText(dcm.ntstDcmTtl || dcm.TTL)
      const code = dcm.ntstDcmClCd || dcm.NTST_DCM_CL_CD
      const type = dcm.ntstDcmClNm || dcm.NTST_DCM_CL_NM || docLabel(code)
      const docNumber = cleanText(dcm.ntstDcmDscmCntn || dcm.NTST_DCM_DSCM_CNTN)
      const productionDate = normalizeDate(dcm.ntstDcmRgtDt || dcm.DCM_RGT_DTM)
      const taxLawCode = dcm.ntstTlawClCd || ""

      const sourceForYearCheck = [gist, answer, bodyText].filter(Boolean).join("\n\n")
      const yearCheck = checkYearApplicability({
        bodyText: sourceForYearCheck,
        targetYear: args.targetYear,
        metadataCitations: relatedLaws,
        productionDate,
      })
      // 인용 조문 추출: 본문 + 메타데이터 모두를 source로 (관련법령 메타에 조문 번호가 흔히 있음).
      const citedArticles = extractLawArticleRefs([gist, answer, bodyText, relatedLaws].filter(Boolean).join("\n"))

      const meta: DoctrineMeta = {
        id: dcm.ntstDcmId || id,
        title,
        docNumber,
        productionDate,
        type,
        taxLawCode,
        relatedLawsMeta: relatedLaws,
      }
      const assessment = assessDoctrineValidity({
        meta,
        yearCheck,
        citedArticles,
        targetYear: args.targetYear,
        bodyText: sourceForYearCheck,  // v0.9.2 — restructure 본문 substring 재확인용
      })

      const out: string[] = []
      out.push(`=== 예규 현행 유효성 자동 평가: ${title || meta.id} ===`)
      out.push("")
      out.push(`출처: ${TAXLAW_BASE}${referer}`)
      out.push(`구분: ${meta.type} / 문서번호: ${meta.docNumber} / 생산일자: ${meta.productionDate}`)
      out.push("")
      out.push(...formatAssessment(assessment))
      if (args.full) {
        out.push("")
        out.push("── 본문 발췌 (full=true) ──")
        out.push(compactBodyText(sourceForYearCheck, true))
      }
      return textResponse(truncate(out.join("\n"), 50000))
    } catch (error) {
      lastError = error
    }
  }

  if (lastError instanceof TaxlawMcpError) {
    if (attempts.length === 1) throw lastError
    if (lastError.code !== ErrorCodes.NOT_FOUND && lastError.code !== ErrorCodes.PARSE_ERROR) {
      throw lastError
    }
  }
  return notFoundResponse(`국세법령정보시스템 문서를 찾을 수 없습니다: ${rawId}`, [
    "search_taxlaw_documents로 DOC_ID를 다시 확인하세요.",
    "docType을 알고 있으면 함께 입력하세요.",
  ], { toolName: "get_taxlaw_document_text" })
}

async function getTaxlawHometaxCounselText(args: HometaxCounselArgs): Promise<ToolResponse> {
  const id = requireString("id", args.id)
  const referer = `/is/USEISA004P.do?reqStdId=${encodeURIComponent(id)}`
  const data = await postTaxlawAction<HometaxCounselData>(
    "ASEISA004MR01",
    { reqStdId: id },
    referer,
  )
  const item = data.ASEISA004MR01
  if (!item || !item.reqStdId) {
    return notFoundResponse(`국세법령정보시스템 홈택스 상담사례 상세를 찾을 수 없습니다: ${id}`, [
      "search_taxlaw_all에서 hometaxCnslThan 결과의 ID를 다시 확인하세요.",
    ], { toolName: "get_taxlaw_hometax_counsel_text" })
  }

  const answer = cleanText(item.answerStdContent)
  const lines = [
    `=== ${cleanText(item.stdTitle) || "(제목 없음)"} ===`,
    "",
    "기본 정보:",
    `  ID: ${item.reqStdId}`,
    `  상담유형: ${cleanText(item.reqTpNm) || "N/A"}`,
    `  등록일자: ${normalizeDate(item.regstDt)}`,
    `  출처: ${TAXLAW_BASE}${referer}`,
    "",
    "답변:",
    answer || "N/A",
  ]
  return textResponse(truncate(lines.join("\n"), 30000))
}

function listTaxlawSiteMenus(args: SiteMenuArgs): ToolResponse {
  const query = cleanText(args.query).toLowerCase()
  const menus = SITE_MENU_ACTIONS.filter((menu) => {
    if (!query) return true
    return [
      menu.key,
      menu.section,
      menu.label,
      menu.path,
      menu.actionId,
      menu.highLevelTool,
      menu.note,
    ].filter(Boolean).join(" ").toLowerCase().includes(query)
  })

  if (menus.length === 0) {
    return notFoundResponse(`국세법령정보시스템 메뉴 목록에서 '${args.query || "(전체)"}' 결과가 없습니다.`)
  }

  const lines = [
    "국세법령정보시스템 주요 메뉴 접근 목록",
    `출처: ${TAXLAW_BASE}/index.do 및 각 메뉴의 action.do 요청 관찰`,
    `표시: ${menus.length.toLocaleString()}개`,
    "",
  ]
  for (const menu of menus) {
    lines.push(`[${menu.key}] ${menu.section} > ${menu.label}`)
    lines.push(`  URL: ${TAXLAW_BASE}${menu.path}`)
    if (menu.highLevelTool) lines.push(`  고수준 도구: ${menu.highLevelTool}`)
    if (menu.actionId) {
      lines.push(`  actionId: ${menu.actionId}`)
      lines.push(`  defaultParamData: ${JSON.stringify(menu.defaultParamData ?? {})}`)
      lines.push("  원시조회: call_taxlaw_action에 actionId/defaultParamData/refererPath 사용")
    }
    if (menu.note) lines.push(`  메모: ${menu.note}`)
    lines.push("")
  }
  lines.push(
    "참고:",
    "  - highLevelTool이 명시된 메뉴는 해당 고수준 도구를 우선 사용하세요(검색 결과·환상 가드 일관성).",
    "  - actionId만 명시된 메뉴는 call_taxlaw_action(actionId=…, paramData=defaultParamData, refererPath=URL)로 호출하세요.",
    "  - note만 있는 정적 페이지는 get_taxlaw_page_text(path=...)를 사용하세요.",
    "  - 응답 본문에 표시되지 않은 사실은 추론·생성하지 마세요.",
  )
  return textResponse(truncate(lines.join("\n"), 50000))
}

async function callTaxlawAction(args: RawActionArgs): Promise<ToolResponse> {
  const actionId = requireString("actionId", args.actionId)
  if (!/^[A-Z0-9]+$/.test(actionId)) {
    throw new TaxlawMcpError("actionId must contain only uppercase letters and digits", ErrorCodes.INVALID_PARAM)
  }
  const refererPath = normalizeTaxlawPath(args.refererPath)
  const paramData = args.paramData && typeof args.paramData === "object" ? args.paramData : {}
  const data = await postTaxlawAction<unknown>(actionId, paramData, refererPath)

  if (isEmptyPayload(data)) {
    return notFoundResponse(
      `국세법령정보시스템 action.do(${actionId}) 응답에 표시 가능한 데이터가 없습니다.`,
      [
        "paramData의 필수 필드(검색어/일자/페이지)를 점검하세요.",
        "list_taxlaw_site_menus로 메뉴별 defaultParamData를 확인 후 재시도하세요.",
      ],
    )
  }

  const lines = [
    "국세법령정보시스템 action.do 원시 응답",
    `출처: ${TAXLAW_BASE}/action.do`,
    `referer: ${TAXLAW_BASE}${refererPath}`,
    `actionId: ${actionId}`,
    `paramData: ${JSON.stringify(paramData)}`,
    "주의: 아래 JSON은 NTS action.do의 원시 응답입니다. 응답에 명시되지 않은 사실은 추론·생성하지 말고, 키 이름·값을 그대로 인용해 답변하세요.",
    ...(args.full === true ? [] : ["참고: 토큰 절감을 위해 null·빈 필드는 생략했습니다. 원시 전체(빈 필드 포함)는 full=true로 재호출하세요."]),
    "",
    stringifyJson(data, args.full === true),
  ]
  return textResponse(lines.join("\n"))
}

export function isEmptyPayload(data: unknown): boolean {
  if (data === null || data === undefined) return true
  if (Array.isArray(data)) return data.length === 0
  if (typeof data === "object") {
    const entries = Object.entries(data as Record<string, unknown>)
    if (entries.length === 0) return true
    return entries.every(([, value]) => isEmptyPayload(value))
  }
  if (typeof data === "string") return data.trim().length === 0
  return false
}

async function getTaxlawPageText(args: TaxlawPageTextArgs): Promise<ToolResponse> {
  // v0.21.0(#G10) — path 미지정 시 "/index.do" 무음 폴백 제거(엉뚱한 홈 페이지 반환 방지). 명시 필수.
  const path = normalizeTaxlawPath(requireString("path", args.path))
  const { response, text: raw } = await fetchTextWithRetry(`${TAXLAW_BASE}${path}`, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
      "user-agent": userAgent(),
    },
  })
  if (!response.ok) {
    throw new TaxlawMcpError(`Taxlaw page fetch failed (${response.status})`, ErrorCodes.API_ERROR)
  }

  const contentType = response.headers.get("content-type") || "N/A"
  const body = /html|xml/i.test(contentType) || /<[^>]+>/.test(raw) ? htmlToText(raw) : decodeHtml(raw)
  const trimmedLength = body.trim().length
  if (trimmedLength < 40) {
    return notFoundResponse(
      `경로 ${path}의 본문이 비어 있거나 의미 있는 텍스트(${trimmedLength}자)를 포함하지 않습니다.`,
      [
        "동적으로 채워지는 페이지일 가능성이 높습니다. call_taxlaw_action으로 해당 메뉴의 actionId를 호출하세요.",
        "list_taxlaw_site_menus의 note에 정적/동적 여부 안내가 있으니 확인하세요.",
      ],
    )
  }

  const lines = [
    "국세법령정보시스템 페이지 텍스트",
    `출처: ${TAXLAW_BASE}${path}`,
    `content-type: ${contentType}`,
    "주의: 아래 텍스트는 HTML 변환 결과이며, 표·이미지·동적 데이터(JS로 채워지는 목록 등)는 누락될 수 있습니다. 본문에 명시되지 않은 내용은 추론·생성하지 마세요.",
    "",
    truncate(body, args.full === true ? 50000 : 15000),
  ]
  return textResponse(lines.join("\n"))
}

// ── v0.24.0(F-min) — 세법집행기준 조회(번호·연도판본·수록페이지). 본문은 PDF/스니펫 경로 안내(서버측 PDF 파싱 없음).
//   레지스트리는 NTS common_st.js 정적 15건(라이브 확인 2026-07-14). 식별키=ntstBscId(유일), ntstPlcnBkId는 MR03 동반 파라미터.
interface ExecStdLaw { ntstNm: string; ntstBscId: string; ntstPlcnBkId: string; aliases: string[] }
const EXEC_STD_REGISTRY: ExecStdLaw[] = [
  { ntstNm: "국세기본법", ntstBscId: "100000000000001586", ntstPlcnBkId: "511100000000000001", aliases: ["국기법", "국세기본"] },
  { ntstNm: "국세징수법", ntstBscId: "100000000000001585", ntstPlcnBkId: "511100000000000002", aliases: ["국세징수", "징수법"] },
  { ntstNm: "법인세", ntstBscId: "100000000000001563", ntstPlcnBkId: "511100000000000003", aliases: ["법인세법", "법인"] },
  { ntstNm: "국제조세", ntstBscId: "100000000000000603", ntstPlcnBkId: "511100000000000004", aliases: ["국조", "국제조세조정"] },
  { ntstNm: "종합소득세", ntstBscId: "100000000000001565", ntstPlcnBkId: "511100000000000005", aliases: ["소득세", "소득세법", "종소세", "종합소득"] },
  { ntstNm: "양도소득세", ntstBscId: "200000000000001565", ntstPlcnBkId: "511100000000000006", aliases: ["양도세", "양도"] },
  { ntstNm: "종합부동산세", ntstBscId: "100000000000009873", ntstPlcnBkId: "511100000000000007", aliases: ["종부세", "종합부동산"] },
  { ntstNm: "상속증여세", ntstBscId: "100000000000001561", ntstPlcnBkId: "511100000000000008", aliases: ["상증세", "상속세", "증여세", "상속증여"] },
  { ntstNm: "개별소비세", ntstBscId: "100000000000001570", ntstPlcnBkId: "511100000000000009", aliases: ["개소세"] },
  { ntstNm: "인지세", ntstBscId: "100000000000001568", ntstPlcnBkId: "511100000000000009", aliases: [] },
  { ntstNm: "주세", ntstBscId: "100000000000001566", ntstPlcnBkId: "511100000000000009", aliases: ["주세법"] },
  { ntstNm: "주류면허법", ntstBscId: "100000000000013931", ntstPlcnBkId: "511100000000000009", aliases: ["주류면허"] },
  { ntstNm: "증권거래세", ntstBscId: "100000000000000621", ntstPlcnBkId: "511100000000000010", aliases: ["증권거래"] },
  { ntstNm: "부가가치세", ntstBscId: "100000000000001571", ntstPlcnBkId: "510000000000000448", aliases: ["부가세", "부가", "부가가치"] },
  { ntstNm: "조세특례제한법", ntstBscId: "100000000000001584", ntstPlcnBkId: "510000000000000823", aliases: ["조특법", "조특", "조세특례"] },
]

export function resolveExecStdLaw(law: string): ExecStdLaw | undefined {
  const q = String(law || "").replace(/\s+/g, "").replace(/집행기준$/, "")
  if (!q) return undefined
  return (
    EXEC_STD_REGISTRY.find((e) => e.ntstNm === q || e.aliases.includes(q)) ||
    EXEC_STD_REGISTRY.find((e) => e.ntstNm.startsWith(q) || e.aliases.some((a) => a.startsWith(q))) ||
    EXEC_STD_REGISTRY.find((e) => q.includes(e.ntstNm) || e.ntstNm.includes(q))
  )
}

// 집행기준 번호 정규화: "제24조-제21조-1", "24-21-1", "7의4-6의4-2" → "의N" 리터럴 유지, 제/조/공백 제거.
export function normalizeExecNo(s: string): string {
  return String(s || "").replace(/제/g, "").replace(/조/g, "").replace(/[·\s]/g, "").replace(/[–—]/g, "-")
}
// ntstTextNm(" 24-21-1  제목") → {no, title}. 개행·다중공백 정규화.
export function parseExecTitleNo(ntstTextNm: string): { no: string; title: string } {
  const t = String(ntstTextNm || "").replace(/\s+/g, " ").trim()
  const m = t.match(/^([0-9의\-]+)\s+(.*)$/)
  return m ? { no: m[1], title: m[2] } : { no: "", title: t }
}
// 사용자 번호 ↔ 목차 번호 매칭: 정확 또는 하이픈 경계 prefix("24-21" → "24-21-1").
export function matchExecNumber(userNo: string, itemNo: string): boolean {
  const a = normalizeExecNo(userNo), b = normalizeExecNo(itemNo)
  if (!a || !b) return false
  return a === b || b.startsWith(a + "-")
}

interface ExecEdition { rgtYr?: string; plcnDt?: string; fleId?: string; fleSn?: number | string }
interface ExecTocRaw { ntstTextNm?: string; srtOrdr?: number | string; lawClCd?: string | number; ntstExrBaseSn?: string }
interface ExecStdArgs { law?: unknown; number?: unknown; query?: unknown; year?: unknown; full?: unknown }

async function getExecutionStandard(args: ExecStdArgs): Promise<ToolResponse> {
  const lawArg = requireString("law", args.law)
  const entry = resolveExecStdLaw(lawArg)
  if (!entry) {
    return notFoundResponse(`세법집행기준 법령을 찾지 못했습니다: ${lawArg}`, [
      `사용 가능 법령: ${EXEC_STD_REGISTRY.map((e) => e.ntstNm).join(", ")}`,
    ])
  }
  const mr03 = await postTaxlawAction<Record<string, { exeBaseDVOList?: ExecEdition[] }>>(
    "ASISTE001MR03", { ntstBscId: entry.ntstBscId, ntstPlcnBkId: entry.ntstPlcnBkId }, "/st/USESTE001M.do",
  )
  const editions = (mr03?.ASISTE001MR03?.exeBaseDVOList || [])
    .filter((e) => e.rgtYr)
    .sort((a, b) => Number(b.rgtYr) - Number(a.rgtYr))
  if (!editions.length) {
    return notFoundResponse(`${entry.ntstNm} 집행기준 판본을 찾지 못했습니다.`, [
      "레지스트리 ID가 변경됐을 수 있습니다 — search_taxlaw_all(collections=formerLibrary)로 대체 검색하세요.",
    ])
  }
  const wantYear = typeof args.year === "number" ? args.year : args.year ? Number(args.year) : undefined
  const ed = wantYear
    ? (editions.find((e) => Number(e.rgtYr) <= wantYear) || editions[editions.length - 1])
    : editions[0]
  const pdfUrl = `${TAXLAW_BASE}/downloadFile.do?fleId=${ed.fleId}&fleSn=${ed.fleSn}`

  const mr02 = await postTaxlawAction<Record<string, { exeBaseDVOList?: ExecTocRaw[] }>>(
    "ASISTE001MR02", { ntstBscId: entry.ntstBscId, rgtYr: ed.rgtYr }, "/st/USESTE001M.do",
  )
  const toc = (mr02?.ASISTE001MR02?.exeBaseDVOList || [])
    .filter((x) => String(x.lawClCd) === "5")
    .map((x) => ({ ...parseExecTitleNo(String(x.ntstTextNm || "")), srtOrdr: Number(x.srtOrdr) || 0 }))
  const pages = [...new Set(toc.map((t) => t.srtOrdr))].sort((a, b) => a - b)
  const pageEnd = (start: number): string => {
    const nxt = pages.find((p) => p > start)
    return nxt ? `${start}~${nxt}` : `${start}~`
  }

  const header = [
    `세법집행기준 조회 — ${entry.ntstNm}`,
    `출처: ${TAXLAW_BASE}/st/USESTE001M.do`,
    `판본: ${ed.rgtYr}${ed.plcnDt ? ` (발간 ${formatYmd(String(ed.plcnDt))})` : ""} — ⚠ 판본연도는 발간시점 해설이지 귀속연도 아님. 귀속 판정은 부칙(build_application_timetable).`,
    "⚠ 집행기준은 국세청 행정해석(법규성 없음) — 법령·판례가 우선.",
    `사용 가능 판본(연도): ${editions.map((e) => e.rgtYr).join(", ")}`,
    "",
  ]
  const numberArg = args.number ? String(args.number).trim() : ""
  const queryArg = args.query ? String(args.query).trim() : ""

  if (numberArg) {
    const hits = toc.filter((t) => matchExecNumber(numberArg, t.no))
    if (!hits.length) {
      return textResponse([...header,
        `✗ 번호 "${numberArg}" 미발견 — 이 판본(${ed.rgtYr}) 목차에 없습니다(오기 또는 다른 판본 가능). 실존 확인 실패.`,
        `전체 목차는 number 없이 재호출(또는 다른 year). PDF: ${pdfUrl}`,
      ].join("\n"), false, "NOT_FOUND")
    }
    const body = hits.slice(0, 20).map((h) => `✔ ${h.no}  ${h.title}  (수록 p.${pageEnd(h.srtOrdr)})`)
    return textResponse([...header,
      `[번호 조회: "${numberArg}"] ${hits.length}건 매칭`,
      ...body, "",
      `본문 인출: PDF 다운로드 후 Read(pages=시작–끝) — ${pdfUrl}`,
      `또는 스니펫: search_taxlaw_all(collections=formerLibrary, query="${hits[0].no} ${hits[0].title.slice(0, 12)}")`,
    ].join("\n"))
  }
  if (queryArg) {
    const hits = toc.filter((t) => t.title.includes(queryArg))
    if (!hits.length) {
      return textResponse([...header, `✗ 제목에 "${queryArg}" 포함 항목 없음(판본 ${ed.rgtYr}). PDF: ${pdfUrl}`].join("\n"), false, "NOT_FOUND")
    }
    const body = hits.slice(0, 30).map((h) => `· ${h.no}  ${h.title}  (p.${pageEnd(h.srtOrdr)})`)
    return textResponse([...header,
      `[제목 검색: "${queryArg}"] ${hits.length}건${hits.length > 30 ? " (상위 30건)" : ""}`,
      ...body, "",
      `본문: PDF ${pdfUrl} — 해당 페이지 Read`,
    ].join("\n"))
  }
  const cap = args.full === true ? 400 : 80
  const body = toc.slice(0, cap).map((h) => `· ${h.no}  ${h.title}  (p.${pageEnd(h.srtOrdr)})`)
  return textResponse([...header,
    `[전체 목차] ${toc.length}개 항목${toc.length > cap ? ` (상위 ${cap}건 — number/query로 좁히거나 full=true)` : ""}`,
    ...body, "",
    `본문: PDF 다운로드 후 해당 페이지 Read — ${pdfUrl}`,
  ].join("\n"))
}

export interface AddendaUnit {
  promulgationDate: string
  promulgationNo: string
  text: string
}

// 법제처 DRF type=XML 응답의 <부칙내용>은 여러 <![CDATA[...]]> 조각으로 나뉘어 있고
// 조각 안에는 <제35999호,2025.12.31> 같은 '리터럴 꺾쇠'가 들어있다. 따라서 일반 태그 제거를
// 적용하면 부칙 헤더가 잘린다. CDATA 조각만 추출해 이어 붙이고, 수식 <img>만 마커로 치환한다.
export function extractCdataText(block: string): string {
  // v0.25.0(리뷰 SEC-4b) — CDATA 조각 추출을 indexOf 선형 스캔으로(의미 동일: 각 '<![CDATA[' 이후 첫 ']]>'까지,
  // 무종결 조각은 종전과 동일하게 미채택). 종전 lazy 정규식은 무종결 '<![CDATA[' 다수에서 O(n²) — 실측 1M자 9.2s.
  const chunks: string[] = []
  let i = 0
  for (;;) {
    const s = block.indexOf("<![CDATA[", i)
    if (s === -1) break
    const e = block.indexOf("]]>", s + 9)
    if (e === -1) break
    chunks.push(block.slice(s + 9, e))
    i = e + 3
  }
  const joined = (chunks.length > 0 ? chunks.join("") : block)
    .replace(/<img\b[^>]*>/gi, " [수식이미지] ")
  return joined
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

// 법령 본문 XML 끝의 <부칙> 노드를 공포번호별 <부칙단위>로 분해한다.
// 현행 MST를 조회하면 과거 개정 부칙까지 누적 포함된다(개정령마다 1개 부칙단위).
export function parseLawAddenda(xml: string): AddendaUnit[] {
  const open = xml.lastIndexOf("<부칙>")
  const close = xml.indexOf("</부칙>", open)
  if (open === -1 || close === -1) return []
  const section = xml.slice(open, close)
  const units: AddendaUnit[] = []
  const unitRe = /<부칙단위[^>]*>([\s\S]*?)<\/부칙단위>/g
  let m: RegExpExecArray | null
  while ((m = unitRe.exec(section))) {
    const block = m[1]
    const date = (block.match(/<부칙공포일자>([\s\S]*?)<\/부칙공포일자>/)?.[1] || "").trim()
    const no = (block.match(/<부칙공포번호>([\s\S]*?)<\/부칙공포번호>/)?.[1] || "").trim()
    const contentBlock = block.match(/<부칙내용>([\s\S]*?)<\/부칙내용>/)?.[1] || ""
    units.push({ promulgationDate: date, promulgationNo: no, text: extractCdataText(contentBlock) })
  }
  return units
}

// v0.27.1(리뷰 P2) — 캐시 키에서 OC(인증키) 제거.
//   종전 `moleg:${url}`은 OC를 그대로 키에 실었다. ① 응답은 OC와 무관한 공개 법령 XML인데
//   OC가 다르면 캐시가 분산되고 ② 비밀키가 Map 키로 24시간 메모리에 잔류했다.
//   OC 파라미터만 제거한 canonical URL을 키로 쓴다(나머지 파라미터는 응답을 결정하므로 유지).
export function molegCacheKey(url: string): string {
  return `moleg:${String(url).replace(/([?&])(?:oc|%4f%43)=[^&]*/gi, "$1__oc__")}`
}

async function fetchMolegXml(url: string, label: string): Promise<string> {
  const cacheKey = molegCacheKey(url)
  const cached = cacheGet(cacheKey)
  if (cached !== null) return cached
  const { response, text: xml } = await fetchTextWithRetry(url, {
    headers: { accept: "application/xml,text/xml;q=0.9,*/*;q=0.5", "user-agent": userAgent() },
  })
  if (!response.ok) {
    throw new TaxlawMcpError(`법제처 ${label} 실패 (${response.status})`, ErrorCodes.API_ERROR)
  }
  cacheSet(cacheKey, xml, MOLEG_CACHE_TTL_MS)
  return xml
}

async function resolveLawMst(oc: string, lawName: string): Promise<string> {
  const url = `${MOLEG_BASE}/DRF/lawSearch.do?OC=${encodeURIComponent(oc)}&target=law&type=XML&display=5&query=${encodeURIComponent(lawName)}`
  const xml = await fetchMolegXml(url, "법령 검색")
  const mst = (xml.match(/<법령일련번호>([\s\S]*?)<\/법령일련번호>/)?.[1] || "").trim()
  if (!mst) {
    throw new TaxlawMcpError(
      `'${lawName}' 법령의 MST를 찾지 못했습니다. korean-law-mcp의 search_law로 정확한 mst를 확보해 전달하세요.`,
      ErrorCodes.NOT_FOUND,
    )
  }
  return mst
}

// 법제처 시행일법령(eflaw) 검색으로 같은 법령의 최근 시행본 MST들을 시행일 내림차순(중복 제거)으로 반환.
// 타법개정 통합본이 직전 일부개정 부칙을 누락하는 consolidation lag를 메우기 위함.
async function fetchEflawMsts(oc: string, lawName: string, limit: number): Promise<string[]> {
  // v0.20.0(#5) — display를 40으로 맞춰 fetchEflawVersions(display=40)와 URL(=fetchMolegXml 캐시 키)을 일치시킨다.
  // → timetable/addenda가 같은 eflaw 목록을 2회 왕복하던 중복 제거(두 번째 호출 캐시 적중). 반환 MST는 limit로 break하므로 불변.
  const url = `${MOLEG_BASE}/DRF/lawSearch.do?OC=${encodeURIComponent(oc)}&target=eflaw&type=XML&display=40&query=${encodeURIComponent(lawName)}`
  const xml = await fetchMolegXml(url, "시행일 법령 검색")
  // v0.21.0(#G2) — eflaw lawSearch(query=법령명)는 이름이 '포함'된 타법(시행령·시행규칙 등)까지 반환하므로,
  //   행(law 요소) 단위로 파싱해 법령명 키가 일치하는 행만 남긴다(fetchEflawVersions의 lawNameKey 방식과 동일).
  //   일치 0건이면 기존 동작(전체 행)으로 폴백(filterVersionsByName과 동일 semantics) — addenda 보강 누락 방지.
  const key = lawNameKey(lawName)
  const rows: Array<{ mst: string; match: boolean }> = []
  for (const row of xml.matchAll(/<law(?:\s[^>]*)?>([\s\S]*?)<\/law>/g)) {
    const block = row[1]
    const mst = (block.match(/<법령일련번호>(\d+)<\/법령일련번호>/)?.[1] || "").trim()
    if (!mst) continue
    const name = (block.match(/<법령명한글>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/법령명한글>/)?.[1] || "").trim()
    rows.push({ mst, match: !!key && lawNameKey(name) === key })
  }
  // <law> 래퍼가 없어 행 파싱이 0건이면 종전 bare-regex 추출로 폴백(기존 동작 보존).
  if (rows.length === 0) {
    const out: string[] = []
    const seen = new Set<string>()
    for (const m of xml.matchAll(/<법령일련번호>(\d+)<\/법령일련번호>/g)) {
      if (seen.has(m[1])) continue
      seen.add(m[1])
      out.push(m[1])
      if (out.length >= limit) break
    }
    return out
  }
  const anyMatch = rows.some((r) => r.match)
  const out: string[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    if (anyMatch && !r.match) continue // 일치 행이 존재하면 타법 행 배제
    if (seen.has(r.mst)) continue
    seen.add(r.mst)
    out.push(r.mst)
    if (out.length >= limit) break
  }
  return out
}

export interface LawVersion { mst: string; enforceDate: string; promDate?: string; lawName?: string }

// 법령명 정규화 키(공백 제거) — eflaw 행 필터·법령명 동일성 비교용.
export function lawNameKey(s: string): string {
  return String(s || "").replace(/\s+/g, "")
}

// v0.21.0(#G11) — 표시용(출처) 법령 URL: OC(API키) 파라미터를 뺀 형태. 응답에 노출되는 모든 `출처:`
// 라인·URL 필드에 이걸 쓴다. 내부 fetch용 URL은 OC를 포함한 채 별도로 만든다(기능 불변).
export function displayLawServiceUrl(mst: string): string {
  return `${MOLEG_BASE}/DRF/lawService.do?target=law&MST=${encodeURIComponent(mst)}&type=XML`
}

// eflaw 검색 결과에서 lawName과 정확히 일치하는 행만(공백 무시). 일치 0건이면 원본 그대로(기존 동작 보존).
// v0.11.0 — eflaw lawSearch(query=법령명)는 이름이 '포함'된 모든 법령(시행령·시행규칙 등)을 반환하므로,
// 이력이 적은 법령은 타법 행이 섞여 '현행본' 오판(교차법령 대조)을 일으킨다(리뷰 실증: 가상자산법 ↔ 시행령).
export function filterVersionsByName(versions: LawVersion[], lawName: string): LawVersion[] {
  const key = lawNameKey(lawName)
  if (!key) return versions
  const hit = versions.filter((v) => v.lawName && lawNameKey(v.lawName) === key)
  return hit.length ? hit : versions
}

// v0.27.0(리뷰 P1) — 위 폴백('일치 0건이면 원본')은 가용성을 위해 유지하되 '무경고'만 없앤다.
//   실측 문제: "요청법"을 검색해 "요청법 시행령" 행만 잡히면 그 시행령이 그대로 채택되고,
//   이후 본문·부칙·후행개정 가드가 전부 엉뚱한 법령을 대상으로 '일관되게' 돌아 오류 신호가 하나도 안 뜬다.
//   폴백 자체를 막지 않는 이유: 제명 변경·표기 흔들림(구법명 등)에서 정상 회수를 실패시키면 더 나쁘다.
//   타법(cross-law) 경로는 오귀속 비용이 더 커서 filterVersionsByNameStrict(0건=안전 강등)를 계속 쓴다.
export function lawNameFallbackNote(versions: LawVersion[], lawName: string): string | null {
  const key = lawNameKey(lawName)
  if (!key || versions.length === 0) return null
  if (versions.some((v) => v.lawName && lawNameKey(v.lawName) === key)) return null
  const names = [...new Set(versions.map((v) => v.lawName).filter(Boolean))].slice(0, 3)
  if (names.length === 0) return null
  return `⚠ 제명 정확일치 0건 — 요청 "${lawName}"과 검색 결과 제명(${names.join(", ")})이 다릅니다. 아래 시점본·부칙·개정 판정이 '다른 법령'을 대상으로 수행됐을 수 있습니다. 정확한 제명으로 다시 지정하거나, korean-law-mcp search_law로 MST를 확보해 mst로 직접 전달하세요.`
}

// eflaw 검색으로 (mst, 시행일자, 공포일자, 법령명)을 시행일 내림차순으로. 시점별 조문 회수용.
// v0.11.0 — 행(law 요소) 단위 파싱으로 전환: 필드별 3-pass index-zip의 어긋남 위험 제거 + 법령명한글 캡처.
async function fetchEflawVersions(oc: string, lawName: string, limit: number): Promise<LawVersion[]> {
  const url = `${MOLEG_BASE}/DRF/lawSearch.do?OC=${encodeURIComponent(oc)}&target=eflaw&type=XML&display=40&query=${encodeURIComponent(lawName)}`
  const xml = await fetchMolegXml(url, "시행일 법령 검색")
  const out: LawVersion[] = []
  const seen = new Set<string>()
  for (const row of xml.matchAll(/<law(?:\s[^>]*)?>([\s\S]*?)<\/law>/g)) {
    const block = row[1]
    const mst = (block.match(/<법령일련번호>(\d+)<\/법령일련번호>/)?.[1] || "").trim()
    if (!mst) continue
    const enforceDate = (block.match(/<시행일자>(\d+)<\/시행일자>/)?.[1] || "").trim()
    const promDate = (block.match(/<공포일자>(\d+)<\/공포일자>/)?.[1] || "").trim()
    const name = (block.match(/<법령명한글>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/법령명한글>/)?.[1] || "").trim()
    const key = `${mst}:${enforceDate}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ mst, enforceDate, promDate, lawName: name })
    if (out.length >= limit) break
  }
  return out.sort((a, b) => (b.enforceDate || "").localeCompare(a.enforceDate || ""))
}

// 특정 시점(efYd, YYYYMMDD)에 시행 중이던 버전. v0.10.0 — 공포일자 우선 tie-break:
// 분할시행(예: 제36127호 2.27 공포본의 7.1 시행 행)은 시행일이 늦어도 '그 공포 시점의 텍스트'라
// 후행 공포본(예: 5.22 자구개정)을 반영하지 못한다. 시행일 ≤ efYd 후보 중 공포일이 가장 늦은
// 공포본(=후행 개정 누적 통합본)을 선택해야 그 시점 실제 문구에 가깝다.
// v0.27.8 — efYd 형식 검증. pickVersionInForce는 문자열 사전순 비교라 형식이 깨지면 조용히 틀린다:
//   "2023-12-31"은 '-'(0x2D) < '0'(0x30) 이라 "20230101"보다 작게 비교돼 한 판본 뒤(2022 시행본)를 고르고,
//   출력에는 "efYd 2023-12-31 시점 시행본"이라 라벨된다 — ISO 표기는 흔한 오타라 실제로 밟힌다(실측 확인).
//   구분자 형태는 의도가 명확하므로 정규화하고, 그 외는 거부한다(조용히 현행본으로 흘리지 않는다).
export function normalizeEfYd(raw: unknown, paramName = "efYd"): { efYd: string; note?: string } {
  const s = String(raw ?? "").trim()
  if (!s) return { efYd: "" }
  const sep = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/)
  const digits = sep ? `${sep[1]}${sep[2].padStart(2, "0")}${sep[3].padStart(2, "0")}` : s
  if (!/^\d{8}$/.test(digits)) {
    throw new TaxlawMcpError(
      `${paramName}는 YYYYMMDD 8자리여야 합니다(받은 값: "${s}"). 연도만 지정하려면 ${paramName === "efYd" ? "year" : paramName.replace("efYd", "year")}=YYYY를 사용하세요.`,
      ErrorCodes.INVALID_PARAM,
    )
  }
  const y = Number(digits.slice(0, 4)), m = Number(digits.slice(4, 6)), d = Number(digits.slice(6, 8))
  if (y < 1948 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) {
    throw new TaxlawMcpError(`${paramName} 날짜 범위 오류: "${s}" (1948~2100년, 월 1~12, 일 1~31).`, ErrorCodes.INVALID_PARAM)
  }
  return { efYd: digits, note: sep ? ` (${paramName} "${s}" → ${digits} 정규화)` : undefined }
}

// v0.27.8 — 연도 파라미터도 같은 이유로 조용히 틀린다. 스키마는 number지만 클라이언트가 "2023"
//   문자열을 보내면 `typeof === "number"` 게이트에 걸려 시점 지정이 통째로 무시되고 현행본이 나온다
//   (요청 시점본을 받았다고 오독). 숫자 문자열은 받아주고, 그 외/범위 밖은 거부한다.
export function normalizeYear(raw: unknown, paramName = "year"): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined
  const n = typeof raw === "number" ? raw : /^\s*\d{4}\s*$/.test(String(raw)) ? Number(String(raw).trim()) : NaN
  if (!Number.isInteger(n) || n < 1948 || n > 2100) {
    throw new TaxlawMcpError(
      `${paramName} 형식/범위 오류: ${JSON.stringify(raw)} — 1948~2100 사이의 연도(YYYY)여야 합니다.`,
      ErrorCodes.INVALID_PARAM,
    )
  }
  return n
}

export function pickVersionInForce(versions: LawVersion[], efYd: string): LawVersion | null {
  const cands = versions
    .filter((v) => v.enforceDate && v.enforceDate <= efYd)
    .sort((a, b) => (b.promDate || "").localeCompare(a.promDate || "") || b.enforceDate.localeCompare(a.enforceDate))
  return cands[0] || null
}

export function todayYmd(d = new Date()): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`
}

// v0.11.0 — 구버전 조문 회수 시 '후행 개정' 능동 경고.
// 실측 사고(2026-06-12, 통합고용 조서): get_law_article(year=2025)가 구법(MST 279739)을 반환하며
// 말미 '최근 시행본' 목록에 신법(MST 286597)을 수동 나열했지만, "이 조문이 후행 개정본에서
// 변경·삭제됐다"는 조문 단위 능동 신호가 없어 호출자가 '신법 사후관리 별도 확인 필요' hedge로
// 도피 → §29의8③ 삭제<2025.12.23> 누락. 목록의 수동 나열만으로는 부족하다는 교훈의 구현.
// currentArticleVerdict: 현행본 같은 조문 자동 대조 결과(공백 무시 비교) — getLawArticle이 계산해 전달.
export type ArticleDiffVerdict = "same" | "differs" | "missing" | "unknown"

// 조문 대조용 정규화: 수식 이미지 마커는 flSeq(파일 일련번호)가 통합본마다 달라질 수 있어
// 중립 마커로 치환(동일 수식의 false 'differs' 방지) 후 공백 제거.
export function normalizeArticleForCompare(t: string): string {
  return String(t || "").replace(/\[수식이미지→[^\]]*\]/g, "[수식이미지]").replace(/\s+/g, "")
}

// 법령 XML에서 조문단위 블록을 찾는다. v0.11.0 — 종전 indexOf('<![CDATA[제N조(')는
// 부칙내용의 bare CDATA(조 단위 분할, '제9조(자기관리…)' 류 1,293개 실측)에 오매칭되어
// 삭제 조문이 부칙 garbage와 대조되는 결함이 있었다(리뷰 실증). <조문내용> 래퍼로 앵커링해 배제.
// 전부 삭제된 조문은 '<조문내용><![CDATA[제9조 삭제 <2019.12.31>]]>' 형태(괄호 없음) → deleted로 적극 보고.
// v0.26.0(리뷰 EF-2 보험) — <조문내용>에 속성이 붙은 변형(<조문내용 ...>)도 앵커가 관용(실 피드는 bare지만 방어). 여전히 bare도 매칭(strict superset).
export function findArticleInXml(
  xml: string,
  jo: string,
): { status: "found" | "deleted" | "missing"; block?: string; deletedDate?: string } {
  const joEsc = jo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const open = new RegExp(`<조문내용(?:\\s[^>]*)?>\\s*<!\\[CDATA\\[\\s*${joEsc}\\(`).exec(xml)
  if (open) {
    const s = xml.lastIndexOf("<조문단위", open.index)
    const e = xml.indexOf("</조문단위>", open.index)
    if (s !== -1 && e !== -1) return { status: "found", block: xml.slice(s, e) }
    return { status: "missing" } // 구조 파손 — 안전 측으로 미발견 처리
  }
  const del = new RegExp(`<조문내용(?:\\s[^>]*)?>\\s*<!\\[CDATA\\[\\s*${joEsc}\\s*삭제\\s*<([^>]*)>`).exec(xml)
  if (del) return { status: "deleted", deletedDate: del[1].trim() }
  return { status: "missing" }
}

// v0.12.1 — getLawArticle의 현행본 대조 판정을 순수 함수로 추출(네트워크 분리 → 단위 테스트 가능).
//   curXml(현행본 XML)에서 같은 조문을 찾아 oldText와 공백·flSeq 무시 비교 →
//   same/differs/missing(+삭제일) 판정. fetch 실패는 호출부에서 unknown 처리.
export function classifyAgainstCurrent(
  curXml: string,
  jo: string,
  oldText: string,
): { verdict: ArticleDiffVerdict; deletedDate?: string; hasFormulaImages: boolean } {
  const found = findArticleInXml(curXml, jo)
  if (found.status === "found") {
    const curText = extractArticleBody(found.block || "").text
    return {
      verdict: normalizeArticleForCompare(curText) === normalizeArticleForCompare(oldText) ? "same" : "differs",
      hasFormulaImages: curText.includes("[수식이미지"),
    }
  }
  return { verdict: "missing", deletedDate: found.deletedDate, hasFormulaImages: false }
}

export function buildLaterRevisionGuard(opts: {
  versions: LawVersion[]
  usedMst: string
  usedEnforceDate: string
  today: string // YYYYMMDD
  jo: string
  currentArticleVerdict?: ArticleDiffVerdict
  currentDeletedDate?: string // verdict=missing이면서 현행본에 '삭제 <날짜>' 표기가 확인된 경우
  hasFormulaImages?: boolean // 대조 본문에 수식 이미지 포함(이미지 내용은 대조 범위 밖)
}): string[] {
  const { versions, usedMst, usedEnforceDate, today, jo } = opts
  if (!versions.length || !usedMst) return []
  const current = pickVersionInForce(versions, today)
  // 시행예정(pending): eflaw는 (MST×시행일) 행을 옛 공포본까지 보존하므로 시행일별로
  // 최신 공포본 행만 채택(superseded 행 혼입 시 건수 과대 + 구버전 텍스트 유도 — 리뷰 실증).
  const pendingByDate = new Map<string, LawVersion>()
  for (const v of versions) {
    if (!v.enforceDate || v.enforceDate <= today) continue
    const prev = pendingByDate.get(v.enforceDate)
    if (!prev || (v.promDate || "") > (prev.promDate || "")) pendingByDate.set(v.enforceDate, v)
  }
  const pending = [...pendingByDate.values()].sort((a, b) => a.enforceDate.localeCompare(b.enforceDate))
  const isCurrent = !current || current.mst === usedMst
  if (isCurrent && pending.length === 0) return []
  const fmt = (d?: string) => (d ? formatYmd(d) : "?")
  const lines = ["── 후행 개정 확인 ──"]
  if (!isCurrent && current) {
    if (usedEnforceDate && usedEnforceDate > today) {
      // 공포-미시행본을 의도 조회한 경우 — '구버전' 프레임은 방향이 반대다.
      lines.push(
        `ℹ [조문 단위] 조회본은 시행예정본(시행 ${fmt(usedEnforceDate)} — 오늘 ${fmt(today)} 기준 미시행)이다. 현재 시점 결론에는 현행본(시행 ${fmt(current.enforceDate)}, MST ${current.mst})을, 시행일 이후 귀속연도에는 이 본문을 적용하라.`,
      )
    } else {
      lines.push(
        `⚠ [조문 단위] 조회본(시행 ${fmt(usedEnforceDate)}, MST ${usedMst})은 오늘(${fmt(today)}) 기준 현행본이 아니다 — 현행: 시행 ${fmt(current.enforceDate)}, MST ${current.mst}${current.promDate ? ` (공포 ${fmt(current.promDate)})` : ""}.`,
      )
      const verdict = opts.currentArticleVerdict ?? "unknown"
      if (verdict === "differs") {
        lines.push(
          `⚠ ${jo}는 현행본에서 본문이 변경됨(자동 대조 결과 — 삭제·신설 항 포함 가능). 이 구버전 문구로 현재·미래 귀속연도의 결론(요건·단가·사후관리 등)을 단정하지 마라.`,
          `  → 변경 hunk: diff_article_versions(jo="${jo}", mstA="${usedMst}", mstB="${current.mst}") / 현행 전문: get_law_article(mst="${current.mst}", jo="${jo}", full=true)`,
        )
      } else if (verdict === "missing") {
        lines.push(
          opts.currentDeletedDate
            ? `⚠ ${jo}는 현행본(MST ${current.mst})에서 삭제됨(현행본에 "삭제 <${opts.currentDeletedDate}>" 명시). 이 조문의 존재를 전제로 현재·미래 귀속연도 결론을 쓰지 마라.`
            : `⚠ ${jo}를 현행본(MST ${current.mst})에서 찾지 못함 — 삭제 또는 조문 이동. 확정 전에는 이 조문의 존재를 전제로 결론을 쓰지 마라.`,
          `  → 1콜 확정: diff_article_versions(jo="${jo}", mstA="${usedMst}", mstB="${current.mst}")(한쪽 부재 시 '조문 전체 신설/삭제' 판정). 삭제 시점·적용시기는 get_law_revision_text·get_law_addenda로 확인.`,
        )
      } else if (verdict === "same") {
        lines.push(
          `${jo}는 현행본(MST ${current.mst})과 문구 동일(자동 대조 — 변경 없음의 적극 신호). 단, 적용 시기는 부칙이 정한다.${opts.hasFormulaImages ? " 수식 이미지 내용은 대조 범위 밖(이미지 직접 확인 필요)." : ""}`,
        )
      } else {
        lines.push(
          `⚠ ${jo}의 현행본 대조에 실패 — diff_article_versions(jo="${jo}", mstA="${usedMst}", mstB="${current.mst}")로 변경 여부를 직접 확인하라.`,
        )
      }
    }
  }
  if (pending.length) {
    if (isCurrent) {
      // v0.12.0 — 현행본 조회의 상시 신호는 1줄 압축(개정 잦은 세법에서 alarm fatigue·토큰 비대 방지).
      const first = pending[0]
      lines.push(
        `ℹ 공포-미시행(시행예정) 개정 ${pending.length}건 [법령 단위 — 이 조문과 무관할 수 있음]: 최단 시행 ${fmt(first.enforceDate)} MST ${first.mst}${pending.length > 1 ? " 외" : ""} — 미래 귀속 결론 전 diff_article_versions(jo="${jo}", mstA=현행MST, mstB=해당MST)로 관련 여부 확인.`,
      )
    } else {
      const shown = pending
        .slice(0, 4)
        .map((v) => `시행 ${fmt(v.enforceDate)} | MST ${v.mst}${v.promDate ? ` (공포 ${fmt(v.promDate)})` : ""}`)
        .join(" / ")
      lines.push(
        `⚠ [법령 단위 신호 — 이 조문과 무관할 수 있음] 공포-미시행(시행예정) 개정 ${pending.length}건: ${shown}${pending.length > 4 ? " …" : ""}`,
        `  → 미래 귀속연도 결론 전 이 조문 관련 여부를 diff_article_versions(jo="${jo}", mstA=현행MST, mstB=해당MST)로 확인. 분할시행 행은 그 공포본 텍스트 기준이라 후행 공포본 미반영 가능.`,
      )
    }
  }
  return lines
}

// v0.12.2 — 해석 분기 가드: 세액공제 사후관리·추징형 조문의 "제N호/제N항을 적용하지 아니한다"류 문언은
// '해당 증가분 공제가 소멸'이 아니라 '낮은 호의 단가로 전환(강등)'을 뜻할 수 있다(삭제 vs 단가전환 = 해석 분기점).
// 실측 사고(2026-06-14): 조특법 §29의7② "청년 감소 → 제1항제1호 미적용"을 "제2호 = 원래 청년외 증가분만"으로
// 오독 → 정답은 전체 증가인원 전부 제2호(일반)단가(기재부 조특제도과-215·서면-2023-법인-0978). 추징식
// (시행령 §26의7⑤: 감소인원 × (상위호 − 하위호) = '프리미엄만 환수')과 forward 공제식의 정합성을 대조했으면
// 잡혔을 오류 — 문언 단정 전 해석례 확인 + 추징식 교차검증을 능동 강제한다. 본문 휴리스틱(순수 함수, 단위 테스트 대상).
// v0.20.1 — 확장: (a) 폐쇄 호구분형("각 호의 구분에 따른 금액 … 공제받은 금액 상당액") 조문 탐지 신설
// (구 조특법 §30의4② 같은 사보 2차 사후관리 — 요건 판정 후 해당 호의 '상당액'만 인정하는 폐쇄 열거형)
// (b) 기존 사후관리·추징형 가드 메시지 양방향화(폐쇄 호구분형에 단가전환 법리를 역으로 유추 적용하는 오류도 경계).
export function buildInterpretiveForkGuard(text: string, jo: string): string[] {
  if (!text) return []
  const lines: string[] = []
  // v0.26.1(리뷰 O2-6) — '공제하지 아니'(공제 배제형)도 포착. '납부하여야'는 모든 납부의무 과발동이라 제외.
  const hasExclusion = /(?:적용|공제)하지\s*(?:아니|않)/.test(text) // 적용/공제하지 아니한다/아니하고/않는다 등
  const refsClause = /제\d+호|제\d+항/.test(text)
  // v0.27.0(리뷰 P2) — 감면 조문 포착. 조특법 §6·§7 등 세액'감면' 사후관리도 공제와 동일한
  //   "배제 vs 단가 강등" 해석 분기를 갖는데 4-AND 게이트가 '공제'만 요구해 통째로 침묵했다.
  const isCredit = /(?:공제|감면)/.test(text)
  const isSunset = /감소|줄어든|추징|사후관리/.test(text) // v0.26.1(리뷰 O2-6) — '줄어든'(근로자 수 감소형) 추가
  if (hasExclusion && refsClause && isCredit && isSunset) {
    lines.push(
      "── 해석 분기 가드(세액공제 사후관리) ──",
      `⚠ ${jo}는 사후관리·추징형 문언("제N호/제N항을 적용하지 아니한다" 등)을 포함한다. 이 문언은 '해당 증가분 공제가 소멸'이 아니라 '낮은 호의 단가로 전환(강등)'을 의미할 수 있다(삭제 vs 단가전환 = 해석 분기점). 문언만으로 공제액·추징액·산식을 단정하지 마라.`,
      "  ① 해석례 확정: search_taxlaw_all/search_taxlaw_documents(해석례·질의)로 '해당 호 미적용 시 잔여연도 공제 산식'을 직접 확인하라. 온포인트 해석이 안 나오면 '해석 미확인'으로 hedge하고 literal로 메우지 마라(검색 실패 ≠ 해석 부재).",
      "  ② 추징식 정합성 교차검증: forward 공제식과 추징 산식(시행령: 감소인원 × (상위호 − 하위호) = '프리미엄만 환수' 구조)이 서로 모순되지 않는지 대조하라. 추징이 프리미엄만 환수하면 forward도 하위 호 단가는 유지되는 것이 정합 — 두 식이 충돌하면 레드플래그.",
      "  ③ 숫자 예시를 제도취지로 스트레스테스트: '전체 유지인데 공제가 줄면 말이 되나?' 1줄 점검.",
      "(실측: 조특법 §29의7② '청년 감소 → 제1항제1호 미적용'을 '제2호 = 원래 청년외 증가분만'으로 오독 → 정답은 전체 증가인원 전부 제2호 단가 / 기재부 조특제도과-215·서면-2023-법인-0978)",
      "역방향 오류도 경계: 폐쇄 호구분형 조문에는 이 전환 법리를 유추 적용하지 마라(해석례 부재 시 문언 우선).",
    )
  }
  // v0.21.0(#G6) — 정확 관용구 2개 AND는 문언 변형("각 호에 따른 금액", "공제한 세액…상당하는")에 침묵했다.
  //   변형군을 흡수하도록 완화(advisory 가드라 약간의 false positive 허용). 기존 문언도 계속 걸린다.
  const hasClosedEnum = /각\s*호(?:의\s*구분)?에\s*따른\s*금액/.test(text)
  const hasEquivalentAmount = /(?:공제받은|공제한)\s*(?:금액|세액)[^\n]{0,6}상당(?:액|하는)/.test(text)
  if (hasClosedEnum && hasEquivalentAmount) {
    lines.push(
      "── 해석 분기 가드(폐쇄 호구분형) ──",
      `⚠ ${jo}는 공제액을 '각 호의 구분'으로 폐쇄 열거하는 조문이다. 다른 공제 조문(조특법 §29의7 등)의 단가전환·유추 법리를 이 조문에 준용하지 마라 — 요건(청년등 감소 등) 판정 후 해당 호에 적힌 '상당액'만 인정된다. 개정 전후로 같은 항 번호가 전혀 다른 규정(공제↔사후관리·추징)을 가리킬 수 있으니 시점본(법률 번호)을 명기하고 인용하라. (실측: 구 조특법 §30의4② 2호 — 청년등 감소 시 제1항제2호 상당액만, 2026-07-13)`,
    )
  }
  return lines
}

// 조문단위 블록에서 본문 텍스트 + 수식 이미지(flDownload) URL을 뽑는다. 이미지는 URL 마커로 보존.
export function extractArticleBody(joBlock: string): { text: string; imageUrls: string[] } {
  const urls = [...joBlock.matchAll(/flDownload\.do\?flSeq=(\d+)/g)].map((m) => `${MOLEG_BASE}/DRF/flDownload.do?flSeq=${m[1]}`)
  const chunks: string[] = []
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(joBlock))) chunks.push(m[1])
  // v0.27.7 — 항/호/목 번호 중복 제거. 법제처 XML은 번호를 <항번호>와 <항내용> 양쪽에 담는다:
  //   <항번호>①</항번호><항내용>① 이 조에서 …</항내용>
  //   CDATA를 그대로 이어붙이면 "①①", "1.1.", "가.가."가 되어 매 조문 본문에 노이즈가 깔린다
  //   (법인세법 실측 642/642 항 전부 중복, 본문 175,687자 중 1,912자=1.09%).
  //   부작용도 있었다: 항 분할 split(/(?=[①②③…])/)이 "①" 단독 조각을 하나 더 만들어냈다.
  //   순수 번호 청크가 '바로 뒤 청크의 접두'일 때만 생략한다 — 둘이 다르면 보존하므로 정보 손실 없음.
  const MARKER_ONLY = /^(?:[①-⑳]|\d{1,2}\.|[가-힣]\.)$/
  // v0.27.8 — 조문 메타 CDATA(<조문제목>·<조문제개정일자문자열>)도 같은 이유로 본문 앞에 붙는다:
  //   <조문제목>정의</조문제목><조문제개정일자문자열>2013.1.1, …</조문제개정일자문자열>
  //   <조문내용>제2조(정의) … <개정 2013.1.1, …></조문내용>
  //   → "정의2013.1.1, 2018.12.24, 2022.12.31제2조(정의)…" 로 조문이 날짜로 시작하는 것처럼 보인다.
  //   법인세법 실측: 255개 조문단위 중 206개(81%)가 이 군더더기로 시작(≈3,320자).
  //   v0.27.7과 동일 원칙 — '뒤 청크에 그대로 남아 있을 때만' 생략하므로 정보 손실이 없다.
  const metaVals = new Set<string>()
  for (const tag of ["조문제목", "조문제개정일자문자열", "조문시행일자문자열"]) {
    const mm = joBlock.match(new RegExp(`<${tag}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`))
    const v = mm?.[1].trim()
    if (v) metaVals.add(v)
  }
  const deduped: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    const cur = chunks[i].trim()
    const next = chunks[i + 1]
    if (cur && cur.length <= 4 && MARKER_ONLY.test(cur) && next && next.trimStart().startsWith(cur)) continue
    if (cur && metaVals.has(cur) && chunks.slice(i + 1).join("").includes(cur)) continue
    deduped.push(chunks[i])
  }
  let text = deduped.length > 0 ? deduped.join("") : joBlock
  text = text
    .replace(/<img[^>]*flSeq=(\d+)[^>]*>/gi, (_s, n) => ` [수식이미지→${MOLEG_BASE}/DRF/flDownload.do?flSeq=${n}] `)
    .replace(/<img\b[^>]*>/gi, " [수식이미지] ")
  return {
    text: text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
    imageUrls: [...new Set(urls)],
  }
}

export interface AddendaSource { mst: string; units: AddendaUnit[]; promDate?: string }

// 부칙단위 본문 안의 <개정 YYYY.M.D.> 꼬리표를 추출한다. 부칙 조항이 후행 개정령에 의해
// 변경되면(부칙-of-부칙 개정) 법제처 통합본은 현행화 문구에 꼬리표를 단다
// (실사례: 제36342호가 제36127호 부칙 §11①·③을 자구개정 → "…적용한다. <개정 2026.5.22>").
// 부칙 헤더 리터럴 <제36342호,2026.5.22>는 매칭하지 않는다. 반환: 자기 공포일보다 뒤인
// 개정일(YYYYMMDD, 오름차순 dedup) — 즉 "이 부칙 문구는 개정 전과 다를 수 있다"는 신호.
export function detectAddendumRevisionTails(text: string, promulgationDate?: string): string[] {
  const dates = new Set<string>()
  for (const m of String(text || "").matchAll(/<\s*개정\s+([^>]*?)>/g)) {
    for (const d of m[1].matchAll(/(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})/g)) {
      dates.add(`${d[1]}${d[2].padStart(2, "0")}${d[3].padStart(2, "0")}`)
    }
  }
  const own = (promulgationDate || "").trim()
  return [...dates].filter((d) => !own || d > own).sort()
}

// 여러 시행본의 부칙단위를 공포번호 기준으로 union·dedup하고, 각 공포번호가 어느 MST에 있었는지 기록.
// dedup 우선순위(v0.9.21): ① 빈 본문 배제 ② 최신 통합본(시행본 자체의 공포일 promDate) 우선
// ③ promDate 동일·미상 시 긴 본문. — 같은 공포번호 부칙이 통합본마다 다른 경우(후행 개정령이 부칙을
// 자구개정한 케이스: 제36127호 부칙 §11을 제36342호가 개정)에 구문구가 더 길어도 stale 채택을 방지.
export function mergeAddendaUnits(sources: AddendaSource[]): { units: AddendaUnit[]; presence: Record<string, string[]> } {
  const byKey = new Map<string, AddendaUnit>()
  const srcMeta = new Map<string, string>() // key -> 채택된 unit의 출처 통합본 공포일
  const presence: Record<string, string[]> = {}
  for (const src of sources) {
    const srcDate = (src.promDate || "").trim()
    for (const u of src.units) {
      const key = u.promulgationNo || `${u.promulgationDate}:${u.text.length}:${u.text.slice(0, 40)}`
      if (!presence[key]) presence[key] = []
      if (!presence[key].includes(src.mst)) presence[key].push(src.mst)
      const ex = byKey.get(key)
      let take = false
      if (!ex) take = true
      else if ((u.text.length > 0) !== (ex.text.length > 0)) take = u.text.length > 0
      else if (srcDate !== (srcMeta.get(key) || "")) take = srcDate > (srcMeta.get(key) || "")
      else take = u.text.length > ex.text.length
      if (take) {
        byKey.set(key, u)
        srcMeta.set(key, srcDate)
      }
    }
  }
  const units = [...byKey.values()].sort((a, b) => (b.promulgationDate || "").localeCompare(a.promulgationDate || ""))
  return { units, presence }
}

interface PreparedAddenda {
  mst: string
  lawTitle: string
  url: string
  xml: string
  units: AddendaUnit[]
  sourceMsts: string[]
  supplementedNos: string[]
  resolvedNote: string
}

// 현행 MST + 최근 시행본들의 부칙을 union해 누락 보정한 결과를 준비. get_law_addenda/trace_article_application 공용.
async function prepareMergedAddenda(oc: string, mstArg: string, lawNameArg: string, depth: number): Promise<PreparedAddenda> {
  let primaryMst = mstArg
  let resolvedNote = ""
  if (!primaryMst) {
    primaryMst = await resolveLawMst(oc, lawNameArg)
    resolvedNote = ` — '${lawNameArg}'로 검색해 현행 MST 해소`
  }
  const lawServiceUrl = (m: string) => `${MOLEG_BASE}/DRF/lawService.do?OC=${encodeURIComponent(oc)}&target=law&MST=${encodeURIComponent(m)}&type=XML`
  const primaryXml = await fetchMolegXml(lawServiceUrl(primaryMst), "법령 조회")
  const lawTitle = (primaryXml.match(/<법령명_한글>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/법령명_한글>/)?.[1] || "").trim()
  const lawName = lawNameArg || lawTitle

  let recent: string[] = []
  if (lawName && depth > 1) {
    try { recent = await fetchEflawMsts(oc, lawName, depth) } catch { recent = [] }
  }
  const msts = [primaryMst, ...recent.filter((m) => m !== primaryMst)].slice(0, Math.max(1, depth))

  // v0.20.0(#6) — 비-primary 시행본 XML(최대 depth-1개)은 서로 독립 fetch이므로 직렬 await 대신 병렬(콜드캐시 벽시계 단축).
  // 순서·dedup은 mergeAddendaUnits가 promDate 기준이라 무관하고, primaryMst 조회(3405)는 mst로 하므로 배열 순서 보존이면 충분.
  const sources: AddendaSource[] = await Promise.all(msts.map(async (m) => {
    const xml = m === primaryMst ? primaryXml : await fetchMolegXml(lawServiceUrl(m), "법령 조회")
    // 그 통합본 자체의 공포일자(기본정보 첫 등장) — dedup 시 최신 통합본 우선 판정 기준
    const promDate = (xml.match(/<공포일자>(\d{8})<\/공포일자>/)?.[1] || "").trim()
    return { mst: m, units: parseLawAddenda(xml), promDate }
  }))
  const { units } = mergeAddendaUnits(sources)
  const primaryNos = new Set((sources.find((s) => s.mst === primaryMst)?.units || []).map((u) => u.promulgationNo).filter(Boolean))
  const supplementedNos = units
    .map((u) => u.promulgationNo)
    .filter((n): n is string => !!n && !primaryNos.has(n))

  // v0.21.0(#G11) — 반환 url은 출처 표기 전용(getLawAddenda/trace/timetable의 `출처:` 라인)이므로 OC 제외본으로. 내부 fetch는 위 lawServiceUrl(OC 포함) 유지.
  return { mst: primaryMst, lawTitle, url: displayLawServiceUrl(primaryMst), xml: primaryXml, units, sourceMsts: msts, supplementedNos, resolvedNote }
}

// ── v0.25.0(E3) — 준용 타법 자동 해소(cross-law 2층 타임라인). E2 라벨을 실제 인출로 승격.
//   안전장치 5종: strict 명칭 게이트(폴백 없음)·상한 2개 타법·depth 2·시간예산 사전게이트·실패 시 E2 강등.
export interface LawCtx { xml: string; units: AddendaUnit[]; lawTitle: string; mst: string }

// 법령 XML에서 조문(항) 개정 인벤토리+본문 회수(순수). trace·timetable 공용, self/cross 무차별.
// v0.25.0(리뷰 EF-2) — naive indexOf('<![CDATA[제N조(')는 부칙 bare-CDATA(조 단위 분할)에 오매칭되어
//   가짜 body+가짜 개정일을 반환했다(v0.11.0 findArticleInXml과 동일 결함) → <조문내용> 앵커·삭제감지 재사용.
// v0.25.0(리뷰 A4) — status 동반 반환: 소비자(trace·timetable cross 층)가 '조문 부재'를 "적용례 없음"
//   정상결과로 둔갑시키지 않도록 존재게이트 재료 제공. deleted는 삭제일 병기.
export function articleInfoFromXml(
  xml: string,
  tjo: string,
  thang?: string,
): { dates: string[]; body: string; status: "found" | "deleted" | "missing"; deletedDate?: string } {
  const found = findArticleInXml(xml, tjo)
  if (found.status === "deleted") return { dates: [], body: "", status: "deleted", deletedDate: found.deletedDate }
  if (found.status !== "found") return { dates: [], body: "", status: "missing" }
  const body = extractCdataText(found.block || "")
  if (!body) return { dates: [], body: "", status: "missing" }
  const inv = extractAmendmentInventory(body)
  const sym = thang ? hangToSymbol(thang) : null
  const hd = sym ? inv.byHang[sym] || [] : []
  return { dates: hd.length ? hd : inv.article, body, status: "found" }
}

// #G2 filterVersionsByName의 strict 변형: 정확 제명 일치만, 0건 시 폴백 없이 빈 배열.
// (cross-law 해소에서 폴백 행 채택 = resolveLawMst 첫행채택급 오해소 → 폴백 제거. self-law 경로는 기존 함수 무변경.)
export function filterVersionsByNameStrict(versions: LawVersion[], lawName: string): LawVersion[] {
  const key = lawNameKey(lawName)
  if (!key) return []
  return versions.filter((v) => v.lawName && lawNameKey(v.lawName) === key)
}

export type CrossLawResult = { ok: true; ctx: LawCtx } | { ok: false; reason: string }
const CROSS_MIN_BUDGET_MS = 15000

// 인용부호로 명시된 타법을 정확 제명으로 해소해 그 법령의 부칙 ctx 회수. 실패는 예외 대신 {ok:false}(도구 전체 실패 전파 금지).
async function resolveCrossLawCtx(oc: string, quotedName: string): Promise<CrossLawResult> {
  try {
    if (remainingBudgetMs(currentBudget()?.deadlineAt) < CROSS_MIN_BUDGET_MS) {
      return { ok: false, reason: "시간예산 부족으로 자동 해소 생략" }
    }
    const versions = await fetchEflawVersions(oc, quotedName, 40)
    const exact = filterVersionsByNameStrict(versions, quotedName)
    if (!exact.length) return { ok: false, reason: "eflaw 정확 제명 일치 없음(제명개정·약칭 가능 — korean-law search_law로 현행 제명 확인)" }
    const picked = pickVersionInForce(exact, todayYmd())
    if (!picked) return { ok: false, reason: "오늘 시행 중 버전 미해소" }
    const prep = await prepareMergedAddenda(oc, picked.mst, quotedName, 2)
    // v0.25.0(리뷰 A8) — lawService 응답 제명 사후검증: eflaw 행은 정확해도 XML 제명이 빈값·불일치·이상이면
    // 안전 강등(malformed 원격 응답이 권위 데이터로 전파 금지). 강등 방향이라 오탐 시에도 E2 라벨로 수렴.
    if (!prep.lawTitle || lawNameKey(prep.lawTitle) !== lawNameKey(quotedName)) {
      return { ok: false, reason: `타법 XML 제명 검증 실패(응답 제명 "${(prep.lawTitle || "").slice(0, 60) || "빈값"}" ≠ "${quotedName}") — korean-law search_law로 확인` }
    }
    return { ok: true, ctx: { xml: prep.xml, units: prep.units, lawTitle: prep.lawTitle, mst: prep.mst } }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "타법 해소 오류" }
  }
}

// 요청당 memoize + 상한 2개 타법(도구 콜 전체 기준). 지역 변수라 요청 간 누수 없음(HTTP 캐시가 요청 간 재사용 담당).
// v0.27.1(리뷰 P2) — prewarm 지원. memo가 Promise를 담으므로, 루프 진입 전에 서로 다른 타법명을
//   await 없이 한 번씩 태워두면 그 시점부터 병렬로 달리고 루프의 await는 진행 중인 것을 받기만 한다.
//   (종전: 서로 다른 타법 2건이 각각 ~15초면 30초가 직렬로 소모)
function makeCrossResolver(oc: string): ((lawName: string) => Promise<CrossLawResult>) & { prewarm: (names: Array<string | undefined>) => void } {
  const memo = new Map<string, Promise<CrossLawResult>>()
  let capLeft = 2
  const resolver = (name: string) => {
    const k = lawNameKey(name)
    let p = memo.get(k)
    if (!p) {
      p = capLeft-- > 0
        ? resolveCrossLawCtx(oc, name)
        : Promise.resolve({ ok: false as const, reason: "타법 자동 해소 상한(2) 초과 — build_application_timetable로 개별 확인" })
      memo.set(k, p)
    }
    return p
  }
  // 상한(capLeft) 소진 순서는 prewarm 호출 순서를 따른다 — 루프 순서와 동일하게 넘겨야 기존 선택과 일치.
  resolver.prewarm = (names: Array<string | undefined>) => {
    for (const n of names) if (n) resolver(n)
  }
  return resolver
}

export async function getLawAddenda(args: LawAddendaArgs): Promise<ToolResponse> {
  const oc = String(args.oc ?? process.env.LAW_GO_KR_OC ?? "").trim()
  if (!oc) {
    throw new TaxlawMcpError(
      "법제처 Open API 인증키(OC)가 필요합니다. 환경변수 LAW_GO_KR_OC를 설정하거나 oc 파라미터로 전달하세요. (korean-law-mcp가 쓰는 것과 동일한 OC 키)",
      ErrorCodes.INVALID_PARAM,
    )
  }
  const mstArg = String(args.mst ?? "").trim()
  const lawName = String(args.lawName ?? "").trim()
  if (!mstArg && !lawName) {
    throw new TaxlawMcpError("mst 또는 lawName 중 하나는 필수입니다.", ErrorCodes.INVALID_PARAM)
  }
  const prep = await prepareMergedAddenda(oc, mstArg, lawName, 4)
  const { mst, lawTitle, url, units, sourceMsts, supplementedNos, resolvedNote } = prep
  if (units.length === 0) {
    return notFoundResponse(
      `MST ${mst}의 부칙 노드를 찾지 못했습니다.`,
      [
        "MST가 유효한지 korean-law-mcp의 search_law/search_historical_law로 확인하세요.",
        "lawName으로 호출했다면 더 정확한 mst를 직접 전달하세요.",
      ],
    )
  }

  const no = String(args.promulgationNo ?? "").trim()
  const q = String(args.query ?? "").trim()
  let filtered = units
  if (no) filtered = filtered.filter((u) => u.promulgationNo === no)
  if (q) filtered = filtered.filter((u) => u.text.includes(q))

  if (filtered.length === 0) {
    return notFoundResponse(
      `부칙단위 ${units.length}개 중 필터(${no ? `공포번호=${no} ` : ""}${q ? `query="${q}"` : ""})에 맞는 항목이 없습니다.`,
      [
        "공포번호/키워드를 완화하거나 생략하고 전체 부칙을 확인하세요.",
        "키워드는 부칙 본문에 그대로 등장하는 표현이어야 합니다(예: '상시근로자', '제11조의2').",
      ],
    )
  }

  filtered = [...filtered].sort((a, b) => (b.promulgationDate || "").localeCompare(a.promulgationDate || ""))
  const maxUnits = args.full === true ? 50 : 12
  const perUnit = args.full === true ? 8000 : 2500
  const shown = filtered.slice(0, maxUnits)

  // v0.27.1(리뷰 P2) — 전역 문자 예산으로 조립한다. 종전엔 maxUnits개를 각 perUnit까지 전부 조립한 뒤
  //   마지막에 전체를 한 번 잘랐다. full=true면 최대 50×8,000=400,000자를 조립해 60,000자 상한에서
  //   실제로는 ~7개만 살아남는데 헤더는 "표시 50개"라고 보고했고, 맨 끝의 "… 외 N개 생략" 안내도
  //   함께 잘려 사용자가 '부칙 전부를 확인했다'고 오인할 수 있었다(적용시기 판정에서 부칙 누락은 결론을 바꾼다).
  const totalCap = args.full === true ? 60000 : 20000
  const allBlocks: string[] = []

  const lines = [
    "법제처 법령 부칙(시행일·적용례·경과조치)",
    `출처: ${url}`,
    `법령: ${lawTitle || "N/A"} (MST ${mst})${resolvedNote}`,
    `부칙 union 출처 MST: ${sourceMsts.join(", ")} (타법개정 통합본의 직전 일부개정 부칙 누락 보정)`,
    "",  // ← 부칙단위 요약행 placeholder(실제 렌더 개수 확정 후 아래에서 교체)
    ...(supplementedNos.length > 0
      ? [`⚠ 현행 MST(${mst}) 부칙에 없어 다른 시행본에서 보강한 공포번호: ${supplementedNos.join(", ")} — 통합본 consolidation lag. 적용시점 판단 시 이 보강분 누락 주의.`]
      : []),
    "주의: 적용례는 '○○ 개정규정은 …부터 적용한다'로 구조문(개정 전 본문)과 짝입니다. 구조문은 korean-law-mcp.compare_old_new의 [개정 전]으로 대조하세요. 아래는 법제처 원문이며, 명시되지 않은 사실은 추론·생성하지 마세요.",
    "",
  ]
  for (const u of shown) {
    const parts = [`──────── [제${u.promulgationNo || "?"}호, ${u.promulgationDate || "?"}] ────────`]
    const revs = detectAddendumRevisionTails(u.text, u.promulgationDate)
    if (revs.length > 0) {
      parts.push(
        `⚠ [부칙 자체개정] 이 부칙은 후행 개정령에 의해 변경된 현행화 문구(<개정 ${revs.map(formatYmd).join(", ")}> 꼬리표). 적용시기 anchor 자체가 바뀌었을 수 있다 — 고친 지시문 원문은 get_law_revision_text(promulgationDate=${revs[0]})로 회수하고, 개정 전 문구는 그 개정일 이전 시행본 MST를 mst로 지정해 재호출해 대조하라.`,
      )
    }
    parts.push(truncate(u.text, perUnit), "")
    allBlocks.push(parts.join("\n"))
  }
  // 헤더·주의문·생략안내 예약분 1,200자를 빼고 채운다.
  const { kept: unitBlocks, omitted: budgetOmitted } = fitBlocks(allBlocks, totalCap - 1200)
  const rendered = unitBlocks.length
  // maxUnits로 이미 잘린 분(filtered - shown) + 예산으로 잘린 분
  const omitted = (filtered.length - shown.length) + budgetOmitted
  lines[4] = `부칙단위: 전체 ${units.length}개${no || q ? ` / 필터 일치 ${filtered.length}개` : ""} / 표시 ${rendered}개 (최신 공포일순)`
  lines.splice(
    5,
    0,
    ...(omitted > 0
      ? [`⚠ 미표시 ${omitted}개 — 아래 목록이 전부가 아니다. 출력 상한(${totalCap.toLocaleString()}자) 또는 표시 개수 제한으로 생략됐다. promulgationNo/query로 좁히거나${args.full === true ? "" : " full=true로"} 재호출해 나머지를 확인하라.`]
      : []),
  )
  lines.push(...unitBlocks)
  if (omitted > 0) lines.push(`… 외 ${omitted}개 부칙단위 생략(위 ⚠ 참조).`)
  return textResponse(truncate(lines.join("\n"), totalCap))
}

// 법령 XML 끝의 <개정문>(없으면 <제정문>) 노드에서 개정 지시문 원문을 추출한다.
// 부칙-of-부칙 자구개정("…부칙 제N조제M항 중 '…'를 '…'로 한다")은 부칙단위가 아니라 여기에만 나타난다.
export function parseLawRevisionText(xml: string): { kind: string; text: string } {
  for (const tag of ["개정문", "제정문"]) {
    const open = xml.indexOf(`<${tag}>`)
    if (open === -1) continue
    const close = xml.indexOf(`</${tag}>`, open)
    if (close === -1) continue
    const text = extractCdataText(xml.slice(open, close))
    if (text) return { kind: tag, text }
  }
  return { kind: "", text: "" }
}

export interface LawVersionDetail { mst: string; promNo: string; promDate: string; enforceDate: string }

// eflaw 검색에서 (MST, 공포번호, 공포일자, 시행일자)를 항목 순서대로 회수. 개정문은 '그 공포번호 시행본'에만 있어 버전 해소가 필요.
async function fetchEflawVersionsDetailed(oc: string, lawName: string, limit: number): Promise<LawVersionDetail[]> {
  const url = `${MOLEG_BASE}/DRF/lawSearch.do?OC=${encodeURIComponent(oc)}&target=eflaw&type=XML&display=40&query=${encodeURIComponent(lawName)}`
  const xml = await fetchMolegXml(url, "시행일 법령 검색")
  const ids = [...xml.matchAll(/<법령일련번호>(\d+)<\/법령일련번호>/g)].map((m) => m[1])
  const nos = [...xml.matchAll(/<공포번호>(\d+)<\/공포번호>/g)].map((m) => m[1])
  const pds = [...xml.matchAll(/<공포일자>(\d+)<\/공포일자>/g)].map((m) => m[1])
  const enfs = [...xml.matchAll(/<시행일자>(\d+)<\/시행일자>/g)].map((m) => m[1])
  const out: LawVersionDetail[] = []
  const seen = new Set<string>()
  for (let i = 0; i < ids.length; i++) {
    const key = `${ids[i]}:${enfs[i] || ""}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ mst: ids[i], promNo: nos[i] || "", promDate: pds[i] || "", enforceDate: enfs[i] || "" })
    if (out.length >= limit) break
  }
  return out
}

// "2026.5.22" / "2026-05-22" / "20260522" → "20260522" (zero-pad 포함)
export function normalizeYmdInput(raw: string): string {
  const s = String(raw || "").trim()
  const md = s.match(/^(\d{4})\D+(\d{1,2})\D+(\d{1,2})\D*$/)
  if (md) return `${md[1]}${md[2].padStart(2, "0")}${md[3].padStart(2, "0")}`
  return s.replace(/\D/g, "")
}

// 공포번호/공포일자로 시행본 선택. 같은 공포번호가 시행일 분할로 여러 항목이어도 개정문은 동일 → 첫 항목.
export function pickVersionByPromulgation(versions: LawVersionDetail[], promNo?: string, promDate?: string): LawVersionDetail | null {
  const no = (promNo || "").trim()
  const date = normalizeYmdInput(promDate || "")
  if (!no && !date) return null
  return versions.find((v) => (!no || v.promNo === no) && (!date || v.promDate === date)) || null
}

export async function getLawRevisionText(args: LawRevisionArgs): Promise<ToolResponse> {
  const oc = String(args.oc ?? process.env.LAW_GO_KR_OC ?? "").trim()
  if (!oc) {
    throw new TaxlawMcpError(
      "법제처 Open API 인증키(OC)가 필요합니다. 환경변수 LAW_GO_KR_OC를 설정하거나 oc 파라미터로 전달하세요. (korean-law-mcp가 쓰는 것과 동일한 OC 키)",
      ErrorCodes.INVALID_PARAM,
    )
  }
  const mstArg = String(args.mst ?? "").trim()
  const lawName = String(args.lawName ?? "").trim()
  if (!mstArg && !lawName) {
    throw new TaxlawMcpError("mst 또는 lawName 중 하나는 필수입니다.", ErrorCodes.INVALID_PARAM)
  }
  const no = String(args.promulgationNo ?? "").trim()
  const pd = normalizeYmdInput(String(args.promulgationDate ?? ""))

  let mst = mstArg
  let pickedNote = ""
  if (!mst) {
    if (no || pd) {
      const versions = await fetchEflawVersionsDetailed(oc, lawName, 40)
      const hit = pickVersionByPromulgation(versions, no, pd)
      if (!hit) {
        return notFoundResponse(
          `'${lawName}' 최근 시행본 ${versions.length}개에서 ${no ? `공포번호 ${no}` : ""}${no && pd ? "·" : ""}${pd ? `공포일자 ${pd}` : ""} 일치 버전을 찾지 못했습니다.`,
          [
            "eflaw 검색은 최근 시행본 위주입니다 — 오래된 개정령은 korean-law-mcp search_historical_law로 그 버전 MST를 확보해 mst로 직접 전달하세요.",
            "promulgationDate는 YYYYMMDD 형식입니다(예: 20260522).",
          ],
        )
      }
      mst = hit.mst
      pickedNote = ` — 공포 제${hit.promNo}호(${formatYmd(hit.promDate)}) 시행본 자동 선택`
    } else {
      mst = await resolveLawMst(oc, lawName)
      pickedNote = ` — '${lawName}' 현행 MST 해소(특정 개정령의 개정문은 promulgationNo/promulgationDate 지정)`
    }
  }

  const url = `${MOLEG_BASE}/DRF/lawService.do?OC=${encodeURIComponent(oc)}&target=law&MST=${encodeURIComponent(mst)}&type=XML`
  const xml = await fetchMolegXml(url, "법령 조회")
  const displayUrl = displayLawServiceUrl(mst) // v0.21.0(#G11) — 출처 표기용(OC 제외)
  const lawTitle = (xml.match(/<법령명_한글>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/법령명_한글>/)?.[1] || "").trim()
  const headNo = (xml.match(/<공포번호>(\d+)<\/공포번호>/)?.[1] || "").trim()
  const headDate = (xml.match(/<공포일자>(\d+)<\/공포일자>/)?.[1] || "").trim()
  const { kind, text } = parseLawRevisionText(xml)
  if (!text) {
    return notFoundResponse(
      `MST ${mst}에서 개정문/제정문 노드를 찾지 못했습니다.`,
      [
        "타법개정·폐지제정 등 일부 버전은 개정문 형식이 다를 수 있습니다 — 해당 공포번호의 일부개정 시행본 MST로 재시도하세요.",
        "korean-law-mcp search_historical_law로 버전 목록을 확인하세요.",
      ],
    )
  }

  let body = text
  let filterNote = ""
  const q = String(args.query ?? "").trim()
  if (q) {
    const rows = text.split("\n")
    const hits = rows.map((l, i) => (l.includes(q) ? i : -1)).filter((i) => i >= 0)
    if (hits.length === 0) {
      filterNote = `(query "${q}" 일치 줄 없음 — 전체 본문 표시)`
    } else {
      const keep = new Set<number>()
      for (const i of hits) {
        keep.add(i)
        if (i > 0) keep.add(i - 1)
        if (i < rows.length - 1) keep.add(i + 1)
      }
      const sorted = [...keep].sort((a, b) => a - b)
      const parts: string[] = []
      let prev = -2
      for (const i of sorted) {
        if (i !== prev + 1) parts.push("…")
        parts.push(rows[i])
        prev = i
      }
      parts.push("…")
      body = parts.join("\n")
      filterNote = `(query "${q}" 일치 ${hits.length}줄 ±1줄만 표시 — 전체는 query 생략 또는 full=true)`
    }
  }

  const lines = [
    `법제처 ${kind}(개정 지시문 원문)`,
    `출처: ${displayUrl}`,
    `법령: ${lawTitle || "N/A"} (MST ${mst}) / 이 시행본의 공포: 제${headNo || "?"}호 ${formatYmd(headDate) || "?"}${pickedNote}`,
    "용도: 개정문은 그 개정령이 실제 수행한 문구 수술 원문('…를 …로 한다')이다. 부칙 적용례의 '개정규정' 결박(문구 단위)과 부칙-of-부칙 자구개정은 여기서만 원문 확인 가능. 적용시기 판정은 get_law_addenda/build_application_timetable과 함께. 아래는 법제처 원문이며, 명시되지 않은 사실은 추론·생성하지 마세요.",
    ...(filterNote ? [filterNote] : []),
    "",
    truncate(body, args.full === true ? 50000 : 9000),
  ]
  return textResponse(truncate(lines.join("\n"), args.full === true ? 60000 : 15000))
}

// "YYYYMMDD" → "YYYY.M.D"
function formatYmd(ymd: string): string {
  const m = String(ymd || "").match(/^(\d{4})(\d{2})(\d{2})$/)
  return m ? `${m[1]}.${Number(m[2])}.${Number(m[3])}` : (ymd || "")
}

// 부칙단위 본문의 제1조(시행일)에서 시행일을 뽑는다. "공포한 날부터 시행"이면 공포일.
export function extractEnforceDate(addendaText: string, promulgationYmd?: string): string {
  const f = addendaText.replace(/\s/g, "")
  const m = f.match(/이영은(\d{4})년(\d{1,2})월(\d{1,2})일부터시행/)
  if (m) return `${m[1]}.${Number(m[2])}.${Number(m[3])}`
  if (/공포한날부터시행/.test(f)) return promulgationYmd ? `${formatYmd(promulgationYmd)}(공포일)` : "공포일"
  return promulgationYmd ? formatYmd(promulgationYmd) : ""
}

// 적용례/경과조치 한 조항을 유형 분류. 순서 중요(경과조치·최초공제·과세연도개시 먼저 검사).
export function classifyApplicationClause(clause: string): string {
  const f = clause.replace(/\s/g, "")
  if (/개정규정에도불구하고[\s\S]*?종전의?규정에따른다/.test(f)) return "경과조치(종전규정)"
  if (/최초공제연도/.test(f)) return "최초공제연도기준"
  if (/이후개시하는(과세연도|사업연도|과세기간)/.test(f)) return "과세연도개시기준"
  if (/시행이후[\s\S]*?신고하는경우/.test(f) || /과세표준(및세액을)?신고/.test(f) || /과세표준을신고/.test(f)) return "신고시점기준"
  if (/시행이후[\s\S]*?(취득|지급|양도|증여|계약|출자|투자|복직|전환|해지|가입|발생|공급|취업|상장|합병)/.test(f)) return "행위시점기준"
  if (/이후[\s\S]*?발생하는소득/.test(f) || /속하는(과세연도|과세기간|사업연도)/.test(f)) return "소득·기간기준"

  // ── v0.27.8 후순위 구제 규칙 ──
  // 위 규칙에 안 걸린 것만 받는다(앞 규칙의 순서·정규식은 손대지 않아 기존 분류는 그대로).
  // 계기: 4개 세법 부칙 적용례 979문장 중 436건(44.5%)이 유형미상 → targetYearApplicationNote가
  //   빈 문자열을 반환해 '귀속 판단' 줄이 통째로 사라졌다(무라벨 누락). 구멍은 구조적이었다:
  //   ① 시점 anchor를 '시행이후'로만 봄 → "이 법 시행 후", "이 법 시행일 이후", "2026년 1월 1일 이후" 누락
  //   ② 행위 동사 화이트리스트 방식 → 창업·출연·기부·신청·인증·행사·납입 등 열거 밖은 전부 미상
  //   ③ 경과조치를 "개정규정에도 불구하고…종전의 규정에 따른다" 한 형태로만 봄
  // 동사 열거를 늘리는 대신, '시점 anchor + …부터 적용한다' 구조로 판정한다(열거는 계속 새는 방식).
  if (/종전의?규정을?(적용한다|따른다|의한다)|종전의?규정에(따른다|의한다)|종전의예에따른다/.test(f)) {
    return "경과조치(종전규정)"
  }
  // anchor는 "이 법 시행"만이 아니다 — "부칙 제1조에 따른 시행일 이후", "같은 개정규정 시행 이후"처럼
  //   시행일을 다른 조항으로 지시하는 형태가 다수(남은 미상의 대부분이 이 형태였다). 앞 규칙이 이미
  //   구체 유형을 다 걸러낸 뒤이므로 여기서는 시점 문언을 넓게 받아도 오분류 위험이 낮다.
  const anchored = /시행(일)?(이후|후|부터)|\d{4}년\d{1,2}월\d{1,2}일(이후|부터)|시행일이속하는/.test(f)
  if (anchored && /부터적용한다/.test(f)) {
    if (/(발생하는|받는|지급받는)(소득|배당소득|이자소득|수입|금액)|소득분?부터/.test(f)) return "소득·기간기준"
    if (/연말정산|확정신고하는|신고하는분/.test(f)) return "신고시점기준"
    return "행위시점기준"
  }
  return "유형미상"
}

// v0.21.0(#X-11) — jo 부분문자열 오매칭 방지: "제2조".includes 는 "제2조의2"를 삼킨다(다른 조).
//   joKey 바로 뒤가 '의<숫자>'면 배제하고, "제2조제1항"·"제2조" 뒤 '같은조' 등 항·후속참조는 매칭 유지.
//   입력 flatText는 공백 제거된 평문 기준(호출부에서 replace(/\s/g,"") 후 전달).
export function joMentioned(flatText: string, joKey: string): boolean {
  const key = String(joKey || "").replace(/\s/g, "")
  if (!key) return false
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(esc + "(?!의\\s*\\d)").test(String(flatText || ""))
}

// 부칙 본문에서 jo(+hang)를 언급하는 '적용례/경과조치' 조항만 추출.
// 타법개정의 자구정정 나열("…를 …로 한다")은 적용례가 아니므로 적용 동사로 걸러낸다.
const APPLICATION_VERB = /(적용한다|종전의?규정에따른다|으로본다|로본다)/
export function extractJoClauses(addendaText: string, jo: string, hang?: string): Array<{ title: string; clause: string }> {
  const joKey = jo.replace(/\s/g, "")
  const hangKey = (hang || "").replace(/\s/g, "")
  const out: Array<{ title: string; clause: string }> = []
  // 부칙은 제N조(제목) 단위로 구성 → 조 블록으로 분해
  const blocks = addendaText.split(/(?=제\d+조(?:의\d+)?\s*\()/).filter((b) => b.trim())
  for (const b of blocks) {
    if (!joMentioned(b.replace(/\s/g, ""), joKey)) continue
    const title = (b.match(/^제\d+조(?:의\d+)?\s*\([^)]*\)/) || [""])[0].trim()
    // 항(①~⑮)으로 쪼개되, 항이 1개뿐이면 블록 전체를 후보로
    const parts = b.split(/(?=[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮])/).filter((p) => p.trim())
    const candidates = parts.length > 1 ? parts : [b]
    for (const p of candidates) {
      const flat = p.replace(/\s/g, "")
      if (!joMentioned(flat, joKey)) continue
      if (!APPLICATION_VERB.test(flat)) continue // 적용례/경과조치만 (자구정정 제외)
      if (hangKey) {
        const adjacent = flat.includes(joKey + hangKey) // 예: 제26조의8제6항
        const sameJoRef = flat.includes(joKey) && flat.includes("같은조" + hangKey) // 예: "제26조의8제4항제1호 및 같은 조 제6항"
        const articleLevelTransitional = /종전의?규정에따른다/.test(flat) // 조 단위 경과조치는 충돌 가시화 위해 포함
        if (!adjacent && !sameJoRef && !articleLevelTransitional) continue
      }
      out.push({ title, clause: p.trim() })
    }
  }
  return out
}

const HANG_SYMBOLS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"]

// "제6항" → "⑥"
export function hangToSymbol(hang: string): string | null {
  const n = Number(String(hang || "").match(/\d+/)?.[0])
  return Number.isFinite(n) && n >= 1 && n <= 20 ? HANG_SYMBOLS[n - 1] : null
}

// "제26조의8제6항"/"제26조의8 제6항"/"제26조의8" → { jo, hang? }
export function parseJoSpec(spec: string): { jo: string; hang?: string } | null {
  const m = String(spec || "").replace(/\s/g, "").match(/^(제\d+조(?:의\d+)?)(제\d+항)?$/)
  return m ? { jo: m[1], hang: m[2] || undefined } : null
}

// 조문 본문에서 항(①~⑳)별 <개정·신설·전문개정 YYYY.M.D> 꼬리표 날짜를 수집.
// = "이 조항을 실제 고친 개정일" 목록(현행본 꼬리표는 누적 표기). 부칙 '개정규정' 결박검증의 기준.
export function extractAmendmentInventory(articleText: string): { article: string[]; byHang: Record<string, string[]> } {
  const norm = String(articleText || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  const dateRe = /(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/g
  const collect = (s: string): string[] => {
    const out = new Set<string>()
    for (const tag of s.matchAll(/[<\[]\s*(?:개정|신설|전문개정)\s+([^>\]]*)[>\]]/g)) {
      for (const d of tag[1].matchAll(dateRe)) out.add(`${d[1]}.${Number(d[2])}.${Number(d[3])}`)
    }
    return [...out].sort()
  }
  const byHang: Record<string, string[]> = {}
  for (const p of norm.split(/(?=[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])/)) {
    const h = p.match(/^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/)?.[0]
    if (!h) continue
    const dates = collect(p)
    if (dates.length) byHang[h] = [...new Set([...(byHang[h] || []), ...dates])].sort()
  }
  return { article: collect(norm), byHang }
}

// 부칙(공포일)이 대상 조·항을 실제 개정했는지 — 현행본 꼬리표(개정 인벤토리) 기준.
export function checkAmendmentBinding(promulgationDate: string, inventoryDates: string[]): "개정함" | "개정 흔적 없음" | "판정불가" {
  if (!promulgationDate || inventoryDates.length === 0) return "판정불가"
  return inventoryDates.includes(formatYmd(promulgationDate)) ? "개정함" : "개정 흔적 없음"
}

// 본문에서 '…제N조(의M)(제K항)…준용' 패턴 추출(자기 자신 제외, 최대 3건).
// '준용' 앵커에서 역방향으로 가장 가까운 조문 참조를 채택(자기 조문 참조가 뒤의 실제 준용 대상을 삼키지 않도록).
// 준용 구조는 '준용하는 조문'과 '준용 대상 조문' 두 층의 부칙이 적용시기를 따로 정할 수 있다(2층 타임라인).
export type JunyongTarget = { jo?: string; hang?: string; lawName?: string; annex?: string; lawHint?: string; joRange?: string; capped?: boolean }
// v0.27.0(리뷰 P1) — 준용 대상 개수 상한. 종전에도 6이었으나 도달 사실이 무라벨이라
//   초과분이 조용히 사라졌다(capJunyongBlocks는 글자수 상한만 라벨링). 마지막 대상에 capped를 실어 렌더층에 알린다.
const JUNYONG_TARGET_CAP = 6
// 열거형 준용의 연결사. 범위형(부터/까지/내지)은 아래 joRange·항범위 로직이 따로 처리하므로 제외한다.
// 「법령명」 토큰도 허용한다 — "「가법」제11조, 「나법」제12조를 준용" 처럼 항목마다 법령이 붙는 열거에서
// 체인이 끊겨 앞 항목이 통째로 사라지던 것 방지. 귀속은 항목별 lawBefore(인접성 게이트)가 각자 판정하므로
// 오귀속 위험은 늘지 않는다. 산문이 끼면("…에도 불구하고…") 여전히 중단된다.
const ENUM_CONNECTOR_ONLY = /^(?:[·ㆍ,、]|및|와|과|또는|「[^」]{2,40}」)*$/
export function extractJunyongTargets(articleText: string, selfJo: string): JunyongTarget[] {
  const out: JunyongTarget[] = []
  const seen = new Set<string>()
  let capped = false
  const flat = String(articleText || "").replace(/\s/g, "")
  const selfKey = String(selfJo || "").replace(/\s/g, "")
  // v0.24.0(E1)→v0.25.0(리뷰 EF-3, P0) — 「법령명」 귀속은 '인접성 게이트' 통과 시만.
  //   」와 조문 ref 사이 개재문자가 조문참조 연쇄·연결사(제N조…/및/부터/까지/·/,/같은법 등)뿐이면 인접=그 법 귀속.
  //   산문 개재(정의목적 인용 "「소득세법」에 따른 …" 뒤 자기법 조문 — §100의32류 오귀속 재현 5/6 문형)는
  //   rejected로 강등: 자기법 처리 + lawHint(렌더층 모호 라벨용). 오귀속 데이터 무경고 승격의 근본 차단.
  const lawBefore = (ctx: string, pos: number): { name?: string; rejected?: string } => {
    const lm = [...ctx.slice(0, pos).matchAll(/「([^」]{2,40})」/g)]
    if (!lm.length) return {}
    const last = lm[lm.length - 1]
    const gap = ctx.slice((last.index ?? 0) + last[0].length, pos)
    const adjacent = /^(?:제\d+조(?:의\d+)?(?:제\d+항)?(?:제\d+호)?|같은법|동법|[·ㆍ,]|및|내지|부터|까지|와|과|의)*$/.test(gap)
    return adjacent ? { name: last[1] } : { rejected: last[1] }
  }
  // shape 하위호환: 값이 있는 필드만 포함(기존 소비자·테스트의 {jo,hang} deepEqual 보존).
  const push = (jo: string | undefined, hang: string | undefined, lawName: string | undefined, annex?: string, lawHint?: string, joRange?: string) => {
    const key = `${lawName || ""}|${jo || ""}${hang || ""}|${annex || ""}`
    if (seen.has(key)) return
    seen.add(key)
    const t: JunyongTarget = {}
    if (jo) t.jo = jo
    if (hang) t.hang = hang
    if (lawName) t.lawName = lawName
    if (annex) t.annex = annex
    if (lawHint) t.lawHint = lawHint
    if (joRange) t.joRange = joRange
    out.push(t)
  }
  for (const m of flat.matchAll(/준용/g)) {
    const idx = m.index ?? 0
    // v0.27.0(리뷰 P2/E2) — 컨텍스트 창 40 → 120자.
    //   40자는 ① 열거형 준용에서 앞 항목들이 창 밖으로 밀려 통째로 소실되고
    //   ② 「법령명」이 창 밖이면 lawBefore가 아무것도 못 찾아 lawHint(귀속 모호 신호)조차 못 붙였다.
    //   → 실측: 「조특법 시행령」제100조의16…및 제100조의17제3항을 준용 → 법령명·모호신호 둘 다 소실.
    //   넓혀도 오귀속이 늘지 않는 이유: 타법 귀속은 EF-3 인접성 게이트가 별도 판정하고,
    //   비인접이면 자기법 처리 + lawHint로 강등된다(창 확대는 '신호 없음'을 '신호 있음'으로 바꿀 뿐).
    const ctx = flat.slice(Math.max(0, idx - 120), idx)
    const refs = [...ctx.matchAll(/(제\d+조(?:의\d+)?)(제\d+항)?/g)]
    if (refs.length > 0) {
      const last = refs[refs.length - 1]
      // v0.26.1(리뷰 라이브) — 조-범위 준용 "제N조부터 제M조까지"(법인세법 §14~54 통째 준용 류)는 대량 편입이라
      //   각 조 개별 전개 대신 마지막 조를 대표로 2층 추적하되 joRange로 범위를 명시(마지막 조만 표시되는 무언 누락 방지).
      const joRangeM = ctx.match(/(제\d+조(?:의\d+)?)부터(제\d+조(?:의\d+)?)까지/)
      const joRange = joRangeM && !last[2] && last[1] === joRangeM[2] ? `${joRangeM[1]}~${joRangeM[2]}` : undefined
      // v0.23.0(B) — 범위 준용 "제N항부터 제M항까지" → 각 항 개별 전개(시작 항이 anchor와 일치할 때만).
      const range = ctx.match(/제(\d+)항부터제(\d+)항까지/)
      const isHangRange = !!(range && last[2] === `제${range[1]}항`)
      // v0.27.0(리뷰 P1) — 열거형 준용에서 마지막 1건만 남던 것 수정.
      //   "제10조, 제11조 및 제12조를 준용한다" → 종전 [제12조]로 2건이 무경고 소실됐다.
      //   "제95조ㆍ제97조를 준용한다"도 마찬가지(v0.26.0이 인접성 whitelist에 ㆍ를 추가한 문형인데
      //   법령명 귀속만 고치고 추출은 그대로였다). 연결사만으로 이어진 참조는 하나의 대상 집합이다.
      //   앵커(가장 가까운 참조)에서 뒤로 확장하고 산문이 끼면 중단한다(별개 문장 성분).
      //   범위형은 위 로직이 대표 1건으로 처리하므로 체인을 만들지 않는다.
      const chain: RegExpMatchArray[] = [last]
      if (!joRange && !isHangRange) {
        for (let i = refs.length - 2; i >= 0; i--) {
          const cur = refs[i]
          const head = chain[0]
          const gap = ctx.slice((cur.index ?? 0) + cur[0].length, head.index ?? 0)
          if (!ENUM_CONNECTOR_ONLY.test(gap)) break
          chain.unshift(cur)
        }
      }
      for (const ref of chain) {
        if (out.length >= JUNYONG_TARGET_CAP) { capped = true; break }
        const jo = ref[1]
        // v0.25.0(리뷰 EF-3) — 타법 귀속은 인접성 게이트 통과 시만. 비인접은 자기법 처리 + lawHint.
        const lb = lawBefore(ctx, ref.index ?? 0)
        const lawName = lb.name
        // 자기 조문 제외는 '같은 법령'일 때만 — 타법의 동일 조번호는 별개 대상.
        if (!lawName && jo === selfKey) continue
        if (isHangRange && range) {
          const start = Number(range[1]), end = Number(range[2])
          if (end > start && end - start <= 10) {
            for (let h = start; h <= end && out.length < JUNYONG_TARGET_CAP; h++) push(jo, `제${h}항`, lawName, undefined, lb.rejected)
          } else {
            push(jo, ref[2] || undefined, lawName, undefined, lb.rejected)
          }
        } else {
          push(jo, ref[2] || undefined, lawName, undefined, lb.rejected, joRange)
        }
      }
    } else {
      // v0.24.0(E1) — 조문 ref 없이 별표만 준용("「X법」 별표3을 준용") — 종전엔 silent skip.
      const annexM = ctx.match(/별표(\d+(?:의\d+)?)(?!\d)/)
      if (annexM) {
        const lb = lawBefore(ctx, annexM.index ?? 0)
        push(undefined, undefined, lb.name, `별표${annexM[1]}`, lb.rejected)
      }
    }
    if (out.length >= JUNYONG_TARGET_CAP) { capped = true; break }
  }
  // v0.27.0 — 상한 도달을 렌더층에 알린다(무라벨 절단 금지 원칙).
  if (capped && out.length > 0) out[out.length - 1].capped = true
  return out
}

// v0.24.0(E2) — 준용 대상 표시 라벨(타법=「법령명」 병기, 별표 포함).
export function fmtJunyong(t: JunyongTarget): string {
  const ref = `${t.jo || ""}${t.hang || ""}${t.annex || ""}`
  const base = t.lawName ? `「${t.lawName}」${ref}` : ref
  // v0.26.1 — 조-범위 준용은 대표 조 뒤에 범위 명시(마지막 조만 보이는 오해 방지).
  const withRange = t.joRange ? `${base}(범위 준용 ${t.joRange} — 대표 ${t.jo}만 2층 추적)` : base
  // v0.27.0 — 대상 개수 상한 도달은 반드시 표기(무라벨 절단 금지).
  return t.capped
    ? `${withRange} ⚠ 준용 대상 ${JUNYONG_TARGET_CAP}건 상한 도달 — 이후 대상 생략됨. 조문 원문에서 준용 목록 전체를 직접 확인하라.`
    : withRange
}

// v0.21.0(#G8) — 순수 함수(네트워크 무관)라 export + 단위테스트 대상. 의미론 보강:
//   ① 과세연도개시기준은 연·월·일 전체 파싱 — 1.1(또는 월일 미기재)만 순연도비교로 단정, 연중(예: 7.1)은 ⚠ 강등.
//   ② 연도 미파싱 && enforceDate 존재면 시행일로 fallback(1.1=그 해 귀속부터 / 연중=⚠).
//   ③ 경과조치의 '이전/이후/부터/까지' 범위 문언은 정확일치(includes) 불가 → ⚠ 강등.
export function targetYearApplicationNote(
  type: string,
  clause: string,
  targetYear: number,
  enforceDate: string,
  filingMonth: number,
): string {
  const f = clause.replace(/\s/g, "")
  if (type === "신고시점기준") {
    const filing = `${targetYear + 1}.${filingMonth}월(말)`
    const ed = enforceDate || "?"
    return `${targetYear} 귀속 정기신고(≈${filing}) 시점에 시행일(${ed})이 이미 지났으면 → 개정규정(신법)이 ${targetYear} 귀속 신고분에 **소급 적용**. 시행일 > 신고시점이면 종전규정.`
  }
  if (type === "과세연도개시기준") {
    const m = f.match(/(\d{4})년(\d{1,2})?월?(\d{1,2})?일?이후개시/)
    if (m) {
      const y = Number(m[1])
      const mo = m[2] ? Number(m[2]) : undefined
      const d = m[3] ? Number(m[3]) : undefined
      // 월일이 1.1(또는 미기재)이면 기존 연도비교 유지. 연중이면 과세연도 개시일 대조 필요 → ⚠.
      const midYear = mo !== undefined && !(mo === 1 && (d === undefined || d === 1))
      if (midYear) {
        return `⚠ 연중 시행(${mo}.${d ?? 1}) 기준 — 과세연도 개시일과 대조 필요(12월말 결산법인은 ${y + 1} 귀속부터 확실, ${y} 귀속은 개시일이 ${mo}.${d ?? 1} 이후인 경우만).`
      }
      return `기준: ${y} 이후 개시 과세연도. targetYear ${targetYear} ${targetYear >= y ? "≥ → 개정규정 적용" : "< → 종전규정"}.`
    }
    // 연도 미파싱 — enforceDate(YYYY.M.D)에서 fallback 계산.
    const em = String(enforceDate || "").match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/)
    if (em) {
      const y = Number(em[1])
      const mo = Number(em[2])
      const d = Number(em[3])
      if (mo === 1 && d === 1) {
        return `기준(시행일 fallback): 시행 ${y}.1.1 → ${y} 이후 개시 과세연도 추정. targetYear ${targetYear} ${targetYear >= y ? "≥ → 개정규정 적용" : "< → 종전규정"}. ⚠ 클로즈 연도 미파싱 — 부칙 원문 대조 권장.`
      }
      return `⚠ 연중 시행(${mo}.${d}, 시행일 fallback) 기준 — 클로즈 연도 미파싱. 과세연도 개시일과 대조 필요(12월말 결산법인은 ${y + 1} 귀속부터 확실, ${y} 귀속은 개시일이 ${mo}.${d} 이후인 경우만).`
    }
    return `기준 과세연도 미파싱 — 원문 확인.`
  }
  if (type === "경과조치(종전규정)") {
    const yrs = [...f.matchAll(/(\d{4})년/g)].map((m) => Number(m[1]))
    const hasRange = /\d{4}년(?:이전|이후|부터|까지)/.test(f)
    if (hasRange) {
      return `경과조치 명시연도 ${yrs.join("·") || "?"}. ⚠ 범위 문언(이전/이후/부터/까지) 포함 — 정확일치 판정 불가, targetYear ${targetYear}가 범위에 드는지 원문 대조 필요.`
    }
    const inRange = yrs.includes(Number(targetYear))
    return `경과조치 명시연도 ${yrs.join("·") || "?"}. targetYear ${targetYear} ${inRange ? "포함 → 원칙 종전규정. ⚠ 같은 조문에 후행·특정 적용례가 있으면 그쪽이 우선할 수 있으니 충돌 점검 필수" : "미포함"}.`
  }
  if (type === "최초공제연도기준") {
    return `최초 공제연도 기준. ${targetYear}를 최초 공제연도로 신청하면 개정규정 적용. 이전 연도 최초공제 사이클의 추가공제·사후관리분이면 종전규정 검토 — ⚠ 귀속연도만으론 판정 불가, 차수(최초공제연도) 확인 필수.`
  }
  if (type === "행위시점기준" || type === "소득·기간기준") {
    return `행위·소득 발생시점 기준. ${targetYear} 중 해당 행위/소득이 시행일(${enforceDate || "?"}) 이후면 개정규정.`
  }
  // v0.27.8 — 유형 미분류라고 침묵하면 '판단노트 없음'이 '적용례 없음'으로 오독된다(무라벨 누락).
  //   분류기를 넓혀도 미상은 남으므로, 미상임을 밝히고 원문 anchor 확인을 지시한다.
  //   길게 쓰면 미상 비율만큼 토큰이 불어나므로 한 줄로 짧게(상세 설명은 헤더에 1회).
  return `⚠ 적용례 유형 미분류 — 자동 판단 없음. 원문의 기준시점(anchor)을 직접 읽고 ${targetYear} 귀속 해당 여부를 판단하라.`
}

// v0.25.0(리뷰 TK-1) — 준용 체인 블록 공유상한(순수): E3 cross 승격(full=true 타법당 최대 ~36,794자)이
// trace 전체 truncate(80,000)를 소진해 자기층·후순위 준용층이 무언 절단되는 것 방지.
// 상한 도달 시 timetable과 동일 원칙의 명시 생략 라벨("…외 N행 생략").
export function capJunyongBlocks(blocks: string[], full: boolean): string[] {
  const capChars = full ? 24000 : 8000
  let acc = 0
  for (let i = 0; i < blocks.length; i++) {
    acc += blocks[i].length + 1
    if (acc > capChars) {
      return [
        ...blocks.slice(0, i),
        `… 준용 체인 출력 상한(${capChars.toLocaleString()}자) 도달 — 외 ${blocks.length - i}행 생략. 준용 대상별 상세는 build_application_timetable(lawName=…)로 개별 확인.`,
      ]
    }
  }
  return blocks
}

const TRACE_GUARD = [
  "⚠ 적용시점 판정 규칙(반드시 준수):",
  "① 어느 과세연도 신고에 적용되는 조문은 '그 해 시행 중이던 본문'이 아니라 '부칙 적용례'가 정한다.",
  "② '신고시점' 기준 적용례는 직전 과세연도에 소급한다(예: 2026.2.27 시행·신고기준 → 2025 귀속 신고분 적용).",
  "③ 부칙이 여러 개면 후행·특정 적용례가 일반 경과조치보다 우선할 수 있으니 충돌을 명시 점검하라.",
  "④ 본문/수식이미지 스냅샷만으로 귀속연도를 단정하지 말고, 결론은 반드시 부칙 verbatim과 함께 적어라.",
  "⑤ 부칙의 '개정규정'은 그 개정령이 실제 바꾼 문구 단위만 가리킨다(타 개정령의 신설·개정분은 그쪽 부칙 관할). 경과조치는 자기 개정령의 개정규정만 사정거리 — 미래 개정 선제유예 불가.",
  "⑥ 적극 문언 우선 — 문언에 없는 fallback(종전규정 회귀 등)을 창작하지 마라. 서식·별지 작성방법은 법규명령 본문이 아니므로 부칙·법령 문언이 우선한다.",
].join("\n")

export async function traceArticleApplication(args: TraceArticleArgs): Promise<ToolResponse> {
  const jo = requireString("jo", args.jo)
  const hang = String(args.hang ?? "").trim()
  const oc = String(args.oc ?? process.env.LAW_GO_KR_OC ?? "").trim()
  if (!oc) {
    throw new TaxlawMcpError(
      "법제처 Open API 인증키(OC)가 필요합니다. 환경변수 LAW_GO_KR_OC를 설정하거나 oc 파라미터로 전달하세요.",
      ErrorCodes.INVALID_PARAM,
    )
  }
  const mstArg = String(args.mst ?? "").trim()
  const lawName = String(args.lawName ?? "").trim()
  if (!mstArg && !lawName) {
    throw new TaxlawMcpError("mst 또는 lawName 중 하나는 필수입니다.", ErrorCodes.INVALID_PARAM)
  }
  const prep = await prepareMergedAddenda(oc, mstArg, lawName, 4)
  const { mst, lawTitle, url, xml, units, sourceMsts, supplementedNos } = prep

  const targetYear = typeof args.targetYear === "number" ? args.targetYear : undefined
  const filingMonth = typeof args.filingMonth === "number" ? args.filingMonth : 3

  // 현행 jo 본문 발췌(앵커용)
  let currentBody = ""
  const bodyIdx = xml.indexOf(`<![CDATA[${jo}(`)
  if (bodyIdx !== -1) {
    const s = xml.lastIndexOf("<조문단위", bodyIdx)
    const e = xml.indexOf("</조문단위>", bodyIdx)
    if (s !== -1 && e !== -1) {
      currentBody = extractCdataText(xml.slice(s, e)).replace(/\[수식이미지\]/g, "[수식이미지=flDownload.do로 별도 확인]")
    }
  }

  const joKey = jo.replace(/\s/g, "")

  // 개정 인벤토리(현행본 <개정·신설> 꼬리표) — "이 조항을 실제 고친 개정일" 목록(결박검증 기준)
  const inventory = currentBody ? extractAmendmentInventory(currentBody) : { article: [] as string[], byHang: {} as Record<string, string[]> }
  const hangSym = hang ? hangToSymbol(hang) : null
  const hangDates = hangSym ? inventory.byHang[hangSym] || [] : []
  const targetDates = hangDates.length ? hangDates : inventory.article
  const targetLabel = hangDates.length ? `${jo} ${hang}` : jo

  // 준용 체인 자동 추적(2층 타임라인)
  const junyongTargets = currentBody ? extractJunyongTargets(currentBody, jo) : []

  const matched = units
    .filter((u) => joMentioned(u.text.replace(/\s/g, ""), joKey)) // v0.21.0(#X-11) — "제2조" vs "제2조의2" 오매칭 방지
    .sort((a, b) => (b.promulgationDate || "").localeCompare(a.promulgationDate || ""))

  // v0.25.0(리뷰 A1) — self 부칙 0건이어도 준용 대상 탐지 시 조기종료하지 않고 준용 체인 층을 회수
  // (준용 대상 타법에만 적용례가 있는 입력에서 2층 타임라인 통째 드롭 방지). 둘 다 0건일 때만 NOT_FOUND.
  if (matched.length === 0 && junyongTargets.length === 0) {
    return notFoundResponse(
      `MST ${mst}의 부칙에서 ${jo}${hang ? " " + hang : ""}을(를) 언급하는 적용례/경과조치를 찾지 못했습니다.`,
      [
        "jo 표기를 법령 표기와 맞추세요(예: '제26조의8').",
        "hang 필터가 너무 좁으면 생략하고 조 단위로 보세요.",
        "부칙 전체는 get_law_addenda로, 구버전 본문은 korean-law-mcp search_historical_law로 확인하세요.",
      ],
    )
  }

  // v0.25.0(리뷰 A5) — 자기 조문 층과 준용 대상 층(타법 포함)의 부칙 유형을 분리 집계.
  // 단일 세트 병합은 서로 다른 법률의 유형을 "같은 조문에 공존"으로 오표시했다.
  const selfTypes = new Set<string>()
  const junyongTypes = new Set<string>()
  const blocks: string[] = []
  for (const u of matched) {
    const enforce = extractEnforceDate(u.text, u.promulgationDate)
    const clauses = extractJoClauses(u.text, jo, hang)
    if (clauses.length === 0) continue
    const binding = checkAmendmentBinding(u.promulgationDate || "", targetDates)
    blocks.push(`──────── [제${u.promulgationNo || "?"}호] 공포 ${formatYmd(u.promulgationDate)} / 시행 ${enforce || "?"} ────────`)
    blocks.push(
      binding === "개정함"
        ? `· [결박검증 ✓] 이 개정령은 ${targetLabel}을(를) 실제 개정함(현행 꼬리표 기준) — 이 부칙의 '개정규정'에 ${targetLabel} 포함 가능.`
        : binding === "개정 흔적 없음"
          ? `· [결박검증 ⚠] 이 개정령이 ${targetLabel}을(를) 개정한 흔적이 현행 꼬리표에 없음 — 부칙의 '개정규정'은 그 개정령이 실제 바꾼 문구 단위만 가리키므로, 이 부칙(특히 경과조치)의 사정거리에 ${targetLabel}이(가) 포함되는지 의심하라.`
          : `· [결박검증 ?] ${targetLabel} 개정 여부 판정불가(현행본 꼬리표 미회수).`,
    )
    for (const c of clauses) {
      const type = classifyApplicationClause(c.clause)
      selfTypes.add(type)
      blocks.push(`· [${type}] ${truncate(c.clause, args.full === true ? 4000 : 1200)}`)
      if (type === "경과조치(종전규정)" && binding === "개정 흔적 없음") {
        blocks.push(`   └▶ ⚠ 사정거리: 경과조치는 '자기 개정령의 개정규정'만 유예한다. 이 개정령이 ${targetLabel}을(를) 고치지 않았다면, 이 경과조치로 ${targetLabel}의 후행 개정까지 유예할 수 없다(미래 개정 선제유예 불가).`)
      }
      if (targetYear !== undefined) {
        const note = targetYearApplicationNote(type, c.clause, targetYear, enforce, filingMonth)
        if (note) blocks.push(`   └▶ ${targetYear} 귀속 판단: ${note}`)
      }
    }
    blocks.push("")
  }

  // 준용 체인 블록(준용 대상 조문의 인벤토리+부칙 동반 회수)
  const getCrossT = makeCrossResolver(oc)
  const selfCtxT: LawCtx = { xml, units, lawTitle, mst }
  const jBlocks: string[] = []
  // v0.27.1(리뷰 P2) — 서로 다른 타법 해소를 병렬로. 루프와 동일한 순서로 태워야 상한(2) 선택이 기존과 일치한다.
  getCrossT.prewarm(junyongTargets.filter((t) => t.jo && !t.annex && t.lawName && lawNameKey(t.lawName) !== lawNameKey(lawTitle)).map((t) => t.lawName))
  for (const t of junyongTargets) {
    // 별표 준용(조문 ref 없음)은 자체 개정 연혁이라 라벨만(E4 미착수).
    if (t.annex || !t.jo) {
      jBlocks.push(`▷ ${jo} 본문이 ${fmtJunyong(t)}을(를) 준용 — ⚠ 별표는 자체 개정 연혁(조문 부칙과 별개). korean-law get_annexes로 2층 확인.${t.lawHint && !t.lawName ? ` (⚠ 귀속 모호 — 「${t.lawHint}」 별표일 수 있음)` : ""}`)
      continue
    }
    // v0.25.0(E3) — 타법(「」 명시·자기법령과 다름) 준용은 그 법령을 자동 해소해 2층 인출. 실패 시 E2 강등.
    let jctx = selfCtxT
    let viaLabel = ""
    if (t.lawName && lawNameKey(t.lawName) !== lawNameKey(lawTitle)) {
      const cr = await getCrossT(t.lawName)
      if (!cr.ok) {
        jBlocks.push(`▷ ${jo} 본문이 ${fmtJunyong(t)}을(를) 준용 — ⚠ 타법 자동 해소 실패(${cr.reason}). build_application_timetable(lawName="${t.lawName}")로 별도 확인.`)
        continue
      }
      jctx = cr.ctx
      viaLabel = `「${t.lawName}」`
    }
    jBlocks.push(`▷ ${jo} 본문이 ${viaLabel}${t.jo}${t.hang || ""}을(를) 준용 — 적용시기는 '준용 구조(${jo})'와 '준용 대상(${viaLabel}${t.jo}) 내용' 두 층의 부칙이 따로 정할 수 있다(2층 타임라인). 두 층 모두 점검하라.${t.joRange ? ` ⚠ 범위 준용 ${t.joRange} — 대표 ${t.jo}만 2층 추적(전체 조는 build_application_timetable/korean-law로).` : ""}`)
    // v0.25.0(리뷰 EF-3) — 비인접 「법령명」 귀속 모호 힌트(자기법 처리 공지, 무언 강등 금지).
    if (!t.lawName && t.lawHint) {
      jBlocks.push(`  ⚠ 준용 귀속 주의: 본문에 「${t.lawHint}」 언급이 선행하나 조문 참조와 비인접 — 자기 법령(${lawTitle}) 조문으로 처리함. 타법 조문일 가능성 있으면 build_application_timetable(lawName="${t.lawHint}")로 교차 확인.`)
    }
    // v0.25.0(리뷰 A6+A3) — 타법 provenance(MST·URL) 병기 + '현행 시행본 기준 해소' caveat.
    if (viaLabel) {
      jBlocks.push(`  타법 출처: ${jctx.lawTitle} (MST ${jctx.mst}) ${displayLawServiceUrl(jctx.mst)} — ⚠ 타법은 현행(오늘) 시행본 기준으로 해소됨: 과거 귀속연도 질의 시 타법 조문번호 재편(전부개정 등) 가능. 필요시 get_law_article(lawName="${t.lawName}", year=귀속연도)로 그 시점 본문 확인.`)
    }
    const ti = articleInfoFromXml(jctx.xml, t.jo, t.hang)
    // v0.25.0(리뷰 A4) — 존재게이트: 대상 조문 미발견·삭제를 정상 데이터처럼 승격 금지(라벨 강등).
    // 부칙 스캔은 계속한다 — 삭제 조문의 과거 적용례·경과조치는 법적으로 유효한 연혁이므로 데이터 억제 대신 라벨.
    if (ti.status !== "found") {
      jBlocks.push(`  ⚠ 준용 대상 ${viaLabel}${t.jo} — ${jctx.lawTitle || "현행본"}에서 ${ti.status === "deleted" ? `삭제됨 <${ti.deletedDate || "?"}>` : "미발견(조번호 이동·재편 가능)"} — 아래 부칙 언급(있는 경우)은 동번호 기계검색이니 별도 확인 필수.`)
    }
    const tDates = ti.dates
    if (tDates.length) jBlocks.push(`  개정 인벤토리 ${viaLabel}${t.jo}${t.hang || ""}: ${tDates.join(", ")}`)
    const tKey = t.jo.replace(/\s/g, "")
    const tMatched = jctx.units
      .filter((u) => joMentioned(u.text.replace(/\s/g, ""), tKey)) // v0.21.0(#X-11)
      .sort((a, b) => (b.promulgationDate || "").localeCompare(a.promulgationDate || ""))
    if (tMatched.length === 0) {
      // v0.25.0(리뷰 A4) — 조문 부재 시 "적용례 없음"을 정상 결과처럼 표시 금지.
      jBlocks.push(ti.status === "found"
        ? `  (부칙에서 ${viaLabel}${t.jo} 언급 적용례 없음)`
        : `  (부칙 언급도 없음 — '적용례 없음' 단정 금지, 위 ⚠ 미발견/삭제 라벨 참조)`)
      continue
    }
    for (const u of tMatched.slice(0, args.full === true ? 8 : 4)) {
      const clauses = extractJoClauses(u.text, t.jo, t.hang)
      const binding = checkAmendmentBinding(u.promulgationDate || "", tDates)
      for (const c of clauses.slice(0, 3)) {
        const type = classifyApplicationClause(c.clause)
        junyongTypes.add(type)
        const revs = detectAddendumRevisionTails(c.clause, u.promulgationDate)
        jBlocks.push(`  · [제${u.promulgationNo || "?"}호${binding === "개정 흔적 없음" ? "·결박⚠" : binding === "개정함" ? "·결박✓" : ""}][${type}]${revs.length ? `[부칙개정⚠ ${revs.map(formatYmd).join("·")}]` : ""} ${truncate(c.clause, args.full === true ? 1500 : 500)}`)
        if (revs.length) {
          jBlocks.push(`     └▶ ⚠ 부칙 자체개정: 이 적용례 문구는 후행 개정령(${revs.map(formatYmd).join(", ")})이 부칙을 고친 현행화본 — 개정 전에는 적용 기준(anchor)이 달랐을 수 있다. 지시문 원문은 get_law_revision_text(promulgationDate=${revs[0]})로, 개정 전 문구는 그 개정일 이전 시행본 MST의 부칙으로 대조하라.`)
        }
        if (targetYear !== undefined) {
          const note = targetYearApplicationNote(type, c.clause, targetYear, extractEnforceDate(u.text, u.promulgationDate), filingMonth)
          if (note) jBlocks.push(`     └▶ ${targetYear} 귀속 판단: ${note}`)
        }
      }
    }
  }

  const lines: string[] = [TRACE_GUARD, ""]
  if (selfTypes.has("최초공제연도기준") || junyongTypes.has("최초공제연도기준")) {
    lines.push(
      "⚠⚠ [차수 확인 필수] 적용례에 '최초공제연도' 기준 검출 — 귀속연도만으로 판정 불가.",
      '   답변 전에 사용자에게 질문하라: "해당 연도가 1차공제(최초공제연도)인지, 이전 연도 최초공제 사이클의 추가공제인지?" (다년 사이클 공제: 통합고용 §29의8, 구 고용증대 §29의7 등)',
      "",
    )
  }
  if ((selfTypes.has("신고시점기준") || junyongTypes.has("신고시점기준")) && targetYear === undefined) {
    lines.push("⚠ 신고시점 기준 적용례 존재 — targetYear·filingMonth를 지정해 재호출하면 연도별 소급 판단노트가 생성된다.", "")
  }
  if (selfTypes.has("유형미상") || junyongTypes.has("유형미상")) {
    lines.push(
      "⚠ [유형미상] 라벨이 붙은 적용례 있음 — 자동 분류가 기준시점(anchor)을 특정하지 못한 것이지 '적용례 없음'이 아니다.",
      "   해당 적용례는 원문 문구를 직접 읽고 anchor(시행일·특정일자·과세연도 개시·신고시점·행위시점·소득 발생)를 판정하라. 미분류를 근거로 결론을 내리지 마라.",
      "",
    )
  }
  lines.push("조문 적용시점 추적", `출처: ${url}`, `법령: ${lawTitle || "N/A"} (MST ${mst}) / 대상 조문: ${jo}${hang ? " " + hang : ""}`)
  lines.push(`부칙 union 출처 MST: ${sourceMsts.join(", ")} (통합본 consolidation lag 보정)`)
  if (supplementedNos.length > 0) {
    lines.push(`⚠ 현행 MST(${mst}) 부칙에 없어 다른 시행본에서 보강한 공포번호: ${supplementedNos.join(", ")} — 이 보강 적용례가 결론에 영향 줄 수 있으니 반드시 확인.`)
  }
  if (targetYear !== undefined) lines.push(`targetYear: ${targetYear} 귀속 (신고시점 추정 ${targetYear + 1}.${filingMonth}월)`)
  // 충돌 경고 — v0.25.0(리뷰 A5): '같은 조문' 판정은 자기 조문 층(selfTypes)만. 준용 대상 층은 별도 표기.
  if (selfTypes.has("경과조치(종전규정)") && [...selfTypes].some((t) => t !== "경과조치(종전규정)" && t !== "유형미상")) {
    lines.push(`⚠ 부칙 충돌 가능: 같은 조문에 [경과조치(종전규정)]와 [${[...selfTypes].filter((t) => t !== "경과조치(종전규정)" && t !== "유형미상").join(", ")}]가 공존 → 어느 적용례가 우선하는지(후행·특정 우선 + 결박검증) 반드시 판단하라.`)
  }
  if (junyongTypes.size) {
    lines.push(`준용 대상 층 부칙 유형: [${[...junyongTypes].join(", ")}] — 자기 조문(${jo}) 층과 별개 층이므로 충돌·우선순위는 층별로 분리 판단.`)
  }
  lines.push(`부칙 적용례: ${jo} 언급 개정 ${matched.length}건 (최신순)`, "")
  if (matched.length === 0) {
    lines.push(`⚠ 이 조문(${jo}) 자체의 부칙 적용례 미발견 — jo 표기 확인(예: '제26조의8')·get_law_addenda로 전체 부칙 확인. 아래는 준용 체인 층만 회수됨.`, "")
  }
  if (inventory.article.length) {
    lines.push("── 개정 인벤토리(현행본 <개정·신설> 꼬리표 = 이 조문을 실제 고친 개정일) ──")
    lines.push(`${jo} 전체: ${inventory.article.join(", ")}`)
    if (hangSym && hangDates.length) lines.push(`${hang}(${hangSym}): ${hangDates.join(", ")}`)
    else if (!hang) {
      for (const [h, ds] of Object.entries(inventory.byHang).slice(0, 20)) lines.push(`${h}: ${ds.join(", ")}`)
    }
    lines.push("주의: 꼬리표에 없는 공포일의 부칙이 이 조항을 언급해도, 그 개정령은 이 조항을 고치지 않았을 수 있다(결박검증 ⚠ 표시 참조).", "")
  }
  if (currentBody) {
    lines.push(`── 현행 ${jo} 본문 발췌(앵커, 적용 버전 확정 후 사용) ──`, truncate(currentBody, args.full === true ? 3000 : 1000), "")
  }
  lines.push("── 부칙 적용례 타임라인 ──", ...blocks)
  if (jBlocks.length) lines.push("── 준용 체인(자동 추적) ──", ...capJunyongBlocks(jBlocks, args.full === true), "")
  lines.push("구버전/시점별 조문 본문·수식이미지는 get_law_article(jo, year 또는 efYd/mst)로 회수. 여러 조문×여러 귀속연도 매트릭스는 build_application_timetable로 한 번에 조립.")
  return textResponse(truncate(lines.join("\n"), args.full === true ? 80000 : 32000))
}

// v0.16.0(G10) — 적용시기 미결박 능동 가드(부칙 우선). 귀속연도 의존 요소(단가·공제율·사후관리·추징·
// 상시근로자 등)를 담은 조문을 year/efYd 앵커 없이 회수하면, 결론 전 build_application_timetable(부칙·경과
// 조치 결박)을 강제 안내한다. 기존 4069행 일반 안내보다 강한 조건부 ⚠(세액공제류 고위험 조문 한정).
export function buildApplicationTimingGuard(body: string, hasYearAnchor: boolean): string[] {
  if (hasYearAnchor) return []
  // 고위험(귀속연도 의존) 키워드만 — '세액공제·공제대상' 등 광범위어는 단순 현행조문 조회 과발동을 유발해 제외(Codex v0.16.1).
  if (!/(공제율|단가|상시근로자|사후관리|추징|최초.{0,3}공제|감면율)/.test(String(body || ""))) return []
  return [
    "── 적용시기 미결박 ⚠ (귀속연도 의존 조문) ──",
    "단가·공제율·사후관리 등 귀속연도에 따라 달라지는 요소를 포함 — 귀속연도별 단가·요건·추징 결론 전에 build_application_timetable(부칙·경과조치·준용 결박)으로 적용시기를 확정하라. 다년 사이클 공제(통합고용 등)는 최초공제연도(차수) 미확인 시 사용자에게 질문(귀속연도만으론 판정 불가).",
  ]
}

// 조특법(법률) 제6조(창중감)·제7조(중특감) 회수 시 업종 적격 판정도구로 능동 라우팅.
// 시행령·시행규칙의 같은 조번호는 다른 내용이므로 법률명 정확일치로 한정한다.
export function buildCreditEligibilityHint(lawTitle: string, jo: string): string[] {
  if ((lawTitle || "").replace(/\s+/g, "") !== "조세특례제한법") return []
  const j = (jo || "").replace(/\s+/g, "")
  if (j === "제6조") {
    return [
      "── 업종 적격(창중감) 안내 ──",
      "특정 업종코드가 §6③ 각 호의 감면 대상 업종인지는 classify_credit_eligibility(업종코드)로 확인(연계표 기반·provisional). ⚠ 부동산임대·소비성서비스 주된사업 배제 등 단서는 조특령 §2·§5 본문으로 재확인.",
    ]
  }
  if (j === "제7조") {
    return [
      "── 업종 적격(중특감) 안내 ──",
      "특정 업종코드가 §7①1호 각 목의 감면 대상 업종인지는 classify_credit_eligibility(업종코드)로 확인(연계표 기반·provisional). ⚠ 단서업종(자동차정비공장=종합·소형종합정비업만[조특칙§22], 의료업 요건 등)은 조특령 §6·조특칙으로 재확인.",
    ]
  }
  return []
}

// v0.22.0 — 하위 위임(고시·행정규칙·시행규칙) 감지 가드.
// 실측 사고(2026-07-14, 조특법 §30 중소기업 취업자 감면): 중기령 §3의3④가 "…중소벤처기업부장관이
// 정하여 고시한다"로 세부 적용기간을 고시(중소기업 범위 및 확인에 관한 규정)에 위임했는데, 시행령
// 본문 단서(관계기업)만 보고 "공시집단 편입 즉시전환 규정 없음"이라 단정 → 고시 §3②2호(편입 사유
// 발생일부터 즉시 적용)를 놓쳐 결론이 반대로 뒤집힘. 조문이 하위규범(고시/훈령/예규/시행규칙)에
// 위임하면 결론(특히 적용시점·판정시점·판정단위·계산방법) 전 그 하위규범을 확인하도록 능동 경고.
// 과발동 방지: '대통령령으로 정한다'(에이전트가 통상 시행령으로 하강)는 제외하고, 자주 누락되는
// 고시·행정규칙과 시행규칙(부령·총리령) 위임만 포착한다.
export function buildDelegationGuard(body: string, jo: string): string[] {
  const text = String(body || "")
  if (!text) return []
  // v0.23.0(C) — 종결형('…정한다')도 포착(장관/청장은 '이', 위원회는 '가').
  // v0.25.0(리뷰 O2-7) — 누락 종결형 보강: '…이 고시한다/고시하는'(주체 결합 한정)·'고시로 정하는/정하도록/정하여'.
  //   무주체 '고시한다'는 과발동 위험으로 제외(주체 anchor 유지).
  const toGosi = /(정하여\s*고시|고시로\s*정(?:한다|하는|하도록|하여)|고시하는\s*바|(?:장관|청장|위원장)이\s*(?:정|고시)(?:하여|하는|한다)|위원회가\s*(?:정|고시)(?:하여|하는|한다))/.test(text)
  // v0.23.0(C) — 조사 '이'('부령이 정하는')도 포착.
  const toRule = /(총리령|[가-힣]{2,12}부령)(?:으로|에서|에|이)\s*정(?:한다|하는|하도록|하여)/.test(text)
  if (!toGosi && !toRule) return []
  const out = [`── 하위 위임 감지 ⚠ (${jo}: 상위 조문에서 종료 금지) ──`]
  if (toGosi) {
    out.push(
      "이 조문은 세부사항을 고시·행정규칙(고시·훈령·예규)에 위임한다 — 적용시점·판정시점·판정단위·계산방법 등 운영 세부는 상위 조문이 아니라 그 하위규범이 정한다. 결론(특히 그 세부) 전 필수 확인: korean-law discover_tools(intent=\"행정규칙\")→search_admin_rule(knd 3고시/1훈령/2예규)→get_admin_rule로 현행 고시 본문·소관부처 확인. 국세청 소관 위임이면 집행기준(call_taxlaw_extra name=\"get_execution_standard\", args={law, number})·기본통칙(list_taxlaw_basic_ruling_laws→get_taxlaw_basic_ruling_text)도 병행.",
    )
  }
  if (toRule) {
    // v0.23.0(C) — 부령 위임이 서식(신청서·계산서·명세서)뿐이면 과발동 완화(공리⑥: 서식·별지<법령 문언).
    // 위임 직후 24자 안에 서식류 명사만 있으면 서식 위임으로 강등. 하나라도 실체 위임이면 강한 경고 유지.
    const ruleRefs = [...text.matchAll(/(?:총리령|[가-힣]{2,12}부령)(?:으로|에서|에|이)\s*정(?:한다|하는|하도록|하여)([^.\n]{0,24})/g)]
    const substantive = ruleRefs.length === 0 || ruleRefs.some((m) => !/(서식|신청서|신고서|계산서|명세서|증명서|서류|신청)/.test(m[1] || ""))
    if (substantive) {
      out.push(
        "이 조문은 시행규칙(총리령·부령)에 위임한다 — 시행령에서 멈추지 말고 해당 시행규칙 조문을 get_law_article(lawName=\"○○시행규칙\", jo) 또는 korean-law get_law_text로 확인하라.",
      )
    } else {
      out.push(
        "이 조문의 시행규칙(총리령·부령) 위임은 서식(신청서·계산서·명세서 등)으로 보인다 — 실체 판단엔 통상 불필요(공리⑥: 서식·별지<법령 문언). 서식 자체가 쟁점일 때만 해당 시행규칙 조문을 확인하라.",
      )
    }
  }
  return out
}

export async function getLawArticle(args: LawArticleArgs): Promise<ToolResponse> {
  const jo = requireString("jo", args.jo)
  const oc = String(args.oc ?? process.env.LAW_GO_KR_OC ?? "").trim()
  if (!oc) {
    throw new TaxlawMcpError(
      "법제처 Open API 인증키(OC)가 필요합니다. 환경변수 LAW_GO_KR_OC를 설정하거나 oc 파라미터로 전달하세요.",
      ErrorCodes.INVALID_PARAM,
    )
  }
  const mstArg = String(args.mst ?? "").trim()
  const lawName = String(args.lawName ?? "").trim()
  const year = normalizeYear(args.year)
  const { efYd, note: efYdNote } = normalizeEfYd(
    String(args.efYd ?? "").trim() || (year !== undefined ? `${year}1231` : ""),
  )
  if (!mstArg && !lawName) {
    throw new TaxlawMcpError("mst 또는 lawName 중 하나는 필수입니다.", ErrorCodes.INVALID_PARAM)
  }

  let mst = mstArg
  let versions: LawVersion[] = []
  let pickNote = ""
  let nameFallbackNote: string | null = null
  // v0.20.0(#9) — mst 직접 지정 + lawName 동시: 버전목록은 후행개정 가드 전용이고 조문 XML(MST 이미 확정)과 독립 →
  // 여기서 await하지 않고 promise만 만들어 아래 조문 XML fetch와 Promise.all로 병렬화(직렬 1왕복 제거).
  let versionsPromise: Promise<LawVersion[]> | null = null
  if (lawName) {
    if (!mst) {
      versions = await fetchEflawVersions(oc, lawName, 40) // 해소에 필수 — 실패 시 호출 실패가 맞다
    } else {
      // mst 직접 지정이면 버전 목록은 후행 개정 가드 전용(soft-fail: 실패 시 가드만 생략) → 조문 XML과 병렬.
      versionsPromise = fetchEflawVersions(oc, lawName, 40).catch(() => [])
    }
  }
  if (!mst) {
    const ownVersions = filterVersionsByName(versions, lawName) // 교차법령 행 배제(일치 0건이면 원본)
    nameFallbackNote = lawNameFallbackNote(versions, lawName) // v0.27.0 — 폴백 유지 + 무경고 금지
    if (efYd && ownVersions.length) {
      const picked = pickVersionInForce(ownVersions, efYd)
      if (picked) {
        mst = picked.mst
        pickNote = ` (efYd ${efYd}${efYdNote ?? ""} 시점 시행본: 시행 ${formatYmd(picked.enforceDate)})`
      } else {
        // v0.11.0 — 최근 40행 윈도우에 efYd 이전 시행본이 없으면 현행본 fallback을 침묵시키지 않는다
        // (무경고 fallback이 '요청 시점본을 받았다'로 오독되는 역방향 누락 — 리뷰 실증).
        pickNote = ` (⚠ efYd ${efYd} 시점 시행본을 최근 40행 윈도우에서 찾지 못해 현행본을 반환 — 요청 시점 텍스트 아님. 구버전 MST는 korean-law-mcp search_historical_law로 확보해 mst로 전달하라)`
      }
    } else if (!efYd && ownVersions.length) {
      // v0.21.0(#W-4) — 현행 조회(!mst && !efYd && !year): 이미 받은 ownVersions에서 오늘 시행본 MST를 먼저 시도하고,
      //   실패 시에만 resolveLawMst(별도 lawSearch 네트워크 1콜) 폴백. 잉여 왕복 제거(버전목록은 이미 회수됨).
      const pickedNow = pickVersionInForce(ownVersions, todayYmd())
      if (pickedNow) mst = pickedNow.mst
    }
    if (!mst) mst = await resolveLawMst(oc, lawName)
  }

  const url = `${MOLEG_BASE}/DRF/lawService.do?OC=${encodeURIComponent(oc)}&target=law&MST=${encodeURIComponent(mst)}&type=XML`
  const displayUrl = displayLawServiceUrl(mst) // v0.21.0(#G11) — 출처 표기용(OC 제외)
  // v0.20.0(#9) — 조문 XML과 (mst 지정 시) 가드용 버전목록을 병렬로. lawName-only 경로는 versionsPromise=null이라 이미 await된 versions를 그대로 사용.
  const [xml, versionsResolved] = await Promise.all([
    fetchMolegXml(url, "법령 조회"),
    versionsPromise ?? Promise.resolve(versions),
  ])
  versions = versionsResolved
  const lawTitle = (xml.match(/<법령명_한글>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/법령명_한글>/)?.[1] || "").trim()
  const enforceDate = (xml.match(/<시행일자>(\d+)<\/시행일자>/)?.[1] || "").trim()

  // v0.11.0 — 부칙 CDATA 오매칭 배제(<조문내용> 앵커) + 삭제 조문 적극 보고.
  const lookup = findArticleInXml(xml, jo)
  if (lookup.status === "deleted") {
    return notFoundResponse(
      `MST ${mst}(${lawTitle || "?"})에서 ${jo}는 삭제된 조문입니다(본문에 "삭제 <${lookup.deletedDate}>" 명시).${pickNote}`,
      [
        "삭제 전 본문은 삭제 이전 시점의 mst를 직접 지정해 조회하세요(구버전 MST는 korean-law-mcp search_historical_law로 확보).",
        "삭제 시점·적용시기는 get_law_revision_text(개정문)·get_law_addenda(부칙)로 확인하세요.",
      ],
    )
  }
  if (lookup.status !== "found") {
    return notFoundResponse(
      `MST ${mst}(${lawTitle || "?"})에서 ${jo} 본문을 찾지 못했습니다.${pickNote}`,
      [
        "jo 표기를 법령 그대로 맞추세요(예: '제26조의8').",
        "다른 시점이면 efYd(YYYYMMDD)/year 또는 정확한 mst를 지정하세요.",
      ],
    )
  }
  const { text, imageUrls } = extractArticleBody(lookup.block || "")

  // v0.11.0 — 후행 개정 능동 가드: 조회본이 오늘 기준 현행본이 아니면 현행본의 같은 조문을
  // 자동 대조(공백·flSeq 무시)해 변경/삭제/동일을 판정한다. 현행본 XML은 fetchMolegXml 캐시(24h) 공유.
  const today = todayYmd()
  // 가드용 버전 목록은 응답 XML의 공식 법령명 기준으로 교차법령 행을 배제하고,
  // 비었으면(mst 단독 호출 등) 공식 법령명으로 재회수 — '가드 무음 생략 = 현행' 오독 방지.
  let guardVersions = lawTitle
    ? versions.filter((v) => v.lawName && lawNameKey(v.lawName) === lawNameKey(lawTitle))
    : versions
  if (!guardVersions.length && lawTitle) {
    try {
      guardVersions = (await fetchEflawVersions(oc, lawTitle, 40)).filter(
        (v) => v.lawName && lawNameKey(v.lawName) === lawNameKey(lawTitle),
      )
    } catch {
      /* 가드 생략 */
    }
  }
  let currentArticleVerdict: ArticleDiffVerdict | undefined
  let currentDeletedDate: string | undefined
  let hasFormulaImages = text.includes("[수식이미지")
  const currentVer = guardVersions.length ? pickVersionInForce(guardVersions, today) : null
  if (currentVer && currentVer.mst !== mst && !(enforceDate && enforceDate > today)) {
    try {
      const curUrl = `${MOLEG_BASE}/DRF/lawService.do?OC=${encodeURIComponent(oc)}&target=law&MST=${encodeURIComponent(currentVer.mst)}&type=XML`
      const curXml = await fetchMolegXml(curUrl, "법령 조회(현행본 대조)")
      const c = classifyAgainstCurrent(curXml, jo, text)
      currentArticleVerdict = c.verdict
      currentDeletedDate = c.deletedDate
      hasFormulaImages = hasFormulaImages || c.hasFormulaImages
    } catch {
      currentArticleVerdict = "unknown"
    }
  }
  const revisionGuard = buildLaterRevisionGuard({
    versions: guardVersions,
    usedMst: mst,
    usedEnforceDate: enforceDate,
    today,
    jo,
    currentArticleVerdict,
    currentDeletedDate,
    hasFormulaImages,
  })

  const lines = [
    "법제처 조문 본문(시점별) — korean-law 연혁/수식 회수 결함 보완",
    ...(nameFallbackNote ? [nameFallbackNote] : []),
    `출처: ${displayUrl}`,
    `법령: ${lawTitle || "N/A"} (MST ${mst}) / 시행일 ${enforceDate ? formatYmd(enforceDate) : "?"}${pickNote}`,
    `대상 조문: ${jo}`,
    "⚠ 이 본문은 '이 시점에 시행 중이던' 조문이다. 어느 과세연도 신고에 적용되는지는 trace_article_application(부칙 적용례)로 별도 판정하라.",
  ]
  if (revisionGuard.length) lines.push("", ...revisionGuard)
  else if (guardVersions.length === 0) {
    // v0.21.0(#G7) — 가드용 버전목록 회수가 최종 실패(이중 soft-fail: versionsPromise catch→[] + lawTitle 재회수 catch)했으면
    //   revisionGuard가 무음으로 []를 반환한다. '침묵=현행'으로 오독되지 않도록 실패 신호를 무조건 1줄 부착.
    //   (versions가 정상 회수됐는데 후행개정 없음 = guardVersions.length>0 이므로 이 분기 미진입 = 기존대로 정상 침묵.)
    lines.push("", "⚠ 후행개정 가드 실패(버전목록 회수 불가) — 이 본문의 현행 여부 미확인. diff_article_versions 또는 재호출로 직접 확인하라.")
  }
  const forkGuard = buildInterpretiveForkGuard(text, jo)
  if (forkGuard.length) lines.push("", ...forkGuard)
  const timingGuard = buildApplicationTimingGuard(text, Boolean(efYd))
  if (timingGuard.length) lines.push("", ...timingGuard)
  const creditHint = buildCreditEligibilityHint(lawTitle, jo)
  if (creditHint.length) lines.push("", ...creditHint)
  const delegationGuard = buildDelegationGuard(text, jo)
  if (delegationGuard.length) lines.push("", ...delegationGuard)
  // v0.23.0(A)/v0.24.0(E2) — 준용 감지: 같은 법령 / 타법 / 별표를 분리 라벨(타법은 현재 법령 부칙과 별개).
  const junyongTargets = extractJunyongTargets(text, jo)
  if (junyongTargets.length) {
    const sameLaw = junyongTargets.filter((t) => t.jo && !t.lawName)
    const parts = ["", `── 준용 감지 ⚠ (${jo}: 준용 대상도 확인) ──`]
    if (sameLaw.length) {
      parts.push(`이 조문은 ${sameLaw.map((t) => t.jo + (t.hang || "")).join(", ")}을(를) 준용 — 대상 본문(get_law_article)·2층 부칙(trace_article_application/build_application_timetable)은 이 조문과 별개다.`)
    }
    // v0.26.0(리뷰 EF-3 완결성) — 비인접 「법령명」 귀속 모호(lawHint) 타깃도 trace·timetable처럼 명시 라벨(get_law_article만 침묵하던 갭).
    for (const t of junyongTargets.filter((t) => !t.lawName && t.lawHint)) {
      parts.push(`⚠ 준용 귀속 주의 ${fmtJunyong(t)} — 본문에 「${t.lawHint}」 언급이 선행하나 조문 참조와 비인접이라 자기 법령(${lawTitle || "?"}) 조문으로 처리. 타법 조문일 가능성 있으면 build_application_timetable(lawName="${t.lawHint}")로 교차 확인.`)
    }
    for (const t of junyongTargets.filter((t) => t.lawName)) {
      parts.push(`⚠ 타법 준용: ${fmtJunyong(t)} — 현재 법령(${lawTitle || "?"})의 부칙·인벤토리와 별개다. 대상 법령 본문은 korean-law get_law_text, 2층 타임라인은 build_application_timetable(lawName="${t.lawName}")로 별도 확인하라.`)
    }
    for (const t of junyongTargets.filter((t) => !t.jo && !t.lawName && t.annex)) {
      parts.push(`⚠ 별표 준용: ${t.annex} — 별표는 조문 부칙과 별개인 자체 개정 연혁을 가진다. korean-law get_annexes로 확인하라.`)
    }
    lines.push(...parts)
  }
  const bodyCap = args.full === true ? 16000 : 6000
  lines.push(
    "",
    "── 본문 ──",
    truncate(text, bodyCap),
  )
  // v0.26.1(리뷰 O2-2) — 본문 절단 시 능동 재조회 안내(후미 항·호·계산식 소실 대비). cap 상향은 금지(토큰).
  if (text.length > bodyCap) {
    lines.push(`⚠ 본문 ${text.length.toLocaleString()}자 중 ${bodyCap.toLocaleString()}자만 표시(절단) — 후미 항·호·계산식 잘림 가능.${args.full === true ? " 특정 항은 trace_article_application(hang=)·diff_article_versions로 확인." : " full=true로 재조회하거나 특정 항을 지정하라."}`)
  }
  if (imageUrls.length) {
    lines.push("", `── 수식 이미지(${imageUrls.length}) — 다운로드 후 Read 또는 브라우저로 확인 ──`)
    imageUrls.forEach((u) => lines.push(u))
  }
  const footerVersions = guardVersions.length ? guardVersions : versions // 교차법령 행 배제본 우선
  if (footerVersions.length) {
    lines.push("", "── 최근 시행본(시점 선택용: efYd/mst) ──")
    footerVersions.slice(0, args.full === true ? 20 : 8).forEach((v) => lines.push(`시행 ${formatYmd(v.enforceDate)} | MST ${v.mst}`))
  }
  return textResponse(truncate(lines.join("\n"), args.full === true ? 30000 : 14000))
}

const TIMETABLE_AXIOMS = [
  "⚠ 해석 공리(반드시 준수):",
  "① 신·구 조문은 버전을 나란히 놓고 문구 단위로 대조하라(단일 시점본으로 단정 금지).",
  "② 부칙의 '개정규정'은 그 개정령이 실제 바꾼 문구 단위만 가리킨다(타 개정령의 신설·개정분은 그쪽 부칙 관할).",
  "③ 경과조치는 자기 개정령의 개정규정만 사정거리 — 미래(후행) 개정을 선제 유예할 수 없다.",
  "④ 후행·특정 적용례 > 일반 경과조치.",
  "⑤ 적극 문언 우선 — 문언에 없는 fallback(종전규정 회귀 등)을 창작하지 마라.",
  "⑥ 서식·별지 작성방법은 법규명령 본문이 아니다 — 부칙·법령 문언이 우선한다.",
].join("\n")

// 귀속연도×조문 적용 타임테이블 — 신구버전 인벤토리 + 부칙 결박검증 + 준용 체인 + 연도별 판단노트를 한 번에 조립.
export async function buildApplicationTimetable(args: TimetableArgs): Promise<ToolResponse> {
  const oc = String(args.oc ?? process.env.LAW_GO_KR_OC ?? "").trim()
  if (!oc) {
    throw new TaxlawMcpError(
      "법제처 Open API 인증키(OC)가 필요합니다. 환경변수 LAW_GO_KR_OC를 설정하거나 oc 파라미터로 전달하세요.",
      ErrorCodes.INVALID_PARAM,
    )
  }
  const mstArg = String(args.mst ?? "").trim()
  const lawName = String(args.lawName ?? "").trim()
  if (!mstArg && !lawName) {
    throw new TaxlawMcpError("mst 또는 lawName 중 하나는 필수입니다.", ErrorCodes.INVALID_PARAM)
  }
  const rawArticles = Array.isArray(args.articles) ? args.articles : args.articles ? [args.articles] : []
  const specs = rawArticles
    .map((s) => parseJoSpec(String(s)))
    .filter((s): s is { jo: string; hang?: string } => !!s)
    .slice(0, 4)
  if (specs.length === 0) {
    throw new TaxlawMcpError('articles가 필요합니다 — 예: ["제26조의8제6항", "제26조의8제4항"]', ErrorCodes.INVALID_PARAM)
  }
  const rawYears = Array.isArray(args.targetYears) ? args.targetYears : args.targetYears !== undefined ? [args.targetYears] : []
  const years = rawYears.map(Number).filter((n) => Number.isFinite(n) && n >= 1990 && n <= 2100).slice(0, 6)
  if (years.length === 0) {
    throw new TaxlawMcpError("targetYears가 필요합니다 — 예: [2024, 2025, 2026]", ErrorCodes.INVALID_PARAM)
  }
  const filingMonth = typeof args.filingMonth === "number" ? args.filingMonth : 3
  const firstCreditYear = typeof args.firstCreditYear === "number" ? args.firstCreditYear : undefined
  const full = args.full === true

  const prep = await prepareMergedAddenda(oc, mstArg, lawName, 4)
  const { mst, lawTitle, url, xml, units, sourceMsts, supplementedNos } = prep
  let versions: LawVersion[] = []
  try {
    versions = await fetchEflawVersions(oc, lawName || lawTitle, 40)
  } catch {
    versions = []
  }
  // v0.21.0(#G2) — 교차법령(시행령·시행규칙 등) 행 배제. '연말 시행본' 참고표기가 타법 버전으로 오염되는 것 방지.
  // v0.27.0 — 정확일치 0건 폴백은 유지하되 무경고는 금지(lawNameFallbackNote).
  const nameFallbackNote = lawNameFallbackNote(versions, lawName || lawTitle)
  versions = filterVersionsByName(versions, lawName || lawTitle)

  // 조문 본문 회수(현행 XML 내) + 인벤토리 — 순수 함수 위임(v0.25.0 E3 리팩터, 동작 동일).
  const articleInfo = (tjo: string, thang?: string) => articleInfoFromXml(xml, tjo, thang)
  // v0.25.0(E3) — 준용 타법 자동 해소기(요청당 memo·상한 2). specs 루프 밖에서 1회 생성(캡 공유).
  const getCross = makeCrossResolver(oc)

  const clauseCap = full ? 1500 : 320
  const lines: string[] = [
    "법령 적용 타임테이블 — 신구법령+부칙 통합(귀속연도×조문 매트릭스)",
    ...(nameFallbackNote ? [nameFallbackNote] : []),
    `출처: ${url}`,
    `법령: ${lawTitle || "N/A"} (MST ${mst}) / 부칙 union MST: ${sourceMsts.join(", ")}`,
    `대상 조문: ${specs.map((s) => s.jo + (s.hang || "")).join(", ")} / 귀속연도: ${years.join("·")} / 최초공제연도: ${firstCreditYear !== undefined ? firstCreditYear : "미지정"}`,
    ...(supplementedNos.length > 0
      ? [`⚠ 현행 MST(${mst}) 부칙에 없어 다른 시행본에서 보강한 공포번호: ${supplementedNos.join(", ")} — 누락 주의.`]
      : []),
    TIMETABLE_AXIOMS,
    "",
  ]
  let anyFirstCredit = false

  interface TtEntry { no: string; date: string; enforce: string; type: string; clause: string; binding: string; via?: string; revs: string[] }
  for (const spec of specs) {
    const { jo, hang } = spec
    const own = articleInfo(jo, hang)
    const junyong = own.body ? extractJunyongTargets(own.body, jo) : []
    const sameLawJy = junyong.filter((t) => t.jo && (!t.lawName || lawNameKey(t.lawName) === lawNameKey(lawTitle)))
    const crossLawJy = junyong.filter((t) => t.jo && t.lawName && lawNameKey(t.lawName) !== lawNameKey(lawTitle))
    const annexJy = junyong.filter((t) => !t.jo)

    lines.push(`════════ [조문 ${jo}${hang || ""}] ════════`)
    if (own.dates.length) lines.push(`개정 인벤토리(현행 꼬리표): ${own.dates.join(", ")}`)
    if (junyong.length) {
      lines.push(`준용 탐지: ${junyong.map(fmtJunyong).join(", ")} — 2층 타임라인(준용 구조/준용 대상 각각의 부칙)을 모두 점검`)
      // v0.24.0(E2) — 별표는 조문 부칙과 다른 자체 연혁 → 라벨만(E4 미착수).
      for (const t of annexJy) lines.push(`  ⚠ 별표 준용 ${fmtJunyong(t)} — 별표는 자체 개정 연혁(조문 부칙과 별개). korean-law get_annexes로 별도 확인.`)
      // v0.25.0(리뷰 EF-3) — 비인접 「법령명」 귀속 모호 힌트(자기법 처리 공지).
      for (const t of junyong.filter((x) => !x.lawName && x.lawHint)) lines.push(`  ⚠ 준용 귀속 주의 ${fmtJunyong(t)} — 본문에 「${t.lawHint}」 언급이 선행하나 비인접이라 자기 법령(${lawTitle}) 조문으로 처리. 타법 가능성 시 build_application_timetable(lawName="${t.lawHint}")로 교차 확인.`)
    }
    const delegation = own.body ? buildDelegationGuard(own.body, jo) : []
    if (delegation.length) delegation.forEach((d) => lines.push(d))

    const entries: TtEntry[] = []
    const collectFor = (tjo: string, thang: string | undefined, dates: string[], via: string | undefined, ctxUnits: AddendaUnit[] = units) => {
      const key = tjo.replace(/\s/g, "")
      const ms = ctxUnits
        .filter((u) => joMentioned(u.text.replace(/\s/g, ""), key)) // v0.21.0(#X-11)
        .sort((a, b) => (b.promulgationDate || "").localeCompare(a.promulgationDate || ""))
      for (const u of ms) {
        const cls = extractJoClauses(u.text, tjo, thang)
        if (cls.length === 0) continue
        const enforce = extractEnforceDate(u.text, u.promulgationDate)
        const binding = checkAmendmentBinding(u.promulgationDate || "", dates)
        for (const c of cls.slice(0, 4)) {
          entries.push({ no: u.promulgationNo || "?", date: formatYmd(u.promulgationDate), enforce, type: classifyApplicationClause(c.clause), clause: c.clause, binding, via, revs: detectAddendumRevisionTails(c.clause, u.promulgationDate) })
        }
      }
    }
    collectFor(jo, hang, own.dates, undefined)
    for (const t of sameLawJy.slice(0, 2)) {
      const ti = articleInfo(t.jo!, t.hang)
      collectFor(t.jo!, t.hang, ti.dates, `${t.jo}${t.hang || ""} 준용대상`)
      if (ti.dates.length) lines.push(`개정 인벤토리(준용대상 ${t.jo}${t.hang || ""}): ${ti.dates.join(", ")}`)
    }
    // v0.25.0(E3) — 타법 준용 자동 인출(2층 타임라인). 실패 시 E2 라벨로 강등(오귀속 금지).
    // v0.27.1(리뷰 P2) — 병렬 prewarm(루프와 동일 순서·동일 대상).
    getCross.prewarm(crossLawJy.slice(0, 2).map((t) => t.lawName))
    for (const t of crossLawJy.slice(0, 2)) {
      const cr = await getCross(t.lawName!)
      if (!cr.ok) {
        lines.push(`  ⚠ 타법 준용 ${fmtJunyong(t)} — 자동 해소 실패(${cr.reason}). build_application_timetable(lawName="${t.lawName}")로 별도 확인.`)
        continue
      }
      const ti = articleInfoFromXml(cr.ctx.xml, t.jo!, t.hang)
      // v0.25.0(리뷰 A6+A3) — 타법 provenance(MST·URL) 병기 + '현행 시행본 기준 해소' caveat.
      lines.push(`  타법 출처: ${cr.ctx.lawTitle} (MST ${cr.ctx.mst}) ${displayLawServiceUrl(cr.ctx.mst)} — ⚠ 타법은 현행(오늘) 시행본 기준으로 해소됨: 과거 귀속연도는 타법 조문번호 재편(전부개정 등) 가능.`)
      // v0.25.0(리뷰 A4) — 존재게이트: 미발견·삭제 라벨 강등(부칙 스캔은 유지 — 삭제 조문 연혁은 유효).
      if (ti.status !== "found") {
        lines.push(`  ⚠ 준용 대상 ${fmtJunyong(t)} — ${cr.ctx.lawTitle}에서 ${ti.status === "deleted" ? `삭제됨 <${ti.deletedDate || "?"}>` : "미발견(조번호 이동·재편 가능)"} — 아래 부칙표의 동번호 언급은 별도 확인 필수.`)
      }
      collectFor(t.jo!, t.hang, ti.dates, `${fmtJunyong(t)} 준용대상`, cr.ctx.units)
      lines.push(`개정 인벤토리(준용대상 ${fmtJunyong(t)} @${cr.ctx.lawTitle}): ${ti.dates.length ? ti.dates.join(", ") : "없음"}`)
    }

    if (entries.length === 0) {
      lines.push("(부칙에서 이 조문 언급 적용례 없음 — get_law_addenda로 전체 부칙 확인)", "")
      continue
    }
    if (entries.some((e) => e.type === "최초공제연도기준")) anyFirstCredit = true

    const shown = entries.slice(0, full ? 24 : 12)
    lines.push("부칙 적용례(결박검증 포함):")
    for (const e of shown) {
      lines.push(`· [제${e.no}호 공포 ${e.date} / 시행 ${e.enforce || "?"}]${e.via ? `[${e.via}]` : ""}[${e.type}][결박:${e.binding === "개정함" ? "✓" : e.binding === "개정 흔적 없음" ? "⚠없음" : "?"}]${e.revs.length ? `[부칙개정⚠ ${e.revs.map(formatYmd).join("·")}]` : ""} ${truncate(e.clause, clauseCap)}`)
      if (e.revs.length) {
        lines.push(`   └▶ ⚠ 부칙 자체개정: 이 적용례 문구는 후행 개정령(${e.revs.map(formatYmd).join(", ")})이 부칙을 고친 현행화본 — 개정 전에는 적용 기준(anchor)이 달랐을 수 있다(예: 신고시점→최초공제연도). 지시문 원문은 get_law_revision_text(promulgationDate=${e.revs[0]})로, 개정 전 문구는 그 개정일 이전 시행본 MST의 부칙으로 대조하라.`)
      }
      if (e.type === "경과조치(종전규정)" && e.binding === "개정 흔적 없음") {
        lines.push("   └▶ ⚠ 사정거리: 이 개정령은 대상 조항을 고친 흔적이 없음 — 경과조치는 자기 개정령의 개정규정만 유예하므로 후행 개정을 선제 유예할 수 없다.")
      }
    }
    if (entries.length > shown.length) {
      // v0.25.0(리뷰 A2) — full=false slice에서 준용 층 entries가 통째로 밀릴 때 무언 드롭 금지(명시 라벨).
      const omittedVia = entries.slice(shown.length).filter((e) => e.via).length
      lines.push(`… 외 ${entries.length - shown.length}건 생략(full=true로 더 보기${omittedVia ? ` — ⚠ 생략분에 준용 대상 층 ${omittedVia}건 포함(타법 층 포함 가능)` : ""}).`)
    }
    lines.push("── 귀속연도별 판단노트 ──")
    for (const y of years) {
      const notes: string[] = []
      if (firstCreditYear !== undefined && entries.some((e) => e.type === "최초공제연도기준")) {
        notes.push(
          firstCreditYear === y
            ? `★차수: ${y} = 1차공제(최초공제연도) → '최초공제연도 기준' 적용례의 개정규정 적용 검토`
            : firstCreditYear < y
              ? `★차수: 최초공제연도 ${firstCreditYear} 사이클의 추가공제·사후관리 연도 → 종전규정 유지 여부를 적용례 verbatim으로 판정`
              : `★차수: 최초공제연도(${firstCreditYear})가 ${y}보다 뒤 → ${y}에는 해당 사이클 미개시`,
        )
      }
      for (const e of shown) {
        const n = targetYearApplicationNote(e.type, e.clause, y, e.enforce, filingMonth)
        if (n) notes.push(`[제${e.no}호·${e.type}${e.via ? `·${e.via}` : ""}] ${n}`)
      }
      const inForce = versions.length ? pickVersionInForce(versions, `${y}1231`) : null
      lines.push(`▶ ${y} 귀속${inForce ? ` (연말 시행본: 시행 ${formatYmd(inForce.enforceDate)} MST ${inForce.mst} — 참고용, 적용 판정은 부칙이 정함)` : ""}`)
      if (notes.length) notes.forEach((n) => lines.push(`   - ${n}`))
      else lines.push("   - (자동 판단노트 없음 — 위 적용례 verbatim으로 직접 판정)")
    }
    lines.push("")
  }

  const head: string[] = []
  if (anyFirstCredit && firstCreditYear === undefined) {
    head.push(
      "⚠⚠ [차수 확인 필수] 적용례에 '최초공제연도' 기준 검출 — 귀속연도만으로 판정 불가.",
      '   사용자에게 질문하라: "해당 연도가 1차공제(최초공제연도)인지, 이전 연도 최초공제 사이클의 추가공제인지?" → firstCreditYear 지정 후 재호출 권장.',
      "",
    )
  }
  lines.push("이 표는 부칙 verbatim의 기계적 조립이며 자동 단정이 아니다 — 결론은 각 칸의 근거 조항 원문과 함께 적어라. 버전별 조문 본문·수식이미지는 get_law_article(jo, efYd/mst)로 회수.")
  return textResponse(truncate([...head, ...lines].join("\n"), full ? 80000 : 30000))
}

// ── v0.10.0: diff_article_versions ──────────────────────────────────────────
// 두 시점 시행본의 같은 조문을 단어단위로 기계 대조. 타임테이블 공리 ①·②의 기계화.

interface ArticleDiffArgs {
  jo?: unknown
  hang?: unknown
  lawName?: unknown
  yearA?: unknown
  efYdA?: unknown
  mstA?: unknown
  yearB?: unknown
  efYdB?: unknown
  mstB?: unknown
  oc?: unknown
  full?: unknown
}

const DIFF_KIND_LABEL: Record<ChangeKind, string> = {
  substantive: "실질변경",
  cosmetic: "자구정비",
  renumbering: "번호이동",
}

// 조문 본문에서 특정 항(①~⑳) 블록만 절단. 못 찾으면 전체 본문 유지(found=false).
// 직렬화 본문은 항번호+항내용 CDATA 결합으로 마커가 "⑥⑥"처럼 중복된다 — 선두 마커 연속
// 구간을 건너뛰지 않으면 두 번째 마커에서 즉시 절단돼 양쪽 모두 "⑥"만 남아 거짓 '변경 없음'이 된다.
export function sliceHangBlock(text: string, hang: string): { text: string; found: boolean } {
  const sym = hangToSymbol(hang)
  if (!sym) return { text, found: false }
  const idx = text.indexOf(sym)
  if (idx === -1) return { text, found: false }
  let bodyStart = idx + sym.length
  while (text.startsWith(sym, bodyStart)) bodyStart += sym.length
  const rest = text.slice(bodyStart)
  const next = rest.search(/[①-⑳]/)
  return { text: sym + (next === -1 ? rest : rest.slice(0, next)), found: true }
}

export async function diffArticleVersionsTool(args: ArticleDiffArgs): Promise<ToolResponse> {
  const jo = requireString("jo", args.jo)
  const hang = String(args.hang ?? "").trim()
  const oc = String(args.oc ?? process.env.LAW_GO_KR_OC ?? "").trim()
  if (!oc) {
    throw new TaxlawMcpError(
      "법제처 Open API 인증키(OC)가 필요합니다. 환경변수 LAW_GO_KR_OC를 설정하거나 oc 파라미터로 전달하세요.",
      ErrorCodes.INVALID_PARAM,
    )
  }
  const lawName = String(args.lawName ?? "").trim()
  const sideSpec = (yearRaw: unknown, efYdRaw: unknown, mstRaw: unknown, label: string) => {
    const mst = String(mstRaw ?? "").trim()
    const year = normalizeYear(yearRaw, `year${label}`)
    const { efYd } = normalizeEfYd(
      String(efYdRaw ?? "").trim() || (year !== undefined ? `${year}1231` : ""),
      `efYd${label}`,
    )
    if (!mst && !efYd) {
      throw new TaxlawMcpError(`${label}측 시점 지정 필요: mst${label} 또는 year${label}/efYd${label}.`, ErrorCodes.INVALID_PARAM)
    }
    if (!mst && !lawName) {
      throw new TaxlawMcpError(`year/efYd로 시점을 해소하려면 lawName이 필요합니다.`, ErrorCodes.INVALID_PARAM)
    }
    return { mst, efYd }
  }
  const specA = sideSpec(args.yearA, args.efYdA, args.mstA, "A")
  const specB = sideSpec(args.yearB, args.efYdB, args.mstB, "B")

  let versions: LawVersion[] = []
  let nameFallbackNote: string | null = null
  if (!specA.mst || !specB.mst) {
    versions = await fetchEflawVersions(oc, lawName, 40)
    // v0.21.0(#G2) — 교차법령 행 배제 후 시점 해소(시행령을 '그 시점 시행본'으로 오판하는 것 방지).
    // v0.27.0 — 정확일치 0건 폴백은 유지하되 무경고는 금지.
    nameFallbackNote = lawNameFallbackNote(versions, lawName)
    versions = filterVersionsByName(versions, lawName)
  }
  const resolveSide = (spec: { mst: string; efYd: string }, label: string): { mst: string; pickedEnforce: string } => {
    if (spec.mst) return { mst: spec.mst, pickedEnforce: "" }
    const picked = pickVersionInForce(versions, spec.efYd)
    if (!picked) {
      throw new TaxlawMcpError(
        `${label}측 efYd ${spec.efYd} 시점 시행본을 eflaw 목록에서 찾지 못했습니다(최근 40건 window 밖일 수 있음). korean-law-mcp search_historical_law로 mst${label}를 직접 확보하세요.`,
        ErrorCodes.NOT_FOUND,
      )
    }
    return { mst: picked.mst, pickedEnforce: picked.enforceDate }
  }
  let sideA = resolveSide(specA, "A")
  let sideB = resolveSide(specB, "B")

  if (sideA.mst === sideB.mst) {
    return textResponse([
      "신구 조문 단어단위 기계 diff",
      `두 시점이 같은 시행본(MST ${sideA.mst})으로 해소되었습니다 — 그 사이 ${jo} 시행본 교체 없음.`,
      "다른 개정 구간을 보려면 yearA/yearB(또는 efYd, mst)를 더 벌려 지정하세요. 시행본 목록은 get_law_article(full=true)의 '최근 시행본' 참조.",
    ].join("\n"))
  }

  const fetchSide = async (mst: string) => {
    const url = `${MOLEG_BASE}/DRF/lawService.do?OC=${encodeURIComponent(oc)}&target=law&MST=${encodeURIComponent(mst)}&type=XML`
    const xml = await fetchMolegXml(url, "법령 조회")
    const lawTitle = (xml.match(/<법령명_한글>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/법령명_한글>/)?.[1] || "").trim()
    const enforceDate = (xml.match(/<시행일자>(\d+)<\/시행일자>/)?.[1] || "").trim()
    const idx = xml.indexOf(`<![CDATA[${jo}(`)
    if (idx === -1) return { lawTitle, enforceDate, text: null as string | null }
    const s = xml.lastIndexOf("<조문단위", idx)
    const e = xml.indexOf("</조문단위>", idx)
    const { text } = extractArticleBody(xml.slice(s, e))
    return { lawTitle, enforceDate, text: text as string | null }
  }
  let [vA, vB] = await Promise.all([fetchSide(sideA.mst), fetchSide(sideB.mst)])

  // A=구(시행일 빠른 쪽) 정렬 보장 — 거꾸로 들어오면 자동 교환.
  let swapNote = ""
  if (vA.enforceDate && vB.enforceDate && vA.enforceDate > vB.enforceDate) {
    ;[vA, vB] = [vB, vA]
    ;[sideA, sideB] = [sideB, sideA]
    swapNote = "ℹ A/B 시점이 역순이라 자동 교환했습니다(A=구, B=신)."
  }

  const header = [
    "신구 조문 단어단위 기계 diff — 해석 공리 ①(신구 나란히 대조)·②(개정규정=문구단위)의 기계화",
    `법령: ${vB.lawTitle || vA.lawTitle || lawName || "?"} / 대상: ${jo}${hang ? ` ${hang}` : ""}`,
    `[구] 시행 ${vA.enforceDate ? formatYmd(vA.enforceDate) : "?"} (MST ${sideA.mst}) ↔ [신] 시행 ${vB.enforceDate ? formatYmd(vB.enforceDate) : "?"} (MST ${sideB.mst})`,
  ]
  if (swapNote) header.push(swapNote)
  // v0.21.0(#G2) — 두 시행본이 다른 법령으로 해소되면(교차법령 대조) diff 자체가 무의미하므로 최상단 경고 + 판정 신뢰금지.
  const crossLaw = !!vA.lawTitle && !!vB.lawTitle && lawNameKey(vA.lawTitle) !== lawNameKey(vB.lawTitle)
  if (crossLaw) {
    header.unshift(
      `⚠⚠ 교차법령 대조 감지: [구]=${vA.lawTitle} vs [신]=${vB.lawTitle} — 같은 법령이 아님. lawName·mstA/mstB를 재지정하라.`,
    )
  }

  if (vA.text === null && vB.text === null) {
    return notFoundResponse(`${jo} 본문을 두 시행본 모두에서 찾지 못했습니다.`, [
      "jo 표기를 법령 그대로 맞추세요(예: '제26조의8').",
      "get_law_article로 각 시점 본문 존재를 먼저 확인하세요.",
    ], { toolName: "diff_article_versions" })
  }
  if (vA.text === null || vB.text === null) {
    const kind = vA.text === null ? "신설" : "삭제"
    const body = vA.text === null ? vB.text : vA.text
    return textResponse(truncate([
      ...header,
      "",
      `판정: 조문 전체 ${kind} — ${kind === "신설" ? "[구]에 없고 [신]에만 존재" : "[구]에만 있고 [신]에서 삭제"}.`,
      "⚠ 신설·삭제 시점과 적용시기는 get_law_addenda(부칙)·get_law_revision_text(개정문)로 확정하라.",
      "",
      "── 존재하는 쪽 본문(발췌) ──",
      truncate(String(body), 3000),
    ].join("\n"), 12000))
  }

  let textA = vA.text
  let textB = vB.text
  let hangNote = ""
  if (hang) {
    const hA = sliceHangBlock(textA, hang)
    const hB = sliceHangBlock(textB, hang)
    if (hA.found && hB.found) {
      textA = hA.text
      textB = hB.text
    } else {
      hangNote = `⚠ ${hang} 블록을 ${hA.found ? "[신]" : hB.found ? "[구]" : "양쪽"}에서 못 찾아 조문 전체를 대조했습니다(항 신설·삭제 가능성 — 부칙 확인).`
    }
  }

  const diff = diffArticleTexts(textA, textB)
  const lines = [...header]
  if (nameFallbackNote) lines.push(nameFallbackNote)
  if (hangNote) lines.push(hangNote)
  lines.push("")

  // v0.21.0(#G2) — 교차법령이면 아래 판정(변경 없음/실질변경 등)은 신뢰 금지로 강등.
  if (crossLaw) {
    lines.push("⚠ 교차법령 대조 — 아래 판정(변경 없음/실질변경 등)은 신뢰하지 마라. 같은 법령의 신·구 시행본으로 재지정 후 재판정.", "")
  }

  if (diff.identical) {
    lines.push(`✅ 변경 없음 — 이 두 시행본 사이에 ${jo}${hang ? ` ${hang}` : ""} 문구 개정 없음. (이 구간 개정 부칙은 이 문구와 무관하다는 적극 신호)`)
    return textResponse(lines.join("\n"))
  }

  const counts = { substantive: 0, cosmetic: 0, renumbering: 0 } as Record<ChangeKind, number>
  diff.hunks.forEach((h) => { counts[h.kind]++ })
  lines.push(`판정: ${DIFF_KIND_LABEL[diff.verdict as ChangeKind]} (hunk ${diff.hunks.length}건 — 실질 ${counts.substantive} / 자구 ${counts.cosmetic} / 번호 ${counts.renumbering})`)
  if (diff.fallbackNote) lines.push(`ℹ ${diff.fallbackNote}`)
  lines.push("")

  const maxHunks = args.full === true ? 40 : 12
  diff.hunks.slice(0, maxHunks).forEach((h, i) => {
    lines.push(`#${i + 1} [${DIFF_KIND_LABEL[h.kind]}]`)
    lines.push(`  …${h.contextBefore} 【삭제: ${truncate(h.removed, 600) || "(없음)"}】【신설: ${truncate(h.added, 600) || "(없음)"}】 ${h.contextAfter}…`)
  })
  if (diff.hunks.length > maxHunks) lines.push(`(외 ${diff.hunks.length - maxHunks}건 — full=true로 전체 표시)`)
  lines.push(
    "",
    "⚠ 위는 기계적 텍스트 대조다(자동 단정 아님). 각 변경 문구가 '어느 개정령' 소관인지는 get_law_revision_text(개정문 '…를 …로 한다')·get_law_addenda(부칙)로 귀속을 확정한 뒤 단정하라. " + COMPANION_NOTICE,
  )
  return textResponse(truncate(lines.join("\n"), args.full === true ? 30000 : 12000))
}

// ── v0.10.0: research_taxlaw_topic ──────────────────────────────────────────
// 체인 매크로: 검색 → 관련성 상위 K건 본문 full+연도검증 첨부를 1콜로(다턴 왕복 절감).

interface ResearchTopicArgs {
  query?: unknown
  targetYear?: unknown
  topK?: unknown
  docType?: unknown
  taxLawCode?: unknown
  fromDate?: unknown
  toDate?: unknown
  full?: unknown
}

// v0.21.0(#W-1) — 이미 회수된 상세(detail)만으로 assessDoctrineValidity(순수함수·네트워크 0)를 돌려
//   픽 블록 말미에 붙일 압축 1~2줄을 만든다. formatAssessment 전체(토큰 과다)는 붙이지 않는다:
//   1줄 = [유효성 <최종라벨>] <한줄사유(최고심각도 신호)>, valid_current가 아니면 최상위 next-action 1줄만 추가.
function compactValidityLine(
  id: string,
  dcm: TaxlawDcm,
  detail: TaxlawDetailData["ASIQTB002PR01"],
  targetYear: number,
): string {
  try {
    const relatedLaws = (detail.dcmRltnStttList || [])
      .map((it) => cleanText(it.ntstTextNm))
      .filter(Boolean)
      .join(", ")
    const bodyText = detailTextFromHtmlList(detail.dcmHwpEditorDVOList)
    const gist = cleanText(dcm.ntstDcmGistCntn || dcm.GIST_CNTN)
    const answer = cleanText(dcm.ntstDcmCntn || dcm.CNTN)
    const productionDate = normalizeDate(dcm.ntstDcmRgtDt || dcm.DCM_RGT_DTM)
    const sourceForYearCheck = [gist, answer, bodyText].filter(Boolean).join("\n\n")
    if (!sourceForYearCheck && !relatedLaws) return "" // 판정 근거 없음 — 침묵(첨부 실패 케이스)
    const yearCheck = checkYearApplicability({
      bodyText: sourceForYearCheck,
      targetYear,
      metadataCitations: relatedLaws,
      productionDate,
    })
    const citedArticles = extractLawArticleRefs([gist, answer, bodyText, relatedLaws].filter(Boolean).join("\n"))
    const meta: DoctrineMeta = {
      id: dcm.ntstDcmId || id,
      title: cleanText(dcm.ntstDcmTtl || dcm.TTL),
      docNumber: cleanText(dcm.ntstDcmDscmCntn || dcm.NTST_DCM_DSCM_CNTN),
      productionDate,
      type: dcm.ntstDcmClNm || dcm.NTST_DCM_CL_NM || docLabel(dcm.ntstDcmClCd || dcm.NTST_DCM_CL_CD),
      taxLawCode: dcm.ntstTlawClCd || "",
      relatedLawsMeta: relatedLaws,
    }
    const a = assessDoctrineValidity({ meta, yearCheck, citedArticles, targetYear, bodyText: sourceForYearCheck })
    // 한 줄 사유: 최고 심각도 신호 메시지(없으면 자동분류 라벨), 공백 정규화 후 110자 캡.
    const rank: Record<DoctrineSignal["severity"], number> = { high: 0, warn: 1, info: 2, ok: 3 }
    const top = [...a.signals].sort((x, y) => rank[x.severity] - rank[y.severity])[0]
    const reason = (top ? top.message : a.yearCheck.classificationLabel).replace(/\s+/g, " ").slice(0, 110)
    const out = [`[유효성 ${a.finalLabel}] ${reason}`]
    if (a.finalValidity !== "valid_current" && a.nextActions.length) {
      const na = a.nextActions[0]
      out.push(`   → 다음(${na.priority}): ${na.tool}(${JSON.stringify(na.args)}) — ${na.purpose}`)
    }
    return out.join("\n")
  } catch {
    return "" // 채점 실패는 본문 첨부를 막지 않는다(가용성 우선)
  }
}

export async function researchTaxlawTopic(args: ResearchTopicArgs): Promise<ToolResponse> {
  const query = requireString("query", args.query)
  if (args.targetYear !== undefined) validateYear(args.targetYear)
  const targetYear = typeof args.targetYear === "number" ? args.targetYear : undefined
  const topK = asPositiveInt(args.topK, 2, 3)
  validateDateRange(args.fromDate, args.toDate)
  const searchArgs = {
    query,
    docType: args.docType || "all",
    display: 20,
    taxLawCode: args.taxLawCode,
    fromDate: args.fromDate,
    toDate: args.toDate,
  } as DocumentSearchArgs

  const codes = documentCodes(searchArgs.docType, "all")
  const groups = splitDocumentCodes(codes)
  // v0.20.0(#8) — 검색+dedupe를 헬퍼로 추출해 복합어 분해 재시도(형제 함수 searchTaxlawDocuments와 동일 패턴)를 매크로에도 부여.
  const searchOnce = async (q: string): Promise<TaxlawDcm[]> => {
    const settled = await Promise.allSettled(groups.map((group) => searchDocumentGroup(group, { ...searchArgs, query: q })))
    const results = settled
      .filter((s): s is PromiseFulfilledResult<{ group: "question" | "precedent"; codes: string[]; result: TaxlawSearchData["ASIPDI002PR01"] }> => s.status === "fulfilled")
      .map((s) => s.value)
    if (results.length === 0) {
      throw settled.find((s) => s.status === "rejected")?.reason ?? new TaxlawMcpError("Taxlaw document search failed.", ErrorCodes.API_ERROR)
    }
    const rawItems = results
      .flatMap((entry) => (entry.result.body || []).map((row) => row.dcm).filter((d): d is TaxlawDcm => !!d))
      .sort((a, b) => documentDateValue(b) - documentDateValue(a))
    return uniqueDocuments(rawItems).items
  }
  let uniqueItems = await searchOnce(query)
  if (uniqueItems.length === 0) {
    for (const rq of buildRetryQueries(query)) {
      try {
        const retried = await searchOnce(rq)
        if (retried.length) { uniqueItems = retried; break }
      } catch { /* 다음 분해 후보 시도 */ }
    }
  }
  if (uniqueItems.length === 0) {
    return notFoundResponse(`'${query}' 검색 결과 없음(복합어 분해 재시도 포함).`, [
      "docType·taxLawCode 필터를 풀거나 키워드를 1~2개 핵심 단어로 축소.",
      "search_taxlaw_all(통합검색)로 컬렉션을 넓혀 재시도.",
    ], { toolName: "research_taxlaw_topic" })
  }

  // 관련성(query 토큰 매칭률) 우선, 동률이면 최신순으로 본문 첨부 대상 선정.
  const scored = uniqueItems.map((item) => {
    const haystack = [cleanText(item.TTL), cleanText(item.GIST_CNTN || item.CNTN || ""), cleanText(item.FILE_CN || "")].join(" ")
    return { item, ratio: judgeRelevance(query, haystack).matchedRatio }
  })
  scored.sort((x, y) => y.ratio - x.ratio || documentDateValue(y.item) - documentDateValue(x.item))
  const picks = scored.slice(0, topK)

  const details = await mapWithConcurrency(picks, 2, async ({ item }) => {
    const id = normalizeDetailId(String(item.DOC_ID || item.DOCID || ""))
    const code = String(item.NTST_DCM_CL_CD || "").padStart(2, "0")
    const referer = refererForDoc(code, id)
    try {
      const data = await postTaxlawAction<TaxlawDetailData>("ASIQTB002PR01", { dcmDVO: { ntstDcmId: id } }, referer)
      const detail = data.ASIQTB002PR01
      if (!detail.dcmDVO) return `[첨부 실패] ${id} — 상세 응답에 본문 없음. get_taxlaw_document_text로 개별 조회.`
      // v0.27.4 — 재절단 금지. cap을 formatDocumentDetail로 넘겨 내부 budgetedJoin이
      //   안전 경고(연도검증·구조개편·통칙)를 먼저 확보하게 한다.
      const body = formatDocumentDetail(id, detail.dcmDVO, detail, true, referer, targetYear, args.full === true ? 20000 : 9000)
      // v0.27.4 — isFull=true 전제가 깨지는 구간 보정. detectHoldingTruncation은 isFull이면
      //   '전문이 있으니 절단 경고 불필요'로 침묵하는데, 이 매크로는 그 뒤 cap으로 실제로 자른다.
      //   실측: 첨부에 주문이 없는데 결론부 경고도 없었다 → 잘린 경우에만 조건부 강경고를 덧붙인다.
      const cut = /\[truncated to/.test(body)
      const holdingWarn = cut && (PRECEDENT_CODES.has(code) || QUESTION_CODES.has(code))
        ? `\n⚠ 이 첨부는 출력 상한으로 잘렸습니다 — ${PRECEDENT_CODES.has(code) ? "주문·판단(결론부)" : "회신 결론부"}이 누락됐을 수 있습니다. 결론·분류를 인용하기 전 get_taxlaw_document_text(id="${id}", full=true)로 개별 재조회하세요(요지만으로 단정 금지 — 요지≠holding).`
        : ""
      // v0.21.0(#W-1) — targetYear 지정 시 픽별 유효성 자동 채점 1~2줄 첨부(추가 네트워크 0, 이미 회수한 detail 재사용).
      const validity = targetYear !== undefined ? compactValidityLine(id, detail.dcmDVO, detail, targetYear) : ""
      return (validity ? `${body}\n${validity}` : body) + holdingWarn
    } catch (error) {
      return `[첨부 실패] ${id} — ${error instanceof Error ? error.message : String(error)}. get_taxlaw_document_text로 개별 조회.`
    }
  })

  const lines = [
    "research_taxlaw_topic — 검색 + 본문(full) + 연도검증 1콜 합본(체인 매크로)",
    `검색어: ${query} / docType: ${String(searchArgs.docType)} / targetYear: ${targetYear ?? "미지정 ⚠(귀속연도 있으면 지정 권장)"} / 본문 첨부 ${picks.length}건(관련성 상위)`,
    "⚠ 첨부 본문이 [truncated]로 잘렸으면 결론 인용 전 get_taxlaw_document_text(id, full=true)로 개별 재조회. " + COMPANION_NOTICE,
    "",
    `── 회수 목록(중복 제거 후 상위 ${Math.min(uniqueItems.length, 10)}건 메타 — 전체는 search_taxlaw_documents) ──`,
  ]
  uniqueItems.slice(0, 10).forEach((it) => lines.push(formatDocumentSearchItem(it, query, args.taxLawCode as string | undefined, false), ""))
  details.forEach((d, i) => {
    lines.push(`━━ 첨부 #${i + 1}/${picks.length} (query 토큰 매칭률 ${Math.round(picks[i].ratio * 100)}%) ━━`, d, "")
  })
  return textResponse(truncate(lines.join("\n"), 50000))
}

async function listTaxlawBasicRulingLaws(args: BasicRulingLawArgs): Promise<ToolResponse> {
  const data = await postTaxlawAction<BasicRulingData>("ASISTD001MR01", {}, "/st/USESTD001M.do")
  const query = cleanText(args.query).toLowerCase()
  const laws = (data.ASISTD001MR01?.bscExrDVOList || [])
    .filter((item) => !query || cleanText(item.ntstNm).toLowerCase().includes(query))

  if (laws.length === 0) {
    return notFoundResponse(
      `기본통칙 법령 목록에서 '${args.query || "(전체)"}' 결과가 없습니다.`,
      ["법령명에서 가운뎃점/공백을 제거하거나 짧은 키워드(예: '법인세')로 재시도하세요."],
      { toolName: "list_taxlaw_basic_ruling_laws" },
    )
  }

  const lines = [
    "국세법령정보시스템 기본통칙 법령 목록",
    `출처: ${TAXLAW_BASE}/st/USESTD001M.do`,
    "",
  ]
  laws.forEach((law) => lines.push(`[${law.ntstBscId || "N/A"}] ${cleanText(law.ntstNm) || "N/A"}`))
  lines.push("", "상세: get_taxlaw_basic_ruling_text의 lawId에 위 ID를 사용하세요.")
  return textResponse(lines.join("\n"))
}

async function getLatestBasicRulingYear(lawId: string): Promise<string> {
  const data = await postTaxlawAction<BasicRulingData>(
    "ASISTD001MR03",
    { ntstBscId: lawId },
    `/st/USESTD002M.do?ntstBscId=${encodeURIComponent(lawId)}`,
  )
  const year = data.ASISTD001MR03?.bscExrDVOList?.map((item) => item.rgtYr).find(Boolean)
  if (!year) throw new TaxlawMcpError(`기본통칙 연도 목록을 찾을 수 없습니다: ${lawId}`, ErrorCodes.NOT_FOUND)
  return year
}

async function getTaxlawBasicRulingText(args: BasicRulingTextArgs): Promise<ToolResponse> {
  const lawId = requireString("lawId", args.lawId)
  validateYear(args.year)
  const year = args.year || await getLatestBasicRulingYear(lawId)
  const display = asPositiveInt(args.display, 30, 200)
  const data = await postTaxlawAction<BasicRulingData>(
    "ASISTD001MR02",
    { ntstBscId: lawId, rgtYr: year },
    `/st/USESTD002M.do?ntstBscId=${encodeURIComponent(lawId)}`,
  )

  const rawQuery = cleanText(args.query)
  const queryTokens = tokenizeQuery(rawQuery)
  const allItems = [
    ...(data.ASISTD001MR02?.bscExrDVOList || []),
    ...(data.ASISTD001MR02?.bscExrDVOArList || []),
  ]
  const textItems = allItems
    .filter((item) => item.lawClCd === "5" || cleanText(htmlToText(item.ntstTextCntn || "")))
    .filter((item) => {
      if (queryTokens.length === 0) return true
      const haystack = `${cleanText(item.ntstTextNm)} ${cleanText(htmlToText(item.ntstTextCntn || ""))}`
      return matchesAllTokens(haystack, queryTokens)
    })

  if (textItems.length === 0) {
    return notFoundResponse(`기본통칙 ${lawId}/${year}에서 '${args.query || "(전체)"}' 항목을 찾을 수 없습니다.`, [
      "list_taxlaw_basic_ruling_laws로 lawId를 확인하세요.",
      "year를 비우면 최신 연도로 조회합니다.",
      "검색어를 여러 토큰으로 분리하고 핵심 키워드만 남겨 재시도하세요(본 도구는 공백/가운뎃점을 토큰화해 AND 매칭).",
      "통칙 키워드 매칭이 실패하면 search_taxlaw_all에서 기본통칙 컬렉션을 함께 회수합니다(statute 컬렉션에 통칙 단편이 포함).",
    ], { toolName: "get_taxlaw_basic_ruling_text" })
  }

  const shown = args.full ? textItems : textItems.slice(0, display)
  const lines = [
    `국세법령정보시스템 기본통칙 본문`,
    `출처: ${TAXLAW_BASE}/st/USESTD002M.do?ntstBscId=${encodeURIComponent(lawId)}`,
    `lawId: ${lawId} / year: ${year} / 검색어: ${args.query || "(전체)"}`,
    `총 ${textItems.length.toLocaleString()}개 중 ${shown.length.toLocaleString()}개 표시`,
    "",
  ]

  const verbose = args.verbose !== false
  for (const item of shown) {
    const body = htmlToText(item.ntstTextCntn || "")
    lines.push(`[${item.ntstExrBaseSn || "N/A"}] ${cleanText(item.ntstTextNm) || "N/A"}`)
    if (verbose && body) lines.push(truncate(body, args.full ? 3000 : 1200))
    lines.push("")
  }
  if (!args.full && textItems.length > shown.length) {
    lines.push(`더 많은 항목이 있습니다. display를 늘리거나 full=true로 재조회하세요.`)
  }
  return textResponse(truncate(lines.join("\n"), args.full ? 50000 : 30000))
}

function formKinds(raw: unknown): FormKind[] {
  const kind = String(raw || "all")
  const aliases: Record<string, FormKind> = {
    all_forms: "all_forms",
    annex: "annex",
    form: "legal_form",
    legal_form: "legal_form",
    instruction_form: "instruction_form",
    favorite_form: "favorite_form",
  }
  if (kind === "all") return ["annex", "legal_form", "instruction_form", "favorite_form"]
  const normalized = aliases[kind]
  if (!normalized) throw new TaxlawMcpError(`Unknown kind: ${kind}`, ErrorCodes.INVALID_PARAM)
  return [normalized]
}

function formKindLabel(kind: FormKind): string {
  return {
    all_forms: "전체 서식",
    annex: "별표",
    legal_form: "법령서식",
    instruction_form: "훈령서식",
    favorite_form: "자주찾는서식",
  }[kind]
}

async function searchFormsKind(kind: FormKind, args: FormsSearchArgs): Promise<{ kind: FormKind; result: FormSearchResult }> {
  const pageIndex = asPositiveInt(args.page, 1)
  const recordCountPerPage = asPositiveInt(args.display, 20, 50)
  let actionId = ""
  let referer = ""
  let params: AnyRecord = {}

  if (kind === "all_forms") {
    actionId = "ASIAFE001MR01"
    referer = "/af/USEAFE001M.do"
    params = { searchFrmlNm: args.query || "", pageIndex, recordCountPerPage }
  } else if (kind === "annex" || kind === "legal_form") {
    actionId = kind === "annex" ? "ASIAFA001MR01" : "ASIAFB001MR01"
    referer = kind === "annex" ? "/af/USEAFA001M.do" : "/af/USEAFB001M.do"
    params = {
      searchFrmlNm: args.query || "",
      searchNtstBscId: args.lawId || "stttAll",
      pageIndex,
      recordCountPerPage,
      srtFeld: "btn_sortPmgDt",
      srtMthd: "desc",
    }
  } else if (kind === "instruction_form") {
    actionId = "ASIAFC001MR01"
    referer = "/af/USEAFC001M.do"
    params = {
      searchNtarTlawClCd: "all",
      searchFrmlNm: args.query || "",
      pageIndex,
      recordCountPerPage,
      srtFeld: "btn_sortPmgDt",
      srtMthd: "desc",
    }
  } else {
    actionId = "ASIAFD001MR01"
    referer = "/af/USEAFD001M.do"
    params = {
      searchBkmrTlawClCd: "all",
      searchFrmlNm: args.query || "",
      ntstBkmrFrmlClCd: "10",
      pageIndex,
      recordCountPerPage,
    }
  }

  const data = await postTaxlawAction<FormsData>(actionId, params, referer)
  const result = data[actionId as keyof FormsData] as FormSearchResult | undefined
  return { kind, result: result || {} }
}

function formResultList(kind: FormKind, result: FormSearchResult): FormItem[] {
  if (kind === "all_forms") return result.allFrmlDVOList || []
  if (kind === "annex") return result.atDVOList || []
  if (kind === "legal_form") return result.stttFrmlDVOList || []
  if (kind === "instruction_form") return result.innsFrmlDVOList || []
  return result.bkmrFrmlDVOList || []
}

function formDetailUrl(item: FormItem): string {
  const params = new URLSearchParams()
  const ntstBscId = item.ntstBscId
  const ntstBrkdId = item.ntstBrkdId
  const ntstAtFrmlSn = item.ntstAtFrmlSn
  const ntarBscId = item.ntarBscId
  const ntarBrkdId = item.ntarBrkdId
  const ntarFrmlNo = item.ntarFrmlNo

  if (ntstBscId || ntstBrkdId || ntstAtFrmlSn) {
    if (ntstBscId) params.set("ntstBscId", ntstBscId)
    if (ntstBrkdId) params.set("ntstBrkdId", ntstBrkdId)
    if (ntstAtFrmlSn) params.set("ntstAtFrmlSn", String(ntstAtFrmlSn))
  } else {
    if (ntarBscId) params.set("ntarBscId", ntarBscId)
    if (ntarBrkdId) params.set("ntarBrkdId", ntarBrkdId)
    if (ntarFrmlNo) params.set("ntarFrmlNo", ntarFrmlNo)
    if (item.ntstAtFrmlClCd) params.set("ntstAtFrmlClCd", item.ntstAtFrmlClCd)
  }
  return `${TAXLAW_BASE}/af/USEAFA002P.do${params.toString() ? `?${params.toString()}` : ""}`
}

function formatFormItem(kind: FormKind, item: FormItem): string {
  const id = [
    item.ntstBscId || item.ntarBscId,
    item.ntstBrkdId || item.ntarBrkdId,
    item.ntstAtFrmlSn || item.ntarFrmlSn || item.ntarFrmlNo,
  ].filter(Boolean).join("_") || "N/A"
  const name = cleanText(item.ntstAtFrmlNm || item.ntarFrmlNm || item.frmlNm)
  const lawName = cleanText(item.ntstNm || item.ntarNm || item.ntstSjtClNm)
  const system = cleanText(item.ntstSysClCd || item.ntstClNm || item.stttInfpClCd)
  const date = normalizeDate(item.ntstPmgDt || item.ntarPmgDt)
  const detail = item.ntstBkmrFrmlDetailClNm ? ` / 상세분류: ${cleanText(item.ntstBkmrFrmlDetailClNm)}` : ""
  const lines = [
    `[${id}] ${name || "N/A"}`,
    `  종류: ${formKindLabel(kind)} / 법령·규칙: ${lawName || "N/A"} / 체계: ${system || "N/A"}${detail}`,
    `  공포일자: ${date} / 파일ID: ${item.fleId || "N/A"}`,
    `  상세URL: ${formDetailUrl(item)}`,
  ]
  if (item.fleId) lines.push(`  다운로드 힌트: ${TAXLAW_BASE}/downloadFile.do?fleId=${encodeURIComponent(item.fleId)}`)
  return lines.join("\n")
}

async function searchTaxlawForms(args: FormsSearchArgs): Promise<ToolResponse> {
  const kinds = formKinds(args.kind)
  const results = await Promise.all(kinds.map((entry) => searchFormsKind(entry, args)))
  const total = results.reduce((sum, entry) => sum + Number(entry.result.recordCount || 0), 0)

  if (total === 0) {
    return notFoundResponse(
      `국세법령정보시스템 별표/서식 '${args.query || "(전체)"}' 검색 결과가 없습니다.`,
      ["kind를 'all'로 두거나 'annex'/'legal_form'/'instruction_form' 등으로 좁혀 재시도하세요."],
      { toolName: "search_taxlaw_forms" },
    )
  }

  const lines = [
    "국세법령정보시스템 별표/서식 검색 결과",
    `출처: ${results.map((entry) => `${TAXLAW_BASE}${SITE_MENU_ACTIONS.find((menu) => menu.highLevelTool?.includes(`kind=${entry.kind}`))?.path || ""}`).filter(Boolean).join(", ") || `${TAXLAW_BASE}/af`}`,
    `검색어: ${args.query || "(전체)"} / 종류: ${kinds.map(formKindLabel).join(", ")} / 총 ${total.toLocaleString()}건`,
    "",
  ]
  for (const entry of results) {
    const list = formResultList(entry.kind, entry.result)
    lines.push(`## ${formKindLabel(entry.kind)}: ${Number(entry.result.recordCount || 0).toLocaleString()}건`)
    if (list.length === 0) {
      lines.push("[NOT_FOUND] 표시 가능한 결과가 없습니다.", "")
      continue
    }
    list.forEach((item) => lines.push(formatFormItem(entry.kind, item), ""))
  }
  return textResponse(truncate(lines.join("\n"), 50000))
}

async function enrichPublicationItem(item: PublicationItem): Promise<PublicationItem> {
  if (item.fleId || !item.ntstPlcnBkId) return item

  try {
    const data = await postTaxlawAction<PublicationData>(
      "ASIELA002MR02",
      { ntstPlcnBkId: item.ntstPlcnBkId },
      `/el/USEELA002M.do?ntstPlcnBkId=${encodeURIComponent(item.ntstPlcnBkId)}`,
    )
    const detail = data.ASIELA002MR02?.plcnBkDVOList?.[0]
    if (!detail) return item

    const merged: Record<string, unknown> = { ...item }
    for (const [key, value] of Object.entries(detail)) {
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        merged[key] = value
      }
    }
    return merged as PublicationItem
  } catch {
    return item
  }
}

function formatPublicationItem(item: PublicationItem): string {
  const lines = [
    `[${item.ntstPlcnBkId || "N/A"}] ${cleanText(item.ntstPlcnBkTtl) || "N/A"}`,
    `  분야: ${cleanText(item.ntstSjtClNm) || item.ntstSjtClCd || "N/A"} / 담당부서: ${cleanText(item.ntstJrsdDnoNm) || "N/A"}`,
    `  발간일자: ${normalizeDate(item.plcnDt)} / 파일ID: ${item.fleId || "N/A"} / 파일순번: ${item.fleSn ?? "N/A"} / 전자책파일ID: ${item.elctBkFleId || "N/A"}`,
  ]
  if (item.fleId) {
    const fleSn = item.fleSn !== undefined ? `&fleSn=${encodeURIComponent(String(item.fleSn))}` : ""
    lines.push(`  다운로드 힌트: ${TAXLAW_BASE}/downloadFile.do?fleId=${encodeURIComponent(item.fleId)}${fleSn}`)
  }
  if (item.elctBkFleId) {
    const fleSn = item.elctBkFleSn !== undefined ? `&fleSn=${encodeURIComponent(String(item.elctBkFleSn))}` : ""
    lines.push(`  전자책 다운로드 힌트: ${TAXLAW_BASE}/downloadFile.do?fleId=${encodeURIComponent(item.elctBkFleId)}${fleSn}`)
  }
  if (item.ntstPlcnBkDscmCntn) lines.push(`  설명: ${truncate(cleanText(item.ntstPlcnBkDscmCntn), 500)}`)
  return lines.join("\n")
}

async function searchTaxlawPublications(args: PublicationSearchArgs): Promise<ToolResponse> {
  const params = {
    ntarClCd: "01",
    ntstSjtClCd: args.categoryCode || "All",
    searchKeyword: args.query || "",
    pageIndex: asPositiveInt(args.page, 1),
    recordCountPerPage: asPositiveInt(args.display, 20, 50),
  }
  const data = await postTaxlawAction<PublicationData>("ASIELA001MR01", params, "/el/USEELA001M.do")
  const result = data.ASIELA001MR01
  const list = result?.plcnBkDVOList || []
  const total = Number(result?.recordCount || 0)

  if (total === 0 || list.length === 0) {
    return notFoundResponse(`국세법령정보시스템 발간책자 '${args.query || "(전체)"}' 검색 결과가 없습니다.`, [
      "list_taxlaw_publication_categories로 분야 코드를 확인하세요.",
      "query를 비우면 최신 발간책자 목록을 볼 수 있습니다.",
    ], { toolName: "search_taxlaw_publications" })
  }

  const enrichedList = await mapWithConcurrency(list, 8, enrichPublicationItem)
  const lines = [
    "국세법령정보시스템 발간책자 검색 결과",
    `출처: ${TAXLAW_BASE}/el/USEELA001M.do`,
    `검색어: ${args.query || "(전체)"} / 분야: ${args.categoryCode || "All"} / 총 ${total.toLocaleString()}건`,
    "",
  ]
  enrichedList.forEach((item) => lines.push(formatPublicationItem(item), ""))
  return textResponse(truncate(lines.join("\n"), 30000))
}

async function listTaxlawPublicationCategories(): Promise<ToolResponse> {
  const data = await postTaxlawAction<PublicationData>("ASIELA001MR02", {}, "/el/USEELA001M.do")
  const list = (data.ASIELA001MR02?.plcnBkDVOList || [])
    .filter((item) => item.ntstSjtClNm && item.ntstSjtClNm !== "해당없음")

  if (list.length === 0) {
    return notFoundResponse("국세법령정보시스템 발간책자 분야 목록을 찾을 수 없습니다.")
  }

  const lines = [
    "국세법령정보시스템 발간책자 분야 코드",
    `출처: ${TAXLAW_BASE}/el/USEELA001M.do`,
    "",
  ]
  list.forEach((item) => lines.push(`[${item.ntstSjtClCd || "N/A"}] ${cleanText(item.ntstSjtClNm)}`))
  return textResponse(lines.join("\n"))
}

function formatUpjongRecord(r: UpjongRecord): string[] {
  const lines: string[] = []
  lines.push(`업종코드: ${r.upjong}`)
  if (r.note) lines.push(`세부설명: ${r.note}`)
  lines.push("업종코드 측 분류:")
  lines.push(...formatClassPath(r.up, "up"))
  lines.push("표준산업분류(KSIC) 측 매핑:")
  lines.push(...formatClassPath(r.ksic, "ksic"))
  return lines
}

function lookupUpjongCodeTool(args: UpjongLookupArgs): ToolResponse {
  const code = requireString("code", args.code)
  const r = findByUpjong(code)
  if (!r) {
    return notFoundResponse(`업종코드 ${code}을 DB에서 찾을 수 없습니다.`, [
      "코드를 다시 확인하거나 search_industry_by_keyword로 분류명으로 검색하세요.",
      "현행 업종코드 고시(국세청)와 DB 귀속연도가 다를 수 있습니다. upjong_db_info로 DB 신선도를 확인하세요.",
    ])
  }
  const info = upjongDbInfo()
  // v0.27.5(라이브 루프) — 업종코드:KSIC 1:N(실측 79종) 전건 노출. 종전엔 첫 건만 보여주고
  //   나머지 매핑의 존재조차 알리지 않아, 여러 KSIC 세세분류에 걸친 업종에서 §7①1호 목 판정이
  //   조용히 한쪽으로 굳어졌다(예: 143107 조광권자 → 7110만 노출, 7121·7122·7210·7290 소실).
  //   1:N 판정은 '레코드 수'가 아니라 '고유 KSIC 코드 수' 기준이어야 한다. 연계표 원본에 표기 흔들림으로
  //   같은 업종+같은 KSIC가 2행인 케이스가 있다(630702 지입: 49301이 "일반 화물 자동차 운송업"과
  //   "일반 화물자동차 운송업" 2행 + 49302 1행 = 3행). 레코드 수로 세면 "KSIC 3건"으로 부풀려진다.
  const all = findAllByUpjong(code)
  const _seenK = new Set([r.ksic?.code].filter(Boolean))
  const siblings = all.filter((x) => {
    const k = x.ksic?.code
    if (!k || _seenK.has(k)) return false
    _seenK.add(k); return true
  })
  const uniqKsic = new Set(all.map((x) => x.ksic?.code).filter(Boolean))
  const lines = [
    `업종코드↔KSIC 매핑 조회 결과 (DB 귀속연도: ${info.year ?? "N/A"})`,
    "출처: 국세청 '업종코드-표준산업분류 연계표'",
    ...(uniqKsic.size > 1
      ? [`⚠ 이 업종코드는 KSIC ${uniqKsic.size}건에 대응(1:N) — 아래는 대표 1건이며 나머지는 하단 '복수 매핑' 참조. 감면 업종 판정(조특 §6③·§7①1호)이 KSIC별로 갈릴 수 있으니 전건을 확인하라.`]
      : []),
    "",
    ...formatUpjongRecord(r),
    ...(siblings.length > 0
      ? ["", `── 복수 매핑(같은 업종코드의 다른 KSIC ${siblings.length}건) ──`,
         ...siblings.map((s) => `  KSIC ${s.ksic?.code} — ${s.ksic?.l5Name || s.ksic?.l4Name || "(명칭 없음)"}`)]
      : []),
    "",
    "주의: 본 결과는 내장 DB(국세청 연계표)에서 직접 인용한 것입니다. 추가 업종코드 변동·신설은 국세청 홈택스 업종코드 조회로 교차확인하세요.",
  ]
  return textResponse(lines.join("\n"))
}

function lookupKsicCodeTool(args: KsicLookupArgs): ToolResponse {
  const code = requireString("code", args.code)
  const records = findByKsic(code)
  if (records.length === 0) {
    return notFoundResponse(`KSIC ${code}에 매핑된 업종코드가 DB에 없습니다.`, [
      "KSIC 5자리 코드를 다시 확인하세요.",
      "search_industry_by_keyword로 분류명 키워드로 검색해보세요.",
    ])
  }
  const lines = [
    `KSIC ${code}에 매핑된 국세청 업종코드 (${records.length}건)`,
    "출처: 국세청 '업종코드-표준산업분류 연계표'",
    "",
  ]
  for (const r of records) {
    lines.push(...formatUpjongRecord(r), "")
  }
  return textResponse(truncate(lines.join("\n"), 30000))
}

function parseLevels(raw: unknown): ClassLevel[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const allowed: ClassLevel[] = ["l1", "l2", "l3", "l4", "l5"]
  const out: ClassLevel[] = []
  for (const v of raw) {
    if (typeof v === "string" && (allowed as string[]).includes(v)) out.push(v as ClassLevel)
  }
  return out.length > 0 ? out : undefined
}

function lookupKsicPrefixTool(args: KsicPrefixArgs): ToolResponse {
  const prefix = requireString("prefix", args.prefix)
  const limit = asPositiveInt(args.limit, 200, 500)
  const matches = findByKsicPrefix(prefix, limit)
  if (matches.length === 0) {
    return notFoundResponse(`KSIC prefix '${prefix}'에 매칭된 업종코드가 없습니다.`, [
      "1자리 영문(B/C/M…) 대분류, 2~5자리 숫자(중/소/세/세세분류) 형식.",
      "search_industry_by_keyword로 분류명 검색을 병행하세요.",
    ])
  }
  // 분류수준별 묶기
  const byLevel = new Map<string, UpjongRecord[]>()
  for (const m of matches) {
    const key = m.matchedLevel
    if (!byLevel.has(key)) byLevel.set(key, [])
    byLevel.get(key)!.push(m.record)
  }
  const lines = [
    `KSIC prefix 매칭 결과: '${prefix}' (${matches.length}건${matches.length >= limit ? " — 결과 잘림" : ""})`,
    `매칭 분류수준: ${[...byLevel.keys()].join(", ")}`,
    "",
  ]
  for (const m of matches.slice(0, 50)) {
    const r = m.record
    lines.push(
      `  ${r.upjong} | KSIC ${r.ksic.code ?? "-"} | ${r.ksic.l5Name ?? r.ksic.l4Name ?? r.ksic.l3Name ?? ""} (NTS: ${r.up.l5Name ?? r.up.l4Name ?? ""})`,
    )
  }
  if (matches.length > 50) lines.push(`  ... 외 ${matches.length - 50}건`)
  return textResponse(truncate(lines.join("\n"), 30000))
}

function searchIndustryByKeywordTool(args: IndustrySearchArgs): ToolResponse {
  const keyword = requireString("keyword", args.keyword)
  const limit = asPositiveInt(args.limit, 30, 100)
  const levels = parseLevels(args.levels) ?? ["l1", "l2", "l3", "l4", "l5"]
  const records = searchUpjongByKeyword(keyword, limit, levels)
  if (records.length === 0) {
    return notFoundResponse(`업종코드 DB에서 '${keyword}' 결과가 없습니다.`, [
      "검색어를 줄이거나 띄어쓰기/괄호를 다르게 시도하세요.",
      "법조문 인용 산업명 그대로(예: '기타 전문, 과학 및 기술 서비스업')를 입력해도 정규화 매칭이 적용됩니다.",
    ])
  }
  const lines = [
    `업종코드 DB 키워드 검색 결과: '${keyword}' (${records.length}건 표시)`,
    "",
  ]
  for (const r of records) {
    lines.push(...formatUpjongRecord(r), "")
  }
  return textResponse(truncate(lines.join("\n"), 30000))
}

function resolveIndustryClassTool(args: ResolveClassArgs): ToolResponse {
  const name = requireString("name", args.name)
  const levels = parseLevels(args.levels)
  const resolved = resolveClassName(name, levels)
  if (resolved.candidates.length === 0) {
    return notFoundResponse(`분류명 '${name}'에 일치하는 KSIC/업종코드 분류수준을 찾지 못했습니다.`, [
      "법조문 인용 표기를 그대로 시도하거나, 띄어쓰기·괄호 변형을 시도하세요.",
      "후보가 없으면 분류수준 식별 없이 사용자에게 추측 답변하지 말고, search_industry_by_keyword로 유사 키워드를 안내하세요.",
    ])
  }
  const lines = [
    `분류명 → KSIC/업종코드 분류수준 식별: '${name}'`,
    "",
    "후보 (해당 분류수준에서 정규화 일치):",
  ]
  for (const c of resolved.candidates) {
    lines.push(
      `  - ${c.side === "ksic" ? "KSIC" : "업종코드"} ${c.levelKr}` +
        (c.code ? ` ${c.code}` : "") +
        ` / 매칭 레코드 ${c.sampleRecords}건` +
        (c.sampleUpjongCodes.length > 0 ? ` / 예시 업종코드: ${c.sampleUpjongCodes.join(", ")}` : ""),
    )
  }
  lines.push(
    "",
    "활용: 법조문이 '대분류명/중분류명/소분류명' 중 어느 레벨을 가리키는지는 그 명칭이 해당 레벨에 존재하는지로 판단합니다. 같은 명칭이 여러 레벨에 등장하면 전후 문맥(괄호 내 제외 단서 등)으로 추가 확인하세요.",
  )
  return textResponse(lines.join("\n"))
}

function formatCreditCell(label: string, cell: CreditLookupResult["chojunggam"], hoLabel: string): string {
  if (!cell) return `${label}: 판정 불가(업종코드 미수록)`
  if (!cell.eligible) return `${label}: ✗ 비적격 (연계표에 ${hoLabel} 매핑 없음)`
  const ho = cell.ho.length ? cell.ho.join(", ") : "?"
  const note = cell.note ? ` / 비고: ${cell.note}` : ""
  return `${label}: ✅ 적격 — ${hoLabel} [${ho}]${note}`
}

function classifyCreditEligibilityTool(args: { code?: unknown }): ToolResponse {
  const code = requireString("code", args.code)
  const r = classifyCreditEligibility(code)
  const lines = [
    `창중감(§6③)·중특감(§7①1호) 업종 적격 판정`,
    `업종코드: ${r.upjong}`,
    `출처: ${r.source || "N/A"}${r.provisional ? " (provisional·미검증)" : ""}`,
    "",
  ]
  if (!r.found) {
    lines.push(
      `[NOT_FOUND] 업종코드 ${r.upjong}가 적격표에 없습니다.`,
      "→ 6자리 표기 확인 / lookup_upjong_code로 코드 실재 확인 / 연계표 미수록일 수 있으니 조특법 §6③·§7①1호 본문과 직접 대조.",
    )
    return textResponse(lines.join("\n"))
  }
  lines.push(
    formatCreditCell("창중감(조특법 §6③)", r.chojunggam, "6조3항 호"),
    formatCreditCell("중특감(조특법 §7①1호)", r.jungteukgam, "7조1항 호/목"),
  )
  if (r.sogiup) {
    lines.push(
      `소기업 매출한도(중기본법 시행령 별표3 기호 ${r.sogiup.bylho}): ${r.sogiup.eok}억원 — 직전 3년 평균매출 ≤ 한도면 소기업(§7 감면율 소기업 10/20/30% vs 중기업 5/15%·수도권 0%), 초과=중기업.`,
    )
  }
  lines.push(
    "",
    "⚠ provisional — 연계표 충실 전사값(미검증). 결론·신고 전 반드시 법령 교차확인:",
    "  · ★연도주의(표=2024 귀속 기준): §6 창중감은 2026.1.1 이후 창업 시 감면율 전면개편(청년 수도권75%·일반 수도권25% 등 4구간)·창업기한 2027.12.31 연장·감면세액 5억 한도(2024.12.31 신설). §7 중특감은 일몰 2028.12.31 연장이나 2026 목 글자 이동(수소발전 '두목' 신설→보안·임업·통관·자동차임대 한칸씩 밀림)·일반서적출판 중기업10% '마목' 신설. → 2025·2026 귀속·창업은 조특법 §6·§7 해당연도 본문 직접 확인(get_law_article year=YYYY).",
    "  · 자동차정비공장(§7터목)=자동차종합·소형자동차종합정비업만(조특칙§22) — 자동차전문정비업(예: 922202)은 ✗.",
    "  · 의료업=요양급여 비율·종합소득 요건 / 부동산임대·소비성서비스는 중소기업 자체 배제(조특령§2①). 농축수산임·발전업(신재생)은 §7 명시이나 비과세(소득세법§12)·전액면제(§66~68)·발전사업자 등록으로 갈림.",
    "  · 적격 표기라도 단서·규모(소기업 매출)·지역·창업요건·최저한세는 별도. 비적격 표기도 연계표 누락 가능 → 법령 확인.",
  )
  if (r.note) lines.push("", `참고: ${r.note}`)
  return textResponse(lines.join("\n"))
}

function classifyIndustryForArticleTool(args: ClassifyArticleArgs): ToolResponse {
  const industryName = requireString("industryName", args.industryName)
  const upjongCode = requireString("upjongCode", args.upjongCode)
  const excludeNames = Array.isArray(args.excludeNames)
    ? args.excludeNames.filter((s): s is string => typeof s === "string" && s.length > 0)
    : []
  const excludeLevels = parseLevels(args.excludeLevels)
  const result = classifyIndustryForArticle({ industryName, upjongCode, excludeNames, excludeLevels })
  const lines = [
    `법조문 산업명 ↔ 업종코드 판정`,
    `법조문 산업명: ${industryName}`,
    `제외 단서: ${excludeNames.length > 0 ? excludeNames.join(", ") : "(없음)"}`,
    `평가 업종코드: ${upjongCode}`,
    "",
  ]
  if (!result.found || !result.upjongRecord) {
    lines.push("업종코드를 DB에서 찾을 수 없어 판정 불가.")
    return textResponse(lines.join("\n"))
  }
  lines.push("업종코드 5단계 분류:")
  lines.push(...formatClassPath(result.upjongRecord.up, "up"))
  lines.push("표준산업분류(KSIC) 매핑:")
  lines.push(...formatClassPath(result.upjongRecord.ksic, "ksic"))
  lines.push("")
  lines.push("법조문 산업명 분류수준 후보:")
  if (result.industryResolution.candidates.length === 0) {
    lines.push("  (DB에서 일치하는 분류명 없음 → 표기 다를 가능성 또는 KSIC 외부 명칭)")
  } else {
    for (const c of result.industryResolution.candidates) {
      lines.push(
        `  - ${c.side === "ksic" ? "KSIC" : "업종코드"} ${c.levelKr}` + (c.code ? ` ${c.code}` : "") + ` (매칭 ${c.sampleRecords}건)`,
      )
    }
  }
  if (excludeNames.length > 0) {
    lines.push("")
    lines.push("제외 단서 분류수준 후보:")
    for (let i = 0; i < excludeNames.length; i++) {
      const er = result.excludeResolutions[i]
      lines.push(`  [${excludeNames[i]}]`)
      if (er.candidates.length === 0) {
        lines.push("    (DB에서 일치하는 분류명 없음)")
      } else {
        for (const c of er.candidates) {
          lines.push(
            `    - ${c.side === "ksic" ? "KSIC" : "업종코드"} ${c.levelKr}` + (c.code ? ` ${c.code}` : "") + ` (매칭 ${c.sampleRecords}건)`,
          )
        }
      }
    }
  }
  lines.push("")
  lines.push(`매칭된 레벨: ${result.matchedLevel ? `${result.matchedLevel.side === "ksic" ? "KSIC" : "업종코드"} ${CLASS_LEVEL_KR[result.matchedLevel.level]} ${result.matchedLevel.code ?? ""}` : "없음"}`)
  lines.push(`제외 적용 여부: ${result.excluded ? "예" : "아니오"}`)
  if (result.excludedBy.length > 0) {
    for (const e of result.excludedBy) {
      lines.push(`  - 제외 '${e.name}' (${e.side === "ksic" ? "KSIC" : "업종코드"} ${CLASS_LEVEL_KR[e.level]} ${e.code ?? ""})`)
    }
  }
  lines.push("")
  lines.push(`판정(verdict): ${result.verdict}`)
  lines.push("  match       = 법조문 산업명에 해당하고 제외 단서에 걸리지 않음")
  lines.push("  excluded    = 법조문 산업명에 해당하나 제외 단서에 걸림")
  lines.push("  out_of_scope= 본 업종코드는 법조문 산업명과 일치하는 분류 레벨이 없음")
  lines.push("  ambiguous   = 산업명을 DB에서 식별 불가 (표기 차이 등)")
  lines.push("")
  lines.push("판정 근거:")
  for (const r of result.reasoning) lines.push(`  - ${r}`)
  lines.push("")
  lines.push("동반 호출 필수: 본 판정은 KSIC 11차 연계표 기준입니다. 법조문 본문·부칙·시행일은 korean-law-mcp의 get_law_text로 직접 확인하고, 법조문 개정/부칙 관련 단서는 사용자에게 함께 보고하세요.")
  return textResponse(lines.join("\n"))
}

function upjongDbInfoTool(): ToolResponse {
  const info = upjongDbInfo()
  const lines = [
    "업종코드↔KSIC DB 정보",
    `생성 시각: ${info.generatedAt}`,
    `원본 CSV: ${info.source ?? "(none)"}`,
    `귀속연도: ${info.year ?? "N/A"}`,
    `레코드 수: ${info.count.toLocaleString()}`,
  ]
  return textResponse(lines.join("\n"))
}

export async function handleToolCall(name: string, args: unknown): Promise<ToolResponse> {
  try {
    const input = (args || {}) as AnyRecord
    if (name === "call_taxlaw_extra") {
      const sub = requireString("name", input.name)
      if (sub === "call_taxlaw_extra" || !HIDDEN_TOOL_NAMES.has(sub)) {
        throw new TaxlawMcpError(
          `'${sub}'는 call_taxlaw_extra 대상이 아닙니다. 대상: ${[...HIDDEN_TOOL_NAMES].join(", ")}`,
          ErrorCodes.INVALID_PARAM,
        )
      }
      return await handleToolCall(sub, input.args ?? {})
    }
    if (name === "verify_nts_citations") {
      return await verifyNtsCitations(input as { text?: string; maxCitations?: number; claims?: NtsClaim[] })
    }
    if (name === "compute_employment_credit") {
      // v0.20.0 — 내장 계산기 제거(계산 SSOT 단일화·검색/검증 MCP와 신뢰경계 분리). 계산 대신 라우팅만 반환.
      return textResponse(
        [
          "compute_employment_credit는 v0.20.0에서 제거되었습니다(계산 SSOT를 하나로 단일화).",
          "고용증대(§29의7)·통합고용(§29의8)·중소기업 사회보험료(§30의4) 공제·추징 계산은 외부 전용 계산기 SSOT(Python)를 사용하세요.",
          "이 MCP에서는 계산 대신 조문·단가·적용시기를 확인하세요:",
          "  · 단가·산식 원문: get_law_article(jo, full=true)  · 귀속연도별 적용본: build_application_timetable / trace_article_application",
          "⚠ 계산기가 자동 반영하지 않는 트랩은 별도 검토: 적용배제 문언(단가전환)·적용순서(중특감→사보→고용 3/2/1차)·§144 이월·통합고용 상시인원 절사방법(연도별 상이).",
        ].join("\n"),
      )
    }
    if (name === "search_taxlaw_all") {
      return await searchTaxlawAll(input as IntegratedSearchArgs)
    }
    if (name === "search_taxlaw_documents") {
      return await searchTaxlawDocuments(input as DocumentSearchArgs)
    }
    if (name === "get_taxlaw_document_text") {
      return await getTaxlawDocumentText(input as DocumentDetailArgs)
    }
    if (name === "get_taxlaw_document_by_number") {
      return await getTaxlawDocumentByNumber(input as DocumentNumberArgs)
    }
    if (name === "assess_doctrine_validity") {
      return await assessDoctrineValidityTool(input as AssessDoctrineArgs)
    }
    if (name === "get_taxlaw_hometax_counsel_text") {
      return await getTaxlawHometaxCounselText(input as HometaxCounselArgs)
    }
    if (name === "list_taxlaw_site_menus") {
      return listTaxlawSiteMenus(input as SiteMenuArgs)
    }
    if (name === "call_taxlaw_action") {
      return await callTaxlawAction(input as RawActionArgs)
    }
    if (name === "get_taxlaw_page_text") {
      return await getTaxlawPageText(input as TaxlawPageTextArgs)
    }
    if (name === "get_execution_standard") {
      return await getExecutionStandard(input as ExecStdArgs)
    }
    if (name === "get_law_revision_text") {
      return await getLawRevisionText(input as LawRevisionArgs)
    }
    if (name === "get_law_addenda") {
      return await getLawAddenda(input as LawAddendaArgs)
    }
    if (name === "trace_article_application") {
      return await traceArticleApplication(input as TraceArticleArgs)
    }
    if (name === "get_law_article") {
      return await getLawArticle(input as LawArticleArgs)
    }
    if (name === "build_application_timetable") {
      return await buildApplicationTimetable(input as TimetableArgs)
    }
    if (name === "diff_article_versions") {
      return await diffArticleVersionsTool(input as ArticleDiffArgs)
    }
    if (name === "research_taxlaw_topic") {
      return await researchTaxlawTopic(input as ResearchTopicArgs)
    }
    if (name === "search_taxlaw_interpretations") {
      return await searchTaxlawDocuments(input as DocumentSearchArgs, "reply")
    }
    if (name === "get_taxlaw_interpretation_text") {
      return await getTaxlawDocumentText({ ...input, docType: input.docType || "reply" } as DocumentDetailArgs)
    }
    if (name === "list_taxlaw_basic_ruling_laws") {
      return await listTaxlawBasicRulingLaws(input as BasicRulingLawArgs)
    }
    if (name === "get_taxlaw_basic_ruling_text") {
      return await getTaxlawBasicRulingText(input as BasicRulingTextArgs)
    }
    if (name === "search_taxlaw_forms") {
      return await searchTaxlawForms(input as FormsSearchArgs)
    }
    if (name === "search_taxlaw_publications") {
      return await searchTaxlawPublications(input as PublicationSearchArgs)
    }
    if (name === "list_taxlaw_publication_categories") {
      return await listTaxlawPublicationCategories()
    }
    if (name === "classify_credit_eligibility") {
      return classifyCreditEligibilityTool(input as { code?: unknown })
    }
    if (name === "lookup_upjong_code") {
      return lookupUpjongCodeTool(input as UpjongLookupArgs)
    }
    if (name === "lookup_ksic_code") {
      return lookupKsicCodeTool(input as KsicLookupArgs)
    }
    if (name === "lookup_ksic_prefix") {
      return lookupKsicPrefixTool(input as KsicPrefixArgs)
    }
    if (name === "search_industry_by_keyword") {
      return searchIndustryByKeywordTool(input as IndustrySearchArgs)
    }
    if (name === "resolve_industry_class") {
      return resolveIndustryClassTool(input as ResolveClassArgs)
    }
    if (name === "classify_industry_for_article") {
      return classifyIndustryForArticleTool(input as ClassifyArticleArgs)
    }
    if (name === "upjong_db_info") {
      return upjongDbInfoTool()
    }
    return textResponse(`[${ErrorCodes.INVALID_PARAM}] Unknown tool: ${name}`, true)
  } catch (error) {
    return formatToolError(error, name)
  }
}

const server = new Server(
  { name: "taxlaw-nts", version: VERSION },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: visibleTools() }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  // v0.21.0(#G14) — MCP 콜 1건 전체(재귀 call_taxlaw_extra 포함)를 하나의 시간예산으로 감싼다.
  //   진입점을 여기로 둬 handleToolCall 직접 호출(테스트)은 store 부재=무제한을 유지한다.
  const result = await runWithToolBudget(() => handleToolCall(name, args))
  return {
    content: result.content,
    isError: result.isError,
    structuredContent: result.structuredContent,
  }
})

async function main(): Promise<void> {
  const stderrWrite = (...args: unknown[]) => process.stderr.write(args.map(String).join(" ") + "\n")
  console.log = console.warn = console.info = console.debug = stderrWrite

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

if (process.env.TAXLAW_MCP_TEST_MODE !== "1") {
  main().catch((error) => {
    console.error("Server error:", error)
    process.exit(1)
  })
}
