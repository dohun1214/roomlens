'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ACCOUNT_DELETE_CONFIRM, canConfirmDelete } from '@/lib/auth/account';
import { createClient } from '@/lib/supabase/client';

/** 내 정보 맨 아래: 계정 삭제. 무엇이 지워지는지 알리고, 확인 글을 적어야 지운다 */
export default function DeleteAccount({ roomCount }: { roomCount: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    if (!canConfirmDelete(text) || busy) return;
    setBusy(true);
    setError(null);
    const res = await fetch('/api/account', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: text.trim() }) }).catch(() => null);
    if (!res?.ok) {
      const json = (await res?.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(json?.error?.message ?? '계정을 지우지 못했습니다. 잠시 후 다시 시도해 주세요.');
      setBusy(false);
      return;
    }
    // 계정은 지워졌으므로 브라우저에 남은 로그인 정보도 지우고 홈으로 (새로 읽어 로그아웃 상태로)
    await createClient().auth.signOut({ scope: 'local' }).catch(() => undefined);
    router.replace('/');
    router.refresh();
  };

  return (
    <section className="flex flex-col gap-4 rounded-3xl border border-danger-soft bg-surface p-6 sm:p-8" data-testid="account-delete">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-lg font-bold">계정 삭제</h2>
        <p className="text-sm text-sub">
          내 방 {roomCount}개와 올린 3D 파일·대표 사진, 저장한 배치, 내 가구, 남긴 코멘트가 모두 지워지고 되돌릴 수 없습니다. 다른 사람이 내 배치를 복사해 저장한 것은 그 사람의
          것으로 남습니다.
        </p>
      </div>
      {!open ? (
        <button type="button" className="btn btn-outline h-11 self-start px-5 text-sm text-danger hover:bg-danger-tint" onClick={() => setOpen(true)} data-testid="account-delete-open">
          계정 삭제…
        </button>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-sm">
            <span>
              정말 지우려면 <b className="text-danger">{ACCOUNT_DELETE_CONFIRM}</b>를 적어 주세요.
            </span>
            <input className="field h-11 rounded-[10px] px-3 text-sm" value={text} onChange={(e) => setText(e.target.value)} autoFocus data-testid="account-delete-input" />
          </label>
          {error && (
            <p className="rounded-[10px] bg-danger-soft px-3 py-2 text-sm text-danger" role="alert" data-testid="account-delete-error">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className="btn h-11 bg-danger px-5 text-sm text-white hover:bg-[#8f231b] disabled:opacity-50"
              disabled={!canConfirmDelete(text) || busy}
              onClick={() => void remove()}
              data-testid="account-delete-yes"
            >
              {busy ? '지우는 중…' : '계정과 모든 데이터 지우기'}
            </button>
            <button
              type="button"
              className="btn btn-outline h-11 px-5 text-sm"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setText('');
                setError(null);
              }}
            >
              취소
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
