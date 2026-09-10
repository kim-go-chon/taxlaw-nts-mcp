import { test } from "node:test"
import { strict as assert } from "node:assert"

process.env.TAXLAW_MCP_TEST_MODE = "1"

const {
  truncate,
  budgetedJoin,
  fitBlocks,
  decodeHtml,
  htmlToText,
  cleanText,
  normalizeDate,
  normalizeDetailId,
  normalizeDocumentNumber,
  matchDocumentNumber,
  toolStatusFromText,
  visibleTools,
  handleToolCall,
  refererForDoc,
  normalizeTaxlawPath,
  documentDateValue,
  documentDedupKey,
  isEmptyPayload,
  tokenizeQuery,
  matchesAllTokens,
  detectHoldingTruncation,
  buildLaterRevisionGuard,
  buildInterpretiveForkGuard,
  normalizeArticleForCompare,
  findArticleInXml,
  classifyAgainstCurrent,
  filterVersionsByName,
  lawNameKey,
  extractNtsCitations,
  findUnparsedCitationTokens,
  propTokens,
  propositionFit,
  isNegativeProposition,
  classifyNoHitOutcome,
  findUnmatchedClaims,
  redactSecrets,
  classifyVerdict,
  buildApplicationTimingGuard,
  todayYmd,
  parseLawAddenda,
  extractCdataText,
  classifyApplicationClause,
  targetYearApplicationNote,
  extractJoClauses,
  extractEnforceDate,
  mergeAddendaUnits,
  detectAddendumRevisionTails,
  parseLawRevisionText,
  pickVersionByPromulgation,
  pickVersionInForce,
  normalizeEfYd,
  extractArticleBody,
  pruneEmpty,
  remainingBudgetMs,
  compactBodyText,
  TaxlawMcpError,
  ErrorCodes,
} = await import("../build/index.js")

test("truncate: returns input when under limit", () => {
  assert.equal(truncate("abc", 10), "abc")
})

test("truncate: appends marker when over limit", () => {
  const out = truncate("a".repeat(20), 5)
  assert.equal(out.startsWith("aaaaa"), true)
  assert.match(out, /\[truncated to 5 chars\]/)
})

test("detectHoldingTruncation: 판례·결정례 잘림 → full=true 재조회 경고", () => {
  const out = detectHoldingTruncation({
    code: "08", // 심판청구
    fullBody: "주 문\n...본문...\n3. 심리 및 판단\n...판단된다",
    shownBody: "주 문\n...본문...[truncated to 8,000 chars]",
    isFull: false,
  }).join("\n")
  assert.match(out, /판단·결론부 확인/)
  assert.match(out, /full=true/)
  assert.match(out, /요지-결과 정합성/)
})

test("detectHoldingTruncation: 잘리지 않아도 판례면 요지-결과 정합성 가드 부착", () => {
  const out = detectHoldingTruncation({
    code: "09", // 판례
    fullBody: "짧은 본문",
    shownBody: "짧은 본문",
    isFull: false,
  })
  assert.equal(out.length > 0, true)
  assert.match(out.join("\n"), /요지-결과 정합성/)
  assert.equal(/full=true로 재조회/.test(out.join("\n")), false) // 잘림 강제경고는 없음
})

test("detectHoldingTruncation: 질의·해석례(비-쟁송)·full·빈본문은 무경고", () => {
  assert.deepEqual(detectHoldingTruncation({ code: "01", fullBody: "x", shownBody: "x", isFull: false }), [])
  assert.deepEqual(detectHoldingTruncation({ code: "08", fullBody: "x", shownBody: "x", isFull: true }), [])
  assert.deepEqual(detectHoldingTruncation({ code: "08", fullBody: "", shownBody: "", isFull: false }), [])
})

// v0.21.0(#G5) — 해석례(01~04) 회신 tail 소실 가드
test("detectHoldingTruncation(#G5): 해석례 본문 잘림 + 회신 필드 빈값 → tail 소실 경고", () => {
  const out = detectHoldingTruncation({
    code: "02", // 질의회신
    fullBody: "a".repeat(9000),
    shownBody: "a".repeat(100) + "[truncated to 8,000 chars]",
    isFull: false,
    structuredReply: "",
  }).join("\n")
  assert.match(out, /회신·결론부 확인 \(해석례\)/)
  assert.match(out, /해석례 tail 소실/)
  assert.match(out, /full=true/)
})

test("detectHoldingTruncation(#G5): 해석례 잘려도 회신 필드가 채워졌으면 무경고(결론 전량 표시)", () => {
  assert.deepEqual(
    detectHoldingTruncation({
      code: "02",
      fullBody: "a".repeat(9000),
      shownBody: "a".repeat(100),
      isFull: false,
      structuredReply: "회신: 과세대상에 해당한다.",
    }),
    [],
  )
})

test("detectHoldingTruncation(#G5): 해석례 안 잘렸거나 full이면 무경고", () => {
  assert.deepEqual(detectHoldingTruncation({ code: "03", fullBody: "짧은본문", shownBody: "짧은본문", isFull: false, structuredReply: "" }), [])
  assert.deepEqual(detectHoldingTruncation({ code: "02", fullBody: "a".repeat(9000), shownBody: "a".repeat(100), isFull: true, structuredReply: "" }), [])
})

test("decodeHtml: standard entities", () => {
  assert.equal(decodeHtml("&lt;b&gt;hi&lt;/b&gt;"), "<b>hi</b>")
  assert.equal(decodeHtml("a&nbsp;b"), "a b")
  assert.equal(decodeHtml("&quot;x&quot;"), '"x"')
  assert.equal(decodeHtml("&#39;y&#39;"), "'y'")
})

test("decodeHtml: numeric and hex entities", () => {
  assert.equal(decodeHtml("&#48;&#x41;"), "0A")
})

test("decodeHtml: ampersand decoded last", () => {
  assert.equal(decodeHtml("&amp;lt;"), "&lt;")
})

test("htmlToText: strips tags and preserves block breaks on closing tags", () => {
  const html = "<div>line1</div><div>line2</div><br/>line3"
  const lines = htmlToText(html).split("\n").filter(Boolean)
  assert.deepEqual(lines, ["line1", "line2", "line3"])
})

test("htmlToText: removes script/style", () => {
  const html = "<script>alert(1)</script><div>visible</div><style>.x{}</style>"
  assert.equal(htmlToText(html), "visible")
})

test("htmlToText: removes img tags", () => {
  assert.equal(htmlToText("<p>hi<img src=x>there</p>"), "hithere")
})

test("cleanText: strips HS/HE highlight markers", () => {
  assert.equal(cleanText("foo<!HS>bar<!HE>baz"), "foobarbaz")
})

test("cleanText: handles HTML inside", () => {
  assert.equal(cleanText("<b>hello</b>"), "hello")
})

test("cleanText: collapses whitespace", () => {
  assert.equal(cleanText("a   b\n\nc"), "a b c")
})

test("cleanText: nullish becomes empty", () => {
  assert.equal(cleanText(null), "")
  assert.equal(cleanText(undefined), "")
})

test("normalizeDate: 8-digit input", () => {
  assert.equal(normalizeDate("20240315"), "2024.03.15")
})

test("normalizeDate: 14-digit input", () => {
  assert.equal(normalizeDate("20240315120000"), "2024.03.15")
})

test("normalizeDate: short input returns N/A", () => {
  assert.equal(normalizeDate("2024"), "N/A")
  assert.equal(normalizeDate(""), "N/A")
})

test("normalizeDetailId: strips 001_ prefix", () => {
  assert.equal(normalizeDetailId("001_200000000000019482"), "200000000000019482")
})

test("normalizeDetailId: passes through unprefixed", () => {
  assert.equal(normalizeDetailId("200000000000019482"), "200000000000019482")
})

test("normalizeDetailId: trims whitespace", () => {
  assert.equal(normalizeDetailId("  001_123  "), "123")
})

test("normalizeDocumentNumber: 표기 구분자를 정규화", () => {
  assert.equal(normalizeDocumentNumber(" 서면-2024-법규부가-4804 "), "서면2024법규부가4804")
  assert.equal(normalizeDocumentNumber("조심 2023 서 9465"), "조심2023서9465")
})

test("matchDocumentNumber: 문서번호·회신번호 완전일치만 허용", () => {
  assert.equal(matchDocumentNumber({ NTST_DCM_DSCM_CNTN: "조심-2023-서-9465" }, "조심 2023 서 9465"), "document")
  assert.equal(matchDocumentNumber({ ntstDcmRplyCntn: "부가-1" }, "부가1"), "reply")
  assert.equal(matchDocumentNumber({ NTST_DCM_DSCM_CNTN: "조심-2023-서-9465" }, "조심-2023-서-94650"), null)
  assert.equal(matchDocumentNumber({ NTST_DCM_DSCM_CNTN: "조심-2023-서-9465" }, ""), null)
})

test("toolStatusFromText: 기존 마커를 기계 판독 상태로 변환", () => {
  assert.equal(toolStatusFromText("[NOT_FOUND] 없음", true), "NOT_FOUND")
  assert.equal(toolStatusFromText("[INVALID_PARAMETER] 잘못된 값", true), "INVALID_INPUT")
  assert.equal(toolStatusFromText("[EXTERNAL_API_ERROR] upstream", true), "UPSTREAM_ERROR")
  assert.equal(toolStatusFromText("[BUDGET_EXCEEDED] timeout", true), "BUDGET_EXCEEDED")
  assert.equal(toolStatusFromText("정상 응답"), "OK")
  assert.equal(toolStatusFromText("오류", true), "UPSTREAM_ERROR")
})

test("get_taxlaw_document_by_number: 공개 도구 스키마와 invalid 입력 상태", async () => {
  const tool = visibleTools().find((entry) => entry.name === "get_taxlaw_document_by_number")
  assert.ok(tool)
  assert.deepEqual(tool.inputSchema.required, ["docNo"])
  const result = await handleToolCall("get_taxlaw_document_by_number", { docNo: "" })
  assert.equal(result.isError, true)
  assert.deepEqual(result.structuredContent, { status: "INVALID_INPUT" })
})

test("normalizeTaxlawPath: accepts /path", () => {
  assert.equal(normalizeTaxlawPath("/index.do"), "/index.do")
  assert.equal(normalizeTaxlawPath("/qt/USEQTA002P.do?ntstDcmId=abc"), "/qt/USEQTA002P.do?ntstDcmId=abc")
})

test("normalizeTaxlawPath: rejects paths without leading slash", () => {
  assert.throws(() => normalizeTaxlawPath("index.do"), TaxlawMcpError)
})

test("normalizeTaxlawPath: empty string uses fallback", () => {
  assert.equal(normalizeTaxlawPath(""), "/index.do")
  assert.equal(normalizeTaxlawPath("", "/custom.do"), "/custom.do")
})

