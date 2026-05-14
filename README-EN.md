# taxlaw-nts-mcp

STDIO MCP server for Korea's NTS Tax Law Information System (`https://taxlaw.nts.go.kr`).

[![MCP 1.27](https://img.shields.io/badge/MCP-1.27-blue)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

This project complements `korean-law-mcp`. Use `korean-law-mcp` for MOLEG/law.go.kr data, and use this server for NTS materials that are hard to reach through MOLEG APIs: tax interpretations, Q&A, objection/review/tribunal/court decisions, basic rulings, annexes/forms, publications, and Hometax counseling examples.

For NTS menus that do not yet have a dedicated high-level tool, the server also exposes a known menu/action map, a raw `action.do` caller, and same-site HTML-to-text retrieval.

[한국어](./README.md)

## Using With korean-law-mcp

For Korean tax questions, use `korean-law-mcp` first for statutes, enforcement decrees, precedents, and tax tribunal materials from MOLEG/law.go.kr, then use this server to fill NTS-specific gaps such as tax interpretations, basic rulings, Hometax counseling examples, forms, and publications.

When both MCPs return the same precedent, decision, or interpretation, consolidate it by normalizing document/request/case numbers with spaces and hyphens removed, then comparing dates and titles. Do not list the same item twice; keep both source IDs and use this server to supplement NTS-only body snippets, Hometax counseling, basic rulings, and publications.

This server only displays items returned by the NTS Tax Law Information System. Empty results or external failures return markers such as `[NOT_FOUND]`, `[EXTERNAL_API_ERROR]`, and `[INVALID_PARAMETER]` plus a no-fabrication warning.

## Tools

### NTS Tax Law Information System search/retrieval
| Tool | Purpose |
| --- | --- |
| `search_taxlaw_all` | Integrated NTS search across annexes/forms, tax statutes, interpretations/Q&A, cases, publications, and Hometax counseling |
| `search_taxlaw_documents` | Search interpretations/Q&A and dispute documents |
| `get_taxlaw_document_text` | Retrieve document detail text by `DOC_ID`/`DOCID`. **`targetYear` option**: auto-verifies cited statute dates and warns if the document is based on superseded provisions |
| `get_taxlaw_hometax_counsel_text` | Retrieve Hometax counseling detail text by `REQ_STD_ID` |
| `list_taxlaw_site_menus` | List major NTS menus plus observed `action.do` call metadata |
| `call_taxlaw_action` | Call a raw NTS `action.do` action with `actionId` and `paramData` |
| `get_taxlaw_page_text` | Fetch same-site HTML/static pages as text |
| `search_taxlaw_interpretations` | Backward-compatible alias for interpretation search |
| `get_taxlaw_interpretation_text` | Backward-compatible alias for interpretation detail retrieval |
| `list_taxlaw_basic_ruling_laws` | List basic ruling law IDs |
| `get_taxlaw_basic_ruling_text` | Retrieve basic ruling text |
| `search_taxlaw_forms` | Search all forms, annexes, legal forms, directive forms, and favorite forms |
| `search_taxlaw_publications` | Search NTS publications |
| `list_taxlaw_publication_categories` | List publication category codes |

### Industry-code ↔ KSIC mapping (0.5.x)
The official NTS "Industry code ↔ Standard Industrial Classification (KSIC) mapping" is bundled as JSON (~1.5MB, 1,784 records, FY 2024). Tools auto-identify which classification level (l1 대분류 / l2 중분류 / l3 소분류 / l4 세분류 / l5 세세분류) a statute clause refers to, preventing the common LLM mistake of "matching on top-level name only".

| Tool | Purpose |
| --- | --- |
| `lookup_upjong_code` | 6-digit industry code → 5-level classification path + KSIC mapping |
| `lookup_ksic_code` | Exact 5-digit KSIC code → mapped industry codes |
| `lookup_ksic_prefix` | KSIC prefix match. 1-letter (B/C/M…) = l1, 2-5 digits = l2~l5. e.g. `681` (real-estate rental), `4791` (mail-order retail), `7421` (cleaning) |
| `search_industry_by_keyword` | Keyword search over class names (whitespace/punctuation normalized). **`levels` option** narrows search to specific levels |
| `resolve_industry_class` | Map a clause-quoted industry name to its KSIC/NTS classification levels. **`levels` option** |
| `classify_industry_for_article` | Given (statute industry name, exclusion clues, industry code under evaluation) → verdict ∈ {match, excluded, out_of_scope, ambiguous}. **`excludeLevels` option** narrows exclusion match levels to prevent over-exclusion |
| `upjong_db_info` | Bundled DB freshness (generation time, FY, record count) |

#### Example — Korean Restriction Special Tax Act Decree §27③ item 16
```js
classify_industry_for_article({
  industryName: "기타 전문, 과학 및 기술 서비스업",     // Korean: "Other professional, scientific, and technical services"
  upjongCode:   "749942",                                  // NTS l2 = 74 "Professional services"
  excludeNames: ["수의업"]                                  // Korean: veterinary services
})
// → verdict: out_of_scope (749942 is NTS l2=74, while item 16 refers to KSIC l2=73)
```

## Full Menu Access

Use `list_taxlaw_site_menus` first to find the menu key, URL, observed `actionId`, and default `paramData`. Prefer a high-level tool when one is listed. For remaining menu-backed data, pass the observed `actionId`, `defaultParamData`, and `refererPath` to `call_taxlaw_action`. Static HTML resources, such as tax-summary pages under `/html/U_0101.html` and tax-law suggestion guidance at `/cm/USECMJ001M.do`, can be read with `get_taxlaw_page_text`. Tax calendar data is available through the `ASECMC001MR01` action listed by `list_taxlaw_site_menus(query="세무일정")`.

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

### Claude Code (Claude Desktop MCP)
Add to `claude_desktop_config.json` or project-local `.mcp.json`:

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
