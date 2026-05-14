#!/usr/bin/env node
// CSV → JSON 변환기.
// 입력: 사용자의 로컬 CSV (환경변수 UPJONG_CSV 또는 기본 경로)
// 출력: src/data/upjong-ksic.json
//
// CSV 컬럼(헤더 줄 기준, 0-indexed):
//   0  일련번호
//   1  업종코드(YYYY년 귀속)
//   2  대분류코드, 3 대분류명
//   4  중분류코드, 5 중분류명
//   6  소분류코드, 7 소분류명
//   8  세분류코드, 9 세분류명
//   10 세세분류명(업종코드 측 — 세세분류명만 있고 코드는 없음)
//   11 연계
//   12 표준산업분류코드(KSIC 5자리)
//   13 대분류코드, 14 대분류명
//   15 중분류코드, 16 중분류명
//   17 소분류코드, 18 소분류명
//   19 세분류코드, 20 세분류명
//   21 세세분류명(KSIC 측)
//   22 연계
//   23 메인
//   24 세부설명

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// CSV 경로는 환경변수 UPJONG_CSV로 지정하세요. 미지정 시 빈 DB가 생성됩니다.
// 원본 자료: 국세청 홈택스 「업종코드-표준산업분류 연계표」 (공개 자료, 출처 명시 권장)
const csvPath = process.env.UPJONG_CSV
const outPath = resolve(__dirname, "..", "src", "data", "upjong-ksic.json")

if (!csvPath || !existsSync(csvPath)) {
  console.error("[build-upjong-db] CSV not provided or not found.")
  console.error("  설정 방법:")
  console.error("    1. 국세청 홈택스에서 「업종코드-표준산업분류 연계표.csv」를 다운로드")
  console.error("    2. UPJONG_CSV 환경변수에 절대경로 지정 후 npm run build:data")
  console.error("       예: UPJONG_CSV=/path/to/연계표.csv npm run build:data")
  console.error("  → 미지정 시 빈 DB로 빌드합니다(MCP는 동작하나 업종코드 도구가 비어 있음).")
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), source: null, year: null, count: 0, records: [] }, null, 2))
  process.exit(0)
}

function parseCsv(text) {
  // RFC 4180 minimal parser. CR/LF tolerant, supports quoted fields with "" escapes.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const rows = []
  let row = []
  let field = ""
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else {
        field += ch
      }
    } else {
      if (ch === '"') inQuotes = true
      else if (ch === ",") { row.push(field); field = "" }
      else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = "" }
      else if (ch === "\r") { /* skip */ }
      else field += ch
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

const text = readFileSync(csvPath, "utf8")
const rows = parseCsv(text)

// Find the header row. The data file has a multi-line title block before the
// real header. We detect the header by looking for a row that contains the
// literal "업종코드" cell and "표준산업\n분류" cell.
let headerIdx = -1
for (let i = 0; i < rows.length; i++) {
  const cells = rows[i].map((c) => String(c).replace(/\s+/g, "").trim())
  if (cells.includes("대분류") && cells.some((c) => c.includes("업종코드")) && cells.some((c) => c.includes("표준산업"))) {
    headerIdx = i
    break
  }
}
if (headerIdx < 0) {
  console.error("[build-upjong-db] failed to locate header row")
  process.exit(1)
}

// Detect year from the header (e.g., "2024년\n업종코드")
let year = null
for (const cell of rows[headerIdx]) {
  const m = String(cell).match(/(\d{4})\s*년\s*귀속?/)
  if (m) { year = Number(m[1]); break }
}

const records = []
for (let i = headerIdx + 1; i < rows.length; i++) {
  const r = rows[i]
  if (!r || r.length < 12) continue
  const upjongCode = String(r[1] || "").replace(/\s+/g, "").trim()
  if (!/^\d{4,6}$/.test(upjongCode)) continue

  records.push({
    seq: Number(r[0]) || null,
    upjong: upjongCode,
    up: {
      l1Code: String(r[2] || "").trim() || null,
      l1Name: cleanCell(r[3]),
      l2Code: String(r[4] || "").trim() || null,
      l2Name: cleanCell(r[5]),
      l3Code: String(r[6] || "").trim() || null,
      l3Name: cleanCell(r[7]),
      l4Code: String(r[8] || "").trim() || null,
      l4Name: cleanCell(r[9]),
      l5Name: cleanCell(r[10]),
    },
    ksic: {
      code: String(r[12] || "").trim() || null,
      l1Code: String(r[13] || "").trim() || null,
      l1Name: cleanCell(r[14]),
      l2Code: String(r[15] || "").trim() || null,
      l2Name: cleanCell(r[16]),
      l3Code: String(r[17] || "").trim() || null,
      l3Name: cleanCell(r[18]),
      l4Code: String(r[19] || "").trim() || null,
      l4Name: cleanCell(r[20]),
      l5Name: cleanCell(r[21]),
    },
    note: cleanCell(r[24]),
  })
}

function cleanCell(value) {
  const s = String(value ?? "").replace(/\r/g, " ").replace(/\n/g, " ").replace(/\s+/g, " ").trim()
  return s || null
}

// source는 원본 CSV의 절대경로(사용자 환경 정보)이므로 익명 라벨로 기록한다.
writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: "NTS 홈택스 「업종코드-표준산업분류 연계표」 (공개 자료)",
      year,
      count: records.length,
      records,
    },
    null,
    2,
  ),
)

console.error(`[build-upjong-db] wrote ${records.length} records (year=${year}) → ${outPath}`)
