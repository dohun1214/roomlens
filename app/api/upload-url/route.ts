import { NextResponse } from 'next/server';
import { apiError, badRequest, notFound, readJson, unauthenticated } from '@/lib/api/http';
import { presignPut, URL_TTL_SECONDS } from '@/lib/r2';
import { firstIssueMessage, UploadUrlInput } from '@/lib/rooms/schemas';
import { createClient, getCurrentUser } from '@/lib/supabase/server';
import { SPLAT_CONTENT_TYPE, splatKeyFor } from '@/lib/upload/splatFile';

/**
 * 방 3D 파일을 R2에 직접 올릴 주소(presigned PUT, 1시간)를 발급한다.
 * 본인 방이고 아직 올리는 중(uploading·failed)일 때만 준다.
 * 서명에 크기와 Content-Type이 들어가므로, 브라우저는 받은 headers 그대로 보내야 한다.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();

  const parsed = UploadUrlInput.safeParse(await readJson(request));
  if (!parsed.success) return badRequest(firstIssueMessage(parsed.error));
  const { roomId, format, size } = parsed.data;

  const supabase = await createClient();
  const { data: room, error } = await supabase.from('rooms').select('id, owner_id, status').eq('id', roomId).maybeSingle();
  if (error) return apiError(500, 'DB_ERROR', '방 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  // 남의 방(공개 방 포함)은 없는 방과 똑같이 답한다
  if (!room || room.owner_id !== user.id) return notFound();
  if (room.status === 'ready') return apiError(409, 'ALREADY_UPLOADED', '이미 파일을 올린 방입니다.');

  const url = await presignPut(splatKeyFor(room.id, format), SPLAT_CONTENT_TYPE, size);
  return NextResponse.json({
    url,
    method: 'PUT',
    headers: { 'Content-Type': SPLAT_CONTENT_TYPE },
    expiresIn: URL_TTL_SECONDS,
  });
}
