// 가구를 화면에 그릴 때의 모양: 위에서 본 작은 그림의 종류와 분류별 색.
// 3D 상자 색(categoryColor)과 같은 계열의 파스텔이다.

export type GlyphKind = 'bed' | 'bed-wide' | 'desk' | 'chair' | 'wardrobe' | 'hanger' | 'drawer' | 'table' | 'bookcase' | 'box';

export type FurnitureTone = {
  /** 작은 그림 뒤의 옅은 바탕 */
  tile: string;
  /** 작은 그림의 선 */
  ink: string;
  /** 평면도에서 가구를 채우는 색과 테두리 */
  fill: string;
  stroke: string;
  /** 목록의 점 */
  dot: string;
};

const TONES: Record<string, FurnitureTone> = {
  bed: { tile: '#e3ecfc', ink: '#4a72c8', fill: '#c9daf8', stroke: '#6f92d8', dot: '#7fa2e6' },
  desk: { tile: '#fcebd3', ink: '#b9781f', fill: '#f8ddb8', stroke: '#d29a4a', dot: '#e3a857' },
  chair: { tile: '#f9e3ef', ink: '#b5558c', fill: '#f3cfe3', stroke: '#c77fa8', dot: '#d98bb8' },
  storage: { tile: '#e1f2de', ink: '#4e9443', fill: '#cfe8cb', stroke: '#76b06b', dot: '#7dbb72' },
  table: { tile: '#f6efc8', ink: '#94801c', fill: '#f1e7b0', stroke: '#bfa93a', dot: '#cdb94a' },
  etc: { tile: '#ebe6f8', ink: '#6f58b3', fill: '#dcd3f3', stroke: '#9482cf', dot: '#a493dc' },
};
const FALLBACK: FurnitureTone = { tile: '#eef0f4', ink: '#566074', fill: '#e2e6ed', stroke: '#8a94a6', dot: '#9aa4b5' };

export function furnitureTone(category: string): FurnitureTone {
  return TONES[category] ?? FALLBACK;
}

const BY_ID: Record<string, GlyphKind> = {
  'bed-single': 'bed',
  'bed-super-single': 'bed',
  'bed-queen': 'bed-wide',
  desk: 'desk',
  chair: 'chair',
  wardrobe: 'wardrobe',
  hanger: 'hanger',
  drawer: 'drawer',
  'table-2': 'table',
  bookcase: 'bookcase',
};
const BY_CATEGORY: Record<string, GlyphKind> = { bed: 'bed', desk: 'desk', chair: 'chair', storage: 'drawer', table: 'table' };

/** 카탈로그 id로, 모르는 id(내 가구 등)면 분류로 그림을 고른다 */
export function glyphKind(furnitureRef: string, category: string): GlyphKind {
  return BY_ID[furnitureRef] ?? BY_CATEGORY[category] ?? 'box';
}

/** "120×60" (cm) */
export function sizeLabel(w: number, d: number): string {
  return `${Math.round(w * 100)}×${Math.round(d * 100)}`;
}
