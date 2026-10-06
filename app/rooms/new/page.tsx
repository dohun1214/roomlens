import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import RoomUploadForm from '@/components/rooms/RoomUploadForm';
import Icon from '@/components/ui/Icon';
import { loginUrlFor } from '@/lib/auth/paths';
import { getCurrentUser } from '@/lib/supabase/server';

export const metadata: Metadata = { title: '방 만들기 | RoomLens' };

const GUIDE = [
  '조명을 모두 켜고 커튼을 엽니다.',
  '우편물·신분증처럼 개인정보가 보이는 물건은 치웁니다.',
  '초당 5~10cm로 천천히 움직이고, 화면이 60% 이상 겹치게 찍습니다.',
  '눈높이·위·아래 세 높이로 찍습니다.',
  '벽을 따라 한 바퀴 돈 뒤 방 가운데에서 한 바퀴 더 돕니다.',
];

export default async function NewRoomPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlFor('/rooms/new')); // proxy.ts 가 먼저 막지만 한 번 더 확인

  return (
    <main className="mx-auto flex w-full max-w-[1160px] flex-1 flex-col gap-7 px-4 pt-6 pb-16 sm:px-6">
      <div className="space-y-1.5">
        <h1 className="text-[34px] font-bold tracking-[-0.02em]">방 만들기</h1>
        <p className="text-base text-sub">찍어 둔 방의 3D 파일을 올립니다. 올린 방은 공개로 바꾸기 전까지 나만 볼 수 있습니다.</p>
      </div>

      <div className="flex flex-col items-start gap-6 lg:flex-row">
        <section className="w-full min-w-0 rounded-3xl bg-surface p-5 shadow-card sm:p-8 lg:flex-[999_1_520px]">
          <h2 className="sr-only">파일 올리기</h2>
          <RoomUploadForm />
        </section>

        <aside className="flex w-full flex-col gap-4 lg:flex-[1_1_320px]">
          <section className="flex flex-col gap-4 rounded-3xl bg-surface p-6 text-sm" data-testid="capture-guide">
            <h2 className="text-[17px] font-bold">방 3D 파일 준비하기</h2>
            <p className="text-ink-2">
              무료 앱 <strong>Scaniverse</strong>에서 스플랫(Splat) 방식으로 방을 찍습니다. 일반 동영상은 쓸 수 없고, 앱 안에서 찍어야 합니다.
            </p>
            <ol className="flex flex-col gap-3 text-ink-2">
              {GUIDE.map((line, i) => (
                <li key={line} className="flex gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft font-mono text-xs font-medium text-accent-strong">{i + 1}</span>
                  <span className="pt-[3px]">{line}</span>
                </li>
              ))}
            </ol>
            <p className="text-ink-2">
              다 찍으면 앱에서 <strong>SPZ</strong> 또는 <strong>PLY</strong> 파일로 내보냅니다. SPZ가 열리지 않는다는 안내가 나오면 PLY로 내보내 주세요.
            </p>
            <p className="rounded-2xl bg-ground p-4 text-body" data-testid="dataset-guide">
              직접 찍지 않아도 됩니다. 공개 데이터셋의 방 3D 파일(.ply, .spz, .sog)을 올려도 같은 기능을 쓸 수 있습니다. 이때는 &ldquo;다른 사람이 만든 3D&rdquo;를 고르고
              출처와 라이선스를 적어 주세요.
            </p>
          </section>

          <section className="flex gap-3.5 rounded-3xl bg-accent-soft p-6">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px] bg-surface text-accent-strong">
              <Icon name="ruler" />
            </span>
            <div className="space-y-1">
              <h2 className="text-base font-bold text-accent-deep">올린 다음에는</h2>
              <p className="text-sm text-[#1a2140]">
                방 화면에서 <strong>크기 보정</strong>을 하면 가구 배치, 문·창문, AI 추천을 쓸 수 있습니다.
              </p>
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
