import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError, badRequest, notFound, unauthenticated } from '@/lib/api/http';
import { MAX_USER_FURNITURE } from '@/lib/layout/userFurniture';
import { copyObject, deleteObject, presignGet } from '@/lib/r2';
import { scanModelKey } from '@/lib/scan/glb';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient, getCurrentUser } from '@/lib/supabase/server';

type Context = { params: Promise<{ id: string }> };

/**
 * 볼 수 있는 3D 스캔 가구(공유받은 배치에 쓰인 남의 가구)를 내 가구로 복사한다 (로그인).
 * 모델 파일도 내 폴더로 복사해, 원래 주인이 지워도 내 것은 남는다.
 */
export async function POST(_request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return notFound('가구를 찾을 수 없습니다.');

  const supabase = await createClient();
  // 볼 수 있는지는 내 권한(RLS)으로 확인한다: 내 것이거나 공개 방의 공개 배치에 쓰인 것
  const { data: row, error } = await supabase.from('user_furniture').select('id, name, category, width_m, depth_m, height_m, model_key').eq('id', id.data).maybeSingle();
  if (error) return apiError(500, 'DB_ERROR', '가구를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  if (!row) return notFound('가구를 찾을 수 없습니다.');
  if (!row.model_key) return badRequest('3D 모델이 없는 가구입니다.');
  const { count } = await supabase.from('user_furniture').select('id', { count: 'exact', head: true }).eq('owner_id', user.id);
  if ((count ?? 0) >= MAX_USER_FURNITURE) return apiError(409, 'TOO_MANY', `내 가구는 ${MAX_USER_FURNITURE}개까지 만들 수 있습니다.`);

  const newId = crypto.randomUUID();
  const key = scanModelKey(user.id, newId);
  try {
    await copyObject(row.model_key, key);
  } catch (err) {
    console.error(err);
    return apiError(502, 'STORAGE_ERROR', '모델을 복사하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  const { data: copy, error: insertError } = await createAdminClient()
    .from('user_furniture')
    .insert({ id: newId, owner_id: user.id, name: row.name, category: row.category, width_m: row.width_m, depth_m: row.depth_m, height_m: row.height_m, source: 'scan', model_key: key })
    .select('id, name, category, width_m, depth_m, height_m')
    .maybeSingle();
  if (insertError || !copy) {
    await deleteObject(key).catch(() => undefined);
    return apiError(500, 'DB_ERROR', '내 가구를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  return NextResponse.json({ furniture: copy, modelUrl: await presignGet(key) });
}
