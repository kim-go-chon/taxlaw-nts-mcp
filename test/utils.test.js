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
