import { describe, expect, it } from 'vitest';
import type { CaptureView } from '@/lib/ai/analysis';
import { DetectInput, detectionPlan, locateDetections, MAX_DETECT_IMAGES, projectPoint, rayThrough, type Camera, type Detection } from '@/lib/ai/openingsDetect';
import { OPENINGS_SYSTEM_PROMPT } from '@/lib/ai/prompts';
import { distanceToPolygon, pointInPolygon } from '@/lib/layout/geometry';
import { openingSegment, type Opening } from '@/lib/rooms/openings';
import type { Point2 } from '@/lib/three/floorDrag';

// 4 × 3 m 방. 벽 1: z=-1.5 (x -2 → 2), 벽 2: x=2, 벽 3: z=1.5 (x 2 → -2), 벽 4: x=-2
const ROOM: Point2[] = [
  [-2, -1.5],
  [2, -1.5],
  [2, 1.5],
  [-2, 1.5],
];
const CAMERA: Camera = { aspect: 16 / 9, fovDeg: 60 };
const DOOR: Opening = { type: 'door', wallIndex: 0, from: 0.2, to: 1.1, widthM: 0.9 };
const WINDOW: Opening = { type: 'window', wallIndex: 2, from: 1, to: 2.2, widthM: 1.2 };
const HEIGHTS = { door: [0, 2.0], window: [0.9, 2.0] } as const;

/** 정답 문·창문이 그 시점의 그림에서 차지하는 상자 (Gemini가 완벽하게 찾았다고 치고). 전혀 안 보이면 null */
function boxOf(opening: Opening, view: CaptureView, polygon: Point2[] = ROOM, camera: Camera = CAMERA): Detection['box_2d'] | null {
  const [[x1, z1], [x2, z2]] = openingSegment(opening, polygon)!;
  const [low, high] = HEIGHTS[opening.type];
  const corners = [
    [x1, low, z1],
    [x2, low, z2],
    [x1, high, z1],
    [x2, high, z2],
  ].map((p) => projectPoint(view, camera, p as [number, number, number]));
  if (corners.some((c) => c === null)) return null;
  const xs = corners.map((c) => c![0]);
  const ys = corners.map((c) => c![1]);
  const [xmin, xmax, ymin, ymax] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  if (xmax <= 0 || xmin >= 1 || ymax <= 0 || ymin >= 1) return null;
  const clip = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000);
  return [clip(ymin), clip(xmin), clip(ymax), clip(xmax)];
}

/** 모든 시점에서, 보이는 것마다 상자를 만든다. fullOnly면 잘리지 않고 다 보이는 것만 */
function detect(openings: Opening[], views: CaptureView[], polygon: Point2[] = ROOM, fullOnly = false): Detection[] {
  const out: Detection[] = [];
  views.forEach((view, index) => {
    for (const opening of openings) {
      const box = boxOf(opening, view, polygon);
      if (!box) continue;
      const cut = box[1] === 0 || box[3] === 1000;
      if (fullOnly && cut) continue;
      // 가로로 2%도 안 보이는 것은 사람도 Gemini도 찾지 못한다
      if (box[3] - box[1] < 20) continue;
      out.push({ type: opening.type, imageIndex: index + 1, box_2d: box, confidence: 'high' });
    }
  });
  return out;
}

const near = (found: Opening | undefined, truth: Opening, tolerance: number) => {
  expect(found, `${truth.type} 벽 ${truth.wallIndex + 1}`).toBeDefined();
  expect(Math.abs(found!.from - truth.from)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(found!.to - truth.to)).toBeLessThanOrEqual(tolerance);
};

