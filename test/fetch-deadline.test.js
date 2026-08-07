import { test } from "node:test"
import { strict as assert } from "node:assert"

process.env.TAXLAW_MCP_TEST_MODE = "1"
// 개별 fetch 타임아웃을 짧게 — 테스트가 15초를 기다리지 않도록.
process.env.TAXLAW_FETCH_TIMEOUT_MS = "200"

const { fetchWithRetryCore, fetchTimeoutMs } = await import("../build/index.js")

// v0.27.2(리뷰 P1) — fetch와 body 읽기를 하나의 AbortController/타이머 아래로 묶은 것 검증.
//   종전: 헤더 수신 직후 clearTimeout → 호출부의 .text()/.json()은 타임아웃도 예산도 적용 못 받아
//   서버가 헤더만 보내고 본문을 끝내지 않으면 도구 호출이 사실상 무한 대기했다.

// 헤더는 즉시 200으로 주고, body는 abort될 때까지 영원히 안 끝나는 가짜 응답.
function makeStalledBodyFetch(observed) {
  return (_url, init) => {
    const signal = init?.signal
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      text: () =>
        new Promise((_resolve, reject) => {
          // 본문 스트림이 영원히 멈춘 상태를 모사. abort가 오면 그때서야 끊긴다.
          if (signal) {
            signal.addEventListener("abort", () => {
              observed.abortedDuringBody = true
              reject(new Error("The operation was aborted"))
            })
          }
        }),
    })
  }
}

test("fetchTimeoutMs: env override, 잘못된 값은 기본 15초", () => {
  assert.equal(fetchTimeoutMs(), 200)
  const saved = process.env.TAXLAW_FETCH_TIMEOUT_MS
  for (const bad of ["0", "-5", "abc", ""]) {
    process.env.TAXLAW_FETCH_TIMEOUT_MS = bad
    assert.equal(fetchTimeoutMs(), 15000, `bad=${bad}`)
  }
  process.env.TAXLAW_FETCH_TIMEOUT_MS = saved
})

test("fetchWithRetryCore: body가 정지하면 타임아웃이 스트림을 끊는다(무한대기 방지)", async () => {
  const observed = { abortedDuringBody: false }
  const original = globalThis.fetch
  globalThis.fetch = makeStalledBodyFetch(observed)
  const started = Date.now()
  try {
    await assert.rejects(
      () => fetchWithRetryCore("https://example.invalid/x", {}, 0, (r) => r.text()),
      /abort/i,
      "body 정지 시 거부되어야 함(종전에는 무한 대기)",
    )
  } finally {
    globalThis.fetch = original
  }
  const elapsed = Date.now() - started
  // 핵심: 타이머가 body 읽기 시점에도 살아 있었다는 증거.
  assert.ok(observed.abortedDuringBody, "body 읽기 중 abort가 전달되지 않음 = 타이머가 이미 해제됨")
  assert.ok(elapsed < 3000, `타임아웃(200ms)보다 과도하게 지연: ${elapsed}ms`)
})

test("fetchWithRetryCore: read=null이면 body를 건드리지 않는다(세션 경로 회귀)", async () => {
  let textCalled = false
  const original = globalThis.fetch
  globalThis.fetch = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "set-cookie": "JSESSIONID=abc; Path=/" }),
      text: () => {
        textCalled = true
        return Promise.resolve("")
      },
    })
  try {
    const { response, body } = await fetchWithRetryCore("https://example.invalid/s", {}, 0, null)
    assert.equal(body, null)
    assert.equal(response.status, 200)
    assert.equal(textCalled, false, "헤더만 쓰는 경로에서 body를 읽으면 안 됨")
  } finally {
    globalThis.fetch = original
  }
})

test("fetchWithRetryCore: 정상 응답은 body를 읽어 반환", async () => {
  const original = globalThis.fetch
  globalThis.fetch = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      text: () => Promise.resolve("<법령>ok</법령>"),
    })
  try {
    const { body } = await fetchWithRetryCore("https://example.invalid/ok", {}, 0, (r) => r.text())
    assert.equal(body, "<법령>ok</법령>")
  } finally {
    globalThis.fetch = original
  }
})

// ── v0.27.6(부분장애 검증) verify 헤더가 실제 결과를 반영하는가 ──────────
// 실측(NTS 다운 중): 3건 전부 조회 실패인데 헤더가 "검출 3건 중 3건 검증"으로 찍혀
// 상세·요약을 읽지 않으면 인용 게이트 통과로 오독됐다. 헤더는 결과 확정 후 조립해야 한다.
const { verifyNtsCitations } = await import("../build/index.js")

test("verifyNtsCitations(v0.27.6): 상류 장애 시 헤더가 '전부 조회 실패'를 명시", async () => {
  const original = globalThis.fetch
  globalThis.fetch = () => Promise.reject(new Error("Connect Timeout Error"))
  try {
    const r = await verifyNtsCitations({ text: "조심-2025-중-2511" })
    const t = r.content.map((c) => c.text).join("\n")
    assert.ok(!/중 \d+건 검증/.test(t), `장애인데 '검증' 표기 잔존: ${t.split("\n")[1]}`)
    assert.match(t, /전부 조회 실패/, "헤더에 전부 실패 고지 없음")
    assert.match(t, /인용 게이트를 통과시키지 마라/, "게이트 통과 금지 문구 없음")
    assert.match(t, /\? 실패 1/, "요약의 실패 카운트 불일치")
    // 장애를 '미발견'으로 둔갑시키면 안 된다(v0.21.0 P0 회귀 방지)
    assert.match(t, /✗ 미발견 0/, "장애가 미발견으로 둔갑")
  } finally {
    globalThis.fetch = original
  }
})

