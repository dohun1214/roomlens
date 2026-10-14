import { describe, expect, it } from 'vitest';
import { SHADOW_SPREAD, makeShadowTexture, shadowAlpha, shadowSize } from '@/lib/three/softShadow';

describe('shadowAlpha', () => {
  it('가운데는 진하고 가장자리는 비어 있다', () => {
    expect(shadowAlpha(0.5, 0.5)).toBe(1);
    expect(shadowAlpha(0, 0.5)).toBe(0);
    expect(shadowAlpha(0.5, 1)).toBe(0);
    expect(shadowAlpha(0, 0)).toBe(0);
  });

  it('가운데에서 멀어질수록 옅어진다 (갑자기 끊기지 않는다)', () => {
    const line = [0.5, 0.4, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05].map((u) => shadowAlpha(u, 0.5));
    for (let i = 1; i < line.length; i += 1) expect(line[i]).toBeLessThanOrEqual(line[i - 1]);
    expect(line.some((a) => a > 0.05 && a < 0.95)).toBe(true);
  });

  it('모서리는 변의 가운데보다 옅다 (둥글게 흐려짐)', () => {
    expect(shadowAlpha(0.2, 0.2)).toBeLessThan(shadowAlpha(0.2, 0.5));
  });

  it('상하좌우 대칭', () => {
    expect(shadowAlpha(0.2, 0.3)).toBeCloseTo(shadowAlpha(0.8, 0.7), 9);
    expect(shadowAlpha(0.2, 0.3)).toBeCloseTo(shadowAlpha(0.3, 0.2), 9);
  });
});

describe('그림자 판', () => {
  it('가구 바닥보다 사방으로 조금 크다', () => {
    expect(shadowSize(1, 2)).toEqual([1 + SHADOW_SPREAD * 2, 2 + SHADOW_SPREAD * 2]);
  });

  it('텍스처는 검은색에 알파만 있다', () => {
    const texture = makeShadowTexture();
    const data = texture.image.data as Uint8Array;
    const size = texture.image.width;
    const center = ((size / 2) * size + size / 2) * 4;
    expect(data[center + 3]).toBe(255);
    expect(data[3]).toBe(0);
    expect(data[center]).toBe(0);
  });
});
