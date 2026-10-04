import Link from 'next/link';
import RoomList from '@/components/rooms/RoomList';
import { PUBLIC_ROOMS_LIMIT, toRoomCards, type RoomListRow } from '@/lib/rooms/list';
import { createClient, getCurrentUser } from '@/lib/supabase/server';

const COLUMNS = 'id, owner_id, title, description, is_public, status, source, created_at';

/**
 * 홈: 공개 방 목록과 (로그인했다면) 내 방 목록.
 * 로그인한 사용자의 권한(RLS)으로 읽으므로 남의 비공개 방은 애초에 나오지 않는다.
 */
export default async function Home() {
  const user = await getCurrentUser();
  const supabase = await createClient();

  const [publicResult, mineResult] = await Promise.all([
    supabase
      .from('rooms')
      .select(COLUMNS)
      .eq('is_public', true)
      .eq('status', 'ready')
      .order('created_at', { ascending: false })
      .limit(PUBLIC_ROOMS_LIMIT),
    user
      ? supabase.from('rooms').select(COLUMNS).eq('owner_id', user.id).order('created_at', { ascending: false })
      : Promise.resolve({ data: [] as RoomListRow[] }),
  ]);
  const publicRows: RoomListRow[] = publicResult.data ?? [];
  const myRows: RoomListRow[] = mineResult.data ?? [];

  // 올린 사람 닉네임 (profiles는 누구나 읽을 수 있다)
  const ownerIds = [...new Set([...publicRows, ...myRows].map((room) => room.owner_id))];
  const { data: profiles } = ownerIds.length
    ? await supabase.from('profiles').select('id, nickname').in('id', ownerIds)
    : { data: [] };
  const nicknames = new Map((profiles ?? []).map((profile) => [profile.id, profile.nickname]));

  const publicRooms = toRoomCards(publicRows, nicknames, false);
  const myRooms = toRoomCards(myRows, nicknames, true);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 space-y-10 px-6 py-10">
      <section className="space-y-3">
        <h1 className="text-3xl font-bold">RoomLens</h1>
        <p className="text-neutral-600 dark:text-neutral-300">
          휴대폰으로 찍은 방을 3D로 둘러보고, 실제 치수의 가구를 배치해 보는 서비스입니다.
        </p>
        <Link href="/rooms/new" className="inline-block rounded bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-white dark:text-neutral-900">
          방 만들기
        </Link>
      </section>

      {user && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">내 방</h2>
          {myRooms.length ? (
            <RoomList rooms={myRooms} testId="my-rooms" />
          ) : (
            <p className="text-sm text-neutral-500" data-testid="my-rooms-empty">
              아직 만든 방이 없습니다. 위의 &ldquo;방 만들기&rdquo;로 첫 방을 올려 보세요.
            </p>
          )}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">공개된 방</h2>
        {publicRooms.length ? (
          <RoomList rooms={publicRooms} testId="public-rooms" />
        ) : (
          <p className="text-sm text-neutral-500" data-testid="public-rooms-empty">
            아직 공개된 방이 없습니다.
          </p>
        )}
      </section>
    </main>
  );
}
