# Changelog

## [0.8.0] - 2026-05-19

### Added
- **기본통칙 인용 자동 검증 (환각·누락 방지 강제 절차)**
  - 신규 모듈 export `extractBasicRulingRefs(text)` / `formatBasicRulingRef(ref)` (`src/citation-extract.ts`) — 본문에 인용된 기본통칙 번호를 옛 형식("N-N", 예: 27-12)과 현행 형식("N-N…M", 예: 27-55…10)으로 구분 추출. 통칙 번호 체계는 과거 짧은 "N-N" 형식이었다가 현행은 "N-N…M" 형식으로 재편되어, 옛 질의회신·해석례 본문에 인용된 옛 번호를 그대로 옮기면 환각이 됨.
  - `get_taxlaw_document_text` 응답에 통칙 인용 자동 검출 섹션 추가. 옛 번호 형식 발견 시 ⚠ 경고와 함께 `list_taxlaw_basic_ruling_laws` + `get_taxlaw_basic_ruling_text` 호출을 강제. 단건 호출이 아닌 주제 키워드 호출로 인접 번호대를 일괄 수집하도록 안내해 관련 통칙 군집 누락 방지.
  - INSTRUCTIONS 5단 응답 가이드에 `[기본통칙 인용 검증 — 환각·누락 방지 강제 절차]` 4단계 추가. 옛 번호("N-N")는 답변 노출 금지, 현행 번호 미확인 시 ⚠ 표기 강제.

### Tested
- `test/citation-extract.test.js` 7건 추가 (옛/현행 형식 구분, HORIZONTAL ELLIPSIS·3-dot 표기, 혼합 본문, 통칙 키워드 없는 조-호 표기 오인 차단, format 라벨링).

### Motivation
- 사용자 환경에서 2006년 「서면인터넷방문상담1팀-626」 질의회신 본문의 "소득세법 기본통칙 27-12" 인용을 검증 없이 옮긴 환각 사례 발생. 현행 정확한 통칙 번호는 「27-55…10」이며 인접 통칙 27-55…11(임차건물 보험료) / 27-55…12(보험사고 시 적립보험료 처리)도 함께 누락. 통칙 도구가 가용함에도 자동 호출 트리거가 없어 발생한 구조적 문제를 instructions + 응답 자동 검출 양쪽으로 차단.

## [0.7.1] - 2026-05-19

### Fixed
라이브 NTS API 검증에서 발견된 회귀 2건:
- **citation 추출 — "법률/대통령령 제N호" 노이즈**: 본문에 "법률 제4666호로 전부 개정된 것" / "대통령령 제15976호로 전문개정된 것" 같은 표기가 흔한데, 기존 `ITEM_PATTERN`이 이 법령번호도 호(item)로 잘못 매칭. 헌재 위헌결정 본문의 `조세특례제한법 시행령 제138조 제15976호` 같은 거짓 인용 다수 발생.
  - 수정: ITEM_PATTERN에 negative lookbehind 추가 (`(?<!(?:법률|대통령령|총리령|부령|...)\s)제\s?(\d+)\s?호`).
  - 추가 보호: 호(item)는 조(article) 또는 항(paragraph) 없이 단독으로 존재하지 않음 — 단독 "제N호"는 매치 무효.
- **헌재·심판례 본문 supersession 미감지**: 본문이 길고 줄 단위 chunk 분리 한계로 `(구)법령`/`폐지된 「법령」`이 별도 줄에 있을 때 amendment_clue/supersession_clue가 격상되지 않던 문제. 라이브 검증에서 헌재 2009헌바35,82(위헌결정) → 잘못된 `unverified`, 토지초과이득세 부동산-1190 → 잘못된 `likely_outdated` (실제: 모두 `superseded_or_repealed` 분류 대상).
  - 수정: `checkYearApplicability`가 본문 전체에 대해 supersession grep을 별도 수행 (`전부\s*개정|폐지된|폐지\s*\)|\(\s*구\s*\)\s*[가-힣]+법`). citation chunk별 분리 한계와 무관하게 격상.
  - citations.length=0이거나 latestDate 추출 실패해도 본문 supersession 단서 있으면 `repealed_or_superseded`로 격상.

