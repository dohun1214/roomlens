import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { sampleScenePoints } from '@/lib/three/scenePoints';

/** 바닥 위에 납작한 스플랫을 깐 가짜 장면. opacityOf(i)로 불투명도를 정한다 */
function fakeMesh(n: number, opacityOf: (i: number) => number) {
  const center = new THREE.Vector3();
  const scales = new THREE.Vector3(0.01, 0.0005, 0.01);
  const quaternion = new THREE.Quaternion();
  const color = { r: 0.5, g: 0.5, b: 0.5 };
  const side = Math.ceil(Math.sqrt(n));
  return {
    packedSplats: {
      numSplats: n,
      forEachSplat(cb: (...a: unknown[]) => void) {
        for (let i = 0; i < n; i += 1) {
          center.set((i % side) * 0.05, 0, Math.floor(i / side) * 0.05);
          cb(i, center, scales, quaternion, opacityOf(i), color);
        }
      },
    },
  } as never;
}

describe('sampleScenePoints', () => {
  it('보통 장면: 흐린 스플랫(0.25 미만)은 버린다', () => {
    const pts = sampleScenePoints(fakeMesh(10_000, (i) => (i % 5 === 0 ? 0.1 : 0.8)))!;
    expect(pts.count).toBe(8000);
  });

  it('흐린 스플랫이 대부분인 장면: 더 불투명한 30%는 남긴다', () => {
    // 90%가 0.05~0.2 (학습기가 반투명 스플랫을 겹쳐 표면을 만든 장면)
    const pts = sampleScenePoints(fakeMesh(10_000, (i) => (i % 10 === 0 ? 0.8 : 0.05 + ((i * 7) % 16) / 100)))!;
    expect(pts.count).toBeGreaterThan(2900);
    expect(pts.count).toBeLessThan(10_000);
  });
});
