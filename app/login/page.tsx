import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import AuthForm from '@/components/auth/AuthForm';
import { safeNextPath } from '@/lib/auth/paths';
import { getCurrentUser } from '@/lib/supabase/server';

export const metadata: Metadata = { title: '로그인 | RoomLens' };

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === 'string' ? params.next : null);
  if (await getCurrentUser()) redirect(next);

  return (
    <main className="mx-auto flex w-full flex-1 flex-col items-center justify-center gap-6 px-6 py-12">
      <h1 className="text-2xl font-bold">RoomLens</h1>
      <AuthForm next={next} />
    </main>
  );
}