test("normalizeTaxlawPath: rejects protocol-relative //evil", () => {
  assert.throws(() => normalizeTaxlawPath("//evil.com/foo"), TaxlawMcpError)
})

test("normalizeTaxlawPath: rejects absolute https://", () => {
  assert.throws(() => normalizeTaxlawPath("https://evil.com/foo"), TaxlawMcpError)
})

test("normalizeTaxlawPath: error code is INVALID_PARAMETER", () => {
  try {
    normalizeTaxlawPath("evil")
    assert.fail("should have thrown")
  } catch (e) {
    assert.equal(e instanceof TaxlawMcpError, true)
    assert.equal(e.code, ErrorCodes.INVALID_PARAM)
  }
})

// v0.21.0(#G10) — 제어문자(C0·DEL) 스트립 심화방어
test("normalizeTaxlawPath: strips control characters", () => {
  assert.equal(normalizeTaxlawPath("/qt\x00/USE\x1fQTA.do"), "/qt/USEQTA.do")
  assert.equal(normalizeTaxlawPath("/a\x7fb.do"), "/ab.do")
})

test("normalizeTaxlawPath: control-only input throws (no silent fallback)", () => {
  assert.throws(() => normalizeTaxlawPath("\x00\x1f"), TaxlawMcpError)
})

test("documentDateValue: prefers DCM_RGT_DTM_S", () => {
  assert.equal(documentDateValue({ DCM_RGT_DTM_S: "20240315120000", DCM_RGT_DTM: "20230101000000" }), 20240315120000)
})

test("documentDateValue: falls back to FRS_RGT_DTM", () => {
  assert.equal(documentDateValue({ FRS_RGT_DTM: "20231231" }), 20231231)
})

test("documentDateValue: no date fields → 0", () => {
  assert.equal(documentDateValue({}), 0)
})

test("documentDedupKey: same doc no produces same key", () => {
  const a = { NTST_DCM_CL_CD: "02", NTST_TLAW_CL_NM: "법인세", NTST_DCM_DSCM_CNTN: "서면-2024-법규법인-1234", TTL: "title" }
  const b = { NTST_DCM_CL_CD: "02", NTST_TLAW_CL_NM: "법인세", NTST_DCM_DSCM_CNTN: "서면-2024-법규법인-1234", TTL: "title" }
  assert.equal(documentDedupKey(a), documentDedupKey(b))
})

test("documentDedupKey: different doc no produces different key", () => {
  const a = { NTST_DCM_CL_CD: "02", NTST_DCM_DSCM_CNTN: "doc-1", TTL: "x" }
  const b = { NTST_DCM_CL_CD: "02", NTST_DCM_DSCM_CNTN: "doc-2", TTL: "x" }
  assert.notEqual(documentDedupKey(a), documentDedupKey(b))
})

test("documentDedupKey: pads single-digit code to 2 digits", () => {
  const a = { NTST_DCM_CL_CD: "2", NTST_DCM_DSCM_CNTN: "doc-1", TTL: "x" }
  const b = { NTST_DCM_CL_CD: "02", NTST_DCM_DSCM_CNTN: "doc-1", TTL: "x" }
  assert.equal(documentDedupKey(a), documentDedupKey(b))
})

test("documentDedupKey: lowercases output", () => {
  const k = documentDedupKey({ TTL: "ABC", NTST_DCM_CL_CD: "01" })
  assert.equal(k, k.toLowerCase())
})

test("isEmptyPayload: null/undefined", () => {
  assert.equal(isEmptyPayload(null), true)
  assert.equal(isEmptyPayload(undefined), true)
})

test("isEmptyPayload: empty array/object/string", () => {
  assert.equal(isEmptyPayload([]), true)
  assert.equal(isEmptyPayload({}), true)
  assert.equal(isEmptyPayload(""), true)
  assert.equal(isEmptyPayload("   "), true)
})

test("isEmptyPayload: nested empty", () => {
  assert.equal(isEmptyPayload({ a: { b: [] }, c: "" }), true)
})

test("isEmptyPayload: number/boolean/non-empty string is non-empty", () => {
  assert.equal(isEmptyPayload(0), false)
  assert.equal(isEmptyPayload(false), false)
  assert.equal(isEmptyPayload("hi"), false)
  assert.equal(isEmptyPayload({ a: 1 }), false)
  assert.equal(isEmptyPayload([0]), false)
})

test("tokenizeQuery: splits whitespace and middle dot", () => {
  assert.deepEqual(tokenizeQuery("연구·인력개발비 세액공제"), ["연구", "인력개발비", "세액공제"])
})

test("tokenizeQuery: collapses duplicates", () => {
  assert.deepEqual(tokenizeQuery("가지급금 가지급금 인정이자"), ["가지급금", "인정이자"])
})

test("tokenizeQuery: empty/whitespace returns empty array", () => {
  assert.deepEqual(tokenizeQuery(""), [])
  assert.deepEqual(tokenizeQuery("   "), [])
  assert.deepEqual(tokenizeQuery(null), [])
})

test("matchesAllTokens: empty token list always true", () => {
  assert.equal(matchesAllTokens("아무 텍스트", []), true)
})

test("matchesAllTokens: all tokens must be present", () => {
  const tokens = tokenizeQuery("가지급금 인정이자")
  assert.equal(
    matchesAllTokens("법인이 그 대표자에게 업무무관 가지급금을 계상하고 당해 가지급금에 대한 인정이자를 계산하는 중에", tokens),
    true,
  )
  assert.equal(matchesAllTokens("가지급금만 있고 다른 키워드는 없음", tokens), false)
})

test("matchesAllTokens: collapsed form catches spacing/middle-dot variants", () => {
  const tokens = tokenizeQuery("연구·인력개발비")
  assert.equal(matchesAllTokens("연구인력개발비 세액공제 대상", tokens), true)
  assert.equal(matchesAllTokens("연구 인력 개발비 세액공제", tokens), true)
})

// v0.9.15: 법제처 DRF 부칙 파서
const ADDENDA_SAMPLE_XML = [
  "<조문단위><조문번호>1</조문번호></조문단위>",
  "<부칙>",
  "<부칙단위 부칙키=\"2026052236342\">",
  "<부칙공포일자>20260522</부칙공포일자>",
  "<부칙공포번호>36342</부칙공포번호>",
  "<부칙내용><![CDATA[부칙 <제36342호,2026.5.22>]]>",
  "<![CDATA[\n]]>",
  "<![CDATA[제1조(시행일) 이 영은 공포한 날부터 시행한다.]]>",
  "<![CDATA[\n]]>",
  "<![CDATA[제2조(상시근로자 수에 관한 적용례) 제11조의2제8항의 개정규정은 <img src=\"http://x/f.png\">이 영 시행 이후 신고하는 경우부터 적용한다.]]>",
  "</부칙내용>",
  "</부칙단위>",
  "<부칙단위 부칙키=\"2025123135999\">",
  "<부칙공포일자>20251231</부칙공포일자>",
  "<부칙공포번호>35999</부칙공포번호>",
  "<부칙내용><![CDATA[제2조(경과조치) 2025년 과세연도는 종전의 규정에 따른다.]]>",
  "</부칙내용>",
  "</부칙단위>",
  "</부칙>",
].join("\n")

test("parseLawAddenda: 공포번호별 부칙단위 분해 + 일자/번호 추출", () => {
  const units = parseLawAddenda(ADDENDA_SAMPLE_XML)
  assert.equal(units.length, 2)
  const u = units.find((x) => x.promulgationNo === "36342")
  assert.ok(u)
  assert.equal(u.promulgationDate, "20260522")
  assert.match(u.text, /상시근로자|제11조의2제8항/)
})

test("extractCdataText: CDATA 조각 결합 + 리터럴 꺾쇠(부칙 헤더) 보존 + img 마커 치환", () => {
  const units = parseLawAddenda(ADDENDA_SAMPLE_XML)
  const u = units.find((x) => x.promulgationNo === "36342")
  // <제36342호,...> 같은 리터럴 꺾쇠는 태그로 제거되면 안 됨
  assert.ok(u.text.includes("<제36342호,2026.5.22>"))
  // 수식 <img>는 마커로 치환
  assert.ok(u.text.includes("[수식이미지]"))
  assert.ok(!/<img/i.test(u.text))
})

test("parseLawAddenda: <부칙> 노드가 없으면 빈 배열", () => {
  assert.deepEqual(parseLawAddenda("<법령><조문단위></조문단위></법령>"), [])
})

// v0.9.16: trace_article_application 헬퍼
test("classifyApplicationClause: 적용례 유형 분류", () => {
  assert.equal(classifyApplicationClause("제26조의8제6항의 개정규정은 이 영 시행 이후 신고하는 경우부터 적용한다."), "신고시점기준")
  assert.equal(classifyApplicationClause("제11조의2제8항의 개정규정은 2026년 1월 1일 이후 개시하는 과세연도부터 적용한다."), "과세연도개시기준")
  assert.equal(classifyApplicationClause("제26조의8의 개정규정에도 불구하고 종전의 규정에 따른다."), "경과조치(종전규정)")
  assert.equal(classifyApplicationClause("제26조의8제6항의 개정규정은 2025년 1월 1일 이후 개시하는 과세연도를 최초 공제연도로 하여 신청하는 경우부터 적용한다."), "최초공제연도기준")
  assert.equal(classifyApplicationClause("제27조의6의 개정규정은 이 영 시행 이후 증여받는 경우부터 적용한다."), "행위시점기준")
})

test("extractEnforceDate: 시행일 추출", () => {
  assert.equal(extractEnforceDate("부칙 제1조(시행일) 이 영은 공포한 날부터 시행한다.", "20260227"), "2026.2.27(공포일)")
  assert.equal(extractEnforceDate("제1조(시행일) 이 영은 2026년 1월 1일부터 시행한다.", "20251231"), "2026.1.1")
})

test("extractJoClauses: jo+hang 적용례 추출 + 자구정정 제외 + 조단위 경과조치 포함", () => {
  const buchik = [
    "제5조(다른 조문 적용례) 제17조제2항의 개정규정은 이 영 시행 이후 신고하는 경우부터 적용한다.",
    "제11조(통합고용세액공제에 관한 적용례 등) ① 제26조의8제4항제1호의 개정규정은 2025년 1월 1일 이후 개시하는 과세연도를 최초 공제연도로 하여 신청하는 경우부터 적용한다. ③ 제26조의8제6항 및 제7항의 개정규정은 이 영 시행 이후 신고하는 경우부터 적용한다.",
    "제2조(경과조치) 2024년 또는 2025년 과세연도는 제26조의8의 개정규정에도 불구하고 종전의 규정에 따른다.",
    "제9조(다른 법령의 개정) 제26조의8제6항 중 \"갑\"을 \"을\"로 한다.",
  ].join(" ")
  const got = extractJoClauses(buchik, "제26조의8", "제6항")
  const flat = got.map((c) => c.clause.replace(/\s/g, ""))
  // ③(제26조의8제6항 신고시점) 포함
  assert.ok(flat.some((c) => c.includes("제26조의8제6항및제7항") && c.includes("신고하는경우")))
  // 조단위 경과조치 포함(충돌 가시화)
  assert.ok(flat.some((c) => c.includes("종전의규정에따른다")))
  // ①(제4항제1호, hang 불일치) 제외
  assert.ok(!flat.some((c) => c.includes("제26조의8제4항제1호") && !c.includes("제6항")))
  // 자구정정("…로 한다") 제외
  assert.ok(!flat.some((c) => c.includes("\"갑\"을\"을\"로한다") || c.includes("을\"로한다")))
})