### Tested
- 라이브 NTS API에 STDIO MCP 호출(`scripts/smoke-test.mjs`)로 5건 검증:
  - 헌재 2009-헌바-35,82 (위헌) → `repealed_or_superseded` ✓
  - 서면1팀-1219 (외국인근로자 2007) → `before_target` → `likely_outdated` ✓
  - 부동산-1190 (토지초과이득세 2010) → `repealed_or_superseded` ✓
  - 서면-2025-4517 (사내복지기금 2026) → `uncertain` → `unverified` ✓ (정직한 처리)
  - 법인1264.21-61 (1985) → `uncertain` → `unverified` ✓
- 단위 테스트 75 → **79** (회귀 4건 추가): 본문 전체 grep 격상, citation 노이즈 제거.

## [0.7.0] - 2026-05-19

### Added
- 신규 도구 **`assess_doctrine_validity`** — 세법해석례·심판례·판례 단일 문서의 **현행 유효성 자동 채점**. 호출 한 번에:
  - 본문/메타데이터에서 인용 법조문 시점 파싱
  - targetYear 대비 사문화 위험 신호 점수화 (vintage, citation_vintage, amendment_clue, supersession_clue, no_target, no_citations, missing_metadata)
  - 최종 판정 6단계: `valid_current` / `needs_current_check` / `partially_outdated` / `likely_outdated` / `superseded_or_repealed` / `unverified`
  - 권장 후속 호출 큐 (`korean-law-mcp.search_law/get_law_text/search_decisions` + 본 MCP의 후일자 해석례 검색) 반환
  - LLM은 next-action 큐를 순서대로 실행해서 답변의 채점표에 결과를 채움
- 신규 모듈 `src/citation-extract.ts` — 인용 법령명·조·항·호 구조화 추출 (조특법/조특/소득세 등 약칭→정식 명칭 매핑, 시행령/시행규칙 구분).
- 신규 모듈 `src/doctrine-assess.ts` — 사문화 평가 오케스트레이터. 채점표(matrix) + 신호(signals) + next-action queue 생성.

### Changed
- `src/year-check.ts` 강화:
  - **헤더 패턴 9종 → 14종**으로 확장: "관련 조세법령(법률, 시행령, 시행규칙, 기본통칙)", "관련 세법", "근거 법령", "참고 법령", "인용 법령", 그리고 헌재/판례 양식의 `[심판대상조문]` / `[참조조문]` / `[심판의 대상]` 등 대괄호 헤더.
  - **메타데이터 fallback 추가**: 본문에서 헤더를 못 찾으면 문서 기본정보의 `관련법령:` 필드(`dcmRltnStttList`)를 인용 텍스트로 fallback. 자동검증 적용 범위가 크게 확장.
  - **classification 5단 → 8단**: `valid_current`(인용 시점 ≥ target + 개정 단서 없음), `partially_outdated`(before_target + amendment clue), `repealed_or_superseded`(폐지·전부개정 단서 감지), `target_or_later`(인용 시점 ≥ target + amendment clue), `before_target`, `no_citations`, `no_target`, `uncertain`.
  - 개정 단서 패턴 확장: "(구) 법령명", "구 [법령]", "폐지된 「법령」", "전부 개정" (띄어쓰기 변형 포함) 등 헌재/심판례 본문 양식 매치.
- `get_taxlaw_document_text`가 year-check 호출 시 메타데이터 fallback도 함께 전달.

### Tested
- 단위 테스트 **57 → 75개** (year-check 신규 7건, citation-extract 6건, doctrine-assess 6건 추가).
- **자체 회귀 검증 20건** (`fixtures/self-review/*.json` + `scripts/self-review.mjs`): 어제 인용된 외국인근로자 4건, 다양 vintage 라이브 4건, 헌재 위헌결정 1건, 헌재 합헌 1건, 1980s 법인세 2건, 2026 심판례 2건, 부가세 영세율 판례 2건, 합성 boundary 케이스 4건. **expected 일치율 20/20 (100%)**.
- 검증된 식별 정확도:
  - 헌재 위헌결정 (2009헌바35,82) → `superseded_or_repealed` 자동 분류 (본문 "전부 개정" + 구법명 단서로 식별)
  - 폐지된 토지초과이득세법 인용 (부동산-1190, 2010) → `superseded_or_repealed`
  - 외국인근로자 단일세율 인용례 4건 (2006~2010, 2026 target) → 모두 `likely_outdated`
  - 최신 NTS 해석례 (2026) → `unverified` (시점 단서 없음 + 메타 fallback 우회) — 정직한 표기

