# Changelog

## [0.20.0] - 2026-07-06

해석례·심판례·판결 **원문링크 병기 강제** + **내장 고용공제 계산기 분리(SSOT 단일화)** + 다관점 적대 리뷰(CONFIRMED 9·PLAUSIBLE FIX 3) 반영 + 데드코드 정리. **MCP 재시작 필요.**

### Added — 원문 링크(환각 방지·출처 추적성)
- 해석례·심판례·판결 검색결과 각 행에 실제 NTS 원문 URL(`원문:`) 병기 — `search_taxlaw_documents`는 `refererForDoc(code,id)`, `search_taxlaw_all`은 collectionName 기반 `/qt`(해석례)·`/pd`(판례·결정례). API DOC_ID로 조립해 모델 URL 창작 차단. INSTRUCTIONS 5단 ③에 원문링크 병기 의무 명문화(임의 생성 금지). hometax 상담사례는 전용 도구 힌트 유지.
- `verify_nts_citations`(인용 직전 최종 게이트) 실존 확인행에도 원문 URL 부착 — verify 출력만으로 citation_table을 채울 때의 URL 창작 잔여경로 차단.
- 원문 URL id는 `normalizeDetailId`로 정규화(`001_` 접두 → canonical id) — 내부 조회 경로(`getTaxlawDocumentText`·`research_taxlaw_topic`)와 일치.

