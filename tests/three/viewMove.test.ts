import { describe, expect, it } from 'vitest';
import { LOOK_DISTANCE, lookTarget, panDelta, pinchDistance, wheelDistance } from '@/lib/three/viewMove';
import { WALK_SPEED } from '@/lib/three/keyboardMove';

describe('lookTarget', () => {
  it('멀리 있는 바라보는 점을 같은 방향 바로 앞으로 당긴다', () => {
    const t = lookTarget([0, 1.5, 0], [0, 1.5, -4]);
    expect(t?.[0]).toBeCloseTo(0, 9);
    expect(t?.[1]).toBeCloseTo(1.5, 9);
    expect(t?.[2]).toBeCloseTo(-LOOK_DISTANCE, 9);
  });

  it('비스듬한 방향도 그대로', () => {
    const t = lookTarget([1, 2, 3], [4, -2, 3]); // (3, -4, 0) 방향
    expect(t?.[0]).toBeCloseTo(1 + 0.6 * LOOK_DISTANCE, 9);
    expect(t?.[1]).toBeCloseTo(2 - 0.8 * LOOK_DISTANCE, 9);
  });

  it('이미 그 거리이거나 방향을 모르면 null', () => {
    expect(lookTarget([0, 0, 0], [0, 0, -LOOK_DISTANCE])).toBeNull();
    expect(lookTarget([1, 1, 1], [1, 1, 1])).toBeNull();
  });
});

describe('wheelDistance', () => {
  it('휠을 위로(deltaY < 0) 굴리면 다가가고, 아래로 굴리면 물러난다', () => {
    expect(wheelDistance(-100, 0, WALK_SPEED)).toBeCloseTo(0.3, 9);
    expect(wheelDistance(100, 0, WALK_SPEED)).toBeCloseTo(-0.3, 9);
  });

  it('줄 단위 휠은 픽셀로 바꾼다', () => {
    expect(wheelDistance(3, 1, WALK_SPEED)).toBeCloseTo(wheelDistance(48, 0, WALK_SPEED), 9);
  });

  it('한 번에 너무 멀리 가지 않는다', () => {
    expect(wheelDistance(-5000, 0, WALK_SPEED)).toBeCloseTo(WALK_SPEED * 0.6, 9);
  });

  it('빠르기가 다르면 같은 비율로 (보정 전 장면)', () => {
    expect(wheelDistance(-100, 0, WALK_SPEED * 2)).toBeCloseTo(0.6, 9);
    expect(wheelDistance(-100, 0, 0)).toBe(0);
  });
});

describe('panDelta', () => {
  it('오른쪽으로 끌면 화면이 따라오도록 카메라는 왼쪽으로', () => {
    const d = panDelta(100, 0, [1, 0, 0], WALK_SPEED);
    expect(d[0]).toBeLessThan(0);
    expect(d[1]).toBe(0);
  });

  it('아래로 끌면 카메라는 위로', () => {
    expect(panDelta(0, 100, [1, 0, 0], WALK_SPEED)[1]).toBeGreaterThan(0);
  });

  it('보정된 방에서 300px 끌면 1~2 m', () => {
    const d = panDelta(300, 0, [0, 0, 1], WALK_SPEED);
    expect(Math.abs(d[2])).toBeGreaterThan(1);
    expect(Math.abs(d[2])).toBeLessThan(2);
  });
});

describe('pinchDistance', () => {
  it('벌리면 앞으로, 오므리면 뒤로', () => {
    expect(pinchDistance(100, 150, WALK_SPEED)).toBeGreaterThan(0);
    expect(pinchDistance(150, 100, WALK_SPEED)).toBeLessThan(0);
    expect(pinchDistance(0, 100, WALK_SPEED)).toBe(0);
  });
});
