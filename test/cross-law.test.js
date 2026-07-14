import { test } from "node:test"
import { strict as assert } from "node:assert"

// v0.25.0(리뷰) 통합경로 테스트 — 준용 타법(cross-law) 2층 타임라인의 근본수정(EF-3·A1·A3·A4·A5·A6·A8·TK-1·A2)을
// globalThis.fetch mock으로 end-to-end 구동한다. 직접 함수 호출이라 budget store 미설정 → remainingBudgetMs=Infinity로
// 15s cross 게이트 자동 통과. 픽스처는 실물 파서(parseLawAddenda·findArticleInXml·extractJoClauses·classifyApplicationClause)에
// 맞춰 CDATA 조문("제N조(")·부칙 문형을 정확히 재현.
process.env.TAXLAW_MCP_TEST_MODE = "1"

const { traceArticleApplication, buildApplicationTimetable, getLawArticle } = await import("../build/index.js")

// ── 픽스처 빌더 ──
const lawXml = ({ title, articles = [], addenda = [] }) =>
  `<법령><법령명_한글><![CDATA[${title}]]></법령명_한글><공포일자>20250101</공포일자>` +
  articles.map((a) => `<조문단위><조문내용><![CDATA[${a}]]></조문내용></조문단위>`).join("") +
  `<부칙>${addenda.map((u) => `<부칙단위><부칙공포일자>${u.date}</부칙공포일자><부칙공포번호>${u.no}</부칙공포번호><부칙내용><![CDATA[${u.text}]]></부칙내용></부칙단위>`).join("")}</부칙></법령>`
const eflawXml = (rows) => `<LawSearch>${rows.map((r) =>
  `<law><법령일련번호>${r.mst}</법령일련번호><법령명한글><![CDATA[${r.name}]]></법령명한글><시행일자>${r.enf}</시행일자><공포일자>${r.prom}</공포일자></law>`).join("")}</LawSearch>`

// 부칙 문형(§3-4 표) — 실물 classifyApplicationClause 대조 완료
const APPLY_TAX_YEAR = (jo, y = 2024) => `제2조(적용례) ${jo}의 개정규정은 ${y}년 1월 1일 이후 개시하는 과세연도 분부터 적용한다.`
const APPLY_FILING = (jo) => `제2조(적용례) ${jo}의 개정규정은 이 법 시행 이후 과세표준을 신고하는 경우부터 적용한다.`
const TRANSITIONAL = (jo) => `제3조(경과조치) ${jo}의 개정규정에도 불구하고 2023년 분은 종전의 규정에 따른다.`

// ── 전역 라우터 + 픽스처 레지스트리(모듈 로드 시 1회 설치) ──
const LAWS = {}       // MST -> lawService XML
const EFLAW = {}      // 법령명(raw) -> eflaw XML
const fetchLog = []
globalThis.fetch = async (url) => {
  fetchLog.push(url)
  const u = new URL(url)
  const target = u.searchParams.get("target")
  const mst = u.searchParams.get("MST")
  const query = u.searchParams.get("query")
  let body = "<LawSearch></LawSearch>"
  if (u.pathname.includes("lawService.do") && mst) body = LAWS[mst] || "<법령></법령>"
  else if (target === "eflaw") body = EFLAW[query] || "<LawSearch></LawSearch>"
  return { ok: true, status: 200, text: async () => body }
}
const textOf = (res) => res.content.map((c) => c.text).join("\n")

// ══════════════ C1 (Codex 1+2+6): self 부칙 0건이어도 준용 타법 층 회수 + provenance + caveat ══════════════
LAWS["8001"] = lawXml({
  title: "C1자기법",
  articles: ["제10조(계산) ① 계산방법은 「A1타법」 제5조를 준용한다."],
  addenda: [{ date: "20200101", no: "9001", text: APPLY_TAX_YEAR("제99조", 2020) }], // 제10조 무언급 → matched=0
})
LAWS["9001"] = lawXml({
  title: "A1타법",
  articles: ["제5조(계산방법) 상시근로자 수 계산방법."],
  addenda: [{ date: "20240101", no: "1", text: APPLY_TAX_YEAR("제5조", 2024) }],
})
EFLAW["A1타법"] = eflawXml([{ mst: "9001", name: "A1타법", enf: "20200101", prom: "20200101" }])

test("C1(A1·A3·A6): self 부칙 0건 + 준용 타법 자동 인출 — NOT_FOUND 금지·verbatim·provenance·caveat", async () => {
  const text = textOf(await traceArticleApplication({ jo: "제10조", mst: "8001", oc: "OCA1" }))
  assert.ok(!text.includes("[NOT_FOUND]"), "준용 탐지 시 조기 NOT_FOUND 금지")
  assert.ok(text.includes("준용 체인(자동 추적)"))
  assert.ok(text.includes("2024년 1월 1일 이후 개시"), "타법 적용례 verbatim 회수")
  assert.ok(text.includes("부칙 적용례 미발견"), "A1: self 부칙 미발견 라벨")
  assert.ok(text.includes("MST 9001") && text.includes("lawService.do?target=law&MST=9001"), "A6: 타법 provenance(MST·URL, OC 무포함)")
  assert.ok(!/MST=9001&OC|OC=OCA1[\s\S]*lawService/.test(text), "출처 URL에 OC 노출 금지")
  assert.ok(text.includes("현행(오늘) 시행본 기준"), "A3: 현행 시행본 해소 caveat")
})

