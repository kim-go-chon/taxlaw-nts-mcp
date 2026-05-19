// 빌드된 0.7.0 모듈을 직접 import해서 사례 본문을 평가하는 self-review 스크립트.
// 본문은 fixtures/self-review/*.json 파일로부터 읽는다.
//
// JSON 스키마:
// {
//   "id": "...",
//   "docNumber": "...",
//   "productionDate": "YYYY.MM.DD",
//   "title": "...",
//   "type": "질의회신",
//   "relatedLawsMeta": "소득세법 제14조, …",
//   "body": "본문 텍스트 (gist + answer + bodyText 결합)",
//   "targetYear": 2026,
//   "expectedFinalValidity": "partially_outdated"   // optional
// }

import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, "..", "fixtures", "self-review")

const { checkYearApplicability } = await import("../build/year-check.js")
const { extractLawArticleRefs } = await import("../build/citation-extract.js")
const { assessDoctrineValidity } = await import("../build/doctrine-assess.js")

const files = (await readdir(fixturesDir)).filter((f) => f.endsWith(".json")).sort()
const rows = []
let mismatches = 0
for (const f of files) {
  const raw = await readFile(join(fixturesDir, f), "utf8")
  const fx = JSON.parse(raw)
  const yc = checkYearApplicability({
    bodyText: fx.body || "",
    targetYear: fx.targetYear,
    metadataCitations: fx.relatedLawsMeta || "",
  })
  const refs = extractLawArticleRefs([fx.body, fx.relatedLawsMeta].filter(Boolean).join("\n"))
  const a = assessDoctrineValidity({
    meta: {
      id: fx.id,
      title: fx.title || "",
      docNumber: fx.docNumber || "",
      productionDate: fx.productionDate || "",
      type: fx.type || "",
      taxLawCode: fx.taxLawCode || "",
      relatedLawsMeta: fx.relatedLawsMeta || "",
    },
    yearCheck: yc,
    citedArticles: refs,
    targetYear: fx.targetYear,
  })
  const expected = fx.expectedFinalValidity
  const matched = expected ? expected === a.finalValidity : null
  if (matched === false) mismatches++
  rows.push({
    file: f,
    docNumber: fx.docNumber,
    productionDate: fx.productionDate,
    targetYear: fx.targetYear,
    citationCount: a.yearCheck.citationCount,
    metaFallback: a.yearCheck.usedMetadataFallback,
    classification: a.yearCheck.classification,
    finalValidity: a.finalValidity,
    expected: expected || "—",
    match: matched === null ? "n/a" : matched ? "✓" : "✗",
    topSignals: a.signals.map((s) => `${s.severity}:${s.kind}`).slice(0, 3).join(", "),
    extractedRefs: refs.length,
  })
}

console.log(`\n## Self-Review Report — ${rows.length} fixtures\n`)
console.log("| file | docNumber | date | tgtYr | cls | final | expected | match | refs | signals |")
console.log("|------|-----------|------|-------|-----|-------|----------|-------|------|---------|")
for (const r of rows) {
  console.log(
    `| ${r.file} | ${r.docNumber} | ${r.productionDate} | ${r.targetYear} | ${r.classification}${r.metaFallback ? "(meta)" : ""} | ${r.finalValidity} | ${r.expected} | ${r.match} | ${r.extractedRefs} | ${r.topSignals} |`,
  )
}
console.log(`\nMismatches: ${mismatches}/${rows.filter((r) => r.expected !== "—").length}\n`)
process.exit(mismatches > 0 ? 1 : 0)
