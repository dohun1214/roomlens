import Link from 'next/link';
import LogoutButton from '@/components/auth/LogoutButton';
import { createClient, getCurrentUser } from '@/lib/supabase/server';

/** 모든 화면 위의 메뉴. 높이는 3rem(h-12)로 고정해 뷰어가 남은 높이를 계산할 수 있게 한다. */
export default async function SiteHeader() {
  const user = await getCurrentUser();
  let nickname: string | null = null;
  if (user) {
    const supabase = await createClient();
    const { data } = await supabase.from('profiles').select('nickname').eq('id', user.id).maybeSingle();
    nickname = data?.nickname ?? null;
  }

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-200 px-4 text-sm dark:border-neutral-800">
      <nav className="flex items-center gap-4">
        <Link href="/" className="font-bold">
          RoomLens
        </Link>
        <Link href="/viewer" className="text-neutral-500 hover:underline">
          3D 뷰어
        </Link>
      </nav>
      <div className="flex items-center gap-3">
        {user ? (
          <>
            <Link href="/account" className="hover:underline" data-testid="header-nickname">
              {nickname ?? user.email ?? '내 정보'}
            </Link>
            <LogoutButton />
          </>
        ) : (
          <Link href="/login" className="hover:underline">
            로그인
          </Link>
        )}
      </div>
    </header>
  );
}
