// 빌드된 0.7.0 MCP 서버를 STDIO로 spawn 해서 assess_doctrine_validity를 실제 호출.
// 라이브 NTS API와의 통합 동작을 검증한다.

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

// 4. assess_doctrine_validity 호출 — 어제 인용한 첫 케이스
const targetId = "010000000000044350" // 서면인터넷방문상담1팀-1219
console.log("\n## assess_doctrine_validity({ id:", targetId, ", targetYear: 2026 })")
const result = await send("tools/call", {
  name: "assess_doctrine_validity",
  arguments: { id: targetId, targetYear: 2026 },
}, 3)
const text = result.result?.content?.[0]?.text || JSON.stringify(result)
console.log(text.slice(0, 4500))
if (text.length > 4500) console.log("... (truncated to 4500 chars)")

child.stdin.end()
child.kill()
process.exit(0)
