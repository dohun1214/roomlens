import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError, notFound, unauthenticated } from '@/lib/api/http';
import { deleteObject } from '@/lib/r2';
import { createClient, getCurrentUser } from '@/lib/supabase/server';

type Context = { params: Promise<{ id: string }> };

/**
 * 내 가구 지우기 (본인). 3D 스캔 가구면 R2의 모델 파일도 지운다.
 * 배치에 남은 이 가구는 다음에 열 때 건너뛴다 (화면이 개수를 알린다).
 */
export async function DELETE(_request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return notFound('가구를 찾을 수 없습니다.');

  const supabase = await createClient();
  // 공개 배치에 쓰인 남의 가구도 읽을 수는 있으므로 주인을 확인한다
  const { data: row, error } = await supabase.from('user_furniture').select('id, owner_id, model_key').eq('id', id.data).maybeSingle();
  if (error) return apiError(500, 'DB_ERROR', '가구를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  if (!row || row.owner_id !== user.id) return notFound('가구를 찾을 수 없습니다.');

  const { data: deleted, error: deleteError } = await supabase.from('user_furniture').delete().eq('id', row.id).select('id').maybeSingle();
  if (deleteError || !deleted) return apiError(500, 'DB_ERROR', '가구를 지우지 못했습니다. 잠시 후 다시 시도해 주세요.');
  if (row.model_key) await deleteObject(row.model_key).catch((err) => console.error(err));
  return NextResponse.json({ deleted: true });
}
