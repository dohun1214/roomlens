import { describe, expect, it } from 'vitest';
import { emptyHistory, historyShortcut, record, redo, undo } from '@/lib/layout/history';

describe('되돌리기 기록', () => {
  it('바뀔 때마다 이전 상태를 쌓고, 되돌리고 다시 한다', () => {
    let h = emptyHistory<number>();
    let value = 0;
    for (const next of [1, 2, 3]) {
      h = record(h, value);
      value = next;
    }
    expect(h.past).toEqual([0, 1, 2]);
    const u1 = undo(h, value)!;
    expect(u1.value).toBe(2);
    const u2 = undo(u1.history, u1.value)!;
    expect(u2.value).toBe(1);
    expect(u2.history.future).toEqual([2, 3]);
    const r1 = redo(u2.history, u2.value)!;
    expect(r1.value).toBe(2);
    expect(r1.history).toEqual({ past: [0, 1], future: [3] });
  });

  it('되돌린 뒤 새로 바꾸면 다시 할 것은 사라진다', () => {
    let h = record(record(emptyHistory<string>(), 'a'), 'b');
    const u = undo(h, 'c')!;
    h = record(u.history, u.value);
    expect(h.future).toEqual([]);
    expect(redo(h, 'd')).toBeNull();
  });

  it('비어 있으면 null, 한도를 넘으면 오래된 것부터 버린다', () => {
    expect(undo(emptyHistory<number>(), 1)).toBeNull();
    expect(redo(emptyHistory<number>(), 1)).toBeNull();
    let h = emptyHistory<number>();
    for (let i = 0; i < 60; i += 1) h = record(h, i, 50);
    expect(h.past).toHaveLength(50);
    expect(h.past[0]).toBe(10);
  });
});

describe('단축키', () => {
  const key = (code: string, extra: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({ code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra });
  it('Ctrl/⌘+Z, Ctrl+Shift+Z, Ctrl+Y', () => {
    expect(historyShortcut(key('KeyZ', { ctrlKey: true }))).toBe('undo');
    expect(historyShortcut(key('KeyZ', { metaKey: true }))).toBe('undo');
    expect(historyShortcut(key('KeyZ', { ctrlKey: true, shiftKey: true }))).toBe('redo');
    expect(historyShortcut(key('KeyY', { ctrlKey: true }))).toBe('redo');
  });
  it('Ctrl 없이, Alt와 함께, 다른 키는 무시', () => {
    expect(historyShortcut(key('KeyZ'))).toBeNull();
    expect(historyShortcut(key('KeyZ', { ctrlKey: true, altKey: true }))).toBeNull();
    expect(historyShortcut(key('KeyX', { ctrlKey: true }))).toBeNull();
  });
});
