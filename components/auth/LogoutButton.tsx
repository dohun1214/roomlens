'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export default function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const logout = async () => {
    setBusy(true);
    await createClient().auth.signOut();
    router.replace('/');
    router.refresh();
    setBusy(false);
  };

  return (
    <button className="flex h-10 items-center rounded-full px-3 text-sm text-sub hover:bg-surface hover:text-ink disabled:opacity-50" onClick={logout} disabled={busy}>
      로그아웃
    </button>
  );
}