// ══════════════ C2 (Codex 3): 준용 대상 조문 미발견·삭제·부칙무언급 존재게이트 ══════════════
// 변형 A: 타법에 제5조 없음(제6조만) + 부칙은 제5조 언급 → "미발견"
LAWS["8021"] = lawXml({ title: "C2자기법A", articles: ["제10조(계산) 계산은 「C2타법A」 제5조를 준용한다."], addenda: [] })
LAWS["9021"] = lawXml({ title: "C2타법A", articles: ["제6조(다른조문) 내용."], addenda: [{ date: "20240101", no: "1", text: APPLY_TAX_YEAR("제5조", 2024) }] })
EFLAW["C2타법A"] = eflawXml([{ mst: "9021", name: "C2타법A", enf: "20200101", prom: "20200101" }])
// 변형 B: 제5조 삭제 → "삭제됨"
LAWS["8022"] = lawXml({ title: "C2자기법B", articles: ["제10조(계산) 계산은 「C2타법B」 제5조를 준용한다."], addenda: [] })
LAWS["9022"] = lawXml({ title: "C2타법B", articles: ["제5조 삭제 <2019.12.31>"], addenda: [{ date: "20240101", no: "1", text: APPLY_TAX_YEAR("제5조", 2024) }] })
EFLAW["C2타법B"] = eflawXml([{ mst: "9022", name: "C2타법B", enf: "20200101", prom: "20200101" }])
// 변형 C: 제5조 없음 + 부칙 무언급 → "'적용례 없음' 단정 금지"
LAWS["8023"] = lawXml({ title: "C2자기법C", articles: ["제10조(계산) 계산은 「C2타법C」 제5조를 준용한다."], addenda: [] })
LAWS["9023"] = lawXml({ title: "C2타법C", articles: ["제6조(다른조문) 내용."], addenda: [{ date: "20240101", no: "1", text: APPLY_TAX_YEAR("제7조", 2024) }] })
EFLAW["C2타법C"] = eflawXml([{ mst: "9023", name: "C2타법C", enf: "20200101", prom: "20200101" }])

test("C2(A4): 준용 대상 조문 미발견/삭제/부칙무언급을 정상결과로 둔갑 금지", async () => {
  const a = textOf(await traceArticleApplication({ jo: "제10조", mst: "8021", oc: "OCA2A" }))
  assert.ok(a.includes("미발견(조번호 이동·재편 가능)"), "제5조 부재 → 미발견 라벨")
  const b = textOf(await traceArticleApplication({ jo: "제10조", mst: "8022", oc: "OCA2B" }))
  assert.ok(b.includes("삭제됨"), "제5조 삭제 감지")
  const c = textOf(await traceArticleApplication({ jo: "제10조", mst: "8023", oc: "OCA2C" }))
  assert.ok(c.includes("'적용례 없음' 단정 금지"), "미발견 + 부칙무언급 → 단정 금지 라벨")
})

// ══════════════ C3 (Codex 5): self/준용 층 부칙 유형 분리(A5) ══════════════
LAWS["8005"] = lawXml({
  title: "C3자기법",
  articles: ["제10조(계산) 계산은 「C3타법」 제5조를 준용한다."],
  addenda: [{ date: "20230101", no: "5", text: TRANSITIONAL("제10조") }], // self 층: 경과조치
})
LAWS["9005"] = lawXml({
  title: "C3타법",
  articles: ["제5조(계산방법) 내용."],
  addenda: [{ date: "20240101", no: "1", text: APPLY_FILING("제5조") }], // 준용 층: 신고시점기준
})
EFLAW["C3타법"] = eflawXml([{ mst: "9005", name: "C3타법", enf: "20200101", prom: "20200101" }])

test("C3(A5): 타법(준용 층) 유형이 self 조문 '충돌'로 오표시되지 않음", async () => {
  const text = textOf(await traceArticleApplication({ jo: "제10조", mst: "8005", oc: "OCA3" }))
  assert.ok(!/같은 조문에 \[경과조치\(종전규정\)\]와/.test(text), "self 층 단일 유형이면 충돌 경고 비발동")
  assert.ok(text.includes("준용 대상 층 부칙 유형"), "준용 층은 별도 표기")
})

// ══════════════ C4 (Codex 8): lawService 제명 사후검증 강등(A8) ══════════════
LAWS["8006"] = lawXml({ title: "C4자기법", articles: ["제10조(계산) 계산은 「C4타법」 제5조를 준용한다."], addenda: [] })
LAWS["9006"] = lawXml({ title: "전혀다른법", articles: ["제5조(계산방법) 내용."], addenda: [{ date: "20240101", no: "1", text: APPLY_TAX_YEAR("제5조", 2024) }] })
EFLAW["C4타법"] = eflawXml([{ mst: "9006", name: "C4타법", enf: "20200101", prom: "20200101" }]) // eflaw 행 제명은 정확

