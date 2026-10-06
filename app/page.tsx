import Image from 'next/image';
import Link from 'next/link';
import SamplePlan from '@/components/home/SamplePlan';
import RoomList from '@/components/rooms/RoomList';
import Icon, { type IconName } from '@/components/ui/Icon';
import { countByRoom, PUBLIC_ROOMS_LIMIT, toRoomCards, type RoomListRow } from '@/lib/rooms/list';
import { createClient, getCurrentUser } from '@/lib/supabase/server';
import heroImage from '@/public/samples/studio11-living.jpg';

const COLUMNS = 'id, owner_id, title, description, is_public, status, source, created_at, transform, floor_polygon, openings';

const STEPS: { icon: IconName; tile: string; title: string; text: string }[] = [
  { icon: 'upload', tile: 'bg-[#e3ecfc] text-[#3d63bf]', title: '방 올리기', text: 'Scaniverse 같은 앱으로 찍은 3D 파일(.spz, .ply)을 올립니다.' },
  { icon: 'ruler', tile: 'bg-[#fcebd3] text-[#a66a17]', title: '크기 맞추기', text: '바닥과 방 모서리를 찍고 벽 하나의 실제 길이를 넣으면 방이 미터 단위가 됩니다.' },
  { icon: 'sofa', tile: 'bg-[#e1f2de] text-[#3f7f36]', title: '가구 놓기', text: '실제 크기의 가구를 끌어 놓거나 AI에게 배치를 추천받고, 겹침·문 앞·통로를 검사합니다.' },
];

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
  const myRoomIds = myRows.map((room) => room.id);
  // 내 방 카드의 상태: 내가 저장한 배치 수와 분석 리포트가 있는지
  const [{ data: profiles }, { data: layoutRows }, { data: reportRows }] = await Promise.all([
    ownerIds.length ? supabase.from('profiles').select('id, nickname').in('id', ownerIds) : Promise.resolve({ data: [] }),
    user && myRoomIds.length
      ? supabase.from('layouts').select('room_id').eq('owner_id', user.id).in('room_id', myRoomIds)
      : Promise.resolve({ data: [] }),
    myRoomIds.length ? supabase.from('room_reports').select('room_id').in('room_id', myRoomIds) : Promise.resolve({ data: [] }),
  ]);
  const nicknames = new Map((profiles ?? []).map((profile) => [profile.id, profile.nickname]));

  const publicRooms = toRoomCards(publicRows, nicknames, false);
  const myRooms = toRoomCards(myRows, nicknames, true, {
    layoutCounts: countByRoom(layoutRows),
    reportRoomIds: new Set((reportRows ?? []).map((row) => row.room_id)),
  });

  return (
    <main className="mx-auto flex w-full max-w-[1160px] flex-1 flex-col gap-12 px-4 pt-2 pb-16 sm:gap-14 sm:px-6">
      <section className="flex flex-wrap items-center gap-8 rounded-[28px] bg-surface p-6 shadow-card sm:gap-10 sm:p-10" data-testid="home-hero">
        <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-5">
          <span className="self-start rounded-full bg-accent-soft px-3 py-1 text-[13px] font-semibold text-accent-strong">자취방 3D 복원 · 가구 배치 시뮬레이션</span>
          <h1 className="text-[28px] leading-[1.25] font-bold tracking-[-0.025em] text-balance sm:text-[44px] sm:leading-[1.22]">
            찍은 방을 3D로 둘러보고, <span className="text-accent">실제 치수</span>의 가구를 놓아 봅니다
          </h1>
          <p className="max-w-[30em] text-[15px] text-pretty text-sub sm:text-[17px]">
            휴대폰으로 찍은 방을 올리고 벽 하나의 길이만 알려 주면, 침대와 책상이 들어가는지, 문 앞과 통로를 막지 않는지 방에 가 보지 않고 확인할 수
            있습니다.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/rooms/new" className="btn btn-primary h-[52px] rounded-[14px] px-6 text-base shadow-accent" data-testid="home-create">
              방 만들기
              <Icon name="arrowRight" />
            </Link>
            {publicRooms.length > 0 && (
              <a href="#public-rooms" className="btn btn-soft h-[52px] rounded-[14px] px-5 text-base">
                공개된 방 둘러보기
              </a>
            )}
          </div>
        </div>

        <figure className="relative min-w-0 flex-[1_1_440px]">
          <Image
            src={heroImage}
            alt="3D로 복원한 방의 거실"
            priority
            sizes="(min-width: 1024px) 520px, 100vw"
            className="aspect-[4/3] w-full rounded-[22px] object-cover"
          />
          <span className="absolute top-4 right-4 rounded-full bg-surface/95 px-3 py-1.5 font-mono text-xs text-ink-2">10.55 × 5.80 m</span>
          <div className="absolute bottom-10 left-4 flex w-[46%] max-w-[230px] flex-col gap-1.5 rounded-2xl bg-surface p-3 shadow-float">
            <SamplePlan className="block h-auto w-full" />
            <span className="text-xs font-semibold">평면도에서도 가구 배치</span>
          </div>
          <figcaption className="mt-2.5 text-right text-xs text-mute">Studio 11 by milanoski (SuperSplat), CC BY 4.0 · 스플랫 수를 줄여 찍은 화면</figcaption>
        </figure>
      </section>

      <section aria-label="쓰는 순서" className="grid gap-4 sm:grid-cols-3">
        {STEPS.map((step, i) => (
          <div key={step.title} className="flex flex-col gap-3 rounded-[20px] bg-surface p-6">
            <div className="flex items-center justify-between">
              <span className={`flex h-11 w-11 items-center justify-center rounded-[13px] ${step.tile}`}>
                <Icon name={step.icon} size={22} />
              </span>
              <span className="font-mono text-[13px] text-mute">0{i + 1}</span>
            </div>
            <h2 className="text-lg font-bold">{step.title}</h2>
            <p className="text-sm text-sub">{step.text}</p>
          </div>
        ))}
      </section>

      {user && (
        <section className="flex flex-col gap-[18px]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-2xl font-bold tracking-tight">
              내 방{myRooms.length > 0 && <span className="ml-2 font-mono text-lg font-medium text-mute">{myRooms.length}</span>}
            </h2>
            <Link href="/rooms/new" className="btn h-10 rounded-full bg-surface px-4 text-sm hover:bg-soft">
              <Icon name="plus" />새 방 올리기
            </Link>
          </div>
          {myRooms.length ? (
            <RoomList rooms={myRooms} testId="my-rooms" />
          ) : (
            <p className="rounded-[20px] bg-surface px-7 py-8 text-[15px] text-sub" data-testid="my-rooms-empty">
              아직 만든 방이 없습니다. 위의 &ldquo;방 만들기&rdquo;로 첫 방을 올려 보세요.
            </p>
          )}
        </section>
      )}

      <section className="flex scroll-mt-6 flex-col gap-[18px]" id="public-rooms">
        <h2 className="text-2xl font-bold tracking-tight">공개된 방</h2>
        {publicRooms.length ? (
          <RoomList rooms={publicRooms} testId="public-rooms" />
        ) : (
          <p className="rounded-[20px] bg-surface px-7 py-8 text-[15px] text-sub" data-testid="public-rooms-empty">
            아직 공개된 방이 없습니다.
          </p>
        )}
      </section>
    </main>
  );
}
