// 검증 하네스 공용 런타임 — '상류에 해를 끼치지 않는' 안전장치를 기본값으로 강제한다.
//
// 왜 있나(실사고 2026-08-07): 대량 검증 루프를 상류 상태를 보지 않고 반복 실행해
//   국세청(taxlaw/www.nts/hometax)에서 IP 차단을 당했다. 제품 쪽 재시도 증폭은 v0.27.7
//   서킷 브레이커로 막았지만, '하네스가 폭주하지 않게' 하는 책임은 여기에 있다.
//
// 기본 안전장치(끄려면 명시적으로 opts를 넘겨야 한다):
//   1) 사전 점검(preflight) — 상류가 죽어 있으면 그 상류에 의존하는 시나리오를 아예 건너뛴다
//   2) 레이트 리밋 — 상류별 최소 호출 간격
//   3) 하네스 서킷 — 연속 실패가 쌓이면 그 상류 시나리오를 중단(제품 서킷과 별개의 2차 방어)
//   4) 지연 감시 — 응답이 기준선 대비 급격히 느려지면 감속 후 중단(스로틀링 조기 감지)
//   5) 총 요청 예산 — 한 번의 실행이 쓸 수 있는 상류 호출 수 상한
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const HERE = dirname(fileURLToPath(import.meta.url))
export const SERVER = resolve(HERE, "../../build/index.js")

/** 도구 → 주 상류 매핑. 사전 점검·레이트 리밋·서킷을 상류별로 적용하기 위한 분류. */
export const UPSTREAM = {
  NTS: "taxlaw.nts.go.kr",
  MOLEG: "www.law.go.kr",
  LOCAL: "(local)",
}
const NTS_TOOLS = new Set([
  "search_taxlaw_all", "search_taxlaw_documents", "get_taxlaw_document_text",
  "get_taxlaw_document_by_number",
  "verify_nts_citations", "list_taxlaw_basic_ruling_laws", "get_taxlaw_basic_ruling_text",
  "search_taxlaw_forms", "search_taxlaw_publications", "list_taxlaw_publication_categories",
  "research_taxlaw_topic", "assess_doctrine_validity", "get_taxlaw_page_text",
  "call_taxlaw_action", "get_taxlaw_hometax_counsel_text",
])
const MOLEG_TOOLS = new Set([
  "get_law_article", "get_law_addenda", "get_law_revision_text",
  "trace_article_application", "build_application_timetable", "diff_article_versions",
])
const LOCAL_EXTRA = new Set([
  "lookup_upjong_code", "lookup_ksic_code", "lookup_ksic_prefix", "search_industry_by_keyword",
  "resolve_industry_class", "classify_industry_for_article", "upjong_db_info",
])

export function upstreamOf(tool, args) {
  if (tool === "classify_credit_eligibility") return UPSTREAM.LOCAL
  if (tool === "call_taxlaw_extra") {
    const sub = args?.name
    if (LOCAL_EXTRA.has(sub)) return UPSTREAM.LOCAL
    return UPSTREAM.NTS
  }
  if (NTS_TOOLS.has(tool)) return UPSTREAM.NTS
  if (MOLEG_TOOLS.has(tool)) return UPSTREAM.MOLEG
  return UPSTREAM.LOCAL
}

/** 상류 생존 확인(HEAD 대신 GET, 짧은 타임아웃). 실패해도 예외를 던지지 않는다. */
export async function probe(host, timeoutMs = 8000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const r = await fetch(`https://${host}/`, { signal: ac.signal, redirect: "manual" })
    return { host, up: true, status: r.status, ms: Date.now() - t0 }
  } catch {
    return { host, up: false, status: 0, ms: Date.now() - t0 }
  } finally { clearTimeout(t) }
}

// 2026-08-09 재조정: 400ms·예산 400은 여전히 과했다(법제처까지 차단당함). 사람이 브라우저로
//   훑는 속도(초당 1회 미만)를 넘지 않도록 낮춘다. 검증이 느려지는 건 감수한다 — 차단당하면 0이다.
const DEFAULTS = {
  minIntervalMs: { [UPSTREAM.NTS]: 3000, [UPSTREAM.MOLEG]: 3000, [UPSTREAM.LOCAL]: 0 },
  failThreshold: 3,        // 상류별 연속 실패 → 해당 상류 시나리오 중단
  budget: 60,              // 실행 1회당 상류 호출 총량 상한
  latencyGuard: 8,         // 기준선(첫 성공 5건 중앙값) 대비 배수 초과가 3연속이면 중단
  latencyStreak: 3,
  callTimeoutMs: 120000,
  preflight: true,
}