test("mergeAddendaUnits: 통합본 누락 부칙을 다른 시행본에서 보강(union·dedup)", () => {
  // 현행(286143)엔 36342 없음, 286209엔 있음 → union에 포함되어야
  const cur = { mst: "286143", units: [
    { promulgationDate: "20260519", promulgationNo: "36338", text: "부칙 36338 ..." },
    { promulgationDate: "20260227", promulgationNo: "36127", text: "부칙 36127 ..." },
  ] }
  const prev = { mst: "286209", units: [
    { promulgationDate: "20260522", promulgationNo: "36342", text: "부칙 36342 절사위치 적용례 ..." },
    { promulgationDate: "20260227", promulgationNo: "36127", text: "부칙 36127 더 긴 본문 ...........(longer)" },
  ] }
  const { units, presence } = mergeAddendaUnits([cur, prev])
  const nos = units.map((u) => u.promulgationNo)
  assert.ok(nos.includes("36342")) // 보강됨
  assert.equal(nos.filter((n) => n === "36127").length, 1) // dedup
  // 최신 공포일순
  assert.equal(units[0].promulgationNo, "36342")
  // 더 긴 본문 채택
  assert.ok(units.find((u) => u.promulgationNo === "36127").text.includes("더 긴 본문"))
  // presence 추적
  assert.deepEqual(presence["36342"], ["286209"])
  assert.deepEqual(presence["36127"], ["286143", "286209"])
})

test("mergeAddendaUnits: 같은 공포번호 부칙이 통합본마다 다르면 최신 통합본 우선(길이 아님) + 빈 본문 배제", () => {
  // 실사례 모델: 제36342호(5.22)가 제36127호 부칙 §11을 자구개정 →
  // 5.19 공포 통합본(286143)엔 개정 전(더 긴) 문구, 5.22 이후 통합본(286209)엔 현행화 문구.
  const older = { mst: "286143", promDate: "20260519", units: [
    { promulgationDate: "20260227", promulgationNo: "36127",
      text: "제11조 ① 제26조의8제4항제1호의 개정규정은 … ③ 제26조의8제6항 및 제7항의 개정규정은 이 영 시행 이후 신고하는 경우부터 적용한다. (개정 전 — 일부러 길게) ................................................." },
  ] }
  const newer = { mst: "286209", promDate: "20260522", units: [
    { promulgationDate: "20260227", promulgationNo: "36127",
      text: "제11조 ① 제26조의8제4항제1호 및 같은 조 제6항의 개정규정은 … <개정 2026.5.22> ③ 제26조의8제7항의 개정규정은 …" },
  ] }
  const { units } = mergeAddendaUnits([older, newer])
  const u = units.find((x) => x.promulgationNo === "36127")
  assert.ok(u.text.includes("같은 조 제6항")) // 구문구가 더 길어도 최신 통합본 채택
  // 더 최신 통합본이라도 빈 본문은 채택하지 않음
  const blank = { mst: "286300", promDate: "20260601", units: [
    { promulgationDate: "20260227", promulgationNo: "36127", text: "" },
  ] }
  const r2 = mergeAddendaUnits([older, newer, blank])
  assert.ok(r2.units.find((x) => x.promulgationNo === "36127").text.includes("같은 조 제6항"))
})

test("parseLawRevisionText: 개정문 CDATA 추출(부칙-of-부칙 자구개정 지시문 포함)", () => {
  const xml = `<법령><부칙><부칙단위>…</부칙단위></부칙><개정문><개정문내용>
<![CDATA[⊙대통령령 제36342호]]>
<![CDATA[
]]>
<![CDATA[조세특례제한법 시행령 일부개정령]]>
<![CDATA[
]]>
<![CDATA[대통령령 제36127호 조세특례제한법 시행령 일부개정령 부칙 제11조제1항 중 "제26조의8제4항제1호"를 "제26조의8제4항제1호 및 같은 조 제6항"으로 하고, 같은 조 제3항 중 "제26조의8제6항 및 제7항"을 "제26조의8제7항"으로 한다.]]>
</개정문내용></개정문></법령>`
  const { kind, text } = parseLawRevisionText(xml)
  assert.equal(kind, "개정문")
  assert.ok(text.includes("⊙대통령령 제36342호"))
  assert.ok(text.includes('부칙 제11조제1항 중 "제26조의8제4항제1호"를 "제26조의8제4항제1호 및 같은 조 제6항"으로'))
})

test("parseLawRevisionText: 개정문 없으면 제정문 fallback, 둘 다 없으면 빈 값", () => {
  assert.equal(parseLawRevisionText("<법령><제정문><![CDATA[제정 지시문]]></제정문></법령>").kind, "제정문")
  assert.equal(parseLawRevisionText("<법령></법령>").kind, "")
  assert.equal(parseLawRevisionText("<법령></법령>").text, "")
})

test("pickVersionByPromulgation: 공포번호/공포일자로 시행본 선택", () => {
  const vs = [
    { mst: "283625", promNo: "36127", promDate: "20260227", enforceDate: "20270101" },
    { mst: "283625", promNo: "36127", promDate: "20260227", enforceDate: "20260701" },
    { mst: "286209", promNo: "36342", promDate: "20260522", enforceDate: "20260522" },
  ]
  assert.equal(pickVersionByPromulgation(vs, "36342").mst, "286209")
  assert.equal(pickVersionByPromulgation(vs, undefined, "2026.5.22").mst, "286209") // 구분자 섞인 날짜 허용
  assert.equal(pickVersionByPromulgation(vs, "36127").mst, "283625") // 시행일 분할 중복은 첫 항목
  assert.equal(pickVersionByPromulgation(vs, "36127", "20260522"), null) // 둘 다 주면 둘 다 일치해야
  assert.equal(pickVersionByPromulgation(vs), null) // 둘 다 없으면 null
})

test("detectAddendumRevisionTails: 부칙 자체개정 <개정> 꼬리표 감지(헤더 리터럴·자기공포일 제외)", () => {
  // 후행 개정 꼬리표 → 감지
  const t1 = "제11조(적용례) ① 제26조의8제4항제1호 및 같은 조 제6항의 개정규정은 2025년 1월 1일 이후 … 적용한다. <개정 2026.5.22>"
  assert.deepEqual(detectAddendumRevisionTails(t1, "20260227"), ["20260522"])
  // 부칙 헤더 리터럴 <제36342호,2026.5.22>는 오탐 금지
  assert.deepEqual(detectAddendumRevisionTails("부칙 <제36342호,2026.5.22> 제1조(시행일) …", "20260522"), [])
  // 자기 공포일 이하 날짜는 후행 개정이 아님 → 제외
  assert.deepEqual(detectAddendumRevisionTails("… 적용한다. <개정 2026.2.27>", "20260227"), [])
  // 복수 날짜·공백 변형 모두 추출(자기 공포일 이후만)
  assert.deepEqual(detectAddendumRevisionTails("… <개정 2026. 2. 27., 2026. 5. 22.> …", "20260101"), ["20260227", "20260522"])
})

test("pickVersionInForce: 기준일에 시행 중이던 버전(시행일 ≤ 기준 중 최신)", () => {
  const vs = [
    { mst: "C", enforceDate: "20260227" },
    { mst: "B", enforceDate: "20251128" },
    { mst: "A", enforceDate: "20250101" },
  ]
  assert.equal(pickVersionInForce(vs, "20251231").mst, "B") // 2025 말 → 2025.11.28본
  assert.equal(pickVersionInForce(vs, "20261231").mst, "C") // 2026 말 → 2026.2.27본
  assert.equal(pickVersionInForce(vs, "20240101"), null) // 그 이전 버전 없음
})

test("buildLaterRevisionGuard: 현행본 조회 + 시행예정 없음 → 무경고", () => {
  const vs = [
    { mst: "B", enforceDate: "20251111", promDate: "20251111" },
    { mst: "A", enforceDate: "20250101", promDate: "20241231" },
  ]
  assert.deepEqual(
    buildLaterRevisionGuard({ versions: vs, usedMst: "B", usedEnforceDate: "20251111", today: "20260612", jo: "제29조의8" }),
    [],
  )
  // versions 미회수(빈 배열) → 가드 생략(soft-skip)
  assert.deepEqual(
    buildLaterRevisionGuard({ versions: [], usedMst: "B", usedEnforceDate: "20251111", today: "20260612", jo: "제29조의8" }),
    [],
  )
})

test("buildLaterRevisionGuard: 구버전 조회 + 조문 변경 감지 → 능동 경고(실측 사고 재현 케이스)", () => {
  // 2026-06-12 실측: year=2025 → MST 279739(시행 2025.11.11) 반환, 현행은 MST 286597(시행 2026.6.2, §29의8③ 삭제)
  const vs = [
    { mst: "286597", enforceDate: "20260602", promDate: "20260602" },
    { mst: "279739", enforceDate: "20251111", promDate: "20251111" },
  ]
  const out = buildLaterRevisionGuard({
    versions: vs, usedMst: "279739", usedEnforceDate: "20251111", today: "20260612",
    jo: "제29조의8", currentArticleVerdict: "differs",
  })
  assert.ok(out[0].includes("── 후행 개정 확인"))
  assert.ok(out.some((l) => l.includes("현행본이 아니다") && l.includes("286597")))
  assert.ok(out.some((l) => l.includes("본문이 변경") && l.includes("단정하지 마라")))
  // diff_article_versions 실제 스키마는 mstA/mstB (mst1/mst2 아님 — 리뷰 검출 회귀 방지)
  assert.ok(out.some((l) => l.includes("diff_article_versions") && l.includes('mstA="279739"') && l.includes('mstB="286597"')))
  assert.ok(!out.some((l) => l.includes("mst1=") || l.includes("mst2=")))
})

