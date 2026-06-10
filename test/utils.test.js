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