### Migration / Compatibility
- 기존 도구(`get_taxlaw_document_text` 등)의 시그니처와 출력 호환. 추가 정보(분류 라벨, fallback 표기)만 늘어남.
- `YearCheckResult` 인터페이스에 `usedMetadataFallback`, `classificationLabel` 필드 추가.

## [0.6.0] - 2026-05-18

### Added
- `Server` 생성자에 `instructions` 옵션 주입. MCP `InitializeResult.instructions`로 전달되어 클라이언트(Claude Code 등)가 system-reminder 형태로 LLM에 자동 노출. 5단 응답 포맷(결론 → 매트릭스 → 법령 래퍼 → AI 보충 → 인용/피드백 prompt)을 LLM이 항상 따르도록 강제.
- 응답 포맷 핵심 규칙:
  - **출처 격리** — 법률/시행령/통칙/해석례 4단을 섹션별 분리, AI 보충은 별도 ⚠ 단락
  - **연도 검증 의무** — 해석례 인용 시 `get_taxlaw_document_text(targetYear=YYYY)` 호출 명시
  - **중복 처리** — korean-law-mcp와 양쪽에서 회수된 동일 사건은 문서번호/일자/제목으로 합치고 양쪽 출처 ID 병기

### Changed
- 버전 0.6.0.
- 기존 `COMPANION_NOTICE`(각 도구 description에 박힌 동반호출 안내)는 그대로 유지. 도구 호출 시점의 즉시 신호로 유효하며 instructions와 상호 보완.

## [0.5.2] - 2026-05-14

### Fixed
- CI: `Run unit tests` 단계가 `node --test test/utils.test.js`만 돌려 0.5.x 신규 테스트 23 케이스(upjong/year-check)를 검증하지 않던 문제 → `npm test`로 변경.
- `classifyIndustryForArticle` reasoning 메시지에 잔존하던 "16호 산업명이…" 하드코딩 표현 → 호 중립적 문구로 일반화.

### Docs
- README-EN을 0.5.x 도구셋으로 갱신: 업종코드↔KSIC 매핑 7개 도구, `targetYear` 옵션, Codex/Claude Code 설치 절차, 업데이트 절차.

## [0.5.1] - 2026-05-14

### Changed
- `src/data/upjong-ksic.json`(귀속연도 2024, 1,784 레코드)을 저장소에 포함. 사용자가 추가 CSV 다운로드·환경변수 설정 없이 `git clone + npm install + npm run build`만으로 모든 업종코드 도구 즉시 동작.
- `.gitignore`에서 `src/data/upjong-ksic.json` 제외 처리 해제.
- README의 설치 안내 단순화 — CSV 다운로드는 선택적(최신화 시에만).

## [0.5.0] - 2026-05-14

### Added

- `lookup_ksic_prefix` 신규 도구 — KSIC 코드 prefix(영문 1자리 대분류 / 2~5자리 숫자) 매칭. `lookup_ksic_code`(5자리 정확)와 별개. 부동산 임대업 6811, 통신판매업 4791, 청소업 7421 등 prefix 패턴이 조특법 §6/§7 작업에서 빈번히 필요했음.
- `search_industry_by_keyword`에 `levels` 인자 추가 — 검색 분류수준 한정 가능. 호별 제외 단서 차감 시 l3~l5로 좁히면 상위 레벨 분류명에 잘못 휘말리는 것 방지.
- `resolve_industry_class`에 `levels` 인자 추가 — 동일 목적.
- `classify_industry_for_article`에 `excludeLevels` 인자 추가 — 제외 단서 검색 분류수준 한정. 7호 음식점업에서 '주점' 차감 시 l2 '음식점 및 주점업'에 휘말리는 버그를 클라이언트 부담 없이 차단.
- 테스트 6 케이스 추가 (총 57). KSIC prefix 매칭, levels 한정 동작 검증.

