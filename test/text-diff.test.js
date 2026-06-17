import { test } from "node:test"
import { strict as assert } from "node:assert"

const { diffArticleTexts, classifyChange } = await import("../build/text-diff.js")

test("identical texts → identical verdict, no hunks", () => {
  const r = diffArticleTexts("① 상시근로자 수는 다음과 같다.", "① 상시근로자 수는 다음과 같다.")
  assert.equal(r.identical, true)
  assert.equal(r.verdict, "identical")
  assert.equal(r.hunks.length, 0)
})

test("substantive word change is detected with markers", () => {
  const oldText = "① 해당 과세연도의 상시근로자 수는 매월 말일 현재의 인원을 합하여 계산한다."
  const newText = "① 해당 과세연도의 상시근로자 수는 매월 말일 현재의 인원을 합한 후 소수점 이하를 버려 계산한다."
  const r = diffArticleTexts(oldText, newText)
  assert.equal(r.identical, false)
  assert.equal(r.verdict, "substantive")
  assert.ok(r.hunks.length >= 1)
  const joined = r.hunks.map((h) => h.added).join(" ")
  assert.ok(joined.includes("버려") || joined.includes("소수점"))
})

test("punctuation-only change → cosmetic", () => {
  const r = diffArticleTexts(
    "사업자가 제1호·제2호에 해당하는 경우",
    "사업자가 제1호ㆍ제2호에 해당하는 경우",
  )
  assert.equal(r.verdict, "cosmetic")
})

test("numbering-only change → renumbering", () => {
  const r = diffArticleTexts(
    "제3항에 따라 계산한 금액",
    "제4항에 따라 계산한 금액",
  )
  assert.equal(r.verdict, "renumbering")
})

test("pure insertion of new clause → substantive", () => {
  const r = diffArticleTexts(
    "① 본문이다.",
    "① 본문이다. ② 신설된 항이다.",
  )
  assert.equal(r.verdict, "substantive")
  assert.ok(r.hunks.some((h) => h.removed === "" && h.added.includes("신설된")))
})

test("context words are attached around changes", () => {
  const oldText = "가 나 다 라 마 바 사 아 자 차 카 타 파 하"
  const newText = "가 나 다 라 마 바 사 아 자 차 카 타 파 거"
  const r = diffArticleTexts(oldText, newText)
  assert.equal(r.hunks.length, 1)
  assert.ok(r.hunks[0].contextBefore.endsWith("파"))
  assert.equal(r.hunks[0].removed, "하")
  assert.equal(r.hunks[0].added, "거")
})

test("nearby changes merge into one hunk across small common gaps", () => {
  const r = diffArticleTexts(
    "100분의 50에 상당하는 금액을 더한 금액",
    "100분의 30에 상당하는 수를 더한 금액",
  )
  assert.equal(r.hunks.length, 1)
  assert.ok(r.hunks[0].removed.includes("50"))
  assert.ok(r.hunks[0].added.includes("30"))
})

test("classifyChange basics", () => {
  assert.equal(classifyChange("제2조", "제3조"), "renumbering")
  assert.equal(classifyChange("금액(원)", "금액 원"), "cosmetic")
  assert.equal(classifyChange("합한", "버린"), "substantive")
})

test("unit-attached number change is substantive, not renumbering", () => {
  // 세율·금액·기간 변경은 실질개정 — '번호이동'으로 강등되면 안 된다.
  assert.equal(classifyChange("100분의 10", "100분의 20"), "substantive")
  assert.equal(classifyChange("1천만원", "2천만원"), "substantive")
  assert.equal(classifyChange("5년", "7년"), "substantive")
  // 순수 조문 참조 변경은 여전히 번호이동
  assert.equal(classifyChange("제1호", "제2호"), "renumbering")
  const r = diffArticleTexts("세액의 100분의 10에 상당하는 금액", "세액의 100분의 20에 상당하는 금액")
  assert.equal(r.verdict, "substantive")
})

test("long text triggers line-level fallback and still finds the change", () => {
  // 단어 1만 개(>DP 가드) / 줄 2천 개(<DP 가드) → 줄단위 분해 경로.
  // 첫·끝 줄도 바꿔 prefix/suffix 절단으로 가드를 우회하지 못하게 한다.
  const mkLines = (firstWord, midWord, lastWord) => {
    const lines = Array.from({ length: 2000 }, (_, i) => `줄${i} 공통 문구 내용 유지`)
    lines[0] = `${firstWord} 공통 문구 내용 유지`
    lines[1000] = `줄1000 공통 문구 ${midWord} 유지`
    lines[1999] = `줄1999 공통 문구 내용 ${lastWord}`
    return lines.join("\n")
  }
  const r = diffArticleTexts(mkLines("구첫", "구중간", "구끝"), mkLines("신첫", "신중간", "신끝"))
  assert.equal(r.identical, false)
  assert.ok(r.fallbackNote, "fallbackNote should be set")
  assert.ok(r.hunks.some((h) => h.removed.includes("구중간") && h.added.includes("신중간")))
})
