import Link from 'next/link';

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-3xl font-bold">RoomLens</h1>
      <p className="text-neutral-600 dark:text-neutral-300">
        휴대폰으로 찍은 방을 3D로 둘러보고, 실제 치수의 가구를 배치해 보는 서비스입니다.
        지금은 개발 중입니다.
      </p>
      <div className="flex gap-3">
        <Link href="/rooms/new" className="w-fit rounded bg-neutral-900 px-4 py-2 text-white dark:bg-white dark:text-neutral-900">
          방 만들기
        </Link>
        <Link href="/viewer" className="w-fit rounded border border-neutral-300 px-4 py-2 dark:border-neutral-700">
          3D 뷰어 테스트
        </Link>
      </div>
    </main>
  );
}
