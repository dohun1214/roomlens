import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import NicknameForm from '@/components/auth/NicknameForm';
import { loginUrlFor } from '@/lib/auth/paths';
import { createClient, getCurrentUser } from '@/lib/supabase/server';

export const metadata: Metadata = { title: '내 정보 | RoomLens' };

export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlFor('/account')); // proxy.ts 가 먼저 막지만 한 번 더 확인

  const supabase = await createClient();
  const { data: profile } = await supabase
    .from('profiles')
    .select('nickname, is_adult_confirmed, created_at')
    .eq('id', user.id)
    .maybeSingle();

  return (
    <main className="mx-auto flex w-full max-w-[560px] flex-1 flex-col gap-6 px-4 pt-6 pb-16 sm:px-6">
      <h1 className="text-[34px] font-bold tracking-[-0.02em]">내 정보</h1>
      <section className="flex flex-col gap-6 rounded-3xl bg-surface p-6 shadow-card sm:p-8">
        <dl className="flex flex-col gap-3 text-[15px]">
          <div className="flex flex-wrap gap-x-3">
            <dt className="w-28 font-semibold text-body">이메일</dt>
            <dd className="break-all" data-testid="account-email">
              {user.email}
            </dd>
          </div>
          <div className="flex flex-wrap gap-x-3">
            <dt className="w-28 font-semibold text-body">만 18세 이상</dt>
            <dd data-testid="account-adult">{profile?.is_adult_confirmed ? '확인함' : '확인 안 됨'}</dd>
          </div>
        </dl>
        <div className="border-t border-line pt-6">
          <NicknameForm userId={user.id} initial={profile?.nickname ?? ''} />
        </div>
      </section>
    </main>
  );
}
