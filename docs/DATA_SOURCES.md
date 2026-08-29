# 데이터 소스·응답 계약

이 문서는 `taxlaw-nts-mcp`가 실제로 조회하는 데이터의 경계와 실패 의미를 정리합니다. 구현의 단일 기준은 `src/index.ts`이며, 이 문서는 도구 설명을 보완합니다.

## 1. 국세법령정보시스템 (NTS)

- 기본 주소: `https://taxlaw.nts.go.kr`
- 호출 방식: 사이트 세션을 확보한 뒤 `POST /action.do`에 확인된 `actionId`와 `paramData`를 전달합니다.
- 주요 범위: 세법해석·질의회신(01–04), 과세전적부·이의·심사·심판·판례·헌재(05–10), 기본통칙, 별표·서식, 발간책자, 홈택스 상담사례.
- `get_taxlaw_document_by_number`는 NTS 문서번호·회신번호를 정규화한 완전일치로 검색한 뒤, 기존 `get_taxlaw_document_text` 상세 경로를 재사용합니다.
- 검색 결과의 요지·검색근거는 트리아지용입니다. 결론·분류 인용은 `full=true` 본문(주문·판단)을 확인하고, 조문은 `korean-law-mcp`에서 현행 문구를 별도 대조합니다.

## 2. 법제처 국가법령정보센터 (MOLEG)

- 기본 주소: `https://www.law.go.kr`
- 이 저장소에서는 법령 연혁·시행본·부칙·개정문·조문 diff 보완에 사용합니다.
- 현행 조문·법원 판례·행정규칙의 1차 조회는 `korean-law-mcp`의 책임 범위입니다. 같은 기능을 NTS에 중복 구현하거나 지방세 자료를 이 저장소에 합치지 않습니다.

## 3. 저장소 내 정적 데이터

- `src/data/upjong-ksic.json`: 국세청 업종코드↔표준산업분류 매핑.
- `src/data/credit-eligibility.json`: 조세특례제한법 감면 업종 판정 보조표이며 `provisional` 플래그를 보존합니다.
- `src/data/statute-restructures.json`: 조문 번호 개편으로 인한 구·현행 위치 보조 매핑입니다.
- `upjong_db_info`가 데이터 생성 시각·원본·귀속연도·레코드 수를 반환합니다. 정적 데이터 갱신은 `npm run build:data` 후 `npm run build`로 반영합니다.

## 4. 결과 상태 계약

모든 도구 결과는 기존 텍스트와 `isError`를 유지하면서 다음 형태를 추가로 제공합니다.

```json
{"structuredContent":{"status":"OK"}}
```

허용 상태는 `OK`, `NOT_FOUND`, `INVALID_INPUT`, `UPSTREAM_ERROR`, `PARSE_ERROR`, `AUTH_ERROR`, `BUDGET_EXCEEDED`입니다.

- `NOT_FOUND`: 유효한 조회였으나 공개 DB가 조건에 맞는 행을 반환하지 않음. 법적 부존재를 뜻하지 않습니다.
- `UPSTREAM_ERROR`: NTS·법제처 등 외부 상류 오류 또는 일부 검색그룹 실패로 결과를 부존재로 확정할 수 없음.
- `BUDGET_EXCEEDED`: 도구 호출 시간예산이 소진되어 부분 결과만 유효함.
- 텍스트 첫 줄의 기존 `[NOT_FOUND]`, `[EXTERNAL_API_ERROR]`, `[INVALID_PARAMETER]` 등 마커는 하위 호환을 위해 계속 반환됩니다.

## 5. 검증 경로

- 단위·회귀 테스트: `test/*.test.js` (`npm test`)
- 타입·빌드: `npm run build`, `npx tsc --noEmit`
- 상류 보호 하네스: `scripts/harness/run.mjs` (`data` 축은 네트워크 없이 실행)
- 상류 장애 시에는 반복 호출하지 말고 상태값과 텍스트 가드를 함께 보고합니다.

## 6. 의도적으로 포함하지 않는 범위

지방세·OLTA 조회는 별도 `taxlaw-olta-mcp` 경계로 유지합니다. 이 저장소의 STDIO 전송을 HTTP 서버로 바꾸거나, `korean-law-mcp`의 법령 도구를 복제하는 변경은 데이터 경계와 운영 안전성을 깨므로 이 문서의 범위에 포함하지 않습니다.
