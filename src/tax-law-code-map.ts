// v0.9.5 — NTS taxLawCode 실제 매핑표.
// v0.9.4까지 schema description은 일반 세법명(예: 308=양도소득세)으로 안내했지만,
// 라이브 검증(taxLawCode= 단독 호출) 결과 NTS 내부 분류는 다음과 같음.
//
// v0.9.8 — v0.9.5의 묶음 가정("305에 양도세 포함", "313에 부가세 포함")이 라이브 응답
// 라벨과 어긋남을 확인. NTS는 단일 세분화 코드 체계를 사용하며, 검색 파라미터와
// 응답 라벨이 동일 코드:
//   303=법인세
//   305=종합소득세            (양도세 별도 코드)
//   306=부가가치세            (소비세 묶음과 별개)
//   307=양도소득세            (305와 별개)
//   308=상속증여세
//   309=조세특례              (354와 별개로 응답 라벨로 등장)
//   310=국제조세              (외국법인·비거주자·조세조약)
//   311=종합부동산세
//   312=원천세                (직접 호출 시 NOT_FOUND 빈번. 305 호출 시 mismatch로 노출됨)
//   313=소비세                (개별소비세·주세·인지세 묶음 — 부가세 제외)
//   354=조세특례제한법        ⚠ deprecated — 라이브 0건 확인. 조세특례 검색은 309 사용.
//
// NTS API의 taxLawCode 필터링은 strict하지 않아(다른 코드 케이스가 가끔 섞여 회수됨)
// post-fetch 필터링이 함께 필요. 예: 305 호출에 312가 1건 섞임(라이브 확인).

export interface TaxLawCodeEntry {
  code: string
  ntsLabel: string          // NTS 응답에 표시되는 분류명
  taxes: string[]           // 이 코드에 포함되는 실제 세목 (실무명)
  hint?: string             // LLM·사용자에게 줄 추가 안내
  deprecated?: boolean      // v0.9.10 — taxLawCodeReference()의 ⚠deprecated 마커 부착 여부.
                            // hint 본문의 "deprecated" 키워드 substring 매칭은 false positive
                            // (예: 309 hint가 354의 deprecation을 언급) 유발 — 명시 필드로 교체.
}

export const TAX_LAW_CODE_MAP: Record<string, TaxLawCodeEntry> = {
  "303": { code: "303", ntsLabel: "법인세", taxes: ["법인세"] },
  "305": {
    code: "305",
    ntsLabel: "종합소득세",
    taxes: ["종합소득세"],
    hint: "v0.9.8 정정 — 양도세는 별도 코드 307. 305는 종합소득세 단독.",
  },
  "306": {
    code: "306",
    ntsLabel: "부가가치세",
    taxes: ["부가가치세"],
    hint: "v0.9.8 추가 — v0.9.5까지 '313 소비세 묶음에 포함'으로 잘못 안내됨. 부가세는 별도 306.",
  },
  "307": {
    code: "307",
    ntsLabel: "양도소득세",
    taxes: ["양도소득세"],
    hint: "v0.9.8 추가 — v0.9.5까지 '305 종합소득세 묶음에 포함'으로 잘못 안내됨. 양도세는 별도 307.",
  },
  "308": {
    code: "308",
    ntsLabel: "상속증여세",
    taxes: ["상속세", "증여세"],
    hint: "v0.9.4까지 schema에서 잘못 안내된 코드. 양도세는 305가 아니라 별도 307 사용.",
  },
  "309": {
    code: "309",
    ntsLabel: "조세특례",
    taxes: ["조세특례제한법"],
    hint: "v0.9.8 — 조세특례 검색은 309 사용. 354(조세특례제한법)는 라이브 0건 확인되어 deprecated.",
  },
  "310": {
    code: "310",
    ntsLabel: "국제조세",
    taxes: ["국제조세조정", "외국법인", "비거주자", "조세조약"],
    hint: "v0.9.8 추가 — 외국법인·비거주자·조세조약 관련 해석례.",
  },
  "311": {
    code: "311",
    ntsLabel: "종합부동산세",
    taxes: ["종합부동산세"],
    hint: "v0.9.4까지 schema에서 잘못 안내된 코드(상속증여세로 표기됨). 상증세는 308 사용.",
  },
  "312": {
    code: "312",
    ntsLabel: "원천세",
    taxes: ["원천세"],
    hint: "v0.9.8 — taxLawCode=312 직접 호출은 NOT_FOUND 빈번. 305(종합소득세) 호출 시 mismatch로 노출됨. NTS 인덱싱 quirk.",
  },
  "313": {
    code: "313",
    ntsLabel: "소비세",
    taxes: ["개별소비세", "주세", "인지세"],
    hint: "v0.9.8 정정 — 부가가치세는 별도 306. 313은 개별소비세·주세·인지세 묶음.",
  },
  "354": {
    code: "354",
    ntsLabel: "조세특례제한법",
    taxes: ["조세특례제한법"],
    hint: "⚠ deprecated v0.9.8 — 라이브 0건. 조세특례 검색은 309 사용. 매핑 보존은 legacy 호환용.",
    deprecated: true,
  },
}

