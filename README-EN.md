# taxlaw-nts-mcp

STDIO MCP server for Korea's NTS Tax Law Information System (`https://taxlaw.nts.go.kr`).

[![MCP 1.27](https://img.shields.io/badge/MCP-1.27-blue)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

This project complements `korean-law-mcp`. Use `korean-law-mcp` for MOLEG/law.go.kr data, and use this server for NTS materials that are hard to reach through MOLEG APIs: tax interpretations, Q&A, objection/review/tribunal/court decisions, basic rulings, annexes/forms, publications, and Hometax counseling examples.

For NTS menus that do not yet have a dedicated high-level tool, the server also exposes a known menu/action map, a raw `action.do` caller, and same-site HTML-to-text retrieval.

[한국어](./README.md)

## What it's for

Tax analysis rarely ends at the statute. The actual basis is often an NTS interpretation, Q&A reply, basic ruling, tax-tribunal decision, or Hometax counseling case — material that MOLEG's law.go.kr rarely surfaces but the NTS Tax Law Information System holds. This server retrieves that material down to the body text, and handles the parts of tax research that tend to go wrong.

- **NTS-only sources** — Find tax interpretations, Q&A, basic rulings, tribunal decisions, Hometax counseling cases, and publications by number or keyword, and pull the full body.
- **Citation existence check** — Before a ruling/decision number goes into your answer, it is checked against the live DB (`verify_nts_citations`); non-existent numbers are dropped or flagged "not found in public DB", so you don't cite a precedent that doesn't exist.
- **Point-in-time check** — Give a tax year and it reviews against the provision in force that year (`build_application_timetable`), and judges whether a cited interpretation is superseded or repealed (`assess_doctrine_validity`). Old vs. new article text can be diffed side by side (`diff_article_versions`).
- **Formula-bearing articles kept intact** — For articles with tables/formulas (e.g. the employment-increase and integrated-employment tax credits in the Restriction of Special Taxation Act), where generic law APIs tend to drop the formula, this pulls the source including the formula.
- **Industry-code eligibility** — For start-up SME and small-business special tax reductions, it checks whether an industry code qualifies against KSIC and returns match / excluded / out-of-scope / ambiguous (`classify_industry_for_article`).
- **Structured replies** — Answers come back as conclusion → case matrix → cited law (separated by source, with source links) → unverified notes (⚠), ready to drop into an opinion memo.

Use MOLEG's `korean-law-mcp` for statute and case originals, and this server for NTS interpretations, basic rulings, and tribunal decisions. No API key or fee is required; final judgement still requires the original sources and a licensed professional.

## Using With korean-law-mcp

For Korean tax questions, use `korean-law-mcp` first for statutes, enforcement decrees, precedents, and tax tribunal materials from MOLEG/law.go.kr, then use this server to fill NTS-specific gaps such as tax interpretations, basic rulings, Hometax counseling examples, forms, and publications.

When both MCPs return the same precedent, decision, or interpretation, consolidate it by normalizing document/request/case numbers with spaces and hyphens removed, then comparing dates and titles. Do not list the same item twice; keep both source IDs and use this server to supplement NTS-only body snippets, Hometax counseling, basic rulings, and publications.

This server only displays items returned by the NTS Tax Law Information System. Empty results or external failures return markers such as `[NOT_FOUND]`, `[EXTERNAL_API_ERROR]`, and `[INVALID_PARAMETER]` plus a no-fabrication warning.

## Tools

Tools split into those exposed directly in `tools/list` and low-frequency tools called through the `call_taxlaw_extra(name, args)` gateway (to cut fixed session tokens). Set `TAXLAW_EXPOSE_ALL=1` to expose all of them directly.

### Search & document retrieval
| Tool | Purpose |
| --- | --- |
| `search_taxlaw_all` | Integrated search across annexes/forms, tax statutes, interpretations/Q&A, cases, publications, and Hometax counseling |
| `search_taxlaw_documents` | Search interpretations/Q&A (01–04) and pre-assessment/objection/review/tribunal/court/constitutional documents (05–10); `taxLawCode` recommended |
| `get_taxlaw_document_text` | Document detail body. **`targetYear`** verifies cited statute dates; **`full`** includes the ruling/holding of cases and decisions |
| `research_taxlaw_topic` | Chain macro — search → attach the top-K bodies (`full`·`targetYear`) in one call |
| `assess_doctrine_validity` | Auto-score the **current validity** of a single interpretation/tribunal/court decision (6-level verdict + recommended next-action queue) |
| `verify_nts_citations` | Extract ruling/decision/case numbers from your draft and **check they exist** in the public DB (citation gate); `claims` also checks citation-to-proposition fit |
| `list_taxlaw_basic_ruling_laws` | List basic ruling laws (to obtain `lawId`) |
| `get_taxlaw_basic_ruling_text` | Retrieve basic ruling text |
| `search_taxlaw_forms` | Search forms/annexes (legal, directive, and favorite forms) |

### Point-in-time & application timing (MOLEG DRF supplement)
Addenda, point-in-time versions, and article diffs — which the NTS system does not expose — are supplemented from MOLEG's law.go.kr Open API. Start here for any tax-year-scoped question.

| Tool | Purpose |
| --- | --- |
| `build_application_timetable` | First entry point for tax-year questions — amendment inventory + addenda application-clause tagging + tax-year × article matrix in one call |
| `trace_article_application` | Trace a single article's per-year application based on its addenda application clauses |
| `get_law_article` | Article body at a point in time (year/effective date/MST) + **formula image URL**; past versions auto-compared against the current one |
| `diff_article_versions` | Word-level diff of the same article across two effective versions (changed hunks only) |
| `get_law_addenda` | Retrieve addenda (effective dates, application clauses, transitional provisions) |
| `get_law_revision_text` | Retrieve the amendment text (the actual "change X to Y" directives) of a given amending act |

### Tax-reduction industry eligibility
| Tool | Purpose |
| --- | --- |
| `classify_credit_eligibility` | Industry code → eligibility for start-up SME reduction (RSTA §6③) and small-business special reduction (§7①); re-check proviso industries against the statute/decree/rule text |

### Low-frequency tools via `call_taxlaw_extra`
Call as `call_taxlaw_extra({ name, args })`.

- **Industry-code ↔ KSIC** — `lookup_upjong_code` · `lookup_ksic_code` · `lookup_ksic_prefix` · `search_industry_by_keyword` · `resolve_industry_class` · `classify_industry_for_article` · `upjong_db_info`
- **Publications / Hometax / site menus** — `get_taxlaw_hometax_counsel_text` · `search_taxlaw_publications` · `list_taxlaw_publication_categories` · `list_taxlaw_site_menus` · `get_taxlaw_page_text` · `call_taxlaw_action`
- **Backward-compatible aliases** — `search_taxlaw_interpretations`(=`search_taxlaw_documents`) · `get_taxlaw_interpretation_text`(=`get_taxlaw_document_text`)

#### Industry-code ↔ KSIC mapping DB
The official NTS "Industry code ↔ Standard Industrial Classification (KSIC) mapping" is bundled as JSON (~1.5MB, 1,784 records, FY 2024). Tools auto-identify which classification level (l1 대분류 / l2 중분류 / l3 소분류 / l4 세분류 / l5 세세분류) a statute clause refers to, preventing the common LLM mistake of "matching on top-level name only".

Example — RSTA Decree §27③ item 16 (749942 vs 852000):
```js
call_taxlaw_extra({
  name: "classify_industry_for_article",
  args: {
    industryName: "기타 전문, 과학 및 기술 서비스업",   // "Other professional, scientific, and technical services"
    upjongCode:   "749942",                                // NTS l2 = 74 "Professional services"
    excludeNames: ["수의업"]                                // veterinary services
  }
})
// → verdict: out_of_scope (749942 is NTS l2=74, while item 16 refers to KSIC l2=73)
```

## Full Menu Access

`list_taxlaw_site_menus`, `call_taxlaw_action`, and `get_taxlaw_page_text` here are low-frequency tools, so call them through `call_taxlaw_extra` by default (or set `TAXLAW_EXPOSE_ALL=1` for direct calls). Use `list_taxlaw_site_menus` first to find the menu key, URL, observed `actionId`, and default `paramData`. Prefer a high-level tool when one is listed. For remaining menu-backed data, pass the observed `actionId`, `defaultParamData`, and `refererPath` to `call_taxlaw_action`. Static HTML resources, such as tax-summary pages under `/html/U_0101.html` and tax-law suggestion guidance at `/cm/USECMJ001M.do`, can be read with `get_taxlaw_page_text`. Tax calendar data is available through the `ASECMC001MR01` action listed by `list_taxlaw_site_menus(query="세무일정")`.

## Quick Start

```bash
git clone https://github.com/kim-go-chon/taxlaw-nts-mcp.git
cd taxlaw-nts-mcp
npm install
npm run build      # tsc + bundle DB copy
npm test           # 57 unit tests (optional)
npm start          # MCP STDIO server
```

After install, **all tools work immediately — no extra downloads or environment variables required**. The industry-code ↔ KSIC mapping DB is bundled (`src/data/upjong-ksic.json`).

### Refresh the mapping DB (optional)
Only needed when the NTS releases an updated CSV. Point `UPJONG_CSV` at your downloaded file:

```bash
# Linux/macOS
UPJONG_CSV=/path/to/your-mapping.csv npm run build:data

# Windows PowerShell
$env:UPJONG_CSV = "C:\path\to\your-mapping.csv"
npm run build:data

# Then on either OS
npm run build
```

## Install — per MCP client

### Claude Desktop / Claude Code (native STDIO)
Add to `claude_desktop_config.json` (Claude Desktop) or project-local `.mcp.json` (Claude Code):

```json
{
  "mcpServers": {
    "taxlaw-nts": {
      "command": "node",
      "args": ["/absolute/path/to/taxlaw-nts-mcp/build/index.js"]
    }
  }
}
```

### Claude.ai web (browser)
**This MCP cannot be used directly on claude.ai web.** claude.ai's [Custom Connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) feature only accepts **remote MCP servers exposed over the public internet (HTTPS)**, but this server is STDIO-only.

**Recommended — Claude Desktop**: the `claude_desktop_config.json` setup from the "Claude Code" section above works as-is. Claude Desktop (macOS/Windows app) supports local STDIO MCP servers natively, with no deployment needed. If you want the same models and chat history as claude.ai web, Claude Desktop is the shortest path.

### Codex (OpenAI Codex CLI)
Add to `~/.codex/config.toml`:

```toml
[mcp_servers.taxlaw-nts]
command = "node"
args = ["/absolute/path/to/taxlaw-nts-mcp/build/index.js"]
default_tools_approval_mode = "approve"
```

Windows users: use absolute node.exe path:

```toml
[mcp_servers.taxlaw-nts]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\Users\<you>\.codex\mcp\taxlaw-nts-mcp\build\index.js']
default_tools_approval_mode = "approve"
```

### Update procedure
```bash
cd /path/to/taxlaw-nts-mcp
git pull
npm install
npm run build
```
Restart the MCP client (Claude Code / Codex) to pick up the new build.

### npm global install (optional)
Once published to npm:

```bash
npm install -g taxlaw-nts-mcp
```

```json
{ "mcpServers": { "taxlaw-nts": { "command": "taxlaw-nts-mcp" } } }
```

```toml
[mcp_servers.taxlaw-nts]
command = "taxlaw-nts-mcp"
```

## Environment

No API key is required. The default User-Agent is `taxlaw-nts-mcp/<version> (+https://github.com/kim-go-chon/taxlaw-nts-mcp)` so the client identifies itself transparently. Only override it with a browser-like UA if NTS blocks the default.

```bash
TAXLAW_USER_AGENT="Mozilla/5.0 ..."
```

## Error Behavior

Empty search/detail results return `[NOT_FOUND]` with `isError: true`. External site failures return `[EXTERNAL_API_ERROR]`; invalid input returns `[INVALID_PARAMETER]`. Tool responses include source URLs and the IDs used for lookups.

## Development

```bash
npm run build
npm run watch
npm test
npm pack --dry-run
```

## Terms of Use & Legal Notice

This is an **unofficial** client for the NTS Tax Law Information System (`https://taxlaw.nts.go.kr`), intended for personal study, research, and professional tax/legal work assistance. This project is not affiliated with the Korean National Tax Service. Users are solely responsible for complying with the NTS terms of service and applicable law.

- **Compliance**
  - Review the NTS [terms of service](https://taxlaw.nts.go.kr) and `robots.txt` before use.
  - The default User-Agent identifies this client. Do not modify it to disguise or hide the client identity.
  - Avoid bulk scraping and tight polling loops. Publication enrichment is already capped at 8 concurrent requests.
  - Do not redistribute or commercialize the retrieved data without permission. Copyrights for statutes, precedents, and interpretations belong to the issuing institutions.
- **Limitations**
  - Results reflect the NTS response at retrieval time. Authoritative legal/tax decisions require consulting original sources (MOLEG, NTS) and licensed practitioners.
  - The tool emits guard messages discouraging LLM hallucination, but final judgement rests with the user.
- **Disclaimer**
  - Authors and contributors accept no liability for legal/tax misjudgement, NTS ToS violations, blocking actions, or data loss arising from use of this tool (see MIT License).

## License

MIT
