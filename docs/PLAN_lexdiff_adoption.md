# lexdiff 차용 구현 계획 (2026-06-11, 3시 세션용)

출처: https://github.com/chrisryugj/lexdiff 분석 결과 (BSL-1.1 — 코드 복사 금지, 아이디어만 독자 구현).
현재 버전 0.9.22 → 목표 0.10.0. 공통 원칙: **출력은 기본 압축, `full=true`로 확장. 외부 npm 의존성 추가 금지.**

## 구현 순서 (효과 큰 순, 각각 독립 커밋 가능)

### ① diff_article_versions — 단어단위 신구 diff (핵심)
- 신규 파일 `src/text-diff.ts` + index.ts에 도구 등록.
- 버전 해소: `get_law_article`의 기존 로직 재사용 (lawName/mst + 각 측 year 또는 efYd).
  파라미터: `jo`(필수), `hang?`, `lawName/mst`, `yearA`/`efYdA`, `yearB`/`efYdB`, `full?`.
- diff 알고리즘: 단어 단위 LCS 직접 구현(~80줄, 의존성 X). 토큰화 = 공백 + 문장부호 경계.
- **출력은 변경 hunk만**: `【삭제: …】【신설: …】` + 앞뒤 ±8단어 문맥. 전문 반환 금지(토큰 효율).
- `change_kind` 휴리스틱(결정적, LLM 위임 X): 
  - `cosmetic` = 문장부호·조사·괄호만 변경
  - `renumbering` = "제N호/제N항" 번호 패턴만 변경
  - `substantive` = 그 외
- 말미 가드 문구: "자동 단정 아님 — get_law_revision_text 개정문과 교차검증" 안내.
- 타임테이블 공리 ①·②(신구 문구 대조, 개정규정=문구단위)를 기계화하는 도구임을 description에 명시.

### ② 도구결과 HTTP 캐시 (in-memory LRU+TTL)
- index.ts의 중앙 fetch 헬퍼(NTS action.do 호출부 + 법제처 DRF 호출부)를 찾아 래핑.
- key = method+URL+body. LRU 200건.
- TTL: 법제처 DRF 24h / NTS 문서본문 12h / NTS 검색 1h (검색은 신규 유입 가능).
- 세션쿠키 캐시(index.ts:1295 부근)와 별개. 쿠키 갱신/재시도 경로는 캐시 우회.

### ③ MST 런타임 캐시
- lawName→MST 해소 함수에 Map 메모이즈(프로세스 수명). 몇 줄이면 끝.
- get_law_addenda / get_law_article / trace / timetable 모두 공유.

### ④ 체인 매크로 research_taxlaw_topic
- `query`, `targetYear`, `topK`(기본 2, 최대 3), `docType?`.
- 내부: search_taxlaw_documents → 상위 K건 get_taxlaw_document_text(full, targetYear) 1콜 합본.
- **full 본문 포함 강제**(요지≠결론 가드 유지), 건당 본문 길이 캡. year-check 분류 결과 동봉.
- 기존 내부 함수 재사용 — 새 API 경로 만들지 말 것.

### ⑤ 검색결과 staleness 플래그
- search_taxlaw_documents / search_taxlaw_all 결과 행 포맷터에서 생산일자 기준 N년 경과 시
  "⚠ 생산 N년 경과 — targetYear 검증 필수" 부착. year-check.ts의 recentThreshold 재사용.

## 마무리 체크리스트 — 2026-06-11 전부 완료 (v0.10.0)
- [x] package.json 0.10.0, docs/tools.md에 신규 도구 2종(①④) + 토큰·성능 메모 추가
- [x] `npm run build` + 기존·신규 170개 테스트 통과 (text-diff 9개 신규)
- [x] 실호출 스모크: ① 조특령 §23 diff 9 hunk(실질5/번호4), §26의8⑥ "변경 없음"(사용자 확정결론 '⑥ 미개정'과 일치하는 정확한 음성),
      ② 캐시 4,413ms→1ms·3,597ms→4ms, ⑤ 9년경과 플래그 출력 확인
- [x] 부수 수정: pickVersionInForce 공포일자 tie-break(분할시행 행이 후행 공포본을 가리는 기존 결함 — 5.22본 미선택 → 수정)
- [x] 추가 반영(리뷰): 검색 요지 700→450/근거 500→300, 판례 요약본 head+tail(결론부 보존)
- [ ] 사용자: MCP 재시작 필요 (재시작 전 v0.10.0 미적용)
