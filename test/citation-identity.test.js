import { test, after } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.TAXLAW_MCP_TEST_MODE = "1"
const temp = mkdtempSync(join(tmpdir(), "nts-identity-"))
process.env.TAXLAW_CITATION_LEDGER = join(temp, "ledger.jsonl")
after(() => rmSync(temp, { recursive: true, force: true }))
const { extractNtsCitations, matchesCitationIdentity, verifyNtsCitations } = await import("../build/index.js")

test("citation identity: full identifier required; title references are not identity", () => {
  const [cit] = extractNtsCitations("조심-2024-서-123")
  assert.equal(matchesCitationIdentity({ NTST_DCM_DSCM_CNTN: "조심-2024-서-1234" }, cit), false)
  assert.equal(matchesCitationIdentity({ NTST_DCM_DSCM_CNTN: "조심-2024-서-999", TTL: "조심-2024-서-123 관련" }, cit), false)
  assert.equal(matchesCitationIdentity({ NTST_DCM_RPLY_CNTN: "조심 2024 서 123" }, cit), true)
  const [court] = extractNtsCitations("2006두18652")
  assert.equal(matchesCitationIdentity({ NTST_DCM_DSCM_CNTN: "대법원-2006-두-18652" }, court), true)
  for (const [wanted, invalid] of [
    ["조심-2024-서-12345", "조심-2024-서-123456"],
    ["서면-2024-법규부가-123456", "서면-2024-법규부가-1234567"],
    ["2024두1234567", "2024두12345678"],
    ["2024두1234567", "12024두1234567"],
  ]) {
    const [citation] = extractNtsCitations(wanted)
    assert.equal(matchesCitationIdentity({ NTST_DCM_DSCM_CNTN: invalid }, citation), false, invalid)
  }
})

test("verify integration: prefix/title hits cannot be confirmed or logged as existing", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    if (!init.body) return new Response("", { headers: { "set-cookie": "JSESSIONID=test; Path=/" } })
    const form = new URLSearchParams(init.body)
    const action = form.get("actionId")
    if (action !== "ASIPDI002PR01") throw new Error("false hit triggered detail lookup")
    return Response.json({ status: "SUCCESS", data: { ASIPDI002PR01: { body: [
      { dcm: { DOC_ID: "wrong-prefix", NTST_DCM_DSCM_CNTN: "조심-2024-서-1234", TTL: "다른 사건" } },
      { dcm: { DOC_ID: "wrong-title", NTST_DCM_DSCM_CNTN: "조심-2024-서-999", TTL: "조심-2024-서-123 참조" } },
    ] } } })
  }
  try {
    const result = await verifyNtsCitations({ text: "조심-2024-서-123" })
    const output = result.content.map((c) => c.text).join("\n")
    assert.match(output, /공개DB 미발견/)
    assert.doesNotMatch(output, /— 실존 확인:/)
    const ledger = readFileSync(process.env.TAXLAW_CITATION_LEDGER, "utf8").trim().split("\n").map(JSON.parse)
    assert.equal(ledger.length, 1)
    assert.equal(ledger[0].exists, false)
  } finally { globalThis.fetch = original }
})