test("buildLaterRevisionGuard: missing(삭제·이동)/deleted(날짜 명시)/same(동일)/대조 실패 분기", () => {
  const vs = [
    { mst: "NEW", enforceDate: "20260101", promDate: "20251223" },
    { mst: "OLD", enforceDate: "20250101", promDate: "20241231" },
  ]
  const base = { versions: vs, usedMst: "OLD", usedEnforceDate: "20250101", today: "20260612", jo: "제10조" }
  const missing = buildLaterRevisionGuard({ ...base, currentArticleVerdict: "missing" })
  assert.ok(missing.some((l) => l.includes("찾지 못함") && l.includes("삭제 또는 조문 이동")))
  assert.ok(missing.some((l) => l.includes("1콜 확정") && l.includes("diff_article_versions"))) // 금지+무경로 조합 방지
  const deleted = buildLaterRevisionGuard({ ...base, currentArticleVerdict: "missing", currentDeletedDate: "2019.12.31" })
  assert.ok(deleted.some((l) => l.includes("삭제됨") && l.includes("2019.12.31")))
  const same = buildLaterRevisionGuard({ ...base, currentArticleVerdict: "same", hasFormulaImages: true })
  assert.ok(same.some((l) => l.includes("문구 동일") && l.includes("별도 확인") && l.includes("수식 이미지 내용은 대조 범위 밖")))
  // verdict 미전달(대조 실패) → 직접 확인 지시
  assert.ok(buildLaterRevisionGuard(base).some((l) => l.includes("대조에 실패") && l.includes("diff_article_versions")))
})

test("buildLaterRevisionGuard: 현행본 조회여도 공포-미시행(시행예정) 개정 존재 시 ℹ 법령 단위 경고", () => {
  // 실측 데이터 형태: 조특법 MST 280409(공포 2025.12.23)가 시행 2026.7.1/2027.1.1로 분할 수록
  const vs = [
    { mst: "X27", enforceDate: "20270101", promDate: "20251223" },
    { mst: "X26", enforceDate: "20260701", promDate: "20251223" },
    { mst: "CUR", enforceDate: "20260602", promDate: "20260602" },
  ]
  const out = buildLaterRevisionGuard({ versions: vs, usedMst: "CUR", usedEnforceDate: "20260602", today: "20260612", jo: "제29조의8" })
  assert.ok(out[0].includes("── 후행 개정 확인"))
  assert.ok(out.some((l) => l.startsWith("ℹ") && l.includes("공포-미시행(시행예정) 개정 2건") && l.includes("법령 단위")))
  // v0.12.0 — 현행본 조회의 상시 신호는 1줄 압축(최단 시행분만 표기)
  assert.ok(out.some((l) => l.includes("시행 2026.7.1") && l.includes("X26")))
  assert.ok(out.some((l) => l.includes("미래 귀속 결론 전") && l.includes("diff_article_versions")))
  assert.equal(out.filter((l) => l.includes("공포-미시행")).length, 1)
  // 현행본이 아니라는 오경고는 없어야 함
  assert.ok(!out.some((l) => l.includes("현행본이 아니다")))
})

test("buildLaterRevisionGuard: pending은 시행일별 최신 공포본만(superseded 옛 통합본 행 배제 — 리뷰 검출)", () => {
  // 실측: 시행 2027.1.1 행이 5개 MST로 중복(280409=2025.12.23 공포가 최신, 나머지는 옛 공포본)
  const vs = [
    { mst: "212779", enforceDate: "20270101", promDate: "20191231" },
    { mst: "280409", enforceDate: "20270101", promDate: "20251223" },
    { mst: "267555", enforceDate: "20270101", promDate: "20241231" },
    { mst: "CUR", enforceDate: "20260602", promDate: "20260602" },
  ]
  const out = buildLaterRevisionGuard({ versions: vs, usedMst: "CUR", usedEnforceDate: "20260602", today: "20260612", jo: "제29조의8" })
  assert.ok(out.some((l) => l.includes("개정 1건") && l.includes("280409"))) // 3행 → 1건(최신 공포본)
  assert.ok(!out.some((l) => l.includes("212779") || l.includes("267555"))) // 옛 공포본 미노출
  assert.ok(!out.some((l) => l.includes("efYd=시행일"))) // 자기모순 지시 제거(분할시행은 efYd로 도달 불가)
})

test("buildLaterRevisionGuard: 시행예정본을 의도 조회 → '구버전' 프레임 대신 ℹ 적용 방향 안내(리뷰 검출)", () => {
  const vs = [
    { mst: "FUT", enforceDate: "20270101", promDate: "20251223" },
    { mst: "CUR", enforceDate: "20260602", promDate: "20260602" },
  ]
  const out = buildLaterRevisionGuard({ versions: vs, usedMst: "FUT", usedEnforceDate: "20270101", today: "20260612", jo: "제29조의8" })
  assert.ok(out.some((l) => l.startsWith("ℹ") && l.includes("시행예정본") && l.includes("시행일 이후 귀속연도에는 이 본문을 적용")))
  assert.ok(!out.some((l) => l.includes("현행본이 아니다") || l.includes("단정하지 마라")))
})

test("lawNameKey/filterVersionsByName: 교차법령(시행령) 행 배제, 일치 0건이면 후보 제외", () => {
  const vs = [
    { mst: "1", enforceDate: "20250423", promDate: "20250422", lawName: "가상자산 이용자 보호 등에 관한 법률 시행령" },
    { mst: "2", enforceDate: "20240719", promDate: "20230718", lawName: "가상자산 이용자 보호 등에 관한 법률" },
  ]
  const own = filterVersionsByName(vs, "가상자산 이용자 보호 등에 관한 법률")
  assert.equal(own.length, 1)
  assert.equal(own[0].mst, "2") // 시행령 행 배제 — 시행령을 '현행본'으로 오판하던 결함
  assert.equal(filterVersionsByName(vs, "전혀 다른 법").length, 0) // 정확 제명 미확인 후보 제외
  assert.equal(lawNameKey("조세특례제한법  시행령"), "조세특례제한법시행령")
})

test("findArticleInXml: 본문/삭제/부칙 오매칭 배제(리뷰 검출 — 부칙 bare CDATA에 제목형 시작 패턴 존재)", () => {
  const xml = [
    '<조문단위><조문내용><![CDATA[제8조(다른 조문)]]></조문내용></조문단위>',
    '<조문단위><조문내용><![CDATA[제9조 삭제 <2019.12.31>]]></조문내용></조문단위>',
    '<조문단위><조문내용><![CDATA[제10조(존치 조문)]]><항내용><![CDATA[① 내용]]></항내용></조문단위>',
    '<부칙단위><부칙내용><![CDATA[제9조(자기관리 부동산투자회사 등에 대한 과세특례) 부칙 본문…]]></부칙내용></부칙단위>',
  ].join("\n")
  const found = findArticleInXml(xml, "제10조")
  assert.equal(found.status, "found")
  assert.ok(found.block.includes("존치 조문"))
  const del = findArticleInXml(xml, "제9조") // 부칙 CDATA의 '제9조(…' 에 오매칭되면 안 됨
  assert.equal(del.status, "deleted")
  assert.equal(del.deletedDate, "2019.12.31")
  assert.equal(findArticleInXml(xml, "제99조").status, "missing")
  // 제10조 탐색이 제100조류에 오매칭되지 않는지
  const xml2 = '<조문단위><조문내용><![CDATA[제100조(다른 조)]]></조문내용></조문단위>'
  assert.equal(findArticleInXml(xml2, "제10조").status, "missing")
})

test("normalizeArticleForCompare: flSeq 상이한 동일 수식은 동일 판정, 실질 변경은 검출", () => {
  const a = "① 계산식 [수식이미지→https://www.law.go.kr/DRF/flDownload.do?flSeq=111] 에 따른다."
  const b = "① 계산식  [수식이미지→https://www.law.go.kr/DRF/flDownload.do?flSeq=999] 에\n따른다."
  assert.equal(normalizeArticleForCompare(a), normalizeArticleForCompare(b)) // flSeq·공백 차이는 무시
  const c = "① 계산식 [수식이미지→…flSeq=111] 에 따르되, 단서를 둔다."
  assert.notEqual(normalizeArticleForCompare(a), normalizeArticleForCompare(c)) // 실질 변경은 검출
})

test("extractNtsCitations: 해석례 신형/구형/부서형·심판례·법원·기본통칙 추출 + 일반어 오탐 차단 + dedup", () => {
  const text = [
    "서면-2024-법규부가-4804 및 서면-2024-법규부가-4804(중복)에 따르면,",
    "부가46015-2833(1997)과 서면법규과-1284도 참조. 기획재정부 부가가치세제과-456 회신.",
    "조심2013서1471, 국심2005서1234 및 대법원 2021두39997, 수원고법 2023누15045 판결.",
    "부가가치세법 기본통칙 10-0-5(옛 표기) 및 기본통칙 10-0…5.",
    "검토 결과-12건이 나왔고 업무 성과-3을 기록했다.", // 오탐 차단 대상
  ].join("\n")
  const cits = extractNtsCitations(text)
  const raws = cits.map((c) => c.raw)
  assert.equal(raws.filter((r) => r.includes("법규부가")).length, 1) // dedup
  assert.ok(raws.includes("부가46015-2833"))
  assert.ok(raws.includes("서면법규과-1284"))
  assert.ok(raws.includes("부가가치세제과-456"))
  assert.ok(raws.includes("조심2013서1471") && raws.includes("국심2005서1234"))
  assert.ok(raws.includes("2021두39997") && raws.includes("2023누15045"))
  assert.equal(cits.filter((c) => c.kind === "basic_rule").length, 2)
  assert.ok(!raws.some((r) => r.includes("결과") || r.includes("성과"))) // 일반어 '결과-12' 차단
  const court = cits.find((c) => c.raw === "2021두39997")
  assert.equal(court.kind, "court")
  assert.equal(court.normalized, "2021두39997")
})

test("extractNtsCitations(P1): 하이픈형 조심·지방청 이의신청·감심 추출 — 오인용 사고(조심-2024-인-2328 침묵누락) 재발방지", () => {
  const text = "조심-2024-서-5990, 조심-2024-인-2328, 이의-부산청-2024-0108, 조심2025서2156, 감심2010-123 참조."
  const norms = extractNtsCitations(text).map((c) => c.normalized)
  assert.ok(norms.includes("조심2024서5990"), "하이픈형 조심(서)")
  assert.ok(norms.includes("조심2024인2328"), "하이픈형 조심(인) — 오인용 당사자")
  assert.ok(norms.includes("이의부산청20240108"), "지방청 이의신청")
  assert.ok(norms.includes("조심2025서2156"), "압축형 조심 회귀")
  assert.ok(norms.includes("감심2010123"), "감심 하이픈")
})

test("findUnparsedCitationTokens(P2): 정밀추출이 놓친 인용형 토큰만 노출, 추출된 것은 제외(침묵누락 가시화)", () => {
  const text = "조심-2024-서-5990 인용. 그리고 적부-국세청-2099-9999 도 있음."
  const extracted = extractNtsCitations(text)
  const unparsed = findUnparsedCitationTokens(text, extracted)
  // 조심-2024-서-5990은 P1로 추출 → unparsed 제외
  assert.ok(!unparsed.some((u) => u.replace(/[\s-]/g, "").includes("조심2024서5990")), "추출된 인용은 미추출 경고에서 제외")
  // 적부-국세청-...는 정밀 추출 대상 아님 → unparsed로 노출
  assert.ok(unparsed.some((u) => u.includes("적부")), "미인식 포맷은 ⚠ 노출")
})

