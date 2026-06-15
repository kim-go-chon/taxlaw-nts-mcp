#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import {
  classifyIndustryForArticle,
  dbInfo as upjongDbInfo,
  findByKsic,
  findByKsicPrefix,
  findByUpjong,
  formatClassPath,
  resolveClassName,
  searchUpjongByKeyword,
  CLASS_LEVEL_KR,
  type ClassLevel,
  type UpjongRecord,
} from "./upjong.js"
import { checkYearApplicability, formatYearCheck, getRecentThresholdYears } from "./year-check.js"
import { extractLawArticleRefs, extractBasicRulingRefs, formatBasicRulingRef, type BasicRulingRef } from "./citation-extract.js"
import { assessDoctrineValidity, formatAssessment, type DoctrineMeta } from "./doctrine-assess.js"
import { detectPreRestructureCitations, formatRestructureHits } from "./restructure-map.js"
import {
  TAX_LAW_CODE_MAP,
  describeTaxLawCode,
  formatTaxLawCellCompact,
  formatTaxLawCodeHeader,
  taxLawCodeMatches,
  taxLawCodeReference,
} from "./tax-law-code-map.js"
import { buildRetryQueries, describeRetryAttempt } from "./query-retry.js"
import { diffArticleTexts, type ChangeKind } from "./text-diff.js"
import { computeEmploymentCredit, type EmpCreditArgs } from "./employment-credit.js"

const TAXLAW_BASE = "https://taxlaw.nts.go.kr"
// 법제처 국가법령정보 Open API(DRF). 부칙(시행일·적용례·경과조치)은 NTS DB에 노출되지 않아 이쪽에서 보완 조회한다.
const MOLEG_BASE = "https://www.law.go.kr"
const VERSION = "0.13.0"

// v0.9.11 — 도구 description마다 ~210자 반복하던 동반 호출 안내를 축약(~50자).
// 전체 워크플로는 INSTRUCTIONS 첫 단락 "korean-law-mcp(법제처 Open API)와 항상 짝으로 호출"에서 1회 안내.
const COMPANION_NOTICE =
  "⚠ korean-law-mcp(법제처) 동반 호출 필수 — 법령 본문·시행일은 그쪽이 1차."

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
const INSTRUCTIONS = `taxlaw-nts-mcp는 한국 국세법령정보시스템(NTS) 자료를 검색·조회한다. 세법·법령 질의에서 korean-law-mcp(법제처)와 짝으로 호출한다. 분담: 현행 조문·법원 판례 전문·행정규칙 현행본=korean-law 1차 / 해석례·기본통칙·시점본(year/efYd)·부칙·조문 diff·심판례 검색=본 MCP 1차. ⚠ 계산식이 든 조문(조특법 고용공제류 등)은 korean-law get_law_text가 수식을 무언 누락하므로 본 MCP get_law_article(full=true)을 반드시 동반.

[강제 절차 — 응답 내 ⚠ 무시 금지]
1. 후행 개정(get_law_article): "── 후행 개정 확인" 블록의 "본문이 변경"/"삭제됨"/"찾지 못함" → 결론(요건·단가·사후관리 등) 작성 전에 제시된 diff_article_versions(mstA/mstB) 또는 현행본 get_law_article(mst=현행MST, full=true) 1콜로 직접 확인. "공포-미시행(시행예정)" → 미래 귀속 결론 전 해당 시행본의 이 조문 변경 여부 확인. "대조에 실패" → 제시된 호출을 그대로 수행. 확인 비용은 1콜 — "별도 확인 필요" 류 hedge로 결론 대체 금지(검증깊이 미루기 금지).
2. 연도 검증: 특정 귀속연도 질문이면 get_taxlaw_document_text(targetYear=YYYY) 필수. 구법조문 기반 예규는 ⚠ 사문화 가능성 경고 동봉.
3. 기본통칙: 해석례 본문 속 "기본통칙 N-N"은 옛 번호 — 그대로 옮기지 말고 list_taxlaw_basic_ruling_laws→get_taxlaw_basic_ruling_text(주제 키워드로 인접 번호대 일괄 수집)로 현행 번호("N-N…M") 확인. 미확인 시 "현행 번호 미확인" ⚠ 표기, 통칙 도구 NOT_FOUND면 통칙 인용 제거.
4. 행정규칙(훈령·예규·고시·지침) stale: NTS 컬렉션은 개정 후 갱신 지연 가능 — korean-law discover_tools(intent="행정규칙")→search_admin_rule(knd 1훈령/2예규/3고시)→get_admin_rule로 현행본 1차 확인, 공포일·시행일·문서번호 3종 대조 후 다르면 법제처 채택(search_law는 행정규칙 NOT_FOUND).
5. NOT_FOUND: [RETRY_CANDIDATES] L1(쿼리 조정)→L2(도구 변경)→L3(외부 MCP) 순 재시도. 판례·심판례는 두 MCP 모두 NOT_FOUND여도 공개DB 미수록일 수 있음 — "미존재/할루시네이션" 단정 금지, 외부 교차확인 전까지 "공개DB 미발견"까지만 기재.
6. 인용 실존 검증: 산출물(문서·표)에 해석례·심판례·판례 번호를 인용하기 전 verify_nts_citations(text)로 일괄 실존 확인.

[적용시기 — 타임테이블 우선] 귀속연도가 제시된 법령·세액공제 질문은 본문 단정 전에 build_application_timetable(다조문×다연도) 또는 trace_article_application(단일 조문)부터. 해석 공리: ①신구 문구 나란히 대조(단일 시점본 단정 금지) ②부칙 "개정규정"=그 개정령이 실제 바꾼 문구 단위만 ③경과조치는 자기 개정령만 사정거리 ④후행·특정 적용례>일반 경과조치 ⑤적극 문언 우선(fallback 창작 금지) ⑥서식·별지<부칙·법령 문언. 적용례 anchor가 '최초공제연도'·'신고시점'형이면 차수(1차/추가공제)·신고시점을 사용자에게 질문(통합고용 §29의8 등 다년 사이클은 귀속연도만으로 판정 불가).

[표준 워크플로] 키워드 추출 → korean-law search_law+get_law_text(법률·시행령 1차 권위) → 본 MCP search_taxlaw_all/search_taxlaw_documents(해석례·통칙 보완) → 인용 전 연도 검증 → 5단 응답.

[응답 5단] ①결론(요지 1~2문장) ②매트릭스(케이스별 표 — 행마다 결론+근거 법령) ③법령 래퍼(법률/시행령/기본통칙/해석례·심판례·판례 — 문서번호·일자·인용문, 출처별 분리) ④AI 보충 해석(⚠ 미검증 표시, ①~③과 섞기 금지) ⑤"인용 본문을 더 부착해드릴까요?" 1줄. 빈 섹션도 헤더 유지+"검색 결과 없음"(추측·생성 금지). 단답형은 5단 생략 가능.

[중복 처리] 두 MCP 동일 사건은 문서번호(공백·하이픈 제거)/생산일자/제목 기준 병합 + 양쪽 출처 ID 병기.

[저빈도 도구] 업종코드·KSIC 매핑(lookup_upjong_code 등 7종)·해석례 별칭·홈택스 상담·발간책자·사이트 메뉴/원시액션은 call_taxlaw_extra(name, args)로 호출 — 목록·용법은 그 도구 설명 참조.`

export const ErrorCodes = {
  NOT_FOUND: "NOT_FOUND",
  INVALID_PARAM: "INVALID_PARAMETER",
  API_ERROR: "EXTERNAL_API_ERROR",
  PARSE_ERROR: "PARSE_ERROR",
} as const

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

