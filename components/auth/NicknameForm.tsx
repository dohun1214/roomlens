'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { NICKNAME_MAX_LENGTH, validateNickname } from '@/lib/auth/messages';
import { createClient } from '@/lib/supabase/client';

export default function NicknameForm({ userId, initial }: { userId: string; initial: string }) {
  const router = useRouter();
  const [nickname, setNickname] = useState(initial);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const problem = validateNickname(nickname);
    if (problem) {
      setMessage({ ok: false, text: problem });
      return;
    }
    setBusy(true);
    const { error } = await createClient().from('profiles').update({ nickname: nickname.trim() }).eq('id', userId);
    setBusy(false);
    if (error) {
      setMessage({ ok: false, text: '저장하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
      return;
    }
    setMessage({ ok: true, text: '저장했습니다.' });
    router.refresh(); // 상단 메뉴의 닉네임 갱신
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
      <label className="flex flex-col gap-2 text-sm font-bold">
        <span>닉네임</span>
        <input className="field h-[50px] text-[15px] font-normal" name="nickname" value={nickname} maxLength={NICKNAME_MAX_LENGTH} onChange={(e) => setNickname(e.target.value)} />
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy || nickname.trim() === initial} className="btn btn-primary h-11 px-5 text-sm">
          저장
        </button>
        {message && (
          <span className={`text-sm ${message.ok ? 'text-ok' : 'text-danger'}`} role="status">
            {message.text}
          </span>
        )}
      </div>
    </form>
  );
}
