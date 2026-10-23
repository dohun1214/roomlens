import { describe, expect, it } from 'vitest';
import { angleDelta, normalizeRotation, parseRotationInput, rotationTowards, snapRotation } from '@/lib/layout/rotation';

describe('회전 각도', () => {
  it('0~359 정수로', () => {
    expect(normalizeRotation(361.4)).toBe(1);
    expect(normalizeRotation(-15)).toBe(345);
    expect(normalizeRotation(Number.NaN)).toBe(0);
  });
  it('90°의 배수 가까이(4° 이내)는 붙고, 나머지는 1° 단위', () => {
    expect(snapRotation(93)).toBe(90);
    expect(snapRotation(-3.5)).toBe(0);
    expect(snapRotation(95)).toBe(95);
    expect(snapRotation(37.6)).toBe(38);
    expect(snapRotation(268)).toBe(270);
  });
  it('단위를 주면 그 단위로 (Shift: 15°)', () => {
    expect(snapRotation(37.6, 15)).toBe(45);
    expect(snapRotation(-8, 15)).toBe(345);
  });
  it('끈 방향을 가구의 뒤쪽이 바라보게', () => {
    // 회전 0°의 뒤쪽은 -z (평면도 위쪽)
    expect(snapRotation(rotationTowards(0, -1))).toBe(0);
    // 회전 90°의 뒤쪽은 [-1, 0] (왼쪽)
    expect(snapRotation(rotationTowards(-1, 0))).toBe(90);
    expect(snapRotation(rotationTowards(0, 1))).toBe(180);
    expect(snapRotation(rotationTowards(1, 0))).toBe(270);
  });
  it('각도 차이는 -180~180', () => {
    expect(angleDelta(10, 350)).toBe(20);
    expect(angleDelta(350, 10)).toBe(-20);
    expect(angleDelta(90, 90)).toBe(0);
  });
  it('입력 칸', () => {
    expect(parseRotationInput('45')).toBe(45);
    expect(parseRotationInput(' 400° ')).toBe(40);
    expect(parseRotationInput('-30')).toBe(330);
    expect(parseRotationInput('')).toBeNull();
    expect(parseRotationInput('abc')).toBeNull();
  });
});
