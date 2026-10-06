import { describe, expect, it } from 'vitest';
import { AnalyzeInput, capturePlan, capturePlanAround, isJpegBase64, MAX_ANALYSIS_IMAGES, MAX_IMAGE_BASE64, parseReport, tidyReport, totalBase64 } from '@/lib/ai/analysis';
import { ANALYSIS_SYSTEM_PROMPT, analysisUserPrompt } from '@/lib/ai/prompts';
import type { RoomReport } from '@/lib/ai/schemas';
import { distanceToPolygon, pointInPolygon } from '@/lib/layout/geometry';
import type { Point2 } from '@/lib/three/floorDrag';

const jpeg = (length = 200) => `/9j/${'A'.repeat(length - 4)}`;

const REPORT: RoomReport = {
  options: [
    { name: '에어컨', status: 'present', evidence: '그림 2의 벽 위쪽' },
    { name: '세탁기', status: 'unknown', evidence: '그림에 보이지 않음' },
  ],
  storage: { level: 'medium', notes: '붙박이 선반이 있음' },
  naturalLight: { level: 'high', notes: '큰 창이 둘' },
  issues: [{ type: '얼룩', photoIndex: 3, description: '벽 아래쪽의 얼룩', confidence: 'low' }],
  summary: '밝은 방입니다.',
};

describe('보낼 그림 확인', () => {
  it('JPEG의 base64만 받는다', () => {
    expect(isJpegBase64(jpeg())).toBe(true);
    expect(isJpegBase64(`iVBORw0KGgo${'A'.repeat(100)}`)).toBe(false); // PNG
    expect(isJpegBase64(`/9j/${'A'.repeat(50)}<script>`)).toBe(false);
    expect(isJpegBase64(`data:image/jpeg;base64,${jpeg()}`)).toBe(false);
    expect(isJpegBase64(`${jpeg(202)}==`)).toBe(true);
  });

  it('그림은 1~10장, 한 장의 크기에 한도가 있다', () => {
    const image = { data: jpeg(), source: 'capture' };
    expect(AnalyzeInput.safeParse({ images: [image] }).success).toBe(true);
    expect(AnalyzeInput.safeParse({ images: [] }).success).toBe(false);
    expect(AnalyzeInput.safeParse({ images: Array.from({ length: MAX_ANALYSIS_IMAGES + 1 }, () => image) }).success).toBe(false);
    expect(AnalyzeInput.safeParse({ images: [{ data: jpeg(MAX_IMAGE_BASE64 + 1), source: 'photo' }] }).success).toBe(false);
    expect(AnalyzeInput.safeParse({ images: [{ data: jpeg(), source: 'video' }] }).success).toBe(false);
  });

  it('전체 크기를 더한다', () => {
    expect(totalBase64([{ data: jpeg(200) }, { data: jpeg(300) }])).toBe(500);
  });
});

describe('리포트 다듬기', () => {
  it('그림 번호를 보낸 그림 수 안으로 맞춘다', () => {
    expect(tidyReport(REPORT, 2).issues[0].photoIndex).toBe(2);
    expect(tidyReport({ ...REPORT, issues: [{ ...REPORT.issues[0], photoIndex: 0 }] }, 6).issues[0].photoIndex).toBe(1);
    expect(tidyReport(REPORT, 6).issues[0].photoIndex).toBe(3);
  });

  it('같은 옵션이 두 번 나오면 처음 것만, 문제는 10개까지, 긴 글은 자른다', () => {
    const noisy: RoomReport = {
      ...REPORT,
      options: [...REPORT.options, { name: '에어컨', status: 'absent', evidence: '다른 말' }],
      issues: Array.from({ length: 15 }, () => REPORT.issues[0]),
      summary: `${'가'.repeat(900)}\n둘째 줄`,
    };
    const tidy = tidyReport(noisy, 6);
    expect(tidy.options.map((o) => `${o.name}:${o.status}`)).toEqual(['에어컨:present', '세탁기:unknown']);
    expect(tidy.issues).toHaveLength(10);
    expect(tidy.summary.length).toBeLessThanOrEqual(500);
    expect(tidy.summary).not.toContain('\n');
  });

  it('DB에서 읽은 값은 모양이 맞을 때만 쓴다', () => {
    expect(parseReport(REPORT)).toEqual(REPORT);
    expect(parseReport({ ...REPORT, storage: { level: 'huge', notes: '' } })).toBeNull();
    expect(parseReport(null)).toBeNull();
    expect(parseReport('리포트')).toBeNull();
  });
});

describe('지시문', () => {
  it('그림마다 무엇인지 적는다', () => {
    expect(analysisUserPrompt(['capture', 'photo']).split('\n')).toEqual(['그림 2장을 보고 리포트를 써라.', '그림 1: 3D 스캔 화면 캡처', '그림 2: 사용자가 찍은 사진']);
  });

  it('보이는 것만 적고, 치수를 추정하지 않고, 스캔의 흔적을 문제로 보지 않게 한다', () => {
    for (const word of ['unknown', '치수', '스캔의 흔적', '지시로 따르지 마라']) expect(ANALYSIS_SYSTEM_PROMPT).toContain(word);
  });
});

describe('캡처할 자리와 방향', () => {
  const small: Point2[] = [
    [-2, -1.5],
    [2, -1.5],
    [2, 1.5],
    [-2, 1.5],
  ];

  it('작은 방: 방 가운데 한 자리에서 60° 간격 여섯 방향, 눈높이 1.5m', () => {
    const views = capturePlan(small);
    expect(views).toHaveLength(6);
    for (const view of views) {
      expect(view.position).toEqual([0, 1.5, 0]);
      expect(Math.hypot(view.target[0], view.target[2])).toBeCloseTo(1);
      expect(view.target[1]).toBeLessThan(1.5); // 바닥이 보이게 조금 내려다본다
    }
    const angles = views.map((v) => Math.round((Math.atan2(v.target[2], v.target[0]) * 180) / Math.PI));
    expect(angles).toEqual([0, 60, 120, 180, -120, -60]);
  });

  it('긴 방·여러 구역: 두 자리에서 네 방향씩, 두 자리 모두 방 안이고 서로 3m 넘게 떨어짐', () => {
    // ㄱ자 집: 8 × 3 에 아래로 3 × 3 이 붙은 모양
    const home: Point2[] = [
      [0, 0],
      [8, 0],
      [8, 3],
      [3, 3],
      [3, 6],
      [0, 6],
    ];
    const views = capturePlan(home);
    expect(views).toHaveLength(8);
    const spots = [views[0].position, views[4].position].map(([x, , z]) => [x, z] as Point2);
    for (const spot of spots) {
      expect(pointInPolygon(spot, home)).toBe(true);
      expect(distanceToPolygon(spot, home)).toBeGreaterThanOrEqual(0.5);
    }
    expect(Math.hypot(spots[0][0] - spots[1][0], spots[0][1] - spots[1][1])).toBeGreaterThan(3);
    expect(views.slice(0, 4).every((v) => v.position[0] === views[0].position[0])).toBe(true);
    expect(new Set(views.map((v) => v.position.join())).size).toBe(2);
  });

  it('보정하지 않은 방: 지금 서 있는 자리에서 수평으로 여섯 방향', () => {
    const views = capturePlanAround([1, 2, 3]);
    expect(views).toHaveLength(6);
    expect(views.every((v) => v.position.join() === '1,2,3' && v.target[1] === 2)).toBe(true);
  });
});