### Changed

- 버전 0.5.0.
- 모든 도구 description에 조특법 §6/§7 실제 사용 사례 인용 (LLM 사용 가이드).

## [0.4.0] - 2026-05-14

### Added

- `get_taxlaw_document_text`에 `targetYear` 파라미터. 본문 '관련규정/관련법령' 섹션을 자동 파싱해 인용 법조문의 법률번호·일자·개정 단서를 추출하고, 사용자가 적용하려는 연도와 비교한다. 구법조문 기반이면 `before_target` 분류 + 경고 동봉. 모든 결과는 `korean-law-mcp`로 직접 대조 후 보고하도록 안내.
- 업종코드↔KSIC 매핑 DB 내장: `src/data/upjong-ksic.json` (귀속연도 2024, 1,784 레코드). 빌드 시 `scripts/build-upjong-db.mjs`가 국세청 연계표 CSV를 JSON으로 변환.
- 신규 도구 6개:
  - `lookup_upjong_code` — 6자리 업종코드 → 5단계 분류 + KSIC 매핑.
  - `lookup_ksic_code` — KSIC → 매핑된 업종코드 목록.
  - `search_industry_by_keyword` — 정규화 키워드 검색.
  - `resolve_industry_class` — 분류명 → 어느 분류수준(대/중/소/세/세세)에 해당하는지 후보 반환.
  - `classify_industry_for_article` — 법조문 산업명·제외 단서·업종코드 → match/excluded/out_of_scope/ambiguous 판정. 분류수준 자동 식별로 LLM의 잘못된 매핑(예: 749942를 조특법시행령 27-3 16호에 잘못 포함)을 방지.
  - `upjong_db_info` — 내장 DB 신선도(생성시각·원본·귀속연도·레코드 수).
- 테스트: `test/upjong.test.js` (11 케이스, 749942 / 852000 사례 포함), `test/year-check.test.js` (6 케이스).

### Changed

- 모든 주요 도구 description에 `korean-law-mcp` 동반 호출 의무 명시(`COMPANION_NOTICE`).
- `docs/tools.md` 문서에 동반 호출 의무·연도 검증 절차·업종코드 도구 사용 예 추가.
- 버전 0.4.0.

## [0.3.6] - 2026-05-10

### Changed

- Publication enrichment concurrency raised from 4 to 8 — preserves per-host politeness while roughly halving the wall-clock time of `search_taxlaw_publications` with `display=20+`. READMEs updated accordingly.

## [0.3.5] - 2026-05-10

### Added

- Unit tests (`test/utils.test.js`) for pure helpers: `truncate`, `decodeHtml`, `htmlToText`, `cleanText`, `normalizeDate`, `normalizeDetailId`, `normalizeTaxlawPath`, `documentDateValue`, `documentDedupKey`, `isEmptyPayload` — 35 cases via Node's built-in `node:test`.
- GitHub Actions CI (`.github/workflows/ci.yml`): build + tsc check + tests + `npm pack --dry-run` on Ubuntu/Windows/macOS × Node 20.19.x/22.x.
- `pretest` / `test` scripts in `package.json` so `npm test` builds first then runs the suite.
- Terms-of-use & legal-notice section in both READMEs covering NTS compliance, identification, rate-limit etiquette, and disclaimer.
- Internal `mapWithConcurrency` helper for bounded parallel fetches.

### Changed

- Default User-Agent switched from a Chrome-spoof string to `taxlaw-nts-mcp/<version> (+repo URL)` so requests identify themselves transparently to NTS. `TAXLAW_USER_AGENT` still overrides if NTS blocks the default.
- `enrichPublicationItem` parallelism capped at 4 concurrent requests (was unbounded — could fire 50 simultaneous fetches when `display=50`) to reduce risk of NTS rate-limiting / blocking.
- `fetchWithRetry` per-attempt timeout reduced from 30s to 15s, cutting the worst-case hang for unresponsive NTS endpoints by half.
- Pure utility functions (`truncate`, `decodeHtml`, `htmlToText`, `cleanText`, `normalizeDate`, `normalizeDetailId`, `normalizeTaxlawPath`, `documentDateValue`, `documentDedupKey`, `isEmptyPayload`, `TaxlawMcpError`, `ErrorCodes`) are now ESM-exported so external test/tooling can import them.
- `main()` invocation gated behind `TAXLAW_MCP_TEST_MODE !== "1"` so importing the built module from tests no longer launches the stdio server.

