import { describe, expect, it } from 'vitest';
import { toBox, toSegmentBoxes } from '@/lib/ai/segment';
import { describeFixture, MIN_SEGMENT_KEEP, projectToView, SEGMENT_IMAGE, SEGMENT_VIEWS, segmentViews, trustSegment, voteSegment, type Box2d, type SegmentBoxes } from '@/lib/rooms/fixtureSegment';

const box = { x: 1, z: -0.5, w: 1.2, d: 1.2, rotationDeg: 30 };

/** 가로·세로·높이 범위를 2cm 간격으로 채운 점 (방 좌표) */
const cube = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): number[][] => {
  const out: number[][] = [];
  for (let x = x0; x <= x1 + 1e-9; x += 0.02) for (let y = y0; y <= y1 + 1e-9; y += 0.02) for (let z = z0; z <= z1 + 1e-9; z += 0.02) out.push([x, y, z]);
  return out;
};

/** 점들을 시점에 투영해 감싸는 상자 (AI가 돌려줄 상자 대신, [ymin, xmin, ymax, xmax] 0~1000) */
const boxOf = (view: ReturnType<typeof segmentViews>[number], pts: number[][]): Box2d => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y, z] of pts) {
    const hit = projectToView(view, x, y, z);
    if (!hit) continue;
    x0 = Math.min(x0, hit[0]);
    x1 = Math.max(x1, hit[0]);
    y0 = Math.min(y0, hit[1]);
    y1 = Math.max(y1, hit[1]);
  }
  const k = 1000 / SEGMENT_IMAGE;
  return [y0 * k, x0 * k, y1 * k, x1 * k];
};

describe('segmentViews · projectToView', () => {
  it('가구 둘레 네 방향에서 내려다보고, 가구 가운데가 그림 가운데에 온다', () => {
    const views = segmentViews(box, 0.9);
    expect(views).toHaveLength(SEGMENT_VIEWS);
    for (const view of views) {
      expect(view.position[1]).toBeGreaterThan(0.45);
      const hit = projectToView(view, box.x, 0.45, box.z)!;
      expect(hit[0]).toBeCloseTo(SEGMENT_IMAGE / 2, 3);
      expect(hit[1]).toBeCloseTo(SEGMENT_IMAGE / 2, 3);
      // 상자 모서리 위아래도 그림 안에 들어온다
      for (const [x, y, z] of [
        [box.x + 0.6, 0, box.z + 0.6],
        [box.x - 0.6, 0.9, box.z - 0.6],
      ]) {
        const corner = projectToView(view, x, y, z)!;
        expect(corner[0]).toBeGreaterThan(0);
        expect(corner[0]).toBeLessThan(SEGMENT_IMAGE);
        expect(corner[1]).toBeGreaterThan(0);
        expect(corner[1]).toBeLessThan(SEGMENT_IMAGE);
      }
    }
    // 위에 있는 점은 그림 위쪽(작은 y)에 온다
    const v = views[0];
    expect(projectToView(v, box.x, 0.9, box.z)![1]).toBeLessThan(projectToView(v, box.x, 0, box.z)![1]);
  });
});

describe('voteSegment', () => {
  const chair = cube(0.75, 1.25, 0.05, 0.8, -0.75, -0.25);
  const lamp = cube(1.3, 1.36, 0.05, 1.3, -0.3, -0.24); // 의자 옆면에 붙은 가는 스탠드
  const vase = cube(0.95, 1.05, 0.82, 1.1, -0.55, -0.45); // 의자 위에 얹힌 꽃병 (가구 상자 위로 솟음)
  const all = [...chair, ...lamp, ...vase];
  const points = new Float32Array(all.flat());
  const views = segmentViews(box, 1.3);
  const count = (keep: Uint8Array, from: number, len: number) => Array.from(keep.slice(from, from + len)).filter(Boolean).length;

  it('가구 상자 밖으로 삐져나온 옆 스탠드는 빼고, 가구와 얹힌 물건은 남긴다', () => {
    const boxes: SegmentBoxes[] = views.map((v) => ({ target: [boxOf(v, chair)], onTop: [boxOf(v, vase)], separate: [boxOf(v, lamp)] }));
    const vote = voteSegment(points, new Uint8Array(all.length).fill(1), views, boxes);
    expect(count(vote.keep, 0, chair.length)).toBe(chair.length);
    expect(count(vote.keep, chair.length + lamp.length, vase.length)).toBe(vase.length);
    expect(count(vote.keep, chair.length, lamp.length)).toBeLessThan(lamp.length * 0.3);
    expect(vote.usedViews).toBe(SEGMENT_VIEWS);
    expect(trustSegment(vote)).toBe(true);
  });
  it('후보가 아닌 것은 그대로 빼고, 가구를 못 찾은 시점은 세지 않는다', () => {
    const candidate = new Uint8Array(all.length).fill(1);
    candidate[0] = 0;
    const empty: SegmentBoxes = { target: [], onTop: [], separate: [] };
    const vote = voteSegment(points, candidate, views, [{ target: [boxOf(views[0], chair)], onTop: [], separate: [] }, empty, empty, empty]);
    expect(vote.keep[0]).toBe(0);
    expect(vote.usedViews).toBe(1);
    expect(trustSegment(vote)).toBe(false); // 시점 하나로는 믿지 않는다
  });
  it('너무 적게 남기면 믿지 않는다', () => {
    expect(trustSegment({ keep: new Uint8Array(0), usedViews: 4, keptShare: MIN_SEGMENT_KEEP - 0.01 })).toBe(false);
    expect(trustSegment({ keep: new Uint8Array(0), usedViews: 3, keptShare: 0.9 })).toBe(true);
  });
});

describe('AI 상자 읽기', () => {
  it('숫자 4개짜리만, 0~1000 안으로, 뒤집힌 순서는 바로잡는다', () => {
    expect(toBox([100, 200, 300, 400])).toEqual([100, 200, 300, 400]);
    expect(toBox([300, 400, 100, 200])).toEqual([100, 200, 300, 400]);
    expect(toBox([-20, 0, 1200, 500])).toEqual([0, 0, 1000, 500]);
    expect(toBox([1, 2, 3])).toBeNull();
    expect(toBox([100, 100, 100, 400])).toBeNull();
  });
  it('역할별로 나누고, 알 수 없는 역할은 따로 선 물건으로 본다', () => {
    const out = toSegmentBoxes({
      boxes: [
        { box_2d: [100, 100, 800, 700], label: 'armchair', role: 'target' },
        { box_2d: [150, 300, 300, 500], label: 'pillow', role: 'On-top' },
        { box_2d: [200, 650, 900, 950], label: 'side table', role: 'separate' },
        { box_2d: [0, 0, 100, 100], label: 'wall', role: 'background' },
      ],
    });
    expect(out.target).toHaveLength(1);
    expect(out.onTop).toHaveLength(1);
    expect(out.separate).toHaveLength(2);
  });
});

describe('describeFixture', () => {
  it('알려진 이름은 영어 설명을 붙이고, 고친 이름은 그대로 쓴다', () => {
    expect(describeFixture('의자', 0.95, 0.99, 0.8)).toBe('의자 (chair or armchair), about 95 × 99 cm footprint, 80 cm tall');
    expect(describeFixture(' 흔들의자 ', 0.7, 0.9, 1)).toBe('흔들의자, about 70 × 90 cm footprint, 100 cm tall');
  });
});
