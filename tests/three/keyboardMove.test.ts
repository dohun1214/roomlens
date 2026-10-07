import { describe, expect, it } from 'vitest';
import { FAST_FACTOR, MAX_STEP_SECONDS, groundBasis, isFast, isMoveKey, isTypingTarget, moveAxes, moveStep, type Vec3 } from '@/lib/three/keyboardMove';

const close = (got: Vec3 | null, want: Vec3) => {
  expect(got).not.toBeNull();
  got?.forEach((v, i) => expect(v).toBeCloseTo(want[i], 9));
};
const UP: Vec3 = [0, 1, 0];

describe('moveAxes', () => {
  it('W A S D와 방향키, Q E', () => {
    expect(moveAxes(['KeyW'])).toEqual([0, 0, 1]);
    expect(moveAxes(['ArrowDown'])).toEqual([0, 0, -1]);
    expect(moveAxes(['KeyD'])).toEqual([1, 0, 0]);
    expect(moveAxes(['ArrowLeft'])).toEqual([-1, 0, 0]);
    expect(moveAxes(['KeyE'])).toEqual([0, 1, 0]);
    expect(moveAxes(['KeyQ'])).toEqual([0, -1, 0]);
  });

  it('반대 키를 같이 누르면 멈추고, 같은 방향 키 둘은 하나와 같다', () => {
    expect(moveAxes(['KeyW', 'KeyS'])).toEqual([0, 0, 0]);
    expect(moveAxes(['KeyW', 'ArrowUp'])).toEqual([0, 0, 1]);
  });

  it('대각선도 같은 빠르기', () => {
    const [r, u, f] = moveAxes(['KeyW', 'KeyD']);
    expect(Math.hypot(r, u, f)).toBeCloseTo(1, 9);
    expect(r).toBeCloseTo(f, 9);
  });

  it('상관없는 키는 무시', () => {
    expect(moveAxes(['KeyX', 'Space', 'ShiftLeft'])).toEqual([0, 0, 0]);
    expect(isMoveKey('KeyW')).toBe(true);
    expect(isMoveKey('KeyX')).toBe(false);
    expect(isFast(['KeyW', 'ShiftRight'])).toBe(true);
    expect(isFast(['KeyW'])).toBe(false);
  });
});

describe('groundBasis', () => {
  it('비스듬히 내려다봐도 앞은 바닥과 나란하다', () => {
    const { forward, right } = groundBasis([0, -0.6, -0.8], UP);
    close(forward, [0, 0, -1]);
    close(right, [1, 0, 0]);
  });

  it('+x를 보면 오른쪽은 +z', () => {
    const { forward, right } = groundBasis([1, 0, 0], UP);
    close(forward, [1, 0, 0]);
    close(right, [0, 0, 1]);
  });

  it('똑바로 내려다보면 화면의 위쪽이 앞', () => {
    // 위에서 내려다보며 화면 위쪽이 -z인 카메라
    const { forward, right } = groundBasis([0, -1, 0], [0, 0, -1]);
    close(forward, [0, 0, -1]);
    close(right, [1, 0, 0]);
  });
});

describe('moveStep', () => {
  const view: Vec3 = [0, -0.6, -0.8];

  it('W: 보는 쪽으로 가되 높이는 그대로', () => {
    close(moveStep(['KeyW'], view, UP, 0.05, 2), [0, 0, -0.1]);
  });

  it('D: 오른쪽, E: 위', () => {
    close(moveStep(['KeyD'], view, UP, 0.05, 2), [0.1, 0, 0]);
    close(moveStep(['KeyE'], view, UP, 0.05, 2), [0, 0.1, 0]);
  });

  it('Shift를 같이 누르면 빠르게', () => {
    close(moveStep(['KeyW', 'ShiftLeft'], view, UP, 0.05, 2), [0, 0, -0.1 * FAST_FACTOR]);
  });

  it('누른 키가 없거나 반대 키면 null', () => {
    expect(moveStep([], view, UP, 0.05, 2)).toBeNull();
    expect(moveStep(['ShiftLeft'], view, UP, 0.05, 2)).toBeNull();
    expect(moveStep(['KeyA', 'KeyD'], view, UP, 0.05, 2)).toBeNull();
  });

  it('화면이 오래 멈췄다 돌아와도 한 번에 멀리 가지 않는다', () => {
    close(moveStep(['KeyW'], view, UP, 5, 2), [0, 0, -2 * MAX_STEP_SECONDS]);
  });

  it('시간이나 속도가 0이면 움직이지 않는다', () => {
    expect(moveStep(['KeyW'], view, UP, 0, 2)).toBeNull();
    expect(moveStep(['KeyW'], view, UP, 0.05, 0)).toBeNull();
  });
});

describe('isTypingTarget', () => {
  it('글자를 넣는 곳에서는 true', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'textarea' })).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('버튼·화면에서는 false', () => {
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget({ tagName: 'CANVAS' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