test("propTokens(G1): 조사 제거·길이≥2·중복제거", () => {
  const toks = propTokens("공동경비를 매출액 비율로 안분, 손금 산입 / 매출액 기준")
  assert.ok(toks.includes("공동경비"), "조사 '를' 제거")
  assert.ok(toks.includes("매출액"), "매출액(로 제거)")
  assert.ok(toks.includes("비율"), "비율")
  assert.ok(toks.includes("안분"), "안분")
  assert.ok(!toks.includes("를") && !toks.includes("이") && !toks.includes("에"), "1자 조사 배제")
  assert.equal(new Set(toks).size, toks.length, "중복(매출액 2회) 제거")
})

test("propTokens(#4): 조사 동형 종성 명사 보존(어간 잔여≥2 가드) — 결과/효과/평가/제도/증가", () => {
  // 이전 버그: '제도'→'제', '결과'→'결', '효과'→'효', '평가'→'평', '증가'→'증'으로 1글자 탈락
  for (const w of ["제도", "결과", "효과", "평가", "증가", "온도", "속도"]) {
    assert.ok(propTokens(`쟁점은 ${w}`).includes(w), `'${w}' 보존(어간 잔여<2라 절삭 안 함)`)
  }
  // 곡용형(어간 잔여≥2)은 기존대로 조사 절삭
  assert.ok(propTokens("제도의 취지").includes("제도"), "'제도의'→'제도'(조사 '의' 절삭)")
  assert.ok(propTokens("공동경비를 안분").includes("공동경비"), "'공동경비를'→'공동경비' 회귀 유지")
  // 순명제(동형종성 명사만)에서도 토큰이 살아 propositionFit이 무조건 1을 반환하지 않음
  assert.ok(propTokens("증가 효과").length >= 2, "동형종성 명사만으로도 토큰 확보(fit=1 blind spot 방지)")
})

test("refererForDoc(#7): 원문 URL id를 normalizeDetailId로 정규화(001_ 접두 제거)", () => {
  // 001_ 접두 DOC_ID → canonical id로 정규화된 링크
  assert.ok(refererForDoc("09", "001_200000000000019482").includes("ntstDcmId=200000000000019482"), "판례(09)=/pd, 001_ 제거")
  assert.ok(refererForDoc("09", "001_123").startsWith("/pd/USEPDA002P.do"), "05~10 코드는 /pd 경로")
  assert.ok(refererForDoc("02", "001_456").startsWith("/qt/USEQTA002P.do"), "01~04 코드는 /qt 경로")
  // 이미 정규화된 id는 멱등(무변경)
  assert.ok(refererForDoc("02", "200000000000019482").includes("ntstDcmId=200000000000019482"), "정규 id는 멱등")
})

test("propositionFit(G1): 명제 적합 케이스 vs 오귀속 케이스 분리(임계 0.4)", () => {
  // 적합: 주장 토큰이 본문에 대부분 등장
  const body = norm("청구법인의 공동경비를 직전 사업연도 매출액 비율로 안분하여 손금불산입한 처분은 정당함")
  const fitHi = propositionFit("공동경비를 매출액 비율로 안분", body)
  assert.ok(fitHi >= 0.4, `적합 케이스 fit=${fitHi} (≥0.4 기대)`)
  // 오귀속(이번 세션 사고형): 사용료소득 사건 본문에 §48 공동경비 배부 주장 토큰이 거의 없음
  const royaltyBody = norm("외국법인의 글로벌 마케팅 분담금이 사용료소득에 해당하는지 여부 — 상표권 국내 사용 대가로 보기 어려움")
  const fitLo = propositionFit("공동경비를 §48 매출액 비율로 안분하는 정상 배부방식", royaltyBody)
  assert.ok(fitLo < 0.4, `오귀속 케이스 fit=${fitLo} (<0.4 기대 → ⚠⚠ 발동)`)
  function norm(s) { return s.replace(/[\s\-–—.·]/g, "").toLowerCase() }
})

test("extractNtsCitations(#E8): 법원 병합 사건번호 — '2021두39997, 39998'의 39998도 동일 연도·접두로 개별 추출", () => {
  const norms = extractNtsCitations("대법원 2021두39997, 39998 판결 참조.").map((c) => c.normalized)
  assert.ok(norms.includes("2021두39997"), "주 사건번호")
  assert.ok(norms.includes("2021두39998"), "병합 꼬리번호도 재구성(종전 침묵 드롭)")
})

test("extractNtsCitations(#E8): 콤마 뒤 별개 인용(연도로 시작)은 병합 흡수 안 함", () => {
  const norms = extractNtsCitations("대법원 2021두39997, 2020구합1234 판결.").map((c) => c.normalized)
  assert.ok(norms.includes("2021두39997"), "첫 인용")
  assert.ok(norms.includes("2020구합1234"), "두 번째 인용은 별개 유지")
  assert.ok(!norms.includes("2021두2020"), "다음 인용 연도를 꼬리번호로 오흡수하지 않음")
})

test("propositionFit(#G4): 핵심어가 전부 불용어·숫자면 -1(판정불가) 반환 — 종전 1(완벽일치 둔갑) 회귀 방지", () => {
  assert.equal(propositionFit("해당 여부 관련 2024", "아무 본문"), -1, "유효 토큰 0개 → -1")
  const f = propositionFit("공동경비 안분", "청구법인의 공동경비를 안분")
  assert.ok(f >= 0 && f <= 1, `정상 명제 fit=${f} (0~1)`)
})

test("isNegativeProposition(#E7): 확장 부정형 어휘 감지 + '부정당' lookahead 제외 + 긍정형 false", () => {
  for (const p of ["…로 보기 어렵다", "쟁점과 무관하다", "성격이 다르다", "규정에 반한다", "법령을 위반", "부정한 방법"]) {
    assert.equal(isNegativeProposition(p), true, `부정형 감지: ${p}`)
  }
  assert.equal(isNegativeProposition("해당하지 아니한다"), true, "기존 어휘 회귀(아니/해당하지)")
  assert.equal(isNegativeProposition("부정당 지정 처분"), false, "'부정당'은 부정(?!당)으로 제외")
  assert.equal(isNegativeProposition("사용료소득에 해당한다"), false, "긍정형은 false")
})

test("classifyNoHitOutcome(#G1): 전 그룹 실패=판정불가·원장미기록 / 일부 실패=미발견 불완전·원장미기록 / 무실패=미발견 기록", () => {
  assert.deepEqual(classifyNoHitOutcome(2, 2), { tally: "failed", writeLedger: false, incomplete: true }, "전 그룹 reject → 판정불가")
  assert.deepEqual(classifyNoHitOutcome(1, 2), { tally: "notFound", writeLedger: false, incomplete: true }, "일부 reject → 미발견이나 불완전·원장 생략")
  assert.deepEqual(classifyNoHitOutcome(0, 2), { tally: "notFound", writeLedger: true, incomplete: false }, "무실패 → 정상 미발견·원장 기록")
})

test("findUnmatchedClaims(#G3): 처리된 인용과 매칭 안 된 claim 수집(오타·미지원·cap 초과) + dedup + citation 없음 skip", () => {
  const processed = new Set(["서면2024법규부가4804", "2021두39997"])
  const claims = [
    { citation: "서면-2024-법규부가-4804", proposition: "p1" }, // 매칭됨 → 제외
    { citation: "서면-2099-오타-9999", proposition: "p2" }, // 미대응
    { citation: "서면-2099-오타-9999", proposition: "p3" }, // 중복 → dedup
    { citation: "", proposition: "p4" }, // citation 없음 → skip
  ]
  assert.deepEqual(findUnmatchedClaims(claims, processed), ["서면-2099-오타-9999"])
  assert.deepEqual(findUnmatchedClaims(undefined, processed), [], "claims 미제출 → 빈 배열")
})

test("redactSecrets(보안): 출력의 법제처 OC 키 마스킹", () => {
  assert.equal(redactSecrets("https://www.law.go.kr/DRF/lawSearch.do?OC=secretkey123&target=law"),
    "https://www.law.go.kr/DRF/lawSearch.do?OC=***&target=law")
  assert.equal(redactSecrets("error at ...&oc=abc DEF"), "error at ...&oc=*** DEF")
  // OC가 없으면 무변경
  assert.equal(redactSecrets("일반 텍스트 OC 설명"), "일반 텍스트 OC 설명")
})

test("classifyVerdict(G3): 명시 결론어 분류(win=과세유지 / lose=납세자유리 / 모호='')", () => {
  assert.equal(classifyVerdict("이 건 심판청구를 기각한다."), "win")
  assert.equal(classifyVerdict("처분을 취소한다."), "lose")
  assert.equal(classifyVerdict("이 건 처분은 달리 잘못이 없는 것으로 판단된다."), "win")
  assert.equal(classifyVerdict("처분은 부당하다."), "lose")
  assert.equal(classifyVerdict("쟁점은 공동경비 안분기준이다."), "") // 결론어 없음
})

test("detectHoldingTruncation(G3): full=true에도 요지↔주문 결과 충돌 시에만 ⚠, 무충돌 시 깨끗", () => {
  // 요지=취소 취지(lose) ↔ 주문=기각(win) → 충돌 → ⚠⚠ 블록
  const conflict = detectHoldingTruncation({
    code: "06", isFull: true, shownBody: "x", fullBody: "…심리 및 판단… 청구주장이 이유 없으므로 심판청구를 기각한다.",
    gist: "쟁점처분은 취소한다는 취지로 인용한다",
  })
  assert.ok(conflict.some((l) => l.includes("요지·주문 결과 불일치")), "충돌 시 ⚠⚠")
  // 무충돌(둘 다 기각/win) → []
  const ok = detectHoldingTruncation({
    code: "06", isFull: true, shownBody: "x", fullBody: "…심판청구를 기각한다.", gist: "처분은 정당하다(기각)",
  })
  assert.equal(ok.length, 0, "무충돌 full은 깨끗")
  // 비-full(truncated)은 기존 요지-결과 정합성 안내 유지
  const cut = detectHoldingTruncation({ code: "06", isFull: false, shownBody: "짧음", fullBody: "긴 본문".repeat(50) })
  assert.ok(cut.some((l) => l.includes("요지-결과 정합성")), "비-full 기존 가드 유지")
})

test("buildApplicationTimingGuard(G10): 귀속연도 의존 조문+앵커없음 → ⚠, 앵커있거나 무관조문 → []", () => {
  assert.ok(buildApplicationTimingGuard("상시근로자 수에 1천만원을 곱한 금액을 공제한다", false).length > 0, "단가·상시근로자+앵커없음")
  assert.equal(buildApplicationTimingGuard("상시근로자 수에 1천만원을 곱한 금액을 공제한다", true).length, 0, "year/efYd 앵커 있으면 억제")
  assert.equal(buildApplicationTimingGuard("법인의 사업연도는 1년을 초과하지 못한다", false).length, 0, "무관 조문 억제")
})