// ── v0.27.7 상류 서킷 브레이커 ─────────────────────────────────────────────
// 계기(실사고): 대량 검증 루프 중 NTS가 느려지자 호출마다 4회 재시도를 계속 던져 트래픽을
// 4배로 증폭 → 스로틀링이 IP 차단으로 승격. 사용자도 호출 1건당 47초를 기다렸다.
const { resetCircuits, circuitStatus } = await import("../build/index.js")
const deadFetch = () => Promise.reject(Object.assign(new Error("fetch failed"), { cause: new Error("Connect Timeout Error") }))
const aliveFetch = () => Promise.resolve({ ok: true, status: 200, statusText: "OK", headers: new Headers(), text: () => Promise.resolve("ok") })
const tryCall = async (url) => {
  try { await fetchWithRetryCore(url, {}, 3, (r) => r.text()); return "ok" }
  catch (e) { return /UPSTREAM_CIRCUIT_OPEN/.test(e.message) ? "open" : "fail" }
}

test("circuit(v0.27.7): 연속 연결실패 threshold 도달 시 회로가 열려 즉시 차단", async () => {
  process.env.TAXLAW_CIRCUIT_THRESHOLD = "3"
  process.env.TAXLAW_CIRCUIT_COOLDOWN_MS = "1500"
  process.env.TAXLAW_FETCH_TIMEOUT_MS = "100"
  resetCircuits()
  const original = globalThis.fetch
  globalThis.fetch = deadFetch
  try {
    const r = []
    for (let i = 0; i < 5; i++) r.push(await tryCall("https://cb1.example/x"))
    assert.deepEqual(r.slice(0, 3), ["fail", "fail", "fail"], `앞 3회는 실패여야: ${r}`)
    assert.deepEqual(r.slice(3), ["open", "open"], `이후는 회로차단이어야: ${r}`)
    const st = circuitStatus().find((c) => c.host === "cb1.example")
    assert.ok(st && st.openForMs > 0, "회로가 열려 있지 않음")
  } finally { globalThis.fetch = original; resetCircuits() }
})

test("circuit(v0.27.7): 호스트별 격리 — 한 상류가 죽어도 다른 상류는 정상", async () => {
  process.env.TAXLAW_CIRCUIT_THRESHOLD = "2"
  resetCircuits()
  const original = globalThis.fetch
  try {
    globalThis.fetch = deadFetch
    for (let i = 0; i < 3; i++) await tryCall("https://cb2-dead.example/x")
    assert.equal(await tryCall("https://cb2-dead.example/x"), "open", "죽은 상류 회로가 안 열림")
    globalThis.fetch = aliveFetch
    assert.equal(await tryCall("https://cb2-alive.example/y"), "ok", "정상 상류가 오염됨")
  } finally { globalThis.fetch = original; resetCircuits() }
})

test("circuit(v0.27.7): 쿨다운 경과 후 상류 회복되면 회로가 닫힌다", async () => {
  process.env.TAXLAW_CIRCUIT_THRESHOLD = "2"
  process.env.TAXLAW_CIRCUIT_COOLDOWN_MS = "300"
  resetCircuits()
  const original = globalThis.fetch
  try {
    globalThis.fetch = deadFetch
    for (let i = 0; i < 3; i++) await tryCall("https://cb3.example/x")
    assert.equal(await tryCall("https://cb3.example/x"), "open")
    await new Promise((r) => setTimeout(r, 400))
    globalThis.fetch = aliveFetch
    assert.equal(await tryCall("https://cb3.example/x"), "ok", "쿨다운 후에도 차단됨")
    const st = circuitStatus().find((c) => c.host === "cb3.example")
    assert.equal(st?.openForMs, 0, "성공했는데 회로가 안 닫힘")
  } finally { globalThis.fetch = original; resetCircuits() }
})

test("circuit(v0.27.7): HTTP 오류(500)는 연결실패가 아니므로 회로를 열지 않는다", async () => {
  process.env.TAXLAW_CIRCUIT_THRESHOLD = "2"
  resetCircuits()
  const original = globalThis.fetch
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 500, statusText: "ISE", headers: new Headers(), text: () => Promise.resolve("") })
  try {
    for (let i = 0; i < 4; i++) await tryCall("https://cb4.example/z")
    const st = circuitStatus().find((c) => c.host === "cb4.example")
    assert.ok(!st || st.openForMs === 0, `HTTP 500인데 회로가 열림: ${JSON.stringify(st)}`)
  } finally { globalThis.fetch = original; resetCircuits() }
})

test("circuit(v0.27.7): 차단 메시지가 '데이터 없음'과 구별되고 추측을 금지한다", async () => {
  process.env.TAXLAW_CIRCUIT_THRESHOLD = "1"
  resetCircuits()
  const original = globalThis.fetch
  globalThis.fetch = deadFetch
  try {
    await tryCall("https://cb5.example/x")
    let msg = ""
    try { await fetchWithRetryCore("https://cb5.example/x", {}, 3, (r) => r.text()) } catch (e) { msg = e.message }
    assert.match(msg, /UPSTREAM_CIRCUIT_OPEN/)
    assert.match(msg, /'데이터 없음'이 아니라/, "미존재 오인 방지 문구 없음")
    assert.match(msg, /추측·생성하지 마라/, "추측 금지 지시 없음")
    assert.match(msg, /반복 호출은 차단을 연장/, "재호출 억제 안내 없음")
  } finally { globalThis.fetch = original; resetCircuits(); delete process.env.TAXLAW_CIRCUIT_THRESHOLD }
})
