// v0.10.0 스모크 — diff_article_versions·research_taxlaw_topic 실호출 + 캐시 체감 확인.
// 실행: node scripts/smoke-v0100.mjs  (LAW_GO_KR_OC 필요)
process.env.TAXLAW_MCP_TEST_MODE = "1"

const mod = await import("../build/index.js")

const head = (r, n = 2600) => {
  const text = r?.content?.[0]?.text ?? "(no text)"
  return text.length > n ? `${text.slice(0, n)}\n…[smoke 출력 절단]` : text
}

console.log("━━━ 1) diff_article_versions: 조특령 §26의8 ⑥, 2024 vs 2026 (절사문구 검출 기대) ━━━")
const d0 = Date.now()
const r1 = await mod.diffArticleVersionsTool({
  jo: "제26조의8",
  hang: "제6항",
  lawName: "조세특례제한법 시행령",
  yearA: 2024,
  yearB: 2026,
})
console.log(`(${Date.now() - d0}ms, isError=${!!r1.isError})`)
console.log(head(r1))

console.log("\n━━━ 2) 같은 diff 재호출 — fetchMolegXml 캐시 체감 ━━━")
const d1 = Date.now()
await mod.diffArticleVersionsTool({
  jo: "제26조의8",
  hang: "제6항",
  lawName: "조세특례제한법 시행령",
  yearA: 2024,
  yearB: 2026,
})
console.log(`재호출 ${Date.now() - d1}ms (1회차 대비 단축 기대)`)

console.log("\n━━━ 3) research_taxlaw_topic: 검색+본문+연도검증 1콜 (+staleness 플래그 확인) ━━━")
const d2 = Date.now()
const r3 = await mod.researchTaxlawTopic({
  query: "통합고용세액공제 상시근로자",
  targetYear: 2025,
  topK: 1,
})
const firstMs = Date.now() - d2
const d3 = Date.now()
await mod.researchTaxlawTopic({
  query: "통합고용세액공제 상시근로자",
  targetYear: 2025,
  topK: 1,
})
console.log(`1회차 ${firstMs}ms → 재호출 ${Date.now() - d3}ms (NTS 캐시 체감), isError=${!!r3.isError}`)
console.log(head(r3, 3200))
const fullText = r3?.content?.[0]?.text ?? ""
console.log(`\n[staleness 플래그 포함 여부] ${fullText.includes("년 경과") ? "✅ 검출" : "ℹ 이번 결과엔 오래된 문서 없음(플래그 미출현)"}`)
