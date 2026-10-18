// 배치 공유: 내 배치를 "링크로 공개"하면 /rooms/{방}?layout={배치} 주소로 남이 볼 수 있다.
// 권한은 RLS가 정한다: 공개 방의 공개 배치만 남이 읽고, 그 배치에 쓰인 내 가구(치수)도 함께 읽힌다.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/database.types';
import type { CatalogItem } from './catalog';
import { parseSavedItems, type SavedItem } from './saved';
import { fromUserFurnitureRow } from './userFurniture';

type Client = SupabaseClient<Database>;

/** 방 주소에서 공유 배치를 고르는 검색 매개변수 이름 */
export const LAYOUT_PARAM = 'layout';
/** 배치 이름의 최대 글자 수 (DB 제약과 같다) */
export const LAYOUT_NAME_MAX = 40;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 남이 공유한 배치 하나 (그리는 데 필요한 그 사람의 가구까지) */
export type SharedLayout = {
  id: string;
  name: string;
  items: SavedItem[];
  ownerId: string;
  ownerName: string;
  /** 배치에 쓰인 그 사람의 가구 (내 가구 목록에는 넣지 않고 그리는 데만 쓴다) */
  furniture: CatalogItem[];
};

/** 공유 링크의 경로 */
export function sharedLayoutPath(roomId: string, layoutId: string): string {
  return `/rooms/${roomId}?${LAYOUT_PARAM}=${layoutId}`;
}

/** 검색 매개변수에서 배치 id를 읽는다 (uuid가 아니면 null) */
export function parseLayoutParam(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && UUID.test(raw) ? raw.toLowerCase() : null;
}

/** 공유받은 배치를 내 배치로 저장할 때의 이름: "OO님의 배치" (40자를 넘으면 닉네임을 줄인다) */
export function sharedCopyName(ownerName: string): string {
  const suffix = '님의 배치';
  const name = ownerName.trim() || '다른 사람';
  const room = LAYOUT_NAME_MAX - suffix.length;
  return (name.length > room ? `${name.slice(0, room - 1)}…` : name) + suffix;
}

/** 남의 가구를 가리키는 항목을 내 가구 사본으로 바꾼다 (map: 남의 가구 id → 내 사본 id). 사본이 없는 항목은 뺀다 */
export function remapFurniture(items: SavedItem[], borrowed: Set<string>, map: Map<string, string>): SavedItem[] {
  const out: SavedItem[] = [];
  for (const item of items) {
    if (item.kind !== 'user' || !borrowed.has(item.furnitureRef)) {
      out.push(item);
      continue;
    }
    const mine = map.get(item.furnitureRef);
    if (mine) out.push({ ...item, furnitureRef: mine });
  }
  return out;
}

/** 배치 안에서 실제로 쓰인 남의 가구만 (같은 가구는 한 번) */
export function usedBorrowed(items: SavedItem[], furniture: CatalogItem[]): CatalogItem[] {
  const used = new Set(items.filter((i) => i.kind === 'user').map((i) => i.furnitureRef));
  return furniture.filter((f) => used.has(f.id));
}

/** 내 배치를 링크로 공개하거나 닫는다. 바뀌었으면 true */
export async function setLayoutPublic(supabase: Client, layoutId: string, isPublic: boolean): Promise<boolean> {
  const { data, error } = await supabase.from('layouts').update({ is_public: isPublic }).eq('id', layoutId).select('id').maybeSingle();
  return !error && data !== null;
}

/** 이 방의 공유 배치를 읽는다. 없거나 볼 수 없으면 null (비공개로 바뀌었거나 지워졌을 때) */
export async function loadSharedLayout(supabase: Client, roomId: string, layoutId: string): Promise<SharedLayout | null> {
  const { data: row } = await supabase.from('layouts').select('id, name, items, owner_id').eq('id', layoutId).eq('room_id', roomId).maybeSingle();
  if (!row) return null;
  const items = parseSavedItems(row.items);
  const refs = [...new Set(items.filter((i) => i.kind === 'user').map((i) => i.furnitureRef))].filter((ref) => UUID.test(ref));
  const [{ data: profile }, { data: furnitureRows }] = await Promise.all([
    supabase.from('profiles').select('nickname').eq('id', row.owner_id).maybeSingle(),
    refs.length
      ? supabase.from('user_furniture').select('id, name, category, width_m, depth_m, height_m').in('id', refs)
      : Promise.resolve({ data: [] as { id: string; name: string; category: string; width_m: number; depth_m: number; height_m: number }[] }),
  ]);
  return {
    id: row.id,
    name: row.name,
    items,
    ownerId: row.owner_id,
    ownerName: profile?.nickname ?? '알 수 없음',
    furniture: (furnitureRows ?? []).map(fromUserFurnitureRow),
  };
}
