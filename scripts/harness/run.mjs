// 검증 하네스 러너 — 상류 안전장치(lib.mjs) 위에서 축별 검증기를 돌리고 '이상징후만' 보고한다.
//
// 사용:
//   node scripts/harness/run.mjs                 # 전체(상류 다운이면 자동 스킵)
//   node scripts/harness/run.mjs data invariant  # 특정 축만
//   node scripts/harness/run.mjs --budget 120    # 상류 호출 예산 조정
//
// 축:
//   data       로컬 데이터 무결성 (네트워크 0)
//   upjong     업종코드↔KSIC↔조특 §6③/§7①1호 (로컬 + 조문 대조)
//   invariant  불변식 (연도 단조성·파라미터 등가성·멱등성·full 단조성)
//   timing     적용시점 (부칙 유형태깅·결박·판단 일관성)
//   junyong    준용 체인 (미탐·유령참조·타법 완주)
//   hierarchy  규범 계층 (위임 미탐·오탐·시행규칙 회수)
//   degraded   부분 장애 거동 (상류 다운 시 정확히 실패하는가)
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { createHarness, isOk, UPSTREAM } from "./lib.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = resolve(HERE, "../../src/data")

const F = []
const seen = new Set()
const flag = (axis, code, scen, detail) => {
  const k = `${code}|${scen}`; if (seen.has(k)) return
  seen.add(k); F.push({ axis, code, scen, detail })
}

// ────────────────────────── data (네트워크 0) ──────────────────────────
function axisData() {
  const up = JSON.parse(readFileSync(DATA + "/upjong-ksic.json", "utf8"))
  const cr = JSON.parse(readFileSync(DATA + "/credit-eligibility.json", "utf8"))
  const rs = JSON.parse(readFileSync(DATA + "/statute-restructures.json", "utf8"))

  if (up.count !== up.records.length) flag("data", "COUNT", "upjong", `count=${up.count} vs ${up.records.length}`)
  if (cr.provisional !== true) flag("data", "PROVISIONAL_DROPPED", "credit", "provisional 플래그 소실 — 미검증 고지 근거 없어짐")

  // 업종+KSIC+표기까지 같은 '순수 중복'은 데이터 오류(1:N은 KSIC가 달라야 정상)
  const seenKey = new Set(), pure = []
  for (const r of up.records) {
    const k = JSON.stringify([r.upjong, r.ksic?.code, r.ksic?.l5Name, r.up?.l5Name, r.note])
    if (seenKey.has(k)) pure.push(r.upjong)
    seenKey.add(k)
  }
  if (pure.length) flag("data", "PURE_DUP", "upjong", `순수 중복 ${pure.length}건: ${pure.slice(0, 5).join(",")}`)

  // 적격/호목 정합
  const MOK = "가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도로모보소오조초코토포호구누두루무부수우주추쿠투푸후"
  let elNoHo = 0, hoNoEl = 0, badHo = 0, badMok = 0
  for (const v of Object.values(cr.records)) {
    for (const [key, c] of Object.entries(v)) {
      if (!c) continue
      const ho = c.ho || []
      if (c.eligible === true && ho.length === 0) elNoHo++
      if (c.eligible === false && ho.length > 0) hoNoEl++
      for (const h of ho) {
        if (key === "chojunggam" && !/^\d{1,2}$/.test(String(h))) badHo++
        if (key === "jungteukgam" && !MOK.includes(String(h))) badMok++
      }
    }
  }
  if (elNoHo) flag("data", "ELIGIBLE_NO_HO", "credit", `적격인데 호/목 없음 ${elNoHo}건`)
  if (hoNoEl) flag("data", "HO_NO_ELIGIBLE", "credit", `비적격인데 호/목 있음 ${hoNoEl}건`)
  if (badHo) flag("data", "BAD_HO", "credit", `창중감 호 형식 이상 ${badHo}건`)
  if (badMok) flag("data", "BAD_MOK", "credit", `중특감 목이 목 순서에 없음 ${badMok}건`)

  for (const [law, obj] of Object.entries(rs.laws || {})) {
    for (const r of obj.restructures || []) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date || "")) flag("data", "RS_DATE", law, `date 형식: ${r.date}`)
      for (const [from, to] of Object.entries(r.mappings || {})) {
        if (from === to) flag("data", "RS_IDENTITY", law, `${from} → 자기 자신`)
      }
    }
  }
  console.log(`  data: 업종 ${up.records.length} / 연계표 ${Object.keys(cr.records).length} 검사`)
}

