import { NextResponse } from 'next/server';
import { apiError, badRequest, notFound, readJson, unauthenticated } from '@/lib/api/http';
import { deleteObject, headObject, presignGet, readObjectHead } from '@/lib/r2';
import { CompleteUploadInput, firstIssueMessage, RoomId } from '@/lib/rooms/schemas';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient, getCurrentUser } from '@/lib/supabase/server';
import { checkSplatFile, SPLAT_HEAD_BYTES, splatKeyFor } from '@/lib/upload/splatFile';

type Context = { params: Promise<{ id: string }> };

const PUBLIC_COLUMNS =
  'id, owner_id, title, description, is_public, status, source, splat_format, splat_bytes, transform, floor_polygon, openings, created_at, updated_at';

/**
 * 방 정보와 3D 파일을 읽을 주소(presigned GET, 1시간)를 준다.
 * 로그인한 사용자의 권한(RLS)으로 읽으므로 공개 방이거나 본인 방일 때만 보인다.
 */
export async function GET(_request: Request, { params }: Context) {
  const id = RoomId.safeParse((await params).id);
  if (!id.success) return notFound();

  const user = await getCurrentUser();
  const supabase = await createClient();
  const { data: room, error } = await supabase.from('rooms').select(`${PUBLIC_COLUMNS}, splat_key`).eq('id', id.data).maybeSingle();
  if (error) return apiError(500, 'DB_ERROR', '방 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
  if (!room) return notFound();

  const { splat_key: splatKey, ...rest } = room;
  const splatUrl = room.status === 'ready' && splatKey ? await presignGet(splatKey) : null;
  return NextResponse.json({ room: rest, isOwner: user?.id === room.owner_id, splatUrl });
}

/**
 * 업로드 완료 확인. 브라우저 말을 믿지 않고 R2에서 실제 크기와 파일 앞부분(형식)을 확인한 뒤
 * status를 ready로 바꾼다. 맞지 않는 파일은 지우고 다시 올리게 한다.
 */
export async function PATCH(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();

  const id = RoomId.safeParse((await params).id);
  if (!id.success) return notFound();
  const parsed = CompleteUploadInput.safeParse(await readJson(request));
  if (!parsed.success) return badRequest(firstIssueMessage(parsed.error));
  const format = parsed.data.splatFormat;

  const supabase = await createClient();
  const { data: room, error } = await supabase.from('rooms').select('id, owner_id, status').eq('id', id.data).maybeSingle();
  if (error) return apiError(500, 'DB_ERROR', '방 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  if (!room || room.owner_id !== user.id) return notFound();
  if (room.status === 'ready') return apiError(409, 'ALREADY_UPLOADED', '이미 파일을 올린 방입니다.');

  const key = splatKeyFor(room.id, format);
  const head = await headObject(key);
  if (!head) return apiError(400, 'UPLOAD_NOT_FOUND', '올린 파일을 찾지 못했습니다. 다시 올려 주세요.');

  const check = checkSplatFile(head.size, (await readObjectHead(key, SPLAT_HEAD_BYTES)) ?? new Uint8Array());
  if (!check.ok || check.format !== format) {
    await deleteObject(key);
    return apiError(
      400,
      check.ok ? 'FORMAT_MISMATCH' : check.code,
      check.ok ? '파일 형식이 요청과 다릅니다. 다시 올려 주세요.' : check.message,
    );
  }

  // status·splat_* 는 브라우저 권한으로 쓸 수 없는 컬럼이라 서버 전용 클라이언트로 바꾼다 (소유자는 위에서 확인함)
  const { data: updated, error: updateError } = await createAdminClient()
    .from('rooms')
    .update({ status: 'ready', splat_key: key, splat_format: format, splat_bytes: head.size })
    .eq('id', room.id)
    .eq('owner_id', user.id)
    .select(PUBLIC_COLUMNS)
    .single();
  if (updateError || !updated) return apiError(500, 'DB_ERROR', '방 상태를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');

  return NextResponse.json({ room: updated });
}
