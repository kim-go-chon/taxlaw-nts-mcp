# Tool Reference

## Companion Role

Use this MCP beside `korean-law-mcp`, not as a replacement. `korean-law-mcp` covers MOLEG/law.go.kr statutes, precedents, interpretations, tax tribunal, treaties, and citation verification. This MCP fills NTS Tax Law Information System gaps: tax interpretations/Q&A, basic rulings, NTS forms/annexes, publications, and Hometax counseling examples.

### Source-of-truth split (verified end-to-end)

| Need | Primary tool | Companion fallback |
|---|---|---|
| Statute article text (e.g. VAT Decree §42 body) | `korean-law-mcp` `search_law` → `get_law_text(jo=…)` | NTS `search_taxlaw_all(collections=statute)` only returns metadata / cross-references |
| Tax interpretations / Q&A (서면질의·회신·기준자문·고시서면) | NTS `search_taxlaw_documents(docType=reply\|advance\|tax_standard\|written)` | `korean-law-mcp` lacks a Q&A domain |
| Tax tribunal (조세심판원 결정례) | NTS `search_taxlaw_documents(docType=tribunal)` is dominant — body and recent cases | `korean-law-mcp` `search_decisions(domain=tax_tribunal)` (often weaker on body / latest cases) |
| Court decisions (대법원·고등·지방·행정) | Try both — NTS body search is strong, MOLEG carries some cases NTS lacks | `korean-law-mcp` `search_decisions(domain=precedent)` |
| Constitutional Court | `korean-law-mcp` `search_decisions(domain=constitutional)` | NTS `search_taxlaw_documents(docType=constitutional)` |
| 법제처 해석례 / 감사원 심사청구 / 납세자보호위원회 / 평가심의사례 | NTS `list_taxlaw_site_menus` + `call_taxlaw_action` (actionId in menu list) | not in `search_taxlaw_documents` enum |
| Basic rulings (기본통칙) | NTS `list_taxlaw_basic_ruling_laws` → `get_taxlaw_basic_ruling_text` | n/a |
| NTS forms / publications / Hometax counseling | NTS `search_taxlaw_forms` / `search_taxlaw_publications` / `search_taxlaw_all(collections=hometaxCnslThan)` | n/a |

If both MCPs find the same item, normalize document/request/case numbers by removing spaces and hyphens, then compare dates and titles. Present one consolidated item with both source IDs rather than duplicating it. Prefer NTS output for NTS-only body snippets, Hometax counseling, basic rulings, forms, and publications.

Failure responses are intentional guardrails. If a tool returns `[NOT_FOUND]`, `[EXTERNAL_API_ERROR]`, or `[INVALID_PARAMETER]` with `isError: true`, clients should report the failure and retry guidance instead of generating missing tax-law facts. NotFound suggestions on `search_taxlaw_all` / `search_taxlaw_documents` cite the relevant `korean-law-mcp` companion call so callers do not stop at a one-sided miss.

## `search_taxlaw_all`

Integrated NTS search across annexes/forms, tax statutes, interpretations/Q&A, cases, publications, and Hometax counseling examples.

Key arguments: `query`, `collections`, `displayPerCollection`, `page`, `sort`, `fromDate`, `toDate`, `taxLawCode`, `synonym`.

## `search_taxlaw_documents`

Search tax interpretation and dispute documents.

Key arguments: `query`, `docType`, `display`, `page`, `sort`, `fromDate`, `toDate`, `taxLawCode`.

Common `docType` values: `interpretations`, `disputes`, `advance`, `reply`, `tax_standard`, `written`, `tax_pre_review`, `objection`, `review`, `tribunal`, `precedent`, `constitutional`.

`search_taxlaw_documents` covers NTS document codes 01–10. NTS menus that use other codes — 법제처 해석례 (`ASIBGE004MR03`), 감사원 심사청구 (`ASIPDM001MR01`), 납세자보호위원회 심의사례 (`ASIPRC019MR02`), 평가심의사례 (`ASIBGH004MR01`) — are reachable only via `list_taxlaw_site_menus` + `call_taxlaw_action`. The NotFound response from this tool repeats the actionId hints to keep clients from inventing missing matches.

## `get_taxlaw_document_text`

Retrieve a document detail by `DOC_ID` or `DOCID` from `search_taxlaw_documents` or `search_taxlaw_all`.

Key arguments: `id`, `docType`, `full`.

## `get_taxlaw_hometax_counsel_text`

Retrieve a Hometax counseling-example detail by `REQ_STD_ID` from the `hometaxCnslThan` collection in `search_taxlaw_all`.

Key argument: `id`.

## Full Menu Fallback Tools

- `list_taxlaw_site_menus`: lists known NTS Tax Law Information System menus, source paths, observed `actionId` values, default `paramData`, and preferred high-level tools when available.
- `call_taxlaw_action`: calls `https://taxlaw.nts.go.kr/action.do` with a caller-supplied `actionId`, `paramData`, and same-site `refererPath`; returns raw JSON.
- `get_taxlaw_page_text`: fetches a same-site path and converts HTML/static pages to text. Use this for static resources such as `/html/U_0101.html`.

These tools make menu-backed NTS data reachable even before a dedicated formatter exists. Keep using high-level tools for formatted interpretation, decision, form, publication, and basic-ruling lookups.

`call_taxlaw_action` returns the raw `action.do` payload prefixed with a "do not infer beyond payload" guard. Empty payloads (`{}`, empty arrays, nested empties) are converted to `[NOT_FOUND]` with retry suggestions instead of being passed through.

`get_taxlaw_page_text` similarly converts near-empty page bodies (under 40 trimmed chars, e.g. JS-driven menus rendered server-side as a shell) to `[NOT_FOUND]`, since static HTML conversion would otherwise produce a misleading-looking empty success.

Current menu fallback coverage includes the public NTS sitemap menus, including tax calendar (`ASECMC001MR01`) and tax-law suggestion guidance (`/cm/USECMJ001M.do`). User-specific local-storage pages such as bookmarks/recent history are intentionally not treated as authoritative tax-law sources.

## Compatibility Aliases

- `search_taxlaw_interpretations`
- `get_taxlaw_interpretation_text`

These map to the document search/detail tools for existing client compatibility.

## Basic Rulings

- `list_taxlaw_basic_ruling_laws`
- `get_taxlaw_basic_ruling_text`

Use `list_taxlaw_basic_ruling_laws` first, then pass its `lawId` to `get_taxlaw_basic_ruling_text`.

## Forms And Publications

- `search_taxlaw_forms`
- `search_taxlaw_publications`
- `list_taxlaw_publication_categories`

`search_taxlaw_forms` supports `kind=all`, `all_forms`, `annex`, `form`/`legal_form`, `instruction_form`, and `favorite_form`.

Use `list_taxlaw_publication_categories` to find `categoryCode` values for publication searches.
Publication search results are hydrated from the NTS publication detail endpoint when possible, so displayed rows include `fleId`/`fleSn` download hints if NTS exposes them.