test("classifyAgainstCurrent: 현행본 대조 — same/differs/deleted/missing 분기(v0.12.1 추출)", () => {
  const cur = (jo, body) => `<조문단위><조문내용><![CDATA[${jo}(제목)]]><항내용><![CDATA[${body}]]></항내용></조문단위>`
  // oldText는 실사용처럼 extractArticleBody 출력(제목 CDATA 포함)을 모사 — 제목 접두 동일
  // same — 공백·flSeq 차이만(중립화)
  const oldSame = "제29조의8(제목)① 내용 [수식이미지→…flSeq=111] 입니다."
  const r1 = classifyAgainstCurrent(cur("제29조의8", "① 내용  [수식이미지→…flSeq=999] 입니다."), "제29조의8", oldSame)
  assert.equal(r1.verdict, "same")
  assert.equal(r1.hasFormulaImages, true)
  // differs — 실질 변경
  const r2 = classifyAgainstCurrent(cur("제29조의8", "① 내용이 바뀌었고 단서를 둔다."), "제29조의8", "제29조의8(제목)① 내용 입니다.")
  assert.equal(r2.verdict, "differs")
  assert.equal(r2.hasFormulaImages, false)
  // deleted — 현행본에 '삭제 <날짜>' 표기
  const delXml = '<조문단위><조문내용><![CDATA[제9조 삭제 <2019.12.31>]]></조문내용></조문단위>'
  const r3 = classifyAgainstCurrent(delXml, "제9조", "① 옛 본문")
  assert.equal(r3.verdict, "missing")
  assert.equal(r3.deletedDate, "2019.12.31")
  // missing — 현행본에 조문 없음
  const r4 = classifyAgainstCurrent(cur("제100조", "다른 조"), "제29조의8", "① 옛 본문")
  assert.equal(r4.verdict, "missing")
  assert.equal(r4.deletedDate, undefined)
})

test("todayYmd: YYYYMMDD 로컬 포맷", () => {
  assert.equal(todayYmd(new Date(2026, 5, 12)), "20260612") // month는 0-base
  assert.equal(todayYmd(new Date(2026, 0, 3)), "20260103")
})

test("extractArticleBody: 수식 이미지 URL 회수 + 본문에 URL 마커", () => {
  const block = '<조문내용><![CDATA[제26조의8(통합고용세액공제)]]><항내용><![CDATA[⑥ 상시근로자 수: <img src="http://www.law.go.kr/DRF/flDownload.do?flSeq=125385447" alt="x">]]></항내용></조문내용>'
  const { text, imageUrls } = extractArticleBody(block)
  assert.equal(imageUrls.length, 1)
  assert.ok(imageUrls[0].includes("flSeq=125385447"))
  assert.ok(text.includes("[수식이미지→") && text.includes("125385447"))
  assert.ok(!/<img/i.test(text))
})

test("pruneEmpty: null·빈 필드 제거(0/false 보존), 실데이터 유지", () => {
  const raw = {
    ASISTH001MR01: {
      searchKeyword: "통합고용",
      recordCount: 0,
      nullField: null,
      emptyStr: "",
      emptyArr: [],
      list: [
        { ntstNm: "조세특례제한법", ntstBscId: "100", empty: null, gone: "" },
        { all: null, blank: "" },
      ],
      flag: false,
    },
  }
  const out = pruneEmpty(raw)
  const o = out.ASISTH001MR01
  assert.equal(o.searchKeyword, "통합고용")
  assert.equal(o.recordCount, 0) // 0 보존
  assert.equal(o.flag, false) // false 보존
  assert.ok(!("nullField" in o) && !("emptyStr" in o) && !("emptyArr" in o))
  assert.equal(o.list.length, 1) // 전부 빈 두번째 객체 제거
  assert.deepEqual(o.list[0], { ntstNm: "조세특례제한법", ntstBscId: "100" })
})

// v0.12.2 — 해석 분기 가드(buildInterpretiveForkGuard)
test("interpretiveForkGuard: 고용 세액공제 사후관리 '적용하지 아니한다' → 가드 발화", () => {
  const t =
    "청년등상시근로자의 수가 최초로 공제를 받은 과세연도에 비하여 감소한 경우에는 감소한 과세연도부터 제1항제1호를 적용하지 아니한다. 이 경우 공제받은 세액에 상당하는 금액을 납부하여야 한다."
  const g = buildInterpretiveForkGuard(t, "제29조의7")
  assert.ok(g.length > 0)
  assert.ok(g[0].includes("해석 분기 가드"))
  assert.ok(g.some((l) => l.includes("제29조의7")))
  assert.ok(g.some((l) => l.includes("단가로 전환")))
  assert.ok(g.some((l) => l.includes("추징식 정합성")))
  // v0.20.1 — 양방향화: 기존 가드에 역방향(폐쇄 호구분형에 전환 법리 유추 금지) 경고 문장 포함
  assert.ok(g.some((l) => l.includes("역방향 오류도 경계")))
  // 폐쇄 호구분형 신규 가드 블록은 발화하지 않음(이 텍스트는 '각 호의 구분에 따른 금액…상당액' 없음)
  assert.ok(!g.some((l) => l.includes("해석 분기 가드(폐쇄 호구분형)")))
})

// v0.26.1(리뷰 O2-6) — '공제하지 아니'(공제 배제형)·'줄어든'(감소형) 문형 갭 보강
test("interpretiveForkGuard(O2-6): '공제하지 아니'+'줄어든' 조합도 발화(종전 '적용하지'만 포착)", () => {
  const t = "상시근로자 수가 직전 과세연도보다 줄어든 경우에는 제1항제1호에 따른 금액을 공제하지 아니한다."
  const g = buildInterpretiveForkGuard(t, "제29조의8")
  assert.ok(g.length > 0, "공제하지 아니+줄어든 4-AND 충족 시 발화")
  assert.ok(g[0].includes("해석 분기 가드"))
})
test("interpretiveForkGuard(O2-6): '납부하여야'만으로는 과발동 안 함(4-AND 유지)", () => {
  // 공제·배제·사후관리 문언 없이 납부의무만 있으면 비발화
  assert.equal(buildInterpretiveForkGuard("세액을 납부하여야 한다.", "제5조").length, 0)
})

// v0.20.1 — 폐쇄 호구분형 신규 가드(구 조특법 §30의4② 사보 2차 사후관리)
test("interpretiveForkGuard: 폐쇄 호구분형('각 호의 구분에 따른 금액…상당액') → 신규 가드 발화", () => {
  const t =
    "제1항을 적용받은 내국인이 최초로 공제받은 과세연도의 종료일부터 1년이 되는 날이 속하는 과세연도까지 상시근로자의 수가 감소하지 아니한 경우에는 다음 각 호의 구분에 따른 금액을 공제한다. 1. 청년등 상시근로자의 수가 감소하지 아니한 경우: 제1항제1호에 따라 공제받은 금액 상당액 2. 제1호 외의 경우: 제1항제2호에 따라 공제받은 금액 상당액"
  const g = buildInterpretiveForkGuard(t, "제30조의4")
  assert.ok(g.length > 0)
  assert.ok(g[0].includes("해석 분기 가드(폐쇄 호구분형)"))
  assert.ok(g.some((l) => l.includes("제30조의4")))
  assert.ok(g.some((l) => l.includes("각 호의 구분")))
  assert.ok(g.some((l) => l.includes("상당액")))
  // 이 텍스트는 '적용하지 아니한다'가 없어 기존 사후관리 가드는 발화하지 않음
  assert.ok(!g.some((l) => l.includes("해석 분기 가드(세액공제 사후관리)")))
})

// v0.21.0(#G6) — 폐쇄 호구분형 관용구 변형("각 호에 따른 금액", "공제한 세액…상당하는")도 흡수
test("interpretiveForkGuard(#G6): 문언 변형(각 호에 따른 금액 + 공제한 세액…상당하는) → 발화", () => {
  const t =
    "요건 판정 후 다음 각 호에 따른 금액을 공제한다. 1. …의 경우: 제1항제1호에 따라 공제한 세액에 상당하는 금액 2. 그 밖의 경우: 제1항제2호에 따라 공제한 세액에 상당하는 금액"
  const g = buildInterpretiveForkGuard(t, "제30조의4")
  assert.ok(g.some((l) => l.includes("해석 분기 가드(폐쇄 호구분형)")))
})

test("interpretiveForkGuard(#G6): 기존 관용구('각 호의 구분에 따른 금액'+'공제받은 금액 상당액')는 계속 발화(회귀)", () => {
  const t =
    "다음 각 호의 구분에 따른 금액을 공제한다. 1. …: 제1항제1호에 따라 공제받은 금액 상당액"
  assert.ok(buildInterpretiveForkGuard(t, "제30조의4").some((l) => l.includes("해석 분기 가드(폐쇄 호구분형)")))
})

test("interpretiveForkGuard: 무관 조문(공제·감소·호 없음) → 미발화", () => {
  assert.equal(buildInterpretiveForkGuard("① 상시근로자 수는 매월 말일 현재 인원을 합하여 계산한다.", "제26조의7").length, 0)
})

test("interpretiveForkGuard: '적용하지 아니' 없으면(추징 산식 본문만) → 미발화", () => {
  // 시행령 추징 산식 본문은 '적용하지 아니한다'가 없어 1차 진입점(법 조문)에서만 발화하도록 절제
  const t = "법 제29조의7제2항에 따라 납부하여야 할 세액은 청년등 상시근로자의 감소한 인원 수에 공제액을 곱한 금액으로 한다."
  assert.equal(buildInterpretiveForkGuard(t, "제26조의7").length, 0)
})

test("interpretiveForkGuard: 빈 본문 → 미발화", () => {
  assert.equal(buildInterpretiveForkGuard("", "제29조의7").length, 0)
})

// v0.21.0(#G14) — 도구 시간예산 남은량 계산 순수함수. store 부재/잔여/소진 3케이스.
test("remainingBudgetMs: deadlineAt 미지정(store 부재) → Infinity(무제한)", () => {
  assert.equal(remainingBudgetMs(undefined), Infinity)
  assert.equal(remainingBudgetMs(undefined, 123456), Infinity)
})

test("remainingBudgetMs: 미래 deadline → 양의 잔여(now 대비)", () => {
  assert.equal(remainingBudgetMs(1000, 400), 600)
  assert.equal(remainingBudgetMs(90000, 0), 90000)
})

test("remainingBudgetMs: 과거·동일 deadline → 소진(<=0)", () => {
  assert.equal(remainingBudgetMs(400, 1000), -600)
  assert.equal(remainingBudgetMs(500, 500), 0)
  assert.ok(remainingBudgetMs(500, 500) <= 0)
  assert.ok(remainingBudgetMs(400, 1000) <= 0)
})

