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

| Tool | Purpose |
| --- | --- |
| `search_taxlaw_all` | Integrated NTS search across annexes/forms, tax statutes, interpretations/Q&A, cases, publications, and Hometax counseling |
| `search_taxlaw_documents` | Search interpretations/Q&A and dispute documents |
| `get_taxlaw_document_text` | Retrieve document detail text by `DOC_ID`/`DOCID` |
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

## Full Menu Access

Use `list_taxlaw_site_menus` first to find the menu key, URL, observed `actionId`, and default `paramData`. Prefer a high-level tool when one is listed. For remaining menu-backed data, pass the observed `actionId`, `defaultParamData`, and `refererPath` to `call_taxlaw_action`. Static HTML resources, such as tax-summary pages under `/html/U_0101.html` and tax-law suggestion guidance at `/cm/USECMJ001M.do`, can be read with `get_taxlaw_page_text`. Tax calendar data is available through the `ASECMC001MR01` action listed by `list_taxlaw_site_menus(query="세무일정")`.

## Quick Start

```bash
npm install
npm run build
npm start
```

Local MCP client configuration:

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

After npm publishing:

```bash
npm install -g taxlaw-nts-mcp
```

```json
{
  "mcpServers": {
    "taxlaw-nts": {
      "command": "taxlaw-nts-mcp"
    }
  }
}
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
