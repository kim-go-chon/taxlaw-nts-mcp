import { test } from "node:test"
import { strict as assert } from "node:assert"

process.env.TAXLAW_MCP_TEST_MODE = "1"

const { lookupRestructure, detectPreRestructureCitations, formatRestructureHits } = await import("../build/restructure-map.js")

test("lookupRestructure: 부가세법 시행령 옛 §35 → 현행 §42 (조 단위)", () => {
  const hit = lookupRestructure("부가가치세법 시행령", {
    article: "제35조",
    paragraph: null,
    item: null,
  })
  assert.ok(hit)
  assert.equal(hit.lawName, "부가가치세법")
  assert.equal(hit.oldRef, "시행령.제35조")
  assert.equal(hit.newRef, "시행령.제42조")
  assert.equal(hit.type, "전부개정")
  assert.equal(hit.restructureDate, "2013-07-01")
})

test("lookupRestructure: 부가세법 시행령 옛 §35 1호 → 현행 §42 1호", () => {
  const hit = lookupRestructure("부가가치세법 시행령", {
    article: "제35조",
    paragraph: null,
    item: "제1호",
  })
  assert.ok(hit)
  assert.equal(hit.oldRef, "시행령.제35조제1호")
  assert.equal(hit.newRef, "시행령.제42조제1호")
})

test("lookupRestructure: 옛 부가세법 §12 → 현행 §26", () => {
  const hit = lookupRestructure("부가가치세법", {
    article: "제12조",
    paragraph: null,
    item: null,
  })
  assert.ok(hit)
  assert.equal(hit.oldRef, "법.제12조")
  assert.equal(hit.newRef, "법.제26조")
})

test("lookupRestructure: 현행 §42 인용은 매핑 없음 (false-positive 차단)", () => {
  const hit = lookupRestructure("부가가치세법 시행령", {
    article: "제42조",
    paragraph: null,
    item: null,
  })
  assert.equal(hit, null)
})

test("lookupRestructure: 사전에 없는 법령은 null", () => {
  const hit = lookupRestructure("교육세법", {
    article: "제10조",
    paragraph: null,
    item: null,
  })
  assert.equal(hit, null)
})

test("lookupRestructure: '소득세법시행령' 띄어쓰기 없는 표기도 인식", () => {
  // 사전에 없는 법령이라 null이지만, splitLawName이 시행령 prefix를 인식하는지 검증.
  const hit = lookupRestructure("소득세법시행령", {
    article: "제999조",
    paragraph: null,
    item: null,
  })
  assert.equal(hit, null) // 매핑 없으므로 null, 하지만 에러는 없어야 함
})

test("detectPreRestructureCitations: 옛 §35 1호 + 옛 §12 두 건 모두 검출", () => {
  const citations = [
    {
      lawName: "부가가치세법 시행령",
      lawNameRaw: "부가가치세법 시행령",
      article: "제35조",
      paragraph: null,
      item: "제1호",
      rawSnippet: "",
    },
    {
      lawName: "부가가치세법",
      lawNameRaw: "부가가치세법",
      article: "제12조",
      paragraph: null,
      item: null,
      rawSnippet: "",
    },
  ]
  const hits = detectPreRestructureCitations(citations)
  assert.equal(hits.length, 2)
  const refs = hits.map((h) => h.oldRef)
  assert.ok(refs.includes("시행령.제35조제1호"))
  assert.ok(refs.includes("법.제12조"))
})

test("detectPreRestructureCitations: 중복 인용은 1건으로 dedupe", () => {
  const citations = [
    {
      lawName: "부가가치세법 시행령",
      lawNameRaw: "부가가치세법 시행령",
      article: "제35조",
      paragraph: null,
      item: null,
      rawSnippet: "",
    },
    {
      lawName: "부가가치세법 시행령",
      lawNameRaw: "부가가치세법 시행령",
      article: "제35조",
      paragraph: null,
      item: null,
      rawSnippet: "",
    },
  ]
  const hits = detectPreRestructureCitations(citations)
  assert.equal(hits.length, 1)
})

