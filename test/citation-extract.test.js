import { test } from "node:test"
import { strict as assert } from "node:assert"

process.env.TAXLAW_MCP_TEST_MODE = "1"

const { extractLawArticleRefs, formatLawArticleRef, extractBasicRulingRefs, formatBasicRulingRef } = await import("../build/citation-extract.js")

test("extractLawArticleRefs: basic 법령 + 제N조 + 제M항", () => {
  const refs = extractLawArticleRefs("「조세특례제한법」 제18조의2 제2항에 따라 …")
  assert.equal(refs.length, 1)
  assert.equal(refs[0].lawName, "조세특례제한법")
  assert.equal(refs[0].article, "제18조의2")
  assert.equal(refs[0].paragraph, "제2항")
  assert.equal(refs[0].item, null)
})

test("extractLawArticleRefs: multiple laws in single text", () => {
  const text = "Ο 소득세법 제52조 제11항 ... Ο 조세특례제한법 제18조의2 제2항"
  const refs = extractLawArticleRefs(text)
  const names = refs.map((r) => `${r.lawName} ${r.article} ${r.paragraph}`)
  assert.ok(names.includes("소득세법 제52조 제11항"), `got: ${names.join(" | ")}`)
  assert.ok(names.includes("조세특례제한법 제18조의2 제2항"), `got: ${names.join(" | ")}`)
})

test("extractLawArticleRefs: alias '조특법' → '조세특례제한법'", () => {
  const refs = extractLawArticleRefs("조특법 제6조 제3항 제16호")
  assert.equal(refs.length, 1)
  assert.equal(refs[0].lawName, "조세특례제한법")
  assert.equal(refs[0].lawNameRaw, "조특법")
  assert.equal(refs[0].article, "제6조")
  assert.equal(refs[0].paragraph, "제3항")
  assert.equal(refs[0].item, "제16호")
})

test("extractLawArticleRefs: 시행령 distinguished from base law", () => {
  const refs = extractLawArticleRefs("법인세법 시행령 제19조 제1항에 따라 …")
  assert.equal(refs.length, 1)
  assert.equal(refs[0].lawName, "법인세법 시행령")
  assert.equal(refs[0].article, "제19조")
})

test("extractLawArticleRefs: ignores law name without article reference", () => {
  // 법령명만 떨어져 있고 조문 인용이 없으면 추출되지 않아야 함.
  const refs = extractLawArticleRefs("관련법령: 소득세법, 조세특례제한법")
  assert.equal(refs.length, 0)
})

// 0.7.1 핫픽스 회귀 — "법률 제N호" / "대통령령 제N호"는 호(item)가 아닌 법령번호.
// citation 추출 시 잘못된 item으로 매핑되지 않아야 한다.
test("extractLawArticleRefs: '법률 제N호' / '대통령령 제N호' is not extracted as 호 (hotfix)", () => {
  const text = "구 조세감면규제법 (1990. 12. 31. 법률 제4285호) 부칙 제23조"
  const refs = extractLawArticleRefs(text)
  // 법률번호 4285가 호로 잡히면 안 됨.
  assert.ok(!refs.some((r) => r.item === "제4285호"), `bad refs: ${JSON.stringify(refs)}`)
})

test("extractLawArticleRefs: 대통령령 제N호 + 시행령 제M조 → article만 추출, 대통령령 번호는 호 아님 (hotfix)", () => {
  const text = "구 조세특례제한법 시행령(1998. 12. 31. 대통령령 제15976호로 전문개정된 것) 제138조"
  const refs = extractLawArticleRefs(text)
  // article=제138조는 OK, item=제15976호는 아니어야 함
  const article138 = refs.find((r) => r.article === "제138조")
  assert.ok(article138, `expected 제138조 ref: got ${JSON.stringify(refs)}`)
  assert.equal(article138.item, null, `대통령령 번호가 호로 잘못 추출됨: ${JSON.stringify(article138)}`)
})

// 0.8.0 — 기본통칙 인용 추출 (옛 번호 "N-N" vs 현행 "N-N…M") — 환각·누락 방지용.

