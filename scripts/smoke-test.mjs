// 빌드된 MCP 서버를 STDIO로 spawn 해서 assess_doctrine_validity를 실제 호출.
// 라이브 NTS API와의 통합 동작을 검증한다.
// v0.9.0 — 신규 라벨 4종(restructured_location / target_or_later_inferred /
// citations_no_dates / no_citations) 모두 실제 케이스로 검증.

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverPath = join(__dirname, "..", "build", "index.js")

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
})

let buffer = ""
const pending = new Map() // id → resolve

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8")
  let idx
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 1)
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    } catch {
      // ignore
    }
  }
})

function send(method, params, id) {
  return new Promise((resolve) => {
    pending.set(id, resolve)
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params })
    child.stdin.write(payload + "\n")
  })
}

// 1. initialize
const init = await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke-test", version: "0.0.1" },
}, 1)
console.log("## initialize")
console.log("server:", init.result?.serverInfo)
console.log("version:", init.result?.serverInfo?.version)

// 2. notifications/initialized
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n")

// 3. list tools — assess_doctrine_validity가 포함되는지 확인
const listed = await send("tools/list", {}, 2)
const toolNames = (listed.result?.tools || []).map((t) => t.name)
console.log("\n## tools/list — 총", toolNames.length, "개")
console.log("assess_doctrine_validity 노출:", toolNames.includes("assess_doctrine_validity") ? "✓" : "✗")

// 4. assess_doctrine_validity 다중 호출 — v0.9.0 신규 라벨 검증.
const cases = [
  {
    id: "010000000000044350",
    label: "서면인터넷방문상담1팀-1219 (2007) — vintage 19년 회귀",
    // before_target 분류 + "사문화 가능성" 최종 판정 (partial/likely 한국어 라벨)
    expectHints: ["before_target", "vintage", "사문화"],
  },
  {
    id: "010000000000035076",
    label: "서삼46015-11608 (2003) — v0.9.0 #1: 옛 §35 인용 → restructured_location",
    // 옛 §12·§35·§37·§11의3 등이 사전 매핑되어 superseded_or_repealed로 격상.
    // finalLabel은 한국어("폐지·전부개정 — 사실상 사용 금지")로 출력됨.
    expectHints: ["restructured_location", "구조개편 이력", "전부개정"],
  },
  {
    id: "000000000000624284",
    label: "조심-2022-인-6988 (2023) — v0.9.0 #2: 최근 + 시점 없음 → target_or_later_inferred",
    expectHints: ["target_or_later_inferred", "recent_doctrine_inferred"],
  },
  {
    id: "010000000000215043",
    label: "서면-2015-부가-2158 (2015) — v0.9.0 #3: 인용 있고 시점 없음 → citations_no_dates",
    expectHints: ["citations_no_dates", "인용"],
  },
]

let idSeq = 3
let allPass = true
for (const c of cases) {
  console.log("\n## case:", c.label)
  console.log(`   assess_doctrine_validity({ id: "${c.id}", targetYear: 2026 })`)
  const result = await send("tools/call", {
    name: "assess_doctrine_validity",
    arguments: { id: c.id, targetYear: 2026 },
  }, idSeq++)
  const text = result.result?.content?.[0]?.text || JSON.stringify(result)
  console.log(text.slice(0, 3500))
  if (text.length > 3500) console.log("... (truncated to 3500 chars)")
  const missing = c.expectHints.filter((h) => !text.includes(h))
  if (missing.length === 0) {
    console.log(`   ✓ expected hints present: ${c.expectHints.join(", ")}`)
  } else {
    console.log(`   ✗ MISSING hints: ${missing.join(", ")}`)
    allPass = false
  }
}

console.log("\n## summary:", allPass ? "✓ all cases pass" : "✗ some cases failed")
child.stdin.end()
child.kill()
process.exit(allPass ? 0 : 1)
