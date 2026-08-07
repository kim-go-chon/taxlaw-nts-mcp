import { test } from "node:test"
import { strict as assert } from "node:assert"

process.env.TAXLAW_MCP_TEST_MODE = "1"

const {
  findByUpjong,
  findAllByUpjong,
  loadUpjongDb,
  findByKsic,
  findByKsicPrefix,
  resolveClassName,
  classifyIndustryForArticle,
  searchUpjongByKeyword,
  normalizeName,
  dbInfo,
} = await import("../build/upjong.js")

test("dbInfo: year=2024, record count > 1000", () => {
  const info = dbInfo()
  assert.equal(info.year, 2024)
  assert.ok(info.count > 1000, `expected >1000 records, got ${info.count}`)
})

test("normalizeName: strips spaces, punctuation, collapses commas", () => {
  assert.equal(
    normalizeName("기타 전문, 과학 및 기술 서비스업"),
    normalizeName("기타전문 과학및기술서비스업"),
  )
})

test("findByUpjong: 749942 → 중분류 74 전문 서비스업", () => {
  const r = findByUpjong("749942")
  assert.ok(r)
  assert.equal(r.up.l2Code, "74")
  assert.equal(r.up.l2Name, "전문 서비스업")
})

test("findByUpjong: 852000 → 중분류 85 / 소분류 852 수의업", () => {
  const r = findByUpjong("852000")
  assert.ok(r)
  assert.equal(r.up.l2Code, "85")
  assert.equal(r.up.l3Code, "852")
  assert.equal(r.up.l3Name, "수의업")
})

test("resolveClassName: '기타 전문, 과학 및 기술 서비스업' → 중분류 후보 KSIC 73 + 업종 85 둘 다 존재", () => {
  const out = resolveClassName("기타 전문, 과학 및 기술 서비스업")
  assert.ok(out.candidates.length > 0)
  const ksicL2 = out.candidates.find((c) => c.level === "l2" && c.side === "ksic" && c.code === "73")
  const upL2 = out.candidates.find((c) => c.level === "l2" && c.side === "up" && c.code === "85")
  assert.ok(ksicL2, "expected KSIC 중분류 73 candidate")
  assert.ok(upL2, "expected 업종 중분류 85 candidate")
})

test("resolveClassName: '수의업' → 소분류 852 후보 포함", () => {
  const out = resolveClassName("수의업")
  const l3 = out.candidates.find((c) => c.level === "l3" && c.code === "852")
  assert.ok(l3, "expected 소분류 852 수의업 candidate")
})

test("classify: 749942 vs '기타 전문, 과학 및 기술 서비스업' → out_of_scope (중분류 74 ≠ 85)", () => {
  const result = classifyIndustryForArticle({
    industryName: "기타 전문, 과학 및 기술 서비스업",
    upjongCode: "749942",
    excludeNames: ["수의업"],
  })
  assert.equal(result.verdict, "out_of_scope", `reasoning: ${result.reasoning.join(" / ")}`)
})

test("classify: 852000 vs '기타 전문, 과학 및 기술 서비스업' + 제외 수의업 → excluded", () => {
  const result = classifyIndustryForArticle({
    industryName: "기타 전문, 과학 및 기술 서비스업",
    upjongCode: "852000",
    excludeNames: ["수의업"],
  })
  assert.equal(result.verdict, "excluded", `reasoning: ${result.reasoning.join(" / ")}`)
})

test("searchUpjongByKeyword: '수의업' returns at least one row", () => {
  const rows = searchUpjongByKeyword("수의업")
  assert.ok(rows.length >= 1)
})

test("findByKsic: 71600 returns 749942 mapping", () => {
  const rows = findByKsic("71600")
  assert.ok(rows.some((r) => r.upjong === "749942"))
})

test("findByKsicPrefix: B(letter) matches all 광업 records (대분류)", () => {
  const rows = findByKsicPrefix("B")
  assert.ok(rows.length > 10)
  assert.ok(rows.every((m) => m.matchedLevel === "l1Letter"))
})

test("findByKsicPrefix: 6811 (부동산임대업 세분류) — 부동산 임대업 코드만", () => {
  const rows = findByKsicPrefix("6811")
  assert.ok(rows.length > 0)
  for (const m of rows) {
    assert.ok(String(m.record.ksic.code || "").startsWith("6811"))
    assert.equal(m.matchedLevel, "l4")
  }
})

test("findByKsicPrefix: 4791 (통신판매업 세분류)", () => {
  const rows = findByKsicPrefix("4791")
  assert.ok(rows.length >= 1)
  assert.ok(rows.some((m) => /통신/.test(m.record.ksic.l5Name || "")))
})

