// 회귀검증(라이브 DRF): v0.9.20 타임테이블·결박검증·준용체인·차수플래그
// 실행: LAW_GO_KR_OC 설정 후  node scripts/verify-timetable.mjs
// 기준 사례: 통합고용세액공제(조특령 §26의8⑥) 2026-06-11 확정 결론
//   - 2024 최초공제=총량 / 2025 최초공제=인별·개인별절사(2.27본) / 2026귀속~=인별·합산후절사(5.22본)
//   - 35999호 경과조치는 ⑥ 무관(⑥ 미개정) / 차수(최초공제연도) 미확인 시 클래리파잉 필수
process.env.TAXLAW_MCP_TEST_MODE = "1"

const { buildApplicationTimetable, traceArticleApplication } = await import("../build/index.js")

if (!process.env.LAW_GO_KR_OC) {
  console.error("LAW_GO_KR_OC 환경변수가 필요합니다.")
  process.exit(2)
}

const checks = []
const check = (label, cond) => {
  checks.push([label, !!cond])
  console.log(`${cond ? "✔" : "✘"} ${label}`)
}
const textOf = (r) => r.content.map((c) => c.text || "").join("\n")

// ── 케이스 1: 통합고용 §26의8⑥ — 타임테이블(차수 미지정) ──
console.log("\n[케이스 1] build_application_timetable §26의8⑥ × 2024·2025·2026 (firstCreditYear 미지정)")
const r1 = await buildApplicationTimetable({
  lawName: "조세특례제한법 시행령",
  articles: ["제26조의8제6항"],
  targetYears: [2024, 2025, 2026],
})
const t1 = textOf(r1)
check("차수 확인 플래그(최초공제연도 검출 → 클래리파잉 지시)", t1.includes("차수 확인 필수"))
check("준용 체인 자동 탐지: 제11조의2제8항", t1.includes("제11조의2제8항"))
check("제36127호 부칙(제11조① 최초공제연도기준) 회수", t1.includes("36127") && t1.includes("최초공제연도기준"))
check("제36342호 부칙(준용대상 §11의2⑧ 적용례) 회수", t1.includes("36342"))
check("제35999호 경과조치 결박검증 ⚠(⑥ 미개정 — 사정거리 의심)", /제35999호[^\n]*결박:⚠없음/.test(t1) || /35999[^\n]*⚠없음/.test(t1))
check("해석 공리(개정규정=문구 단위·경과조치 사정거리) 출력", t1.includes("해석 공리") && t1.includes("선제 유예"))

// ── 케이스 1b: firstCreditYear=2025 지정 → 차수 분기 노트 ──
console.log("\n[케이스 1b] firstCreditYear=2025 지정")
const r2 = await buildApplicationTimetable({
  lawName: "조세특례제한법 시행령",
  articles: ["제26조의8제6항"],
  targetYears: [2025, 2026],
  firstCreditYear: 2025,
  filingMonth: 5,
})
const t2 = textOf(r2)
check("★차수: 2025=1차공제 노트", t2.includes("2025 = 1차공제"))
check("★차수: 2026=추가공제·사후관리 노트", t2.includes("추가공제·사후관리"))

// ── 케이스 2(교차): trace §11의2 자체(특구 경로) — 일반화 확인 ──
console.log("\n[케이스 2] trace_article_application 제11조의2 제8항 targetYear=2026 (특구 등 자체 적용 경로)")
const r3 = await traceArticleApplication({
  lawName: "조세특례제한법 시행령",
  jo: "제11조의2",
  hang: "제8항",
  targetYear: 2026,
})
const t3 = textOf(r3)
check("개정 인벤토리 출력(제8항 꼬리표)", t3.includes("개정 인벤토리"))
check("결박검증 라인 출력", t3.includes("결박검증"))
check("부칙 적용례 타임라인 존재", t3.includes("부칙 적용례 타임라인"))

const fails = checks.filter(([, ok]) => !ok)
console.log(`\n결과: ${checks.length - fails.length}/${checks.length} 통과`)
if (fails.length) {
  console.log("--- 실패 항목 디버그(케이스1 출력 앞 4000자) ---")
  console.log(t1.slice(0, 4000))
  process.exit(1)
}