## [0.3.4] - 2026-05-10

### Added

- `prepare` script in `package.json` so `npm install` from a git checkout (or `npm install <git-url>`) auto-builds the CLI binary.
- Build step now sets the executable bit on `build/index.js` (no-op on Windows) so the `taxlaw-nts-mcp` shebang works on macOS/Linux without manual `chmod`.
- Repository / bugs / homepage / author metadata in `package.json` for npm registry and GitHub linkage.

### Changed

- `postTaxlawAction` now caches the NTS session cookie for 5 minutes and refreshes once on 401/403/JSON-parse failures, eliminating a redundant session GET on every call.
- `searchTaxlawDocuments` switched to `Promise.allSettled` for the question/precedent groups so that a transient failure in one group no longer drops results from the other; partial failures are surfaced as a warning line.
- `LICENSE` copyright holder updated to match repository owner.

## [0.3.3] - 2026-05-10

### Added

- Tool descriptions and NotFound suggestions on `search_taxlaw_all` / `search_taxlaw_documents` now explicitly direct callers to `korean-law-mcp` when its DB is the stronger source (statute body via `get_law_text`; precedents/interpretations/tax-tribunal cases via `search_decisions`). Verified end-to-end for VAT Enforcement Decree §42 — both MCPs are needed because each system has indexing gaps.

## [0.3.2] - 2026-05-10

### Added

- `call_taxlaw_action` and `get_taxlaw_page_text` now emit explicit "do not infer beyond payload" guard lines and convert empty payloads / near-empty page bodies into `[NOT_FOUND]` responses with retry suggestions.
- `list_taxlaw_site_menus` output now ends with a usage note pointing high-level / actionId / static-page consumers to the appropriate tool and reminding LLMs not to invent unseen content.
- NotFound suggestions on `search_taxlaw_all` and `search_taxlaw_documents` now name the menus that are reachable only via `call_taxlaw_action` (법제처 해석례 / 감사원 심사청구 / 납세자보호위원회 심의사례 / 평가심의사례).

### Changed

- `get_taxlaw_document_text` now re-throws external API / parse errors when multiple referer attempts fail, instead of masking them as `[NOT_FOUND]`.
- `formatIntegratedRow` flags rows that have no title, labels, document numbers, or summary so LLMs do not hallucinate body content from a bare ID.

## [0.3.1] - 2026-05-10

### Added

- Added NTS public sitemap fallback entries for tax calendar and tax-law suggestion guidance.
- Added document-search match snippets so results matched only in source body text show why they were returned.

### Changed

- Documented companion usage with `korean-law-mcp`, including cross-source duplicate consolidation rules.

## [0.3.0] - 2026-05-10

### Added

- Added `list_taxlaw_site_menus`, `call_taxlaw_action`, and `get_taxlaw_page_text` so MCP clients can reach NTS menu-backed data that does not yet have a dedicated high-level tool.
- Added known NTS menu/action mappings for statutes, treaties, notices/directives, interpretation maintenance pages, audit review, major cases, customer-center boards, summary pages, and dictionary lookup.

### Changed

- Expanded `search_taxlaw_forms` to include the NTS "전체 서식", "훈령서식", and "자주찾는서식" menus in addition to existing annex/legal-form searches.

## [0.2.0] - 2026-05-10

### Added

- Project files: README, English README, MIT license, `.env.example`, and packaging metadata.
- NTS search tools for integrated search, tax interpretations/Q&A, dispute documents, basic rulings, annexes/forms, publications, and Hometax counseling examples.

### Changed

- Packaged the server as an npm CLI binary: `taxlaw-nts-mcp`.
- Documented `[NOT_FOUND]`, `[EXTERNAL_API_ERROR]`, and `[INVALID_PARAMETER]` error behavior.
