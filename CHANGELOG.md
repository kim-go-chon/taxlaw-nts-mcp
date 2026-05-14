# Changelog

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
