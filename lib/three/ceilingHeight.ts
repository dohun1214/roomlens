// 보정된 방의 천장 높이(m)를 스플랫에서 잰다: 평면도 안에서 1.8 m 위에 있는 수평면 가운데 가장 넓은 높이.
// 벽 정면 그림(문·창문 찾기)의 위쪽 끝을 정할 때 쓴다. 브라우저 전용은 아니지만 SplatMesh가 필요하다.
import * as THREE from 'three';
import type { SplatMesh } from '@sparkjsdev/spark';
import { pointInPolygon, type Point2 } from './floorDrag';
import { sampleScenePoints } from './scenePoints';

const BIN = 0.02;

/** 높이들(m)과 수평면인지로 천장 높이를 고른다. 수평면이 없으면 높은 쪽 98% 값 */
export function ceilingFromHeights(heights: number[], horizontal: boolean[]): number | null {
  if (heights.length < 50) return null;
  const bins = new Map<number, number>();
  heights.forEach((h, i) => {
    if (!horizontal[i] || h < 1.8 || h > 6) return;
    const b = Math.round(h / BIN);
    bins.set(b, (bins.get(b) ?? 0) + 1);
  });
  let best: [number, number] | null = null;
  for (const [b, n] of bins) {
    const around = n + (bins.get(b - 1) ?? 0) + (bins.get(b + 1) ?? 0);
    if (!best || around > best[1]) best = [b, around];
  }
  if (best && best[1] >= 30) return Math.round(best[0] * BIN * 100) / 100;
  const sorted = [...heights].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length * 0.98)] * 100) / 100;
}

/** 보정된 방(방 좌표 = 월드 좌표, 바닥 y=0)의 천장 높이 */
export function measureCeiling(mesh: SplatMesh, polygon: Point2[]): number | null {
  const points = sampleScenePoints(mesh, 300_000);
  if (!points || polygon.length < 3) return null;
  mesh.updateMatrixWorld(true);
  const m = mesh.matrixWorld;
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(m);
  const xs = polygon.map((p) => p[0]);
  const zs = polygon.map((p) => p[1]);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const heights: number[] = [];
  const horizontal: boolean[] = [];
  for (let i = 0; i < points.count; i += 1) {
    p.fromArray(points.positions, i * 3).applyMatrix4(m);
    if (p.x < x0 || p.x > x1 || p.z < z0 || p.z > z1 || p.y < 0.5) continue;
    if (!pointInPolygon([p.x, p.z], polygon)) continue;
    n.fromArray(points.normals, i * 3);
    const hasNormal = n.lengthSq() > 0;
    if (hasNormal) n.applyMatrix3(normalMatrix).normalize();
    heights.push(p.y);
    horizontal.push(hasNormal && Math.abs(n.y) > 0.94);
  }
  return ceilingFromHeights(heights, horizontal);
}
