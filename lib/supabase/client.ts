import { createBrowserClient } from '@supabase/ssr';
import type { Database } from './database.types';

/** 브라우저(클라이언트 컴포넌트)에서 쓰는 Supabase 클라이언트. 접근 권한은 RLS가 정한다. */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}
