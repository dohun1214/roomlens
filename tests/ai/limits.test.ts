import { describe, expect, it } from 'vitest';
import { BUNDLE_WINDOW_MS, canBundle, type BundleParent } from '@/lib/ai/limits';

const now = new Date('2026-10-17T03:00:00Z');
const parent = (extra: Partial<BundleParent> = {}): BundleParent => ({
  owner_id: 'u1',
  room_id: 'r1',
  kind: 'openings',
  status: 'done',
  created_at: new Date(now.getTime() - 60_000).toISOString(),
  bundle_of: null,
  ...extra,
});

describe('canBundle', () => {
  it('같은 사람·같은 방의 끝난 문·창문 찾기에 이어 붙인다', () => {
    expect(canBundle(parent(), 'u1', 'r1', now)).toBe(true);
  });

  it('다른 사람, 다른 방, 다른 종류, 끝나지 않았거나 실패한 호출에는 붙이지 않는다', () => {
    expect(canBundle(null, 'u1', 'r1', now)).toBe(false);
    expect(canBundle(parent(), 'u2', 'r1', now)).toBe(false);
    expect(canBundle(parent(), 'u1', 'r2', now)).toBe(false);
    expect(canBundle(parent({ kind: 'layout' }), 'u1', 'r1', now)).toBe(false);
    expect(canBundle(parent({ status: 'running' }), 'u1', 'r1', now)).toBe(false);
    expect(canBundle(parent({ status: 'failed' }), 'u1', 'r1', now)).toBe(false);
  });

  it('이미 다른 호출에 붙은 호출이나 오래된 호출에는 붙이지 않는다', () => {
    expect(canBundle(parent({ bundle_of: 'x' }), 'u1', 'r1', now)).toBe(false);
    expect(canBundle(parent({ created_at: new Date(now.getTime() - BUNDLE_WINDOW_MS - 1000).toISOString() }), 'u1', 'r1', now)).toBe(false);
    expect(canBundle(parent({ created_at: new Date(now.getTime() + 60_000).toISOString() }), 'u1', 'r1', now)).toBe(false);
  });
});
