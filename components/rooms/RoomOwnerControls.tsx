'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

type Pending = 'publish' | 'delete' | null;

const CONFIRM_TEXT: Record<Exclude<Pending, null>, string> = {
  publish: '공개하면 누구나 이 방을 3D로 볼 수 있습니다. 공개할까요?',
  delete: '방과 올린 파일이 모두 지워지고 되돌릴 수 없습니다. 지울까요?',
};

/** 방 주인에게만 보이는 버튼: 공개/비공개 전환, 삭제. 공개와 삭제는 한 번 더 확인한다. */
export default function RoomOwnerControls({
  roomId,
  initialPublic,
  canPublish,
}: {
  roomId: string;
  initialPublic: boolean;
  /** 파일을 다 올린 방만 공개할 수 있다 */
  canPublish: boolean;
}) {
  const router = useRouter();
  const [isPublic, setIsPublic] = useState(initialPublic);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setVisibility = async (next: boolean) => {
    setBusy(true);
    setError(null);
    // is_public 은 방 주인이 직접 바꿀 수 있는 컬럼이다 (RLS + 컬럼 권한)
    const { data, error: updateError } = await createClient()
      .from('rooms')
      .update({ is_public: next })
      .eq('id', roomId)
      .select('is_public')
      .maybeSingle();
    setBusy(false);
    setPending(null);
    if (updateError || !data) {
      setError('바꾸지 못했습니다. 잠시 후 다시 시도해 주세요.');
      return;
    }
    setIsPublic(data.is_public);
    router.refresh();
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/rooms/${roomId}`, { method: 'DELETE' }).catch(() => null);
    if (!res?.ok) {
      setBusy(false);
      setPending(null);
      setError('지우지 못했습니다. 잠시 후 다시 시도해 주세요.');
      return;
    }
    router.replace('/');
    router.refresh();
  };

  const buttonClass = 'rounded border border-neutral-300 px-3 py-1 disabled:opacity-50 dark:border-neutral-700';

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="room-owner-controls">
      {pending ? (
        <>
          <span data-testid="room-confirm-text">{CONFIRM_TEXT[pending]}</span>
          <button
            type="button"
            className={`${buttonClass} font-semibold`}
            disabled={busy}
            onClick={() => (pending === 'publish' ? setVisibility(true) : remove())}
            data-testid="room-confirm-yes"
          >
            {busy ? '처리 중…' : pending === 'publish' ? '공개' : '삭제'}
          </button>
          <button type="button" className={buttonClass} disabled={busy} onClick={() => setPending(null)} data-testid="room-confirm-no">
            취소
          </button>
        </>
      ) : (
        <>
          <span className="text-neutral-500" data-testid="room-visibility">
            {isPublic ? '공개' : '비공개'}
          </span>
          {canPublish && (
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => (isPublic ? setVisibility(false) : setPending('publish'))}
              data-testid="room-visibility-toggle"
            >
              {isPublic ? '비공개로 바꾸기' : '공개하기'}
            </button>
          )}
          <button type="button" className={buttonClass} disabled={busy} onClick={() => setPending('delete')} data-testid="room-delete">
            삭제
          </button>
        </>
      )}
      {error && (
        <span className="text-red-600" role="alert" data-testid="room-control-error">
          {error}
        </span>
      )}
    </div>
  );
}
