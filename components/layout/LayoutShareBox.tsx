'use client';

import { useState } from 'react';
import Icon from '@/components/ui/Icon';
import { sharedLayoutPath } from '@/lib/layout/share';

/** 링크를 복사한다. 클립보드를 못 쓰면 false */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 지금 보고 있는 내 배치를 링크로 공유하는 칸.
 * "링크로 공개"를 켜면 공개 방에서는 링크를 받은 누구나 이 배치를 볼 수 있다 (RLS: 공개 방의 공개 배치).
 */
export default function LayoutShareBox({
  roomId,
  layoutId,
  isPublic,
  roomPublic,
  dirty,
  onSetPublic,
}: {
  roomId: string;
  layoutId: string;
  isPublic: boolean;
  /** 방이 공개인지. 비공개 방의 배치는 링크를 받아도 볼 수 없다 */
  roomPublic: boolean;
  /** 저장하지 않은 변경이 있는지 (링크에는 저장한 배치가 보인다) */
  dirty: boolean;
  onSetPublic: (next: boolean) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null);
  const [url] = useState(() => (typeof window === 'undefined' ? '' : window.location.origin) + sharedLayoutPath(roomId, layoutId));

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const ok = await onSetPublic(!isPublic);
    setBusy(false);
    if (!ok) setMessage({ text: '바꾸지 못했습니다. 잠시 뒤에 다시 해 주세요.', tone: 'warn' });
  };

  const copy = async () => {
    const ok = await copyText(url);
    setMessage(ok ? { text: '링크를 복사했습니다.', tone: 'ok' } : { text: '복사하지 못했습니다. 주소를 직접 골라 복사해 주세요.', tone: 'warn' });
  };

  return (
    <div className="flex flex-col gap-2.5 rounded-xl bg-ground p-3 text-[13px]" data-testid="layout-share-box" data-public={isPublic}>
      <div className="flex items-center gap-3">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-semibold text-ink">링크로 공개</span>
          <span className="text-xs text-sub">{isPublic ? '링크를 받은 사람이 이 배치를 볼 수 있습니다.' : '켜면 링크를 받은 사람이 이 배치를 볼 수 있습니다.'}</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={isPublic}
          aria-label="링크로 공개"
          disabled={busy}
          onClick={() => void toggle()}
          className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-60 ${isPublic ? 'bg-accent' : 'bg-line-strong'}`}
          data-testid="layout-share-public"
        >
          <span className={`absolute top-1 left-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${isPublic ? 'translate-x-5' : ''}`} />
        </button>
      </div>
      {isPublic && (
        <div className="flex gap-2">
          <input
            className="field h-10 min-w-0 flex-1 rounded-[10px] px-3 font-mono text-xs text-body"
            readOnly
            value={url}
            aria-label="공유 링크"
            onFocus={(e) => e.currentTarget.select()}
            data-testid="layout-share-url"
          />
          <button type="button" className="btn btn-primary h-10 shrink-0 px-3.5 text-[13px]" onClick={() => void copy()} data-testid="layout-share-copy">
            <Icon name="link" size={14} />
            링크 복사
          </button>
        </div>
      )}
      {isPublic && !roomPublic && (
        <p className="rounded-[10px] bg-warn-tint px-3 py-2 text-warn" data-testid="layout-share-room-private">
          방이 비공개라 다른 사람은 아직 링크를 열 수 없습니다. 방 주인이 방을 공개하면 볼 수 있습니다.
        </p>
      )}
      {isPublic && dirty && <p className="text-xs text-sub" data-testid="layout-share-dirty">저장하지 않은 변경은 링크에 보이지 않습니다. 저장하면 링크에도 바로 반영됩니다.</p>}
      {message && (
        <p className={`text-xs ${message.tone === 'ok' ? 'text-ok' : 'text-warn'}`} role="status" data-testid="layout-share-message">
          {message.text}
        </p>
      )}
    </div>
  );
}
