# taxlaw-nts-mcp

국세법령정보시스템(`https://taxlaw.nts.go.kr`) 자료를 MCP 도구로 검색하는 STDIO 서버입니다.

[![MCP 1.27](https://img.shields.io/badge/MCP-1.27-blue)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

법제처에서 바로 찾기 어려운 국세청 세법해석, 질의회신, 조세 불복 문서, 기본통칙, 별표/서식, 발간책자, 홈택스 상담사례를 보완 검색합니다.

전용 고수준 도구가 아직 없는 메뉴도 접근할 수 있도록, 확인된 사이트 메뉴/action 목록 조회와 `action.do` 원시 호출, 같은 사이트 HTML 텍스트 조회 도구를 함께 제공합니다.

[English](./README-EN.md)

## 무엇에 쓰나

세법 검토의 근거는 법 조문만이 아니라 국세청 해석례·질의회신·기본통칙, 조세심판례, 홈택스 상담사례인 경우가 많습니다. 이 자료들은 법제처 국가법령정보센터에서는 잘 나오지 않고 국세법령정보시스템에만 있습니다. 이 서버는 그 자료를 찾아 본문까지 가져오고, 세법 검토에서 자주 문제되는 부분을 함께 처리합니다.

- **국세청 전용 자료 조회** — 세법해석례·질의회신·기본통칙·조세심판례·홈택스 상담사례·발간책자를 번호나 키워드로 찾아 본문을 가져옵니다.
- **인용 번호 실존 확인** — 답변에 들어갈 해석례·심판례 번호가 실제 DB에 있는지 대조합니다(`verify_nts_citations`). 없는 번호는 걸러 내거나 "공개DB 미발견"으로만 남겨, 존재하지 않는 예규를 근거로 다는 일을 막습니다.
- **적용 시점 확인** — 귀속연도를 지정하면 그 해에 적용되던 조문으로 검토하고(`build_application_timetable`), 개정으로 사문화됐거나 폐지·대체된 해석인지 판정합니다(`assess_doctrine_validity`). 신·구 조문은 나란히 대조할 수 있습니다(`diff_article_versions`).
- **계산식 조문 원문 유지** — 조특법 고용증대·통합고용 세액공제처럼 표·산식이 든 조문은 일반 법령 API에서 산식이 빠지기도 하는데, 여기서는 산식까지 그대로 가져옵니다.
- **업종코드 감면 판정** — 창업중소기업·중소기업특별세액감면 검토에서 해당 업종코드가 감면 대상인지 표준산업분류와 대조해 해당/제외/범위밖/애매로 판정합니다(`classify_industry_for_article`).
- **정리된 형식으로 회신** — 결론 → 케이스별 표 → 근거 법령(출처별·원문링크) → 미검증 보충(⚠) 순으로 정리돼, 의견서·검토 메모에 옮기기 쉽습니다.

법 조문·판례 원문은 법제처 MCP(`korean-law-mcp`), 국세청 해석·통칙·심판례는 이 서버에서 확인하는 식으로 나눠 씁니다. API 키나 비용은 없으며, 최종 판단은 원문과 전문가 확인을 거쳐야 합니다.

## korean-law-mcp와 함께 쓰는 방식

세법 질의는 먼저 `korean-law-mcp`로 법령 조문, 시행령, 판례, 조세심판 등 법제처/법령 DB 자료를 확인하고, 법제처 검색에서 국세청 질의회신·기본통칙·홈택스 상담사례·발간책자를 찾지 못할 때 이 서버로 보완 조회하는 흐름을 권장합니다.

두 MCP가 같은 판례·결정례·해석례를 찾으면 문서번호/청구번호/사건번호에서 공백·하이픈을 제거한 값, 생산일자/의결일자, 제목을 기준으로 하나로 정리하세요. 같은 항목은 중복 나열하지 말고 양쪽 출처 ID를 함께 남기며, 국세법령정보시스템에만 있는 원문 스니펫·홈택스 상담·기본통칙·발간책자는 이 서버 결과로 보완합니다.

이 서버는 국세법령정보시스템 응답에 존재한 항목만 표시하며, 검색 실패나 외부 사이트 오류가 나면 `[NOT_FOUND]`, `[EXTERNAL_API_ERROR]`, `[INVALID_PARAMETER]` 같은 마커와 추측 금지 경고를 반환합니다.

모든 도구 결과는 기존 텍스트·`isError`와 함께 `structuredContent.status`를 제공합니다. 상태값은 `OK`, `NOT_FOUND`, `INVALID_INPUT`, `UPSTREAM_ERROR`, `PARSE_ERROR`, `AUTH_ERROR`, `BUDGET_EXCEEDED`이며, 기존 마커를 파싱하던 클라이언트도 그대로 사용할 수 있습니다. `NOT_FOUND`는 공개 DB에서 해당 조건의 항목을 찾지 못했다는 뜻이지 문서의 법적 부존재를 확정하는 뜻은 아닙니다.

## 응답 포맷 — 5단 구조 (0.6.0+)

MCP `InitializeResult.instructions`로 LLM에 자동 주입됩니다. 클라이언트(Claude Code 등)는 이를 system-reminder로 노출하여 LLM이 아래 5단 구조를 따르도록 강제합니다. 단순 1~2문장 단답형 질문은 생략 가능.

1. **결론 (요지)** — 사용자 이해와 어긋나면 맨 앞에서 명시. 핵심 판정·조치 1~2문장.
2. **매트릭스 (케이스별 처리)** — 분기 기준(소득구성·신고유형·거래유형 등)을 표로 정리. 각 행에 결론 + 근거 법령 함께 표기.
3. **법령 래퍼 (Citation)** — 출처별로 분리:
   - (1) 법률 — `korean-law-mcp.get_law_text` 결과
   - (2) 시행령/시행규칙 — MST·시행일 명시
   - (3) 기본통칙 — `list/get_taxlaw_basic_ruling` 또는 본문 인용
   - (4) 국세청 해석례 / 심판례 / 판례 — 문서번호·일자·핵심 인용문
4. **AI 보충 해석 (⚠ 검증되지 않음)** — LLM 자체 지식·실무 팁은 별도 단락에 ⚠ 경고와 함께 분리.
5. **인용/피드백 prompt 2줄** — "인용 본문을 더 부착해드릴까요?" + "1~5점 + 한 줄 코멘트".

**출처 격리** — (1)~(4)는 검증된 출처. 섹션 내용을 다른 섹션과 섞지 말 것. AI 보충과의 혼합 금지.

**연도 검증 의무** — 해석례 인용 시 `get_taxlaw_document_text(targetYear=YYYY)`로 인용 법조문 시점 자동 검증. 구법조문 기반 예규는 ⚠ 사문화 가능성 경고 동봉.

**사문화 자동 채점 (0.7.0+)** — 예규/심판례/판례를 인용할 때 `assess_doctrine_validity(id, targetYear)`를 호출하면 8단계 분류(valid_current / target_or_later / before_target / partially_outdated / repealed_or_superseded / no_citations / no_target / uncertain)와 6단계 최종 판정(valid_current / needs_current_check / partially_outdated / likely_outdated / superseded_or_repealed / unverified)을 자동 채점하고, korean-law-mcp로 현행 조문 대조 + 후속 결정(대법원·헌재) 확인까지 이어지는 next-action 큐를 반환합니다.

## 제공 도구

`tools/list`에 바로 노출되는 도구와, 세션 고정 토큰 절감을 위해 `call_taxlaw_extra(name, args)` 게이트웨이로 호출하는 저빈도 도구로 나뉩니다. 저빈도 도구도 `TAXLAW_EXPOSE_ALL=1` 환경변수를 주면 모두 직접 노출됩니다.

### 검색·본문 조회
| Tool | 용도 |
| --- | --- |
| `search_taxlaw_all` | 통합검색 — 별표서식·국세법령·세법해석/질의·판례결정례·발간책자·홈택스 상담사례 |
| `search_taxlaw_documents` | 세법해석례/질의회신(01–04)과 과세전적부·이의·심사·심판·판례·헌재(05–10) 검색. 세목코드(`taxLawCode`) 지정 권장 |
| `get_taxlaw_document_text` | 문서 상세 본문. **`targetYear`**로 인용 법조문 시점 검증, **`full`**로 판례·결정례 주문·판단 결론부까지 |
| `get_taxlaw_document_by_number` | DOC_ID를 거치지 않고 문서번호·회신번호로 직접 조회. 공백·하이픈 정규화 후 완전일치 |
| `research_taxlaw_topic` | 체인 매크로 — 검색 → 관련 상위 K건 본문(`full`·`targetYear`) 첨부를 1콜로(다턴 왕복 절감). `targetYear` 지정 시 픽별 유효성 1줄 자동 첨부 |
| `assess_doctrine_validity` | 해석례·심판례·판례 한 건의 **현행 유효성 자동 채점**(6단계 판정 + 권장 후속 호출 큐) |
| `verify_nts_citations` | 산출물 속 해석례·심판례·판례 번호를 일괄 추출해 **실존 여부 확인**(인용 게이트). `claims`로 인용–명제 적합성까지 검사 |
| `list_taxlaw_basic_ruling_laws` | 기본통칙 법령 목록 조회(`lawId` 확보) |
| `get_taxlaw_basic_ruling_text` | 기본통칙 본문 조회 |
| `search_taxlaw_forms` | 별표·서식(전체·법령서식·훈령서식·자주찾는서식) 검색 |

### 조문 시점·적용시기 (법제처 DRF 보완)
국세법령정보시스템에 없는 부칙·시점본·조문 신구대조를 법제처 국가법령정보 Open API로 보완합니다. 귀속연도가 걸린 질문은 여기부터 시작합니다.

| Tool | 용도 |
| --- | --- |
| `build_application_timetable` | 귀속연도 제시 질문의 1차 진입점 — 개정 인벤토리 + 부칙 적용례 태깅 + 귀속연도×조문 매트릭스를 1콜로 |
| `trace_article_application` | 단일 조문의 연도별(귀속) 적용시점을 부칙 적용례 기준으로 추적 |
| `get_law_article` | 특정 시점(연도/시행일/MST)의 조문 본문 + **계산식 이미지 URL**. 과거본엔 후행 개정 자동 대조 |
| `diff_article_versions` | 두 시점 시행본의 같은 조문을 단어단위로 대조(변경 hunk만) |
| `get_law_addenda` | 법령 부칙(시행일·적용례·경과조치) 조회 |
| `get_law_revision_text` | 특정 개정령의 개정문(개정 지시문 원문) 회수 |

### 세액감면 업종 판정
| Tool | 용도 |
| --- | --- |
| `classify_credit_eligibility` | 업종코드 → 창업중소기업 세액감면(조특법 §6③)·중소기업특별세액감면(§7①) 적격 업종 여부 판정. 단서업종은 조특법·령·칙 본문 재확인 |

### `call_taxlaw_extra`로 호출하는 저빈도 도구
`call_taxlaw_extra({ name, args })` 형태로 호출합니다.

- **업종코드 ↔ KSIC 매핑** — `lookup_upjong_code` · `lookup_ksic_code` · `lookup_ksic_prefix` · `search_industry_by_keyword` · `resolve_industry_class` · `classify_industry_for_article` · `upjong_db_info`
- **발간책자·홈택스·사이트 메뉴** — `get_taxlaw_hometax_counsel_text` · `search_taxlaw_publications` · `list_taxlaw_publication_categories` · `list_taxlaw_site_menus` · `get_taxlaw_page_text` · `call_taxlaw_action`
- **하위호환 별칭** — `search_taxlaw_interpretations`(=`search_taxlaw_documents`) · `get_taxlaw_interpretation_text`(=`get_taxlaw_document_text`)

#### 업종코드 ↔ KSIC 매핑 DB
국세청 「업종코드-표준산업분류 연계표」를 빌드 시 JSON으로 내장(약 1.5MB, 1,784 레코드, 귀속연도 2024). 분류수준(대/중/소/세/세세)을 자동 식별해 LLM이 "대분류만 보고 잘못 매칭"하는 실수를 차단합니다.

예 — 조특법 시행령 §27③ 16호 판정(749942 vs 852000):
```js
call_taxlaw_extra({
  name: "classify_industry_for_article",
  args: {
    industryName: "기타 전문, 과학 및 기술 서비스업",
    upjongCode:   "749942",     // 국세청 중분류 74 "전문 서비스업"
    excludeNames: ["수의업"]
  }
})
// → verdict: out_of_scope (16호가 가리키는 KSIC 중분류 73과 불일치)
```

## 전체 메뉴 접근

이 절의 `list_taxlaw_site_menus`·`call_taxlaw_action`·`get_taxlaw_page_text`는 저빈도 도구라 기본적으로 `call_taxlaw_extra`로 감싸 호출합니다(`TAXLAW_EXPOSE_ALL=1`이면 직접 호출 가능). 먼저 `list_taxlaw_site_menus`로 메뉴 키, URL, 확인된 `actionId`, 기본 `paramData`를 확인합니다. 전용 도구가 있는 메뉴는 해당 고수준 도구를 쓰고, 없는 메뉴는 `call_taxlaw_action`에 `actionId`, `defaultParamData`, `refererPath`를 넘겨 원시 응답을 조회합니다. 세목별요약정보·세법개정건의처럼 정적 HTML로 제공되는 자료는 `get_taxlaw_page_text`에 `/html/U_0101.html`, `/cm/USECMJ001M.do` 같은 경로를 넘겨 조회합니다. 세무일정은 `list_taxlaw_site_menus(query="세무일정")`에서 확인한 `ASECMC001MR01` action에 `year`, `month`를 넘겨 조회할 수 있습니다.

## 빠른 시작

```bash
git clone https://github.com/kim-go-chon/taxlaw-nts-mcp.git
cd taxlaw-nts-mcp
npm install
npm run build      # tsc + 내장 DB(JSON) 복사
npm test           # 240개 단위 테스트 (선택)
npm start          # MCP STDIO 서버 실행
```

설치 후 **추가 다운로드 없이 모든 도구가 즉시 동작**합니다. 업종코드↔KSIC 매핑 DB(`src/data/upjong-ksic.json`, 약 1.5MB, 1,784 레코드, 귀속연도 2024)는 저장소에 포함되어 있습니다.

### 매핑 DB를 최신 데이터로 교체하려면 (선택)
국세청이 「업종코드-표준산업분류 연계표」를 갱신했을 때만 필요합니다. 본인이 받은 최신 CSV를 환경변수로 지정해 재빌드하면 됩니다.

```bash
# Linux/macOS
UPJONG_CSV=/path/to/업종코드-표준산업분류\ 연계표.csv npm run build:data

# Windows PowerShell
$env:UPJONG_CSV = "C:\path\to\업종코드-표준산업분류 연계표.csv"
npm run build:data

# 그 다음 (두 OS 공통)
npm run build
```

## 설치 — MCP 클라이언트별 안내

### Claude Desktop / Claude Code (STDIO 직접 지원)
`claude_desktop_config.json`(Claude Desktop) 또는 프로젝트별 `.mcp.json`(Claude Code)에 등록:

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

### Claude.ai 웹 (브라우저)
**현재 본 MCP는 claude.ai 웹에서 직접 사용할 수 없습니다.** claude.ai의 [Custom Connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) 기능은 **공인 인터넷으로 노출된 원격 MCP 서버(HTTPS)만** 지원하지만, 본 서버는 STDIO 전용입니다.

**권장 대안 — Claude Desktop**: 위 "Claude Code" 섹션의 `claude_desktop_config.json` 등록 방식이 그대로 적용됩니다. Claude Desktop은 macOS/Windows 앱에서 로컬 STDIO MCP를 직접 지원하므로 별도 배포 없이 즉시 동작합니다. claude.ai 웹과 동일한 모델·대화 히스토리를 사용하면서 본 MCP를 쓰려면 Claude Desktop이 가장 간단한 경로입니다.

### Codex (OpenAI Codex CLI)
`~/.codex/config.toml`에 등록:

```toml
[mcp_servers.taxlaw-nts]
command = "node"
args = ["/absolute/path/to/taxlaw-nts-mcp/build/index.js"]
default_tools_approval_mode = "approve"
```

Windows 사용자는 백슬래시 경로 + node.exe 절대경로 권장:

```toml
[mcp_servers.taxlaw-nts]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\Users\사용자명\.codex\mcp\taxlaw-nts-mcp\build\index.js']
default_tools_approval_mode = "approve"
```

### 업데이트 절차 (양쪽 공통)
```bash
cd /path/to/taxlaw-nts-mcp
git pull
npm install
npm run build      # CSV가 등록되어 있으면 데이터도 함께 재빌드
```
MCP 클라이언트(Claude Code, Codex)를 재시작하면 새 버전이 활성화됩니다.

### npm 전역 설치 (선택)
npm 레지스트리에 배포된 경우 더 짧게 등록 가능합니다.

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

## 환경 변수

API 키는 필요하지 않습니다. 기본 User-Agent는 `taxlaw-nts-mcp/<version> (+https://github.com/kim-go-chon/taxlaw-nts-mcp)`로 클라이언트 식별이 가능하게 설정되어 있습니다. 국세법령정보시스템에서 봇으로 차단되는 경우에 한해 일반 브라우저 UA로 덮어쓰세요.

```bash
TAXLAW_USER_AGENT="Mozilla/5.0 ..."
```

도구 콜 1건에 시간예산을 걸 수 있습니다(tail-latency 방어, 소진 시 부분 결과 + 재호출 안내).

```bash
TAXLAW_TOOL_BUDGET_MS=90000   # 도구 콜 시간예산(ms). 기본 90000, 0=무제한
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

## 데이터 출처 · 저작권 안내

- **국세법령정보시스템 응답**: 본 MCP가 실시간 호출로 받아오는 모든 본문은 국세법령정보시스템(`https://taxlaw.nts.go.kr`)의 공개 자료입니다. 저작권은 각 발행기관(국세청·법원·헌법재판소·기재부 등)에 있습니다.
- **업종코드↔KSIC 매핑 DB**: 본 저장소는 「업종코드-표준산업분류 연계표」(국세청 홈택스 공개 자료)를 JSON으로 변환한 결과(`src/data/upjong-ksic.json`, 귀속연도 2024)를 포함합니다. 사용자가 추가로 다운로드할 필요 없이 즉시 사용 가능합니다. 최신 데이터로 교체하려면 본인이 받은 CSV를 `UPJONG_CSV` 환경변수로 지정해 `npm run build:data && npm run build`를 다시 실행하세요.
- **인용 시**: "출처: 국세청 「업종코드-표준산업분류 연계표」" 형태로 출처를 함께 표기하세요.

## 이용약관·법적 고지

이 도구는 국세법령정보시스템(`https://taxlaw.nts.go.kr`)의 공개 자료를 개인 학습·연구·법률 업무 보조 목적으로 조회하기 위한 비공식 클라이언트입니다. 이 프로젝트는 국세청과 무관하며, 사용자가 직접 NTS의 이용약관과 법령을 준수할 책임이 있습니다.

- **준수 사항**
  - NTS 사이트의 [이용약관](https://taxlaw.nts.go.kr) 및 `robots.txt`를 사용 전 확인하세요.
  - 본 MCP는 기본 User-Agent로 클라이언트 식별 문자열을 보냅니다. 식별 정보를 제거하거나 위장할 목적으로 변경하지 마세요.
  - NTS 서버에 부담을 주지 않도록 대량 일괄 수집(scraping), 짧은 간격의 반복 호출은 피하세요. 발간책자 enrichment는 동시 8건으로 제한되어 있습니다.
  - 조회한 자료를 무단 재배포·상업적 가공하지 마세요. 법령·판례·해석례의 저작권은 각 기관에 있습니다.
- **한계**
  - 결과는 NTS 응답 시점의 데이터입니다. 법적 효력 있는 판단은 반드시 원문(법제처/국세청)과 변호사·세무사·관할 기관 확인이 필요합니다.
  - LLM이 결과를 추측·생성하지 않도록 가드 메시지를 함께 반환하지만, 최종 판단은 사용자에게 있습니다.
- **면책**
  - 본 도구의 사용으로 발생한 법률·세무 판단 오류, NTS 약관 위반, 차단 조치, 데이터 손실 등에 대해 저자/기여자는 책임지지 않습니다(MIT License 참조).

## 라이선스

MIT
