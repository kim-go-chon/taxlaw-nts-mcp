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