test("extractBasicRulingRefs: 옛 번호 형식 'N-N' 검출", () => {
  // 2006년 질의회신 본문에 종종 등장하는 옛 통칙 번호.
  const text = "○ 소득세법 기본통칙 27-12 【장기손해보험계약에 관련된 보험료의 필요경비산입 범위】"
  const refs = extractBasicRulingRefs(text)
  assert.equal(refs.length, 1)
  assert.equal(refs[0].taxLaw, "소득세법")
  assert.equal(refs[0].major, "27")
  assert.equal(refs[0].minor, "12")
  assert.equal(refs[0].sub, null)
  assert.equal(refs[0].format, "legacy_candidate")
})

test("extractBasicRulingRefs: 현행 번호 형식 'N-N…M' 검출 (HORIZONTAL ELLIPSIS)", () => {
  const text = "소득세법 기본통칙 27-55…10 【장기손해보험계약에 관련된 보험료의 필요경비산입 범위】"
  const refs = extractBasicRulingRefs(text)
  assert.equal(refs.length, 1)
  assert.equal(refs[0].major, "27")
  assert.equal(refs[0].minor, "55")
  assert.equal(refs[0].sub, "10")
  assert.equal(refs[0].format, "current")
})

test("extractBasicRulingRefs: 현행 번호 '...' (3-dot) 표기도 인정", () => {
  const text = "법인세법 기본통칙 19-19...11 관련 비용 처리"
  const refs = extractBasicRulingRefs(text)
  assert.equal(refs.length, 1)
  assert.equal(refs[0].taxLaw, "법인세법")
  assert.equal(refs[0].sub, "11")
  assert.equal(refs[0].format, "current")
})

test("extractBasicRulingRefs: 세법명 없이 '통칙' 키워드만 있어도 추출", () => {
  const text = "통칙 27-6에 따라 …"
  const refs = extractBasicRulingRefs(text)
  assert.equal(refs.length, 1)
  assert.equal(refs[0].taxLaw, null)
  assert.equal(refs[0].format, "legacy_candidate")
})

test("extractBasicRulingRefs: 옛+현행 혼합 본문에서 모두 검출", () => {
  const text = `
    ○ 소득세법 기본통칙 27-12 (구) ...
    ○ 현행: 소득세법 기본통칙 27-55…10 ...
    ○ 법인세법 기본통칙 19-19…11 ...
  `
  const refs = extractBasicRulingRefs(text)
  assert.equal(refs.length, 3)
  assert.equal(refs.filter((r) => r.format === "legacy_candidate").length, 1)
  assert.equal(refs.filter((r) => r.format === "current").length, 2)
})

test("extractBasicRulingRefs: '제27조 제6호' 같은 조-호 표기는 통칙으로 오인하지 않음", () => {
  // "통칙" 키워드가 앞에 없으면 추출 X.
  const text = "소득세법 제27조 제6호 ...  제33조 ① 5호"
  const refs = extractBasicRulingRefs(text)
  assert.equal(refs.length, 0)
})

test("formatBasicRulingRef: 옛/현행 라벨 차이", () => {
  const legacy = { raw: "기본통칙 27-12", taxLaw: "소득세법", major: "27", minor: "12", sub: null, format: "legacy_candidate" }
  const current = { raw: "기본통칙 27-55…10", taxLaw: "소득세법", major: "27", minor: "55", sub: "10", format: "current" }
  assert.equal(formatBasicRulingRef(legacy), "소득세법 기본통칙 27-12")
  assert.equal(formatBasicRulingRef(current), "소득세법 기본통칙 27-55…10")
})

test("formatLawArticleRef: composes a readable label", () => {
  const ref = {
    lawName: "조세특례제한법",
    lawNameRaw: "조특법",
    article: "제6조",
    paragraph: "제3항",
    item: "제16호",
    rawSnippet: "조특법 제6조 제3항 제16호",
  }
  assert.equal(formatLawArticleRef(ref), "조세특례제한법 제6조 제3항 제16호")
})
