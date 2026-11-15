'use client';
import { useEffect } from 'react';
import type { UsageKind } from '@/lib/usage/events';
import { trackOnce } from '@/lib/usage/client';

/** 화면을 열었을 때 사용 기록을 한 번 남긴다 (아무것도 그리지 않는다) */
export default function TrackView({ kind, roomId }: { kind: UsageKind; roomId?: string }) {
  useEffect(() => {
    trackOnce(kind, roomId);
  }, [kind, roomId]);
  return null;
}
