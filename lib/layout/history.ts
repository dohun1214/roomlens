// 가구 배치의 되돌리기·다시하기 기록. 동작 하나(추가·옮기기·회전·삭제)가 한 칸이다.
// 상태(배치)는 바깥에 두고, 여기는 "바뀌기 전의 배치들"과 "되돌린 배치들"만 다룬다. DB·화면과 무관한 순수 함수.

/** 기억하는 단계 수 */
export const MAX_HISTORY = 50;

export type History<T> = {
  /** 되돌릴 수 있는 이전 상태들 (오래된 것부터) */
  past: T[];
  /** 다시 할 수 있는 상태들 (가까운 것부터) */
  future: T[];
};

export function emptyHistory<T>(): History<T> {
  return { past: [], future: [] };
}

/** 상태가 previous에서 바뀌었을 때: previous를 기록하고, 다시 할 것은 버린다 (가장 오래된 것부터 MAX_HISTORY만 남김) */
export function record<T>(history: History<T>, previous: T, limit = MAX_HISTORY): History<T> {
  const past = [...history.past, previous];
  return { past: past.length > limit ? past.slice(past.length - limit) : past, future: [] };
}

/** 되돌리기: 바로 전 상태와 새 기록. 되돌릴 것이 없으면 null */
export function undo<T>(history: History<T>, current: T): { value: T; history: History<T> } | null {
  if (history.past.length === 0) return null;
  const value = history.past[history.past.length - 1];
  return { value, history: { past: history.past.slice(0, -1), future: [current, ...history.future] } };
}

/** 다시하기: 되돌렸던 상태와 새 기록. 다시 할 것이 없으면 null */
export function redo<T>(history: History<T>, current: T): { value: T; history: History<T> } | null {
  if (history.future.length === 0) return null;
  const [value, ...future] = history.future;
  return { value, history: { past: [...history.past, current], future } };
}

/** 단축키: Ctrl/⌘+Z = 되돌리기, Ctrl/⌘+Shift+Z·Ctrl+Y = 다시하기. 한글 입력 상태에서도 되게 key가 아니라 code로 본다 */
export function historyShortcut(e: { code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): 'undo' | 'redo' | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.code === 'KeyZ') return e.shiftKey ? 'redo' : 'undo';
  if (e.code === 'KeyY' && !e.shiftKey) return 'redo';
  return null;
}
