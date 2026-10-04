import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import RoomUploadForm from '@/components/rooms/RoomUploadForm';
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
    <main className="mx-auto w-full max-w-xl flex-1 space-y-8 px-6 py-10">
      <h1 className="text-2xl font-bold">방 만들기</h1>

      <section className="space-y-2 text-sm" data-testid="capture-guide">
        <h2 className="font-semibold">1. 방 3D 파일 준비하기</h2>
        <p className="text-neutral-600 dark:text-neutral-300">
          무료 앱 <strong>Scaniverse</strong>에서 스플랫(Splat) 방식으로 방을 찍습니다. 일반 동영상은 쓸 수 없고, 앱 안에서
          찍어야 합니다.
        </p>
        <ol className="list-decimal space-y-1 pl-5 text-neutral-600 dark:text-neutral-300">
          {GUIDE.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
        <p className="text-neutral-600 dark:text-neutral-300">
          다 찍으면 앱에서 <strong>SPZ</strong> 또는 <strong>PLY</strong> 파일로 내보냅니다. SPZ가 열리지 않는다는 안내가 나오면
          PLY로 내보내 주세요.
        </p>
        <p className="text-neutral-600 dark:text-neutral-300" data-testid="dataset-guide">
          직접 찍지 않아도 됩니다. 공개 데이터셋의 방 3D 파일(.ply, .spz, .sog)을 올려도 같은 기능을 쓸 수 있습니다. 이때는 아래에서
          &ldquo;공개 데이터셋&rdquo;을 고르고 출처와 라이선스를 적어 주세요.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">2. 파일 올리기</h2>
        <RoomUploadForm />
      </section>
    </main>
  );
}
