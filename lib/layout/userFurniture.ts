// 내 가구: 사용자가 이름과 가로·깊이·높이를 넣어 만든 박스 가구 (user_furniture 테이블).
// 본인만 읽고 쓸 수 있다(RLS). 배치에는 { kind: 'user', furnitureRef: 이 가구의 id }로 저장한다.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/database.types';
import type { CatalogItem } from './catalog';

export const USER_FURNITURE_NAME_MAX = 20;
/** 한 사람이 만들 수 있는 내 가구 수 (화면에서 막는다) */
export const MAX_USER_FURNITURE = 30;
/** 가로·깊이는 10cm~5m, 높이는 5cm~3m */
const SIZE_LIMITS_CM = { width: [10, 500], depth: [10, 500], height: [5, 300] } as const;
const SIZE_LABEL = { width: '가로', depth: '깊이', height: '높이' } as const;

export type UserFurnitureForm = { name: string; width: string; depth: string; height: string };
export type UserFurnitureValue = { name: string; w: number; d: number; h: number };
export type UserFurnitureRow = { id: string; name: string; category: string; width_m: number; depth_m: number; height_m: number };

type Client = SupabaseClient<Database>;
const COLUMNS = 'id, name, category, width_m, depth_m, height_m';

/** 폼에 넣은 글자(치수는 cm)를 검증해 m 단위 값으로 바꾼다 */
export function parseUserFurnitureForm(form: UserFurnitureForm): { ok: true; value: UserFurnitureValue } | { ok: false; message: string } {
  const name = form.name.trim();
  if (!name) return { ok: false, message: '이름을 넣어 주세요.' };
  if (name.length > USER_FURNITURE_NAME_MAX) return { ok: false, message: `이름은 ${USER_FURNITURE_NAME_MAX}자까지 쓸 수 있습니다.` };
  const sizes = { width: 0, depth: 0, height: 0 };
  for (const key of ['width', 'depth', 'height'] as const) {
    const text = form[key].trim();
    const cm = Number(text);
    const [min, max] = SIZE_LIMITS_CM[key];
    if (!text || !Number.isFinite(cm)) return { ok: false, message: `${SIZE_LABEL[key]}를 숫자(cm)로 넣어 주세요.` };
    if (cm < min || cm > max) return { ok: false, message: `${SIZE_LABEL[key]}는 ${min}~${max} cm 사이여야 합니다.` };
    sizes[key] = Math.round(cm) / 100;
  }
  return { ok: true, value: { name, w: sizes.width, d: sizes.depth, h: sizes.height } };
}

/** DB 행을 가구 목록 항목으로 바꾼다 (카탈로그 가구와 같은 모양, kind만 'user') */
export function fromUserFurnitureRow(row: UserFurnitureRow): CatalogItem {
  return {
    id: row.id,
    kind: 'user',
    nameKo: row.name,
    category: row.category,
    w: Number(row.width_m),
    d: Number(row.depth_m),
    h: Number(row.height_m),
    clearance: 0,
  };
}

/** 내가 만든 가구 (만든 순서대로) */
export async function loadUserFurniture(supabase: Client, userId: string): Promise<CatalogItem[]> {
  const { data } = await supabase.from('user_furniture').select(COLUMNS).eq('owner_id', userId).order('created_at').limit(MAX_USER_FURNITURE);
  return (data ?? []).map(fromUserFurnitureRow);
}

/** 내 가구를 만든다. 실패하면 null */
export async function createUserFurniture(supabase: Client, value: UserFurnitureValue): Promise<CatalogItem | null> {
  const { data, error } = await supabase
    .from('user_furniture')
    .insert({ name: value.name, width_m: value.w, depth_m: value.d, height_m: value.h })
    .select(COLUMNS)
    .maybeSingle();
  return error || !data ? null : fromUserFurnitureRow(data);
}

/** 내 가구를 지운다. 지웠으면 true */
export async function deleteUserFurniture(supabase: Client, id: string): Promise<boolean> {
  const { data, error } = await supabase.from('user_furniture').delete().eq('id', id).select('id').maybeSingle();
  return !error && data !== null;
}
