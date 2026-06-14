import { test } from "node:test"
import { strict as assert } from "node:assert"

process.env.TAXLAW_MCP_TEST_MODE = "1"

const {
  truncate,
  decodeHtml,
  htmlToText,
  cleanText,
  normalizeDate,
  normalizeDetailId,
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
  todayYmd,
  parseLawAddenda,
  extractCdataText,
  classifyApplicationClause,
  extractJoClauses,
  extractEnforceDate,
  mergeAddendaUnits,
  detectAddendumRevisionTails,
  parseLawRevisionText,
  pickVersionByPromulgation,
  pickVersionInForce,
  extractArticleBody,
  pruneEmpty,
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
  assert.ok(same.some((l) => l.includes("문구 동일") && l.includes("적극 신호") && l.includes("수식 이미지 내용은 대조 범위 밖")))
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

test("lawNameKey/filterVersionsByName: 교차법령(시행령) 행 배제, 일치 0건이면 원본 보존(리뷰 검출)", () => {
  const vs = [
    { mst: "1", enforceDate: "20250423", promDate: "20250422", lawName: "가상자산 이용자 보호 등에 관한 법률 시행령" },
    { mst: "2", enforceDate: "20240719", promDate: "20230718", lawName: "가상자산 이용자 보호 등에 관한 법률" },
  ]
  const own = filterVersionsByName(vs, "가상자산 이용자 보호 등에 관한 법률")
  assert.equal(own.length, 1)
  assert.equal(own[0].mst, "2") // 시행령 행 배제 — 시행령을 '현행본'으로 오판하던 결함
  assert.equal(filterVersionsByName(vs, "전혀 다른 법").length, 2) // 일치 0건 → 원본(기존 동작 보존)
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
