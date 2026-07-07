import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync, readdirSync } from "node:fs"

// v0.21.1(#8) — test 스크립트 하드코딩 목록 footgun 가드.
// package.json test 스크립트가 나열한 파일과 실제 test/ 디렉터리의 *.test.js가 어긋나면 실패:
//   · 파일 추가 후 목록 미갱신 → 조용한 미실행(커버리지 착시) 방지
//   · 목록에 존재하지 않는 파일 참조 → Node 20 하드에러(CI 깨짐) 사전 검출
// (glob 전환은 Node 20.19/24 × Windows/Unix 교차 비호환이라 명시 목록 유지 + 이 가드로 동기화 강제.)
test("meta: package.json test 스크립트가 test/*.test.js 전체와 일치한다", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  const listed = new Set((String(pkg.scripts.test).match(/test\/[\w.-]+\.test\.js/g) || []).map((p) => p.replace(/^test\//, "")))
  const actual = new Set(readdirSync(new URL("./", import.meta.url)).filter((f) => f.endsWith(".test.js")))
  const missing = [...actual].filter((f) => !listed.has(f)).sort()
  const stale = [...listed].filter((f) => !actual.has(f)).sort()
  assert.deepEqual(missing, [], `test 스크립트에 누락된 파일(추가 후 package.json 미갱신): ${missing.join(", ")}`)
  assert.deepEqual(stale, [], `test 스크립트가 존재하지 않는 파일 참조: ${stale.join(", ")}`)
})