describe('그림 위의 점 ↔ 방 안의 광선', () => {
  const view: CaptureView = { position: [0, 1.5, 0], target: [1, 1.4, 0.3] };

  it('그림 가운데는 카메라가 보는 방향', () => {
    const d = rayThrough(view, CAMERA, 0.5, 0.5);
    const length = Math.hypot(1, -0.1, 0.3);
    expect(d[0]).toBeCloseTo(1 / length);
    expect(d[1]).toBeCloseTo(-0.1 / length);
    expect(d[2]).toBeCloseTo(0.3 / length);
  });

  it('광선 위의 점을 다시 그림에 비추면 같은 자리', () => {
    for (const [px, py] of [[0.1, 0.2], [0.9, 0.8], [0.5, 0.5], [0, 1]]) {
      const d = rayThrough(view, CAMERA, px, py);
      const point: [number, number, number] = [d[0] * 3, 1.5 + d[1] * 3, d[2] * 3];
      const [qx, qy] = projectPoint(view, CAMERA, point)!;
      expect(qx).toBeCloseTo(px, 6);
      expect(qy).toBeCloseTo(py, 6);
    }
  });

  it('카메라 뒤의 점은 보이지 않는다', () => {
    expect(projectPoint(view, CAMERA, [-3, 1.5, -0.9])).toBeNull();
  });
});

describe('캡처할 자리', () => {
  it('작은 방: 한 자리에서 여섯 방향', () => {
    const views = detectionPlan(ROOM);
    expect(views).toHaveLength(6);
    expect(new Set(views.map((v) => v.position.join())).size).toBe(1);
    expect(views[0].position).toEqual([0, 1.5, 0]);
  });

  it('집 전체: 세 자리 × 여섯 방향, 자리는 모두 방 안이고 서로 2.5m 넘게 떨어짐', () => {
    const home: Point2[] = [
      [2.78, -3.05], [6.33, -3.05], [6.33, 2.75], [2.63, 2.75], [2.63, 1.75], [2.42, 1.75], [2.42, 2.68], [-0.75, 2.68], [-0.75, 0.87],
      [-1.75, 0.87], [-1.75, 2.2], [-3.62, 2.2], [-3.62, 1.2], [-4.22, 1.2], [-4.22, 0], [-2.25, 0], [-2.25, -0.4], [-1.22, -0.4],
      [-1.22, -0.15], [1.3, -0.15], [1.3, -0.47], [2.42, -0.47], [2.42, 0.22], [2.63, 0.22], [2.63, -1.87], [2.78, -1.87],
    ];
    const views = detectionPlan(home);
    expect(views).toHaveLength(MAX_DETECT_IMAGES);
    const spots = [0, 6, 12].map((i) => [views[i].position[0], views[i].position[2]] as Point2);
    for (const spot of spots) {
      expect(pointInPolygon(spot, home)).toBe(true);
      expect(distanceToPolygon(spot, home)).toBeGreaterThanOrEqual(0.59);
    }
    for (let i = 0; i < 3; i += 1) {
      for (let j = i + 1; j < 3; j += 1) expect(Math.hypot(spots[i][0] - spots[j][0], spots[i][1] - spots[j][1])).toBeGreaterThan(2.5);
    }
  });
});

