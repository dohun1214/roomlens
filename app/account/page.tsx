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
    <main className="mx-auto w-full max-w-md flex-1 space-y-6 px-6 py-10">
      <h1 className="text-2xl font-bold">내 정보</h1>
      <dl className="space-y-1 text-sm">
        <div className="flex gap-2">
          <dt className="w-24 text-neutral-500">이메일</dt>
          <dd data-testid="account-email">{user.email}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-24 text-neutral-500">만 18세 이상</dt>
          <dd data-testid="account-adult">{profile?.is_adult_confirmed ? '확인함' : '확인 안 됨'}</dd>
        </div>
      </dl>
      <NicknameForm userId={user.id} initial={profile?.nickname ?? ''} />
    </main>
  );
}
