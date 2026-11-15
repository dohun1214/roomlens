import Image from 'next/image';
import Link from 'next/link';
import SamplePlan from '@/components/home/SamplePlan';
import RoomList from '@/components/rooms/RoomList';
import Icon, { type IconName } from '@/components/ui/Icon';
import { countByRoom, PUBLIC_ROOMS_LIMIT, toRoomCards, type RoomListRow } from '@/lib/rooms/list';
import { createClient, getCurrentUser } from '@/lib/supabase/server';
import heroImage from '@/public/samples/studio11-living.jpg';

const COLUMNS = 'id, owner_id, title, description, is_public, status, source, created_at, transform, floor_polygon, openings, thumbnail_key';

/** 이 서비스로 하는 두 가지 일. 둘은 같은 비중이다 */
const USES: { icon: IconName; tile: string; title: string; lead: string; points: string[] }[] = [
  {
    icon: 'door',
    tile: 'bg-[#e3ecfc] text-[#3d63bf]',
    title: '이사 가기 전에',
    lead: '집 보러 갔을 때 찍어 두면, 가 보지 않고도 새 방에 가구를 놓아 볼 수 있습니다.',
    points: ['지금 쓰는 침대·책상·옷장이 다 들어갈까?', '문을 열 때 가구에 걸리지 않을까?', '책상을 창가에 두면 지나갈 길이 남을까?'],
  },
  {
    icon: 'rotate',
    tile: 'bg-[#e1f2de] text-[#3f7f36]',
    title: '지금 방을 바꿀 때',
    lead: '무거운 가구를 직접 옮기기 전에, 새 배치를 3D로 먼저 확인합니다.',
    points: ['스캔에 찍힌 원래 가구를 그대로 떼어 옮겨 보기', '새 가구를 사기 전에 실제 크기로 놓아 보기', '통로·문 앞을 막지 않는지 자동 검사'],
  },
];

const STEPS: { icon: IconName; title: string; text: string }[] = [
  { icon: 'upload', title: '방 찍어 올리기', text: 'Scaniverse 같은 3D 스캔 앱으로 방을 한 바퀴 찍고 파일(.spz, .ply)을 올립니다.' },
  { icon: 'ruler', title: 'AI가 크기 맞추기', text: '바닥·벽·문·창문과 원래 있던 가구를 AI가 찾아 방을 실제 미터 단위로 맞춥니다.' },
  { icon: 'sofa', title: '가구 놓고 확인하기', text: '실제 치수의 가구를 끌어 놓거나 AI에게 추천받고, 겹침·문 앞·통로를 검사합니다.' },
];

const FEATURES = ['3D 방 둘러보기', '실제 치수(m)', '배치 자동 검사', 'AI 배치 추천'];

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
    <main className="mx-auto flex w-full max-w-[1160px] flex-1 flex-col gap-12 px-4 pt-2 pb-16 sm:gap-16 sm:px-6">
      <section className="flex flex-wrap items-center gap-8 rounded-[28px] bg-surface p-6 shadow-card sm:gap-10 sm:p-10" data-testid="home-hero">
        <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-5">
          <span className="self-start rounded-full bg-accent-soft px-3 py-1 text-[13px] font-semibold text-accent-strong">3D 방 · 실제 크기 가구 배치</span>
          <h1 className="text-[28px] leading-[1.25] font-bold tracking-[-0.025em] text-balance sm:text-[44px] sm:leading-[1.22]">
            방을 3D로 보고, <span className="whitespace-nowrap"><span className="text-accent">실제 크기</span>로</span> 가구를 놓아 보세요
          </h1>
          <p className="max-w-[30em] text-[15px] text-pretty text-sub sm:text-[17px]" data-testid="home-purpose">
            RoomLens는 휴대폰으로 찍은 방을 3D로 만들고, 실제 치수의 가구를 놓아 보는 서비스입니다. 이사 갈 방도, 지금 사는 방도 가구를 옮기기 전에 먼저 확인할 수
            있습니다.
          </p>
          <ul className="flex flex-wrap gap-2" aria-label="할 수 있는 것">
            {FEATURES.map((feature) => (
              <li key={feature} className="flex items-center gap-1.5 rounded-full bg-soft px-3 py-1.5 text-[13px] font-medium text-ink-2">
                <Icon name="check" size={13} className="text-accent" />
                {feature}
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center gap-3">
              {publicRooms.length > 0 && (
                <a href="#public-rooms" className="btn btn-primary h-[52px] rounded-[14px] px-6 text-base shadow-accent" data-testid="home-try">
                  샘플 방에서 해 보기
                  <Icon name="arrowRight" />
                </a>
              )}
              <Link
                href="/rooms/new"
                className={`btn h-[52px] rounded-[14px] px-6 text-base ${publicRooms.length > 0 ? 'btn-soft' : 'btn-primary shadow-accent'}`}
                data-testid="home-create"
              >
                <Icon name="upload" />내 방 올리기
              </Link>
            </div>
            {!user && <p className="text-[13px] text-mute">샘플 방은 로그인 없이 가구를 놓아 볼 수 있습니다. 저장·AI 추천은 로그인 후에 쓸 수 있습니다.</p>}
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
              아직 만든 방이 없습니다. 위의 &ldquo;내 방 올리기&rdquo;로 첫 방을 올려 보세요.
            </p>
          )}
        </section>
      )}

      <section aria-labelledby="home-uses-title" className="flex flex-col gap-[18px]" data-testid="home-uses">
        <h2 id="home-uses-title" className="text-2xl font-bold tracking-tight">
          이럴 때 씁니다
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          {USES.map((use) => (
            <div key={use.title} className="flex flex-col gap-4 rounded-[20px] bg-surface p-6 sm:p-7">
              <div className="flex items-center gap-3">
                <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px] ${use.tile}`}>
                  <Icon name={use.icon} size={22} />
                </span>
                <h3 className="text-xl font-bold">{use.title}</h3>
              </div>
              <p className="text-[15px] text-body">{use.lead}</p>
              <ul className="flex flex-col gap-2">
                {use.points.map((point) => (
                  <li key={point} className="flex items-start gap-2 text-sm text-sub">
                    <Icon name="check" size={15} className="mt-0.5 shrink-0 text-ok" />
                    {point}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="home-steps-title" className="flex flex-col gap-[18px]">
        <h2 id="home-steps-title" className="text-2xl font-bold tracking-tight">
          쓰는 순서
        </h2>
        <ol className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex flex-col gap-3 rounded-[20px] bg-surface p-6">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent font-mono text-[15px] font-semibold text-white">{i + 1}</span>
                <h3 className="text-lg font-bold">{step.title}</h3>
              </div>
              <p className="text-sm text-sub">{step.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="flex scroll-mt-6 flex-col gap-[18px]" id="public-rooms">
        <div className="flex flex-col gap-1">
          <h2 className="text-2xl font-bold tracking-tight">샘플 방</h2>
          <p className="text-[15px] text-sub">공개된 방에 들어가 가구를 놓아 보세요. 방을 직접 찍지 않아도 바로 해 볼 수 있습니다.</p>
        </div>
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
