// 신구 조문 단어단위 diff — 독자 구현(의존성 0, lexdiff 등 BSL-1.1 라이선스 코드 미참조).
// 전략: 공통 prefix/suffix 절단 → 단어 LCS. 크기 초과 시 줄단위 LCS로 분해 후 구간별 단어 LCS.
// 출력은 변경 hunk(±문맥)만 반환한다 — 전문 재출력 금지(토큰 절약).
// 분류(change_kind)는 결정적 휴리스틱이며 LLM 추정이 아니다. 타임테이블 해석 공리
// ①(신구 문구 나란히 대조)·②(개정규정=실제 바뀐 문구 단위)의 기계화가 목적.

export type ChangeKind = "substantive" | "cosmetic" | "renumbering"

export interface DiffHunk {
  kind: ChangeKind
  // 구버전에만 있는 문구(빈 문자열 = 순수 신설). 작은 공통 구간(≤MERGE_GAP_WORDS)이
  // 변경 사이에 끼면 가독성을 위해 양쪽에 모두 포함된다.
  removed: string
  // 신버전에만 있는 문구(빈 문자열 = 순수 삭제).
  added: string
  contextBefore: string // 직전 공통 문맥(≤CONTEXT_WORDS 단어)
  contextAfter: string
}

export interface ArticleDiffResult {
  identical: boolean
  hunks: DiffHunk[]
  verdict: ChangeKind | "identical"
  // 크기 가드 발동 시 정밀도 안내(null = 전체 단어단위 정밀 diff)
  fallbackNote: string | null
}

type Op = { type: "eq" | "del" | "ins"; words: string[] }

const MAX_DP_CELLS = 16_000_000
const CONTEXT_WORDS = 8
const MERGE_GAP_WORDS = 4

function tokenize(text: string): string[] {
  return String(text || "").split(/\s+/).filter(Boolean)
}

// 표준 LCS DP + 역추적. DP 셀 수 초과 시 null(호출자가 줄단위로 분해).
function lcsOps(a: string[], b: string[]): Op[] | null {
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) return []
  if (n === 0) return [{ type: "ins", words: b.slice() }]
  if (m === 0) return [{ type: "del", words: a.slice() }]
  if ((n + 1) * (m + 1) > MAX_DP_CELLS) return null
  const w = m + 1
  const dp = new Int32Array((n + 1) * w)
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i * w + j] = a[i - 1] === b[j - 1]
        ? dp[(i - 1) * w + (j - 1)] + 1
        : Math.max(dp[(i - 1) * w + j], dp[i * w + (j - 1)])
    }
  }
  const ops: Op[] = []
  const push = (type: Op["type"], word: string) => {
    const last = ops[ops.length - 1]
    if (last && last.type === type) last.words.push(word)
    else ops.push({ type, words: [word] })
  }
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      push("eq", a[i - 1])
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i * w + (j - 1)] >= dp[(i - 1) * w + j])) {
      push("ins", b[j - 1])
      j--
    } else {
      push("del", a[i - 1])
      i--
    }
  }
  ops.reverse()
  ops.forEach((op) => op.words.reverse())
  return ops
}

// 문장부호·공백 차이만이면 자구정비, 번호 참조 패턴만 바뀌면 번호이동, 그 외 실질변경.
const PUNCT_RE = /[\s.,·ㆍ;:!?'"‘’“”「」『』()<>〈〉《》[\]\-–—~‧†*]/g

function normalizePunct(s: string): string {
  return String(s || "").replace(PUNCT_RE, "")
}

function normalizeNumbers(s: string): string {
  return normalizePunct(s)
    .replace(/제\d+(?:조|항|호|목)(?:의\d+)?/g, "#")
    .replace(/[①-⑳㉑-㉟]/g, "#")
    .replace(/\d+/g, "#")
}

export function classifyChange(removed: string, added: string): ChangeKind {
  if (normalizePunct(removed) === normalizePunct(added)) return "cosmetic"
  if (normalizeNumbers(removed) === normalizeNumbers(added)) return "renumbering"
  return "substantive"
}

// ops → 변경 클러스터(짧은 공통 구간은 병합) → hunk 목록.
function buildHunks(ops: Op[]): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let i = 0
  while (i < ops.length) {
    if (ops[i].type === "eq") {
      i++
      continue
    }
    const removed: string[] = []
    const added: string[] = []
    const before = ops[i - 1]?.type === "eq" ? ops[i - 1].words : []
    let j = i
    while (j < ops.length) {
      const op = ops[j]
      if (op.type === "eq") {
        const next = ops[j + 1]
        if (op.words.length <= MERGE_GAP_WORDS && next && next.type !== "eq") {
          removed.push(...op.words)
          added.push(...op.words)
          j++
          continue
        }
        break
      }
      if (op.type === "del") removed.push(...op.words)
      else added.push(...op.words)
      j++
    }
    const after = ops[j]?.type === "eq" ? ops[j].words : []
    const removedText = removed.join(" ")
    const addedText = added.join(" ")
    hunks.push({
      kind: classifyChange(removedText, addedText),
      removed: removedText,
      added: addedText,
      contextBefore: before.slice(-CONTEXT_WORDS).join(" "),
      contextAfter: after.slice(0, CONTEXT_WORDS).join(" "),
    })
    i = j
  }
  return hunks
}

