import 'server-only';
import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

/**
 * secret key로 동작하는 서버 전용 클라이언트. RLS를 건너뛰므로
 * 반드시 호출하기 전에 "누가 요청했는지, 그 사람의 것인지"를 코드에서 확인한다.
 * 브라우저가 쓸 수 없는 컬럼(rooms.status, splat_key 등)을 바꿀 때만 쓴다.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('환경변수 NEXT_PUBLIC_SUPABASE_URL 또는 SUPABASE_SECRET_KEY 가 없습니다.');
  return createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
