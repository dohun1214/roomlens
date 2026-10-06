// 배치를 layouts 테이블에서 읽고 쓴다. 권한은 RLS가 정한다:
// 내 방이나 공개 방에 내 배치를 만들 수 있고, 내 배치만 고칠 수 있다.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/database.types';
import { parseSavedItems, type SavedItem } from './saved';

export type SavedLayout = { id: string; items: SavedItem[] };

/** 한 방에 남겨 두는 내 AI 배치의 수 (새로 추천받으면 오래된 것부터 지운다) */
export const MAX_AI_LAYOUTS = 5;

type Client = SupabaseClient<Database>;

/** 이 방에서 내가 가장 최근에 저장한 배치. 없으면 null */
export async function loadMyLayout(supabase: Client, roomId: string, userId: string): Promise<SavedLayout | null> {
  const { data } = await supabase
    .from('layouts')
    .select('id, items')
    .eq('room_id', roomId)
    .eq('owner_id', userId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? { id: data.id, items: parseSavedItems(data.items) } : null;
}

/**
 * 배치를 저장하고 그 id를 돌려준다. 실패하면 null.
 * layoutId가 있으면 그 배치를 고치고, 없거나 그 배치가 사라졌으면 새로 만든다.
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
