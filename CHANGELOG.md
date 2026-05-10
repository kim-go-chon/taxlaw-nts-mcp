# Changelog

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
