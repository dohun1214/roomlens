import { NextResponse } from 'next/server';
import { apiError, badRequest, notFound, unauthenticated } from '@/lib/api/http';
import { deleteObject, putObject } from '@/lib/r2';
import { checkThumbnail, MAX_THUMBNAIL_BYTES, THUMBNAIL_CONTENT_TYPE, thumbnailKeyFor, thumbnailSrc } from '@/lib/rooms/thumbnail';
import { RoomId } from '@/lib/rooms/schemas';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient, getCurrentUser } from '@/lib/supabase/server';

type Context = { params: Promise<{ id: string }> };

/**
 * 방 대표 사진을 바꾼다 (방 주인만). 본문은 JPEG 그대로(image/jpeg).
 * R2에 새 이름으로 올리고 rooms.thumbnail_key 를 바꾼 뒤 예전 사진은 지운다.
 */
export async function PUT(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const id = RoomId.safeParse((await params).id);
  if (!id.success) return notFound();
  if (request.headers.get('content-type') !== THUMBNAIL_CONTENT_TYPE) return badRequest('JPEG 사진만 올릴 수 있습니다.');
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_THUMBNAIL_BYTES) return badRequest('사진이 너무 큽니다.');

  const supabase = await createClient();
  const { data: room, error } = await supabase.from('rooms').select('id, owner_id, status, thumbnail_key').eq('id', id.data).maybeSingle();
  if (error) return apiError(500, 'DB_ERROR', '방 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  if (!room || room.owner_id !== user.id) return notFound();
  if (room.status !== 'ready') return apiError(409, 'NOT_READY', '3D 파일을 올린 뒤에 대표 사진을 정할 수 있습니다.');

  const bytes = new Uint8Array(await request.arrayBuffer());
  const check = checkThumbnail(bytes);
  if (!check.ok) return badRequest(check.message);

  const key = thumbnailKeyFor(room.id, Date.now());
  try {
    await putObject(key, bytes, THUMBNAIL_CONTENT_TYPE);
  } catch (err) {
    console.error(err);
    return apiError(502, 'STORAGE_ERROR', '사진을 올리지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  // thumbnail_key 는 브라우저 권한으로 쓸 수 없는 컬럼이라 서버 전용 클라이언트로 바꾼다 (소유자는 위에서 확인함)
  const { error: updateError } = await createAdminClient().from('rooms').update({ thumbnail_key: key }).eq('id', room.id).eq('owner_id', user.id);
  if (updateError) {
    await deleteObject(key).catch(() => undefined);
    return apiError(500, 'DB_ERROR', '대표 사진을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  if (room.thumbnail_key && room.thumbnail_key !== key) await deleteObject(room.thumbnail_key).catch((err) => console.error(err));
  return NextResponse.json({ thumbnail: thumbnailSrc(room.id, key) });
}
