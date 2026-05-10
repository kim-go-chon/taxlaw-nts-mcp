#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const TAXLAW_BASE = "https://taxlaw.nts.go.kr"
const VERSION = "0.3.4"

const ErrorCodes = {
  NOT_FOUND: "NOT_FOUND",
  INVALID_PARAM: "INVALID_PARAMETER",
  API_ERROR: "EXTERNAL_API_ERROR",
  PARSE_ERROR: "PARSE_ERROR",
} as const

const FAILURE_GUARD =
  "⚠️ 이 도구는 신뢰 가능한 세법 데이터를 반환하지 못했습니다. LLM은 세법 정보, 문서, 판례를 추측하거나 생성하지 말고 오류/검색 실패와 재시도 필요성을 사용자에게 명시하세요."

type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]

class TaxlawMcpError extends Error {
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
}

interface DocumentDetailArgs {
  id?: string
  docType?: string
  full?: boolean
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
    description: "국세법령정보시스템 통합검색. 법제처 API에 없는 국세청 자료까지 보완 탐색: 별표서식, 국세법령, 세법해석/질의, 판례·결정례, 발간책자, 홈택스 상담사례. korean-law-mcp(법제처 DB)와 병용 권장 — 법조문 본문은 korean-law-mcp의 get_law_text가 정확하고, 본 도구의 statute 컬렉션은 메타·인용 위주.",
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
        taxLawCode: { type: "string", description: "세목 코드. 예: 303=법인세, 305=종합소득세" },
        synonym: { type: "boolean", default: false, description: "동의어 검색 사용 여부" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "search_taxlaw_documents",
    description: "국세법령정보시스템 문서 검색. 세법해석례/질의회신(01-04)과 과세전적부·이의·심사·심판·판례·헌재(05-10)를 검색. 최신 조세심판원 결정례는 NTS가 강세이므로 본 도구 우선; 그래도 없으면 korean-law-mcp의 search_decisions로 병행 확인 권장.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "검색어. 비우면 선택 문서유형의 최신순 목록 조회" },
        docType: {
          type: "string",
          enum: ["all", "interpretations", "disputes", "advance", "reply", "tax_standard", "written", "tax_pre_review", "objection", "review", "tribunal", "precedent", "constitutional", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10"],
          default: "reply",
        },
        display: { type: "number", minimum: 1, maximum: 50, default: 20 },
        page: { type: "number", minimum: 1, default: 1 },
        sort: { type: "string", enum: ["date_desc", "date_asc", "reg_desc", "reg_asc"], default: "date_desc" },
        fromDate: { type: "string", pattern: "^\\d{8}$", description: "검색 시작일 YYYYMMDD" },
        toDate: { type: "string", pattern: "^\\d{8}$", description: "검색 종료일 YYYYMMDD" },
        taxLawCode: { type: "string", description: "세목 코드. 예: 303=법인세, 305=종합소득세" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "get_taxlaw_document_text",
    description: "국세법령정보시스템 문서 상세 조회. search_taxlaw_documents/search_taxlaw_all 결과의 DOC_ID/id를 사용.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "검색 결과의 DOC_ID 또는 DOCID. 예: 001_200000000000019482 또는 200000000000019482" },
        docType: { type: "string", enum: ["advance", "reply", "tax_standard", "written", "tax_pre_review", "objection", "review", "tribunal", "precedent", "constitutional", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10"], description: "알고 있는 경우 문서유형. 미입력 시 질의/판례 상세를 순차 시도" },
        full: { type: "boolean", default: false, description: "true면 HTML 원문 변환 텍스트를 더 길게 포함" },
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
]

function textResponse(text: string, isError = false): ToolResponse {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) }
}

function notFoundResponse(message: string, suggestions: string[] = []): ToolResponse {
  const lines = [
    `[${ErrorCodes.NOT_FOUND}] ${message}`,
    "",
    "⚠️ 이 도구는 국세법령정보시스템에서 실제 데이터를 찾지 못했습니다. LLM은 결과를 추측하거나 생성하지 말고, '해당 데이터 없음/검색 실패'를 사용자에게 명시하세요.",
  ]
  if (suggestions.length > 0) {
    lines.push("", "재시도 제안:")
    suggestions.forEach((suggestion) => lines.push(`  - ${suggestion}`))
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

function truncate(text: string, max = 50000): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[truncated to ${max.toLocaleString()} chars]`
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

function normalizeDetailId(id: string): string {
  const trimmed = id.trim()
  const prefixed = trimmed.match(/^001_(\d+)$/)
  return prefixed ? prefixed[1] : trimmed
}

function normalizeTaxlawPath(value: unknown, fallback = "/index.do"): string {
  const path = String(value || fallback).trim()
  if (!path || !path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
    throw new TaxlawMcpError("path/refererPath must be a relative taxlaw.nts.go.kr path starting with /", ErrorCodes.INVALID_PARAM)
  }
  return path
}

function stringifyJson(value: unknown, full = false): string {
  const json = JSON.stringify(value, null, 2)
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
  return postTaxlawActionAttempt<T>(actionId, paramData, refererPath, true)
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

async function fetchWithRetry(url: string, init: RequestInit, retries = 3): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)
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

function userAgent(): string {
  return process.env.TAXLAW_USER_AGENT ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

function decodeHtml(text: string): string {
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

function htmlToText(html: string): string {
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

function cleanText(value: unknown): string {
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

function normalizeDate(value: unknown): string {
  const digits = String(value ?? "").replace(/\D/g, "")
  if (digits.length < 8) return "N/A"
  return `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6, 8)}`
}

function compactBodyText(text: string, full = false): string {
  if (full) return truncate(text, 45000)
  const relatedLawIndex = text.search(/\n?3\.\s*관련\s*법령/)
  const compact = relatedLawIndex >= 0 ? text.slice(0, relatedLawIndex).trim() : text
  return truncate(compact, 8000)
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

function formatIntegratedRow(row: AnyRecord, collectionName: string): string {
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
  if (summary) {
    lines.push(`  내용: ${truncate(summary, collectionName === "hometaxCnslThan" ? 600 : 500)}`)
  } else if (!title && !labels && !docNo && !replyNo) {
    lines.push("  내용: (메타데이터 부족 — 본문 없음. 추가 조회 도구로 확인 필요)")
  }
  if ((collectionName === "question" || collectionName === "precedent") && id !== "N/A") {
    lines.push("  상세: get_taxlaw_document_text에 위 ID 사용")
  }
  if (collectionName === "hometaxCnslThan" && id !== "N/A") {
    lines.push("  상세: get_taxlaw_hometax_counsel_text에 위 ID 사용")
  }
  return lines.join("\n")
}

async function searchTaxlawAll(args: IntegratedSearchArgs): Promise<ToolResponse> {
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
    useSynonymYn: args.synonym ? "Y" : "N",
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
    return notFoundResponse(`국세법령정보시스템 통합검색 '${query}' 결과가 없습니다.`, [
      "검색어를 더 짧게 줄여 재검색하세요.",
      "세법해석/판례만 필요하면 search_taxlaw_documents를 사용하세요.",
      "법제처 해석례·감사원 심사청구·납세자보호위원회 심의사례·평가심의사례는 통합검색에 포함되지 않습니다. list_taxlaw_site_menus에서 actionId를 확인 후 call_taxlaw_action으로 조회하세요.",
      "법조문 본문 자체가 필요한 경우 NTS의 statute 컬렉션은 본문 인덱싱이 약하므로 korean-law-mcp의 search_law + get_law_text(jo=...)로 직접 조회하는 것이 확실합니다.",
      "판례·해석례·조세심판이 NTS에 없으면 korean-law-mcp의 search_decisions(domain=precedent/interpretation/tax_tribunal)도 함께 시도하세요(두 시스템은 인덱싱 범위가 달라 한쪽만 회수되는 경우가 흔함).",
    ])
  }

  const lines = [
    `국세법령정보시스템 통합검색 결과: "${query}"`,
    `출처: ${TAXLAW_BASE}/is/USEISA001M.do`,
    `검색 컬렉션: ${collections.join(", ")} / 총 ${total.toLocaleString()}건 / page=${page}`,
    "주의: 아래 결과는 국세법령정보시스템 action.do 응답에서 온 실제 항목만 표시합니다.",
    "",
  ]

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
    rows.slice(0, display).forEach((row) => {
      lines.push(formatIntegratedRow(row, nameEn), "")
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
  const display = asPositiveInt(args.display, 20, 50)
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

function documentDateValue(item: TaxlawDcm): number {
  const digits = String(item.DCM_RGT_DTM_S || item.DCM_RGT_DTM || item.FRS_RGT_DTM || "").replace(/\D/g, "")
  return Number(digits.slice(0, 14) || 0)
}

function documentDedupKey(item: TaxlawDcm): string {
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

function formatDocumentSearchItem(item: TaxlawDcm, query?: string): string {
  const id = item.DOC_ID || item.DOCID || "N/A"
  const code = String(item.NTST_DCM_CL_CD || "").padStart(2, "0")
  const type = item.NTST_DCM_CL_NM || item.LBL1_TTL || docLabel(code)
  const tax = item.NTST_TLAW_CL_NM || item.LBL2_TTL || "N/A"
  const title = cleanText(item.TTL)
  const gist = cleanText(item.GIST_CNTN || item.CNTN || item.FILE_CN)
  const snippet = query ? highlightedSnippet(item.FILE_CN || item.CNTN || item.GIST_CNTN || item.TTL, query) : ""
  const lines = [
    `[${id}] ${title}`,
    `  구분: ${type} / 세목: ${tax}`,
    `  문서번호: ${cleanText(item.NTST_DCM_DSCM_CNTN) || "N/A"} / 회신번호: ${cleanText(item.NTST_DCM_RPLY_CNTN) || "N/A"}`,
    `  생산일자: ${normalizeDate(item.DCM_RGT_DTM_S || item.DCM_RGT_DTM)} / 등록일자: ${normalizeDate(item.FRS_RGT_DTM)}`,
  ]
  if (item.NTST_DCM_DCS_CL_NM) lines.push(`  결정: ${item.NTST_DCM_DCS_CL_NM}`)
  if (gist) lines.push(`  요지: ${truncate(gist, 700)}`)
  if (snippet && !gist.includes(snippet)) lines.push(`  검색근거: ${truncate(snippet, 500)}`)
  lines.push("  상세: get_taxlaw_document_text에 위 ID 사용")
  return lines.join("\n")
}

async function searchTaxlawDocuments(args: DocumentSearchArgs, fallbackDocType = "reply"): Promise<ToolResponse> {
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
  const items = uniqueItems.slice(0, asPositiveInt(args.display, 20, 50))

  if (total === 0 || items.length === 0) {
    const label = codes.map((code) => docLabel(code)).join(", ")
    return notFoundResponse(`국세법령정보시스템 '${args.query || "(전체)"}' ${label} 검색 결과가 없습니다.`, [
      "docType을 all 또는 interpretations/disputes로 넓혀 재검색하세요.",
      "통합검색이 필요하면 search_taxlaw_all을 사용하세요.",
      "본 도구는 코드 01–10(세법해석례·과세전적부심사·이의·심사·심판·판례·헌재)만 직접 지원합니다. 법제처 해석례(actionId=ASIBGE004MR03), 감사원 심사청구(ASIPDM001MR01), 납세자보호위원회 심의사례(ASIPRC019MR02), 평가심의사례(ASIBGH004MR01)는 list_taxlaw_site_menus + call_taxlaw_action으로 조회하세요.",
      "korean-law-mcp의 search_decisions(domain=precedent/interpretation/tax_tribunal/constitutional)도 병행 시도하세요. NTS와 법제처는 인덱싱 범위·본문 검색 강도가 달라 한쪽에만 회수되는 사건이 흔합니다(특히 최신 조세심판원 결정례는 NTS, 일부 대법원·헌재 판결은 법제처가 강세).",
    ])
  }

  const title = codes.length === 1 ? docLabel(codes[0]) : codes.map((code) => docLabel(code)).join(", ")
  const lines = [
    `국세법령정보시스템 문서 검색 결과: ${title}`,
    `출처: ${TAXLAW_BASE}/action.do (ASIPDI002PR01)`,
    `검색어: ${args.query || "(전체)"} / 총 ${total.toLocaleString()}건 / page=${asPositiveInt(args.page, 1)}`,
    "주의: 아래 결과는 국세법령정보시스템 응답에 존재한 항목만 표시합니다.",
    "",
  ]
  if (duplicatesRemoved > 0) {
    lines.push(`중복 제거: 같은 문서번호/회신번호/제목으로 보이는 ${duplicatesRemoved.toLocaleString()}건은 표시에서 제외했습니다.`, "")
  }
  if (failedGroups.length > 0) {
    const labels = failedGroups.map((entry) => entry.group.kind === "question" ? "세법해석례/질의회신" : "판례·결정례").join(", ")
    const reasons = failedGroups.map((entry) => entry.reason instanceof Error ? entry.reason.message : String(entry.reason)).join("; ")
    lines.push(`⚠️ 일부 그룹 조회 실패(표시되지 않음): ${labels} — ${reasons}`, "")
  }
  items.forEach((item) => lines.push(formatDocumentSearchItem(item, args.query), ""))
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
      return textResponse(formatDocumentDetail(id, dcm, detail, args.full === true, referer))
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
  ])
}

function formatDocumentDetail(id: string, dcm: TaxlawDcm, detail: TaxlawDetailData["ASIQTB002PR01"], full: boolean, referer: string): string {
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
  if (bodyText) lines.push(full ? "원문 변환 텍스트:" : "원문 요약 텍스트:", compactBodyText(bodyText, full), "")
  if (referencePrecedents.length > 0) {
    lines.push("참조 판례:", ...referencePrecedents.slice(0, 20).map((item) => `  - ${item}`), "")
  }
  if (quotedPrecedents.length > 0) {
    lines.push("인용 판례:", ...quotedPrecedents.slice(0, 20).map((item) => `  - ${item}`), "")
  }

  return truncate(lines.join("\n"), full ? 50000 : 30000)
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
    ])
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
    "",
    stringifyJson(data, args.full === true),
  ]
  return textResponse(lines.join("\n"))
}

function isEmptyPayload(data: unknown): boolean {
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

async function listTaxlawBasicRulingLaws(args: BasicRulingLawArgs): Promise<ToolResponse> {
  const data = await postTaxlawAction<BasicRulingData>("ASISTD001MR01", {}, "/st/USESTD001M.do")
  const query = cleanText(args.query).toLowerCase()
  const laws = (data.ASISTD001MR01?.bscExrDVOList || [])
    .filter((item) => !query || cleanText(item.ntstNm).toLowerCase().includes(query))

  if (laws.length === 0) {
    return notFoundResponse(`기본통칙 법령 목록에서 '${args.query || "(전체)"}' 결과가 없습니다.`)
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

  const query = cleanText(args.query).toLowerCase()
  const allItems = [
    ...(data.ASISTD001MR02?.bscExrDVOList || []),
    ...(data.ASISTD001MR02?.bscExrDVOArList || []),
  ]
  const textItems = allItems
    .filter((item) => item.lawClCd === "5" || cleanText(htmlToText(item.ntstTextCntn || "")))
    .filter((item) => {
      if (!query) return true
      return `${cleanText(item.ntstTextNm)} ${cleanText(htmlToText(item.ntstTextCntn || ""))}`.toLowerCase().includes(query)
    })

  if (textItems.length === 0) {
    return notFoundResponse(`기본통칙 ${lawId}/${year}에서 '${args.query || "(전체)"}' 항목을 찾을 수 없습니다.`, [
      "list_taxlaw_basic_ruling_laws로 lawId를 확인하세요.",
      "year를 비우면 최신 연도로 조회합니다.",
    ])
  }

  const shown = args.full ? textItems : textItems.slice(0, display)
  const lines = [
    `국세법령정보시스템 기본통칙 본문`,
    `출처: ${TAXLAW_BASE}/st/USESTD002M.do?ntstBscId=${encodeURIComponent(lawId)}`,
    `lawId: ${lawId} / year: ${year} / 검색어: ${args.query || "(전체)"}`,
    `총 ${textItems.length.toLocaleString()}개 중 ${shown.length.toLocaleString()}개 표시`,
    "",
  ]

  for (const item of shown) {
    const body = htmlToText(item.ntstTextCntn || "")
    lines.push(`[${item.ntstExrBaseSn || "N/A"}] ${cleanText(item.ntstTextNm) || "N/A"}`)
    if (body) lines.push(truncate(body, args.full ? 3000 : 1200))
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
    return notFoundResponse(`국세법령정보시스템 별표/서식 '${args.query || "(전체)"}' 검색 결과가 없습니다.`)
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
    ])
  }

  const enrichedList = await Promise.all(list.map(enrichPublicationItem))
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

async function handleToolCall(name: string, args: unknown): Promise<ToolResponse> {
  try {
    const input = (args || {}) as AnyRecord
    if (name === "search_taxlaw_all") {
      return await searchTaxlawAll(input as IntegratedSearchArgs)
    }
    if (name === "search_taxlaw_documents") {
      return await searchTaxlawDocuments(input as DocumentSearchArgs)
    }
    if (name === "get_taxlaw_document_text") {
      return await getTaxlawDocumentText(input as DocumentDetailArgs)
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
    return textResponse(`[${ErrorCodes.INVALID_PARAM}] Unknown tool: ${name}`, true)
  } catch (error) {
    return formatToolError(error, name)
  }
}

const server = new Server(
  { name: "taxlaw-nts", version: VERSION },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

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

main().catch((error) => {
  console.error("Server error:", error)
  process.exit(1)
})
