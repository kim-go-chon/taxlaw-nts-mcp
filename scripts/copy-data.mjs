#!/usr/bin/env node
// src/data/*.json → build/data/*.json 복사. tsc는 .ts만 컴파일하므로 JSON은 수동 복사 필요.
import { mkdirSync, copyFileSync, readdirSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve, extname } from "node:path"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const src = resolve(__dirname, "..", "src", "data")
const dest = resolve(__dirname, "..", "build", "data")

if (!existsSync(src)) {
  console.error(`[copy-data] no src/data → skip`)
  process.exit(0)
}

mkdirSync(dest, { recursive: true })
const entries = readdirSync(src)
let n = 0
for (const name of entries) {
  if (extname(name).toLowerCase() !== ".json") continue
  copyFileSync(resolve(src, name), resolve(dest, name))
  n++
}
console.error(`[copy-data] copied ${n} json file(s) → ${dest}`)
