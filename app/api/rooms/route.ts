import { NextResponse } from 'next/server';
import { apiError, badRequest, readJson, unauthenticated } from '@/lib/api/http';
import { CreateRoomInput, firstIssueMessage, MAX_ROOMS_PER_USER } from '@/lib/rooms/schemas';
import { createClient, getCurrentUser } from '@/lib/supabase/server';

/**
 * 방 레코드를 만든다 (status = uploading). 파일은 이후 /api/upload-url 로 받은 주소에 브라우저가 직접 올린다.
 * 로그인한 사용자의 권한(RLS)으로 넣으므로 owner_id는 DB가 채운다.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();

  const parsed = CreateRoomInput.safeParse(await readJson(request));
  if (!parsed.success) return badRequest(firstIssueMessage(parsed.error));
  const { title, description } = parsed.data;

  const supabase = await createClient();
  const { count, error: countError } = await supabase
    .from('rooms')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', user.id);
  if (countError) return apiError(500, 'DB_ERROR', '방 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  if ((count ?? 0) >= MAX_ROOMS_PER_USER) {
    return apiError(409, 'ROOM_LIMIT', `방은 ${MAX_ROOMS_PER_USER}개까지 만들 수 있습니다. 쓰지 않는 방을 지운 뒤 다시 시도해 주세요.`);
  }

  const { data: room, error } = await supabase
    .from('rooms')
    .insert({ title, description, consent_at: new Date().toISOString() })
    .select('id, title, description, status, created_at')
    .single();
  if (error || !room) return apiError(500, 'DB_ERROR', '방을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.');

  return NextResponse.json({ room }, { status: 201 });
}
