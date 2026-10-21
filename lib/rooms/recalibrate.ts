// 보정을 다시 했을 때 예전 방 좌표의 것(배치·원래 가구·문·창문)을 새 방 좌표로 옮긴다.
// 방 좌표 p = s·R·(F·p_원본) + t (F는 "X축 180°" 뒤집기). 원본(스플랫) 좌표는 그대로이므로
// 예전 방 좌표 → 원본 → 새 방 좌표로 옮기면 가구가 3D 안의 같은 자리에 남는다.
import * as THREE from 'three';
import type { SavedItem } from '@/lib/layout/saved';
import type { SavedCalibration } from './calibration';
import type { Fixture } from './fixtures';
import { openingSegment, wallsOf, type Opening } from './openings';

type Point2 = [number, number];

/** 예전 방 좌표 → 새 방 좌표. 바닥 위의 점과 바닥에서의 회전(도), 길이 배율 */
export type RoomRemap = {
  point: (x: number, z: number) => Point2;
  /** 새 회전 = 예전 회전 + yawDeg */
  yawDeg: number;
  /** 새 방 좌표의 1 = 예전 방 좌표의 1/scale (실제 길이를 고쳐 크기가 바뀐 경우) */
  scale: number;
  /** 아무것도 바뀌지 않았는지 */
  identity: boolean;
};

const FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);

/** 원본 → 방 좌표의 4×4 행렬 */
function roomMatrix(c: SavedCalibration): THREE.Matrix4 {
  const { s, q, t } = c.transform;
  const rotation = new THREE.Quaternion(...q).normalize();
  if (c.flipX) rotation.multiply(FLIP);
  return new THREE.Matrix4().compose(new THREE.Vector3(...t), rotation, new THREE.Vector3(s, s, s));
}

const same = (a: SavedCalibration, b: SavedCalibration) =>
  a.flipX === b.flipX && a.transform.s === b.transform.s && a.transform.q.every((v, i) => v === b.transform.q[i]) && a.transform.t.every((v, i) => v === b.transform.t[i]);

export function roomRemap(before: SavedCalibration, after: SavedCalibration): RoomRemap {
  if (same(before, after)) return { point: (x, z) => [x, z], yawDeg: 0, scale: 1, identity: true };
  // 예전 방 → 원본 → 새 방
  const m = roomMatrix(after).multiply(roomMatrix(before).invert());
  const point = (x: number, z: number): Point2 => {
    const v = new THREE.Vector3(x, 0, z).applyMatrix4(m);
    return [v.x, v.z];
  };
  // 회전: 가로 방향 (1, 0, 0)이 어디로 가는지 (three.js의 rotation.y와 같은 규칙: r도 → (cos r, 0, -sin r))
  const o = new THREE.Vector3(0, 0, 0).applyMatrix4(m);
  const x = new THREE.Vector3(1, 0, 0).applyMatrix4(m).sub(o);
  const yawDeg = (Math.atan2(-x.z, x.x) * 180) / Math.PI;
  const scale = after.transform.s / before.transform.s;
  return { point, yawDeg, scale, identity: false };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000 + 0;
const round2 = (v: number) => Math.round(v * 100) / 100 + 0;
const wrapDeg = (deg: number) => ((deg % 360) + 360) % 360;

/** 배치의 가구: 자리와 회전만 옮긴다 (가구 치수는 실제 크기라 그대로) */
export function remapLayoutItems(items: SavedItem[], remap: RoomRemap): SavedItem[] {
  if (remap.identity) return items;
  return items.map((item) => {
    const [x, z] = remap.point(item.x, item.z);
    return { ...item, x: round3(x), z: round3(z), rotationDeg: Math.round(wrapDeg(item.rotationDeg + remap.yawDeg)) % 360 };
  });
}

/** 원래 가구: 3D 스캔 속의 물건이라 크기도 배율만큼 바뀐다 */
export function remapFixtures(fixtures: Fixture[], remap: RoomRemap): Fixture[] {
  if (remap.identity) return fixtures;
  return fixtures.map((f) => {
    const [x, z] = remap.point(f.x, f.z);
    return {
      ...f,
      x: round3(x),
      z: round3(z),
      w: round2(f.w * remap.scale),
      d: round2(f.d * remap.scale),
      h: round2(f.h * remap.scale),
      rotationDeg: round2(wrapDeg(f.rotationDeg + remap.yawDeg)),
    };
  });
}

/** 문·창문을 옮길 때 새 벽에서 이만큼 넘게 떨어지면 버린다 (m) */
export const OPENING_SNAP = 0.3;

/**
 * 문·창문: 벽 번호로 저장하므로 양 끝을 새 방 좌표로 옮긴 뒤 가장 가까운 새 벽에 다시 얹는다.
 * 양 끝이 한 벽 가까이에 없으면(벽 모양이 크게 바뀜) 버린다.
 */
export function remapOpenings(openings: Opening[], beforePolygon: Point2[], afterPolygon: Point2[], remap: RoomRemap): Opening[] {
  if (remap.identity && JSON.stringify(beforePolygon) === JSON.stringify(afterPolygon)) return openings;
  const walls = wallsOf(afterPolygon);
  const out: Opening[] = [];
  for (const opening of openings) {
    const segment = openingSegment(opening, beforePolygon);
    if (!segment) continue;
    const a = remap.point(...segment[0]);
    const b = remap.point(...segment[1]);
    let best: { index: number; from: number; to: number; dist: number } | null = null;
    for (const wall of walls) {
      if (wall.length < 1e-6) continue;
      const ux = (wall.b[0] - wall.a[0]) / wall.length;
      const uz = (wall.b[1] - wall.a[1]) / wall.length;
      const along = (p: Point2) => (p[0] - wall.a[0]) * ux + (p[1] - wall.a[1]) * uz;
      const off = (p: Point2) => Math.abs((p[0] - wall.a[0]) * uz - (p[1] - wall.a[1]) * ux);
      const [s1, s2] = [along(a), along(b)].sort((m, n) => m - n);
      const from = Math.max(0, s1);
      const to = Math.min(wall.length, s2);
      // 벽 구간 안에 대부분이 들어와야 한다
      if (to - from < Math.max(0.1, (s2 - s1) * 0.7)) continue;
      const dist = Math.max(off(a), off(b));
      if (dist <= OPENING_SNAP && (!best || dist < best.dist)) best = { index: wall.index, from, to, dist };
    }
    if (!best) continue;
    const from = round2(best.from);
    const to = round2(best.to);
    out.push({ type: opening.type, wallIndex: best.index, from, to, widthM: round2(to - from) });
  }
  // 같은 벽에서 겹치면 먼저 것만 남긴다
  return out.filter((o, i) => !out.slice(0, i).some((p) => p.wallIndex === o.wallIndex && o.from < p.to - 0.01 && p.from < o.to - 0.01));
}