### Removed — 내장 고용공제 계산기 분리(신뢰경계 분리·SSOT 단일화)
- `compute_employment_credit`(고용증대 §29의7·통합고용 §29의8구법·사회보험료 §30의4)를 제거(`src/employment-credit.ts`·`test/employment-credit.test.js` 삭제). 배경: ①검색·검증 MCP에 '저자 산식 계산값' 혼입(신뢰경계) ②단가 하드코딩 stale ③로컬 Python SSOT 1:1 포팅이라 이중 구현 drift ④쉬운 케이스만 자동화(신법 통합고용 2026+·COVID fy+3·§30의4 forward는 manual) ⑤단가전환·적용순서·§144 이월 등 텍스트 트랩 미반영.
- 계산 로직은 전용 SSOT(`Downloads\TAX\고용증대세액공제_계산기\` Python)에 생존 — capability 손실 없음. `call_taxlaw_extra(name="compute_employment_credit")` 호출은 계산 대신 **라우터 응답**(전용 계산기 경로 + 조문 확인 도구 + 트랩 경고). HIDDEN 유지로 게이트 도달.
- 데드코드 정리: 미사용 import(`type BasicRulingRef`·`TAX_LAW_CODE_MAP`)·상수(`TAX_LAW_HEAD`)·함수(`yearsBetween`) 제거. (ts-prune 오탐 `formatLawArticleRef`는 test 커버 → 보존.)

### Fixed — 다관점 적대 리뷰 반영(능동게이트 정밀도·성능)
- 명제결박 polarity: `propositionFit`이 순수 토큰겹침이라 '…아니다' vs '…이다' 미구분(정반대 판시도 100% 통과) → 라벨 `[명제 결박(토큰겹침)]` 약화 + 부정형 주장이면 주문 방향 full 확인 강제.
- 인용 추출: '감심 제2023-56호'(공백+제…호) 침묵누락(추출 패턴 확장)·감심/심사 이중분류(쟁송 접두어 skip) 수정.
- `propTokens` JOSA 과절삭: '제도·결과·효과·평가·증가' 등 조사 동형 종성 명사 보존(어간 잔여≥2) — 극단선 `toks=[]`→`propositionFit=1`(무조건 통과) blind spot 해소.
- 성능: `fetchEflawMsts` 캐시키 정렬(display 20→40)·`prepareMergedAddenda` 부칙 XML 병렬·`get_law_article` 가드 버전목록+조문 XML 병렬·`research_taxlaw_topic` 복합어 분해 retry·검색 행별 `전문:` 스캐폴딩 헤더 1줄 통합.
- `VERSION` 상수를 package.json과 일치(서버 보고 버전·User-Agent 추적성).

### CI / Test
- test 스크립트 하드코딩 목록 가드(`test/meta.test.js`) — 나열 파일 ≡ 실제 `test/*.test.js` 강제(파일 추가/삭제 시 조용한 미실행·Node 20 하드에러 방지). glob 전환은 Node 20/24 × 크로스플랫폼 비호환이라 명시 목록 유지. 테스트 214 통과.

### 리뷰 방법
- Claude 멀티에이전트 적대검증(6관점 × 발견별 반증): CONFIRMED 9 · PLAUSIBLE FIX 3 · DEFER 2(#6 tail-latency 전역예산) · SKIP 3(overclaim=라벨약화로 해소·COMPANION 칩=의도된 ACTIVE 게이트·인젝션 델리미터=권위출처 가치 훼손). Codex 교차검증은 Windows 샌드박스 장애(CreateProcessAsUserW 1312)로 불가. ⚠ 네트워크 fetch 동시성(부칙·조문 병렬)은 컴파일+정적추론 검증(라이브 미검증) — 재시작 후 스모크 권장.

## [0.19.0] - 2026-06-23

classify_credit_eligibility에 **소기업 매출한도(별표3)** 추가 — 중특감 감면율(소기업 10/20/30% vs 중기업 5/15%)을 빠르게 판정. **MCP 재시작 필요.**

### Added — 소기업 매출한도 도출
- `sogiupThreshold(ksic)`: KSIC 대분류(l1)·중분류(l2)로 중기본법 시행령 [별표3](2025.10.1) 소기업 매출한도 도출. C는 중분류(C19/C24=140·C10등=120·C12등=80·C34=15억), E는 E36(수도 120)/E(40), S=15억, 그 외 대분류. l2 strip 저장 → 2자리 복원.
- `classify_credit_eligibility` 출력에 소기업 한도 1줄 추가: "소기업 매출한도(별표3 기호 X): N억원 — ≤한도면 소기업". 업종코드 1콜로 적격 호/목 + 소기업 한도까지 → 중특감 감면율 즉시 판정. (leading-zero 업종은 strip형으로 KSIC 조회.)
- 사용자 「창중감,중특감 판정기」 xlsx 검증 완료(랜덤+함정 40건 전건 일치, 별표3 자동산출 가동) 후 동일 로직을 MCP에 반영.
- 테스트 +1(227 통과): 922202→S 15억·011000→A 80억·C26 120억·E36 120억 등.

## [0.18.0] - 2026-06-23

창중감/중특감 전수 정확도 감사 결과 반영 — credit-eligibility 데이터 교정 + 연도 경고. **MCP 재시작 필요.**

### Changed — classify_credit_eligibility 연도 경고 + 교정 데이터
- `classify_credit_eligibility` 출력에 **★연도주의 경고** 추가: 표=2024 귀속 기준 — §6 창중감 2026.1.1 창업 감면율 4구간 개편·창업기한 2027 연장·5억 한도(2024.12.31 신설), §7 중특감 일몰 2028 연장·2026 목 글자 이동(수소발전 '두목' 신설→보안·임업·통관·자동차임대 이동)·일반서적출판 중기업10% 마목 신설 → 2025·2026 귀속·창업은 해당연도 본문 직접 확인. 농축수산임·발전업 비과세/전액면제/등록 단서 추가.
- `src/data/credit-eligibility.json` **교정 반영(116건)**: 사용자 「창중감,중특감 판정기」 연계표 정확도 감사(46목 전수, 워크플로 도출+적대검증) → 허(의료업) 사회복지·유사의료 오태그 −21·소(장기요양) 목재제조 −5·비철금속광업 등 교차오염·농축수산임 +30·자동차전문정비업(922202) 터 삭제 등. 별도검토 5건(엔티티 등록)·연도 변동(2026 목 이동)은 미반영.
- 회귀 테스트 갱신: 922202 중특감 비적격(교정 반영) 가드. 전체 226 통과.
- ⚠ 표는 여전히 2024 기준·provisional — 데이터 권위원천은 사용자 xlsx(SSOT).

## [0.17.0] - 2026-06-23

창중감(§6③)·중특감(§7①1호) **업종 적격 판정 도구 신설**(노출) + statute 검색 결과 **조번호·조제목 노출**. additive·하위호환. **MCP 재시작 필요.**

### Added — `classify_credit_eligibility(업종코드)` 노출 도구 (창중감/중특감 업종 적격)
- 배경: 임베드된 표준산업분류표(`upjong-ksic.json`)는 ①업종 도구가 HIDDEN(call_taxlaw_extra 게이트)이라 사실상 미호출 ②순수 KSIC 크로스워크로 §6/§7 적격 플래그 0개 ③`classify_industry_for_article`은 호출자가 업종명을 넣어야 하는 범용 매칭기 ④§6/§7 조문과 무연결 — 즉 창중감/중특감 판정엔 미사용. (922202 자동차전문정비업을 §7 자동차정비공장으로 오판하는 실수의 온상)
- `classify_credit_eligibility(code)`: 업종코드→창중감(§6③ 호)·중특감(§7①1호 호/목) 적격을 한 번에 반환. **메인 목록 노출**(숨김 ❌). 단서업종(자동차정비공장=종합·소형종합정비업만[조특칙§22]·의료업 요건·부동산임대/소비성서비스 배제) 재확인 ⚠ 동봉. provisional(미검증) 명시.
- 데이터 `src/data/credit-eligibility.json`: **SSOT=「창중감,중특감 판정기.xlsx [연계표]」** → `build_mcp_credit_data.py`(판정기 폴더)로 파생. 연계표 D=업종코드/B=6조3항 호/AC=창중감 비고/AE=7조1항 호/AF=중특감 비고를 충실 전사(업종코드 1611건). ⚠ 연계표 §6③/§7① 매핑 정확도 재검토 진행 중 — 현재 값은 미검증.
- `getLawArticle`: 조특법(법률) **제6조·제7조** 회수 시 `classify_credit_eligibility` 능동 라우팅 힌트 부착(시행령/시행규칙 같은 조번호는 제외). 신규 export: `classifyCreditEligibility`/`normalizeUpjongCode6`/`buildCreditEligibilityHint`. 단위테스트 4건.

### Fixed — statute 행 제목이 조번호·조제목을 버리던 문제 (실측 회귀)
- 실측: "자동차정비공장 공장의 범위 조세특례제한법 시행규칙" statute 검색 시 raw 행에 `TEXT_UQNM="제22조"`·`TEXT_KRN_NM="자동차정비공장의 범위"`가 있으나, `formatIntegratedTitle`이 `NM`(법령명 "조세특례제한법 시행규칙")을 firstValue로 먼저 잡아 둘 다 버림 → 결과만으로 조 위치를 알 수 없어 조번호 더듬기 유발.
- `statuteArticleSuffix(row)`(pure, export) 신설: LBL1이 `법령` 계열인 행에 한해 `제N조(조제목)`를 추출(통칙형 `2-1-3`·해석례·판례·별표는 제외, `<!HS>` 마커 제거). `formatIntegratedRow` 제목에 결합 → `[id] 조세특례제한법 시행규칙 제22조(자동차정비공장의 범위)`.
- 라이브 검증: BEFORE `조세특례제한법 시행규칙` → AFTER `조세특례제한법 시행규칙 제22조(자동차정비공장의 범위)`. 단위테스트 7건 추가(0.17.0 합산 전체 225 통과).

## [0.16.1] - 2026-06-18

Codex GPT-5.5(최고수준) v0.14~0.16 재대조 반영. P0 없음 — 소규모 견고화. **MCP 재시작 필요.**
- redactSecrets: `gi` 플래그 → 대소문자(Oc/oC)·URL인코딩(`%4F%43`) 변형까지 OC 마스킹.
- propositionFit(G1): 초고빈도 비핵심 토큰(여부·해당·관련·적용 등) + 순수숫자 제외 → 명제 매칭 false negative 완화.
- verify claims: 인용당 선형탐색 → 정규화 키 Map(대량 입력 성능).
- G2 제목-only 판정: bodyHay에 CNTN·FILE_CN 추가 → 본문 보유 문서 오강등 방지.
- G9 citationBound 칩: `verbose=false`(트리아지/헬스체크)에선 억제(토큰 절감).
- G10 적용시기 가드: 키워드를 고위험(공제율·단가·상시근로자·사후관리·추징·최초공제·감면율)으로 협소화 → 단순 현행조문 조회 과발동 방지.

## [0.16.0] - 2026-06-18

3관점+보안 리뷰 로드맵 additive ACTIVE 게이트 2차 배치(G3·G4·G9·G10) — 모두 신호 추가형·하위호환. 사용자 반복 피드백을 호출시점 능동 신호로 계속 전환. **MCP 재시작 필요.**

### Added — 요지↔주문 결과 불일치 능동 검사 (G3, 피드백 요지≠holding)
- `classifyVerdict()`(pure) 신설 + `detectHoldingTruncation`을 **full=true에도** 발동: 요지(gist) 결론어와 주문(결론부) 결과가 '달라 보이면'만 `⚠⚠ 요지·주문 결과 불일치` (모순 신호 없으면 full 응답은 깨끗 — 평시 노이즈 0). full을 받고도 요지만 읽는 위험 구간 차단. 단위테스트.

### Added — 검색 '쟁점일치' 축 (G4, 피드백 검색근거≠쟁점)
- `formatDocumentSearchItem`: query가 본문(발췌·검색근거)에는 매칭되나 제목·요지(쟁점)에는 약하면 `⚠ 본문어 매칭O·쟁점(제목/요지)X — 같은 단어 다른 쟁점 의심` 태그. judgeRelevance가 토큰겹침만 보던 사각 보강.

### Added — citationBound 인용게이트 칩 (G9, 메타테마)
- 검색 응답 헤더에 결과시점 ACTIVE 1줄: 결론·분류 인용 절차(쟁점 확인→full 주문·판단 대조→korean-law 동반→verify_nts_citations(claims) 게이트, 티어 금지). INSTRUCTIONS/COMPANION_NOTICE의 PASSIVE 라우팅을 검색→인용 실패경로에 직접 들이밂(토큰효율 위해 1줄).

### Added — get_law_article 적용시기 미결박 가드 (G10, 피드백 부칙 우선)
- `buildApplicationTimingGuard()`(pure): 단가·공제율·사후관리·상시근로자·추징 등 귀속연도 의존 조문을 year/efYd 앵커 없이 회수하면 `⚠ 적용시기 미결박 → build_application_timetable(부칙·경과조치 결박)` 강제 안내(다년 사이클은 최초공제연도 질문). 단위테스트.

테스트 214/214.

## [0.15.0] - 2026-06-17

3관점(효과성·토큰·시간) + 보안 리뷰(Claude 7-에이전트 적대 워크플로 + 직접 보안 정독, Codex GPT-5.5 병행) 반영. ★핵심 메타테마 — "수동적 권고문(description·INSTRUCTIONS)은 반복 무시되어 실패 → 인용 1건 쓰는 그 호출에서 기계적으로 발동되는 ACTIVE 게이트로 전환". 이번 세션 오인용 사고(사용료 사건을 §48 공동경비 배부 근거로 오귀속, 제목≠본문) 직격. **MCP 재시작 필요.**

### Added — verify_nts_citations 명제 결박 ACTIVE 게이트 (G1)
- 스키마에 `claims:[{citation, proposition, basis:'direct'|'inference'}]` 추가. 제출 시 각 인용의 **주장 핵심어가 문서 본문/요지에 실제 등장하는지** 매칭률로 ACTIVE 검사: <40%면 `⚠⚠ [명제 불일치 의심] 오귀속 의심 — full 본문 대조 필수`, 결박 시 매칭%+`[직접근거]/[추론]` 라벨. claims 미제출 시 `ℹ` 안내(하위호환, 실존만). 요약에 `⚠명제불일치/⚠명제미결박` 카운트. pure 함수 `propTokens`/`propositionFit`(단위테스트). "실존≠명제적합" PASSIVE 한 줄을 통과조건으로 승격.

### Added — verify confirmed 제목-only 강등 (G2)
- 번호가 제목(TTL)에만 매칭되고 본문(문서번호·요지)에 없으면 `△ 제목≠본문(이의-부산청 류) 가능 — full로 사건 동일성 확인` 강등 태그(실존✓은 유지). 요약에 `△제목만매칭` 카운트. NTS 제목↔본문 불일치(데이터 이상) 자동 노출.

### Security — OC(법제처 API키) 출력 redaction 방어심층
- `redactSecrets()`를 모든 `textResponse` 출력에 적용 → `?OC=…`/`&oc=…`를 `***`로 마스킹. 현재 누출 경로는 없으나(에러는 label만, fetchWithRetry는 err.message만) DRF URL이 미래에 출력/에러에 섞여도 키 보호. 직접 보안 리뷰 결론: SSRF는 `normalizeTaxlawPath`(시작 `/` 강제+`//`·`://` 차단·호스트 고정)로 견고, ReDoS는 bounded 정규식으로 낮음, ledger append는 env경로·try/catch — Critical/High 없음.

### 로드맵(승인/추가 예정)
- additive 다음 배치: G3(detectHoldingTruncation을 full=true에도—요지↔주문 모순), G4(검색 쟁점일치 축+티어금지 헤더), G9(citationBound 동반호출 ACTIVE칩), G10(get_law_article 적용시기 미결박 가드), 간접 프롬프트 인젝션 delimiter.
- 기본동작 변경(사용자 승인 필요): G5(검색 verbose triage 기본), G7(research_taxlaw_topic verify 인라인), G8(precedent full 자동승격).

## [0.14.0] - 2026-06-17

인용 검증 백스톱 강화 + '능동 게이트' 기반(L1 원장). 계기: 오인용 사고 — 하이픈형 심판례 번호(조심-2024-인-2328)가 verify_nts_citations 추출 정규식(`\s?`만 허용)에 안 잡혀 침묵 누락 → "4건 중 4건 검증" 거짓안심. 근본은 에이전트가 보조 인용을 full 본문 없이 검색근거 스니펫으로 인용한 규율 실패(수동 규율의 반복 한계)이고, 본 릴리스는 그 백스톱(MCP)과 능동 게이트 기반을 보강한다. **MCP 재시작 필요.**

### Fixed — `extractNtsCitations` (P1)
- 심판·심사 번호 구분자 `\s?`→`[\s-]?`로 통일 → **하이픈형 조심/국심**(조심-2024-서-5990) 추출. **이의신청 지방청 패턴**(이의-부산청-2024-0108) 신규. 감심/심사도 하이픈 허용. (`test/utils.test.js` P1 케이스)

### Added — `findUnparsedCitationTokens` (P2, 침묵 누락 가시화)
- 정밀 추출이 놓친 '인용처럼 보이는' 토큰을 광의 패턴으로 검출 → verify 출력에 `⚠ 추출 실패(미인식 패턴) N건` + 요약에 `⚠추출실패`. "검출 N건 중 N건"의 거짓안심 제거(포맷 불문 안전망). 추출된 토큰은 정규화 포함관계로 제외.

### Added — verify_nts_citations 메타 echo (P3+P5) + 검증 원장 (L1)
- ✓ 확인 줄에 **제목·요지·결정구분·세목 + 관련법령**(상세 1콜 보강) 병기 + "⚠ 실존≠명제적합, full 본문 대조" 강제 줄 → 2328류 royalty 사건이 게이트에서 눈앞에 드러나 자가적발 보조.
- **L1 원장**: 검증결과를 `~/.taxlaw-nts-citation-ledger.jsonl`(env `TAXLAW_CITATION_LEDGER`)에 적재(raw·normalized·exists·title·gist·decision·relatedLaws·id·ts). 외부 빌드게이트(L2 `verify_citations.py`)가 "검증 실행 여부"를 대조하는 근거. 기록 실패는 검증을 막지 않음.

### Changed — search_taxlaw_documents 설명 (P4)
- "'검색근거' 스니펫=질의어 매칭 단편, 사건 실제 쟁점(제목·요지·관련법령)과 다를 수 있음 — 보조·예시 인용도 핵심과 동일 검증 바, 결론·분류는 full=true" 명문화.

### 능동 게이트(외부, MCP 밖)
- L2 빌드게이트 `Downloads\TAX\한의_관계도\verify_citations.py`(+test): 산출물 인용 전수추출 ↔ 원장 대조, 미검증(원장 부재)=빌드 실패(exit 1), 실존=제목·결정·관련법령 노출(명제 재대조), NTS 미발견=WARN(≠미존재).
- L3 살리언스 훅 `~/.claude/hooks/citation_gate.py`(settings.json UserPromptSubmit): 법령·세무 인용 작업 시 '인용 게이트' 규율(핵심/보조 티어 금지·full 본문·verify) 자동 주입.

## [0.13.0] - 2026-06-15

고용 세액공제 '단일 출처' 계산 엔진 내장 — forward 공제 ↔ 추징식을 LLM이 따로 도출하다 모순 내는 오류의 구조적 차단(도구가 계산, 손계산 금지). 다단계 적대적 리뷰(정확성 14건·설계 3축·전체 산출물 8건)를 반영해 포팅.

### Added — `compute_employment_credit` (HIDDEN, `src/employment-credit.ts`)
- 고용증대(§29의7)·통합고용(§29의8 구법=2024·2025귀속)·중소기업 사회보험료(§30의4) + COVID 특례(§29의7⑤⑥⑦) forward 공제 + 추징 산정. 로컬 Python SSOT(`Downloads\TAX\고용증대세액공제_계산기\`)의 1:1 포팅 — `test/employment-credit.test.js` 16블록이 Python 자체테스트·검증배터리와 골든 패리티(동일 숫자).
- **설계(design-tradeoff 리뷰 D안)**: tools/list 비노출(HIDDEN_TOOL_NAMES) → `call_taxlaw_extra(name="compute_employment_credit")` 경유(상주 토큰 0, v0.12.0 토큰규율 정렬). 게이트웨이 description에 발견성 1줄. 계산 핸들러 try/catch 격리(검색 가용성 보호).
- **stale·오인 방지**: 출력 헤더에 "저자 산식 기반 계산값 — 1차 근거 아님" 강제('검증' 단어 금지), 사용 단가·기준 시행일 동봉. 통합고용 2026 귀속~ 신법(직전3년·단년·A+B+C 구간식)은 NOT_SUPPORTED → build_application_timetable 라우팅. 사회보험료 만원급 입력(원/만원 혼동) 거부. first_year(차수) 필수.
- **법령 정합(리뷰 반영)**: ① 추징 청년감소 한도 = max(0,dYouth)(절사 전, §26의7⑤/§26의8④/§27의4⑪ 한도 단서) — forward 제1호 인원 n1=clamp(dYouth,0,dTotal)(§…①제1호 전체증가 절사)과 별개 상수 분리(dYouth>dTotal 과소추징 버그 차단). ② 3차 한도=직전2년 공제세액 합계(제1호 추징분은 산식값에만 차감). ③ COVID 게이트 fy∈{2018,2019}+⑤(2020감소)·⑥(2021회복) 데이터 게이트(무감소 유령 4차 forward 차단), fy+3 추징은 시행령 미규정 → 수동. ④ 전체유지·청년감소 잔여연도=전체 증가인원 전부 제2호 단가(기재부 조특제도과-215).

### Fixed
- `VERSION` 상수가 0.12.1로 잔존(0.12.2 커밋 시 package.json만 갱신)했던 것 → 0.13.0으로 정정.

### Tested
- `test/employment-credit.test.js` 16블록(고용증대·통합고용·사회보험료·COVID·신법 hardgate·단위가드·입력검증·HIDDEN 노출). 전체 205건 통과.

## [0.12.2] - 2026-06-14

세액공제 사후관리 조문의 '문언 단정' 오류 능동 가드 추가(실측 사고 재발방지).

### Added — `get_law_article` 해석 분기 가드 (`src/index.ts`)
배경: 조특법 §29의7②("청년 감소 → 제1항제1호를 적용하지 아니한다")를 문언 그대로 "제2호=원래 청년외 증가분만 공제"로 오독한 실측 사고(2026-06-14). 정답은 **당초 청년 증가분까지 전체 증가인원 전부를 제2호(일반)단가로** 공제(기재부 조특제도과-215·서면-2023-법인-0978). 손에 든 추징식(시행령 §26의7⑤ = 감소인원 × (상위호−하위호) = '프리미엄만 환수')과 forward 공제식의 정합성만 대조했어도 잡혔을 오류.
- `buildInterpretiveForkGuard(text, jo)` (순수함수, export): 본문에 "적용하지 아니(한다/하고/하며)" + (제N호|제N항) + "공제" + (감소|추징|사후관리)가 동시에 있으면 ⚠ 가드 부착. "제N호 미적용 = 공제 소멸이 아니라 단가 전환일 수 있음(삭제 vs 단가전환 = 해석 분기점)"을 명시하고 ①해석례 확정(검색 실패≠해석 부재) ②추징식 정합성 교차검증 ③제도취지 스트레스테스트를 강제. 추징 산식 본문(시행령, "적용하지 아니" 없음)에는 미발화 — 1차 진입점인 법 조문에서만 발화하도록 절제.
- `getLawArticle`가 후행개정 가드 직후 본문 앞에 주입(혼재 없이 별도 블록).

### Tested
- `test/utils.test.js` +4블록(발화/무관조문 미발화/추징식본문 미발화/빈본문). 전체 통과.

## [0.12.1] - 2026-06-14

코드 리뷰 피드백 반영(기능 변경 없음 — 성능·테스트·라이선스 명료성).

### Changed
- **`verifyNtsCitations` 병렬화**(`src/index.ts`): 인용별 순차 `for await`(N건=N회 직렬 왕복)를 동시성 상한 4의 청크 병렬로 전환. 출력 순서는 인덱스 보존으로 동일. NTS API 과부하 방지로 상한 절제. 라이브 재확인(순서보존·✓3/✗1/통칙1 동일).
- **`classifyAgainstCurrent` 순수 함수 추출**: `getLawArticle`의 현행본 대조 verdict 분기(same/differs/missing+삭제일/hasFormulaImages)를 네트워크와 분리해 단위 테스트 가능화. 호출부는 fetch 후 이 함수만 호출.
- **`text-diff.ts` 라이선스 disclaimer 복원**: "자체 구현" → "독자 구현(의존성 0, lexdiff 등 BSL-1.1 라이선스 코드 미참조)" — v0.11.0에서 의도치 않게 제거됐던 비참조 명시 복구.

### Tested
- `test/utils.test.js` 신규 1블록(classifyAgainstCurrent same/differs/deleted/missing). 전체 185건 통과.

## [0.12.0] - 2026-06-12

두 세법 MCP 동시사용 리뷰(토큰효율·효과성, 8세션 정량 마이닝+라이브 A/B+효과성 감사)의 권고 반영.

### Added — `verify_nts_citations` 인용 실존 일괄 검증 (`src/index.ts`)
배경: 기존 검증기 간극 — korean-law verify_citations는 법령 조문만, cite_check는 법원 판례만 커버. "서면-NNNN"·"조심20XX..."류 해석례·심판례 번호는 어떤 검증기도 패턴 매칭조차 안 해 날조 번호가 /tb verify 게이트를 통과 가능(효과성 감사 벡터⑦, HIGH).
- `extractNtsCitations()` (순수함수, export): 해석례 신형(서면-2024-법규부가-4804)/구형(부가46015-2833)/부서형(서면법규과-1284, '결과-12' 류 일반어 오탐 차단)·심판례(조심/국심/감심/심사)·법원 사건번호(두/누/구합/헌바 등)·기본통칙 번호 추출+dedup.
- `verifyNtsCitations(text, maxCitations=12)`: 번호별 NTS 검색(question+precedent 그룹 병렬)→문서번호·회신번호·제목 정규화 매칭 → ✓ 실존(제목·생산일자·ID) / ✗ 공개DB 미발견(⚠ 미존재 단정 금지 — "공개DB 미발견"까지만 기재, 법원 건은 korean-law 병행 안내) / 기본통칙은 현행번호 확인 경로 안내. 헤더에 "실존 확인 ≠ 명제 적합성" 경고 고정.

### Changed — 토큰 효율 (리뷰 절감 레버 반영)
- **저빈도 도구 15종 tools/list 비노출**(세션 고정 ~6.9K chars 절감): 업종코드·KSIC 7종 + 별칭 2종(search_taxlaw_interpretations·get_taxlaw_interpretation_text) + 홈택스상담·발간책자 2종·사이트 3종·call_taxlaw_action. 신설 게이트웨이 `call_taxlaw_extra(name, args)`로 전부 호출 가능(HIDDEN_TOOL_NAMES). env `TAXLAW_EXPOSE_ALL=1`로 전체 노출 복원.
- **search_taxlaw_documents 기본 display 20→10**(검색콜당 ~4.3K chars 절감, 건당 평균 ~480자 실측). 필요 시 display 명시.
- **INSTRUCTIONS 치명도순 재배치+압축**(3,707→약 2,900 chars): 호스트가 ~2,000자 부근에서 절단하는 실측에 따라 [강제 절차](후행개정·연도검증·기본통칙·행정규칙 stale·NOT_FOUND·인용 실존) 6항을 서두로, 5단 응답 포맷·워크플로를 후미로. NOT_FOUND 항에 "판례·심판례 미발견≠미존재(공개DB 미발견까지만)" 명문화, 서두에 "계산식 조문은 korean-law 단독 인용 금지(수식 무언 누락 실측)" 분담 명시.
- **현행본 응답의 공포-미시행 신호 1줄 압축**(콜당 ~390 chars 절감): isCurrent면 최단 시행분 1건+확인 경로만. 구버전 조회(!isCurrent)는 기존 상세 유지.

### Tested
- `test/utils.test.js`: extractNtsCitations 신규 1블록(신형/구형/부서형/심판/법원/통칙/dedup/오탐 차단) + pending 압축 반영. 전체 통과.
- 라이브: verify_nts_citations(실존 4건+미수록 1건 혼합), call_taxlaw_extra(lookup_upjong_code), display 기본 10, visibleTools 15종 제외 확인.

## [0.11.0] - 2026-06-12

### Added — `get_law_article` 후행 개정 능동 가드 (`src/index.ts`)
배경(사용자 실측, 통합고용 조서): get_law_article(조특법 §29의8, year=2025)가 구법(MST 279739, 시행 2025.11.11)을 반환하면서 말미 '최근 시행본' 목록에 신법(MST 286597, 시행 2026.6.2)을 **수동 나열만** 했고, "이 조문이 후행 개정본에서 변경·삭제됐다"는 조문 단위 능동 신호가 없었다. 호출자는 신법을 조회하지 않은 채 "신법 사후관리 규정은 별도 확인 필요" hedge로 도피 → §29의8③ 삭제<2025.12.23>(신법 사이클 추징 없음) 사실이 산출물에서 누락. 사후 검증 비용은 단 1콜(약 1.5초)이었다 — 수동 목록 나열은 hedge 도피를 막지 못한다는 교훈의 구현.
- `buildLaterRevisionGuard()` (순수함수, export): eflaw 버전 목록 + 조회본 MST + 오늘 날짜로 ① 조회본이 현행본이 아니면 "── 후행 개정 확인 (조문 단위) ──" 경고 블록 생성(현행 MST·공포일 명기 + 다음 행동을 도구·파라미터로 직접 지시) ② 공포됐으나 미시행(시행예정) 개정 존재 시 별도 경고(시행일 | MST 목록).
- 조문 단위 자동 대조: 조회본 ≠ 현행본이면 현행본 XML(fetchMolegXml 24h 캐시 공유)에서 같은 조문을 추출해 공백 무시 비교 → `differs`(변경 — diff_article_versions 지시) / `missing`(삭제·이동 가능) / `same`(변경 없음의 적극 신호) / `unknown`(대조 실패 — 직접 확인 지시) 4분기. soft-fail: 대조 실패해도 본 응답 정상.
- mst 직접 지정 호출도 lawName이 있으면 가드용 버전 목록을 try/catch로 회수(실패 시 가드만 생략).
- 서버 INSTRUCTIONS에 "[구버전 조문 현행성 — 후행 개정 강제 절차]" 신설(+서두 1줄 포인터 — 클라이언트 truncation 대비): 경고 블록 무시 금지 + "확인 비용은 1콜 — '별도 확인 필요' hedge로 결론 대체 금지". 도구 description에도 동일 명시(응답 데이터 레이어 + 행동 레이어 이중화, ADMIN_RULE_STALE_NOTICE 패턴).
- `todayYmd()` export(로컬 시간 YYYYMMDD), `getLawArticle` export(라이브 검증용).

### Fixed — 적대적 리뷰(3렌즈: 정합성·회귀·행동유도력) 검출분 동일 릴리스 반영
- **교차법령 오염(라이브 실증)**: eflaw lawSearch는 이름이 '포함'된 모든 법령(시행령 등)을 반환 — 이력이 적은 법령은 타법 행이 섞여 시행령을 '현행본'으로 오판, 거짓 "변경됨" 경고(실증: 가상자산법 §10 ↔ 시행령). → fetchEflawVersions를 행(law 요소) 단위 파싱으로 전환(3-pass index-zip 위험 제거)해 `법령명한글` 캡처, `filterVersionsByName`(공백 무시 정확 일치, 0건이면 원본 보존)으로 efYd 해소·가드·푸터 모두 자기 법령 행만 사용. 가드용 목록은 응답 XML의 공식 법령명 기준 + 비었으면 재회수 — **mst 단독 호출도 가드 부착**(무음 생략='현행' 오독 방지).
- **삭제 조문 부칙 garbage 대조(라이브 실증)**: `indexOf('<![CDATA[제N조(')`가 부칙내용의 bare CDATA(제목형 시작 1,293개 실측)에 오매칭 + `</조문단위>` 미발견(-1) 무가드 → 삭제 조문이 부칙 39만자와 대조되어 differs 오판. → `findArticleInXml()` 신설: `<조문내용>` 앵커 regex(공백 변형 허용)로 부칙 배제, '제N조 삭제 <날짜>' 형태를 deleted로 적극 보고(본 응답 경로도 "삭제된 조문입니다" 메시지로 개선 — 0.9.18부터 잠복하던 garbage 본문 반환 해소).
- **pending(시행예정) 목록 과대·구버전 유도**: (MST×시행일) 행이 옛 공포본까지 보존돼 8건 과대 보고 + superseded MST 확인 유도. → 시행일별 최신 공포본만 dedup(8→4건), 각 행에 공포일 병기, 자기모순 지시 'efYd=시행일' 제거(promDate tie-break상 분할시행 미래 행은 efYd로 도달 불가), diff_article_versions 확인 경로로 교체.
- **diff_article_versions 파라미터 오기**: 가드가 존재하지 않는 mst1/mst2를 지시(실제 스키마 mstA/mstB, additionalProperties:false) — '1콜 확인'이 첫 시도에 반드시 실패. → mstA/mstB로 정정 + 회귀 테스트(mst1/mst2 부재 assert).
- **윈도우 밖 year 무음 fallback(라이브 실증)**: year=2018처럼 40행 윈도우보다 과거면 경고 없이 현행본 반환 — '가드 침묵=요청 시점본' 역방향 오독. → pickNote에 "⚠ … 윈도우에서 찾지 못해 현행본을 반환 — 요청 시점 텍스트 아님" 강제 삽입(NOT_FOUND 경로 포함).
- **시행예정본 의도 조회 방향 역전**: 미래본 조회에 '구버전' 프레임 경고가 붙던 분기 → ℹ "시행일 이후 귀속연도에는 이 본문을 적용" 안내로 교체.
- **alarm fatigue 완화**: 헤더에서 '(조문 단위)' 과잉 주장 제거, verdict 줄 [조문 단위]·pending 줄 [법령 단위 신호 — 이 조문과 무관할 수 있음] 라벨 분리, 현행본 조회 시 pending은 ⚠→ℹ. missing 분기에 1콜 확정 경로 추가(금지+무경로 조합이 hedge를 유발하는 패턴 차단). same+수식 이미지 시 "수식 내용은 대조 범위 밖" 단서. INSTRUCTIONS 앵커 문구를 응답 verbatim과 정렬 + "대조에 실패" 4호 추가.
- **VERSION 상수 0.10.1→0.11.0 동기화**(serverInfo·User-Agent 자기보고).

### Tested
- `test/utils.test.js` 신규 10블록(무경고/실측 사고 재현(differs·mstA/mstB)/missing·deleted·same·unknown/ℹ pending·dedup·efYd 지시 제거/시행예정본 의도 조회/filterVersionsByName 교차법령/findArticleInXml 부칙 오매칭·삭제/normalizeArticleForCompare flSeq/todayYmd) — 전체 183건 통과.
- 라이브 7케이스: ① §29의8 year=2025 → differs+mstA/mstB ② 현행 → ℹ pending 4건 ③ §1 무변경 → same ④ 가상자산법 mst 지정 → 거짓 경고 없음 ⑤ §9 현행 → "삭제된 조문(삭제 <2019.12.31>)" ⑥ §9 year=2018 → fallback ⚠ 명시 ⑦ mst 단독 → 가드 부착.

## [0.10.1] - 2026-06-11

### Fixed — `diff_article_versions` hang(항 지정) 거짓 '변경 없음' (`src/index.ts`)
배경(사용자 실측): 통합고용세액공제 3개년 리뷰에서 hang 지정 diff 4건(조특령 §26의8 제2·3·6항, §11의2 제8항)이 전부 "✅ 변경 없음"을 반환 — 같은 MST쌍의 조 단위 diff는 실질 hunk 다수. "변경 없음=무개정 적극 신호" 안내와 결합하면 무개정 오판을 적극 유도하는 거짓 음성.
- 원인: DRF 조문 직렬화가 항번호+항내용 CDATA 결합으로 항 마커를 "⑥⑥"처럼 중복 출력하는데, `sliceHangBlock`이 첫 마커 직후의 다음 원문자(=두 번째 "⑥")에서 즉시 절단 → 블록이 "⑥" 1자 → 양쪽 동일 → identical 판정(found=true라 경고도 없음).
- 수정: 선두 마커 연속 구간을 건너뛴 뒤 다음 항 마커를 탐색. 단일 마커 본문은 종전 동작 유지. `sliceHangBlock` export(회귀 테스트용).

### Tested
- `test/timetable.test.js` 신규 3건(중복 마커 회귀 / 단일 마커 호환 / 미존재 항 found=false+전체 유지). `npm test` 전체 173건 통과.
- 라이브: §26의8 hang=제6항(2025↔2026.2.27) → "변경 없음"(버그) 대신 실질 hunk 1건(총량식→제11조의2제8항 준용) / §11의2 hang=제8항(2.27↔5.22) → ⑧ 범위 hunk 7건(절사위치 "수(…)의 합"→"수의 합(…)") — 조 단위 결과와 정합.

## [0.9.22] - 2026-06-11

### Added — 개정문(개정 지시문 원문) 조회 `get_law_revision_text` (`src/index.ts`)
v0.9.21의 잔여 한계 마감(사용자 요청): `[부칙개정⚠]` 플래그는 부칙이 후행 개정령에 의해 변경됐음을 알리지만, **고치는 지시문 자체**("대통령령 제36127호 … 부칙 제11조제1항 중 '…'를 '…'으로 한다")는 부칙단위가 아니라 법령 XML 끝의 `<개정문>` 노드(개정문내용 CDATA)에만 있어 어느 도구로도 회수되지 않았다.
- **`parseLawRevisionText`**: `<개정문>`(없으면 `<제정문>` fallback) CDATA 추출 — 리터럴 꺾쇠·수식 img 마커는 `extractCdataText` 재사용.
- **`fetchEflawVersionsDetailed` + `pickVersionByPromulgation`**: 개정문은 '그 공포번호 시행본'의 XML에만 있으므로, eflaw 검색에서 (MST·공포번호·공포일자·시행일자)를 항목별 회수해 promulgationNo/promulgationDate로 시행본 자동 해소(같은 공포번호의 시행일 분할 항목은 개정문 동일 → 첫 항목). `normalizeYmdInput`("2026.5.22"→"20260522" zero-pad — 플래그가 주는 날짜 표기 그대로 입력 가능).
- **`getLawRevisionText`**: query 필터(일치 줄 ±1줄 + "…" 구분), 미일치 시 전체 표시 안내. 캡 9,000자(full=50,000) — 연말 대개정 개정문이 수십만 자일 수 있어 query 사용 권장.
- `[부칙개정⚠]` 경고 3곳(`get_law_addenda`/`trace_article_application`/`build_application_timetable`)에 "지시문 원문은 `get_law_revision_text(promulgationDate=개정일)`" 동선 연결 — 플래그→지시문 원문→개정 전 부칙 대조의 3단 워크플로 완성.

### Tested
- `test/utils.test.js` 신규 3건(개정문 CDATA 추출+자구개정 지시문 보존 / 제정문 fallback·빈 값 / 공포번호·일자 선택+구분자 날짜 정규화+동시지정 AND). `npm test` 전체 161건 통과. (테스트가 "2026.5.22" 구분자 입력의 zero-pad 누락 버그를 사전 포착 → `normalizeYmdInput` 신설로 수정)
- 라이브: `promulgationDate='2026.5.22'` → MST 286209(제36342호) 자동 선택 + "대통령령 제36127호 … 부칙 제11조제1항 중 …" 지시문 verbatim 회수 / `promulgationNo='36342'` 경로 동일 확인.

## [0.9.21] - 2026-06-11

### Added — 부칙 자체개정(부칙-of-부칙) 꼬리표 감지 `detectAddendumRevisionTails` (`src/index.ts`)
배경(사용자 실측 지적): 제36342호(2026.5.22) 개정령이 **제36127호(2026.2.27) 부칙 제11조①·③ 자체를 자구개정**해 §26의8⑥의 적용 anchor를 신고시점 기준(③)에서 최초공제연도 기준(①)으로 옮겼다 — 6/10 오판→6/11 정정의 직접 원인. 법제처 통합본은 이를 36127 부칙단위의 **현행화 문구 + `<개정 2026.5.22>` 꼬리표**로만 노출하고, 고치는 지시문 자체는 개정문 영역이라 부칙단위 파싱에 잡히지 않는다. 종전에는 이 꼬리표의 인지·해석이 전적으로 모델 재량(코드 가드 없음)이었다. 이를 도구가 강제 표시하도록 변경:
- **`detectAddendumRevisionTails`**: 부칙단위 본문의 `<개정 YYYY.M.D.>` 꼬리표에서 **자기 공포일보다 뒤인 개정일만** 추출(복수 날짜·공백 변형 지원, 부칙 헤더 리터럴 `<제N호,날짜>` 오탐 차단).
- **`get_law_addenda`**: 해당 부칙단위 상단에 `⚠ [부칙 자체개정]` 경고 — 개정 전 문구는 그 개정일 이전 시행본 MST로 재호출 대조 + 고친 개정령 부칙 동반 조회 안내.
- **`build_application_timetable` / `trace_article_application`**: 적용례 줄에 `[부칙개정⚠ 날짜]` 태그 + `└▶ ⚠ 부칙 자체개정`(anchor가 달랐을 수 있음 — 예: 신고시점→최초공제연도) 경고. **클로즈 단위 감지**라 36127 §11①에만 붙고 꼬리표 없는 §11②에는 안 붙는다.

### Changed — `mergeAddendaUnits` dedup: 길이 휴리스틱 → 최신 통합본 우선 (`src/index.ts`)
같은 공포번호 부칙단위가 통합본마다 다를 수 있다(위 자구개정 케이스: 5.19 공포 통합본 286143=개정 전 문구 / 5.22 이후 통합본=현행화 문구). 종전 v0.9.17의 '가장 긴 본문 채택'은 **구문구가 더 길면 stale을 채택할 위험**. 우선순위를 ① 빈 본문 배제 ② 출처 통합본 공포일 최신 우선(`AddendaSource.promDate` — 각 MST lawService XML 기본정보 `<공포일자>`에서 추출, **추가 네트워크 호출 없음**) ③ 동일·미상 시 길이 순으로 변경. promDate 미지정 소스는 종전 길이 동작과 호환(기존 테스트 무수정 통과). `getLawAddenda` export(라이브 검증용).

### Tested
- `test/utils.test.js` 신규 2건(최신 통합본 우선·빈 본문 배제 / 꼬리표 감지 4케이스 — 헤더 리터럴·자기공포일 제외·복수날짜). `npm test` 전체 158건 통과.
- 라이브: `build_application_timetable` §26의8⑥×2025 → 제36127호 §11① 줄에 `[부칙개정⚠ 2026.5.22]`+`└▶` 경고 확인 / `get_law_addenda(promulgationNo=36127, full)` → 단위 상단 `⚠ [부칙 자체개정]` + 현행화 문구("및 같은 조 제6항") 채택 확인 / `scripts/verify-timetable.mjs` 11/11 통과.

## [0.9.20] - 2026-06-11

### Added — 법령 적용 타임테이블 `build_application_timetable` + trace 4중 가드(인벤토리·결박검증·준용체인·차수플래그) (`src/index.ts`)
통합고용세액공제 상시근로자 계산방식 리서치(2026-06-10~11)에서 모델 추론이 반복 오류를 냈다. 근본원인: ① 버전 인벤토리 없이 단일 시점본으로 단정 ② 부칙 '개정규정'을 그 개정령이 실제 바꾼 문구에 결박하지 않음(제35999호 경과조치를 ⑥ 계산방법에 오적용 — 35999호는 ⑥ 미개정) ③ 준용 2층 구조(§26의8⑥ 준용 구조 vs §11의2⑧ 내용)의 층별 적용시기 분리 추적 실패 ④ '최초공제연도' anchor 검출 시 차수(1차공제/추가공제) 클래리파잉 부재 ⑤ 적극 문언 대신 문언에 없는 fallback 창작. 이 5가지를 판단 의존이 아니라 **도구가 기계적으로 강제**하도록 변경:

- **`build_application_timetable`(신규)**: 조문(1~4)×귀속연도(1~6) 적용 매트릭스 일괄 조립. ① 개정 인벤토리(현행본 `<개정·신설>` 꼬리표 = 그 조항을 실제 고친 개정일 목록) ② 부칙 적용례 유형태깅 ③ **결박검증**(부칙 공포일↔꼬리표 대조 — 경과조치 사정거리 자동 경고: "자기 개정령의 개정규정만 유예, 미래 개정 선제유예 불가") ④ **준용 체인 자동 추적**('제N조…준용' 역방향 최근접 탐지 → 준용 대상 조문의 부칙·인벤토리 동반 회수 = 2층 타임라인) ⑤ 연도별 판단노트 + `firstCreditYear` 차수 분기 + 미지정 시 ⚠⚠ 차수 확인 플래그. 내부적으로 기존 DRF 호출 재조합(연혁 1+조문 2~4+부칙 1)이라 신규 API·지연 요인 없음.
- **`trace_article_application` 강화**: 동일 4중 가드(인벤토리·결박검증·준용체인·차수/신고시점 플래그) + `TRACE_GUARD` ⑤⑥ 신설(개정규정=문구 단위·경과조치 사정거리 / 적극 문언 우선·서식 작성방법<부칙·문언).
- **`extractJoClauses` 회수 결함 수정**: hang 필터가 `"제26조의8제4항제1호 및 같은 조 제6항"`류 **"같은 조 제N항" 표기를 누락**하던 문제 수정 — 이번 사태의 핵심 적용례(제36127호 부칙 제11조①)가 hang 지정 호출에서 통째로 빠졌었다.
- instructions에 **[법령 적용시기 — 타임테이블 우선]** 섹션: 귀속연도 질문은 타임테이블부터 + 6대 해석 공리 + 차수·신고시점 클래리파잉 의무(다년 사이클 공제: 통합고용 §29의8, 구 고용증대 §29의7 등).

### Tested
- `test/timetable.test.js` 신규 12건(항별 인벤토리·HTML엔티티·결박 3종·준용 역방향 탐지·"같은 조" 회수·파서). `npm test` 전체 156건 통과.
- `scripts/verify-timetable.mjs` 라이브 회귀 **11/11 통과**: 통합고용 §26의8⑥×2024·2025·2026 — 차수 플래그·제36127호(최초공제연도기준·결박✓)·제36342호(준용대상 적용례)·제35999호(결박⚠+사정거리 경고)·준용체인(§11의2⑧·§23⑬), firstCreditYear=2025 분기 노트, §11의2⑧ 자체 경로(특구) 교차 케이스.

## [0.9.19] - 2026-06-10

### Changed — `call_taxlaw_action` 비-full 응답 토큰 절감(빈 필드 prune) (`src/index.ts` `pruneEmpty`/`stringifyJson`)
NTS action.do 원시 JSON은 null·빈 필드가 대다수(예: `ASISTH001MR01`은 각 항목마다 ~20개 null 필드)라 15,000자 truncate 전에 신호밀도가 매우 낮았다. 비-full 모드에서 `pruneEmpty`로 null·""·빈 배열·빈 객체를 재귀 제거(0·false는 보존) → 같은 토큰 예산에 실제 데이터를 더 담는다. 추가 네트워크·지연 없는 인메모리 변환이라 속도 영향 0, full=true는 원시 전체(빈 필드 포함) 그대로 보존. 응답에 "빈 필드 생략 — 원시 전체는 full=true" 안내 부착.

(검토했으나 미반영: 업종코드 6개 도구의 지연노출 그룹화 — discover/execute 2단 라운드트립으로 업종조회가 느려지고 직접호출 워크플로를 깨뜨려 효과성 저하. 현 직접노출 유지.)

### Tested
- `test/utils.test.js` 신규 1건(null·빈 필드 제거, 0/false·실데이터 보존). `npm test` 전체 144건 통과.

## [0.9.18] - 2026-06-10

### Added — 시점별 조문 본문·수식이미지 회수 `get_law_article` (korean-law 연혁 결함 보완) (`src/index.ts` `fetchEflawVersions`/`pickVersionInForce`/`extractArticleBody`/`getLawArticle`)
korean-law-mcp의 **시점별(연혁) 조문 회수가 사실상 고장**(이번 세션 실측: `get_historical_law`는 jo 추출 불능으로 메타만 반환, `get_law_text`+과거 mst/efYd는 NOT_FOUND 반복)이라, 구법령 본문을 결국 법제처 DRF raw XML로 우회해야 했다. 또 계산식이 **이미지**라 본문 텍스트에 안 보인다. 이 두 결함을 taxlaw-nts에서 흡수.

- **`get_law_article`**: `year`(예: 2025) 또는 `efYd`(YYYYMMDD)를 주면 eflaw(시행일법령) 목록에서 **그 시점에 시행 중이던 버전(시행일 ≤ 기준 중 최신)을 자동 선택**(`pickVersionInForce`)해 조문 본문을 회수. 계산식 등 **수식은 `flDownload.do` 이미지 URL로 반환**(`extractArticleBody`) → 다운로드 후 Read/브라우저로 확인. 최근 시행본(시행일·MST) 목록도 함께 제공(다른 시점 선택용).
- **가드**: "이 본문은 '그 시점 시행 중이던' 조문일 뿐, 어느 과세연도 신고에 적용되는지는 `trace_article_application`(부칙)으로 따로 판정"을 응답에 명시. `trace_article_application`의 구버전 본문 안내도 korean-law → `get_law_article`로 변경(자체 회수).
- 실측 검증: §26의8을 year=2025 → MST 279959(시행 2025.11.28, 매월말 합÷개월수 총량식 이미지), year=2026 → MST 283625(시행 2026.7.1, §11의2제8항 준용=인당)로 정확 해소. 전부 법제처 DRF 단일 출처, korean-law-mcp 미수정.

### Tested
- `test/utils.test.js` 신규 2건(시점 버전 선택 / 수식 이미지 URL 회수·마커). `npm test` 전체 143건 통과.

## [0.9.17] - 2026-06-10

### Fixed — 부칙 consolidation lag 보정(최근 시행본 union) (`src/index.ts` `fetchEflawMsts`/`mergeAddendaUnits`/`prepareMergedAddenda`)
법제처 통합본이 **직전 일부개정 부칙을 누락**하는 케이스 발견: 조특령 현행 통합본(타법개정 제36338호, 공포 2026.5.19, 시행 2026.6.3)의 부칙에는 **제36342호(공포 2026.5.22, 시행 2026.5.22)가 빠져 있음**(부칙단위 280 vs 286209의 281). 원인은 286143이 *자기 공포시점(5.19) 기준*으로 누적돼 그 뒤(5.22) 공포된 일부개정 부칙을 못 담은 것. 그래서 `get_law_addenda`/`trace_article_application`이 현행 MST만 보면 통합고용세액공제 상시근로자 수 계산식의 **절사 위치 적용례(제36342호 §2②: "§26의8제6항 준용 시 2026.1.1 이후 개시 과세연도 신고분")를 통째로 놓쳤다.** 부칙 우선을 강제하려는 도구가 정작 부칙 소스 누락에 당하는 구조.

- `fetchEflawMsts`: 법제처 시행일법령(eflaw) 검색으로 같은 법령의 최근 시행본 MST들을 시행일 내림차순(중복 제거)으로 확보.
- `mergeAddendaUnits`: 여러 시행본의 부칙단위를 공포번호 기준 union·dedup(가장 긴 본문 채택) + 각 공포번호가 어느 MST에 있었는지 presence 추적.
- `prepareMergedAddenda`: 현행 MST + 최근 4개 시행본 부칙을 union. **현행 MST에 없어 보강된 공포번호를 응답에 ⚠로 노출**(consolidation lag 가시화). `get_law_addenda`/`trace_article_application` 공용.
- 결과: 제36342호가 286209에서 보강되어 절사 위치 적용례가 정상 회수됨. 전부 법제처 DRF 단일 출처, korean-law-mcp 미수정.

### Tested
- `test/utils.test.js` 신규 1건(union·dedup·보강·presence). 실데이터 종단 확인: 현행 통합본 누락 제36342호를 union이 보강, §11의2제8항 절사 적용례 회수.
- `npm test` 전체 141건 통과.

## [0.9.16] - 2026-06-10

### Added — 조문 적용시점 추적 `trace_article_application` (`src/index.ts` `extractJoClauses`/`classifyApplicationClause`/`extractEnforceDate`/`traceArticleApplication`)
"어느 과세연도(귀속) 신고에 어떤 버전의 조문이 적용되는가"를 **부칙 적용례 기준**으로 추적하는 도구. 반복된 실측 오류의 근본원인을 구조적으로 차단하기 위해 신설: **'그 해에 시행 중이던 본문' = '그 귀속에 적용되는 본문'으로 착각**(특히 "시행 이후 신고하는 경우부터" 같은 신고시점 기준 적용례가 직전 과세연도에 **소급**하는 것을 무시)하여, 통합고용세액공제 상시근로자 수 계산방식을 2025 귀속에 대해 잘못 판정한 사고. 실측: 조특령 §26의8제6항(계산방법=§11의2제8항 준용, per-person)은 **제36127호(2026.2.27) 부칙 §11③ "이 영 시행 이후 신고하는 경우부터"** → 2025 귀속 법인세(2026.3)·종소세(2026.5) 신고분에 소급 적용. "2025.1.1 시행본(MST 267757)은 총량식"이라는 본문 스냅샷으로 단정한 게 오류였음.

- **`trace_article_application`**: jo(+hang) 지정 시, 그 조문을 언급하는 모든 개정 부칙의 적용례·경과조치를 원문 그대로 모아 ① 유형 태깅(과세연도개시/신고시점/행위시점/최초공제연도/경과조치/소득·기간) ② targetYear 소급 판단노트(신고시점형은 targetYear+1년 신고시점과 시행일 비교) ③ 부칙 충돌 경고(같은 조문에 경과조치 + 후행 특정 적용례 공존 시) ④ **강제 가드 헤더**(부칙 우선·신고기준 소급·후행 특정 우선·본문 스냅샷 단정 금지)를 반환.
- `extractJoClauses`: 조→항 분해 후 jo 언급 + 적용 동사(적용한다/종전규정에 따른다/본다) 보유 조항만 → 타법개정 자구정정("…를 …로 한다") 오탐 제외. hang 지정 시 'jo+hang' 인접(예 제26조의8제6항) 매칭, 단 조 단위 경과조치는 충돌 가시화를 위해 항상 포함.
- `classifyApplicationClause`/`extractEnforceDate` 규칙 기반(정규식). 전부 법제처 DRF 단일 출처, korean-law-mcp 미수정.
- 한계 명시: 법적 결론을 자동 단정하지 않음 — 적용례 verbatim + 유형 + 소급 체크포인트로 '부칙 우선' 사고를 강제하는 보조도구.

### Tested
- `test/utils.test.js` 신규 3건(유형 분류 5종/시행일 추출/jo+hang 추출·자구정정 제외·조단위 경과조치 포함). 실데이터 종단 확인: 조특령(MST 286143) §26의8제6항 → 제36127호[신고시점기준]·제35999호[경과조치]·제35347호[경과조치] 정확 분류 + 타법개정(제35947호) 오탐 제거.
- `npm test` 전체 140건 통과.

## [0.9.15] - 2026-06-10

### Added — 법령 부칙(시행일·적용례·경과조치) 조회 `get_law_addenda` (`src/index.ts` `parseLawAddenda`/`extractCdataText`/`getLawAddenda`)
세법 리서치의 핵심인 **부칙(적용례·경과조치)**이 그동안 어느 경로로도 회수되지 않았다. 실측 원인: 부칙은 '조문'이 아니라 법령 본문 XML 맨 끝의 별도 `<부칙><부칙단위>` 노드인데, ① NTS statute 컬렉션은 메타·인용 위주라 부칙 본문 미노출, ② 법제처 래퍼는 조문만 파싱(jo="부칙"은 NOT_FOUND), ③ 전체 본문(조특법 시행령 raw ≈ 2MB, 부칙단위 281개)은 일반 fetch/요약이 끝의 부칙에 도달 전에 잘림. 그 결과 "통합고용세액공제 상시근로자 수 계산방식의 연도별(귀속) 적용시기"처럼 부칙 적용례 없이는 못 푸는 질의를 검증하지 못하고 사용자에게 전가하는 사고가 있었음.

- **`get_law_addenda`**: 법제처 국가법령정보 Open API(DRF) `lawService.do?target=law&type=XML`에서 `<부칙>` 노드를 공포번호별 `<부칙단위>`로 분해해 시행일·적용례·경과조치를 반환. `mst`(현행 MST면 과거 개정 부칙까지 누적 포함) 또는 `lawName`(DRF lawSearch로 현행 MST 1차 해소) 입력. `promulgationNo`/`query`로 특정 개정령·키워드 필터. 무거운 XML 파싱은 서버에서 끝내고 적용례 텍스트만 distill해 반환(절단 우회).
- **출처 분리 원칙 유지**: 부칙의 1차 권위 출처가 법제처라 DRF를 직접 호출(korean-law-mcp와 동일 OC). 도구 설명에 "적용례는 구조문(개정 전 본문)과 짝 → 구조문은 korean-law-mcp.compare_old_new의 [개정 전]로 대조" 안내 명시. korean-law-mcp는 미수정.
- **CDATA 처리**: `<부칙내용>`은 여러 `<![CDATA[...]]>` 조각으로 쪼개져 있고 조각 안에 `<제36342호,2026.5.22>` 같은 리터럴 꺾쇠가 있어, 일반 태그 제거 시 부칙 헤더가 잘린다. CDATA 조각만 결합하고 수식 `<img>`만 `[수식이미지]` 마커로 치환.
- 인증키: 환경변수 `LAW_GO_KR_OC` 또는 `oc` 파라미터(미설정 시 명확한 안내 에러). 키는 소스에 하드코딩하지 않음.

### Tested
- `test/utils.test.js` 신규 3건(공포번호별 분해+일자/번호 추출, CDATA 결합+리터럴 꺾쇠 보존+img 마커, `<부칙>` 부재 시 빈 배열). 한글 토큰 뒤 `\b`(ASCII 단어경계) 미매칭 버그를 테스트가 사전 포착 → 수정.
- 실데이터 종단 확인: 조특법 시행령(MST 286209) raw XML 파싱 → 부칙단위 281개, 제36342호(2026.5.22) 제2조②("§11의2제8항이 §26의8제6항 준용 시 2026.1.1 이후 개시 과세연도 신고분부터") 정확 추출.
- `npm test` 전체 137건 통과.

## [0.9.14] - 2026-06-09

### Added — 판례·결정례 '판단·결론부' 잘림 경고 (`src/index.ts` `detectHoldingTruncation`, `formatDocumentDetail`)
판례·결정례(05~10: 과세전적부·이의·심사·심판·판례·헌재)는 '주문'이 본문 앞, 실제 '판단(3. 심리 및 판단)·결론'이 본문 뒤에 위치한다. 기본(full=false)은 본문을 8000자에서 truncate하므로 결론부가 잘리는 경우가 많고, 이때 요지·처분개요만 보고 결론을 단정하면 **요지와 실제 주문/판단이 어긋나는 오류**가 난다. 실측: 수원고법 2023누15045 — NTS 요지는 "쟁점 타사 포인트는 … 에누리에 해당함"인데, 판결 본문·주문은 정반대로 "제3자적립마일리지로 과세표준에 포함, 에누리에 해당하지 않음, 항소기각(과세유지)"이었음. 요지만 신뢰하면 '에누리 인정 사례'로 정반대 분류.

- `get_taxlaw_document_text` 응답에 `── 판단·결론부 확인 (판례·결정례) ──` 블록 부착: ① 본문이 잘렸으면 `⚠ 결론부 누락 가능 → full=true 재조회` 강제 안내, ② `[요지-결과 정합성]` 가드(요지가 '에누리/인정'인데 결과가 기각·국승이면 모순 신호), ③ `[결정구분 표기]` 가드(인용/기각/각하/재조사는 국세기본법 §65① 또는 주문 기준, 목록 메타데이터 의존 금지).
- `PRECEDENT_CODES`(05~10)만 대상, 질의·해석례(01~04)·full·빈 본문은 무경고. 기존 bodyText 1회 재사용 — 추가 API 호출 없음.
- 도구 설명/`full` 파라미터 설명에 판례 결론 인용 시 full=true 권장 명시.
- `detectHoldingTruncation` export(테스트용).

### Tested
- `test/utils.test.js` 신규 3건(잘림 강제경고/비잘림 정합성가드/비쟁송·full·빈본문 무경고).
- `npm test` 전체 통과.

## [0.9.13] - 2026-06-05

### Added — 행정규칙(훈령·예규·고시) stale 경고 (`src/index.ts` `searchTaxlawAll`)
NTS statute/별표 컬렉션은 행정규칙 개정 후 색인 갱신이 지연될 수 있다. 실측: 「모범납세자 관리규정」이 법제처에서는 **2026.5.19 제2742호 현행본**(31개 조)인데, 본 MCP의 statute 컬렉션은 **2022.9.30 구버전**(14개 조)을 보유 → 조문 번호 체계가 전면 불일치(제4조 추천 vs 선정일, 제6조 내부검증 vs 관리종료 등). 이 구버전만 신뢰하면 현행 의견서를 "조문 전부 오류"로 오판할 위험이 있었음.

두 MCP(korean-law 법제처 + taxlaw-nts 국세청)는 **자동 교차검증이 아니라 서로 다른 DB를 보는 상호보완 관계**라, 단순히 둘 다 호출하는 것만으로는 staleness가 드러나지 않는다. 이를 응답 레벨에서 가시화:
- 통합검색 결과 분류 라벨이 행정규칙(`/^(훈령|예규|고시|지침)(서식)?$|행정규칙/`)이면 헤더에 `⚠ 행정규칙 … stale 가능` 경고 + 법제처 현행본 교차확인 경로(`korean-law-mcp.discover_tools(intent="행정규칙") → search_admin_rule → get_admin_rule`)와 공포일·시행일·문서번호 3종 대조를 안내.
- 앵커(`^…$`)로 `고시서면질의`(해석례 docType) 같은 라벨의 오탐 방지.
- `isAdminRuleRow` 헬퍼 export(테스트용). 기존 headerItems 스캔에 1줄 편승 — 추가 순회·API 호출 없음.

### Added — INSTRUCTIONS `[행정규칙 현행성 — stale 경고]` 절차
서버 INSTRUCTIONS에 행정규칙 근거 질의의 강제 절차 추가: ① 응답의 stale 경고 무시 금지, ② `search_law`는 행정규칙 NOT_FOUND → `discover_tools → search_admin_rule(knd) → get_admin_rule`로 법제처 현행본 조회, ③ 공포일·시행일·문서번호 교차확인 후 조문 1:1 대조(개정 시 조문 체계 재편 가능).

### Tested
- `test/admin-rule-stale.test.js` 신규 8건 (훈령/훈령서식/예규·고시·지침/2nd 라벨/고시서면질의 오탐 가드/일반 해석례·판례 false/빈 행 false).
- `npm test` 전체 통과.

## [0.9.12] - 2026-05-20

### Removed — 데드코드 정리 (`src/index.ts`, `src/tax-law-code-map.ts`)
v0.9.6에서 `formatTaxLawCell` → `formatTaxLawCellCompact` 교체 시 옛 함수 미제거. import 1줄 + 함수 정의 15줄 데드 코드 → 빌드 크기 소폭 절감 + 인지 부담 제거. 사용처 0건 확인 후 제거.

### Fixed — citation-extract 노이즈 ref 차단 (`src/citation-extract.ts`)
같은 줄에 법령명이 여러 번 등장하고 80자 window 안에 조 번호 없이 항만 잡히는 경우 `소득세법 제1항` 같은 무효 ref가 추출되던 버그. doctrine-assess 라이브 출력에서 `소득세법 제1항`, `소득세법 제2항` 노이즈 2건 관찰. 정식 법령 인용은 항상 조 번호를 포함하므로 `article === null` ref는 무조건 거부. 회귀 가드 테스트 1건 추가.

### Added — relevance_low overflow 경고 (`src/index.ts` `searchTaxlawDocuments`)
멀티 키워드(2토큰+) 쿼리에서 회수 항목의 80% 이상이 원본 query 토큰을 본문에 하나도 포함하지 않으면 헤더에 `⚠️ relevance_low overflow: N/M건…` 경고 노출. 자동 분해 재시도로 들어온 무관 결과(예: "신성장원천기술 R&D 세액공제" → 변형 매칭으로 R&D 관련 옛 회신만 회수)를 사용자/LLM이 본문 클릭 전에 식별 가능. 토큰 판정은 자동 재시도 케이스를 고려해 원본 쿼리(`retryContext.originalQuery`) 기준으로 측정.

### Changed — `taxLawCode=305↔312` cross-bleed 양방향 안내 (`src/index.ts`)
v0.9.5의 단방향 안내(`312 직접 호출 NOT_FOUND 빈번 → 305로 호출 시 mismatch로 노출됨`)가 실제 라이브 패턴과 어긋남. 라이브에서 `taxLawCode=305 + "근로소득 비과세 식대"` 검색 시 312(원천세)로 분류된 식대·자가운전보조금 케이스가 자주 mismatch로 섞임. description을 양방향으로 정정: `quirk: 305(종합소득세)↔312(원천세) 양방향 cross-bleed 잦음`.

### Changed — `citations_no_dates` + vintage ≥15년 → `likely_outdated` 격상 (`src/doctrine-assess.ts`)
v0.9.0의 `citations_no_dates` 분류는 인용 시점 단서가 없으면 무조건 `unverified`로 떨어졌는데, 라이브에서 vintage gap 15년(2011년 식대 회신 → 2026 targetYear)인 케이스도 ❓로 떨어지는 패턴 관찰. 본문에 일자가 없어도 vintage gap 자체가 강한 사문화 신호이므로 ≥15년이면 `likely_outdated`로 격상. 임계값을 before_target의 `> 15`보다 한 단계 보수적(`≥ 15`)으로 설정한 이유는 citations_no_dates가 더 약한 증거 위에 서 있으므로 안전망을 한 칸 더 넓힘. 회귀 가드 테스트 2건 추가 (15년 격상 / 14년 미격상).

### Tested
- `npm test`: 124/124 통과 (신규 3건: citations_no_dates 격상, 14년 미격상 회귀, article 없는 ref 거부).
- `node scripts/smoke-test.mjs`: all cases pass.
- 라이브 검증(0.9.12 빌드 반영 후 클라이언트 재시작 시 활성):
  - `search_taxlaw_documents(query="신성장원천기술 R&D 세액공제", taxLawCode=309)` → 자동 변형으로 4건 회수되지만 모두 relevance_low → `⚠️ relevance_low overflow` 헤더 노출.
  - `assess_doctrine_validity(id="010000000000143289", targetYear=2026)` → vintage 15년 + citations_no_dates → 기존 `unverified` 대신 `likely_outdated` 판정.

## [0.9.11] - 2026-05-20

### Added — `[RETRY_CANDIDATES]` 명시 marker + L1/L2/L3 단계 라벨 (`src/index.ts`)
v0.9.9의 NOT_FOUND 토큰 압축본은 정보는 다 있지만 LLM이 "재시도 제안 → 무시 → 사용자에게 빈손 보고"하는 패턴이 라이브에서 관찰됨. 명시 marker로 self-recover 순서를 강제.
- `[RETRY_CANDIDATES] 다음 순서로 재시도:` 헤더 + 각 줄에 `L1 (쿼리·파라미터 조정)`, `L2 (도구·범위 변경)`, `L3 (외부 MCP 병행)` 라벨 prefix.
- L1 안내문에 `'연구·인력개발비' → '연구개발비'` 같은 가운뎃점·공백 제거 예시 포함.
- `actionId(call_taxlaw_action):` 줄에 본 도구 미지원(법제처 해석례·감사원 심사청구·납세자보호위원회·평가심의·주요 대법원/판례결정례) actionId 6개 인라인 명시 — L2 단계에서 즉시 사용 가능.

### Added — `get_taxlaw_basic_ruling_text(verbose=false)` 헤더·항목명만 반환 (`src/index.ts`)
인접 번호 군집 스캔(예: `24-0…1` ~ `24-36…3`)을 위해 본문 텍스트를 생략하고 lawId/year/검색어/총건수 헤더 + `[ID] 번호 【제목】` 1줄 항목만 반환. display=20일 때 응답 ~85% 감소.
- 기본통칙 인용 검증 워크플로(README 6의 통칙 환각 방지 절차) 2단계에서 인접 번호대를 한 호출에 일괄 회수할 때 유용.
- 본문이 필요한 단계에서는 `verbose=true`(기본값) 또는 `full=true`로 재호출.

### Changed — query variant 자동 재시도 변형 규칙 확대 (`src/query-retry.ts`)
v0.9.9의 0건 fallback이 한자·복합어에서 누락이 잦아 변형 후보 확대.
- 가운뎃점/공백/하이픈 제거 변형 추가 (`연구·인력개발비` → `연구인력개발비`).
- 영문/숫자 토큰 단독 분해 (회사명 포함 paraphrase 쿼리 → 핵심 토큰 한 개로 폴백).
- 자동 재시도 발동 시 응답 헤더에 `↻ 자동 재시도: 원본 쿼리 "X" 회수 0건 → 분해 키워드 "Y"로 재시도 (회수 N건). 결과 일부가 원본 의도와 다를 수 있으니 본문 확인 권장.` 안내 노출.

### Changed — 도구 description 동반 호출 안내 압축 (`src/index.ts`)
모든 도구 description에 ~210자 반복되던 `korean-law-mcp 동반 호출 필수 — 법령 본문은 그쪽이 1차…` 보일러플레이트를 ~50자(`⚠ korean-law-mcp(법제처) 동반 호출 필수 — 법령 본문·시행일은 그쪽이 1차.`)로 축약. `search_taxlaw_documents` description 길이 약 58% 감소. 시스템 프롬프트 토큰 절감 효과.

### Docs — claude.ai 웹 사용자 안내 추가 (`README.md`, `README-EN.md`)
사용자 요청으로 claude.ai 웹(브라우저) MCP 지원 현황 명시. claude.ai의 Custom Connectors는 원격 HTTPS MCP만 지원하므로 본 STDIO 서버는 직접 추가 불가 — Claude Desktop 권장(STDIO 직접 지원, 동일 모델·대화 히스토리). 기존 "Claude Code (Claude Desktop의 MCP 설정)" 헤더는 "Claude Desktop / Claude Code (STDIO 직접 지원)"로 정정 — Claude Code(CLI)와 Claude Desktop(앱)이 같은 STDIO 설정을 공유한다는 점을 명확화.

### Tested
- `npm test`: 121/121 통과.
- `node scripts/smoke-test.mjs`: all cases pass (조특법 §6 사례 doctrine assess 정상).
- 라이브 검증 (4 items, 2026-05-20):
  1. `search_taxlaw_documents` description ~58% 축소 — 스키마 조회로 확인.
  2. NOT_FOUND `[RETRY_CANDIDATES]` + L1/L2/L3 + actionId 6개 — `query="zzzqqq...impossible"` 케이스로 확인.
  3. 자동 변형 재시도 — `query="존재할리없는검색어자모음qwxz9988"` → `"9988"` 분해 재시도로 1건 회수, `↻ 자동 재시도` 안내 노출 확인. 원본이 회수되는 케이스(`연구·인력개발비` 409건)에서는 변형 재시도 미발동(기대 동작).
  4. `get_taxlaw_basic_ruling_text(verbose=false)` — 법인세법 기부금 통칙 20건 중 8건이 본문 0자, 항목명·번호만 노출 확인.

## [0.9.10] - 2026-05-20 (로컬 빌드만, GitHub 미푸시)

### Added — `taxLawCode=354(조세특례제한법) ⚠deprecated` 마커 (`src/tax-law-code-map.ts`, `src/index.ts`)
v0.9.8 라이브에서 354 단독 호출이 가끔 회수되지만 309(조세특례)와 라벨 중복 + NTS 신규 데이터는 309로 쏠리는 패턴 확인. 매핑표에 `deprecated: true` 필드 추가 + 도구 description에 `354=조세특례제한법 ⚠deprecated` 인라인 표시. 사용자가 354를 그대로 쓸 수 있지만 309 권장 시그널 노출.

## [0.9.9] - 2026-05-20 (로컬 빌드만, GitHub 미푸시)

### Added — `verbose=false` 옵션 (`src/index.ts` `search_taxlaw_documents` / `search_taxlaw_all`)
검증·헬스체크·인용 verification 용도로 ID/구분/세목/문서번호/일자만 노출하고 요지·검색근거를 생략. 응답 토큰 ~60% 절감. 기본값 `true`로 호환성 유지.

### Added — NOT_FOUND 응답 자동 재시도 제안 (`src/index.ts` `searchTaxlawDocuments`)
회수 0건 케이스에서 LLM이 "검색 실패 → 사용자에게 빈손 보고"하는 패턴 방지. 응답에 재시도 제안(쿼리 축약·docType 확대·call_taxlaw_action으로 미지원 메뉴 접근·korean-law-mcp 병행) + 미지원 메뉴 actionId 인라인 노출. v0.9.11에서 L1/L2/L3 단계 라벨 + `[RETRY_CANDIDATES]` 명시 marker로 한 번 더 강화.

### Added — 동적 세목 코드 헤더 (`search_taxlaw_all`에 v0.9.7 패치 이식)
v0.9.7의 `formatTaxLawCodeHeader` 매핑표 외 코드 fallback 로직을 `searchTaxlawAll` 결과 포매터에도 이식. 통합검색에서도 매핑표 외 세목이 헤더에 표시됨.

### Added — query variant 자동 분해 재시도 (`src/query-retry.ts` 신규)
긴 paraphrase 쿼리(`존재할리없는검색어자모음qwxz9988`)나 회사명·금액 포함 자연어 쿼리가 회수 0건일 때, 영문/숫자 토큰 단독으로 분해 후 자동 재시도. 응답 헤더에 `↻ 자동 재시도: 원본 쿼리 "X" 회수 0건 → 분해 키워드 "Y"로 재시도` 안내. v0.9.11에서 가운뎃점·공백·하이픈 제거 변형 추가.

## [0.9.8] - 2026-05-19 (로컬 빌드, package.json version 0.9.8로 bump)

### Fixed — TAX_LAW_CODE_MAP 묶음 가정 정정 + 매핑표 보강 (`src/tax-law-code-map.ts`, `src/index.ts`)

v0.9.7 라이브 재검증(taxLawCode 미지정 검색에서 다양한 세목 회수)에서 v0.9.5의 묶음 가정이 NTS 실제 응답 라벨과 어긋남을 발견.

**v0.9.5 가정 (오류)**:
- `305 = 종합소득세 (양도소득세 포함)` — 묶음
- `313 = 소비세 (부가가치세·개별소비세·주세·인지세)` — 부가세 묶음

**v0.9.8 라이브 검증 결과**:
- `taxLawCode=307` 단독 호출 → 총 28,222건 회수, 응답 라벨 `양도소득세(307)` — 305와 별개 코드.
- `taxLawCode=306` 단독 호출 → 총 29,258건 회수, 응답 라벨 `부가가치세(306)` — 313과 별개 코드.
- `taxLawCode=305` + `query=양도` → 응답에 307 없음. 305는 종합소득세 단독.
- `taxLawCode=313` → 응답에 부가세 없음. 개별소비세/주세/인지세만 회수.
- `taxLawCode=309` → 총 9,261건, 응답 라벨 `조세특례(309)`. 354(조세특례제한법)와 별개 코드.
- `taxLawCode=310` → 총 3,293건, 응답 라벨 `국제조세(310)`. 외국법인·비거주자·조세조약 케이스.

**패치**:
- `TAX_LAW_CODE_MAP`에 4개 신규 등록 — 306(부가가치세), 307(양도소득세), 309(조세특례), 310(국제조세).
- `305.taxes` `["종합소득세", "양도소득세"]` → `["종합소득세"]` (양도세 제외).
- `313.taxes` `["부가가치세", "개별소비세", "주세", "인지세"]` → `["개별소비세", "주세", "인지세"]` (부가세 제외).
- 모든 schema description 텍스트(`search_taxlaw_all` / `search_taxlaw_documents`의 `taxLawCode` 필드) 정정 — "양도세는 305에 포함" / "부가세는 313에 포함" 안내 제거 + v0.9.8 매핑 안내로 교체.
- `package.json` version `0.9.5` → `0.9.8`. `src/index.ts:35` VERSION 상수 동기화.

**영향**:
- v0.9.7 빌드의 v0.9.7 동적 헤더 fallback(매핑표 외 코드는 NTS 응답 분류명 사용)이 더 이상 필요 없는 코드들 — 306/307/309/310. 그러나 fallback 로직은 미래 신규 코드 대응용으로 유지.
- 사용자가 양도세 검색을 위해 `taxLawCode=305`를 사용하던 패턴은 이제 `taxLawCode=307`로 변경 필요. 도구 description에 정정 안내 포함.
- 354(조세특례제한법)와 309(조세특례)의 관계는 후속 검증 필요 — 두 코드 모두 라이브에서 등장하므로 분리 보존.

### Tested
- `npm test`: 121/121 통과.
- 라이브 검증: 307/306/309/310 단독 호출 정상 회수 + 305에 양도세 미포함 확인.

## [0.9.7] - 2026-05-19 (로컬 빌드만, GitHub 미푸시 — package.json version은 0.9.5 유지)

### Fixed — v0.9.6 라이브 재검증에서 발견한 multi-code 헤더 누락 (`src/tax-law-code-map.ts`, `src/index.ts`)

라이브 케이스: `search_taxlaw_documents(query="원천징수 사업소득 기타소득")` (taxLawCode 미지정) → 결과에 종합소득세(305)·국제조세(310)·조세특례(309) 혼재. 항목별 출력은 `세목: 국제조세(310)`처럼 정상 노출되지만, 헤더 `※ 세목 코드:`에는 305만 표시되어 매핑표 외 코드(310, 309)가 누락됨.

- 원인: `formatTaxLawCodeHeader`가 `TAX_LAW_CODE_MAP[k]` 매칭 실패 시 코드를 skip → 매핑표 외 코드는 헤더에서 사라짐. 항목별 `formatTaxLawCellCompact`는 매핑표 외 코드도 그대로 노출(`${name}(${code})`)하므로 비대칭.
- 패치: `formatTaxLawCodeHeader` 시그니처를 `Array<string>` → `Array<{code, name?}>`로 변경. 매핑표에 있으면 정규명+묶음세 표시, 없으면 NTS 응답 분류명을 fallback. 호출부(index.ts:1761)에서 `NTST_TLAW_CL_NM`을 동반 전달.
- 출력 예: `※ 세목 코드: 305=종합소득세(종합소득세·양도소득세), 310=국제조세, 309=조세특례`.
- 토큰 영향: 매핑표 외 코드 1건당 ~10자 추가(`, 310=국제조세`). 정보 누락 차단 효과가 더 큼.

## [0.9.6] - 2026-05-19 (로컬 빌드만, GitHub 미푸시 — package.json version은 0.9.5 유지)

### Changed — v0.9.5 라이브 self-review에서 발견한 토큰 비용 비효율 3건 압축

v0.9.5 패치 4건의 라이브 출력을 효과성 vs 토큰비용 매트릭스로 재검토. 효과성 손실 없이 비용만 깎는 방향으로 응답 포매터 압축.

**A. 세목 정규명 — 항목 반복 → 헤더 1회 압축 (`src/tax-law-code-map.ts`, `src/index.ts`)**
- v0.9.5는 `formatTaxLawCell`이 매 결과 항목에 `소비세 (코드 313) (부가가치세·개별소비세·주세·인지세)` 식으로 묶음세 부가설명을 반복 출력 → 5건 호출 시 ~150자 중복.
- 신규 `formatTaxLawCellCompact` — 항목은 `소비세(313)` 축약형(묶음 정보 제외).
- 신규 `formatTaxLawCodeHeader` — 응답 시작부에 `※ 세목 코드: 313=소비세(부가가치세·개별소비세·주세·인지세)` 1줄로 unique 코드별 안내.
- 적용: `formatDocumentSearchItem`(항목), `searchTaxlawDocuments`(헤더). 묶음세 정보 보존 + 반복 제거.
- 예상 절감: 5건 검색당 ~70토큰, 20건 검색당 ~360토큰.

**B. assess 후속 큐 dedupe (`src/doctrine-assess.ts buildNextActions`)**
- v0.9.5 라이브 출력에서 `citedArticles`에 "제24조 제1항 제1호"와 "제24조"가 별개 ref로 추출돼 동일 `search_law`/`get_law_text`가 큐에 두 번 push되는 패턴 관찰.
- `(tool, JSON.stringify(args))` 기준 dedupe 추가. 동일 키에 priority가 다르면 더 강한 쪽(required > recommended > optional) 유지.
- 예상 절감: assess 1회당 ~330토큰.

**C. 큐 출력 그룹 헤더화 + 항목 압축 (`src/doctrine-assess.ts formatAssessment`)**
- v0.9.5는 큐 11개 모두에 `목적/활용` 풀 텍스트 반복 — `예규 본문의 인용 문구와 1:1 대조해...` 같은 보일러플레이트가 4회까지 동일 문장으로 등장.
- tool 종류로 그룹 분류(`citation_check`, `follow_decisions`, `follow_nts`, `other`) + 그룹 헤더 1회로 공통 활용 안내. 항목은 `[N] 🔴 tool(args)` 1줄 + `▸ purpose` 1줄로 압축.
- 예상 절감: assess 1회당 ~770토큰.

### Tested
- `npm run build` 통과.
- `npm test`: **121/121 회귀 0건**.
- 정보 손실 없음: dedupe로 사라지는 큐는 동일 (tool, args) 중복뿐, 새 정보는 제거되지 않음. 그룹 헤더 활용 안내는 v0.9.5의 항목별 활용 문구를 그대로 일반화한 표현.

### 균형 분석 — Effectiveness × Token Cost

| v0.9.5 항목 | Effectiveness | Token cost (이전) | v0.9.6 대응 |
|---|---|---|---|
| P0 ① 세목 정규명 | 高 | 中 — 매 항목 ~30자 반복 | **A 압축** — 헤더 1회 + 항목 축약 |
| P0 ② mismatch 라벨 | 中 (안전망) | 저 — 트리거 0건 자연발생 | 유지 |
| P1 NOT_FOUND 자동 분해 | 高 | 저 — 트리거 시 한 줄 안내 | 유지 (ROI 최고) |
| P2 relevance + matched/missing | 高 | 中 — missing 배열 반복 | (보류 — 효과·비용 균형 양호) |
| P3 후속 큐 priority 정렬 | 高 | 高 — 11항목 × 보일러플레이트 | **B dedupe + C 그룹화** |

assess 1회당 응답 크기 약 65% 감소 예상. 일반 search는 결과 건수에 비례해 5~15% 감소.

### 배포 상태
- 로컬 빌드(`build/index.js`)만 갱신. GitHub `main`에는 미푸시. `package.json` version은 0.9.5 유지(사용자 결정 — v0.9.5/v0.9.6를 합쳐 한 줄기로 묶음).

## [0.9.5] - 2026-05-19 (로컬 빌드만, GitHub 미푸시)

### Added — v0.9.4 라이브 self-review로 발견한 6개 약점 일괄 보강

**P0. `taxLawCode` 매핑 정정 + post-fetch 필터링 (신뢰성 직격 fix)**
- v0.9.4까지 schema description의 세목 코드 매핑이 NTS 실제와 어긋남:
  - 308=양도소득세 (실제: **상속증여세**)
  - 311=상속증여세 (실제: **종합부동산세**)
  - 309=원천세 (실제: **312=원천세**)
  - 313=부가가치세 (실제: **소비세** — 부가세·개소세·주세·인지세 묶음)
- 라이브 검증(taxLawCode= 단독 호출 4회)으로 NTS 실제 코드표 확보 후 schema description 정정.
- 신규 `src/tax-law-code-map.ts` — `TAX_LAW_CODE_MAP` 상수 + 4개 헬퍼 (`describeTaxLawCode`, `formatTaxLawCell`, `taxLawCodeMatches`, `taxLawCodeReference`).
- 응답 출력 시 NTS 분류명 + 정규명 병기. 예: `소비세 (코드 313) (부가가치세·개별소비세·주세·인지세)`.
- **post-fetch 필터링**: NTS API가 taxLawCode 파라미터를 strict하게 적용하지 않아(305 호출에 312 케이스가 섞여 회수됨) 응답 코드 ≠ 요청 코드인 항목에 `⚠ taxLawCode_mismatch (요청=X / 응답=Y)` 라벨 자동 부착. 결과 헤더에 mismatch 건수 요약.

**P1. 복합어 NOT_FOUND 자동 분해 재시도**
- "통합투자세액공제", "영세율 외화획득" 등 복합어/다토큰 쿼리가 NTS NOT_FOUND를 반환하던 문제.
- 신규 `src/query-retry.ts` — `buildRetryQueries(query)` 헬퍼가 한국어 합성어를 분해해 후보 키워드 1~3개 생성:
  - 다중 토큰 → 가장 긴 토큰 단독 시도.
  - 단일 토큰 + 6자 이상 → 자주 등장하는 세법 후미명사("세액공제", "감면" 등 24개) 매칭으로 분해.
  - 단일 토큰 + 8자 이상 → 앞/뒤 4자 slice.
- `searchTaxlawAll` / `searchTaxlawDocuments`에서 결과 0건 시 1회 자동 재시도. 무한루프 방지 위해 `retryContext.originalQuery` flag 사용.
- 재시도 성공 시 헤더에 `↻ 자동 재시도: 원본 쿼리 "X" 회수 0건 → 분해 키워드 "Y"로 재시도` 안내.

**P2. 세목명 정규화 병기 + relevance 진단정보 확장**
- 세목명 정규화: P0의 `formatTaxLawCell`로 NTS 원본명 + 정규명 + 묶음세 병기.
- `judgeRelevance` 반환에 `matched: string[]` / `missing: string[]` 추가. 태그 출력도 매칭/누락 토큰 명시:
  - 기존: `⚠ relevance_low (query 키워드 미포함 — 본문 확인 권장)`
  - 변경: `⚠ relevance_low (matched: [], missing: ["기업업무추진비"])`

**P3. assess 후속큐 priority 등급화 + 페이지네이션 안내**
- `NextAction`에 `priority: "required" | "recommended" | "optional"` 필드 추가.
  - 처음 2개 인용 조문 대조 → required.
  - 나머지 인용 조문 → recommended.
  - 대법원 판결 검색 → 사문화 신호 강할 때 required, 그 외 recommended.
  - 헌재 결정 검색 → 사문화 신호 강할 때 recommended, 그 외 optional.
  - NTS 후속 해석례 → optional.
- `formatAssessment`에서 priority 순서로 정렬 + 헤더에 등급별 건수 요약(`required N건 / recommended M건 / optional K건`) + 각 단계에 색상 라벨(🔴/🟡/⚪) 부착.
- 페이지네이션: `searchTaxlawDocuments` / `searchTaxlawAll` 결과 헤더에 `page=현재/총 페이지` + `다음 페이지: page=N+1` 안내 추가.

### Tested
- 단위 테스트 121/121 통과 (회귀 0건).
- `tax-law-code-map.ts`, `query-retry.ts`는 라이브 검증 위주. 매핑/분해 휴리스틱이라 회귀 위험 낮음.

### Motivation
- v0.9.4 라이브 self-review (taxLawCode 308/311/313 단독 호출 + 4세법 랜덤 검증)에서 발견한 약점:
  - schema description의 잘못된 세목 매핑이 LLM에게 거짓 정보 제공 (P0).
  - NTS API가 taxLawCode를 strict하게 필터링하지 않아 305 호출에 312 케이스 누수 (P0).
  - "통합투자세액공제" 류 합성어가 NOT_FOUND 직행, 사용자가 매번 키워드 줄여야 함 (P1).
  - relevance 라벨이 어떤 토큰이 누락인지 표시 X → 진단 어려움 (P2).
  - assess 후속 큐가 19단계까지 폭증 → LLM 모두 실행 시 과도 (P3).
  - 16,336건 검색 결과에 page 안내 부족 (P3).

### 배포 상태
- 로컬 빌드(`build/index.js`)만 갱신. GitHub `main`에는 미푸시.

## [0.9.4] - 2026-05-19 (로컬 빌드만, GitHub 미푸시)

### Added — 4세법 × 4자료 매트릭스 라이브 테스트에서 발견한 3가지 약점 일괄 보강

**#1. `get_taxlaw_basic_ruling_text` 본문 검색 토큰 AND 매칭 (가장 큰 비대칭 제거)**
- 기존: `query` 전체 문자열을 `includes`로 매칭 → "가지급금 인정이자" 같이 본문에 "가지급금 등으로" 같은 다른 텍스트가 끼면 매칭 실패. 통합검색에선 잡히는데 통칙 단독 호출에선 NOT_FOUND가 나는 비대칭의 원인.
- 신규 export 함수 `tokenizeQuery(query)` / `matchesAllTokens(text, tokens)` 추가:
  - 공백·가운뎃점("·")·하이픈·구두점을 모두 토큰 구분자로 처리하고 토큰별 AND 매칭.
  - "연구·인력개발비" vs "연구인력개발비" vs "연구 인력 개발비" 변형을 모두 매칭하도록 collapsed form(공백·구두점 제거)에서도 보조 검사.
- 적용: `getTaxlawBasicRulingText` 본문 필터(line 2024 일대).

**#2. `search_taxlaw_all`의 `synonym` 기본값 false → true**
- NTS API의 `useSynonymYn`을 매번 명시해야 하던 부담을 해소. 한국 세법 용어는 변형이 많아 동의어 검색이 기본값이어야 합리적.
- 정확매칭만 원할 때 `synonym=false`로 명시. 도구 description에 안내 추가.

**#3. NOT_FOUND 응답에 NTS 사이트 actionId 자동 추천**
- 신규 헬퍼 `lookupSiteActions` + `NOT_FOUND_ACTION_HINTS` 매핑 테이블 추가.
- `notFoundResponse`에 `options.toolName?: string` 파라미터 추가. 도구별로 후속 시도할 만한 actionId(법제처 해석례·감사원 심사청구·납세자보호위원회 심의사례·평가심의사례 등)를 응답 하단에 자동 인라인.
- 적용 도구: `search_taxlaw_all`, `search_taxlaw_documents`, `get_taxlaw_document_text`, `get_taxlaw_basic_ruling_text`, `list_taxlaw_basic_ruling_laws`, `search_taxlaw_forms`, `search_taxlaw_publications`, `get_taxlaw_hometax_counsel_text`.
- 사용자/LLM이 NOT_FOUND를 받자마자 다음 호출(`call_taxlaw_action`)을 바로 결정할 수 있어 round-trip 1회 단축.

### Tested
- 단위 테스트 115 → **121** (`tokenizeQuery` 3건, `matchesAllTokens` 3건 신규 추가).
- 신규 테스트가 검증하는 시나리오:
  - 가운뎃점 분리: "연구·인력개발비 세액공제" → `["연구", "인력개발비", "세액공제"]`.
  - 중복 토큰 제거: "가지급금 가지급금 인정이자" → `["가지급금", "인정이자"]`.
  - collapsed form 매칭: 토큰 "연구·인력개발비"가 "연구인력개발비" / "연구 인력 개발비" 본문에서 모두 매칭.
  - null/공백 입력 안전성.

### Motivation
- v0.9.3 self-review에서 4세법(법인세 가지급금 / 소득세 주택임대 분리과세 / 조특법 R&D / 부가세 간주임대료) 매트릭스를 돌린 결과:
  - `get_taxlaw_basic_ruling_text(lawId, query="가지급금 인정이자")` → NOT_FOUND. 통합검색에선 동일 통칙 단편이 회수됨. 본문 인덱싱 비대칭 확인.
  - "연구·인력개발비 세액공제" / "부동산임대 간주임대료 부가가치세" 등 가운뎃점·공백 변형이 들어간 쿼리에서 statute/question/precedent 컬렉션 0건. `synonym` 기본값을 켜 한 호출로 해결.
  - NOT_FOUND 응답에서 LLM이 다음 호출을 결정하려면 `list_taxlaw_site_menus`를 한 번 더 거쳐야 했음. actionId 인라인 노출로 단축.

### 배포 상태
- 로컬 빌드(`build/index.js`)만 갱신. GitHub `main`에는 미푸시.

## [0.9.3] - 2026-05-19 (로컬 빌드만, GitHub 미푸시)

### Added — 4세법 × 4자료 매트릭스 self-review로 발견한 검색 정확도 보강

**#1. `search_taxlaw_documents` description 보강 (taxLawCode 권장 예시 확장)**
- 도구 description에 ⚠️ taxLawCode 권장 안내 추가. "인적용역" 같은 쿼리가 부가세법 + 조특법 양쪽에 매칭되어 세목이 혼재되는 케이스를 LLM이 사전 인지하도록 유도.
- 주요 코드 7개 노출: 303=법인세, 305=종합소득세, 313=부가가치세, 354=조세특례, 311=상속증여세, 308=양도소득세, 309=원천세. 기존엔 303·305만 언급.

**#2. 결과 출력에 세목 코드 prefix 표시**
- `formatDocumentSearchItem`: `세목: 종합소득세` → `세목: 종합소득세 (코드 305)` 형식으로 변경. 사용자가 쿼리와 결과 세목 불일치를 한눈에 인지 가능.
- `TaxlawDcm` 인터페이스에 `NTST_TLAW_CL_CD` 필드 추가.

**#3. relevance_low / relevance_partial ⚠ tag 부착**
- 신규 함수 `judgeRelevance(query, haystack)` 추가. query 토큰(공백 분리, 2글자 이상)을 결과 본문(제목+요지+검색근거)과 substring 매칭.
  - 매칭 0% → `⚠ relevance_low (query 키워드 미포함 — 본문 확인 권장)`
  - 매칭 < 50% (2 토큰 이상일 때만) → `⚠ relevance_partial (query 일부만 매칭)`
  - 매칭 50% 이상 → 표시 없음 (정상)
- 보수적 동작: 한국어는 토큰 분리가 어려워 false-positive ⚠ 가능. 메시지가 "본문 확인 권장"이라 사용자가 무시할 수도 있도록 톤 조절.

### Tested
- 단위 테스트 115 → **115** (회귀 없음, `judgeRelevance`는 index.ts 내부 함수라 별도 export 안 함. 라이브 smoke test로 검증).
- 라이브 검증:
  - `"면세 인적용역 범위"` (taxLawCode 미지정) → 조특법 결과 회수 (v0.9.2 self-review 갭 재현, NTS API 자체 정확도)
  - `"창업감면"` 단일 토큰 → ⚠ relevance_low 부착 (정확 동작)
  - 모든 결과에 `(코드 N)` prefix 부착

### Motivation
- v0.9.2 self-review (4세법 × 4자료 매트릭스)에서 발견한 검색 정밀도 약점 보강.
- 검색 엔진 자체는 NTS API 한계라 외부 의존이지만, MCP 측에서 (1) description으로 사전 안내, (2) 출력에 세목 코드 강조, (3) relevance ⚠로 사후 표시 — 세 단계 방어선 추가.

### 배포 상태
- 로컬 빌드(`build/index.js`)만 갱신. GitHub `main` 브랜치에는 v0.9.1까지만 푸시됨. v0.9.2/v0.9.3은 사용자가 명시적으로 push 지시할 때까지 로컬 상태 유지.

## [0.9.2] - 2026-05-19 (로컬 빌드만, GitHub 미푸시)

### Fixed — v0.9.1 라이브 self-review로 발견한 false-positive 차단

**citation-extract 80자 윈도우 노이즈 → restructure 본문 substring 재확인**
- `citation-extract.ts:91`의 `ARTICLE_PATTERN`이 법령명 발견 후 80자 윈도우 안에서 조 번호를 매칭. 본문에 "조세특례제한법 제6조"가 있고 같은 줄 80자 안에 "부가가치세법"이 있으면 "부가가치세법 + 제6조"라는 false-positive 페어링 발생.
- restructure-map 사전의 `법.제6조 → 법.제8조` 매핑이 잘못 트리거되어 v0.9.1에서 `superseded_or_repealed` 격상되는 케이스 (예: 조심-2026-서-0581) 차단.
- `detectPreRestructureCitations(citations, bodyText?)` 시그니처에 `bodyText` 옵션 파라미터 추가. 본문에 `{법령명}{조 번호}` substring이 실제로 등장하는지 verify. 공백 정규화로 "부가가치세법시행령" / "부가가치세법 시행령" 양쪽 표기 모두 매칭.
- `bodyText` 미전달 시 verify 생략 → v0.9.0/0.9.1 하위호환.
- 호출 지점 통합: `assessDoctrineValidity`에 `bodyText` 입력 파라미터, `index.ts`의 `assess_doctrine_validity` / `get_taxlaw_document_text` 두 곳 모두 본문 전달.

### Tested
- 단위 테스트 111 → **115** (회귀 +4):
  - `test/restructure-map.test.js` +4: false-positive 차단, 본문 등장 verify, 공백 정규화, 하위호환.
- 라이브 NTS API smoke-test 6/6 통과. 조심-2026-서-0581이 v0.9.1의 `🔴 superseded_or_repealed` → v0.9.2의 `🟡 needs_current_check (1:1 대조 권장)`로 정확히 회피.

### Motivation
- v0.9.1 라이브 self-review에서 조심-2026-서-0581이 패치 #2(before_target 회피) 의도와 다른 경로로 떨어지는 문제 발견. 원인이 citation-extract의 80자 윈도우 노이즈로 추적됨. 윈도우 축소는 다른 정상 케이스 회귀 리스크가 있어, 대신 **restructure 룩업 단계에서 본문 substring 재확인**으로 false-positive만 정밀 차단.

### 배포 상태
- 로컬 빌드(`build/index.js`)만 갱신. GitHub `main` 브랜치에는 v0.9.1까지만 푸시됨. v0.9.2는 사용자가 명시적으로 push 지시할 때까지 로컬 상태 유지.

## [0.9.1] - 2026-05-19

### Fixed — self-review로 발견한 2건 갭 해소

**#1. 본문 직접 추출 패스 (메타 fallback 경로의 citations_no_dates 미트리거)**
- `checkYearApplicability`: 관련규정 섹션 추출이 0건이고 메타 fallback도 동작했지만 chunk가 비어 있는 경우, 본문(`bodyText`) 자체에 `extractCitations`를 한 번 더 적용. ARTICLE_HINT_PATTERN으로 "법령명 + 제N조" 형식 인용을 추가 수집.
- 헤더가 없는 본문(`related === null`)일 때도 본문 직접 추출 패스로 citations를 잡으면 분류 로직으로 진행. 이전엔 early return으로 `no_citations` 처리됐던 케이스 다수가 이제 `citations_no_dates` 또는 `target_or_later_inferred`로 정확히 분기.
- `relatedSectionText`/`hasRelatedSection` 출력이 본문 직접 추출 패스와도 안전하게 호환되도록 처리.

**#2. before_target false-positive 완화 (최근 심판례 보호)**
- `determineFinalValidity`: `before_target` 분류 + 생산일자가 targetYear의 3년 이내인 경우 `partially_outdated` 격상 회피하고 `needs_current_check`로 분류.
- 예: 조심-2026-서-0581(2026.04.08)이 본문에 "조특법 §6 (2021.12.28. 개정된 것)" 시점 단서를 인용해도, 심판례 자체가 2026년에 내려진 것이라 인용 법령이 2026년 시점 동일 문구로 살아있을 가능성 높음. 시점 비교만으로 사문화 처리하는 false-positive 차단.

### Tested
- 단위 테스트 108 → **111** (회귀 +3):
  - `test/year-check.test.js` +1: 관련규정 헤더 없는 본문 + 조 번호만 인용 → 본문 직접 추출 패스
  - `test/doctrine-assess.test.js` +2: 최근 심판례 before_target → needs_current_check 회피 + 오래된 케이스 partially_outdated 회귀 유지
- 라이브 NTS API smoke-test 4/4 통과.

### Motivation
- v0.9.0 self-review에서 발견한 두 갭:
  1. `조법1264-488 (1982)` 본문에 "법인세법 시행령 제42조"가 명시되어 있는데도 메타 fallback 경로에서 citations 0건 → `uncertain`(이전엔 v0.7.0 호환)로 분류. v0.9.0 의도(`citations_no_dates`/`target_or_later_inferred`)와 어긋남.
  2. `조심-2026-서-0581 (2026.04)`이 본문에 인용한 조특법 §6의 시점 단서 "(2021.12.28. 개정)"을 그대로 받아 `before_target → partially_outdated`로 격상. 실제 인용 법령은 2026년에도 동일 문구로 살아있는 false-positive.

## [0.9.0] - 2026-05-19

### Added — 사문화 채점 정확도 3대 개선

**#1. 세법 구조개편 이력 사전 (`statute-restructures.json` + `restructure-map.ts`)**
- 신규 데이터 `src/data/statute-restructures.json` — 세법 전부개정으로 인한 옛 조 번호 → 현행 조 번호 매핑. 1차 범위: **부가가치세법 2013.7.1 전부개정** (법 §12 → §26, 시행령 §35 → §42, 시행규칙 §11의3 → §29 등 약 20개 매핑).
- 신규 모듈 `src/restructure-map.ts` — `lookupRestructure(lawName, articleRef)` / `detectPreRestructureCitations(citations)` / `formatRestructureHits(hits)` export. 가장 구체적인 키(조+항+호)부터 fallback 룩업.
- `assess_doctrine_validity` 통합: 인용 조문 추출 후 자동 룩업. 옛 위치 매칭되면 신규 신호 `🔴 [restructured_location]` + finalValidity를 `superseded_or_repealed`로 격상. 답변에 옛 조 번호를 그대로 옮기지 않도록 강제 안내.
- `get_taxlaw_document_text` 응답 말미에 `── 구조개편 이력 자동 검출 ──` 섹션 자동 부착.

**#2. 최근 심판례·해석례 적극 라벨링 (`target_or_later_inferred`)**
- 신규 라벨 `target_or_later_inferred` — 본문에 시점 단서(YYYY.MM.DD)가 없어도 **인용 조문 추출 ≥1건 + 생산일자가 targetYear의 N년 이내**(기본 3년)이면 적극 라벨링. ✅⚠️ 동시 표시(현행 적용 가능성 높음 + 직접 대조 권장).
- 환경변수 `TAXLAW_RECENT_THRESHOLD_YEARS`로 문턱값 override 가능 (기본 3, 양수 정수).
- `checkYearApplicability(input)`에 `productionDate` 신규 입력 파라미터 추가. `index.ts`의 두 호출 지점(`get_taxlaw_document_text` / `assess_doctrine_validity`) 모두 자동 전달.
- 이전엔 `no_citations` ❓로 잘못 분류되던 2023~2026 심판례·해석례 다수가 이제 `target_or_later_inferred` ✅로 분류.

**#3. `no_citations` 라벨 세분화 (`citations_no_dates`)**
- 신규 라벨 `citations_no_dates` — 인용 조문은 추출됐으나 시점 단서가 없는 케이스. 이전엔 `no_citations` / `uncertain`에 섞여 들어갔던 케이스를 분리.
- 라벨 의미 명확화:
  - `no_citations`: 인용 0건 (진짜 비어있음)
  - `citations_no_dates`: 인용 ≥1건, 시점 0건 (v0.9.0 신규)
  - `target_or_later_inferred`: 인용 ≥1건, 시점 0건, 생산 최근 N년 이내 (v0.9.0 신규)
- `extractCitations`에 `ARTICLE_HINT_PATTERN` 추가 — "법령명 + 제N조" 형태만 있어도 chunk 생성(시점·법률번호·개정단서 없어도). 이전엔 chunk가 0건으로 잘못 처리되던 케이스가 해소됨.

**citation-extract.ts 보완 — 공백 없는 옛 표기 대응**
- `LAW_NAME_ALIAS`에 "부가가치세법시행령" / "소득세법시행령" / "법인세법시행령" 등 9개 alias 추가. 2013년 이전 예규 본문에 흔한 표기 정확히 잡음.

### Changed
- `DoctrineAssessment`에 `restructureHits: RestructureHit[]` 필드 신규.
- `DoctrineSignal.kind`에 `restructured_location` / `recent_doctrine_inferred` / `citations_no_dates` 3종 추가.
- `YearCheckClassification`에 `target_or_later_inferred` / `citations_no_dates` 2종 추가. 기존 `uncertain` 호환 유지.

### Tested
- 단위 테스트 86 → **108** (회귀 +22):
  - `test/restructure-map.test.js` 11건 신규 — 룩업 우선순위, 중복 dedupe, 사전 외 법령 null, 공백 없는 표기.
  - `test/year-check.test.js` +8건 — 신규 라벨 분기, 환경변수 override, 메타 fallback 동작.
  - `test/doctrine-assess.test.js` +3건 — 신호 부착·finalValidity 격상.

### Migration
- 라벨 enum 확장은 호출 측 LLM이 신규 라벨을 모를 수 있으나 메시지 텍스트로 의미가 자연어 이해 가능 — 하위호환.
- v0.8.0 사용자 대상 동작 변경: `no_citations`/`uncertain`으로 분류되던 일부 케이스가 v0.9.0에서는 `target_or_later_inferred` / `citations_no_dates` / `superseded_or_repealed`로 더 정확히 분기됨.

### Motivation
- v0.7.0 사문화 채점이 부가세법 2013.7.1 전부개정 같은 "구조 개편으로 인한 조문 위치 이전"을 자동 인식 못해 false-negative 발생. 옛 §35 인용이 명백한 케이스도 `no_citations`로 보수 분류됨.
- 최근 심판례(생산 ≤3년)는 본문에 (YYYY.MM.DD) 시점 단서가 없는 경우가 많아 인용 9건 추출됐어도 ❓ 라벨로 떨어짐. 적극 라벨링 + 단서 부착으로 사용자 효용 향상.

## [0.8.0] - 2026-05-19

### Added
- **기본통칙 인용 자동 검증 (환각·누락 방지 강제 절차)**
  - 신규 모듈 export `extractBasicRulingRefs(text)` / `formatBasicRulingRef(ref)` (`src/citation-extract.ts`) — 본문에 인용된 기본통칙 번호를 옛 형식("N-N", 예: 27-12)과 현행 형식("N-N…M", 예: 27-55…10)으로 구분 추출. 통칙 번호 체계는 과거 짧은 "N-N" 형식이었다가 현행은 "N-N…M" 형식으로 재편되어, 옛 질의회신·해석례 본문에 인용된 옛 번호를 그대로 옮기면 환각이 됨.
  - `get_taxlaw_document_text` 응답에 통칙 인용 자동 검출 섹션 추가. 옛 번호 형식 발견 시 ⚠ 경고와 함께 `list_taxlaw_basic_ruling_laws` + `get_taxlaw_basic_ruling_text` 호출을 강제. 단건 호출이 아닌 주제 키워드 호출로 인접 번호대를 일괄 수집하도록 안내해 관련 통칙 군집 누락 방지.
  - INSTRUCTIONS 5단 응답 가이드에 `[기본통칙 인용 검증 — 환각·누락 방지 강제 절차]` 4단계 추가. 옛 번호("N-N")는 답변 노출 금지, 현행 번호 미확인 시 ⚠ 표기 강제.

### Tested
- `test/citation-extract.test.js` 7건 추가 (옛/현행 형식 구분, HORIZONTAL ELLIPSIS·3-dot 표기, 혼합 본문, 통칙 키워드 없는 조-호 표기 오인 차단, format 라벨링).

### Motivation
- 사용자 환경에서 2006년 「서면인터넷방문상담1팀-626」 질의회신 본문의 "소득세법 기본통칙 27-12" 인용을 검증 없이 옮긴 환각 사례 발생. 현행 정확한 통칙 번호는 「27-55…10」이며 인접 통칙 27-55…11(임차건물 보험료) / 27-55…12(보험사고 시 적립보험료 처리)도 함께 누락. 통칙 도구가 가용함에도 자동 호출 트리거가 없어 발생한 구조적 문제를 instructions + 응답 자동 검출 양쪽으로 차단.

## [0.7.1] - 2026-05-19

### Fixed
라이브 NTS API 검증에서 발견된 회귀 2건:
- **citation 추출 — "법률/대통령령 제N호" 노이즈**: 본문에 "법률 제4666호로 전부 개정된 것" / "대통령령 제15976호로 전문개정된 것" 같은 표기가 흔한데, 기존 `ITEM_PATTERN`이 이 법령번호도 호(item)로 잘못 매칭. 헌재 위헌결정 본문의 `조세특례제한법 시행령 제138조 제15976호` 같은 거짓 인용 다수 발생.
  - 수정: ITEM_PATTERN에 negative lookbehind 추가 (`(?<!(?:법률|대통령령|총리령|부령|...)\s)제\s?(\d+)\s?호`).
  - 추가 보호: 호(item)는 조(article) 또는 항(paragraph) 없이 단독으로 존재하지 않음 — 단독 "제N호"는 매치 무효.
- **헌재·심판례 본문 supersession 미감지**: 본문이 길고 줄 단위 chunk 분리 한계로 `(구)법령`/`폐지된 「법령」`이 별도 줄에 있을 때 amendment_clue/supersession_clue가 격상되지 않던 문제. 라이브 검증에서 헌재 2009헌바35,82(위헌결정) → 잘못된 `unverified`, 토지초과이득세 부동산-1190 → 잘못된 `likely_outdated` (실제: 모두 `superseded_or_repealed` 분류 대상).
  - 수정: `checkYearApplicability`가 본문 전체에 대해 supersession grep을 별도 수행 (`전부\s*개정|폐지된|폐지\s*\)|\(\s*구\s*\)\s*[가-힣]+법`). citation chunk별 분리 한계와 무관하게 격상.
  - citations.length=0이거나 latestDate 추출 실패해도 본문 supersession 단서 있으면 `repealed_or_superseded`로 격상.

### Tested
- 라이브 NTS API에 STDIO MCP 호출(`scripts/smoke-test.mjs`)로 5건 검증:
  - 헌재 2009-헌바-35,82 (위헌) → `repealed_or_superseded` ✓
  - 서면1팀-1219 (외국인근로자 2007) → `before_target` → `likely_outdated` ✓
  - 부동산-1190 (토지초과이득세 2010) → `repealed_or_superseded` ✓
  - 서면-2025-4517 (사내복지기금 2026) → `uncertain` → `unverified` ✓ (정직한 처리)
  - 법인1264.21-61 (1985) → `uncertain` → `unverified` ✓
- 단위 테스트 75 → **79** (회귀 4건 추가): 본문 전체 grep 격상, citation 노이즈 제거.

## [0.7.0] - 2026-05-19

### Added
- 신규 도구 **`assess_doctrine_validity`** — 세법해석례·심판례·판례 단일 문서의 **현행 유효성 자동 채점**. 호출 한 번에:
  - 본문/메타데이터에서 인용 법조문 시점 파싱
  - targetYear 대비 사문화 위험 신호 점수화 (vintage, citation_vintage, amendment_clue, supersession_clue, no_target, no_citations, missing_metadata)
  - 최종 판정 6단계: `valid_current` / `needs_current_check` / `partially_outdated` / `likely_outdated` / `superseded_or_repealed` / `unverified`
  - 권장 후속 호출 큐 (`korean-law-mcp.search_law/get_law_text/search_decisions` + 본 MCP의 후일자 해석례 검색) 반환
  - LLM은 next-action 큐를 순서대로 실행해서 답변의 채점표에 결과를 채움
- 신규 모듈 `src/citation-extract.ts` — 인용 법령명·조·항·호 구조화 추출 (조특법/조특/소득세 등 약칭→정식 명칭 매핑, 시행령/시행규칙 구분).
- 신규 모듈 `src/doctrine-assess.ts` — 사문화 평가 오케스트레이터. 채점표(matrix) + 신호(signals) + next-action queue 생성.

### Changed
- `src/year-check.ts` 강화:
  - **헤더 패턴 9종 → 14종**으로 확장: "관련 조세법령(법률, 시행령, 시행규칙, 기본통칙)", "관련 세법", "근거 법령", "참고 법령", "인용 법령", 그리고 헌재/판례 양식의 `[심판대상조문]` / `[참조조문]` / `[심판의 대상]` 등 대괄호 헤더.
  - **메타데이터 fallback 추가**: 본문에서 헤더를 못 찾으면 문서 기본정보의 `관련법령:` 필드(`dcmRltnStttList`)를 인용 텍스트로 fallback. 자동검증 적용 범위가 크게 확장.
  - **classification 5단 → 8단**: `valid_current`(인용 시점 ≥ target + 개정 단서 없음), `partially_outdated`(before_target + amendment clue), `repealed_or_superseded`(폐지·전부개정 단서 감지), `target_or_later`(인용 시점 ≥ target + amendment clue), `before_target`, `no_citations`, `no_target`, `uncertain`.
  - 개정 단서 패턴 확장: "(구) 법령명", "구 [법령]", "폐지된 「법령」", "전부 개정" (띄어쓰기 변형 포함) 등 헌재/심판례 본문 양식 매치.
- `get_taxlaw_document_text`가 year-check 호출 시 메타데이터 fallback도 함께 전달.

### Tested
- 단위 테스트 **57 → 75개** (year-check 신규 7건, citation-extract 6건, doctrine-assess 6건 추가).
- **자체 회귀 검증 20건** (`fixtures/self-review/*.json` + `scripts/self-review.mjs`): 어제 인용된 외국인근로자 4건, 다양 vintage 라이브 4건, 헌재 위헌결정 1건, 헌재 합헌 1건, 1980s 법인세 2건, 2026 심판례 2건, 부가세 영세율 판례 2건, 합성 boundary 케이스 4건. **expected 일치율 20/20 (100%)**.
- 검증된 식별 정확도:
  - 헌재 위헌결정 (2009헌바35,82) → `superseded_or_repealed` 자동 분류 (본문 "전부 개정" + 구법명 단서로 식별)
  - 폐지된 토지초과이득세법 인용 (부동산-1190, 2010) → `superseded_or_repealed`
  - 외국인근로자 단일세율 인용례 4건 (2006~2010, 2026 target) → 모두 `likely_outdated`
  - 최신 NTS 해석례 (2026) → `unverified` (시점 단서 없음 + 메타 fallback 우회) — 정직한 표기

### Migration / Compatibility
- 기존 도구(`get_taxlaw_document_text` 등)의 시그니처와 출력 호환. 추가 정보(분류 라벨, fallback 표기)만 늘어남.
- `YearCheckResult` 인터페이스에 `usedMetadataFallback`, `classificationLabel` 필드 추가.

## [0.6.0] - 2026-05-18

### Added
- `Server` 생성자에 `instructions` 옵션 주입. MCP `InitializeResult.instructions`로 전달되어 클라이언트(Claude Code 등)가 system-reminder 형태로 LLM에 자동 노출. 5단 응답 포맷(결론 → 매트릭스 → 법령 래퍼 → AI 보충 → 인용/피드백 prompt)을 LLM이 항상 따르도록 강제.
- 응답 포맷 핵심 규칙:
  - **출처 격리** — 법률/시행령/통칙/해석례 4단을 섹션별 분리, AI 보충은 별도 ⚠ 단락
  - **연도 검증 의무** — 해석례 인용 시 `get_taxlaw_document_text(targetYear=YYYY)` 호출 명시
  - **중복 처리** — korean-law-mcp와 양쪽에서 회수된 동일 사건은 문서번호/일자/제목으로 합치고 양쪽 출처 ID 병기

### Changed
- 버전 0.6.0.
- 기존 `COMPANION_NOTICE`(각 도구 description에 박힌 동반호출 안내)는 그대로 유지. 도구 호출 시점의 즉시 신호로 유효하며 instructions와 상호 보완.

## [0.5.2] - 2026-05-14

### Fixed
- CI: `Run unit tests` 단계가 `node --test test/utils.test.js`만 돌려 0.5.x 신규 테스트 23 케이스(upjong/year-check)를 검증하지 않던 문제 → `npm test`로 변경.
- `classifyIndustryForArticle` reasoning 메시지에 잔존하던 "16호 산업명이…" 하드코딩 표현 → 호 중립적 문구로 일반화.

### Docs
- README-EN을 0.5.x 도구셋으로 갱신: 업종코드↔KSIC 매핑 7개 도구, `targetYear` 옵션, Codex/Claude Code 설치 절차, 업데이트 절차.

## [0.5.1] - 2026-05-14

### Changed
- `src/data/upjong-ksic.json`(귀속연도 2024, 1,784 레코드)을 저장소에 포함. 사용자가 추가 CSV 다운로드·환경변수 설정 없이 `git clone + npm install + npm run build`만으로 모든 업종코드 도구 즉시 동작.
- `.gitignore`에서 `src/data/upjong-ksic.json` 제외 처리 해제.
- README의 설치 안내 단순화 — CSV 다운로드는 선택적(최신화 시에만).

## [0.5.0] - 2026-05-14

### Added

- `lookup_ksic_prefix` 신규 도구 — KSIC 코드 prefix(영문 1자리 대분류 / 2~5자리 숫자) 매칭. `lookup_ksic_code`(5자리 정확)와 별개. 부동산 임대업 6811, 통신판매업 4791, 청소업 7421 등 prefix 패턴이 조특법 §6/§7 작업에서 빈번히 필요했음.
- `search_industry_by_keyword`에 `levels` 인자 추가 — 검색 분류수준 한정 가능. 호별 제외 단서 차감 시 l3~l5로 좁히면 상위 레벨 분류명에 잘못 휘말리는 것 방지.
- `resolve_industry_class`에 `levels` 인자 추가 — 동일 목적.
- `classify_industry_for_article`에 `excludeLevels` 인자 추가 — 제외 단서 검색 분류수준 한정. 7호 음식점업에서 '주점' 차감 시 l2 '음식점 및 주점업'에 휘말리는 버그를 클라이언트 부담 없이 차단.
- 테스트 6 케이스 추가 (총 57). KSIC prefix 매칭, levels 한정 동작 검증.

### Changed

- 버전 0.5.0.
- 모든 도구 description에 조특법 §6/§7 실제 사용 사례 인용 (LLM 사용 가이드).

## [0.4.0] - 2026-05-14

### Added

- `get_taxlaw_document_text`에 `targetYear` 파라미터. 본문 '관련규정/관련법령' 섹션을 자동 파싱해 인용 법조문의 법률번호·일자·개정 단서를 추출하고, 사용자가 적용하려는 연도와 비교한다. 구법조문 기반이면 `before_target` 분류 + 경고 동봉. 모든 결과는 `korean-law-mcp`로 직접 대조 후 보고하도록 안내.
- 업종코드↔KSIC 매핑 DB 내장: `src/data/upjong-ksic.json` (귀속연도 2024, 1,784 레코드). 빌드 시 `scripts/build-upjong-db.mjs`가 국세청 연계표 CSV를 JSON으로 변환.
- 신규 도구 6개:
  - `lookup_upjong_code` — 6자리 업종코드 → 5단계 분류 + KSIC 매핑.
  - `lookup_ksic_code` — KSIC → 매핑된 업종코드 목록.
  - `search_industry_by_keyword` — 정규화 키워드 검색.
  - `resolve_industry_class` — 분류명 → 어느 분류수준(대/중/소/세/세세)에 해당하는지 후보 반환.
  - `classify_industry_for_article` — 법조문 산업명·제외 단서·업종코드 → match/excluded/out_of_scope/ambiguous 판정. 분류수준 자동 식별로 LLM의 잘못된 매핑(예: 749942를 조특법시행령 27-3 16호에 잘못 포함)을 방지.
  - `upjong_db_info` — 내장 DB 신선도(생성시각·원본·귀속연도·레코드 수).
- 테스트: `test/upjong.test.js` (11 케이스, 749942 / 852000 사례 포함), `test/year-check.test.js` (6 케이스).

### Changed

- 모든 주요 도구 description에 `korean-law-mcp` 동반 호출 의무 명시(`COMPANION_NOTICE`).
- `docs/tools.md` 문서에 동반 호출 의무·연도 검증 절차·업종코드 도구 사용 예 추가.
- 버전 0.4.0.

## [0.3.6] - 2026-05-10

### Changed

- Publication enrichment concurrency raised from 4 to 8 — preserves per-host politeness while roughly halving the wall-clock time of `search_taxlaw_publications` with `display=20+`. READMEs updated accordingly.

## [0.3.5] - 2026-05-10

### Added

- Unit tests (`test/utils.test.js`) for pure helpers: `truncate`, `decodeHtml`, `htmlToText`, `cleanText`, `normalizeDate`, `normalizeDetailId`, `normalizeTaxlawPath`, `documentDateValue`, `documentDedupKey`, `isEmptyPayload` — 35 cases via Node's built-in `node:test`.
- GitHub Actions CI (`.github/workflows/ci.yml`): build + tsc check + tests + `npm pack --dry-run` on Ubuntu/Windows/macOS × Node 20.19.x/22.x.
- `pretest` / `test` scripts in `package.json` so `npm test` builds first then runs the suite.
- Terms-of-use & legal-notice section in both READMEs covering NTS compliance, identification, rate-limit etiquette, and disclaimer.
- Internal `mapWithConcurrency` helper for bounded parallel fetches.

### Changed

- Default User-Agent switched from a Chrome-spoof string to `taxlaw-nts-mcp/<version> (+repo URL)` so requests identify themselves transparently to NTS. `TAXLAW_USER_AGENT` still overrides if NTS blocks the default.
- `enrichPublicationItem` parallelism capped at 4 concurrent requests (was unbounded — could fire 50 simultaneous fetches when `display=50`) to reduce risk of NTS rate-limiting / blocking.
- `fetchWithRetry` per-attempt timeout reduced from 30s to 15s, cutting the worst-case hang for unresponsive NTS endpoints by half.
- Pure utility functions (`truncate`, `decodeHtml`, `htmlToText`, `cleanText`, `normalizeDate`, `normalizeDetailId`, `normalizeTaxlawPath`, `documentDateValue`, `documentDedupKey`, `isEmptyPayload`, `TaxlawMcpError`, `ErrorCodes`) are now ESM-exported so external test/tooling can import them.
- `main()` invocation gated behind `TAXLAW_MCP_TEST_MODE !== "1"` so importing the built module from tests no longer launches the stdio server.

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
