import Link from 'next/link';
import LogoutButton from '@/components/auth/LogoutButton';
import Logo from '@/components/ui/Logo';
import { createClient, getCurrentUser } from '@/lib/supabase/server';

/** 닉네임의 첫 글자를 넣은 동그란 표시 */
export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-[#e3e8ff] text-[13px] font-bold text-accent-strong"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {[...name.trim()][0] ?? '?'}
    </span>
  );
}

/** 모든 화면 위의 메뉴. 높이는 --header-h로 고정해 방 화면이 남은 높이를 계산할 수 있게 한다. */
export default async function SiteHeader() {
  const user = await getCurrentUser();
  let nickname: string | null = null;
  if (user) {
    const supabase = await createClient();
    const { data } = await supabase.from('profiles').select('nickname').eq('id', user.id).maybeSingle();
    nickname = data?.nickname ?? null;
  }
  const displayName = nickname ?? user?.email ?? '내 정보';

  return (
    <header className="h-(--header-h) shrink-0 bg-ground" data-testid="site-header">
      <div className="mx-auto flex h-full w-full max-w-[1160px] items-center justify-between gap-3 px-4 sm:px-6">
        <nav className="flex min-w-0 items-center gap-3 sm:gap-7" aria-label="메뉴">
          <Link href="/" aria-label="RoomLens 홈">
            <Logo className="text-[17px] sm:text-[19px]" />
          </Link>
          {user && (
            <Link href="/rooms/new" className="flex h-10 items-center rounded-full px-3.5 text-sm font-medium text-sub hover:bg-surface hover:text-ink">
              방 만들기
            </Link>
          )}
        </nav>
        <div className="flex items-center gap-1 text-sm sm:gap-3">
          {user ? (
            <>
              <Link href="/account" className="flex h-10 items-center gap-2 rounded-full pr-2 text-body hover:text-ink" title="내 정보">
                <Avatar name={displayName} />
                <span className="hidden max-w-40 truncate sm:inline" data-testid="header-nickname">
                  {displayName}
                </span>
              </Link>
              <LogoutButton />
            </>
          ) : (
            <Link href="/login" className="btn btn-outline h-10 px-4 text-sm">
              로그인
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
