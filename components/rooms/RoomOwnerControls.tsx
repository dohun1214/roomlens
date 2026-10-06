'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Icon from '@/components/ui/Icon';
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

  return (
    <div className="flex items-center gap-2 text-[13px]" data-testid="room-owner-controls">
      <span className="pill bg-chip py-1 text-sub" data-testid="room-visibility">
        <Icon name={isPublic ? 'globe' : 'lock'} size={12} />
        {isPublic ? '공개' : '비공개'}
      </span>
      {canPublish && (
        <button
          type="button"
          className="btn btn-outline h-[38px] px-3 sm:px-4"
          disabled={busy || pending !== null}
          onClick={() => (isPublic ? setVisibility(false) : setPending('publish'))}
          data-testid="room-visibility-toggle"
        >
          {isPublic ? '비공개로 바꾸기' : '공개하기'}
        </button>
      )}
      <button type="button" className="btn btn-soft h-[38px] px-3 text-sub hover:text-danger" disabled={busy || pending !== null} onClick={() => setPending('delete')} data-testid="room-delete">
        삭제
      </button>

      {/* 공개와 삭제는 한 번 더 묻는다 */}
      {pending && (
        <div className="absolute top-full right-3 mt-2 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-3 rounded-2xl bg-surface p-4 shadow-float" role="alertdialog" aria-label="확인">
          <p className="text-sm text-ink-2" data-testid="room-confirm-text">
            {CONFIRM_TEXT[pending]}
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-outline h-10 px-4" disabled={busy} onClick={() => setPending(null)} data-testid="room-confirm-no">
              취소
            </button>
            <button
              type="button"
              className={`btn h-10 px-4 ${pending === 'delete' ? 'bg-danger text-white hover:bg-[#8f231b]' : 'btn-primary'}`}
              disabled={busy}
              onClick={() => (pending === 'publish' ? setVisibility(true) : remove())}
              data-testid="room-confirm-yes"
            >
              {busy ? '처리 중…' : pending === 'publish' ? '공개' : '삭제'}
            </button>
          </div>
        </div>
      )}
      {error && (
        <span className="absolute top-full right-3 mt-2 rounded-xl bg-danger-soft px-3 py-2 text-danger shadow-float" role="alert" data-testid="room-control-error">
          {error}
        </span>
      )}
    </div>
  );
}
