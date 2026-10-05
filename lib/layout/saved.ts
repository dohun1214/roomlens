// 배치를 저장하는 형식. layouts.items = [{ id, furnitureRef, kind, x, z, rotationDeg }]
// 치수·이름은 저장하지 않고 furnitureRef로 카탈로그(또는 내 가구)에서 다시 찾는다.
// 브라우저에서 본인 권한으로 바로 저장하므로, 읽을 때 반드시 검증한다.
import { z } from 'zod';
import type { Footprint } from '@/lib/three/floorDrag';
import { categoryColor, type CatalogItem } from './catalog';

/** DB의 layouts_items_check 와 같은 값 */
export const MAX_LAYOUT_ITEMS = 50;

const coordinate = z.number().min(-1000).max(1000);

export const SavedItemSchema = z.object({
  id: z.string().min(1).max(40),
  /** kind가 catalog면 furniture_catalog.id, user면 user_furniture.id */
  furnitureRef: z.string().min(1).max(64),
  kind: z.enum(['catalog', 'user']),
  x: coordinate,
  z: coordinate,
  rotationDeg: z.number().min(-3600).max(3600),
});

export type SavedItem = z.infer<typeof SavedItemSchema>;

/** 화면에 놓인 가구: 저장 항목 + 그릴 때 필요한 치수·이름·색 */
export type PlacedItem = Footprint & {
  id: string;
  kind: SavedItem['kind'];
  furnitureRef: string;
  name: string;
  h: number;
  /** 가구 종류와 앞에 비워 둘 깊이(m): 쓰는 쪽 검사에 쓴다 */
  category: string;
  clearance: number;
  color: number;
  /** 3D 모델(GLB) 주소. 없으면 상자로 그린다 */
  modelUrl?: string;
};

// + 0 은 -0 을 0 으로 바꾼다
const round3 = (v: number) => Math.round(v * 1000) / 1000 + 0;
const normalizeDeg = (deg: number) => ((Math.round(deg) % 360) + 360) % 360;

/**
 * DB에서 읽은 items를 검증한다. 배열이 아니면 빈 배치로 보고,
 * 모양이 틀린 항목과 id가 겹치는 항목은 버린다.
 */
export function parseSavedItems(raw: unknown): SavedItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const items: SavedItem[] = [];
  for (const entry of raw) {
    if (items.length >= MAX_LAYOUT_ITEMS) break;
    const parsed = SavedItemSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    items.push({ ...parsed.data, rotationDeg: normalizeDeg(parsed.data.rotationDeg) });
  }
  return items;
}

/** 화면의 가구를 저장 형식으로 바꾼다 (좌표는 mm 단위로 반올림) */
export function toSavedItems(items: PlacedItem[]): SavedItem[] {
  return items.map((item) => ({
    id: item.id,
    furnitureRef: item.furnitureRef,
    kind: item.kind,
    x: round3(item.x),
    z: round3(item.z),
    rotationDeg: normalizeDeg(item.rotationDeg),
  }));
}

/** 가구 목록의 가구(카탈로그 또는 내 가구) 하나를 주어진 자리에 놓은 것 */
export function placeCatalogItem(entry: CatalogItem, id: string, at: Pick<Footprint, 'x' | 'z' | 'rotationDeg'>): PlacedItem {
  return {
    id,
    kind: entry.kind ?? 'catalog',
    furnitureRef: entry.id,
    name: entry.nameKo,
    w: entry.w,
    d: entry.d,
    h: entry.h,
    category: entry.category,
    clearance: entry.clearance,
    color: categoryColor(entry.category),
    x: at.x,
    z: at.z,
    rotationDeg: at.rotationDeg,
    ...(entry.modelUrl ? { modelUrl: entry.modelUrl } : {}),
  };
}

/**
 * 저장된 배치를 화면의 가구로 되살린다.
 * 카탈로그나 내 가구에서 찾을 수 없는 가구는 건너뛰고 그 수를 missing으로 알려준다.
 */
export function restoreItems(
  saved: SavedItem[],
  catalog: CatalogItem[],
  userFurniture: CatalogItem[] = [],
): { items: PlacedItem[]; missing: number } {
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  const mineById = new Map(userFurniture.map((entry) => [entry.id, entry]));
  const items: PlacedItem[] = [];
  let missing = 0;
  for (const s of saved) {
    const entry = s.kind === 'catalog' ? byId.get(s.furnitureRef) : mineById.get(s.furnitureRef);
    if (!entry) {
      missing += 1;
      continue;
    }
    items.push(placeCatalogItem(entry, s.id, s));
  }
  return { items, missing };
}

/** 새 가구에 붙일 번호: 지금 있는 f1, f2, ... 중 가장 큰 수 + 1 */
export function nextItemNumber(items: { id: string }[]): number {
  let max = 0;
  for (const { id } of items) {
    const match = /^f(\d+)$/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/** 두 배치가 같은지 (저장할 것이 있는지 판단) */
export function sameSavedItems(a: SavedItem[], b: SavedItem[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, i) => {
    const other = b[i];
    return (
      item.id === other.id &&
      item.furnitureRef === other.furnitureRef &&
      item.kind === other.kind &&
      item.x === other.x &&
      item.z === other.z &&
      item.rotationDeg === other.rotationDeg
    );
  });
}
