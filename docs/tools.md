# Tool Reference

## Companion Role (필수 동반 호출)

이 MCP는 `korean-law-mcp`와 **항상 짝으로 사용**해야 합니다. 한쪽만 호출하면 누락이 발생합니다.

- `korean-law-mcp`: MOLEG/law.go.kr 법조문, 시행일, 부칙, 개정연혁, 판례, 해석례, 조세심판, 조약, 인용 검증의 1차 권위.
- `taxlaw-nts-mcp`(본 MCP): 국세청 측 세법해석례, 질의회신, 기본통칙, 별표·서식, 발간책자, 홈택스 상담사례, 그리고 **국세청 업종코드↔KSIC 매핑 DB(내장)**.

호출 의무:
1. 법령·세법 관련 모든 질문에서 두 MCP를 모두 호출하고 양쪽 출처 ID를 병기.
2. 본 MCP가 반환한 질의회신/해석례를 사용자에게 제시할 때는 **반드시** `get_taxlaw_document_text(..., targetYear=YYYY)`로 호출해 인용 법조문 시점과 적용연도를 비교. 구법 기반이면 `korean-law-mcp`로 현행 문구와 대조하고 사문화 가능성을 함께 보고.
3. 업종코드·산업 분류 질문은 본 MCP의 `lookup_upjong_code` / `resolve_industry_class` / `classify_industry_for_article`로 1차 응답. 추정 금지.

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

Key arguments: `id`, `docType`, `full`, **`targetYear`**.

`targetYear`(예: 2024)를 지정하면 본문 **'관련규정/관련법령' 섹션**을 자동 파싱하여:
- 인용된 법조문의 법률번호·일자(YYYY.MM.DD)·개정 단서("개정 전", "구법", "삭제", "신설" 등)를 추출
- `targetYear`보다 앞선 시점의 인용만 있으면 `classification = before_target`로 분류하고 **구법조문 기반 예규** 가능성 경고
- 항상 `korean-law-mcp` `get_law_text(jo=...)`로 현행 조문과 직접 대조할 것을 안내

⚠️ 이 검증은 본문 휴리스틱 파싱이며, 최종 적용가능성은 반드시 `korean-law-mcp`로 직접 대조 후 보고하세요.

## 업종코드 ↔ KSIC DB 도구

본 MCP는 국세청 '업종코드-표준산업분류 연계표' CSV를 빌드 시 JSON으로 변환해 내장합니다 (`build/data/upjong-ksic.json`, 약 1,784건, 귀속연도는 `upjong_db_info`로 확인).

### `lookup_upjong_code`
6자리 업종코드 → KSIC 매핑 및 대/중/소/세/세세 5단계 분류명·코드. 사용자가 업종코드를 묻거나 법조문이 특정 업종을 가리킬 때 1차 호출.

### `lookup_ksic_code`
KSIC 5자리 정확 일치 → 매핑된 업종코드 목록.

### `lookup_ksic_prefix`
KSIC 코드 prefix로 매칭. prefix 길이에 따라 분류수준 자동 식별:
- 1자리 영문(B/C/M…) = 대분류
- 2자리 = 중분류
- 3자리 = 소분류 (예: 681 부동산임대업)
- 4자리 = 세분류 (예: 4791 통신판매업, 6811 부동산 임대업)
- 5자리 = 세세분류

조특법 §6 3항 5호 "통신판매업"(KSIC 4791), §6 2조 1항 4호 "부동산 임대업"(KSIC 6811) 등 prefix 패턴이 자주 필요합니다.

### `search_industry_by_keyword`
분류명 키워드 검색(띄어쓰기·괄호 무시 정규화 매칭).
- `levels` 옵션으로 검색 분류수준 한정 가능. 예: `levels=["l3","l4","l5"]`.
- 사례: "주점" 키워드 검색 시 levels 미지정이면 l2 '음식점 및 주점업'에도 매칭되어 모든 음식점이 결과에 포함. levels=["l3","l4","l5"]로 좁히면 실제 주점업만.

### `resolve_industry_class`
법조문 인용 산업명 한 줄 → KSIC/업종코드의 어느 분류수준(대/중/소/세/세세)인지 후보 반환.
같은 명칭이 여러 레벨에 등장하면 모두 보여 줍니다(예: "기타 전문, 과학 및 기술 서비스업" → KSIC 중분류 73 + 업종 중분류 85 둘 다).

### `classify_industry_for_article` (핵심)
법조문 산업명·제외 단서·평가 업종코드 → verdict ∈ {match, excluded, out_of_scope, ambiguous}.

