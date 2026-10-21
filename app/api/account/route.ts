import { NextResponse } from 'next/server';
import { apiError, badRequest, readJson, unauthenticated } from '@/lib/api/http';
import { ACCOUNT_DELETE_CONFIRM, canConfirmDelete } from '@/lib/auth/account';
import { deleteObject, deletePrefix } from '@/lib/r2';
import { createAdminClient } from '@/lib/supabase/admin';
import { getCurrentUser } from '@/lib/supabase/server';
import { roomPrefix } from '@/lib/upload/splatFile';

/**
 * 계정 삭제 (본인). 개인정보가 남지 않게 내 방의 R2 파일(3D·대표 사진)과 내 가구 모델을 먼저 지우고,
 * 계정을 지운다. 방·배치·코멘트·내 가구·AI 사용 기록은 DB에서 함께 지워진다 (on delete cascade).
 * 파일 삭제가 하나라도 실패하면 계정은 그대로 두어 다시 시도할 수 있게 한다.
 */
export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const body = (await readJson(request)) as { confirm?: unknown } | null;
  if (typeof body?.confirm !== 'string' || !canConfirmDelete(body.confirm)) return badRequest(`확인 칸에 "${ACCOUNT_DELETE_CONFIRM}"을 적어 주세요.`);

  const admin = createAdminClient();
  const [{ data: rooms, error: roomsError }, { data: furniture, error: furnitureError }] = await Promise.all([
    admin.from('rooms').select('id').eq('owner_id', user.id),
    admin.from('user_furniture').select('model_key').eq('owner_id', user.id),
  ]);
  if (roomsError || furnitureError) return apiError(500, 'DB_ERROR', '계정 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');

  let removedFiles = 0;
  try {
    for (const room of rooms ?? []) removedFiles += await deletePrefix(roomPrefix(room.id));
    for (const item of furniture ?? []) {
      if (!item.model_key) continue;
      await deleteObject(item.model_key);
      removedFiles += 1;
    }
  } catch (err) {
    console.error(err);
    return apiError(502, 'STORAGE_ERROR', '파일을 지우지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }

  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) {
    console.error(error);
    return apiError(500, 'DB_ERROR', '계정을 지우지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  return NextResponse.json({ deleted: true, rooms: rooms?.length ?? 0, removedFiles });
}
