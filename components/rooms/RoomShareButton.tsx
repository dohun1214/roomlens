'use client';

import { useEffect, useState } from 'react';
import Icon from '@/components/ui/Icon';

/** 공개 방의 주소를 복사하는 버튼 (방 화면 머리말) */
export default function RoomShareButton({ roomId }: { roomId: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => setState('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/rooms/${roomId}`);
      setState('copied');
    } catch {
      setState('failed');
    }
  };

  return (
    <button
      type="button"
      className="btn btn-outline h-[38px] gap-1.5 px-3 text-[13px]"
      onClick={() => void copy()}
      aria-label="방 링크 복사"
      title="방 링크 복사"
      data-testid="room-share"
      data-state={state}
    >
      <Icon name={state === 'copied' ? 'check' : 'link'} size={14} />
      <span className="max-md:hidden">{state === 'copied' ? '복사했습니다' : state === 'failed' ? '복사 실패' : '링크 복사'}</span>
    </button>
  );
}
