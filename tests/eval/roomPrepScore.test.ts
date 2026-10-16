import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  boxIoU,
  frameMap,
  frameScale,
  mapFixture,
  openingSegments,
  polygonIoU,
  scoreFixtures,
  scoreLayout,
  scoreOpenings,
  turningCorners,
  type FixtureBox,
  type OpeningSegment,
} from '@/lib/eval/roomPrepScore';
import type { Point2 } from '@/lib/three/floorDrag';

const rect = (w: number, d: number, cx = 0, cz = 0): Point2[] => [
  [cx - w / 2, cz - d / 2],
  [cx + w / 2, cz - d / 2],
  [cx + w / 2, cz + d / 2],
  [cx - w / 2, cz + d / 2],
];
const box = (over: Partial<FixtureBox> = {}): FixtureBox => ({ label: '침대', x: 0, z: 0, w: 2, d: 1.6, rotationDeg: 0, h: 0.5, ...over });
const IDENTITY = { transform: { s: 1, q: [0, 0, 0, 1] as [number, number, number, number], t: [0, 0, 0] as [number, number, number] }, flipX: false };

describe('scoreLayout', () => {
  it('같은 방은 겹침 1, 모서리 오차 0', () => {
    const s = scoreLayout(rect(4, 3), rect(4, 3));
    expect(s.iou).toBeCloseTo(1, 2);
    expect(s.cornerMean).toBeCloseTo(0, 5);
    expect(s.areaRatio).toBeCloseTo(1, 5);
    expect(s.corners).toEqual([4, 4]);
  });

  it('한 벽이 20cm 안쪽이면 겹침이 그만큼 줄고 그 쪽 모서리만 틀린다', () => {
    const pred = rect(3.8, 3, -0.1);
    const s = scoreLayout(pred, rect(4, 3));
    expect(s.iou).toBeCloseTo(0.95, 2);
    expect(s.cornerMax).toBeCloseTo(0.2, 3);
    expect(s.cornerMean).toBeCloseTo(0.1, 3);
  });

  it('한 직선 위의 점은 모서리로 세지 않는다', () => {
    expect(turningCorners([[0, 0], [2, 0], [4, 0], [4, 3], [0, 3]])).toHaveLength(4);
  });

  it('겹치지 않으면 0', () => {
    expect(polygonIoU(rect(1, 1), rect(1, 1, 5, 5))).toBe(0);
  });
});

describe('scoreOpenings', () => {
  const room = rect(4, 3);
  it('저장 형식을 벽 위의 선분으로 바꾼다', () => {
    const [s] = openingSegments([{ type: 'door', wallIndex: 1, from: 0.5, to: 1.4, widthM: 0.9 }], room);
    expect(s.a[0]).toBeCloseTo(2);
    expect(s.a[1]).toBeCloseTo(-1);
    expect(s.b[1]).toBeCloseTo(-0.1);
  });

  it('같은 벽에서 많이 겹치면 맞음, 다른 벽이거나 멀면 틀림', () => {
    const truth: OpeningSegment[] = [
      { type: 'door', a: [2, -1], b: [2, -0.1] },
      { type: 'window', a: [-1, -1.5], b: [1, -1.5] },
    ];
    const pred: OpeningSegment[] = [
      { type: 'door', a: [2.05, -0.95], b: [2.05, -0.05] },
      { type: 'door', a: [-0.9, -1.5], b: [1.1, -1.5] },
      { type: 'window', a: [-2, 0], b: [-2, 1] },
    ];
    const s = scoreOpenings(pred, truth);
    expect(s.matched).toBe(2);
    expect(s.recall).toBe(1);
    expect(s.precision).toBeCloseTo(2 / 3);
    expect(s.typeAccuracy).toBe(0.5);
    expect(s.endError).toBeGreaterThan(0.05);
    expect(s.endError).toBeLessThan(0.12);
  });

  it('정답이 없고 결과도 없으면 1 (나눌 것이 없음)', () => {
    expect(scoreOpenings([], []).recall).toBe(1);
  });
});

describe('scoreFixtures', () => {
  it('회전한 사각형의 겹침을 잰다', () => {
    expect(boxIoU(box(), box())).toBeCloseTo(1, 5);
    // 90° 돌리면 2×1.6 과 1.6×2 → 겹침 1.6×1.6
    expect(boxIoU(box(), box({ rotationDeg: 90 }))).toBeCloseTo((1.6 * 1.6) / (2 * 2 * 1.6 - 1.6 * 1.6), 4);
  });

  it('한 정답에 결과 하나만 맞는다 (중복은 틀린 후보)', () => {
    const truth = [box(), box({ label: '옷장', x: 3, w: 0.6, d: 1.5, h: 2 })];
    const pred = [box({ x: 0.1, h: 0.6 }), box({ x: 0.15 }), box({ label: '수납장', x: 3, w: 0.6, d: 1.5, h: 1.9 })];
    const s = scoreFixtures(pred, truth);
    expect(s.matched).toBe(2);
    expect(s.precision).toBeCloseTo(2 / 3);
    expect(s.typeAccuracy).toBe(0.5);
    expect(s.centerError).toBeCloseTo(0.05, 3);
    expect(s.heightError).toBeCloseTo(0.1, 3);
  });
});

describe('frameMap', () => {
  it('같은 파일을 다르게 보정한 결과를 정답 좌표로 옮긴다', () => {
    // 정답 보정: 그대로. 결과 보정: 2배 크기 + 90° 돌림 + 옮김
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    const pred = { transform: { s: 2, q: [q.x, q.y, q.z, q.w] as [number, number, number, number], t: [1, 0, 3] as [number, number, number] }, flipX: false };
    const toTruth = frameMap(pred, IDENTITY);
    // 파일 좌표 (1, 0, 0) 은 결과 방 좌표로 2·R·p + t
    const fileP = new THREE.Vector3(1, 0, 0);
    const inPred = fileP.clone().applyQuaternion(q).multiplyScalar(2).add(new THREE.Vector3(1, 0, 3));
    const back = toTruth([inPred.x, inPred.z]);
    expect(back[0]).toBeCloseTo(1, 6);
    expect(back[1]).toBeCloseTo(0, 6);
    expect(frameScale(pred, IDENTITY)).toBeCloseTo(0.5);
    // 가구도 크기가 반으로 줄고 방향이 돌아간다
    const f = mapFixture(box({ x: inPred.x, z: inPred.z }), toTruth, frameScale(pred, IDENTITY));
    expect([f.w, f.d, f.h]).toEqual([1, 0.8, 0.25]);
    expect(f.rotationDeg % 90).toBeCloseTo(0, 4);
  });

  it('X축 뒤집기를 함께 계산한다', () => {
    const flipped = { ...IDENTITY, flipX: true };
    // 뒤집은 쪽의 (x, z) 는 파일의 (x, -z)
    expect(frameMap(flipped, IDENTITY)([1, 2])).toEqual([1, -2]);
  });
});
