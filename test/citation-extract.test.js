import { test } from "node:test"
import { strict as assert } from "node:assert"

process.env.TAXLAW_MCP_TEST_MODE = "1"

const { extractLawArticleRefs, formatLawArticleRef } = await import("../build/citation-extract.js")

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