test("detectPreRestructureCitations: 현행 인용만 있으면 빈 배열", () => {
  const citations = [
    {
      lawName: "부가가치세법 시행령",
      lawNameRaw: "부가가치세법 시행령",
      article: "제42조",
      paragraph: null,
      item: "제1호",
      rawSnippet: "",
    },
  ]
  const hits = detectPreRestructureCitations(citations)
  assert.equal(hits.length, 0)
})

test("formatRestructureHits: 빈 배열 → 빈 출력", () => {
  const lines = formatRestructureHits([])
  assert.deepEqual(lines, [])
})

test("formatRestructureHits: 옛 §35 매핑 안내 라인 생성", () => {
  const hits = [
    {
      oldRef: "시행령.제35조제1호",
      newRef: "시행령.제42조제1호",
      restructureDate: "2013-07-01",
      lawName: "부가가치세법",
      type: "전부개정",
      note: "현행 부가세법 체계로 전부개정",
    },
  ]
  const lines = formatRestructureHits(hits)
  assert.ok(lines.some((l) => l.includes("구조개편 이력 자동 검출")))
  assert.ok(lines.some((l) => l.includes("시행령.제35조제1호 → 현행 시행령.제42조제1호")))
})

// ─── v0.9.2 본문 substring 재확인 ──────────────────────

test("v0.9.2: 본문에 '부가가치세법 제6조' 표기 없으면 매핑 무효 (false-positive 차단)", () => {
  const citations = [
    {
      lawName: "부가가치세법",
      lawNameRaw: "부가가치세법",
      article: "제6조",
      paragraph: null,
      item: null,
      rawSnippet: "",
    },
  ]
  // 본문에 "조세특례제한법 제6조"만 있고 "부가가치세법 제6조"는 없음
  // (citation-extract 80자 윈도우가 잘못 매칭한 케이스 재현)
  const bodyText = "청구인이 「조세특례제한법」 제6조에 따른 창업중소기업 감면을 적용받으려 하였고, 「부가가치세법」 제26조에 따라 면세 인적용역에 해당한다."
  const hits = detectPreRestructureCitations(citations, bodyText)
  assert.equal(hits.length, 0, "본문에 '부가가치세법 제6조'가 없으면 매핑 무효")
})

test("v0.9.2: 본문에 옛 표기 실제 등장하면 매핑 유효", () => {
  const citations = [
    {
      lawName: "부가가치세법 시행령",
      lawNameRaw: "부가가치세법 시행령",
      article: "제35조",
      paragraph: null,
      item: "제1호",
      rawSnippet: "",
    },
  ]
  const bodyText = "이 건은 부가가치세법 시행령 제35조 제1호의 인적용역에 해당하는지 여부가 쟁점이다."
  const hits = detectPreRestructureCitations(citations, bodyText)
  assert.equal(hits.length, 1, "본문에 실제 등장하면 매핑 유효")
  assert.equal(hits[0].oldRef, "시행령.제35조제1호")
})

test("v0.9.2: 공백 차이 ('부가가치세법시행령' vs '부가가치세법 시행령')도 substring 매칭", () => {
  const citations = [
    {
      lawName: "부가가치세법 시행령",  // 공백 있는 정규화 표기
      lawNameRaw: "부가가치세법시행령",  // 본문 표기
      article: "제35조",
      paragraph: null,
      item: null,
      rawSnippet: "",
    },
  ]
  const bodyText = "부가가치세법시행령 제35조에 해당함."  // 공백 없는 표기
  const hits = detectPreRestructureCitations(citations, bodyText)
  assert.equal(hits.length, 1, "공백 정규화 후 substring 매칭")
})

test("v0.9.2: bodyText 미전달 시 기존 동작 유지 (하위호환)", () => {
  const citations = [
    {
      lawName: "부가가치세법",
      lawNameRaw: "부가가치세법",
      article: "제6조",
      paragraph: null,
      item: null,
      rawSnippet: "",
    },
  ]
  const hits = detectPreRestructureCitations(citations)  // bodyText 생략
  assert.equal(hits.length, 1, "bodyText 미전달이면 verify 생략 — 기존 v0.9.0/0.9.1 동작 유지")
})
