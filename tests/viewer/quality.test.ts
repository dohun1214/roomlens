import { describe, expect, it } from 'vitest';
import { DESKTOP_QUALITY, MOBILE_QUALITY, resolveViewerQuality } from '@/lib/viewer/quality';

const q = (isMobile: boolean, query = '') => resolveViewerQuality(isMobile, new URLSearchParams(query));

describe('resolveViewerQuality', () => {
  it('데스크톱 기본값: 그리는 수는 Spark에 맡기고 배율 1.5까지', () => {
    expect(q(false)).toEqual(DESKTOP_QUALITY);
    expect(q(false).lodSplatCount).toBeUndefined();
  });

  it('폰 기본값: 그리는 수와 배율을 낮춘다', () => {
    expect(q(true)).toEqual(MOBILE_QUALITY);
    expect(q(true).lodSplatCount).toBeLessThanOrEqual(1_000_000);
    expect(q(true).pixelRatioCap).toBeLessThan(DESKTOP_QUALITY.pixelRatioCap);
  });

  it('주소의 값이 기본값보다 우선한다', () => {
    expect(q(true, 'lod=500000&pr=1&lrs=2')).toMatchObject({ lodSplatCount: 500_000, pixelRatioCap: 1, lodRenderScale: 2 });
    expect(q(false, 'lod=1200000')).toEqual({ ...DESKTOP_QUALITY, lodSplatCount: 1_200_000 });
  });

  it('일부만 주면 나머지는 기본값', () => {
    expect(q(true, 'pr=1.5')).toEqual({ ...MOBILE_QUALITY, pixelRatioCap: 1.5 });
  });

  it('범위를 벗어난 값은 범위 안으로 맞춘다', () => {
    expect(q(false, 'lod=1').lodSplatCount).toBe(100_000);
    expect(q(false, 'lod=99999999').lodSplatCount).toBe(5_000_000);
    expect(q(false, 'pr=10').pixelRatioCap).toBe(3);
    expect(q(false, 'lrs=0').lodRenderScale).toBe(1);
  });

  it('정렬 간격과 시야 집중도 주소 값으로 바꾼다', () => {
    expect(q(true, 'sort=200&fov=off')).toEqual({ ...MOBILE_QUALITY, minSortIntervalMs: 200, foveation: false });
    expect(q(true, 'fov=on').foveation).toBe(true);
    expect(q(true, 'fov=maybe').foveation).toBe(MOBILE_QUALITY.foveation);
    expect(q(false, 'sort=-5').minSortIntervalMs).toBe(0);
    expect(q(false, 'sort=99999').minSortIntervalMs).toBe(1000);
  });

  it('숫자가 아니거나 빈 값은 무시한다', () => {
    expect(q(true, 'lod=abc&pr=&lrs=NaN')).toEqual(MOBILE_QUALITY);
  });

  it('다른 주소 값(url 등)이 섞여 있어도 된다', () => {
    expect(q(false, 'url=https%3A%2F%2Fexample.com%2Fa.sog&lod=300000').lodSplatCount).toBe(300_000);
  });
});