// ── v0.25.0(리뷰 SEC-4b·O2-1) ──
test("SEC-4b: htmlToText 무종결 <script 1M자 폭주 — 선형(<5s) + 결과 동일", () => {
  const evil = "<script".repeat(150000)
  const t0 = Date.now()
  assert.equal(htmlToText("safe<p>ok</p>" + evil), htmlToText("safe<p>ok</p>"))
  assert.ok(Date.now() - t0 < 5000)   // 종전 정규식 실측 68s → 명확 분리
})
test("SEC-4b: extractCdataText 무종결 CDATA 1M자 폭주 — 선형(<5s) + 무종결 미채택", () => {
  const evil = "<![CDATA[".repeat(120000)
  const t0 = Date.now()
  extractCdataText(evil)
  assert.ok(Date.now() - t0 < 5000)   // 종전 9.2s
})
test("compactBodyText(O2-1): 관련법령 절단 시 생략 마커(무언 손실 금지)", () => {
  const out = compactBodyText("1. 사실관계\n본문\n3. 관련법령\n소득세법 제1조 전문", false)
  assert.ok(out.includes("생략") && out.includes("full=true"))
  assert.ok(!out.includes("소득세법 제1조"))
})

// ── v0.27.0(리뷰 P2) OC 마스킹 우회 형태 ────────────────────────────────
test("redactSecrets(v0.27.0): HTML 엔티티·선행구분자 없음·JSON 표기 우회 차단", () => {
  for (const s of ["?OC=secret", "&OC=secret", "?a=1&amp;OC=secret", "OC=secret", '"OC":"secret"']) {
    assert.ok(!redactSecrets(s).includes("secret"), `미마스킹: ${s} → ${redactSecrets(s)}`)
  }
})

test("redactSecrets(v0.27.0): OC 아닌 파라미터는 보존(과발동 방지)", () => {
  assert.equal(redactSecrets("?doc=secret"), "?doc=secret")
  assert.ok(redactSecrets("?MST=12345&target=law").includes("12345"))
})

// ── v0.27.1(리뷰 P1) 경고 우선 예산 배분 ────────────────────────────────
test("budgetedJoin: 본문이 상한을 초과해도 안전 경고는 살아남는다", () => {
  // 실제 시나리오: 원문 45,000자 + 요지·회신·판례목록이 더해져 상한 50,000을 넘는 경우.
  const head = ["A".repeat(45000), "요지 ".repeat(2000), "판례 ".repeat(2000)]
  const guard = ["⚠ 사문화 경고", "⚠ 기본통칙 현행 번호 미확인", "강제 절차: ..."]
  const out = budgetedJoin(head, guard, 50000)
  for (const g of guard) assert.ok(out.includes(g), `경고 소실: ${g}`)
  assert.ok(out.includes("[truncated"), "본문이 잘렸으면 절단 표기가 있어야 함")
  assert.ok(out.length <= 50000 + 200, `상한 초과: ${out.length}`)
})

test("budgetedJoin: 종전 방식이었다면 경고가 사라졌을 입력에서 경고 보존 확인", () => {
  const head = ["A".repeat(50000)]
  const guard = ["⚠ 반드시 살아남아야 하는 경고"]
  // 종전: truncate([head, guard].join("\n"), 50000) → 경고가 꼬리라 절단됨
  const oldWay = truncate([...head, ...guard].join("\n"), 50000)
  assert.ok(!oldWay.includes("반드시 살아남아야"), "전제 확인: 종전 방식에서는 경고가 잘려야 함")
  // 신규: 경고 우선 예산
  assert.ok(budgetedJoin(head, guard, 50000).includes("반드시 살아남아야"))
})

test("budgetedJoin: 경고가 없으면 종전과 동일하게 본문만 절단(회귀)", () => {
  assert.equal(budgetedJoin(["짧은 본문"], [], 50000), "짧은 본문")
  assert.ok(budgetedJoin(["B".repeat(60000)], [], 50000).includes("[truncated"))
})

test("budgetedJoin: 본문이 짧으면 아무것도 자르지 않는다", () => {
  const out = budgetedJoin(["본문"], ["⚠ 경고"], 50000)
  assert.equal(out, "본문\n⚠ 경고")
})

// ── v0.27.1(리뷰 P2) 블록 예산 채우기 ──────────────────────────────────
test("fitBlocks: 예산에 맞춰 채우고 생략 개수를 정확히 보고", () => {
  const blocks = Array.from({ length: 10 }, () => "X".repeat(1000))
  const { kept, omitted } = fitBlocks(blocks, 3500)
  assert.equal(kept.length, 3)
  assert.equal(omitted, 7)
  assert.equal(kept.length + omitted, blocks.length, "표시+생략이 전체와 불일치")
})

test("fitBlocks: 예산이 0이어도 최소 1건은 렌더(빈 응답 금지)", () => {
  const { kept, omitted } = fitBlocks(["X".repeat(9999)], 0)
  assert.equal(kept.length, 1)
  assert.equal(omitted, 0)
})

test("fitBlocks: 전부 들어가면 생략 0", () => {
  const { kept, omitted } = fitBlocks(["a", "b"], 1000)
  assert.deepEqual(kept, ["a", "b"])
  assert.equal(omitted, 0)
})

// ── v0.27.4(라이브 검증) 법원 사건번호 하이픈 표기 ─────────────────────
// search_taxlaw_documents가 '문서번호: 대법원-2006-두-18652'로 출력하는데
// verify_nts_citations가 그 형식을 추출하지 못해, 검색 결과를 그대로 옮기면
// 인용 게이트가 검출 0건으로 통과시키던 라운드트립 구멍.
test("extractNtsCitations(v0.27.4): 법원 문서번호 하이픈 표기 추출", () => {
  const t = "대법원-2006-두-18652 / 서울행정법원-2018-구합-62461 / 울산지방법원-2019-구합-6417 / 서울고등법원-2018-누-30459"
  const norm = extractNtsCitations(t).filter((c) => c.kind === "court").map((c) => c.normalized)
  for (const want of ["2006두18652", "2018구합62461", "2019구합6417", "2018누30459"]) {
    assert.ok(norm.includes(want), `미추출 ${want}: ${JSON.stringify(norm)}`)
  }
})

test("extractNtsCitations(v0.27.4): 기존 표기 회귀 + 병합사건 유지", () => {
  const norm = extractNtsCitations("2006두18652, 2021두39997, 39998 및 2019헌바73").filter((c) => c.kind === "court").map((c) => c.normalized)
  for (const want of ["2006두18652", "2021두39997", "2021두39998", "2019헌바73"]) {
    assert.ok(norm.includes(want), `누락 ${want}: ${JSON.stringify(norm)}`)
  }
})

test("extractNtsCitations(v0.27.4): 과발동 방지(일반 문장은 미추출)", () => {
  const norm = extractNtsCitations("2024년 두 번째 안건, 제2020호 구합의 건").filter((c) => c.kind === "court")
  assert.equal(norm.length, 0, `오탐: ${JSON.stringify(norm)}`)
})

// ── v0.27.4(라이브 루프) formatDocumentDetail capOverride ───────────────
// research_taxlaw_topic이 결과를 다시 truncate해 꼬리의 안전 경고가 통째로 잘리던 것.
// budgetedJoin에 cap을 넘기면 경고가 먼저 확보된다(호출부 재절단 금지).
test("budgetedJoin(v0.27.4): capOverride 경로에서도 경고 우선 보존", () => {
  const head = ["본문 ".repeat(6000)]                 // 약 18,000자
  const guard = ["── 관련규정 연도 적용여부 검증 ──", "⚠ 구법조문 기반 가능성"]
  const out = budgetedJoin(head, guard, 9000)          // research 기본 cap
  for (const g of guard) assert.ok(out.includes(g), `경고 소실: ${g}`)
  assert.ok(out.includes("[truncated"), "본문 절단 표기 필요")
  assert.ok(out.length <= 9000 + 300, `상한 초과: ${out.length}`)
})

test("budgetedJoin(v0.27.4): 종전 방식(재truncate)이었다면 경고가 잘렸음을 대조", () => {
  const head = ["본문 ".repeat(6000)]
  const guard = ["⚠ 반드시 보존되어야 하는 결론부 경고"]
  const oldWay = truncate([...head, ...guard].join("\n"), 9000)
  assert.ok(!oldWay.includes("반드시 보존"), "전제 확인: 종전 방식은 경고가 잘려야 함")
  assert.ok(budgetedJoin(head, guard, 9000).includes("반드시 보존"))
})

// ── v0.27.7 항/호/목 번호 중복 제거 ─────────────────────────────────────
// 법제처 XML은 번호를 <항번호>와 <항내용> 양쪽에 담아, CDATA를 이어붙이면 "①①"이 된다.
// 실측(법인세법): 642/642 항 전부 중복, 본문 175,687→173,301자(1.36% 절감).
test("extractArticleBody(v0.27.7): 항 번호 중복(①①) 제거", () => {
  const blk = "<조문단위><조문내용><![CDATA[제25조(제목)]]></조문내용>" +
    "<항><항번호><![CDATA[①]]></항번호><항내용><![CDATA[① 첫째 항 내용]]></항내용></항>" +
    "<항><항번호><![CDATA[②]]></항번호><항내용><![CDATA[② 둘째 항 내용]]></항내용></항></조문단위>"
  const { text } = extractArticleBody(blk)
  assert.ok(!/①①/.test(text), `①① 잔존: ${text}`)
  assert.ok(!/②②/.test(text), `②② 잔존: ${text}`)
  assert.match(text, /① 첫째 항 내용/)
  assert.match(text, /② 둘째 항 내용/)
})

test("extractArticleBody(v0.27.7): 호(1.1.)·목(가.가.) 중복 제거", () => {
  const blk = "<조문단위><호><호번호><![CDATA[1.]]></호번호><호내용><![CDATA[1. 광업]]></호내용></호>" +
    "<목><목번호><![CDATA[가.]]></목번호><목내용><![CDATA[가. 비디오물 감상실]]></목내용></목></조문단위>"
  const { text } = extractArticleBody(blk)
  assert.ok(!/1\.1\./.test(text), `1.1. 잔존: ${text}`)
  assert.ok(!/가\.가\./.test(text), `가.가. 잔존: ${text}`)
  assert.match(text, /1\. 광업/)
  assert.match(text, /가\. 비디오물 감상실/)
})

test("extractArticleBody(v0.27.7): 번호와 본문이 다르면 보존(정보 손실 금지)", () => {
  // 항번호와 항내용 접두가 어긋나는 경우는 둘 다 남겨야 한다.
  const blk = "<조문단위><항><항번호><![CDATA[①]]></항번호><항내용><![CDATA[② 어긋난 내용]]></항내용></항></조문단위>"
  const { text } = extractArticleBody(blk)
  assert.match(text, /①/, "불일치인데 항번호가 사라짐")
  assert.match(text, /② 어긋난 내용/)
})