// ────────────────────────── upjong ──────────────────────────
async function axisUpjong(h) {
  const up = JSON.parse(readFileSync(DATA + "/upjong-ksic.json", "utf8"))
  const cr = JSON.parse(readFileSync(DATA + "/credit-eligibility.json", "utf8"))
  const codes = up.records.map((r) => r.upjong)
  const samples = [...new Set(["101000", "143107", "630702", "511115", "292901", ...codes.filter((_, i) => i % 29 === 0).slice(0, 60)])]

  for (const code of samples) {
    const recs = up.records.filter((r) => r.upjong === code)
    if (!recs.length) continue
    const r = await h.call("call_taxlaw_extra", { name: "lookup_upjong_code", args: { code } })
    if (r.skipped || !isOk(r)) continue
    const uniq = new Set(recs.map((x) => x.ksic?.code).filter(Boolean))
    // 1:N이면 전건이 노출돼야 한다(v0.27.5)
    for (const k of uniq) if (!r.text.includes(k)) flag("upjong", "KSIC_MISSING", `업종 ${code}`, `KSIC ${k} 미노출(고유 ${uniq.size}건)`)
    if (uniq.size > 1 && !/KSIC \d+건에 대응/.test(r.text)) flag("upjong", "NO_1N_NOTICE", `업종 ${code}`, `고유 KSIC ${uniq.size}건인데 1:N 고지 없음`)
    if (uniq.size === 1 && /KSIC \d+건에 대응/.test(r.text)) flag("upjong", "FALSE_1N", `업종 ${code}`, "1:1인데 1:N 고지")

    const c = cr.records[code]
    if (!c) continue
    const out = await h.call("classify_credit_eligibility", { code })
    if (out.skipped || !isOk(out)) continue
    const line = (re) => out.text.match(re)?.[0] || ""
    const pos = (l) => /✅/.test(l) && !/✗/.test(l)
    if (c.chojunggam && pos(line(/창중감\(조특법[^\n]*/)) !== !!c.chojunggam.eligible) flag("upjong", "CREDIT_DIVERGE", `업종 ${code} 창중감`, "DB와 출력 불일치")
    if (c.jungteukgam && pos(line(/중특감\(조특법[^\n]*/)) !== !!c.jungteukgam.eligible) flag("upjong", "CREDIT_DIVERGE", `업종 ${code} 중특감`, "DB와 출력 불일치")
    if (!/provisional|미검증/.test(out.text)) flag("upjong", "NO_PROVISIONAL", `업종 ${code}`, "provisional 경고 없음")
  }
  console.log(`  upjong: ${samples.length} 표본`)
}

// ────────────────────────── invariant ──────────────────────────
async function axisInvariant(h) {
  // 연도 스윕 단조성
  for (const [law, jo, years] of [["조세특례제한법", "제30조의4", [2021, 2022, 2023, 2024, 2025]], ["법인세법", "제25조", [2022, 2023, 2024, 2025]]]) {
    const rows = []
    for (const y of years) {
      const r = await h.call("get_law_article", { lawName: law, jo, year: y })
      if (r.skipped || !isOk(r) || /요청 시점 텍스트 아님/.test(r.text)) continue
      const m = r.text.match(/시행일 (\d{4})\.(\d{1,2})\.(\d{1,2})/)
      if (m) rows.push({ y, ef: `${m[1]}${m[2].padStart(2, "0")}${m[3].padStart(2, "0")}` })
    }
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].ef < rows[i - 1].ef) flag("invariant", "NONMONOTONIC", `${law} ${jo}`, `${rows[i-1].y}→${rows[i].y} 인데 시행일 후퇴`)
      if (rows[i].ef > `${rows[i].y}1231`) flag("invariant", "FUTURE_PICK", `${law} ${jo}`, `year=${rows[i].y}에 시행일 ${rows[i].ef}`)
    }
  }
  // 파라미터 등가성 year ≡ efYd
  for (const [law, jo, y] of [["법인세법", "제25조", 2023], ["조세특례제한법", "제30조의4", 2023]]) {
    const a = await h.call("get_law_article", { lawName: law, jo, year: y })
    const b = await h.call("get_law_article", { lawName: law, jo, efYd: `${y}1231` })
    if (!isOk(a) || !isOk(b)) continue
    const mst = (t) => t.match(/MST (\d+)/)?.[1]
    if (mst(a.text) !== mst(b.text)) flag("invariant", "YEAR_EFYD_DIFF", `${law} ${jo} ${y}`, `${mst(a.text)} vs ${mst(b.text)}`)
  }
  // 멱등성
  for (const [tool, args, scen] of [["get_law_article", { lawName: "법인세법", jo: "제25조" }, "조문"], ["classify_credit_eligibility", { code: "101000" }, "감면판정"]]) {
    const a = await h.call(tool, args), b = await h.call(tool, args)
    if (!isOk(a) || !isOk(b)) continue
    if (a.text !== b.text) flag("invariant", "NONDETERMINISTIC", scen, `2회 결과 상이 (${a.text.length} vs ${b.text.length})`)
  }
  // full 단조성
  for (const [tool, args, scen] of [["get_law_article", { lawName: "조세특례제한법", jo: "제29조의8" }, "조문 full"], ["get_law_addenda", { lawName: "법인세법" }, "부칙 full"]]) {
    const s = await h.call(tool, { ...args, full: false }), f = await h.call(tool, { ...args, full: true })
    if (!isOk(s) || !isOk(f)) continue
    if (s.text.length > f.text.length * 1.05) flag("invariant", "FULL_SMALLER", scen, `full=false(${s.text.length}) > full=true(${f.text.length})`)
  }
  console.log("  invariant: 단조성·등가성·멱등성·full 단조성")
}

