import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  footprintCorners,
  halfExtentAlong,
  placeOnFloor,
  rayFloorPoint,
  signedArea,
  snapToGrid,
  snapToWalls,
  type Footprint,
  type Point2,
} from '@/lib/three/floorDrag';

// 3.2 × 4.0m 방 (원점이 중심). 두 가지 꼭짓점 순서를 모두 시험한다.
const ROOM: Point2[] = [
  [-1.6, -2],
  [1.6, -2],
  [1.6, 2],
  [-1.6, 2],
];
const ROOM_REVERSED = [...ROOM].reverse();
const desk = (x: number, z: number, rotationDeg = 0): Footprint => ({ x, z, w: 1.2, d: 0.6, rotationDeg });

describe('rayFloorPoint', () => {
  it('내려다보는 광선은 바닥(y=0)과 만난다', () => {
    const p = rayFloorPoint({ x: 0, y: 2, z: 0 }, { x: 0.5, y: -1, z: 0.25 });
    expect(p![0]).toBeCloseTo(1, 9);
    expect(p![1]).toBeCloseTo(0.5, 9);
  });

  it('수평이거나 위를 향하는 광선은 null', () => {
    expect(rayFloorPoint({ x: 0, y: 2, z: 0 }, { x: 1, y: 0, z: 0 })).toBeNull();
    expect(rayFloorPoint({ x: 0, y: 2, z: 0 }, { x: 0, y: 1, z: 0 })).toBeNull();
  });

  it('바닥 높이를 지정할 수 있다', () => {
    const p = rayFloorPoint({ x: 0, y: 2, z: 0 }, { x: 1, y: -1, z: 0 }, 0.5);
    expect(p![0]).toBeCloseTo(1.5, 9);
  });
});

describe('snapToGrid', () => {
  it('5cm 단위로 맞춘다', () => {
    expect(snapToGrid(1.234)).toBeCloseTo(1.25, 9);
    expect(snapToGrid(-0.321)).toBeCloseTo(-0.3, 9);
    expect(snapToGrid(0.02)).toBeCloseTo(0, 9);
  });
});

describe('가구 밑면', () => {
  it('회전 0°: 가로 w는 x 방향, 깊이 d는 z 방향', () => {
    const f = desk(0, 0);
    expect(halfExtentAlong(f, [1, 0])).toBeCloseTo(0.6, 9);
    expect(halfExtentAlong(f, [0, 1])).toBeCloseTo(0.3, 9);
  });

  it('회전 90°: 가로와 깊이가 바뀐다', () => {
    const f = desk(0, 0, 90);
    expect(halfExtentAlong(f, [1, 0])).toBeCloseTo(0.3, 9);
    expect(halfExtentAlong(f, [0, 1])).toBeCloseTo(0.6, 9);
  });

  it('꼭짓점이 three.js의 Y축 회전 결과와 같다', () => {
    const f: Footprint = { x: 0.4, z: -0.7, w: 1.2, d: 0.6, rotationDeg: 30 };
    const object = new THREE.Object3D();
    object.position.set(f.x, 0, f.z);
    object.rotation.y = THREE.MathUtils.degToRad(f.rotationDeg);
    object.updateMatrixWorld();
    const expected = [
      [-0.6, -0.3],
      [0.6, -0.3],
      [0.6, 0.3],
      [-0.6, 0.3],
    ].map(([x, z]) => new THREE.Vector3(x, 0, z).applyMatrix4(object.matrixWorld));
    footprintCorners(f).forEach((c, i) => {
      expect(c[0]).toBeCloseTo(expected[i].x, 9);
      expect(c[1]).toBeCloseTo(expected[i].z, 9);
    });
  });
});

describe('snapToWalls', () => {
  it('벽에서 먼 가구는 그대로 둔다', () => {
    const f = snapToWalls(desk(0, 0), ROOM);
    expect(f.x).toBe(0);
    expect(f.z).toBe(0);
  });

  it('벽과의 틈이 10cm보다 작으면 벽에 붙인다', () => {
    // 오른쪽 벽 x=1.6, 책상 반폭 0.6 → 중심 x=0.95면 틈 5cm
    const f = snapToWalls(desk(0.95, 0), ROOM);
    expect(f.x).toBeCloseTo(1.0, 9);
    expect(f.z).toBe(0);
  });

  it('틈이 10cm 이상이면 붙이지 않는다', () => {
    expect(snapToWalls(desk(0.85, 0), ROOM).x).toBeCloseTo(0.85, 9);
  });

  it('벽 밖으로 끌어도 방 안에 머문다', () => {
    const f = snapToWalls(desk(5, -9), ROOM);
    expect(f.x).toBeCloseTo(1.0, 9); // 오른쪽 벽에 붙음
    expect(f.z).toBeCloseTo(-1.7, 9); // 아래쪽 벽(z=-2)에 붙음, 반깊이 0.3
  });

  it('모서리 근처에서는 두 벽에 모두 붙는다', () => {
    const f = snapToWalls(desk(-0.96, 1.66), ROOM);
    expect(f.x).toBeCloseTo(-1.0, 9);
    expect(f.z).toBeCloseTo(1.7, 9);
  });

  it('90° 돌린 가구는 깊이 쪽이 벽에 닿는다', () => {
    const f = snapToWalls(desk(1.28, 0, 90), ROOM);
    expect(f.x).toBeCloseTo(1.3, 9); // 반폭이 0.3으로 바뀜
  });

  it('꼭짓점 순서가 반대여도 결과가 같다', () => {
    expect(signedArea(ROOM) * signedArea(ROOM_REVERSED)).toBeLessThan(0);
    const a = snapToWalls(desk(5, -9), ROOM);
    const b = snapToWalls(desk(5, -9), ROOM_REVERSED);
    expect(b.x).toBeCloseTo(a.x, 9);
    expect(b.z).toBeCloseTo(a.z, 9);
  });

  it('비스듬한 벽(45° 돌아간 방)에서도 붙인 뒤 모든 꼭짓점이 방 안에 있다', () => {
    const c = Math.SQRT1_2;
    const rotated: Point2[] = ROOM.map(([x, z]) => [x * c - z * c, x * c + z * c]);
    const f = snapToWalls(desk(3, 0), rotated);
    const back = footprintCorners(f).map(([x, z]) => [x * c + z * c, -x * c + z * c]);
    for (const [x, z] of back) {
      expect(x).toBeLessThanOrEqual(1.6 + 1e-9);
      expect(Math.abs(z)).toBeLessThanOrEqual(2 + 1e-9);
    }
    // 가장 바깥 꼭짓점은 벽에 닿아 있다
    expect(Math.max(...back.map(([x]) => x))).toBeCloseTo(1.6, 9);
  });
});

describe('placeOnFloor', () => {
  it('격자에 맞춘 뒤 벽에 붙인다', () => {
    const f = placeOnFloor(desk(0.337, -0.412), ROOM);
    expect(f.x).toBeCloseTo(0.35, 9);
    expect(f.z).toBeCloseTo(-0.4, 9);
  });

  it('평면도가 없으면 격자 스냅만 한다', () => {
    const f = placeOnFloor(desk(7.777, 0), null);
    expect(f.x).toBeCloseTo(7.8, 9);
  });
});