⚠️ taxLawCode 권장: 검색어가 여러 세법에 걸칠 수 있으면 세목 코드 명시. NTS 코드 매핑: ${taxLawCodeReference()}. NTS API의 코드 필터링이 strict하지 않아 불일치 항목은 ⚠ taxLawCode_mismatch 자동 부착.`,
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
    name: "assess_doctrine_validity",
    description: `세법해석례·심판례·판례 단일 문서의 **현행 유효성**을 자동 채점한다. ${COMPANION_NOTICE}\n호출 한 번으로: (1) 본문/메타데이터에서 인용 법조문 시점 파싱, (2) targetYear 대비 사문화 위험 신호 점수화, (3) 최종 판정(valid_current / needs_current_check / partially_outdated / likely_outdated / superseded_or_repealed / unverified) 한 줄 라벨, (4) 권장 후속 호출 큐(korean-law-mcp.search_law/get_law_text/search_decisions + 본 MCP의 후일자 해석례 검색)를 반환. LLM은 next-action 큐를 순서대로 실행해서 답변의 채점표에 결과를 채우세요.`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "평가할 문서의 DOC_ID/DOCID. search_taxlaw_documents/search_taxlaw_all 결과에서 획득." },
        docType: { type: "string", enum: ["advance", "reply", "tax_standard", "written", "tax_pre_review", "objection", "review", "tribunal", "precedent", "constitutional", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10"], description: "알고 있는 경우 문서유형. 미입력 시 질의/판례 상세를 순차 시도." },
        targetYear: { type: "number", minimum: 1990, maximum: 2100, description: "적용하려는 연도 (예: 2026). 시점 비교의 기준. 미지정 시 needs_current_check로 분류." },
        full: { type: "boolean", default: false, description: "true면 본문 원문 텍스트를 더 길게 가져와 인용 추출 정확도 향상." },
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
        oc: { type: "string", description: "법제처 Open API 인증키(OC). 미입력 시 환경변수 LAW_GO_KR_OC 사용." },
        full: { type: "boolean", default: false, description: "true면 부칙단위·각 본문을 더 길게 반환." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "get_law_revision_text",
    description:
      "특정 개정령(공포번호/공포일자)의 '개정문'(개정 지시문 원문)을 법제처 DRF에서 회수한다. 개정문은 그 개정령이 실제 수행한 문구 수술의 원문('…를 …로 한다')으로 ① 부칙 적용례의 '개정규정'이 가리키는 문구 단위 확정 ② 부칙-of-부칙 자구개정 확인(예: 제36342호가 제36127호 부칙 §11①을 개정 — 통합본 부칙에는 <개정 2026.5.22> 꼬리표만 남고 지시문 원문은 개정문에만 있음)에 필수. get_law_addenda/build_application_timetable/trace_article_application의 [부칙개정⚠] 플래그가 뜨면 그 개정일을 promulgationDate로 지정해 이 도구로 무엇이 어떻게 바뀌었는지 원문 대조하라. ⚠ 개정문은 '그 공포번호 시행본'의 XML에만 있다 — lawName+promulgationNo(또는 promulgationDate)면 최근 시행본에서 자동 해소, 오래된 개정령은 korean-law-mcp search_historical_law로 MST를 확보해 mst로 직접 전달.",
    inputSchema: {
      type: "object",
      properties: {
        lawName: { type: "string", description: "법령명. promulgationNo/promulgationDate와 조합해 해당 개정령 시행본을 자동 선택. 예: 조세특례제한법 시행령" },
        promulgationNo: { type: "string", description: "개정령 공포번호. 예: 36342" },
        promulgationDate: { type: "string", description: "개정령 공포일자 YYYYMMDD(부칙개정⚠ 플래그의 개정일). 예: 20260522" },
        mst: { type: "string", description: "그 개정령 시행본의 MST 직접 지정(최근 시행본 window 밖의 오래된 개정령용)." },
        query: { type: "string", description: "지시문 키워드 필터(일치 줄 ±1줄만 표시). 예: 부칙, 제26조의8" },
        oc: { type: "string", description: "법제처 Open API 인증키(OC). 미입력 시 환경변수 LAW_GO_KR_OC." },
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
        oc: { type: "string", description: "법제처 Open API 인증키(OC). 미입력 시 환경변수 LAW_GO_KR_OC." },
        full: { type: "boolean", default: false, description: "true면 조문 본문 발췌·부칙 적용례를 더 길게." },
      },
      required: ["jo"],
      additionalProperties: false,
    },
  },
  {
    name: "get_law_article",
    description: "특정 시점(연도/시행일/MST)의 조문 본문과 '수식 이미지 URL'을 법제처 국가법령정보 DRF에서 회수한다. ⚠ korean-law-mcp의 연혁(시점별 조문) 회수가 사실상 고장(get_historical_law jo 추출 불능, efYd NOT_FOUND)이고 계산식이 이미지라 본문에 안 보이는 문제를 보완. year(예: 2025) 또는 efYd(YYYYMMDD)를 주면 그 시점에 시행 중이던 버전을 자동 선택(시행일 ≤ 기준 중 최신). 수식(계산식)은 flDownload.do 이미지 URL로 반환 — 다운로드 후 Read/브라우저로 확인. 주의: 이 본문은 '그 시점 시행 중이던' 조문일 뿐, 어느 과세연도 신고에 적용되는지는 trace_article_application(부칙)으로 따로 판정. v0.11.0: 과거본 회수 시 '── 후행 개정 확인 ──' 블록 자동 부착 — 현행본의 같은 조문을 자동 대조해 변경/삭제/동일을 판정하고 공포-미시행(시행예정) 개정도 경고한다. 이 블록의 ⚠는 무시 금지: 변경·삭제 경고가 있으면 현재·미래 귀속 결론 전에 현행본을 확인하라('별도 확인 필요' hedge 금지).",
    inputSchema: {
      type: "object",
      properties: {
        jo: { type: "string", description: "조회할 조문. 예: 제26조의8 (필수)" },
        year: { type: "number", description: "그 해 말(12.31) 시점에 시행 중이던 버전 자동 선택. 예: 2025" },
        efYd: { type: "string", description: "기준 시행일 YYYYMMDD. year보다 우선. 예: 20250101" },
        mst: { type: "string", description: "특정 시행본 MST를 직접 지정(연혁 목록에서 고른 값)." },
        lawName: { type: "string", description: "법령명. year/efYd로 시점 해소 또는 현행 해소에 사용. 예: 조세특례제한법 시행령" },
        oc: { type: "string", description: "법제처 Open API 인증키(OC). 미입력 시 환경변수 LAW_GO_KR_OC." },
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
        oc: { type: "string", description: "법제처 Open API 인증키(OC). 미입력 시 환경변수 LAW_GO_KR_OC." },
        full: { type: "boolean", default: false, description: "true면 hunk 12→40건까지 표시." },
      },
      required: ["jo"],
      additionalProperties: false,
    },
  },
  {
    name: "research_taxlaw_topic",
    description:
      "체인 매크로: search_taxlaw_documents → 관련성 상위 K건(기본 2, 최대 3)의 get_taxlaw_document_text(full, targetYear) 본문 첨부를 1콜로 수행한다(검색→본문→연도검증 다턴 왕복 절감). 첨부는 항상 full 본문 기반(요지만으로 결론 단정 금지 가드 유지)이며 연도검증·통칙검증·결론부 가드가 그대로 부착된다. ⚠ 첨부가 [truncated]로 잘렸으면 결론 인용 전 get_taxlaw_document_text(full=true) 개별 재조회. 복합어 자동 분해 재시도는 search_taxlaw_documents에만 있으므로 결과 없음 시 그쪽으로 재검색. korean-law-mcp 동반 호출(법조문 1차 권위)은 여전히 필수.",
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
        display: { type: "number", minimum: 1, maximum: 50, default: 20 },
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
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "call_taxlaw_extra",
    description:
      "v0.12.0 — 저빈도 도구 게이트웨이(목록 비노출로 세션 토큰 절감). name에 다음 중 하나, args에 그 도구의 인자 객체. [업종코드·KSIC 매핑] lookup_upjong_code(code) / lookup_ksic_code(code) / lookup_ksic_prefix(prefix, levels?) / search_industry_by_keyword(keyword, levels?) / resolve_industry_class(name, levels?) / classify_industry_for_article(industryName, upjongCode, excludeNames?, excludeLevels?) / upjong_db_info(). [별칭] search_taxlaw_interpretations(=search_taxlaw_documents) / get_taxlaw_interpretation_text(=get_taxlaw_document_text). [고용공제계산] compute_employment_credit(고용증대 §29의7·통합고용 §29의8구법·사회보험료 §30의4 forward 공제+추징 산정 — 손계산 대신 사용). [기타] get_taxlaw_hometax_counsel_text(id) / search_taxlaw_publications(query) / list_taxlaw_publication_categories() / list_taxlaw_site_menus() / get_taxlaw_page_text(url) / call_taxlaw_action(actionId, payload).",
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
  {
    name: "compute_employment_credit",
    description:
      "[HIDDEN — call_taxlaw_extra 경유] 고용 세액공제 forward 공제 + 추징을 한 출처에서 산정(고용증대 §29의7 · 통합고용 §29의8 구법=2024·2025귀속 · 중소기업 사회보험료 §30의4 + COVID §29의7⑤⑥⑦). LLM 손계산(법령회수+장문추론)·forward↔추징 모순 오류를 차단. ⚠ '저자 산식 기반 계산값'이며 1차 근거 아님 — 인용·신고 전 조문·해석례 원문 및 사용 단가 확인. 단가는 코드 상수(시행일 기준)라 개정 시 stale(결과에 단가·기준 동봉). 통합고용 2026 귀속~ 신법(직전3년·단년공제·최소고용·A+B+C 구간식)은 NOT_SUPPORTED → build_application_timetable 라우팅. 다년 사이클이라 first_year(=최초공제연도=차수) 필수.",
    inputSchema: {
      type: "object",
      properties: {
        credit_type: { type: "string", enum: ["고용증대", "통합고용", "사회보험료"], description: "공제 종류(기본 고용증대)" },
        size: { type: "string", enum: ["중소", "중견", "대기업"], description: "기업규모(고용증대/통합고용 필수). 사회보험료는 중소 전제." },
        region: { type: "string", enum: ["수도권내", "수도권밖"], description: "증가 지역(고용증대/통합고용 필수)" },
        first_year: { type: "number", description: "최초공제연도(=차수 기준=증가연도). 다년 사이클은 귀속연도만으로 판정 불가 — 필수." },
        counts: {
          type: "object",
          description: "연도별 인원. 키=연도(직전연도부터 마지막 공제연도까지), 값={total, youth, youth_deemed?}. youth_deemed=청년 간주(연령초과는 최초연도 수준으로 입력 → 추징 0; 미입력 시 실퇴사로 처리). 인원은 최초공제연도별 산정방법(통합고용 절사 등) 적용 후 값.",
          additionalProperties: {
            type: "object",
            properties: { total: { type: "number" }, youth: { type: "number" }, youth_deemed: { type: "number" } },
            required: ["total", "youth"],
            additionalProperties: false,
          },
        },
        sinsung: { type: "boolean", description: "[사회보험료] 신성장서비스업이면 제2호 50%→75%" },
        si_youth: { type: "number", description: "[사회보험료] 청년등 1인당 사용자 사회보험료(원, =총급여×요율÷인원). 만원급 입력은 거부." },
        si_other: { type: "number", description: "[사회보험료] 청년외 1인당 사용자 사회보험료(원)" },
      },
      required: ["first_year", "counts"],
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
  "call_taxlaw_action",
  "compute_employment_credit",
])

export function visibleTools(): typeof tools {
  if (process.env.TAXLAW_EXPOSE_ALL === "1") return tools
  return tools.filter((t) => !HIDDEN_TOOL_NAMES.has(t.name))
}

function textResponse(text: string, isError = false): ToolResponse {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) }
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

export function normalizeTaxlawPath(value: unknown, fallback = "/index.do"): string {
  const path = String(value || fallback).trim()
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

  const response = await fetchWithRetry(`${TAXLAW_BASE}/action.do`, {
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
    await consume(response)
    if (allowRefresh && (response.status === 401 || response.status === 403)) {
      cachedSession = null
      return postTaxlawActionAttempt<T>(actionId, paramData, refererPath, false)
    }
    throw new TaxlawMcpError(`Taxlaw action.do failed (${response.status})`, ErrorCodes.API_ERROR)
  }

  let payload: TaxlawActionResponse<T>
  try {
    payload = await response.json() as TaxlawActionResponse<T>
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

async function fetchWithRetry(url: string, init: RequestInit, retries = 3): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(url, { ...init, signal: controller.signal })
      clearTimeout(timeout)
      if (response.ok || ![429, 503, 504].includes(response.status) || attempt === retries) {
        return response
      }
      await consume(response)
    } catch (error) {
      clearTimeout(timeout)
      lastError = error
      if (attempt === retries) break
    }
    await sleep(700 * Math.pow(2, attempt))
  }

  const err = lastError instanceof Error ? lastError : new Error(String(lastError))
  const cause = (err as Error & { cause?: unknown }).cause
  const causeText = cause instanceof Error ? `: ${cause.message}` : ""
  throw new TaxlawMcpError(`${err.message}${causeText}`, ErrorCodes.API_ERROR)
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

export function htmlToText(html: string): string {
  const prepared = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
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

function compactBodyText(text: string, full = false, code?: string): string {
  if (full) return truncate(text, 45000)
  const relatedLawIndex = text.search(/\n?3\.\s*관련\s*법령/)
  const compact = relatedLawIndex >= 0 ? text.slice(0, relatedLawIndex).trim() : text
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
export function detectHoldingTruncation(opts: { code?: string; fullBody: string; shownBody: string; isFull: boolean }): string[] {
  const { code, fullBody, shownBody, isFull } = opts
  if (isFull || !fullBody) return []
  if (!code || !PRECEDENT_CODES.has(code.padStart(2, "0"))) return []
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

function refererForDoc(code: string | undefined, id: string): string {
  const normalizedCode = code?.padStart(2, "0")
  if (normalizedCode && PRECEDENT_CODES.has(normalizedCode)) {
    return `/pd/USEPDA002P.do?ntstDcmId=${encodeURIComponent(id)}`
  }
  return `/qt/USEQTA002P.do?ntstDcmId=${encodeURIComponent(id)}`
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

  const lines = [`[${id}] ${title || "(제목 없음)"}`]
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
    lines.push("  상세: get_taxlaw_document_text에 위 ID 사용")
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
    "주의: 아래 결과는 국세법령정보시스템 action.do 응답에서 온 실제 항목만 표시합니다.",
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
  for (const m of src.matchAll(/(?:서면|사전|기준)\s?-\s?\d{4}\s?-\s?[가-힣]{2,12}\s?-\s?\d{1,6}/g)) push(m[0], "interpretation")
  // 구형 해석례: 부가46015-2833, 법인46012-123, 소득22601-1234
  for (const m of src.matchAll(/[가-힣]{2,6}\d{4,5}\s?-\s?\d{1,6}/g)) push(m[0], "interpretation")
  // 부서형: 서면법규과-1284, 부가가치세제과-456, 법인세과-789 (일반어 '결과-12' 류는 차단)
  for (const m of src.matchAll(/([가-힣]{2,14}(?:과|팀))\s?-\s?\d{1,6}/g)) {
    if (DEPT_FALSE_PREFIXES.has(m[1])) continue
    push(m[0], "interpretation")
  }
  // 심판·심사: 조심2013서1471, 국심2005서1234 / 감심2010-123, 심사소득2019-0012
  for (const m of src.matchAll(/(?:조심|국심)\s?\d{4}\s?[가-힣]{1,2}\s?\d{1,5}/g)) push(m[0], "tribunal")
  for (const m of src.matchAll(/(?:감심|심사[가-힣]{0,4})\s?\d{4}\s?-\s?\d{1,5}/g)) push(m[0], "tribunal")
  // 법원: 2021두39997, 2023누15045, 2020구합1234, 2019헌바73
  for (const m of src.matchAll(/\d{4}\s?(?:두|누|구합|구단|헌바|헌가|헌마)\s?\d{2,7}/g)) push(m[0], "court")
  // 기본통칙: "기본통칙 10-0…5" / 옛 "기본통칙 10-0-5"
  for (const m of src.matchAll(/기본통칙\s?\d{1,3}\s?-\s?\d{1,3}(?:\s?(?:…|\.\.\.|-)\s?\d{1,3})?/g)) push(m[0], "basic_rule")
  return out
}

// v0.12.0 — NTS 인용 실존 일괄 검증 도구. 산출물에 들어갈 번호의 실존을 검색으로 확인.
// ⚠ 실존 확인 ≠ 명제 적합성(그 문서가 결론을 지지하는가) — 후자는 full 본문 대조가 별도 필요.
export async function verifyNtsCitations(args: { text?: string; maxCitations?: number }): Promise<ToolResponse> {
  const text = requireString("text", args.text)
  const cap = asPositiveInt(args.maxCitations, 12, 20)
  const all = extractNtsCitations(text)
  if (all.length === 0) {
    return textResponse(
      "인용 번호 패턴이 검출되지 않았습니다(해석례 문서번호·심판례 청구번호·법원 사건번호·기본통칙). 번호 표기를 확인하거나 인용 목록만 따로 전달하세요.",
    )
  }
  const cits = all.slice(0, cap)
  const lines = [
    "── NTS 인용 실존 일괄 검증 ──",
    `검출 ${all.length}건 중 ${cits.length}건 검증${all.length > cap ? ` (초과 ${all.length - cap}건은 maxCitations 확대 후 재호출)` : ""}.`,
    "⚠ 실존 확인 ≠ 명제 적합성 — 결론 인용 전 full 본문(주문·판단)으로 그 문서가 명제를 실제 지지하는지 별도 대조하라.",
    "",
  ]
  // v0.12.1 — 인용별 처리를 동시성 상한(4) 청크 병렬로(종전 순차 for: N건=N회 직렬 왕복).
  //   순서 보존: 각 인용을 인덱스 그대로 결과 배열에 채운 뒤 합산. NTS API 과부하 방지로 상한 절제.
  const GROUPS = [
    { kind: "question" as const, codes: ["01", "02", "03", "04"] },
    { kind: "precedent" as const, codes: ["05", "06", "07", "08", "09", "10"] },
  ]
  type CitResult = { tally: "confirmed" | "notFound" | "failed" | "basic"; line: string }

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
      const items: TaxlawDcm[] = settled
        .filter((s): s is PromiseFulfilledResult<Awaited<ReturnType<typeof searchDocumentGroup>>> => s.status === "fulfilled")
        .flatMap((s) => (s.value.result.body || []).map((row) => row.dcm).filter((d): d is TaxlawDcm => !!d))
      const hit = items.find((d) => {
        const hay = `${cleanText(d.NTST_DCM_DSCM_CNTN)}|${cleanText(d.NTST_DCM_RPLY_CNTN)}|${cleanText(d.TTL)}`
          .replace(/[\s\-–—.·]/g, "")
          .toLowerCase()
        return hay.includes(cit.normalized)
      })
      if (hit) {
        const date = cleanText(String(hit.DCM_RGT_DTM_S || hit.DCM_RGT_DTM || "")).slice(0, 12)
        const id = hit.DOC_ID || hit.DOCID || "?"
        return { tally: "confirmed", line: `✓ ${cit.raw} — 실존 확인: ${cleanText(hit.TTL).slice(0, 60)} (생산 ${date || "?"}, ID ${id})` }
      }
      return {
        tally: "notFound",
        line: `✗ ${cit.raw} — NTS 공개DB 미발견. ⚠ 미존재/할루시네이션 단정 금지 — 공개DB는 선별·익명화 수록이므로 외부 DB(casenote 등) 교차확인 전까지 산출물에는 "공개DB 미발견"으로만 기재.${cit.kind === "court" ? " 법원 판례는 korean-law-mcp search_decisions(domain=precedent)·cite_check 병행." : ""}`,
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
  for (const r of results) {
    if (r.tally === "confirmed") confirmed++
    else if (r.tally === "notFound") notFound++
    else if (r.tally === "failed") failed++
    lines.push(r.line)
  }
  lines.push("", `요약: ✓ 확인 ${confirmed} / ✗ 미발견 ${notFound} / ? 실패 ${failed} / 검출 ${all.length}`)
  return textResponse(truncate(lines.join("\n"), 20000))
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

  // v0.9.5 — NTS API의 taxLawCode 필터링이 strict하지 않아 응답에 다른 세목 코드가 섞일 수 있음.
  // 요청 코드와 응답 코드가 다르면 ⚠ 라벨 부착.
  const codeMismatchTag = requestedTaxLawCode && !taxLawCodeMatches(requestedTaxLawCode, taxCode)
    ? ` ⚠ taxLawCode_mismatch (요청=${requestedTaxLawCode} / 응답=${taxCode || "N/A"})`
    : ""

  const lines = [
    `[${id}] ${title}${relevance.tag}${codeMismatchTag}`,
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
  lines.push("  상세: get_taxlaw_document_text에 위 ID 사용")
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
  const pageSize = asPositiveInt(args.display, 20, 50)
  const estimatedPages = total > 0 ? Math.ceil(total / pageSize) : 0
  const lines = [
    `국세법령정보시스템 문서 검색 결과: ${title}`,
    `출처: ${TAXLAW_BASE}/action.do (ASIPDI002PR01)`,
    `검색어: ${args.query || "(전체)"} / 총 ${total.toLocaleString()}건 / page=${currentPage}/${estimatedPages.toLocaleString()} (display=${pageSize}) — 다음 페이지: page=${currentPage + 1}`,
    "주의: 아래 결과는 국세법령정보시스템 응답에 존재한 항목만 표시합니다.",
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

function formatDocumentDetail(id: string, dcm: TaxlawDcm, detail: TaxlawDetailData["ASIQTB002PR01"], full: boolean, referer: string, targetYear?: number): string {
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
  if (bodyText) lines.push(full ? "원문 변환 텍스트:" : "원문 요약 텍스트:", compactBodyText(bodyText, full, code), "")
  if (referencePrecedents.length > 0) {
    lines.push("참조 판례:", ...referencePrecedents.slice(0, 20).map((item) => `  - ${item}`), "")
  }
  if (quotedPrecedents.length > 0) {
    lines.push("인용 판례:", ...quotedPrecedents.slice(0, 20).map((item) => `  - ${item}`), "")
  }

  // 연도 적용여부 검증 (관련규정 섹션 파싱). 본문이 없으면 답변 텍스트를 사용.
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
    lines.push("", ...formatYearCheck(result), "")

    // v0.9.0 — 본문·메타에서 추출한 인용 조문에 옛 위치(전부개정 전) 매핑이 있으면 추가 안내.
    // v0.9.2 — bodyText 전달로 본문 substring 재확인 (citation 80자 윈도우 노이즈 차단).
    const citedRefs = extractLawArticleRefs([gist, answer, bodyText, relatedLaws].filter(Boolean).join("\n"))
    const verifyBody = [gist, answer, bodyText].filter(Boolean).join("\n")
    const restructureHits = detectPreRestructureCitations(citedRefs, verifyBody)
    if (restructureHits.length > 0) {
      lines.push("", ...formatRestructureHits(restructureHits), "")
    }

    lines.push(
      "동반 호출 필수: 위 검증은 본문 휴리스틱입니다. 인용 법조문의 현행 적용가능성은 반드시 korean-law-mcp의 search_law + get_law_text(law=..., jo=...)로 직접 대조 후 사용자에게 보고하세요.",
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
      lines.push("── 기본통칙 인용 검증 ──")
      if (legacy.length > 0) {
        lines.push(
          `⚠ 옛 번호 형식("N-N") 통칙 인용 ${legacy.length}건 검출 — 현행 번호 체계는 "N-N…M". 답변에 그대로 옮기지 말 것:`,
        )
        for (const ref of legacy) {
          lines.push(`  - ${formatBasicRulingRef(ref)} → 현행 번호 미확인. get_taxlaw_basic_ruling_text 호출 필수`)
        }
      }
      if (current.length > 0) {
        lines.push(`현행 형식 통칙 인용 ${current.length}건:`)
        for (const ref of current) {
          lines.push(`  - ${formatBasicRulingRef(ref)}`)
        }
      }
      lines.push("강제 절차:")
      lines.push("  1) list_taxlaw_basic_ruling_laws(query=세법명)로 lawId 확보")
      lines.push("  2) get_taxlaw_basic_ruling_text(lawId, query=주제어)로 현행 본문/번호 직접 확인")
      lines.push("  3) 단건이 아닌 주제어로 호출 → 인접 번호대 일괄 수집 (관련 통칙 군집 누락 방지)")
      lines.push("")
    }
  }

  // v0.9.14 — 판례·결정례 결론부(판단·주문) 잘림 경고 + 요지-결과 정합성 가드
  if (bodyText) {
    const holdingWarn = detectHoldingTruncation({
      code,
      fullBody: bodyText,
      shownBody: compactBodyText(bodyText, full, code),
      isFull: full,
    })
    if (holdingWarn.length > 0) lines.push(...holdingWarn, "")
  }

  return truncate(lines.join("\n"), full ? 50000 : 30000)
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
  const path = normalizeTaxlawPath(args.path)
  const response = await fetchWithRetry(`${TAXLAW_BASE}${path}`, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
      "user-agent": userAgent(),
    },
  })
  if (!response.ok) {
    await consume(response)
    throw new TaxlawMcpError(`Taxlaw page fetch failed (${response.status})`, ErrorCodes.API_ERROR)
  }

  const contentType = response.headers.get("content-type") || "N/A"
  const raw = await response.text()
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

export interface AddendaUnit {
  promulgationDate: string
  promulgationNo: string
  text: string
}

// 법제처 DRF type=XML 응답의 <부칙내용>은 여러 <![CDATA[...]]> 조각으로 나뉘어 있고
// 조각 안에는 <제35999호,2025.12.31> 같은 '리터럴 꺾쇠'가 들어있다. 따라서 일반 태그 제거를
// 적용하면 부칙 헤더가 잘린다. CDATA 조각만 추출해 이어 붙이고, 수식 <img>만 마커로 치환한다.
export function extractCdataText(block: string): string {
  const chunks: string[] = []
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(block))) chunks.push(m[1])
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

async function fetchMolegXml(url: string, label: string): Promise<string> {
  const cacheKey = `moleg:${url}`
  const cached = cacheGet(cacheKey)
  if (cached !== null) return cached
  const response = await fetchWithRetry(url, {
    headers: { accept: "application/xml,text/xml;q=0.9,*/*;q=0.5", "user-agent": userAgent() },
  })
  if (!response.ok) {
    await consume(response)
    throw new TaxlawMcpError(`법제처 ${label} 실패 (${response.status})`, ErrorCodes.API_ERROR)
  }
  const xml = await response.text()
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
  const url = `${MOLEG_BASE}/DRF/lawSearch.do?OC=${encodeURIComponent(oc)}&target=eflaw&type=XML&display=20&query=${encodeURIComponent(lawName)}`
  const xml = await fetchMolegXml(url, "시행일 법령 검색")
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of xml.matchAll(/<법령일련번호>(\d+)<\/법령일련번호>/g)) {
    const mst = m[1]
    if (seen.has(mst)) continue
    seen.add(mst)
    out.push(mst)
    if (out.length >= limit) break
  }
  return out
}

export interface LawVersion { mst: string; enforceDate: string; promDate?: string; lawName?: string }

// 법령명 정규화 키(공백 제거) — eflaw 행 필터·법령명 동일성 비교용.
export function lawNameKey(s: string): string {
  return String(s || "").replace(/\s+/g, "")
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
export function findArticleInXml(
  xml: string,
  jo: string,
): { status: "found" | "deleted" | "missing"; block?: string; deletedDate?: string } {
  const joEsc = jo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const open = new RegExp(`<조문내용>\\s*<!\\[CDATA\\[\\s*${joEsc}\\(`).exec(xml)
  if (open) {
    const s = xml.lastIndexOf("<조문단위", open.index)
    const e = xml.indexOf("</조문단위>", open.index)
    if (s !== -1 && e !== -1) return { status: "found", block: xml.slice(s, e) }
    return { status: "missing" } // 구조 파손 — 안전 측으로 미발견 처리
  }
  const del = new RegExp(`<조문내용>\\s*<!\\[CDATA\\[\\s*${joEsc}\\s*삭제\\s*<([^>]*)>`).exec(xml)
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
export function buildInterpretiveForkGuard(text: string, jo: string): string[] {
  if (!text) return []
  const hasExclusion = /적용하지\s*(?:아니|않)/.test(text) // 적용하지 아니한다/아니하고/아니하며/않는다/않으며
  const refsClause = /제\d+호|제\d+항/.test(text)
  const isCredit = /공제/.test(text)
  const isSunset = /감소|추징|사후관리/.test(text)
  if (!(hasExclusion && refsClause && isCredit && isSunset)) return []
  return [
    "── 해석 분기 가드(세액공제 사후관리) ──",
    `⚠ ${jo}는 사후관리·추징형 문언("제N호/제N항을 적용하지 아니한다" 등)을 포함한다. 이 문언은 '해당 증가분 공제가 소멸'이 아니라 '낮은 호의 단가로 전환(강등)'을 의미할 수 있다(삭제 vs 단가전환 = 해석 분기점). 문언만으로 공제액·추징액·산식을 단정하지 마라.`,
    "  ① 해석례 확정: search_taxlaw_all/search_taxlaw_documents(해석례·질의)로 '해당 호 미적용 시 잔여연도 공제 산식'을 직접 확인하라. 온포인트 해석이 안 나오면 '해석 미확인'으로 hedge하고 literal로 메우지 마라(검색 실패 ≠ 해석 부재).",
    "  ② 추징식 정합성 교차검증: forward 공제식과 추징 산식(시행령: 감소인원 × (상위호 − 하위호) = '프리미엄만 환수' 구조)이 서로 모순되지 않는지 대조하라. 추징이 프리미엄만 환수하면 forward도 하위 호 단가는 유지되는 것이 정합 — 두 식이 충돌하면 레드플래그.",
    "  ③ 숫자 예시를 제도취지로 스트레스테스트: '전체 유지인데 공제가 줄면 말이 되나?' 1줄 점검.",
    "(실측: 조특법 §29의7② '청년 감소 → 제1항제1호 미적용'을 '제2호 = 원래 청년외 증가분만'으로 오독 → 정답은 전체 증가인원 전부 제2호 단가 / 기재부 조특제도과-215·서면-2023-법인-0978)",
  ]
}

// 조문단위 블록에서 본문 텍스트 + 수식 이미지(flDownload) URL을 뽑는다. 이미지는 URL 마커로 보존.
export function extractArticleBody(joBlock: string): { text: string; imageUrls: string[] } {
  const urls = [...joBlock.matchAll(/flDownload\.do\?flSeq=(\d+)/g)].map((m) => `${MOLEG_BASE}/DRF/flDownload.do?flSeq=${m[1]}`)
  const chunks: string[] = []
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(joBlock))) chunks.push(m[1])
  let text = chunks.length > 0 ? chunks.join("") : joBlock
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

  const sources: AddendaSource[] = []
  for (const m of msts) {
    const xml = m === primaryMst ? primaryXml : await fetchMolegXml(lawServiceUrl(m), "법령 조회")
    // 그 통합본 자체의 공포일자(기본정보 첫 등장) — dedup 시 최신 통합본 우선 판정 기준
    const promDate = (xml.match(/<공포일자>(\d{8})<\/공포일자>/)?.[1] || "").trim()
    sources.push({ mst: m, units: parseLawAddenda(xml), promDate })
  }
  const { units } = mergeAddendaUnits(sources)
  const primaryNos = new Set((sources.find((s) => s.mst === primaryMst)?.units || []).map((u) => u.promulgationNo).filter(Boolean))
  const supplementedNos = units
    .map((u) => u.promulgationNo)
    .filter((n): n is string => !!n && !primaryNos.has(n))

  return { mst: primaryMst, lawTitle, url: lawServiceUrl(primaryMst), xml: primaryXml, units, sourceMsts: msts, supplementedNos, resolvedNote }
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

  const lines = [
    "법제처 법령 부칙(시행일·적용례·경과조치)",
    `출처: ${url}`,
    `법령: ${lawTitle || "N/A"} (MST ${mst})${resolvedNote}`,
    `부칙 union 출처 MST: ${sourceMsts.join(", ")} (타법개정 통합본의 직전 일부개정 부칙 누락 보정)`,
    `부칙단위: 전체 ${units.length}개${no || q ? ` / 필터 일치 ${filtered.length}개` : ""} / 표시 ${shown.length}개 (최신 공포일순)`,
    ...(supplementedNos.length > 0
      ? [`⚠ 현행 MST(${mst}) 부칙에 없어 다른 시행본에서 보강한 공포번호: ${supplementedNos.join(", ")} — 통합본 consolidation lag. 적용시점 판단 시 이 보강분 누락 주의.`]
      : []),
    "주의: 적용례는 '○○ 개정규정은 …부터 적용한다'로 구조문(개정 전 본문)과 짝입니다. 구조문은 korean-law-mcp.compare_old_new의 [개정 전]으로 대조하세요. 아래는 법제처 원문이며, 명시되지 않은 사실은 추론·생성하지 마세요.",
    "",
  ]
  shown.forEach((u) => {
    lines.push(`──────── [제${u.promulgationNo || "?"}호, ${u.promulgationDate || "?"}] ────────`)
    const revs = detectAddendumRevisionTails(u.text, u.promulgationDate)
    if (revs.length > 0) {
      lines.push(
        `⚠ [부칙 자체개정] 이 부칙은 후행 개정령에 의해 변경된 현행화 문구(<개정 ${revs.map(formatYmd).join(", ")}> 꼬리표). 적용시기 anchor 자체가 바뀌었을 수 있다 — 고친 지시문 원문은 get_law_revision_text(promulgationDate=${revs[0]})로 회수하고, 개정 전 문구는 그 개정일 이전 시행본 MST를 mst로 지정해 재호출해 대조하라.`,
      )
    }
    lines.push(truncate(u.text, perUnit))
    lines.push("")
  })
  if (filtered.length > shown.length) {
    lines.push(`… 외 ${filtered.length - shown.length}개 부칙단위 생략. promulgationNo/query로 좁히거나 full=true로 더 보세요.`)
  }
  return textResponse(truncate(lines.join("\n"), args.full === true ? 60000 : 20000))
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
    `출처: ${url}`,
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
  if (/이후개시하는과세연도/.test(f) || /이후개시하는사업연도/.test(f)) return "과세연도개시기준"
  if (/시행이후[\s\S]*?신고하는경우/.test(f) || /과세표준(및세액을)?신고/.test(f) || /과세표준을신고/.test(f)) return "신고시점기준"
  if (/시행이후[\s\S]*?(취득|지급|양도|증여|계약|출자|투자|복직|전환|해지|가입|발생|공급|취업|상장|합병)/.test(f)) return "행위시점기준"
  if (/이후[\s\S]*?발생하는소득/.test(f) || /속하는과세(연도|기간)/.test(f)) return "소득·기간기준"
  return "유형미상"
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
    if (!b.replace(/\s/g, "").includes(joKey)) continue
    const title = (b.match(/^제\d+조(?:의\d+)?\s*\([^)]*\)/) || [""])[0].trim()
    // 항(①~⑮)으로 쪼개되, 항이 1개뿐이면 블록 전체를 후보로
    const parts = b.split(/(?=[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮])/).filter((p) => p.trim())
    const candidates = parts.length > 1 ? parts : [b]
    for (const p of candidates) {
      const flat = p.replace(/\s/g, "")
      if (!flat.includes(joKey)) continue
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
export function extractJunyongTargets(articleText: string, selfJo: string): Array<{ jo: string; hang?: string }> {
  const out: Array<{ jo: string; hang?: string }> = []
  const seen = new Set<string>()
  const flat = String(articleText || "").replace(/\s/g, "")
  const selfKey = String(selfJo || "").replace(/\s/g, "")
  for (const m of flat.matchAll(/준용/g)) {
    const idx = m.index ?? 0
    const ctx = flat.slice(Math.max(0, idx - 40), idx)
    const refs = [...ctx.matchAll(/(제\d+조(?:의\d+)?)(제\d+항)?/g)]
    if (refs.length === 0) continue
    const last = refs[refs.length - 1]
    const jo = last[1]
    if (jo === selfKey) continue
    const key = `${jo}${last[2] || ""}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ jo, hang: last[2] || undefined })
    if (out.length >= 3) break
  }
  return out
}

function targetYearApplicationNote(
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
    const ym = f.match(/(\d{4})년\d{0,2}월?\d{0,2}일?이후개시/)?.[1]
    if (!ym) return `기준 과세연도 미파싱 — 원문 확인.`
    return `기준: ${ym} 이후 개시 과세연도. targetYear ${targetYear} ${Number(targetYear) >= Number(ym) ? "≥ → 개정규정 적용" : "< → 종전규정"}.`
  }
  if (type === "경과조치(종전규정)") {
    const yrs = [...f.matchAll(/(\d{4})년/g)].map((m) => Number(m[1]))
    const inRange = yrs.includes(Number(targetYear))
    return `경과조치 명시연도 ${yrs.join("·") || "?"}. targetYear ${targetYear} ${inRange ? "포함 → 원칙 종전규정. ⚠ 같은 조문에 후행·특정 적용례가 있으면 그쪽이 우선할 수 있으니 충돌 점검 필수" : "미포함"}.`
  }
  if (type === "최초공제연도기준") {
    return `최초 공제연도 기준. ${targetYear}를 최초 공제연도로 신청하면 개정규정 적용. 이전 연도 최초공제 사이클의 추가공제·사후관리분이면 종전규정 검토 — ⚠ 귀속연도만으론 판정 불가, 차수(최초공제연도) 확인 필수.`
  }
  if (type === "행위시점기준" || type === "소득·기간기준") {
    return `행위·소득 발생시점 기준. ${targetYear} 중 해당 행위/소득이 시행일(${enforceDate || "?"}) 이후면 개정규정.`
  }
  return ""
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
    .filter((u) => u.text.replace(/\s/g, "").includes(joKey))
    .sort((a, b) => (b.promulgationDate || "").localeCompare(a.promulgationDate || ""))

  if (matched.length === 0) {
    return notFoundResponse(
      `MST ${mst}의 부칙에서 ${jo}${hang ? " " + hang : ""}을(를) 언급하는 적용례/경과조치를 찾지 못했습니다.`,
      [
        "jo 표기를 법령 표기와 맞추세요(예: '제26조의8').",
        "hang 필터가 너무 좁으면 생략하고 조 단위로 보세요.",
        "부칙 전체는 get_law_addenda로, 구버전 본문은 korean-law-mcp search_historical_law로 확인하세요.",
      ],
    )
  }

  const allTypes = new Set<string>()
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
      allTypes.add(type)
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
  const jBlocks: string[] = []
  for (const t of junyongTargets) {
    jBlocks.push(`▷ ${jo} 본문이 ${t.jo}${t.hang || ""}을(를) 준용 — 적용시기는 '준용 구조(${jo})'와 '준용 대상(${t.jo}) 내용' 두 층의 부칙이 따로 정할 수 있다(2층 타임라인). 두 층 모두 점검하라.`)
    let tDates: string[] = []
    const tIdx = xml.indexOf(`<![CDATA[${t.jo}(`)
    if (tIdx !== -1) {
      const ts = xml.lastIndexOf("<조문단위", tIdx)
      const te = xml.indexOf("</조문단위>", tIdx)
      if (ts !== -1 && te !== -1) {
        const tInv = extractAmendmentInventory(extractCdataText(xml.slice(ts, te)))
        const tSym = t.hang ? hangToSymbol(t.hang) : null
        const tHangDates = tSym ? tInv.byHang[tSym] || [] : []
        tDates = tHangDates.length ? tHangDates : tInv.article
        if (tDates.length) jBlocks.push(`  개정 인벤토리 ${t.jo}${t.hang || ""}: ${tDates.join(", ")}`)
      }
    }
    const tKey = t.jo.replace(/\s/g, "")
    const tMatched = units
      .filter((u) => u.text.replace(/\s/g, "").includes(tKey))
      .sort((a, b) => (b.promulgationDate || "").localeCompare(a.promulgationDate || ""))
    if (tMatched.length === 0) {
      jBlocks.push(`  (부칙에서 ${t.jo} 언급 적용례 없음)`)
      continue
    }
    for (const u of tMatched.slice(0, args.full === true ? 8 : 4)) {
      const clauses = extractJoClauses(u.text, t.jo, t.hang)
      const binding = checkAmendmentBinding(u.promulgationDate || "", tDates)
      for (const c of clauses.slice(0, 3)) {
        const type = classifyApplicationClause(c.clause)
        allTypes.add(type)
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
  if (allTypes.has("최초공제연도기준")) {
    lines.push(
      "⚠⚠ [차수 확인 필수] 적용례에 '최초공제연도' 기준 검출 — 귀속연도만으로 판정 불가.",
      '   답변 전에 사용자에게 질문하라: "해당 연도가 1차공제(최초공제연도)인지, 이전 연도 최초공제 사이클의 추가공제인지?" (다년 사이클 공제: 통합고용 §29의8, 구 고용증대 §29의7 등)',
      "",
    )
  }
  if (allTypes.has("신고시점기준") && targetYear === undefined) {
    lines.push("⚠ 신고시점 기준 적용례 존재 — targetYear·filingMonth를 지정해 재호출하면 연도별 소급 판단노트가 생성된다.", "")
  }
  lines.push("조문 적용시점 추적", `출처: ${url}`, `법령: ${lawTitle || "N/A"} (MST ${mst}) / 대상 조문: ${jo}${hang ? " " + hang : ""}`)
  lines.push(`부칙 union 출처 MST: ${sourceMsts.join(", ")} (통합본 consolidation lag 보정)`)
  if (supplementedNos.length > 0) {
    lines.push(`⚠ 현행 MST(${mst}) 부칙에 없어 다른 시행본에서 보강한 공포번호: ${supplementedNos.join(", ")} — 이 보강 적용례가 결론에 영향 줄 수 있으니 반드시 확인.`)
  }
  if (targetYear !== undefined) lines.push(`targetYear: ${targetYear} 귀속 (신고시점 추정 ${targetYear + 1}.${filingMonth}월)`)
  // 충돌 경고
  if (allTypes.has("경과조치(종전규정)") && [...allTypes].some((t) => t !== "경과조치(종전규정)" && t !== "유형미상")) {
    lines.push(`⚠ 부칙 충돌 가능: 같은 조문에 [경과조치(종전규정)]와 [${[...allTypes].filter((t) => t !== "경과조치(종전규정)" && t !== "유형미상").join(", ")}]가 공존 → 어느 적용례가 우선하는지(후행·특정 우선 + 결박검증) 반드시 판단하라.`)
  }
  lines.push(`부칙 적용례: ${jo} 언급 개정 ${matched.length}건 (최신순)`, "")
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
  if (jBlocks.length) lines.push("── 준용 체인(자동 추적) ──", ...jBlocks, "")
  lines.push("구버전/시점별 조문 본문·수식이미지는 get_law_article(jo, year 또는 efYd/mst)로 회수. 여러 조문×여러 귀속연도 매트릭스는 build_application_timetable로 한 번에 조립.")
  return textResponse(truncate(lines.join("\n"), args.full === true ? 80000 : 32000))
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
  const efYd = String(args.efYd ?? "").trim() || (typeof args.year === "number" ? `${args.year}1231` : "")
  if (!mstArg && !lawName) {
    throw new TaxlawMcpError("mst 또는 lawName 중 하나는 필수입니다.", ErrorCodes.INVALID_PARAM)
  }

  let mst = mstArg
  let versions: LawVersion[] = []
  let pickNote = ""
  if (lawName) {
    if (!mst) {
      versions = await fetchEflawVersions(oc, lawName, 40) // 해소에 필수 — 실패 시 호출 실패가 맞다
    } else {
      // v0.11.0 — mst 직접 지정이면 버전 목록은 후행 개정 가드 전용(soft-fail: 실패 시 가드만 생략).
      try {
        versions = await fetchEflawVersions(oc, lawName, 40)
      } catch {
        /* 가드 생략 — 본 응답은 정상 */
      }
    }
  }
  if (!mst) {
    const ownVersions = filterVersionsByName(versions, lawName) // 교차법령 행 배제(일치 0건이면 원본)
    if (efYd && ownVersions.length) {
      const picked = pickVersionInForce(ownVersions, efYd)
      if (picked) {
        mst = picked.mst
        pickNote = ` (efYd ${efYd} 시점 시행본: 시행 ${formatYmd(picked.enforceDate)})`
      } else {
        // v0.11.0 — 최근 40행 윈도우에 efYd 이전 시행본이 없으면 현행본 fallback을 침묵시키지 않는다
        // (무경고 fallback이 '요청 시점본을 받았다'로 오독되는 역방향 누락 — 리뷰 실증).
        pickNote = ` (⚠ efYd ${efYd} 시점 시행본을 최근 40행 윈도우에서 찾지 못해 현행본을 반환 — 요청 시점 텍스트 아님. 구버전 MST는 korean-law-mcp search_historical_law로 확보해 mst로 전달하라)`
      }
    }
    if (!mst) mst = await resolveLawMst(oc, lawName)
  }

  const url = `${MOLEG_BASE}/DRF/lawService.do?OC=${encodeURIComponent(oc)}&target=law&MST=${encodeURIComponent(mst)}&type=XML`
  const xml = await fetchMolegXml(url, "법령 조회")
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
    `출처: ${url}`,
    `법령: ${lawTitle || "N/A"} (MST ${mst}) / 시행일 ${enforceDate ? formatYmd(enforceDate) : "?"}${pickNote}`,
    `대상 조문: ${jo}`,
    "⚠ 이 본문은 '이 시점에 시행 중이던' 조문이다. 어느 과세연도 신고에 적용되는지는 trace_article_application(부칙 적용례)로 별도 판정하라.",
  ]
  if (revisionGuard.length) lines.push("", ...revisionGuard)
  const forkGuard = buildInterpretiveForkGuard(text, jo)
  if (forkGuard.length) lines.push("", ...forkGuard)
  lines.push(
    "",
    "── 본문 ──",
    truncate(text, args.full === true ? 16000 : 6000),
  )
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

  // 조문 본문 회수(현행 XML 내) + 인벤토리
  const articleInfo = (tjo: string, thang?: string): { dates: string[]; body: string } => {
    let body = ""
    const idx = xml.indexOf(`<![CDATA[${tjo}(`)
    if (idx !== -1) {
      const s = xml.lastIndexOf("<조문단위", idx)
      const e = xml.indexOf("</조문단위>", idx)
      if (s !== -1 && e !== -1) body = extractCdataText(xml.slice(s, e))
    }
    if (!body) return { dates: [], body: "" }
    const inv = extractAmendmentInventory(body)
    const sym = thang ? hangToSymbol(thang) : null
    const hd = sym ? inv.byHang[sym] || [] : []
    return { dates: hd.length ? hd : inv.article, body }
  }

  const clauseCap = full ? 1500 : 320
  const lines: string[] = [
    "법령 적용 타임테이블 — 신구법령+부칙 통합(귀속연도×조문 매트릭스)",
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

    lines.push(`════════ [조문 ${jo}${hang || ""}] ════════`)
    if (own.dates.length) lines.push(`개정 인벤토리(현행 꼬리표): ${own.dates.join(", ")}`)
    if (junyong.length) {
      lines.push(`준용 탐지: ${junyong.map((t) => t.jo + (t.hang || "")).join(", ")} — 2층 타임라인(준용 구조/준용 대상 각각의 부칙)을 모두 점검`)
    }

    const entries: TtEntry[] = []
    const collectFor = (tjo: string, thang: string | undefined, dates: string[], via?: string) => {
      const key = tjo.replace(/\s/g, "")
      const ms = units
        .filter((u) => u.text.replace(/\s/g, "").includes(key))
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
    collectFor(jo, hang, own.dates)
    for (const t of junyong.slice(0, 2)) {
      const ti = articleInfo(t.jo, t.hang)
      collectFor(t.jo, t.hang, ti.dates, `${t.jo}${t.hang || ""} 준용대상`)
      if (ti.dates.length) lines.push(`개정 인벤토리(준용대상 ${t.jo}${t.hang || ""}): ${ti.dates.join(", ")}`)
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
    if (entries.length > shown.length) lines.push(`… 외 ${entries.length - shown.length}건 생략(full=true로 더 보기).`)
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
    const efYd = String(efYdRaw ?? "").trim() || (typeof yearRaw === "number" ? `${yearRaw}1231` : "")
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
  if (!specA.mst || !specB.mst) versions = await fetchEflawVersions(oc, lawName, 40)
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
  if (hangNote) lines.push(hangNote)
  lines.push("")

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
  const settled = await Promise.allSettled(groups.map((group) => searchDocumentGroup(group, searchArgs)))
  const results = settled
    .filter((s): s is PromiseFulfilledResult<{ group: "question" | "precedent"; codes: string[]; result: TaxlawSearchData["ASIPDI002PR01"] }> => s.status === "fulfilled")
    .map((s) => s.value)
  if (results.length === 0) {
    throw settled.find((s) => s.status === "rejected")?.reason ?? new TaxlawMcpError("Taxlaw document search failed.", ErrorCodes.API_ERROR)
  }
  const rawItems = results
    .flatMap((entry) => (entry.result.body || []).map((row) => row.dcm).filter((d): d is TaxlawDcm => !!d))
    .sort((a, b) => documentDateValue(b) - documentDateValue(a))
  const { items: uniqueItems } = uniqueDocuments(rawItems)
  if (uniqueItems.length === 0) {
    return notFoundResponse(`'${query}' 검색 결과 없음.`, [
      "search_taxlaw_documents로 재검색(복합어 자동 분해 재시도 내장 — 본 매크로에는 없음).",
      "docType·taxLawCode 필터를 풀거나 키워드를 1~2개 핵심 단어로 축소.",
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
      return truncate(
        formatDocumentDetail(id, detail.dcmDVO, detail, true, referer, targetYear),
        args.full === true ? 20000 : 9000,
      )
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
  const lines = [
    `업종코드↔KSIC 매핑 조회 결과 (DB 귀속연도: ${info.year ?? "N/A"})`,
    "출처: 국세청 '업종코드-표준산업분류 연계표'",
    "",
    ...formatUpjongRecord(r),
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
      return await verifyNtsCitations(input as { text?: string; maxCitations?: number })
    }
    if (name === "compute_employment_credit") {
      // 계산 엔진 예외 격리 — 검색 핸들러 가용성에 전이 금지(design D)
      try {
        return textResponse(computeEmploymentCredit(input as EmpCreditArgs))
      } catch (e) {
        return textResponse(`[입력/적용범위 오류] ${e instanceof Error ? e.message : String(e)}`, true)
      }
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
  const result = await handleToolCall(name, args)
  return {
    content: result.content,
    isError: result.isError,
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