// ────────────────────────── timing ──────────────────────────
async function axisTiming(h) {
  // 유형 판정은 '줄 단위 + 우선순위'여야 한다. 문서 전체에서 문언만 보면 오탐이 난다:
  //   "2025.1.1 이후 개시하는 과세연도를 최초 공제연도로 하여 … 신청하는 경우부터 적용"
  //   → '이후 개시하는 과세연도'가 있지만 실제 anchor는 최초공제연도이고, 도구가 그렇게 태깅하는 게 맞다.
  // 구체적인 것부터 먼저 매칭(최초공제연도 > 신고시점 > 과세연도개시).
  const RULES = [
    [/최초\s*공제연도/, "최초공제연도기준"],
    [/신고하는 경우부터|과세표준[^\n]{0,12}신고하는/, "신고시점기준"],
    [/이후 개시하는 과세연도/, "과세연도개시기준"],
  ]
  for (const [law, jo, years] of [["조세특례제한법", "제29조의8", [2024, 2025, 2026]], ["조세특례제한법", "제6조", [2024, 2025]], ["조세특례제한법 시행령", "제26조의8", [2025, 2026]]]) {
    const tr = await h.call("trace_article_application", { lawName: law, jo, targetYear: years[0] })
    const tt = await h.call("build_application_timetable", { lawName: law, articles: [jo], targetYears: years })
    if (!isOk(tr) || !isOk(tt)) continue
    for (const line of tr.text.split("\n")) {
      if (!/^·\s*\[/.test(line.trim())) continue          // 적용례 항목 줄만
      if (/\[경과조치/.test(line)) continue                // 경과조치는 별도 유형
      const expected = RULES.find(([re]) => re.test(line))?.[1]
      if (expected && !line.includes(`[${expected}]`)) {
        flag("timing", "TAG_MISMATCH", `${law} ${jo}`, `기대 [${expected}] / 실제 ${line.match(/\[[^\]]+\]/)?.[0] ?? "없음"} — ${line.slice(0, 80)}`)
      }
    }
    for (const y of years) if (!new RegExp(`▶ ${y} 귀속`).test(tt.text)) flag("timing", "YEAR_NOTE_MISSING", `${law} ${jo}`, `${y} 판단노트 없음`)
    if (!/적용시점 판정 규칙|해석 공리/.test(tr.text + tt.text)) flag("timing", "AXIOM_MISSING", `${law} ${jo}`, "공리 블록 미부착")
    // 부등호·결론 정합
    for (const m of tt.text.matchAll(/기준: (\d{4}) 이후 개시 과세연도\. targetYear (\d{4}) (<|≥) → (종전규정|개정규정 적용)/g)) {
      const base = +m[1], ty = +m[2]
      if (m[3] !== (ty >= base ? "≥" : "<")) flag("timing", "REL_WRONG", `${law} ${jo}`, `base=${base} target=${ty} 부등호 '${m[3]}'`)
      if (m[4] !== (ty >= base ? "개정규정 적용" : "종전규정")) flag("timing", "VERDICT_WRONG", `${law} ${jo}`, `base=${base} target=${ty} → ${m[4]}`)
    }
    // 판단노트 누락 — targetYear를 줬으면 적용례 줄마다 판단이 붙어야 한다.
    //   v0.27.8 이전엔 [유형미상]일 때 노트가 통째로 사라져 '적용례 없음'으로 오독됐다.
    const clauseLines = tr.text.split("\n").filter((l) => /^·\s*\[/.test(l.trim()) && !/\[결박검증/.test(l))
    const noteLines = tr.text.split("\n").filter((l) => new RegExp(`└▶ ${years[0]} 귀속 판단`).test(l))
    if (clauseLines.length > 0 && noteLines.length < clauseLines.length) {
      flag("timing", "NOTE_MISSING", `${law} ${jo}`, `적용례 ${clauseLines.length}줄인데 판단노트 ${noteLines.length}줄 — ${clauseLines.length - noteLines.length}건 무언 누락`)
    }
    // 미분류 비율 — 분류기가 새면 판단 품질이 조용히 떨어진다.
    const unk = clauseLines.filter((l) => /\[유형미상\]/.test(l)).length
    if (clauseLines.length >= 10 && unk / clauseLines.length > 0.15) {
      flag("timing", "UNCLASSIFIED_HIGH", `${law} ${jo}`, `유형미상 ${unk}/${clauseLines.length} (${((unk / clauseLines.length) * 100).toFixed(0)}%)`)
    }
    if (unk > 0 && !/\[유형미상\] 라벨이 붙은 적용례 있음/.test(tr.text)) {
      flag("timing", "UNK_HEADER_MISSING", `${law} ${jo}`, "유형미상 존재하나 헤더 고지 없음")
    }
    // 층별 결박 자기모순
    const byLayer = new Map()
    for (const l of tt.text.split("\n").filter((x) => /결박:/.test(x))) {
      const no = l.match(/제(\d+)호/)?.[1]; if (!no) continue
      const k = `${no}|${/준용대상/.test(l) ? "cross" : "self"}`
      const v = /결박:✓/.test(l) ? "Y" : "N"
      if (byLayer.has(k) && byLayer.get(k) !== v) flag("timing", "BINDING_CONTRADICT", `${law} ${jo}`, `${k} 층에 ✓와 ⚠ 동시`)
      byLayer.set(k, v)
    }
  }
  console.log("  timing: 유형태깅·판단노트·부등호·결박")
}

// ────────────────────────── junyong / hierarchy ──────────────────────────
async function axisJunyong(h) {
  for (const [law, jo] of [["조세특례제한법 시행령", "제26조의8"], ["조세특례제한법 시행령", "제100조의16"], ["조세특례제한법 시행규칙", "제14조의2"], ["법인세법 시행령", "제19조"]]) {
    const r = await h.call("get_law_article", { lawName: law, jo, full: true })
    if (!isOk(r)) continue
    const flat = (r.text.split("── 본문 ──")[1] || "").replace(/\s/g, "")
    if (/준용/.test(flat) && !/준용 감지/.test(r.text)) flag("junyong", "MISS", `${law} ${jo}`, "본문에 '준용' 있으나 감지 없음")
    if (/준용 감지/.test(r.text)) {
      const seg = r.text.split("준용 감지")[1]?.slice(0, 400) || ""
      for (const m of [...new Set([...seg.matchAll(/제(\d+조(?:의\d+)?)/g)].map((x) => "제" + x[1]))].slice(0, 4)) {
        if (!flat.includes(m)) flag("junyong", "PHANTOM", `${law} ${jo}`, `감지 대상 ${m}가 본문에 없음`)
      }
    }
    const cross = r.text.match(/「([^」]{2,30})」\s*제(\d+조(?:의\d+)?)/)
    if (cross && /준용/.test(r.text)) {
      const sub = await h.call("get_law_article", { lawName: cross[1], jo: "제" + cross[2] })
      if (!sub.skipped && /^\[NOT_FOUND/.test(sub.text)) flag("junyong", "CHAIN_BROKEN", `${law} ${jo}`, `타법 ${cross[1]} ${cross[2]} 회수 실패`)
    }
  }
  console.log("  junyong: 미탐·유령참조·타법 완주")
}

async function axisHierarchy(h) {
  for (const [law, jo] of [["조세특례제한법 시행령", "제2조"], ["조세특례제한법 시행령", "제26조의8"], ["법인세법 시행령", "제42조"], ["조세특례제한법", "제30조의4"], ["법인세법", "제25조"]]) {
    const r = await h.call("get_law_article", { lawName: law, jo, full: true })
    if (!isOk(r)) continue
    const body = r.text.split("── 본문 ──")[1] || ""
    const toRule = /(총리령|[가-힣]{2,12}부령)(으로|에서|에|이)\s*정/.test(body)
    const toGosi = /(정하여\s*고시|고시로\s*정|(장관|청장|위원장)이\s*(정|고시))/.test(body)
    const guard = /하위 위임 감지/.test(r.text)
    if ((toRule || toGosi) && !guard) flag("hierarchy", "DELEG_MISS", `${law} ${jo}`, `위임문언(부령=${toRule}/고시=${toGosi}) 있으나 가드 없음`)
    if (guard && !toRule && !toGosi) flag("hierarchy", "DELEG_FALSE", `${law} ${jo}`, "가드 있으나 본문에 위임문언 없음")
  }
  console.log("  hierarchy: 위임 미탐·오탐")
}

// ────────────────────────── degraded ──────────────────────────
async function axisDegraded(h) {
  // 상류가 죽어 있을 때만 의미 있는 축 — 살아 있으면 스킵
  if (h.health[UPSTREAM.NTS]) { console.log("  degraded: NTS 정상이라 건너뜀"); return }
  for (const [tool, args] of [["search_taxlaw_documents", { query: "세액공제", docType: "interpretations", display: 3 }], ["verify_nts_citations", { text: "조심-2025-중-2511" }]]) {
    const r = await h.call(tool, args)
    if (r.skipped) continue     // preflight가 이미 막았으면 정상
    const guard = /추측하거나 생성하지|추측·생성 금지|데이터 없음|인용 게이트를 통과시키지 마라|실존 미검증|판정 불가|상류 장애/.test(r.text)
    if (!guard) flag("degraded", "NO_GUARD", tool, "실패인데 추측금지 가드 없음")
    if (/검색 결과: 0건|결과가 없습니다/.test(r.text) && !/EXTERNAL|fetch failed|Timeout|CIRCUIT/.test(r.text)) {
      flag("degraded", "FAILURE_AS_EMPTY", tool, "상류 장애를 '결과 없음'으로 표기")
    }
  }
  console.log("  degraded: 장애 시 실패 선언 정확성")
}

// ────────────────────────── main ──────────────────────────
const AXES = { data: axisData, upjong: axisUpjong, invariant: axisInvariant, timing: axisTiming, junyong: axisJunyong, hierarchy: axisHierarchy, degraded: axisDegraded }

const argv = process.argv.slice(2)
const budgetIdx = argv.indexOf("--budget")
const budget = budgetIdx >= 0 ? Number(argv[budgetIdx + 1]) : undefined
const want = argv.filter((a) => AXES[a])
const run = want.length ? want : Object.keys(AXES)

console.log("── 사전 점검 ──")
const needsUpstream = run.some((name) => name !== "data")
const h = await createHarness({ ...(budget ? { budget } : {}), preflight: needsUpstream })
console.log(`\n── 검증 (${run.join(", ")}) ──`)
const t0 = Date.now()
for (const name of run) {
  try { await AXES[name](h) }
  catch (e) { flag(name, "HARNESS_ERROR", name, e.message) }
}
const st = h.stats()
if (st.nonJsonStdout.length) flag("proto", "STDOUT_POLLUTION", "전역", st.nonJsonStdout.join(" | "))

console.log(`\n════ 이상징후 ${F.length}건 / ${((Date.now() - t0) / 1000).toFixed(0)}s ════`)
for (const f of F) console.log(`  [${f.axis}·${f.code}] ${f.scen} — ${f.detail}`)
if (!F.length) console.log("  (없음)")
console.log(`\n상류 호출 ${st.used} / 스킵 ${st.skipped}${Object.keys(st.tripped).length ? ` / 서킷오픈 ${Object.keys(st.tripped).join(",")}` : ""}`)
h.close()
process.exit(F.length ? 1 : 0)
