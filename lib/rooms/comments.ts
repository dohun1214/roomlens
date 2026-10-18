// 방 코멘트: 방을 볼 수 있는 사람은 읽고, 로그인한 사람은 쓰고, 쓴 사람과 방 주인은 지운다 (권한은 RLS가 정한다).
// 브라우저에서 본인 권한의 Supabase 클라이언트로 직접 읽고 쓴다.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/database.types';

/** 코멘트 한 개의 최대 글자 수 (DB 제약과 같다) */
export const MAX_COMMENT_LENGTH = 1000;
/** 한 번에 불러오는 코멘트 수 (최근 것부터) */
export const COMMENT_PAGE = 100;

export type RoomComment = {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
};

type Client = SupabaseClient<Database>;

/** 쓴 글을 다듬는다: 앞뒤 공백을 빼고 빈 줄은 두 줄까지만. 비었거나 너무 길면 이유와 함께 실패 */
export function parseCommentBody(text: string): { ok: true; body: string } | { ok: false; message: string } {
  const body = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!body) return { ok: false, message: '내용을 적어 주세요.' };
  if (body.length > MAX_COMMENT_LENGTH) return { ok: false, message: `코멘트는 ${MAX_COMMENT_LENGTH}자까지 쓸 수 있습니다.` };
  return { ok: true, body };
}

/** "방금", "5분 전", "3시간 전", "어제", "10/12", 올해가 아니면 "2025/10/12" (한국 시간) */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const t = new Date(iso);
  const diff = now.getTime() - t.getTime();
  if (!Number.isFinite(diff)) return '';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const kst = (d: Date) => new Date(d.getTime() + 9 * 3_600_000);
  const a = kst(t);
  const b = kst(now);
  const dayA = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const dayB = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  if (dayB - dayA === 86_400_000) return '어제';
  const md = `${a.getUTCMonth() + 1}/${a.getUTCDate()}`;
  return a.getUTCFullYear() === b.getUTCFullYear() ? md : `${a.getUTCFullYear()}/${md}`;
}

/** 이 방의 코멘트를 오래된 것부터 (최근 COMMENT_PAGE개). 쓴 사람의 닉네임을 붙인다. 읽지 못하면 null */
export async function loadComments(supabase: Client, roomId: string): Promise<RoomComment[] | null> {
  const { data, error } = await supabase
    .from('comments')
    .select('id, author_id, body, created_at')
    .eq('room_id', roomId)
    .order('created_at', { ascending: false })
    .limit(COMMENT_PAGE);
  if (error || !data) return null;
  const authors = [...new Set(data.map((row) => row.author_id))];
  const names = new Map<string, string>();
  if (authors.length) {
    const { data: profiles } = await supabase.from('profiles').select('id, nickname').in('id', authors);
    for (const p of profiles ?? []) names.set(p.id, p.nickname);
  }
  return data
    .map((row) => ({ id: row.id, authorId: row.author_id, authorName: names.get(row.author_id) ?? '알 수 없음', body: row.body, createdAt: row.created_at }))
    .reverse();
}

/** 코멘트를 쓴다. 성공하면 새 코멘트(닉네임은 부르는 쪽이 채운다), 실패하면 null */
export async function postComment(supabase: Client, roomId: string, body: string): Promise<Omit<RoomComment, 'authorName'> | null> {
  const { data, error } = await supabase.from('comments').insert({ room_id: roomId, body }).select('id, author_id, body, created_at').maybeSingle();
  if (error || !data) return null;
  return { id: data.id, authorId: data.author_id, body: data.body, createdAt: data.created_at };
}

/** 코멘트를 지운다 (쓴 사람 또는 방 주인). 지웠으면 true */
export async function deleteComment(supabase: Client, commentId: string): Promise<boolean> {
  const { data, error } = await supabase.from('comments').delete().eq('id', commentId).select('id').maybeSingle();
  return !error && data !== null;
}
