import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { pickSurfaceAlongRay, type Quat, type SplatVisitor, type Vec3 } from '@/lib/three/splatPick';

type Splat = { center: Vec3; scales: Vec3; quaternion: Quat; opacity: number };

const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };
const visitAll = (splats: Splat[]) => (visit: SplatVisitor) => {
  for (const s of splats) visit(s.center, s.scales, s.quaternion, s.opacity);
};

/** y = height 평면에 납작한 스플랫을 격자로 깐다 (바닥·천장). */
function plane(height: number, opacity = 0.9, half = 3, step = 0.1): Splat[] {
  const out: Splat[] = [];
  for (let x = -half; x <= half; x += step) {
    for (let z = -half; z <= half; z += step) {
      out.push({ center: { x, y: height, z }, scales: { x: 0.08, y: 0.001, z: 0.08 }, quaternion: IDENTITY, opacity });
    }
  }
  return out;
}

/** x = 2 평면의 벽: 바닥용 스플랫을 Z축으로 90° 돌려 세운다. */
function wallAtX(x0: number): Splat[] {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  const out: Splat[] = [];
  for (let y = 0; y <= 2.5; y += 0.1) {
    for (let z = -3; z <= 3; z += 0.1) {
      out.push({
        center: { x: x0, y, z },
        scales: { x: 0.08, y: 0.001, z: 0.08 },
        quaternion: { x: q.x, y: q.y, z: q.z, w: q.w },
        opacity: 0.9,
      });
    }
  }
  return out;
}

function hitPoint(splats: Splat[], origin: THREE.Vector3, target: THREE.Vector3) {
  const direction = target.clone().sub(origin).normalize();
  const pick = pickSurfaceAlongRay(visitAll(splats), origin, direction, { near: 0.05 });
  return pick ? { ...pick, point: origin.clone().addScaledVector(direction, pick.distance) } : null;
}

describe('pickSurfaceAlongRay', () => {
  const floor = plane(0);

  it('수직으로 내려다본 광선이 바닥(y=0)에 닿는다', () => {
    const hit = hitPoint(floor, new THREE.Vector3(0.33, 1.6, -0.21), new THREE.Vector3(0.33, 0, -0.21));
    expect(hit).not.toBeNull();
    expect(hit!.point.y).toBeCloseTo(0, 2);
    expect(hit!.distance).toBeCloseTo(1.6, 2);
  });

  it('비스듬한 광선도 바닥의 정확한 위치에 닿는다 (오차 1cm 이내)', () => {
    const target = new THREE.Vector3(1.7, 0, 1.2);
    const hit = hitPoint(floor, new THREE.Vector3(0, 1.4, 0), target);
    expect(hit).not.toBeNull();
    expect(hit!.point.distanceTo(target)).toBeLessThan(0.01);
  });

  it('바닥에 거의 스치는 각도(약 10°)에서도 2cm 이내', () => {
    const target = new THREE.Vector3(2.5, 0, 0);
    const hit = hitPoint(floor, new THREE.Vector3(-2.5, 0.9, 0), target);
    expect(hit).not.toBeNull();
    expect(hit!.point.distanceTo(target)).toBeLessThan(0.02);
  });

  it('바닥과 벽이 만나는 모서리 쪽을 찍으면 벽보다 앞의 바닥이 잡힌다', () => {
    const scene = [...floor, ...wallAtX(2)];
    const target = new THREE.Vector3(1.9, 0, 0.5); // 벽 10cm 앞 바닥
    const hit = hitPoint(scene, new THREE.Vector3(0.5, 1.4, 0), target);
    expect(hit!.point.distanceTo(target)).toBeLessThan(0.01);
  });

  it('세워진(회전된) 벽 스플랫에 닿는다', () => {
    const hit = hitPoint(wallAtX(2), new THREE.Vector3(0, 1.2, 0.3), new THREE.Vector3(2, 1.0, 0.8));
    expect(hit).not.toBeNull();
    expect(hit!.point.x).toBeCloseTo(2, 2);
  });

  it('앞에 떠 있는 옅은 조각(불투명도 0.1)은 무시하고 바닥을 고른다', () => {
    const floater: Splat = {
      center: { x: 0.5, y: 0.7, z: 0.5 },
      scales: { x: 0.2, y: 0.2, z: 0.2 },
      quaternion: IDENTITY,
      opacity: 0.1,
    };
    const target = new THREE.Vector3(1, 0, 1);
    const hit = hitPoint([...floor, floater], new THREE.Vector3(0, 1.4, 0), target);
    expect(hit!.point.distanceTo(target)).toBeLessThan(0.01);
  });

  it('앞에 불투명한 물체가 있으면 그 물체가 잡힌다', () => {
    const box: Splat = {
      center: { x: 0.5, y: 0.7, z: 0.5 },
      scales: { x: 0.15, y: 0.15, z: 0.15 },
      quaternion: IDENTITY,
      opacity: 0.95,
    };
    const hit = hitPoint([...floor, box], new THREE.Vector3(0, 1.4, 0), new THREE.Vector3(1, 0, 1));
    expect(hit!.point.y).toBeGreaterThan(0.5);
  });

  it('아무것도 없는 방향은 null', () => {
    expect(hitPoint(floor, new THREE.Vector3(0, 1.4, 0), new THREE.Vector3(0, 3, 0))).toBeNull();
  });

  it('옅은 스플랫만 스치면(누적 불투명도 부족) null', () => {
    const haze: Splat[] = [
      { center: { x: 0, y: 0, z: 1 }, scales: { x: 0.2, y: 0.2, z: 0.2 }, quaternion: IDENTITY, opacity: 0.05 },
    ];
    expect(hitPoint(haze, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1))).toBeNull();
  });

  it('near보다 가까운 스플랫은 건너뛴다', () => {
    const close: Splat = {
      center: { x: 0, y: 1.39, z: 0 },
      scales: { x: 0.05, y: 0.05, z: 0.05 },
      quaternion: IDENTITY,
      opacity: 0.95,
    };
    const hit = hitPoint([...floor, close], new THREE.Vector3(0, 1.4, 0), new THREE.Vector3(0, 0, 0));
    expect(hit!.point.y).toBeCloseTo(0, 2);
  });

  it('광택 바닥: 반투명한 바닥 아래에 반사 스플랫이 있어도 바닥 면을 고른다', () => {
    // 바닥 자체의 기여는 30%뿐이고, 나머지는 0.8m 아래에 맺힌 반사(불투명)가 차지한다
    const scene = [...plane(0, 0.3), ...plane(-0.8, 0.95)];
    const straight = hitPoint(scene, new THREE.Vector3(0.2, 2.2, 0.2), new THREE.Vector3(0.2, 0, 0.2));
    expect(straight!.point.y).toBeCloseTo(0, 2);
    const target = new THREE.Vector3(1.5, 0, 1.0);
    const oblique = hitPoint(scene, new THREE.Vector3(0, 1.4, 0), target);
    expect(oblique!.point.distanceTo(target)).toBeLessThan(0.02);
  });

  it('아주 옅은 바닥 층(기여 7%)도 뒤의 반사보다 먼저 잡는다', () => {
    const scene = [...plane(0, 0.07), ...plane(-1.6, 0.45)];
    const hit = hitPoint(scene, new THREE.Vector3(0, 2.2, 0), new THREE.Vector3(0, 0, 0));
    expect(hit!.point.y).toBeCloseTo(0, 2);
  });
});
