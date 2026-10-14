// 가구 카탈로그. DB의 furniture_catalog 테이블이 원본이고, DB 없이 여는 화면(/viewer)은 아래 기본값을 쓴다.

export type CatalogItem = {
  id: string;
  /** 카탈로그 가구(기본값)인지 사용자가 만든 내 가구인지 */
  kind?: 'catalog' | 'user';
  /** 가구 종류의 이름 ("책상"). 배치 검사 문구·AI에 쓴다 */
  nameKo: string;
  /** 같은 종류 안에서 모양을 가르는 말 ("서랍형"). 카탈로그 목록에만 보인다 */
  styleKo?: string | null;
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
  style_ko?: string | null;
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
    ...(row.style_ko ? { styleKo: row.style_ko } : {}),
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
 * supabase/migrations 의 furniture_catalog 와 같은 값 (종류마다 두 가지 모양, 두 번째 id는 끝에 -b).
 * 치수는 3D 모델(실제 판매 상품)의 실제 크기를 cm로 반올림한 것이다 (scripts/dev-data/build-furniture-models.mjs).
 * 침대 높이는 머리판까지 잰다. 슈퍼싱글은 싱글과 같은 모델을 폭만 넓힌다.
 */
export const DEFAULT_CATALOG: CatalogItem[] = [
  { id: 'bed-single', nameKo: '싱글 침대', styleKo: '원목', category: 'bed', w: 0.99, d: 2.14, h: 0.92, clearance: 0.6 },
  { id: 'bed-single-b', nameKo: '싱글 침대', styleKo: '철제', category: 'bed', w: 0.99, d: 1.93, h: 0.97, clearance: 0.6 },
  { id: 'bed-super-single', nameKo: '슈퍼싱글 침대', styleKo: '원목', category: 'bed', w: 1.1, d: 2.14, h: 0.92, clearance: 0.6 },
  { id: 'bed-super-single-b', nameKo: '슈퍼싱글 침대', styleKo: '철제', category: 'bed', w: 1.1, d: 1.93, h: 0.97, clearance: 0.6 },
  { id: 'bed-queen', nameKo: '퀸 침대', styleKo: '원목', category: 'bed', w: 1.47, d: 1.99, h: 0.94, clearance: 0.6 },
  { id: 'bed-queen-b', nameKo: '퀸 침대', styleKo: '철제', category: 'bed', w: 1.52, d: 2.06, h: 0.97, clearance: 0.6 },
  { id: 'desk', nameKo: '책상', styleKo: '서랍형', category: 'desk', w: 1.25, d: 0.6, h: 0.77, clearance: 0.7 },
  { id: 'desk-b', nameKo: '책상', styleKo: '철제 다리', category: 'desk', w: 1.2, d: 0.6, h: 0.75, clearance: 0.7 },
  { id: 'chair', nameKo: '의자', styleKo: '회전', category: 'chair', w: 0.66, d: 0.6, h: 0.82, clearance: 0 },
  { id: 'chair-b', nameKo: '의자', styleKo: '원목', category: 'chair', w: 0.5, d: 0.5, h: 0.8, clearance: 0 },
  { id: 'wardrobe', nameKo: '옷장', styleKo: '원목', category: 'storage', w: 1, d: 0.6, h: 1.96, clearance: 0.6 },
  { id: 'wardrobe-b', nameKo: '옷장', styleKo: '화이트', category: 'storage', w: 0.86, d: 0.6, h: 2.04, clearance: 0.6 },
  { id: 'hanger', nameKo: '행거', styleKo: '선반형', category: 'storage', w: 1.01, d: 0.4, h: 1.5, clearance: 0.6 },
  { id: 'hanger-b', nameKo: '행거', styleKo: '심플', category: 'storage', w: 0.9, d: 0.5, h: 1.5, clearance: 0.6 },
  { id: 'drawer', nameKo: '서랍장', styleKo: '원목', category: 'storage', w: 0.8, d: 0.43, h: 0.8, clearance: 0.6 },
  { id: 'drawer-b', nameKo: '서랍장', styleKo: '화이트', category: 'storage', w: 0.91, d: 0.46, h: 0.72, clearance: 0.6 },
  { id: 'table-2', nameKo: '2인 식탁', styleKo: '정사각', category: 'table', w: 0.75, d: 0.75, h: 0.74, clearance: 0.6 },
  { id: 'table-2-b', nameKo: '2인 식탁', styleKo: '원목', category: 'table', w: 1.03, d: 0.76, h: 0.76, clearance: 0.6 },
  { id: 'bookcase', nameKo: '책장', styleKo: '철제', category: 'storage', w: 0.87, d: 0.36, h: 1.86, clearance: 0.6 },
  { id: 'bookcase-b', nameKo: '책장', styleKo: '화이트', category: 'storage', w: 1, d: 0.26, h: 2.08, clearance: 0.6 },
  { id: 'sofa', nameKo: '소파', styleKo: '화이트', category: 'sofa', w: 1.7, d: 0.96, h: 0.89, clearance: 0.6 },
  { id: 'sofa-b', nameKo: '소파', styleKo: '차콜', category: 'sofa', w: 1.75, d: 0.97, h: 0.92, clearance: 0.6 },
  { id: 'tv-stand', nameKo: 'TV장', styleKo: '원목', category: 'storage', w: 1.6, d: 0.42, h: 0.55, clearance: 0.5 },
  { id: 'tv-stand-b', nameKo: 'TV장', styleKo: '블랙', category: 'storage', w: 1.31, d: 0.39, h: 0.52, clearance: 0.5 },
  { id: 'nightstand', nameKo: '협탁', styleKo: '원목', category: 'storage', w: 0.56, d: 0.44, h: 0.47, clearance: 0 },
  { id: 'nightstand-b', nameKo: '협탁', styleKo: '화이트', category: 'storage', w: 0.4, d: 0.36, h: 0.56, clearance: 0 },
  { id: 'coffee-table', nameKo: '커피테이블', styleKo: '화이트', category: 'table', w: 1.2, d: 0.6, h: 0.45, clearance: 0 },
  { id: 'coffee-table-b', nameKo: '커피테이블', styleKo: '원목', category: 'table', w: 1.19, d: 0.61, h: 0.33, clearance: 0 },
  { id: 'shoe-cabinet', nameKo: '신발장', styleKo: '화이트', category: 'storage', w: 0.52, d: 0.26, h: 1.63, clearance: 0.5 },
  { id: 'shoe-cabinet-b', nameKo: '신발장', styleKo: '블랙', category: 'storage', w: 0.75, d: 0.25, h: 1.28, clearance: 0.5 },
  { id: 'vanity', nameKo: '화장대', styleKo: '거울·의자 세트', category: 'desk', w: 0.88, d: 1.21, h: 1.63, clearance: 0.3 },
  { id: 'vanity-b', nameKo: '화장대', styleKo: '서랍형', category: 'desk', w: 0.93, d: 0.38, h: 0.79, clearance: 0.7 },
  { id: 'bench', nameKo: '수납 벤치', styleKo: '블랙', category: 'chair', w: 0.97, d: 0.35, h: 0.56, clearance: 0 },
  { id: 'bench-b', nameKo: '수납 벤치', styleKo: '화이트', category: 'chair', w: 1.14, d: 0.4, h: 0.5, clearance: 0 },
  { id: 'floor-lamp', nameKo: '스탠드 조명', styleKo: '갓', category: 'lamp', w: 0.34, d: 0.34, h: 1.54, clearance: 0 },
  { id: 'floor-lamp-b', nameKo: '스탠드 조명', styleKo: '구형', category: 'lamp', w: 0.22, d: 0.22, h: 1.75, clearance: 0 },
];

/** 목록·버튼에 쓰는 이름: "책상 · 서랍형" (모양이 없으면 종류만) */
export function catalogLabel(item: Pick<CatalogItem, 'nameKo' | 'styleKo'>): string {
  return item.styleKo ? `${item.nameKo} · ${item.styleKo}` : item.nameKo;
}

/** 카탈로그 목록에 보여줄 모델 사진 (scripts/dev-data/render-furniture-thumbs.mjs). 내 가구는 없다 */
export function catalogThumbnail(item: Pick<CatalogItem, 'id' | 'kind'>): string | null {
  return item.kind === 'user' ? null : `/furniture/${item.id}.webp`;
}

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
  sofa: 0x76a5af,
  lamp: 0xf1c232,
  // 내 가구의 기본 분류
  etc: 0xb4a7d6,
};

/** 박스 가구의 색 (종류별). 모르는 종류는 회색 */
export function categoryColor(category: string): number {
  return CATEGORY_COLORS[category] ?? 0xb7b7b7;
}
