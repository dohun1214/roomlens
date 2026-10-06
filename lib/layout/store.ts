// 배치를 layouts 테이블에서 읽고 쓴다. 권한은 RLS가 정한다:
// 내 방이나 공개 방에 내 배치를 만들 수 있고, 내 배치만 고치고 지울 수 있다.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/database.types';
import { parseSavedItems, type SavedItem } from './saved';

export type SavedLayout = { id: string; items: SavedItem[] };

/** 한 방에서 내가 가진 배치 하나: 직접 만든 "내 배치" 또는 AI가 추천한 "AI 배치" */
export type MyLayout = SavedLayout & {
  name: string;
  createdBy: 'user' | 'ai';
  /** AI 배치일 때: 전체 의도와 가구별 이유 */
  aiSummary: string | null;
};

/** 한 방에 남겨 두는 내 AI 배치의 수 (새로 추천받으면 오래된 것부터 지운다) */
export const MAX_AI_LAYOUTS = 5;
/** 직접 만든 배치의 기본 이름 (DB의 기본값과 같다) */
export const MY_LAYOUT_NAME = '내 배치';

type Client = SupabaseClient<Database>;
type LayoutRow = { id: string; name: string; items: unknown; created_by: string; ai_summary: string | null };

const COLUMNS = 'id, name, items, created_by, ai_summary';

export function fromLayoutRow(row: LayoutRow): MyLayout {
  return {
    id: row.id,
    name: row.name,
    items: parseSavedItems(row.items),
    createdBy: row.created_by === 'ai' ? 'ai' : 'user',
    aiSummary: row.created_by === 'ai' ? row.ai_summary : null,
  };
}

/** 이 방의 내 배치들. 마지막으로 고친 것이 맨 앞이다 (방을 열면 그 배치로 시작한다) */
export async function loadMyLayouts(supabase: Client, roomId: string, userId: string): Promise<MyLayout[]> {
  const { data } = await supabase
    .from('layouts')
    .select(COLUMNS)
    .eq('room_id', roomId)
    .eq('owner_id', userId)
    .order('updated_at', { ascending: false })
    .limit(MAX_AI_LAYOUTS + 5);
  return (data ?? []).map(fromLayoutRow);
}

/**
 * 배치를 저장하고 그 id를 돌려준다. 실패하면 null.
 * layoutId가 있으면 그 배치를 고치고, 없거나 그 배치가 사라졌으면 "내 배치"를 새로 만든다.
 */
export async function saveMyLayout(
  supabase: Client,
  roomId: string,
  layoutId: string | null,
  items: SavedItem[],
): Promise<string | null> {
  if (layoutId) {
    const { data, error } = await supabase.from('layouts').update({ items }).eq('id', layoutId).select('id').maybeSingle();
    if (error) return null;
    if (data) return data.id;
  }
  const { data, error } = await supabase.from('layouts').insert({ room_id: roomId, items }).select('id').maybeSingle();
  return error || !data ? null : data.id;
}

/** 내 배치를 지운다. 지웠으면 true */
export async function deleteMyLayout(supabase: Client, layoutId: string): Promise<boolean> {
  const { data, error } = await supabase.from('layouts').delete().eq('id', layoutId).select('id').maybeSingle();
  return !error && data !== null;
}
