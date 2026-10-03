import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from './database.types';

/**
 * 서버 컴포넌트·Route Handler에서 쓰는 Supabase 클라이언트.
 * 로그인한 사용자의 쿠키로 동작하므로 접근 권한은 그 사용자의 RLS를 따른다.
 */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // 서버 컴포넌트에서는 쿠키를 쓸 수 없다. 세션 갱신은 proxy.ts가 맡으므로 무시해도 된다.
          }
        },
      },
    },
  );
}

export type CurrentUser = { id: string; email: string | null };

/**
 * 로그인한 사용자. JWT 서명을 검증하는 getClaims()를 쓴다
 * (getSession()은 쿠키 내용을 그대로 믿으므로 서버에서 신뢰하지 않는다).
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) return null;
  return { id: data.claims.sub, email: typeof data.claims.email === 'string' ? data.claims.email : null };
}
