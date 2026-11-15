import Image from 'next/image';
import Link from 'next/link';
import SampleRooms from '@/components/home/SampleRooms';
import RoomList from '@/components/rooms/RoomList';
import Icon, { type IconName } from '@/components/ui/Icon';
import { pickFeatured } from '@/lib/rooms/featured';
import { SURVEY_URL } from '@/lib/survey';
import { countByRoom, PUBLIC_ROOMS_LIMIT, toRoomCards, type RoomListRow } from '@/lib/rooms/list';
import { createClient, getCurrentUser } from '@/lib/supabase/server';
import heroImage from '@/public/home/hero-bedroom.jpg';
import moveAfter from '@/public/home/move-after.jpg';
import moveBefore from '@/public/home/move-before.jpg';
import oneroomImage from '@/public/home/oneroom.jpg';
import placedImage from '@/public/home/placed-3d.jpg';
import planImage from '@/public/home/plan-ai.jpg';

const COLUMNS = 'id, owner_id, title, description, is_public, status, source, created_at, transform, floor_polygon, openings, thumbnail_key';

const FEATURES: { icon: IconName; title: string; text: string; note: string; dark?: boolean }[] = [
  {
    icon: 'ruler',
    title: 'AI 방 준비',
    text: '바닥과 벽을 찾아 방을 미터 단위로 맞추고, 문·창문과 원래 있던 가구를 찾아 표시합니다.',
    note: '방 모양 일치도 89% · 시험 장면 72곳',
  },
  {
    icon: 'check',
    title: '배치 자동 검사',
    text: '놓을 때마다 겹침, 방 밖, 문 앞, 60 cm 통로, 창문 가림을 검사합니다.',
    note: '검사 5가지',
  },
  {
    icon: 'chat',
    title: '말로 하는 AI 배치 추천',
    text: '"책상은 창가에, 침대는 문에서 먼 쪽에"라고 적으면 AI가 배치하고 이유를 알려 줍니다.',
    note: '요청 반영 88% · 한국식 방 4곳',
    dark: true,
  },
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

  const featured = pickFeatured(publicRooms);
  const pill = 'flex items-center gap-2 rounded-full bg-surface/95 px-3.5 py-2 text-sm font-semibold text-ink shadow-sm';

  return (
    <main className="flex w-full flex-1 flex-col pb-16" data-page="home">
      {/* 첫 화면: 무엇을 하는 서비스인지 */}
      <section className="mx-auto flex w-full max-w-[1200px] flex-col items-center gap-6 px-4 pt-10 text-center sm:px-6 sm:pt-16" data-testid="home-hero">
        <span className="rounded-full bg-accent-soft px-3.5 py-1.5 text-[13px] font-semibold text-accent-strong sm:text-sm">이사 전 확인 · 지금 방 재배치</span>
        <h1 className="max-w-[900px] text-[34px] leading-[1.18] font-bold tracking-[-0.04em] text-balance sm:text-[56px] lg:text-[68px] lg:leading-[1.12]">
          방을 3D로 보고, <span className="whitespace-nowrap"><span className="text-accent">실제 크기</span>로</span> 가구를 놓아 보세요
        </h1>
        <p className="max-w-[620px] text-[15px] leading-relaxed text-pretty text-sub sm:text-lg" data-testid="home-purpose">
          RoomLens는 휴대폰으로 찍은 방을 3D로 만들고, 실제 치수의 가구를 놓아 보는 서비스입니다. 침대가 들어가는지, 문과 통로를 막지 않는지 옮기기 전에 확인하세요.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          {featured.length > 0 && (
            <a href="#sample-rooms" className="btn btn-primary h-14 rounded-full px-7 text-base shadow-accent sm:text-[17px]" data-testid="home-try">
              샘플 방에서 해 보기
              <Icon name="arrowRight" />
            </a>
          )}
          <Link
            href="/rooms/new"
            className={`btn h-14 rounded-full px-7 text-base sm:text-[17px] ${featured.length > 0 ? 'bg-soft text-ink hover:bg-chip' : 'btn-primary shadow-accent'}`}
            data-testid="home-create"
          >
            내 방 올리기
          </Link>
        </div>
        <p className="text-[13px] text-mute sm:text-sm">{user ? '저장한 배치와 AI 추천은 내 방 목록에서 이어서 할 수 있습니다' : '로그인 없이 바로 체험 · 저장과 AI 추천은 로그인 후'}</p>
        <a href={SURVEY_URL} target="_blank" rel="noopener noreferrer" className="rounded-full bg-warn-tint px-4 py-2 text-[13px] font-semibold text-warn hover:bg-warn-soft sm:text-sm" data-testid="home-survey">
          써 보셨다면 1분 설문에 답해 주세요 →
        </a>
      </section>

      {/* 화면 미리 보기 */}
      <section aria-label="화면 미리 보기" className="mx-auto mt-10 w-full max-w-[1200px] px-4 sm:mt-14 sm:px-6">
        <div className="grid gap-4 lg:grid-cols-3">
          <figure className="relative min-h-[300px] overflow-hidden rounded-[28px] bg-soft sm:min-h-[420px] lg:col-span-2 lg:min-h-[480px]">
            <Image src={heroImage} alt="3D로 복원한 침실. AI가 원래 있던 가구를 찾아 상자로 표시했다" priority sizes="(min-width: 1024px) 780px, 100vw" className="object-cover" fill />
            <div className="absolute right-4 bottom-4 left-4 flex flex-wrap gap-2 sm:right-5 sm:bottom-5 sm:left-5">
              <span className={pill}>
                <span className="h-2 w-2 rounded-full bg-ok-dot" />
                크기 보정됨 · <span className="font-mono font-medium">5.8 × 4.0 m</span>
              </span>
              <span className={pill}>AI가 찾은 원래 가구 4개</span>
            </div>
          </figure>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
            <figure className="relative min-h-[220px] overflow-hidden rounded-[28px] bg-soft">
              <Image src={placedImage} alt="3D 방에 소파·침대·책상을 놓은 화면" sizes="(min-width: 1024px) 380px, 50vw" className="object-cover" fill />
              <span className="absolute top-4 left-4 rounded-full bg-surface/95 px-3 py-1.5 text-[13px] font-semibold shadow-sm">3D에서 가구 놓기</span>
            </figure>
            <figure className="relative min-h-[220px] overflow-hidden rounded-[28px] bg-[#fafafa] ring-1 ring-line ring-inset">
              <Image src={planImage} alt="가구를 놓은 평면도" sizes="(min-width: 1024px) 380px, 50vw" className="object-contain p-4" fill />
              <span className="absolute top-4 left-4 rounded-full bg-ink px-3 py-1.5 text-[13px] font-semibold text-white">평면도로 한눈에</span>
            </figure>
          </div>
        </div>
        <p className="mt-2.5 text-right text-xs text-mute">Bedroom by ethan3111, HAUSSMANN APARTMENT by Stéphane Agullo (SuperSplat), CC BY 4.0 · RoomLens 화면</p>
      </section>

      {user && (
        <section className="mx-auto mt-20 flex w-full max-w-[1200px] flex-col gap-[18px] px-4 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-2xl font-bold tracking-tight sm:text-[28px]">
              내 방{myRooms.length > 0 && <span className="ml-2 font-mono text-lg font-medium text-mute">{myRooms.length}</span>}
            </h2>
            <Link href="/rooms/new" className="btn h-10 rounded-full bg-soft px-4 text-sm hover:bg-chip">
              <Icon name="plus" />새 방 올리기
            </Link>
          </div>
          {myRooms.length ? (
            <RoomList rooms={myRooms} testId="my-rooms" />
          ) : (
            <p className="rounded-[20px] bg-ground px-7 py-8 text-[15px] text-sub" data-testid="my-rooms-empty">
              아직 만든 방이 없습니다. 위의 &ldquo;내 방 올리기&rdquo;로 첫 방을 올려 보세요.
            </p>
          )}
        </section>
      )}

      {/* 쓰임새 두 가지 (같은 비중) */}
      <section aria-labelledby="home-uses-title" className="mx-auto mt-24 flex w-full max-w-[1200px] flex-col gap-8 px-4 sm:mt-32 sm:px-6" data-testid="home-uses">
        <h2 id="home-uses-title" className="text-center text-[28px] font-bold tracking-[-0.03em] sm:text-[40px]">
          두 가지 상황에서 씁니다
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-4 rounded-[28px] bg-accent-soft p-6 sm:p-9">
            <span className="text-sm font-bold text-accent-strong">A · 이사 가기 전에</span>
            <h3 className="text-[22px] leading-snug font-bold tracking-[-0.025em] sm:text-[28px]">가 보지 않은 방에 지금 가진 가구를 놓아 봅니다</h3>
            <p className="text-[15px] leading-relaxed text-ink-2 sm:text-base">
              집 보러 갔을 때 한 바퀴 찍어 두면, 침대·책상·옷장이 다 들어가는지, 문을 열 때 걸리지 않는지 이사 전에 알 수 있습니다.
            </p>
            <Image src={oneroomImage} alt="3D로 복원한 오피스텔 원룸" sizes="(min-width: 768px) 520px, 100vw" className="mt-auto aspect-video w-full rounded-[18px] object-cover" />
          </div>
          <div className="flex flex-col gap-4 rounded-[28px] bg-ok-soft p-6 sm:p-9">
            <span className="text-sm font-bold text-ok">B · 지금 방을 바꿀 때</span>
            <h3 className="text-[22px] leading-snug font-bold tracking-[-0.025em] sm:text-[28px]">무거운 가구를 옮기기 전에 새 배치를 먼저 봅니다</h3>
            <p className="text-[15px] leading-relaxed text-ink-2 sm:text-base">
              스캔에 찍힌 원래 가구를 그대로 떼어 옮겨 보고(빈자리는 AI가 채움), 새로 살 가구는 실제 크기로 놓아 봅니다.
            </p>
            <div className="mt-auto grid grid-cols-2 gap-2">
              <figure className="relative">
                <Image src={moveBefore} alt="옮기기 전: 창가의 의자" sizes="(min-width: 768px) 260px, 50vw" className="aspect-[8/9] w-full rounded-[18px] object-cover" />
                <figcaption className="absolute top-3 left-3 rounded-lg bg-surface px-2.5 py-1 text-xs font-bold">지금</figcaption>
              </figure>
              <figure className="relative">
                <Image src={moveAfter} alt="옮긴 뒤: 의자를 떼어 낸 자리를 AI가 채웠다" sizes="(min-width: 768px) 260px, 50vw" className="aspect-[8/9] w-full rounded-[18px] object-cover" />
                <figcaption className="absolute top-3 left-3 rounded-lg bg-ok px-2.5 py-1 text-xs font-bold text-white">옮긴 뒤</figcaption>
              </figure>
            </div>
          </div>
        </div>
      </section>

      {/* 기능 */}
      <section aria-labelledby="home-features-title" className="mx-auto mt-24 flex w-full max-w-[1200px] flex-col gap-8 px-4 sm:mt-32 sm:px-6">
        <h2 id="home-features-title" className="text-center text-[28px] font-bold tracking-[-0.03em] text-balance sm:text-[40px]">
          AI가 방을 준비하고, 배치를 도와줍니다
        </h2>
        <div className="grid gap-4 md:grid-cols-3">
          {FEATURES.map((feature) => (
            <div key={feature.title} className={`flex flex-col gap-3.5 rounded-[24px] p-7 ${feature.dark ? 'bg-ink text-white' : 'bg-ground'}`}>
              <span className={`flex h-11 w-11 items-center justify-center rounded-[13px] ${feature.dark ? 'bg-accent text-white' : 'bg-surface text-accent'}`}>
                <Icon name={feature.icon} size={22} />
              </span>
              <h3 className="text-xl font-bold">{feature.title}</h3>
              <p className={`text-[15px] leading-relaxed ${feature.dark ? 'text-[#b4bccd]' : 'text-sub'}`}>{feature.text}</p>
              <span className={`mt-auto text-[13px] font-semibold ${feature.dark ? 'text-[#9fb0ff]' : 'text-accent'}`}>{feature.note}</span>
            </div>
          ))}
        </div>
        <ol className="grid gap-3 sm:grid-cols-3" aria-label="쓰는 순서">
          {['방을 3D 스캔 앱으로 찍어 올리기', '"AI로 방 준비하기"로 크기·문·창문 맞추기', '가구를 놓고 저장·공유하기'].map((step, i) => (
            <li key={step} className="flex items-center gap-3 rounded-2xl border border-line px-5 py-4 text-[15px] text-ink-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent font-mono text-sm font-semibold text-white">{i + 1}</span>
              {step}
            </li>
          ))}
        </ol>
      </section>

      {/* 샘플 방 */}
      <section id="sample-rooms" aria-labelledby="sample-rooms-title" className="mx-auto mt-24 flex w-full max-w-[1200px] scroll-mt-6 flex-col gap-7 px-4 sm:mt-32 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-2">
            <h2 id="sample-rooms-title" className="text-[28px] font-bold tracking-[-0.03em] sm:text-[40px]">
              샘플 방
            </h2>
            <p className="text-[15px] text-sub sm:text-base">로그인 없이 들어가 가구를 놓아 보세요.</p>
          </div>
          {publicRooms.length > 0 && (
            <a href="#public-rooms" className="text-[15px] font-semibold text-accent hover:text-accent-strong">
              공개된 방 전체 보기 →
            </a>
          )}
        </div>
        {featured.length ? (
          <SampleRooms rooms={featured} />
        ) : (
          <p className="rounded-[20px] bg-ground px-7 py-8 text-[15px] text-sub" data-testid="public-rooms-empty">
            아직 공개된 방이 없습니다.
          </p>
        )}
      </section>

      {/* 마지막 권유 */}
      <section aria-label="시작하기" className="mx-auto mt-24 w-full max-w-[1200px] px-4 sm:mt-32 sm:px-6">
        <div className="flex flex-col items-center gap-4 rounded-[32px] bg-accent px-6 py-14 text-center text-white sm:px-10">
          <h2 className="text-[26px] font-bold tracking-[-0.03em] sm:text-[36px]">가구를 옮기기 전에, 먼저 3D로</h2>
          <p className="text-[15px] text-[#dde3ff] sm:text-base">스캔 파일이 없어도 샘플 방에서 바로 시작할 수 있습니다.</p>
          <div className="mt-2 flex flex-wrap justify-center gap-3">
            <a href="#sample-rooms" className="btn h-[52px] rounded-full bg-white px-6 text-base font-bold text-accent-strong hover:bg-accent-tint">
              샘플 방에서 해 보기
            </a>
            <Link href="/rooms/new" className="btn h-[52px] rounded-full border border-white/50 px-6 text-base text-white hover:bg-white/10">
              내 방 올리기
            </Link>
          </div>
        </div>
      </section>

      {/* 공개된 방 전체 */}
      {publicRooms.length > 0 && (
        <section className="mx-auto mt-24 flex w-full max-w-[1200px] scroll-mt-6 flex-col gap-[18px] px-4 sm:px-6" id="public-rooms">
          <h2 className="text-2xl font-bold tracking-tight">공개된 방 전체</h2>
          <RoomList rooms={publicRooms} testId="public-rooms" />
        </section>
      )}

      <footer className="mx-auto mt-20 flex w-full max-w-[1200px] flex-wrap justify-between gap-3 px-4 text-[13px] text-mute sm:px-6">
        <span>
          RoomLens · 2026 교내 AI 경진대회 출품작 ·{' '}
          <a href={SURVEY_URL} target="_blank" rel="noopener noreferrer" className="underline hover:text-ink">
            사용자 설문
          </a>
        </span>
        <span>한국식 샘플 방은 RoomLens에서 직접 만든 장면입니다</span>
      </footer>
    </main>
  );
}
