// 브라우저에서 사용 기록 보내기. 실패해도 조용히 넘어간다.
// 주소에 ?nolog=1 을 붙여 한 번 열면 그 브라우저는 기록하지 않는다 (개발자 본인의 방문을 빼려고)
import type { UsageKind } from './events';

const VISITOR_KEY = 'roomlens-visitor';
const NOLOG_KEY = 'roomlens-nolog';
/** 한 번 연 화면에서 이미 보낸 기록 (같은 화면의 가구 놓기는 한 번만 센다) */
const sent = new Set<string>();

function visitorId(): string | null {
  try {
    if (new URLSearchParams(window.location.search).get('nolog') === '1') localStorage.setItem(NOLOG_KEY, '1');
    if (localStorage.getItem(NOLOG_KEY) === '1') return null;
    let id = localStorage.getItem(VISITOR_KEY);
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      id = crypto.randomUUID().replace(/-/g, '');
      localStorage.setItem(VISITOR_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

/** 주소가 /rooms/<id> 이면 그 방 id */
export function roomIdFromPath(path: string): string | undefined {
  const m = path.match(/^\/rooms\/([0-9a-f-]{36})(?:\/|$)/i);
  return m ? m[1] : undefined;
}

/** 이 화면에서 처음일 때만 보낸다 */
export function trackOnce(kind: UsageKind, roomId?: string): void {
  if (typeof window === 'undefined') return;
  const key = `${kind}:${roomId ?? ''}:${window.location.pathname}`;
  if (sent.has(key)) return;
  sent.add(key);
  const visitor = visitorId();
  if (!visitor) return;
  const body = JSON.stringify({ kind, roomId, visitor });
  try {
    void fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  } catch {
    // 기록은 화면 동작에 영향을 주지 않는다
  }
}
