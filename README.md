# taxlaw-nts-mcp

국세법령정보시스템(`https://taxlaw.nts.go.kr`) 자료를 MCP 도구로 검색하는 STDIO 서버입니다.

[![MCP 1.27](https://img.shields.io/badge/MCP-1.27-blue)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

법제처에서 바로 찾기 어려운 국세청 세법해석, 질의회신, 조세 불복 문서, 기본통칙, 별표/서식, 발간책자, 홈택스 상담사례를 보완 검색합니다.

전용 고수준 도구가 아직 없는 메뉴도 접근할 수 있도록, 확인된 사이트 메뉴/action 목록 조회와 `action.do` 원시 호출, 같은 사이트 HTML 텍스트 조회 도구를 함께 제공합니다.

[English](./README-EN.md)

## korean-law-mcp와 함께 쓰는 방식

세법 질의는 먼저 `korean-law-mcp`로 법령 조문, 시행령, 판례, 조세심판 등 법제처/법령 DB 자료를 확인하고, 법제처 검색에서 국세청 질의회신·기본통칙·홈택스 상담사례·발간책자를 찾지 못할 때 이 서버로 보완 조회하는 흐름을 권장합니다.

두 MCP가 같은 판례·결정례·해석례를 찾으면 문서번호/청구번호/사건번호에서 공백·하이픈을 제거한 값, 생산일자/의결일자, 제목을 기준으로 하나로 정리하세요. 같은 항목은 중복 나열하지 말고 양쪽 출처 ID를 함께 남기며, 국세법령정보시스템에만 있는 원문 스니펫·홈택스 상담·기본통칙·발간책자는 이 서버 결과로 보완합니다.

이 서버는 국세법령정보시스템 응답에 존재한 항목만 표시하며, 검색 실패나 외부 사이트 오류가 나면 `[NOT_FOUND]`, `[EXTERNAL_API_ERROR]`, `[INVALID_PARAMETER]` 같은 마커와 추측 금지 경고를 반환합니다.

## 제공 도구

| Tool | 용도 |
| --- | --- |
| `search_taxlaw_all` | 국세법령정보시스템 통합검색. 별표서식, 국세법령, 세법해석/질의, 판례·결정례, 발간책자, 홈택스 상담사례를 함께 검색 |
| `search_taxlaw_documents` | 세법해석례/질의회신과 과세전적부, 이의, 심사, 심판, 판례, 헌재 문서 검색 |
| `get_taxlaw_document_text` | 검색 결과의 `DOC_ID`/`DOCID`로 문서 상세 본문 조회 |
| `get_taxlaw_hometax_counsel_text` | 통합검색 홈택스 상담사례 결과의 `REQ_STD_ID`로 상세 본문 조회 |
| `list_taxlaw_site_menus` | 국세법령정보시스템 주요 메뉴와 확인된 `action.do` 호출 정보 조회 |
| `call_taxlaw_action` | 메뉴에서 확인한 `actionId`/`paramData`로 `action.do` 원시 JSON 조회 |
| `get_taxlaw_page_text` | 정적 HTML 자료와 일반 페이지를 텍스트로 조회 |
| `search_taxlaw_interpretations` | 기존 호환용 세법해석례 검색 alias |
| `get_taxlaw_interpretation_text` | 기존 호환용 세법해석례 상세 alias |
| `list_taxlaw_basic_ruling_laws` | 기본통칙 법령 목록 조회 |
| `get_taxlaw_basic_ruling_text` | 기본통칙 본문 조회 |
| `search_taxlaw_forms` | 전체 서식, 별표, 법령서식, 훈령서식, 자주찾는서식 검색 |
| `search_taxlaw_publications` | 국세청 발간책자 검색. 가능한 경우 상세 API의 파일 ID와 다운로드 힌트까지 표시 |
| `list_taxlaw_publication_categories` | 발간책자 분야 코드 조회 |

## 전체 메뉴 접근

먼저 `list_taxlaw_site_menus`로 메뉴 키, URL, 확인된 `actionId`, 기본 `paramData`를 확인합니다. 전용 도구가 있는 메뉴는 해당 고수준 도구를 쓰고, 없는 메뉴는 `call_taxlaw_action`에 `actionId`, `defaultParamData`, `refererPath`를 넘겨 원시 응답을 조회합니다. 세목별요약정보·세법개정건의처럼 정적 HTML로 제공되는 자료는 `get_taxlaw_page_text`에 `/html/U_0101.html`, `/cm/USECMJ001M.do` 같은 경로를 넘겨 조회합니다. 세무일정은 `list_taxlaw_site_menus(query="세무일정")`에서 확인한 `ASECMC001MR01` action에 `year`, `month`를 넘겨 조회할 수 있습니다.

## 빠른 시작

```bash
npm install
npm run build
npm start
```

MCP 클라이언트에서 로컬 소스 경로로 실행하려면:

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

npm에 배포한 뒤에는 전역 설치 후 더 짧게 등록할 수 있습니다.

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

## 환경 변수

API 키는 필요하지 않습니다. 기본 User-Agent는 `taxlaw-nts-mcp/<version> (+https://github.com/kim-go-chon/taxlaw-nts-mcp)`로 클라이언트 식별이 가능하게 설정되어 있습니다. 국세법령정보시스템에서 봇으로 차단되는 경우에 한해 일반 브라우저 UA로 덮어쓰세요.

```bash
TAXLAW_USER_AGENT="Mozilla/5.0 ..."
```

## 오류 응답 원칙

검색 또는 상세 조회 결과가 없으면 `[NOT_FOUND]`와 `isError: true`를 반환합니다. 외부 사이트 오류는 `[EXTERNAL_API_ERROR]`, 잘못된 입력은 `[INVALID_PARAMETER]`로 반환합니다. 결과 본문에는 출처 URL과 실제 조회한 ID를 함께 표시합니다.

## 개발

```bash
npm run build
npm run watch
npm test
npm pack --dry-run
```

## 이용약관·법적 고지

이 도구는 국세법령정보시스템(`https://taxlaw.nts.go.kr`)의 공개 자료를 개인 학습·연구·법률 업무 보조 목적으로 조회하기 위한 비공식 클라이언트입니다. 이 프로젝트는 국세청과 무관하며, 사용자가 직접 NTS의 이용약관과 법령을 준수할 책임이 있습니다.

- **준수 사항**
  - NTS 사이트의 [이용약관](https://taxlaw.nts.go.kr) 및 `robots.txt`를 사용 전 확인하세요.
  - 본 MCP는 기본 User-Agent로 클라이언트 식별 문자열을 보냅니다. 식별 정보를 제거하거나 위장할 목적으로 변경하지 마세요.
  - NTS 서버에 부담을 주지 않도록 대량 일괄 수집(scraping), 짧은 간격의 반복 호출은 피하세요. 발간책자 enrichment는 동시 4건으로 제한되어 있습니다.
  - 조회한 자료를 무단 재배포·상업적 가공하지 마세요. 법령·판례·해석례의 저작권은 각 기관에 있습니다.
- **한계**
  - 결과는 NTS 응답 시점의 데이터입니다. 법적 효력 있는 판단은 반드시 원문(법제처/국세청)과 변호사·세무사·관할 기관 확인이 필요합니다.
  - LLM이 결과를 추측·생성하지 않도록 가드 메시지를 함께 반환하지만, 최종 판단은 사용자에게 있습니다.
- **면책**
  - 본 도구의 사용으로 발생한 법률·세무 판단 오류, NTS 약관 위반, 차단 조치, 데이터 손실 등에 대해 저자/기여자는 책임지지 않습니다(MIT License 참조).

## 라이선스

MIT
