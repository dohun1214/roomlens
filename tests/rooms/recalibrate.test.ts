import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { SavedCalibration } from '@/lib/rooms/calibration';
import { remapFixtures, remapLayoutItems, remapOpenings, roomRemap } from '@/lib/rooms/recalibrate';
import type { Opening } from '@/lib/rooms/openings';

const yaw = (deg: number): [number, number, number, number] => {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (deg * Math.PI) / 180);
  return [q.x, q.y, q.z, q.w];
};
const SQUARE: [number, number][] = [
  [-2, -1.5],
  [2, -1.5],
  [2, 1.5],
  [-2, 1.5],
];
const cal = (s: number, q: [number, number, number, number], t: [number, number, number], floorPolygon = SQUARE, flipX = false): SavedCalibration => ({
  transform: { s, q, t },
  flipX,
  floorPolygon,
});
const item = (x: number, z: number, rotationDeg = 0) => ({ id: 'f1', furnitureRef: 'desk', kind: 'catalog' as const, x, z, rotationDeg });

describe('roomRemap', () => {
  it('같은 보정이면 그대로', () => {
    const a = cal(1, [0, 0, 0, 1], [0, 0, 0]);
    const r = roomRemap(a, { ...a, floorPolygon: SQUARE });
    expect(r.identity).toBe(true);
    expect(remapLayoutItems([item(1, 2)], r)).toEqual([item(1, 2)]);
  });

  it('옮기기만 했으면 같은 만큼 옮긴다', () => {
    const r = roomRemap(cal(1, [0, 0, 0, 1], [0, 0, 0]), cal(1, [0, 0, 0, 1], [0.5, 0, -1]));
    expect(r.point(1, 1)).toEqual([1.5, 0]);
    expect(r.yawDeg).toBeCloseTo(0);
  });

  it('원본은 그대로이고 방 좌표만 돌았으면 가구 자리와 방향도 같이 돈다', () => {
    // 새 보정이 원본을 90° 더 돌림 → 예전 방의 +X는 새 방의 -Z (rotation.y = 90°)
    const r = roomRemap(cal(1, [0, 0, 0, 1], [0, 0, 0]), cal(1, yaw(90), [0, 0, 0]));
    const [x, z] = r.point(1, 0);
    expect(x).toBeCloseTo(0);
    expect(z).toBeCloseTo(-1);
    expect(r.yawDeg).toBeCloseTo(90);
    expect(remapLayoutItems([item(1, 0, 10)], r)).toEqual([item(0, -1, 100)]);
  });

  it('크기를 고쳤으면 자리는 배율만큼, 가구 치수는 그대로', () => {
    const r = roomRemap(cal(1, [0, 0, 0, 1], [0, 0, 0]), cal(1.1, [0, 0, 0, 1], [0, 0, 0]));
    expect(r.scale).toBeCloseTo(1.1);
    expect(remapLayoutItems([item(2, -1, 45)], r)).toEqual([item(2.2, -1.1, 45)]);
  });

  it('예전 보정 → 원본 → 새 보정 (회전·크기·이동이 섞여도 원본 기준 같은 자리)', () => {
    const before = cal(0.8, yaw(30), [1, 0.2, -2]);
    const after = cal(1.25, yaw(-45), [-0.5, -0.1, 3]);
    const r = roomRemap(before, after);
    // 원본의 한 점을 두 보정으로 각각 옮겨 비교
    const toRoom = (c: SavedCalibration, p: THREE.Vector3) =>
      p.clone().applyQuaternion(new THREE.Quaternion(...c.transform.q)).multiplyScalar(c.transform.s).add(new THREE.Vector3(...c.transform.t));
    const source = new THREE.Vector3(3, -0.25, 1);
    const a = toRoom(before, source);
    const b = toRoom(after, source);
    const [x, z] = r.point(a.x, a.z);
    expect(x).toBeCloseTo(b.x, 6);
    expect(z).toBeCloseTo(b.z, 6);
    expect(r.yawDeg).toBeCloseTo(-75);
  });

  it('회전은 0~359 정수로', () => {
    const r = roomRemap(cal(1, [0, 0, 0, 1], [0, 0, 0]), cal(1, yaw(-90), [0, 0, 0]));
    expect(remapLayoutItems([item(0, 0, 30)], r)[0].rotationDeg).toBe(300);
  });
});

describe('remapFixtures', () => {
  it('원래 가구는 크기도 배율만큼', () => {
    const r = roomRemap(cal(1, [0, 0, 0, 1], [0, 0, 0]), cal(2, [0, 0, 0, 1], [0, 0, 0]));
    const [f] = remapFixtures([{ id: 'x1', label: '소파', x: 1, z: 0.5, w: 2, d: 0.9, h: 0.8, rotationDeg: 0, remove: false }], r);
    expect(f).toMatchObject({ x: 2, z: 1, w: 4, d: 1.8, h: 1.6, rotationDeg: 0 });
  });
});

describe('remapOpenings', () => {
  const door: Opening = { type: 'door', wallIndex: 0, from: 0.5, to: 1.4, widthM: 0.9 };
  const win: Opening = { type: 'window', wallIndex: 2, from: 1, to: 2.2, widthM: 1.2 };

  it('평면도를 돌린 만큼 같은 벽(새 번호)의 같은 자리로', () => {
    // 새 보정에서 방이 90° 돌아 벽 순서가 하나 밀림: 새 평면도의 벽 i는 예전 벽 i-1
    const r = roomRemap(cal(1, [0, 0, 0, 1], [0, 0, 0]), cal(1, yaw(90), [0, 0, 0]));
    const turned = SQUARE.map(([x, z]) => r.point(x, z));
    const after = [turned[3], ...turned.slice(0, 3)];
    const moved = remapOpenings([door, win], SQUARE, after, r);
    expect(moved).toEqual([
      { type: 'door', wallIndex: 1, from: 0.5, to: 1.4, widthM: 0.9 },
      { type: 'window', wallIndex: 3, from: 1, to: 2.2, widthM: 1.2 },
    ]);
  });

  it('보정은 같고 벽 하나만 조금 옮겼으면 그 벽에 다시 얹는다', () => {
    const r = roomRemap(cal(1, [0, 0, 0, 1], [0, 0, 0]), cal(1, [0, 0, 0, 1], [0, 0, 0]));
    const after: [number, number][] = [
      [-2, -1.6],
      [2, -1.6],
      [2, 1.5],
      [-2, 1.5],
    ];
    expect(remapOpenings([door], SQUARE, after, r)).toEqual([door]);
  });

  it('새 벽에서 멀어진 문·창문은 버린다', () => {
    const r = roomRemap(cal(1, [0, 0, 0, 1], [0, 0, 0]), cal(1, [0, 0, 0, 1], [0, 0, 0]));
    const smaller: [number, number][] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    expect(remapOpenings([door, win], SQUARE, smaller, r)).toEqual([]);
  });
});