/**
 * 코드 → 사용자 친화 표기. NTS 원본명과 실무 묶음을 병기.
 * 예: "313" → "소비세 (코드 313) [부가가치세·개별소비세·주세·인지세]"
 */
export function describeTaxLawCode(code: string | undefined | null): string {
  if (!code) return ""
  const entry = TAX_LAW_CODE_MAP[String(code)]
  if (!entry) return `(코드 ${code})`
  const taxes = entry.taxes.length > 1 ? ` [${entry.taxes.join("·")}]` : ""
  return `${entry.ntsLabel} (코드 ${entry.code})${taxes}`
}

/**
 * post-fetch 필터링. NTS API가 taxLawCode 파라미터를 strict하게 적용하지 않는 경우
 * 응답에 다른 코드 케이스가 섞여 회수됨. 요청 코드와 응답 코드 일치 여부 판정.
 */
export function taxLawCodeMatches(requestedCode: string | undefined, responseCode: string | undefined): boolean {
  if (!requestedCode) return true
  const req = String(requestedCode).trim()
  const res = String(responseCode || "").trim()
  return req === res
}

/**
 * v0.9.6 — `formatTaxLawCell`의 축약형. 응답 항목 반복 출력에서 매번 묶음(`부가가치세·...`)
 * 부가설명을 반복하지 않도록 코드만 인라인. 묶음 안내는 응답 헤더(`formatTaxLawCodeHeader`)에
 * 1회만 출력.
 */
export function formatTaxLawCellCompact(ntsName: string | undefined, code: string | undefined): string {
  const cleanName = (ntsName || "").trim() || "N/A"
  const cleanCode = String(code || "").trim()
  if (!cleanCode) return cleanName
  const entry = TAX_LAW_CODE_MAP[cleanCode]
  if (!entry) return `${cleanName}(${cleanCode})`
  const showCanonical = cleanName !== entry.ntsLabel ? ` [정규명:${entry.ntsLabel}]` : ""
  return `${cleanName}(${cleanCode})${showCanonical}`
}

/**
 * v0.9.6 — 응답에 등장한 unique 세목 코드를 헤더 1줄로 안내.
 * 매 항목에 반복 출력되던 묶음세 부가설명(예: `(부가가치세·개별소비세·주세·인지세)`)을 1회만 출력.
 *
 * v0.9.7 — 매핑표 외 코드(예: 310 국제조세, 309 조세특례)도 NTS 응답 분류명을 사용해
 * 헤더에 포함. v0.9.6는 매핑표 외 코드를 skip하여 결과에 등장한 다른 코드가 헤더에서
 * 누락되는 비대칭(항목별 출력은 그대로 노출됨)이 있었음.
 */
export function formatTaxLawCodeHeader(items: Array<{ code?: string; name?: string }>): string {
  const parts: string[] = []
  const seen = new Set<string>()
  for (const it of items) {
    const code = String(it.code || "").trim()
    if (!code || seen.has(code)) continue
    seen.add(code)
    const entry = TAX_LAW_CODE_MAP[code]
    if (entry) {
      const taxes = entry.taxes.length > 1 ? `(${entry.taxes.join("·")})` : ""
      parts.push(`${code}=${entry.ntsLabel}${taxes}`)
    } else {
      const name = String(it.name || "").trim() || "분류명 미확인"
      parts.push(`${code}=${name}`)
    }
  }
  if (parts.length === 0) return ""
  return `※ 세목 코드: ${parts.join(", ")}`
}

/**
 * 코드 매핑 안내 문자열(도구 description 등에서 재사용).
 */
export function taxLawCodeReference(): string {
  const lines = Object.values(TAX_LAW_CODE_MAP).map((entry) => {
    const taxes = entry.taxes.length > 1 ? ` (${entry.taxes.join("·")})` : ""
    const deprecated = entry.deprecated ? " ⚠deprecated" : ""
    return `${entry.code}=${entry.ntsLabel}${taxes}${deprecated}`
  })
  return lines.join(", ")
}
