// 스플랫 장면에서 "표면 점"을 고르게 뽑는다: 위치, 표면 방향(법선), 무게. 자동 보정(lib/rooms/autoLayout.ts)의 입력이다.
// 화면에 무엇이 그려지고 있는지와 상관없이 파일 전체(LOD 트리)를 훑는다. 좌표는 스플랫 원본(파일) 좌표다.
// 브라우저 전용은 아니지만 Spark의 SplatMesh가 필요하다.
import * as THREE from 'three';
import type { PackedSplats, SplatMesh } from '@sparkjsdev/spark';

export type ScenePoints = {
  count: number;
  /** x, y, z × count */
  positions: Float32Array;
  /** 표면 방향(단위 벡터) × count. 납작하지 않은 스플랫은 0 벡터 */
  normals: Float32Array;
  /** 불투명도 × 크기를 반영한 무게 */
  weights: Float32Array;
  /** 밝기 (0~1). 천장은 보통 밝고 바닥은 어둡다 (위아래를 정할 때 참고) */
  brightness?: Float32Array;
};

/** 이보다 흐린 스플랫은 버린다 */
const MIN_OPACITY = 0.25;
/** 가장 얇은 축이 두 번째 축의 이 비율보다 얇으면 "납작하다"(표면 방향이 있다)고 본다 */
const FLAT_RATIO = 0.35;

/**
 * 장면에서 표면 점을 최대 maxPoints개 뽑는다.
 * LOD 트리에는 같은 표면을 여러 단계로 뭉친 큰 스플랫도 들어 있으므로, 장면 크기에 견줘 큰 것은 뺀다.
 */
export function sampleScenePoints(mesh: SplatMesh, maxPoints = 600_000): ScenePoints | null {
  const packed: PackedSplats | undefined = mesh.packedSplats;
  const source = packed?.numSplats ? packed : packed?.lodSplats;
  if (!source?.numSplats) return null;
  const total = source.numSplats;

  // 1) 장면 크기 (2~98% 범위)
  const probe = Math.max(1, Math.floor(total / 100_000));
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  source.forEachSplat((i, center) => {
    if (i % probe !== 0) return;
    xs.push(center.x);
    ys.push(center.y);
    zs.push(center.z);
  });
  const span = (arr: number[]) => {
    arr.sort((a, b) => a - b);
    return arr[Math.floor(arr.length * 0.98)] - arr[Math.floor(arr.length * 0.02)];
  };
  const size = Math.max(span(xs), span(ys), span(zs));
  if (!(size > 0)) return null;
  // 장면의 한 변이 10 m라면 6 cm 넘는 스플랫은 뭉친 것으로 본다
  const maxScale = size * 0.006;

  // 2) 고르게 건너뛰며 뽑는다. 파일 순서는 공간적으로 몰려 있으므로 끝까지 훑은 뒤에 다시 고르게 줄인다
  const room = maxPoints * 3;
  const stride = Math.max(1, Math.floor(total / room));
  const positions = new Float32Array(room * 3);
  const normals = new Float32Array(room * 3);
  const weights = new Float32Array(room);
  const brightness = new Float32Array(room);
  const axis = new THREE.Vector3();
  let count = 0;
  source.forEachSplat((i, center, scales, quaternion, opacity, color) => {
    if (count >= room || i % stride !== 0 || opacity < MIN_OPACITY) return;
    const s = [scales.x, scales.y, scales.z];
    const big = Math.max(...s);
    if (!(big > 0) || big > maxScale) return;
    const order = [0, 1, 2].sort((a, b) => s[a] - s[b]);
    const k = count * 3;
    positions[k] = center.x;
    positions[k + 1] = center.y;
    positions[k + 2] = center.z;
    if (s[order[0]] < s[order[1]] * FLAT_RATIO) {
      axis.set(order[0] === 0 ? 1 : 0, order[0] === 1 ? 1 : 0, order[0] === 2 ? 1 : 0).applyQuaternion(quaternion);
      normals[k] = axis.x;
      normals[k + 1] = axis.y;
      normals[k + 2] = axis.z;
    }
    // 넓은 스플랫일수록 표면을 많이 덮는다
    weights[count] = opacity * Math.min(1, (s[order[1]] * s[order[2]]) / (maxScale * maxScale * 0.01));
    brightness[count] = Math.min(1, Math.max(0, 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b));
    count += 1;
  });
  if (count <= maxPoints)
    return { count, positions: positions.subarray(0, count * 3), normals: normals.subarray(0, count * 3), weights: weights.subarray(0, count), brightness: brightness.subarray(0, count) };
  // 너무 많으면 고르게 줄인다
  const keep = maxPoints;
  const out = { count: keep, positions: new Float32Array(keep * 3), normals: new Float32Array(keep * 3), weights: new Float32Array(keep), brightness: new Float32Array(keep) };
  for (let k = 0; k < keep; k += 1) {
    const i = Math.floor((k * count) / keep);
    out.positions.set(positions.subarray(i * 3, i * 3 + 3), k * 3);
    out.normals.set(normals.subarray(i * 3, i * 3 + 3), k * 3);
    out.weights[k] = weights[i];
    out.brightness[k] = brightness[i];
  }
  return out;
}