export async function createHarness(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts, minIntervalMs: { ...DEFAULTS.minIntervalMs, ...(opts.minIntervalMs || {}) } }

  // ── 사전 점검 ──
  const health = { [UPSTREAM.LOCAL]: true }
  if (cfg.preflight) {
    for (const h of [UPSTREAM.NTS, UPSTREAM.MOLEG]) {
      const p = await probe(h)
      health[h] = p.up
      console.log(`  preflight ${h.padEnd(20)} ${p.up ? `UP (HTTP ${p.status}, ${p.ms}ms)` : "DOWN — 이 상류 시나리오는 건너뜁니다"}`)
    }
  } else {
    health[UPSTREAM.NTS] = true; health[UPSTREAM.MOLEG] = true
  }

  const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } })
  let buf = "", stderr = ""
  const pending = new Map()
  const nonJson = []
  child.stdout.on("data", (d) => {
    buf += d.toString(); let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue
      try { const m = JSON.parse(line); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m) } }
      catch { nonJson.push(line.slice(0, 120)) }
    }
  })
  child.stderr.on("data", (d) => { stderr += d.toString() })

  let id = 1
  const rpc = (method, params, ms) => {
    const my = id++
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n")
    return new Promise((res) => {
      const t = setTimeout(() => { pending.delete(my); res({ __timeout: true }) }, ms)
      pending.set(my, (m) => { clearTimeout(t); res(m) })
    })
  }

  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "harness", version: "1" } }, 30000)
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")

  const state = {
    lastAt: {}, fails: {}, tripped: {}, latSamples: [], baseline: 0, slowStreak: 0,
    used: 0, skipped: 0, aborted: null,
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /**
   * 안전 호출. 반환: { text, ms, skipped?, reason? }
   *  - skipped=true 면 상류 다운/서킷/예산 소진으로 호출하지 않은 것(실패와 구분해야 한다)
   */
  async function call(tool, args) {
    const up = upstreamOf(tool, args)

    if (!health[up]) { state.skipped++; return { text: "", ms: 0, skipped: true, reason: `상류 ${up} DOWN` } }
    if (state.tripped[up]) { state.skipped++; return { text: "", ms: 0, skipped: true, reason: `하네스 서킷 오픈(${up})` } }
    if (up !== UPSTREAM.LOCAL && state.used >= cfg.budget) {
      state.skipped++; return { text: "", ms: 0, skipped: true, reason: `요청 예산 소진(${cfg.budget})` }
    }

    // 레이트 리밋
    const gap = cfg.minIntervalMs[up] ?? 0
    if (gap > 0) {
      const wait = gap - (Date.now() - (state.lastAt[up] ?? 0))
      if (wait > 0) await sleep(wait)
    }
    state.lastAt[up] = Date.now()
    if (up !== UPSTREAM.LOCAL) state.used++

    const t0 = Date.now()
    const r = await rpc("tools/call", { name: tool, arguments: args }, cfg.callTimeoutMs)
    const ms = Date.now() - t0
    const text = r.__timeout ? "" : (r.result?.content?.map((c) => c.text).join("\n") ?? "")
    const timedOut = !!r.__timeout
    const upstreamErr = timedOut || /^\[EXTERNAL_API_ERROR|UPSTREAM_CIRCUIT_OPEN|fetch failed|Connect Timeout/.test(text)

    // 서킷: 연속 실패 집계
    if (up !== UPSTREAM.LOCAL) {
      if (upstreamErr) {
        state.fails[up] = (state.fails[up] ?? 0) + 1
        if (state.fails[up] >= cfg.failThreshold) {
          state.tripped[up] = true
          console.log(`  ⚠ 하네스 서킷 오픈 — ${up} 연속 실패 ${state.fails[up]}회. 해당 상류 시나리오를 중단합니다(상류 보호).`)
        }
      } else {
        state.fails[up] = 0
        // 지연 감시: 기준선 대비 급증 감지
        state.latSamples.push(ms)
        if (!state.baseline && state.latSamples.length >= 5) {
          const s = [...state.latSamples].sort((a, b) => a - b)
          state.baseline = Math.max(300, s[Math.floor(s.length / 2)])
        }
        if (state.baseline && ms > state.baseline * cfg.latencyGuard) {
          state.slowStreak++
          if (state.slowStreak >= cfg.latencyStreak) {
            state.tripped[up] = true
            console.log(`  ⚠ 하네스 중단 — ${up} 응답이 기준선(${state.baseline}ms) 대비 ${cfg.latencyGuard}배 초과가 ${state.slowStreak}연속. 스로틀링 조짐으로 보고 멈춥니다.`)
          }
        } else state.slowStreak = 0
      }
    }
    return { text, ms, skipped: false, timedOut }
  }

  return {
    call,
    health,
    stats: () => ({ ...state, nonJsonStdout: nonJson.slice(0, 3) }),
    stderr: () => stderr,
    close: () => { try { child.kill() } catch {} },
  }
}

/** 결과 텍스트가 '정상 응답'인지(에러·스킵 아님) */
export const isOk = (r) => r && !r.skipped && r.text && !/^\[/.test(r.text)