분류수준을 자동 식별하기 때문에 LLM이 "대분류명만 보고 매칭"하는 실수를 차단합니다.

`excludeLevels` 옵션으로 제외 단서 검색 분류수준 한정 가능. 권장: `excludeLevels=["l3","l4","l5"]`. 7호 음식점업에서 '주점' 차감 시 l2 '음식점 및 주점업'에 휘말리는 것 방지.

예 (조세특례제한법 시행령 27조 3항 16호):
```
classify_industry_for_article({
  industryName: "기타 전문, 과학 및 기술 서비스업",
  upjongCode:   "749942",
  excludeNames: ["수의업"]
})
→ verdict: out_of_scope
  (749942는 업종 중분류 74 '전문 서비스업'이며 16호가 가리키는 중분류와 일치하지 않음)
```

```
classify_industry_for_article({
  industryName: "기타 전문, 과학 및 기술 서비스업",
  upjongCode:   "852000",
  excludeNames: ["수의업"]
})
→ verdict: excluded
  (852000은 중분류 85에 해당하나 소분류 852가 수의업이므로 제외)
```

⚠️ **법조문 인용 시 반드시 부칙·시행일을 `korean-law-mcp` `get_law_text`로 별도 확인**하세요. 본 도구는 분류 매핑만 책임지며, 시행일/개정 단서 해석은 책임지지 않습니다.

### `upjong_db_info`
내장 DB의 생성 시각, 원본 CSV 경로, 귀속연도, 레코드 수 (신선도 확인용).

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

## `diff_article_versions` (v0.10.0)

두 시점 시행본의 같은 조문을 단어단위로 기계 대조해 **변경 hunk만** 반환 (【삭제】【신설】 마커 + 앞뒤 문맥). 타임테이블 해석 공리 ①(신구 나란히 대조)·②(개정규정=문구단위)의 기계화.

- 분류는 결정적 휴리스틱: `실질변경` / `자구정비`(문장부호만) / `번호이동`(번호·날짜 패턴만). LLM 추정 아님.
- Key arguments: `jo`(필수), `hang`, `lawName`, `yearA`/`efYdA`/`mstA`(구), `yearB`/`efYdB`/`mstB`(신), `full`.
- "✅ 변경 없음"은 그 구간 해당 조문 무개정의 **적극 신호** (예: 조특령 §26의8⑥ 2024↔2026 무개정 확인).
- ⚠ 변경 문구의 개정령 귀속은 `get_law_revision_text`(개정문)·`get_law_addenda`(부칙)로 확정 후 단정. 부칙-of-부칙 개정(본문 미변경)은 이 도구에 안 잡힌다.
- 시점 해소는 공포일자 우선 tie-break(v0.10.0): 분할시행 행(시행일만 늦은 구 공포본)이 후행 공포본(자구개정 누적)을 가리는 문제 수정 — `get_law_article`에도 동일 적용.

## `research_taxlaw_topic` (v0.10.0)

체인 매크로: `search_taxlaw_documents` → 관련성 상위 K건(기본 2, 최대 3)의 `get_taxlaw_document_text(full, targetYear)` 본문 첨부를 1콜로. 검색→본문→연도검증 다턴 왕복 절감.

- 첨부는 항상 full 본문 기반(요지≠결론 가드 유지) + 연도검증·통칙검증·결론부 가드 부착.
- Key arguments: `query`(필수), `targetYear`, `topK`, `docType`(기본 all), `taxLawCode`, `fromDate`/`toDate`, `full`.
- 복합어 자동 분해 재시도는 없음 — 결과 없으면 `search_taxlaw_documents`로 재검색.

## 토큰·성능 메모 (v0.10.0)

- **도구결과 캐시**: 법제처 XML 24h / NTS 문서상세 12h / NTS 검색 1h, LRU 200건. 같은 자원 재조회(요지→full→targetYear)가 ms 단위로 단축. lawName→MST 해소도 자동 커버.
- **검색결과 staleness 플래그**: 생산일자가 `TAXLAW_RECENT_THRESHOLD_YEARS`(기본 3년) 초과 경과 시 "⚠ 생산 N년 경과" 자동 부착.
- **판례·결정례(05~10) 요약본**: head 5000 + tail 2500자 분할(결론부 보존)로 full=true 재조회 필요성 축소. 인용 전 full=true 검증 의무는 유지.
- 검색 목록 요지 450자·검색근거 300자(트리아지용 — 인용 판단은 상세 본문에서).

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