function trimCommon(a: string[], b: string[]): { prefix: string[]; aMid: string[]; bMid: string[]; suffix: string[] } {
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  return { prefix: a.slice(0, p), aMid: a.slice(p, a.length - s), bMid: b.slice(p, b.length - s), suffix: a.slice(a.length - s) }
}

// 단어 LCS가 크기 가드에 걸릴 만큼 긴 조문은 줄단위 LCS로 변경 구역을 좁힌 뒤
// 구역별로 단어 LCS를 적용한다(법령 조문은 항·호 단위 줄바꿈이라 구역화가 잘 됨).
function lineFallbackOps(oldText: string, newText: string): Op[] | null {
  const aLines = String(oldText || "").split(/\n+/).map((l) => l.trim()).filter(Boolean)
  const bLines = String(newText || "").split(/\n+/).map((l) => l.trim()).filter(Boolean)
  const lineOps = lcsOps(aLines, bLines)
  if (!lineOps) return null
  const out: Op[] = []
  for (let i = 0; i < lineOps.length; i++) {
    const op = lineOps[i]
    if (op.type === "eq") {
      out.push({ type: "eq", words: tokenize(op.words.join(" ")) })
      continue
    }
    const delWords: string[] = []
    const insWords: string[] = []
    while (i < lineOps.length && lineOps[i].type !== "eq") {
      const cur = lineOps[i]
      if (cur.type === "del") delWords.push(...tokenize(cur.words.join(" ")))
      else insWords.push(...tokenize(cur.words.join(" ")))
      i++
    }
    i--
    const region = lcsOps(delWords, insWords)
    if (region) out.push(...region)
    else out.push({ type: "del", words: delWords }, { type: "ins", words: insWords })
  }
  return out
}

export function diffArticleTexts(oldText: string, newText: string): ArticleDiffResult {
  const a = tokenize(oldText)
  const b = tokenize(newText)
  const { prefix, aMid, bMid, suffix } = trimCommon(a, b)
  if (aMid.length === 0 && bMid.length === 0) {
    return { identical: true, hunks: [], verdict: "identical", fallbackNote: null }
  }
  let fallbackNote: string | null = null
  let midOps = lcsOps(aMid, bMid)
  if (!midOps) {
    midOps = lineFallbackOps(oldText, newText)
    if (midOps) {
      fallbackNote = "조문이 길어 줄단위 분해 후 구역별 단어 diff를 적용했습니다(hunk 경계가 줄 단위로 거칠 수 있음)."
      // 줄단위 fallback은 원문 전체 기준이므로 prefix/suffix를 다시 붙이지 않는다.
      const hunks = buildHunks(midOps)
      return finalize(hunks, fallbackNote)
    }
    midOps = [
      { type: "del", words: aMid },
      { type: "ins", words: bMid },
    ]
    fallbackNote = "조문이 너무 길어 정밀 diff를 생략하고 변경 구간 전체를 단일 hunk로 표시합니다."
  }
  const ops: Op[] = []
  if (prefix.length) ops.push({ type: "eq", words: prefix })
  ops.push(...midOps)
  if (suffix.length) ops.push({ type: "eq", words: suffix })
  return finalize(buildHunks(ops), fallbackNote)
}

function finalize(hunks: DiffHunk[], fallbackNote: string | null): ArticleDiffResult {
  const verdict: ArticleDiffResult["verdict"] = hunks.some((h) => h.kind === "substantive")
    ? "substantive"
    : hunks.some((h) => h.kind === "renumbering")
      ? "renumbering"
      : hunks.length
        ? "cosmetic"
        : "identical"
  return { identical: hunks.length === 0, hunks, verdict, fallbackNote }
}
