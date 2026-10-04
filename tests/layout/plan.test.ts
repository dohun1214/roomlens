import { describe, expect, it } from 'vitest';
import type { Point2 } from '@/lib/three/floorDrag';
import { dragPlacement, gridLines, planViewBox, pointsAttr, wallLabels } from '@/lib/layout/plan';

// 4 × 3 m 방
const ROOM: Point2[] = [
  [-2, -1.5],
  [2, -1.5],
  [2, 1.5],
  [-2, 1.5],
];

describe('planViewBox', () => {
  it('방 전체에 여백 0.5m를 둔다', () => {
    expect(planViewBox(ROOM)).toEqual({ x: -2.5, y: -2, width: 5, height: 4 });
  });

  it('여백을 바꿀 수 있고, 원점에서 벗어난 방도 된다', () => {
    expect(planViewBox([[1, 2], [4, 2], [4, 7]], 0.1)).toEqual({ x: 0.9, y: 1.9, width: 3.2, height: 5.2 });
  });

  it('빈 평면도면 여백만 한 상자', () => {
    expect(planViewBox([])).toEqual({ x: -0.5, y: -0.5, width: 1, height: 1 });
  });
});

describe('pointsAttr · gridLines', () => {
  it('SVG points 값 (mm 단위로 반올림)', () => {
    expect(pointsAttr([[0, 0], [1.23456, -0.5], [-0.00001, 2]])).toBe('0,0 1.235,-0.5 0,2');
  });

  it('viewBox 안의 정수 m 위치', () => {
    expect(gridLines({ x: -2.5, y: -2, width: 5, height: 4 })).toEqual({ xs: [-2, -1, 0, 1, 2], zs: [-2, -1, 0, 1, 2] });
  });
});

describe('wallLabels', () => {
  it('벽 가운데에서 방 바깥으로 0.25m 띄운 자리', () => {
    expect(wallLabels(ROOM)).toEqual([
      { index: 0, at: [0, -1.75] },
      { index: 1, at: [2.25, 0] },
      { index: 2, at: [0, 1.75] },
      { index: 3, at: [-2.25, 0] },
    ]);
  });

  it('꼭짓점이 반대 방향으로 돌아도 바깥쪽', () => {
    const labels = wallLabels([...ROOM].reverse());
    // 뒤집으면 벽 1은 위쪽 벽 (-2, 1.5) → (2, 1.5)
    expect(labels[0].at).toEqual([0, 1.75]);
    expect(labels[1].at).toEqual([2.25, 0]);
  });

  it('꼭짓점이 3개보다 적으면 없음', () => {
    expect(wallLabels([[0, 0], [1, 0]])).toEqual([]);
  });
});

describe('dragPlacement', () => {
  const desk = { id: 'f1', x: 0, z: 0, w: 1.2, d: 0.6, rotationDeg: 0 };

  it('잡은 자리를 유지한 채 포인터를 따라가고 5cm 격자에 맞는다', () => {
    // 가구 중심에서 (0.3, 0.1) 떨어진 곳을 잡았다 → grab = 중심 − 포인터 = (−0.3, −0.1)
    const moved = dragPlacement(desk, [-0.3, -0.1], [0.83, 0.52], ROOM);
    expect(moved.x).toBeCloseTo(0.55);
    expect(moved.z).toBeCloseTo(0.4);
    expect(moved.id).toBe('f1');
  });

  it('벽 너머로 끌면 벽에 붙는다', () => {
    const moved = dragPlacement(desk, [0, 0], [5, 0], ROOM);
    expect(moved.x).toBeCloseTo(1.4); // 오른쪽 벽 2.0 − 가로 절반 0.6
    expect(moved.z).toBeCloseTo(0);
  });

  it('회전한 가구는 돌린 크기로 벽에 붙는다', () => {
    const moved = dragPlacement({ ...desk, rotationDeg: 90 }, [0, 0], [5, 5], ROOM);
    expect(moved.x).toBeCloseTo(1.7); // 2.0 − 깊이 절반 0.3
    expect(moved.z).toBeCloseTo(0.9); // 1.5 − 가로 절반 0.6
  });

  it('평면도가 없으면 격자에만 맞춘다', () => {
    const moved = dragPlacement(desk, [0, 0], [5.02, -3.99], null);
    expect(moved.x).toBeCloseTo(5);
    expect(moved.z).toBeCloseTo(-4);
  });
});