test("searchUpjongByKeyword: levels=[l3,l4,l5]로 한정 시 상위 매칭 차단", () => {
  // '주점업'은 l2='음식점 및 주점업'에 포함되지만 l3에서는 '주점업'만 매칭
  const all = searchUpjongByKeyword("주점", 200, ["l1", "l2", "l3", "l4", "l5"])
  const narrow = searchUpjongByKeyword("주점", 200, ["l3", "l4", "l5"])
  assert.ok(all.length > narrow.length, `all=${all.length} narrow=${narrow.length}`)
})

test("resolveClassName: levels 한정 동작", () => {
  const all = resolveClassName("음식점업")
  const l3only = resolveClassName("음식점업", ["l3"])
  // l3에서 매칭되는 후보만 — 더 적거나 같은 수
  assert.ok(l3only.candidates.length <= all.candidates.length)
  // l3 후보가 하나는 있어야 함
  assert.ok(l3only.candidates.some((c) => c.level === "l3"))
})

test("classifyIndustryForArticle: excludeLevels로 상위 레벨 차감 방지", () => {
  // 7호 음식점업 사례: 552101 한식 일반 음식점은 l3='음식점업' 매칭.
  // '주점' 제외 단서를 l1~l5 전체에 적용하면 l2='음식점 및 주점업'에 휘말림.
  // l3~l5로만 한정하면 정상 'match'가 되어야 함.
  const r1 = classifyIndustryForArticle({
    industryName: "음식점업",
    upjongCode: "552101",
    excludeNames: ["주점"],
  })
  const r2 = classifyIndustryForArticle({
    industryName: "음식점업",
    upjongCode: "552101",
    excludeNames: ["주점"],
    excludeLevels: ["l3", "l4", "l5"],
  })
  // r2는 r1보다 같거나 적게 제외되어야 함
  assert.ok(r2.excludedBy.length <= r1.excludedBy.length)
})

// ── v0.27.5(라이브 루프) 업종코드:KSIC 1:N 전건 노출 ────────────────────
// 실측: 연계표에 1:N 매핑이 79종. findByUpjong은 .find()로 첫 건만 돌려주고
// 렌더러도 그것만 표시해 나머지 매핑의 존재조차 알리지 않았다.
test("findAllByUpjong(v0.27.5): 1:N 업종코드의 모든 KSIC를 반환", () => {
  const all = findAllByUpjong("143107")
  assert.ok(all.length >= 2, `1:N인데 ${all.length}건만 반환`)
  const ksics = all.map((r) => r.ksic?.code).filter(Boolean)
  for (const want of ["7110", "7121", "7122", "7210", "7290"]) {
    assert.ok(ksics.includes(want), `KSIC ${want} 누락: ${JSON.stringify(ksics)}`)
  }
})

test("findAllByUpjong(v0.27.5): 1:1 코드는 1건, findByUpjong과 정합(회귀)", () => {
  const all = findAllByUpjong("101000")
  assert.equal(all.length, 1)
  assert.equal(all[0].upjong, findByUpjong("101000").upjong)
})

test("findAllByUpjong(v0.27.5): 없는 코드·잘못된 형식은 빈 배열", () => {
  assert.deepEqual(findAllByUpjong("999999"), [])
  assert.deepEqual(findAllByUpjong("abc"), [])
  assert.deepEqual(findAllByUpjong(""), [])
})

test("v0.27.5: 표기 흔들림 중복행이 1:N 카운트를 부풀리지 않는다", () => {
  // 630702(지입)는 3행이지만 고유 KSIC는 2건이다.
  //   49301 "일반 화물 자동차 운송업" / 49301 "일반 화물자동차 운송업"(띄어쓰기 차이) / 49302
  // 렌더러가 레코드 수로 세면 "KSIC 3건 대응"으로 부풀려지므로 고유 코드 수로 판정해야 한다.
  const recs = findAllByUpjong("630702")
  assert.equal(recs.length, 3, `전제: 630702는 3행 (실제 ${recs.length})`)
  const uniq = new Set(recs.map((r) => r.ksic?.code).filter(Boolean))
  assert.equal(uniq.size, 2, `고유 KSIC는 2건이어야 함: ${[...uniq].join(",")}`)
})

test("연계표 무결성: 업종+KSIC+표기까지 완전히 같은 순수 중복은 0건", () => {
  const seen = new Set(), dup = []
  for (const r of loadUpjongDb().records) {
    const k = JSON.stringify([r.upjong, r.ksic?.code, r.ksic?.l5Name, r.up?.l5Name, r.note])
    if (seen.has(k)) dup.push(r.upjong)
    seen.add(k)
  }
  assert.equal(dup.length, 0, `순수 중복 레코드: ${dup.slice(0, 5).join(", ")}`)
})