test("C4(A8): eflaw 정확하나 lawService XML 제명 불일치 → 안전 강등(승격 금지)", async () => {
  const text = textOf(await traceArticleApplication({ jo: "제10조", mst: "8006", oc: "OCA4" }))
  assert.ok(text.includes("제명 검증 실패"), "제명 사후검증 강등 라벨")
  assert.ok(!text.includes("개정 인벤토리 「C4타법」"), "검증 실패면 준용 대상 데이터 승격 금지")
})

// ══════════════ C5 (Codex 7): 타법 해소 memo·상한 2(TK/A6 memo) ══════════════
LAWS["8007"] = lawXml({
  title: "C5자기법",
  articles: ["제10조(계산) 계산은 「C5법1」 제5조를 준용하고, 「C5법1」 제6조를 준용하며, 「C5법2」 제5조를 준용하고, 「C5법3」 제5조를 준용한다."],
  addenda: [{ date: "20200101", no: "5", text: APPLY_TAX_YEAR("제10조", 2020) }],
})
LAWS["9101"] = lawXml({ title: "C5법1", articles: ["제5조(계산) 내용.", "제6조(계산2) 내용."], addenda: [{ date: "20240101", no: "1", text: APPLY_TAX_YEAR("제5조", 2024) }] })
LAWS["9102"] = lawXml({ title: "C5법2", articles: ["제5조(계산) 내용."], addenda: [{ date: "20240101", no: "1", text: APPLY_TAX_YEAR("제5조", 2024) }] })
EFLAW["C5법1"] = eflawXml([{ mst: "9101", name: "C5법1", enf: "20200101", prom: "20200101" }])
EFLAW["C5법2"] = eflawXml([{ mst: "9102", name: "C5법2", enf: "20200101", prom: "20200101" }])
// C5법3 픽스처 없음 — 상한(2) 초과로 해소 자체가 차단됨

test("C5(memo·cap): 동일 타법 2회 참조는 lawService 1회(memo) + 3번째 타법은 상한(2) 초과", async () => {
  fetchLog.length = 0
  const text = textOf(await traceArticleApplication({ jo: "제10조", mst: "8007", oc: "OCA5" }))
  const c5law1Fetches = fetchLog.filter((u) => u.includes("lawService.do") && u.includes("MST=9101&")).length
  assert.equal(c5law1Fetches, 1, "C5법1(2회 참조) lawService fetch는 memo로 1회")
  assert.ok(text.includes("상한(2) 초과"), "3번째 타법은 자동 해소 상한 초과 라벨")
})

// ══════════════ C6 (Codex 4): timetable full=false 생략분에 준용 층 포함 라벨(A2) ══════════════
const c6Addenda = Array.from({ length: 13 }, (_, i) => ({ date: `201${i < 3 ? 3 + i : 3}${String(i + 1).padStart(2, "0")}01`, no: `${2000 + i}`, text: APPLY_TAX_YEAR("제10조", 2013 + i) }))
LAWS["8008"] = lawXml({
  title: "C6자기법",
  articles: ["제10조(계산) 계산방법은 「D타법」 제5조를 준용한다."],
  addenda: c6Addenda,
})
LAWS["9008"] = lawXml({ title: "D타법", articles: ["제5조(계산) 내용."], addenda: [{ date: "20240101", no: "1", text: APPLY_TAX_YEAR("제5조", 2024) }] })
EFLAW["D타법"] = eflawXml([{ mst: "9008", name: "D타법", enf: "20200101", prom: "20200101" }])

test("C6(A2): timetable full=false 생략분에 준용 대상 층 포함 시 명시 라벨", async () => {
  const text = textOf(await buildApplicationTimetable({ articles: ["제10조"], targetYears: [2025], mst: "8008", oc: "OCA6" }))
  assert.ok(text.includes("생략분에 준용 대상 층 1건 포함"), "준용 층 생략 명시 라벨")
})

// ── C7(v0.26.0 리뷰 완결성): get_law_article도 비인접 「타법」 lawHint를 명시(종전 침묵 갭) ──
LAWS["8009"] = lawXml({
  title: "C7자기법",
  articles: ["제10조(양도소득 계산) 「소득세법」에 따른 양도소득과세표준의 계산에 관하여는 제5조를 준용한다."],
})
test("C7(EF-3 완결성): get_law_article이 lawHint 귀속 모호를 ⚠ 라벨로 렌더", async () => {
  const text = textOf(await getLawArticle({ jo: "제10조", mst: "8009", oc: "OCG1" }))
  assert.ok(text.includes("준용 귀속 주의"), "lawHint ⚠ 라벨 렌더(수정 전엔 자기법으로 침묵)")
  assert.ok(text.includes("「소득세법」"), "귀속 모호 법령명 표기")
})
