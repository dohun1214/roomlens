// 내 가구: 사용자가 이름과 가로·깊이·높이를 넣어 만든 박스 가구, 또는 3D 스캔(GLB)을 올려 만든 가구 (user_furniture 테이블).
// 본인만 읽고 쓸 수 있다(RLS). 배치에는 { kind: 'user', furnitureRef: 이 가구의 id }로 저장한다.
// 스캔 가구의 모델 파일은 R2 furniture/user/{사용자}/{가구}.glb, 만들기·지우기는 서버(/api/furniture)가 한다.
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
export type UserFurnitureRow = { id: string; name: string; category: string; width_m: number; depth_m: number; height_m: number; model_key?: string | null };

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

/** 서버에서 받은 값(m) 검사: 화면의 폼과 같은 규칙 (이름 길이, 치수 범위, cm 단위로 반올림) */
export function checkUserFurnitureValue(raw: { name?: unknown; w?: unknown; d?: unknown; h?: unknown }): { ok: true; value: UserFurnitureValue } | { ok: false; message: string } {
  const cm = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? String(Math.round(Number(v) * 1000) / 10) : '');
  return parseUserFurnitureForm({ name: typeof raw.name === 'string' ? raw.name : '', width: cm(raw.w), depth: cm(raw.d), height: cm(raw.h) });
}

/** DB 행을 가구 목록 항목으로 바꾼다 (카탈로그 가구와 같은 모양, kind만 'user'). 3D 스캔 가구는 모델 주소를 함께 */
export function fromUserFurnitureRow(row: UserFurnitureRow, modelUrl?: string | null): CatalogItem {
  return {
    ...(modelUrl ? { modelUrl } : {}),
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

/**
 * 내가 만든 가구 (만든 순서대로). 3D 스캔 가구는 presign으로 모델 읽기 주소를 만든다 (서버에서 부를 때만 넘긴다).
 * model_key 열은 로그인한 사람만 읽을 수 있다
 */
export async function loadUserFurniture(supabase: Client, userId: string, presign?: (key: string) => Promise<string>): Promise<CatalogItem[]> {
  const { data } = await supabase.from('user_furniture').select(`${COLUMNS}, model_key`).eq('owner_id', userId).order('created_at').limit(MAX_USER_FURNITURE);
  return Promise.all((data ?? []).map(async (row) => fromUserFurnitureRow(row, row.model_key && presign ? await presign(row.model_key) : null)));
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

/** 내 가구를 지운다 (3D 스캔 모델 파일도 함께 지우도록 서버를 거친다). 지웠으면 true */
export async function deleteUserFurniture(id: string): Promise<boolean> {
  const res = await fetch(`/api/furniture/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
  return Boolean(res?.ok);
}

/** 3D 스캔 가구를 만든다: 다듬은 GLB와 이름·치수(m)를 서버로 보낸다 */
export async function createScanFurniture(glb: Blob, value: UserFurnitureValue): Promise<{ ok: true; item: CatalogItem } | { ok: false; message: string }> {
  const form = new FormData();
  form.set('name', value.name);
  form.set('w', String(value.w));
  form.set('d', String(value.d));
  form.set('h', String(value.h));
  form.set('file', glb, 'model.glb');
  const res = await fetch('/api/furniture/scan', { method: 'POST', body: form }).catch(() => null);
  const json = (await res?.json().catch(() => null)) as { furniture?: UserFurnitureRow; modelUrl?: string; error?: { message?: string } } | null;
  if (!res?.ok || !json?.furniture) return { ok: false, message: json?.error?.message ?? '올리지 못했습니다. 인터넷 연결을 확인하고 다시 해 주세요.' };
  return { ok: true, item: fromUserFurnitureRow(json.furniture, json.modelUrl) };
}

/** 공유받은 배치에 쓰인 남의 3D 스캔 가구를 내 가구로 복사한다 (모델 파일도 서버가 복사) */
export async function copyScanFurniture(id: string): Promise<CatalogItem | null> {
  const res = await fetch(`/api/furniture/${encodeURIComponent(id)}/copy`, { method: 'POST' }).catch(() => null);
  const json = (await res?.json().catch(() => null)) as { furniture?: UserFurnitureRow; modelUrl?: string } | null;
  return res?.ok && json?.furniture ? fromUserFurnitureRow(json.furniture, json.modelUrl) : null;
}
