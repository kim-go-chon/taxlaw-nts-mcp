# Changelog

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
