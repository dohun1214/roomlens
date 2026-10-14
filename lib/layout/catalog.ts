// 가구 카탈로그. DB의 furniture_catalog 테이블이 원본이고, DB 없이 여는 화면(/viewer)은 아래 기본값을 쓴다.

export type CatalogItem = {
  id: string;
  /** 카탈로그 가구(기본값)인지 사용자가 만든 내 가구인지 */
  kind?: 'catalog' | 'user';
  nameKo: string;
  category: string;
  /** 가로 × 깊이 × 높이 (m) */
  w: number;
  d: number;
  h: number;
  /** 앞에 비워 둘 공간 (m). 통로·접근 검사에 쓴다 */
  clearance: number;
  /** 3D 모델(GLB)을 받을 주소. 없으면 상자로 그린다 */
  modelUrl?: string | null;
  /** 3D 모델의 출처·라이선스 */
  license?: string | null;
};

export type CatalogRow = {
  id: string;
  name_ko: string;
  category: string;
  width_m: number;
  depth_m: number;
  height_m: number;
  clearance_m: number;
  license?: string | null;
};

export function fromCatalogRow(row: CatalogRow, modelUrl?: string | null): CatalogItem {
  return {
    ...(modelUrl ? { modelUrl } : {}),
    ...(row.license ? { license: row.license } : {}),
    id: row.id,
    nameKo: row.name_ko,
    category: row.category,
    w: Number(row.width_m),
    d: Number(row.depth_m),
    h: Number(row.height_m),
    clearance: Number(row.clearance_m),
  };
}

/**
 * supabase/migrations 의 furniture_catalog 와 같은 값.
 * 치수는 3D 모델(실제 판매 상품)의 실제 크기를 cm로 반올림한 것이다 (scripts/dev-data/build-furniture-models.mjs).
 * 침대 높이는 머리판까지 잰다. 슈퍼싱글은 싱글과 같은 모델을 폭만 넓힌다.
 */
export const DEFAULT_CATALOG: CatalogItem[] = [
  { id: 'bed-single', nameKo: '싱글 침대', category: 'bed', w: 0.99, d: 2.14, h: 0.92, clearance: 0.6 },
  { id: 'bed-super-single', nameKo: '슈퍼싱글 침대', category: 'bed', w: 1.1, d: 2.14, h: 0.92, clearance: 0.6 },
  { id: 'bed-queen', nameKo: '퀸 침대', category: 'bed', w: 1.47, d: 1.99, h: 0.94, clearance: 0.6 },
  { id: 'desk', nameKo: '책상', category: 'desk', w: 1.25, d: 0.6, h: 0.77, clearance: 0.7 },
  { id: 'chair', nameKo: '의자', category: 'chair', w: 0.66, d: 0.6, h: 0.82, clearance: 0 },
  { id: 'wardrobe', nameKo: '옷장', category: 'storage', w: 1.0, d: 0.6, h: 1.96, clearance: 0.6 },
  { id: 'hanger', nameKo: '행거', category: 'storage', w: 1.01, d: 0.4, h: 1.5, clearance: 0.6 },
  { id: 'drawer', nameKo: '서랍장', category: 'storage', w: 0.8, d: 0.43, h: 0.8, clearance: 0.6 },
  { id: 'table-2', nameKo: '2인 식탁', category: 'table', w: 0.75, d: 0.75, h: 0.74, clearance: 0.6 },
  { id: 'bookcase', nameKo: '책장', category: 'storage', w: 0.87, d: 0.36, h: 1.86, clearance: 0.6 },
];

/** 카탈로그 가구 모델들의 출처 (겹치지 않게, 처음 나온 순서대로). 화면에 출처를 밝힐 때 쓴다 */
export function modelCredits(catalog: CatalogItem[]): string[] {
  return [...new Set(catalog.filter((item) => item.modelUrl && item.license).map((item) => item.license as string))];
}

const CATEGORY_COLORS: Record<string, number> = {
  bed: 0x6fa8dc,
  desk: 0xe0a458,
  chair: 0xc27ba0,
  storage: 0x93c47d,
  table: 0xd5a6bd,
  // 내 가구의 기본 분류
  etc: 0xb4a7d6,
};

/** 박스 가구의 색 (종류별). 모르는 종류는 회색 */
export function categoryColor(category: string): number {
  return CATEGORY_COLORS[category] ?? 0xb7b7b7;
}