test("extractArticleBody(v0.27.7): 마커 아닌 짧은 청크는 보존", () => {
  const blk = "<조문단위><조문내용><![CDATA[삭제]]></조문내용><조문참고자료><![CDATA[삭제 <2019.12.31>]]></조문참고자료></조문단위>"
  const { text } = extractArticleBody(blk)
  assert.ok(text.startsWith("삭제"), `앞 청크 소실: ${text}`)
})

// v0.27.8 — 적용례 유형 분류 커버리지. 실측 계기: 4개 세법 부칙 979문장 중 436건(44.5%)이
//   유형미상 → targetYearApplicationNote가 ""를 반환해 '귀속 판단' 줄이 통째로 사라졌다.
test("classifyApplicationClause(v0.27.8): 기존 분류 결과 불변(회귀 방지)", () => {
  // 후순위 규칙을 '뒤에만' 덧붙였으므로 기존에 분류되던 문장은 그대로여야 한다.
  assert.equal(classifyApplicationClause("제26조의8제6항의 개정규정은 이 영 시행 이후 신고하는 경우부터 적용한다."), "신고시점기준")
  assert.equal(classifyApplicationClause("제11조의2제8항의 개정규정은 2026년 1월 1일 이후 개시하는 과세연도부터 적용한다."), "과세연도개시기준")
  assert.equal(classifyApplicationClause("제26조의8의 개정규정에도 불구하고 종전의 규정에 따른다."), "경과조치(종전규정)")
  assert.equal(classifyApplicationClause("제26조의8제6항의 개정규정은 2025년 1월 1일 이후 개시하는 과세연도를 최초 공제연도로 하여 신청하는 경우부터 적용한다."), "최초공제연도기준")
  assert.equal(classifyApplicationClause("제27조의6의 개정규정은 이 영 시행 이후 증여받는 경우부터 적용한다."), "행위시점기준")
})

test("classifyApplicationClause(v0.27.8): '시행 후'·'시행일 이후'·날짜 anchor", () => {
  // 종전에는 anchor를 '시행이후' 한 형태로만 봐서, 동사가 목록에 있어도(합병) 미상이었다.
  assert.equal(classifyApplicationClause("제12조의3의 개정규정은 이 법 시행 후 합병하는 분부터 적용한다."), "행위시점기준")
  assert.equal(classifyApplicationClause("제88조의2제1항의 개정규정은 이 법 시행일 이후 가입하는 분부터 적용한다."), "행위시점기준")
  assert.equal(classifyApplicationClause("제71조의2제1항의 개정규정은 2025년 11월 28일 이후 주택을 취득하는 경우부터 적용한다."), "행위시점기준")
  // 시행일을 부칙 다른 조로 지시하는 형태
  assert.equal(classifyApplicationClause("이 법 중 양도소득세에 관한 개정규정은 부칙 제1조에 따른 각 해당 개정규정의 시행일 이후 양도하는 경우부터 적용한다."), "행위시점기준")
})

test("classifyApplicationClause(v0.27.8): 동사 열거 밖 행위·과세기간·연말정산·사업연도", () => {
  // 동사 화이트리스트(취득·지급·양도…)에 없던 행위들 — 구조(anchor + 부터 적용한다)로 판정한다.
  assert.equal(classifyApplicationClause("제6조제1항의 개정규정은 이 법 시행 이후 창업하는 경우부터 적용한다."), "행위시점기준")
  assert.equal(classifyApplicationClause("제8조의3제5항의 개정규정은 이 법 시행 이후 무역보험기금에 출연하는 경우부터 적용한다."), "행위시점기준")
  assert.equal(classifyApplicationClause("제58조제1항의 개정규정은 이 법 시행 이후 기부하는 경우부터 적용한다."), "행위시점기준")
  // 부가세 부칙은 '과세연도'가 아니라 '과세기간' — 통째로 빠져 있었다.
  assert.equal(classifyApplicationClause("제108조제2항의 개정규정은 2026년 7월 1일 이후 개시하는 과세기간부터 적용한다."), "과세연도개시기준")
  // 연말정산·확정신고 형태
  assert.equal(classifyApplicationClause("제132조의2제1항제7호의2의 개정규정은 이 법 시행 이후 근로소득세액의 연말정산 또는 종합소득과세표준을 확정신고하는 분부터 적용한다."), "신고시점기준")
  // '…일이 속하는 사업연도'
  assert.equal(classifyApplicationClause("제51조의2제2항제1호 단서의 개정규정은 2023년 12월 31일이 속하는 사업연도부터 적용한다."), "소득·기간기준")
})

test("classifyApplicationClause(v0.27.8): 경과조치 문구 변형('종전의 규정을 적용한다')", () => {
  assert.equal(classifyApplicationClause("이 법 시행 당시 종전의 제6조의 규정을 적용받던 중소기업에 대하여는 종전의 규정을 적용한다."), "경과조치(종전규정)")
  assert.equal(classifyApplicationClause("이 법 시행 전에 발생한 소득에 대해서는 종전의 예에 따른다."), "경과조치(종전규정)")
})

test("targetYearApplicationNote(v0.27.8): 유형미상도 침묵하지 않는다", () => {
  // 미상이면 ""를 반환해 호출부가 '귀속 판단' 줄을 아예 안 찍었다 → '적용례 없음'으로 오독된다.
  const note = targetYearApplicationNote("유형미상", "무언가 알 수 없는 적용례 문구", 2025, "2025.1.1", 3)
  assert.notEqual(note, "", "미상일 때 빈 문자열 반환 — 판단노트가 무언 누락된다")
  assert.match(note, /미분류/)
  assert.match(note, /2025/)
  // 분류된 유형은 종전 동작 유지
  assert.match(targetYearApplicationNote("신고시점기준", "…신고하는 경우부터", 2024, "2025.1.1", 3), /소급 적용/)
})

// v0.27.8 — efYd 형식 검증. 실측 계기: efYd="2023-12-31"(ISO 오타)이 2022 시행본(MST 238037)을
//   반환하면서 "2023-12-31 시점 시행본"이라고 라벨됐다. 사전순 비교라 '-'(0x2D) < '0'(0x30)이기 때문.
test("normalizeEfYd(v0.27.8): 정상 8자리는 그대로", () => {
  assert.deepEqual(normalizeEfYd("20231231"), { efYd: "20231231", note: undefined })
  assert.deepEqual(normalizeEfYd(""), { efYd: "" })
  assert.deepEqual(normalizeEfYd(undefined), { efYd: "" })
})

test("normalizeEfYd(v0.27.8): 구분자 형태는 정규화 + 노트", () => {
  const a = normalizeEfYd("2023-12-31")
  assert.equal(a.efYd, "20231231")
  assert.match(a.note, /정규화/)
  assert.equal(normalizeEfYd("2023.12.31").efYd, "20231231")
  assert.equal(normalizeEfYd("2023/1/5").efYd, "20230105")
})

test("normalizeEfYd(v0.27.8): 형식·범위 위반은 조용히 넘기지 않고 거부", () => {
  for (const bad of ["2023", "202312", "not-a-date", "20231232", "20231301", "19001231", "21011231"]) {
    assert.throws(() => normalizeEfYd(bad), /INVALID|8자리|범위/, `"${bad}"가 통과됨 — 현행본이 요청 시점본으로 둔갑한다`)
  }
})

test("normalizeEfYd(v0.27.8): 사전순 비교가 왜 위험한지(회귀 근거)", () => {
  // 검증이 없다면 pickVersionInForce는 이 비교로 한 판본 뒤를 고른다.
  assert.ok("2023-12-31" < "20230101", "전제 붕괴: '-'가 숫자보다 크게 비교됨")
  const versions = [
    { enforceDate: "20220101", promDate: "20211221", mst: "238037" },
    { enforceDate: "20230101", promDate: "20221231", mst: "247463" },
  ]
  assert.equal(pickVersionInForce(versions, "20231231").mst, "247463")
  assert.equal(pickVersionInForce(versions, "2023-12-31")?.mst, "238037", "검증 없이 통과하면 2022본이 선택된다")
})

// v0.27.8 — 조문 메타 CDATA가 본문 앞에 붙던 문제.
//   법인세법 실측: 255개 조문단위 중 206개(81%)가 "정의2013.1.1, …제2조(정의)"처럼 시작했다.
test("extractArticleBody(v0.27.8): 제목·제개정일자 메타가 본문 앞에 붙지 않는다", () => {
  const blk = [
    "<조문단위>",
    "<조문제목><![CDATA[정의]]></조문제목>",
    "<조문제개정일자문자열><![CDATA[2013.1.1, 2018.12.24]]></조문제개정일자문자열>",
    "<조문내용><![CDATA[제2조(정의) 이 법에서 사용하는 용어의 뜻은 다음과 같다. <개정 2013.1.1, 2018.12.24>]]></조문내용>",
    "</조문단위>",
  ].join("")
  const { text } = extractArticleBody(blk)
  assert.ok(text.startsWith("제2조(정의)"), `본문이 조문 표기로 시작하지 않음: ${JSON.stringify(text.slice(0, 40))}`)
  // 생략한 값은 본문에 그대로 남아 있어야 한다(정보 손실 0).
  assert.match(text, /정의/)
  assert.match(text, /2013\.1\.1, 2018\.12\.24/)
})

test("extractArticleBody(v0.27.8): 뒤에 안 남는 메타는 생략하지 않는다", () => {
  // 제목이 본문에 없으면(예: 표기 불일치) 지우면 정보가 사라지므로 보존해야 한다.
  const blk = [
    "<조문단위>",
    "<조문제목><![CDATA[전혀다른제목]]></조문제목>",
    "<조문내용><![CDATA[제9조(과세표준) 내용만 있다.]]></조문내용>",
    "</조문단위>",
  ].join("")
  const { text } = extractArticleBody(blk)
  assert.match(text, /전혀다른제목/, "본문에 없는 제목까지 지워버렸다 — 정보 손실")
})

test("extractArticleBody(v0.27.8): v0.27.7 항번호 중복 제거와 함께 동작", () => {
  const blk = [
    "<조문단위>",
    "<조문제목><![CDATA[납세의무자]]></조문제목>",
    "<조문내용><![CDATA[제3조(납세의무자)]]></조문내용>",
    "<항><항번호><![CDATA[①]]></항번호><항내용><![CDATA[① 다음 각 호의 법인은 납부할 의무가 있다.]]></항내용></항>",
    "</조문단위>",
  ].join("")
  const { text } = extractArticleBody(blk)
  assert.ok(text.startsWith("제3조(납세의무자)"), `앞머리 군더더기: ${JSON.stringify(text.slice(0, 30))}`)
  assert.equal((text.match(/①/g) || []).length, 1, "항번호가 중복됨")
})
