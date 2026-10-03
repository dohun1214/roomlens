import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { isProtectedPath, loginUrlFor } from '@/lib/auth/paths';
import type { Database } from './database.types';

/**
 * 요청마다 Supabase 세션(쿠키)을 갱신하고, 로그인이 필요한 경로는 로그인 화면으로 보낸다.
 * createServerClient 와 getClaims() 사이에 다른 코드를 넣지 않는다 (세션이 풀리는 원인이 된다).
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);

  if (!signedIn && isProtectedPath(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    const target = loginUrlFor(request.nextUrl.pathname + request.nextUrl.search);
    const [pathname, search = ''] = target.split('?');
    url.pathname = pathname;
    url.search = search ? `?${search}` : '';
    return NextResponse.redirect(url);
  }

  // 갱신된 쿠키가 담긴 response 를 그대로 돌려줘야 한다
  return response;
}
