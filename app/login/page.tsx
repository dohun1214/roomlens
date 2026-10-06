import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import AuthForm from '@/components/auth/AuthForm';
import Logo from '@/components/ui/Logo';
import { safeNextPath } from '@/lib/auth/paths';
import { getCurrentUser } from '@/lib/supabase/server';
import heroImage from '@/public/samples/studio11-living.jpg';

export const metadata: Metadata = { title: '로그인 | RoomLens' };

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === 'string' ? params.next : null);
  if (await getCurrentUser()) redirect(next);

  return (
    <main className="flex w-full flex-1 flex-col gap-4 p-4 lg:flex-row">
      <div className="relative flex min-h-[220px] flex-col justify-between gap-6 overflow-hidden rounded-[28px] bg-soft p-5 sm:p-7 lg:flex-1">
        <Image src={heroImage} alt="" fill priority sizes="(min-width: 1024px) 50vw, 100vw" className="object-cover" />
        <Link href="/" className="relative self-start rounded-2xl bg-surface py-2 pr-4 pl-2 shadow-float" aria-label="RoomLens 홈">
          <Logo className="text-lg" />
        </Link>
        <div className="relative hidden max-w-[24em] flex-col gap-2 rounded-[20px] bg-surface p-[22px] shadow-float sm:flex">
          <p className="text-[22px] leading-[1.35] font-bold tracking-tight text-balance">
            찍은 방을 3D로 둘러보고, <span className="text-accent">실제 치수</span>의 가구를 놓아 봅니다
          </p>
          <p className="text-xs text-mute">Studio 11 by milanoski (SuperSplat), CC BY 4.0</p>
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center rounded-[28px] bg-surface px-5 py-10 sm:px-6">
        <div className="flex w-full max-w-[400px] flex-col gap-6">
          <div className="space-y-1.5">
            <h1 className="text-[30px] font-bold tracking-[-0.02em]">시작하기</h1>
            <p className="text-sub">이메일과 비밀번호만 있으면 됩니다.</p>
          </div>
          <AuthForm next={next} />
        </div>
      </div>
    </main>
  );
}