describe('상자 → 벽 위의 구간', () => {
  const views = detectionPlan(ROOM);

  it('다 보이는 문과 창문: 어느 벽의 어디인지 10cm 안으로 맞춘다', () => {
    const found = locateDetections(detect([DOOR, WINDOW], views, ROOM, true), views, CAMERA, ROOM);
    expect(found.map((o) => `${o.type}:${o.wallIndex}`)).toEqual(['door:0', 'window:2']);
    near(found[0], DOOR, 0.1);
    near(found[1], WINDOW, 0.1);
  });

  it('한 그림에 다 들어오지 않는 큰 창: 잘린 그림들을 이어 전체를 찾는다', () => {
    // 벽 3 전체에 가까운 3.6m 창. 가운데(0,0)에서 1.5m 떨어져 있어 한 그림에 다 들어오지 않는다
    const wide: Opening = { type: 'window', wallIndex: 2, from: 0.2, to: 3.8, widthM: 3.6 };
    const detections = detect([wide], views);
    expect(detections.some((d) => d.box_2d[1] === 0 || d.box_2d[3] === 1000)).toBe(true);
    const found = locateDetections(detections, views, CAMERA, ROOM);
    expect(found).toHaveLength(1);
    near(found[0], wide, 0.15);
  });

  it('같은 벽에서 가까이 이어진 창문 조각은 하나로, 멀리 떨어진 창문은 따로', () => {
    const left: Opening = { type: 'window', wallIndex: 2, from: 0.5, to: 1.5, widthM: 1 };
    const close: Opening = { type: 'window', wallIndex: 2, from: 1.8, to: 2.6, widthM: 0.8 };
    const far: Opening = { type: 'window', wallIndex: 2, from: 2.7, to: 3.5, widthM: 0.8 };
    const joined = locateDetections(detect([left, close], views, ROOM, true), views, CAMERA, ROOM);
    expect(joined).toHaveLength(1);
    expect(joined[0].from).toBeCloseTo(0.5, 0);
    expect(joined[0].to).toBeCloseTo(2.6, 0);
    const apart = locateDetections(detect([left, far], views, ROOM, true), views, CAMERA, ROOM);
    expect(apart).toHaveLength(2);
  });

  it('같은 자리를 문으로도 창문으로도 봤으면 더 많이 본 쪽 하나만 남긴다', () => {
    const asDoor = detect([DOOR], views, ROOM, true);
    const asWindow = detect([{ ...DOOR, type: 'window' }], views, ROOM, true).slice(0, 1);
    expect(asDoor.length).toBeGreaterThan(asWindow.length - 1);
    const found = locateDetections([...asWindow, ...asDoor, ...asDoor], views, CAMERA, ROOM);
    expect(found.map((o) => o.type)).toEqual(['door']);
  });

  it('확신이 낮은 것, 없는 그림 번호, 넓이가 없는 상자, 너무 넓은 문은 버린다', () => {
    const good = detect([DOOR], views, ROOM, true)[0];
    expect(locateDetections([{ ...good, confidence: 'low' }], views, CAMERA, ROOM)).toEqual([]);
    expect(locateDetections([{ ...good, imageIndex: 99 }], views, CAMERA, ROOM)).toEqual([]);
    expect(locateDetections([{ ...good, box_2d: [100, 500, 900, 500] }], views, CAMERA, ROOM)).toEqual([]);
    const hugeDoor: Opening = { type: 'door', wallIndex: 2, from: 0.5, to: 3.5, widthM: 3 };
    expect(locateDetections(detect([hugeDoor], views), views, CAMERA, ROOM)).toEqual([]);
    expect(locateDetections([], views, CAMERA, ROOM)).toEqual([]);
  });

  it('결과는 벽 번호·위치 순서이고 서로 겹치지 않는다', () => {
    const second: Opening = { type: 'door', wallIndex: 0, from: 2.6, to: 3.5, widthM: 0.9 };
    const found = locateDetections(detect([WINDOW, second, DOOR], views, ROOM, true), views, CAMERA, ROOM);
    expect(found.map((o) => `${o.type}:${o.wallIndex}:${Math.round(o.from)}`)).toEqual(['door:0:0', 'door:0:3', 'window:2:1']);
  });
});

describe('요청 형식과 지시문', () => {
  const image = { data: `/9j/${'A'.repeat(200)}` };
  const view = { position: [0, 1.5, 0], target: [1, 1.4, 0] };

  it('그림 1~18장, 카메라의 비율과 시야각이 있어야 한다', () => {
    expect(DetectInput.safeParse({ images: [image], views: [view], aspect: 1.78, fovDeg: 60 }).success).toBe(true);
    expect(DetectInput.safeParse({ images: [], views: [], aspect: 1.78, fovDeg: 60 }).success).toBe(false);
    expect(DetectInput.safeParse({ images: Array.from({ length: 19 }, () => image), views: Array.from({ length: 19 }, () => view), aspect: 1.78, fovDeg: 60 }).success).toBe(false);
    expect(DetectInput.safeParse({ images: [image], views: [view], aspect: 0, fovDeg: 60 }).success).toBe(false);
    expect(DetectInput.safeParse({ images: [image], views: [{ position: [0, 1.5], target: [1, 1.4, 0] }], aspect: 1.78, fovDeg: 60 }).success).toBe(false);
  });

  it('지시문: 문과 창문의 뜻, 상자의 형식, 커튼·잘린 것을 다루는 법', () => {
    for (const word of ['box_2d', 'ymin', '커튼', '잘려', 'confidence']) expect(OPENINGS_SYSTEM_PROMPT).toContain(word);
  });
});
