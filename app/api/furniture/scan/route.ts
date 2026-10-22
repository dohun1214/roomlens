import { NextResponse } from 'next/server';
import { apiError, badRequest, unauthenticated } from '@/lib/api/http';
import { checkUserFurnitureValue, MAX_USER_FURNITURE } from '@/lib/layout/userFurniture';
import { deleteObject, presignGet, putObject } from '@/lib/r2';
import { checkGlb, MAX_SCAN_MODEL_BYTES, SCAN_MODEL_CONTENT_TYPE, scanModelKey } from '@/lib/scan/glb';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient, getCurrentUser } from '@/lib/supabase/server';

/**
 * 3D 스캔 가구 만들기 (로그인). 브라우저가 바닥을 지우고 줄인 GLB와 이름·치수(m)를 multipart로 보낸다.
 * 모델은 R2 furniture/user/{사용자}/{가구}.glb 에 올리고, 내 가구(source = scan, model_key)를 만든다.
 * model_key·source 는 브라우저 권한으로 쓸 수 없는 열이라 서버 전용 클라이언트로 넣는다.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_SCAN_MODEL_BYTES + 64 * 1024) return badRequest(`모델이 너무 큽니다 (${MAX_SCAN_MODEL_BYTES / 1024 / 1024}MB까지).`);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return badRequest();
  }
  const parsed = checkUserFurnitureValue({ name: form.get('name'), w: form.get('w'), d: form.get('d'), h: form.get('h') });
  if (!parsed.ok) return badRequest(parsed.message);
  const file = form.get('file');
  if (!(file instanceof Blob)) return badRequest('모델 파일이 없습니다.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const glb = checkGlb(bytes);
  if (!glb.ok) return badRequest(glb.message);

  const supabase = await createClient();
  const { count, error: countError } = await supabase.from('user_furniture').select('id', { count: 'exact', head: true }).eq('owner_id', user.id);
  if (countError) return apiError(500, 'DB_ERROR', '내 가구를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  if ((count ?? 0) >= MAX_USER_FURNITURE) return apiError(409, 'TOO_MANY', `내 가구는 ${MAX_USER_FURNITURE}개까지 만들 수 있습니다.`);

  const id = crypto.randomUUID();
  const key = scanModelKey(user.id, id);
  try {
    await putObject(key, bytes, SCAN_MODEL_CONTENT_TYPE);
  } catch (err) {
    console.error(err);
    return apiError(502, 'STORAGE_ERROR', '모델을 올리지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  const { value } = parsed;
  const { data: row, error } = await createAdminClient()
    .from('user_furniture')
    .insert({ id, owner_id: user.id, name: value.name, width_m: value.w, depth_m: value.d, height_m: value.h, source: 'scan', model_key: key })
    .select('id, name, category, width_m, depth_m, height_m')
    .maybeSingle();
  if (error || !row) {
    await deleteObject(key).catch(() => undefined);
    return apiError(500, 'DB_ERROR', '내 가구를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  return NextResponse.json({ furniture: row, modelUrl: await presignGet(key) });
}
