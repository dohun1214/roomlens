// AI 배치 추천 성능 재기: 공개 샘플 방(보정·문창문·원래 가구가 있는 방)마다 정해진 가구 세트와 요청으로
// 실제 Gemini + 솔버(suggestLayout)를 돌려 점수를 낸다. DB에는 아무것도 쓰지 않는다 (AI 횟수도 쓰지 않음).
//   놓은 비율, 배치 검사의 문제(error)·경고 수, 지키지 못한 조건 수, 요청을 지켰는지(규칙으로 판정), 시간·Gemini 호출 수
// 실행: npx tsx --env-file=.env.local --conditions=react-server scripts/dev-data/eval-layout-suggest.mts [--tag 이름] [--only 방이름,…] [--repeat 2]
// 결과: ../roomlens-data/_e2e/eval/results/<tag>-suggest.json + 표
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import { generateJson } from '../../lib/ai/gemini';
import { suggestLayout, type GenerateIntent } from '../../lib/ai/layoutSuggest';
import { LAYOUT_SYSTEM_PROMPT } from '../../lib/ai/prompts';
import { LayoutIntent } from '../../lib/ai/schemas';
import { frontDirection } from '../../lib/layout/accessSide';
import { checkLayout } from '../../lib/layout/check';
import { distanceToSegment } from '../../lib/layout/geometry';
import type { SolverItem } from '../../lib/layout/solver';
import { parseSavedCalibration } from '../../lib/rooms/calibration';
import { fixtureObstacles, parseFixtures } from '../../lib/rooms/fixtures';
import { openingSegment, parseOpenings, type Opening } from '../../lib/rooms/openings';
import type { Point2 } from '../../lib/three/floorDrag';

const { values } = parseArgs({
  options: {
    tag: { type: 'string', default: new Date().toISOString().slice(0, 16).replace(/[:T]/g, '') },
    only: { type: 'string', default: '' },
    repeat: { type: 'string', default: '1' },
  },
});
const dataDir = process.env.ROOMLENS_DATA ?? path.resolve(import.meta.dirname, '../../../roomlens-data');
const resultDir = path.join(dataDir, '_e2e', 'eval', 'results');
mkdirSync(resultDir, { recursive: true });
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });

/** 평가에 쓰는 공개 샘플 방 (짧은 이름 → id) */
const ROOMS: Record<string, string> = {
  studio11: 'c866250f-7f4a-46ef-8b2a-f0e22582d6b5',
  haussmann: 'b0981a51-39d4-4aed-9e10-bd1556561d02',
  bedroom: '31cfd81c-8e95-48fa-94ee-b37895a75e1a',
  sh3: '575bb26e-01a0-4614-bf10-881eaf1fa6da',
  apt07: 'd2c10a6e-2578-4d46-a09c-b54d4b3f6136',
  fireplace: 'abeebfd5-aeef-4d48-8bb0-e81dc553d85d',
  bellevue: 'f2870ed6-bb33-4e54-ab74-27b7d3a84e8e',
  villa09: 'c6ec1a27-ed23-4f8c-ad79-69901ec4a794',
  villa02: '710a3ada-2dd1-4ade-9615-0382229aafb5',
  living: '01a65fef-29cd-4d75-b1fb-6713c9505c86',
};

type Rule = 'desk-window' | 'bed-far-door' | 'tv-facing-sofa' | 'shoe-near-door';
type Scenario = { name: string; refs: string[]; request: string; rules: Rule[]; keepFixtures: boolean };
const SCENARIOS: Scenario[] = [
  { name: '원룸', refs: ['bed-single', 'desk', 'chair', 'wardrobe', 'drawer'], request: '', rules: [], keepFixtures: false },
  { name: '원룸+요청', refs: ['bed-single', 'desk', 'chair', 'wardrobe', 'drawer'], request: '책상은 창가에 두고, 침대는 문에서 먼 쪽에 둬 줘', rules: ['desk-window', 'bed-far-door'], keepFixtures: false },
  { name: '거실+요청', refs: ['sofa', 'coffee-table', 'tv-stand', 'bookcase', 'floor-lamp'], request: 'TV장은 소파 맞은편 벽에 두고 싶어', rules: ['tv-facing-sofa'], keepFixtures: false },
  { name: '있는 방에 더하기', refs: ['desk', 'chair', 'bookcase', 'shoe-cabinet'], request: '신발장은 문 가까이', rules: ['shoe-near-door'], keepFixtures: true },
];

const { data: catalogRows, error: catalogError } = await admin.from('furniture_catalog').select('id, name_ko, category, width_m, depth_m, height_m, clearance_m');
if (catalogError) throw catalogError;
const catalog = new Map(catalogRows!.map((r) => [r.id, r]));

const generate: GenerateIntent = async (prompt) => {
  const { data, inputTokens, outputTokens } = await generateJson(LayoutIntent, { system: LAYOUT_SYSTEM_PROMPT, parts: [{ text: prompt }] });
  return { intent: data, inputTokens, outputTokens };
};

const center = (seg: [Point2, Point2]): Point2 => [(seg[0][0] + seg[1][0]) / 2, (seg[0][1] + seg[1][1]) / 2];
const dist = (a: Point2, b: Point2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const segmentsOf = (openings: Opening[], polygon: Point2[], type: Opening['type']) =>
  openings.filter((o) => o.type === type).flatMap((o) => {
    const s = openingSegment(o, polygon);
    return s ? [s] : [];
  });

/** 요청을 지켰는지 (판정할 수 없으면 null) */
function judge(rule: Rule, placed: { category: string; name: string; x: number; z: number; rotationDeg: number }[], polygon: Point2[], openings: Opening[]): boolean | null {
  const windows = segmentsOf(openings, polygon, 'window');
  const doors = segmentsOf(openings, polygon, 'door');
  const find = (name: string) => placed.find((p) => p.name === name);
  if (rule === 'desk-window') {
    const desk = find('책상');
    if (!desk || windows.length === 0) return null;
    return Math.min(...windows.map((w) => distanceToSegment([desk.x, desk.z], w[0], w[1]))) <= 1.0;
  }
  if (rule === 'bed-far-door') {
    const bed = find('싱글 침대');
    if (!bed || doors.length === 0) return null;
    const door = center(doors[0]);
    // 문에서 가장 먼 꼭짓점까지의 거리에 견줘 절반 이상 떨어졌으면 지킨 것으로 본다
    const far = Math.max(...polygon.map((p) => dist(p, door)));
    return Math.min(...doors.map((d) => dist([bed.x, bed.z], center(d)))) >= far * 0.5;
  }
  if (rule === 'tv-facing-sofa') {
    const tv = find('TV장');
    const sofa = find('소파');
    if (!tv || !sofa) return null;
    const faces = (from: { x: number; z: number; rotationDeg: number }, to: { x: number; z: number }) => {
      const f = frontDirection(from.rotationDeg);
      const v: Point2 = [to.x - from.x, to.z - from.z];
      const len = Math.hypot(v[0], v[1]) || 1;
      return (f[0] * v[0] + f[1] * v[1]) / len > Math.cos((50 * Math.PI) / 180);
    };
    return faces(tv, sofa) && faces(sofa, tv);
  }
  if (rule === 'shoe-near-door') {
    const shoe = find('신발장');
    if (!shoe || doors.length === 0) return null;
    return Math.min(...doors.map((d) => distanceToSegment([shoe.x, shoe.z], d[0], d[1]))) <= 1.5;
  }
  return null;
}

const only = values.only ? values.only.split(',') : Object.keys(ROOMS);
const repeat = Math.max(1, Number(values.repeat) || 1);
const rows: Record<string, unknown>[] = [];
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

for (const roomName of only) {
  const { data: room } = await admin.from('rooms').select('id, transform, floor_polygon, openings, fixtures').eq('id', ROOMS[roomName]).maybeSingle();
  const calibration = room && parseSavedCalibration(room.transform, room.floor_polygon);
  if (!room || !calibration) {
    log('SKIP', roomName);
    continue;
  }
  const polygon = calibration.floorPolygon;
  const openings = parseOpenings(room.openings, polygon);
  const allFixtures = parseFixtures(room.fixtures, polygon);
  for (const scenario of SCENARIOS) {
    for (let r = 0; r < repeat; r += 1) {
      const fixtures = scenario.keepFixtures ? fixtureObstacles(allFixtures) : [];
      const items: SolverItem[] = scenario.refs.map((ref, i) => {
        const row = catalog.get(ref)!;
        return { id: `f${i + 1}`, name: row.name_ko, category: row.category, w: Number(row.width_m), d: Number(row.depth_m), h: Number(row.height_m), clearance: Number(row.clearance_m) };
      });
      const t0 = Date.now();
      let row: Record<string, unknown>;
      try {
        const s = await suggestLayout({ polygon, openings, fixtures }, items, scenario.request, generate);
        const placedFull = s.placed.map((p) => ({ ...p, h: p.h }));
        const violations = checkLayout(placedFull, polygon, openings, fixtures);
        const errors = violations.filter((v) => v.severity === 'error');
        const warnings = violations.filter((v) => v.severity === 'warning');
        const judged = scenario.rules.map((rule) => judge(rule, s.placed, polygon, openings)).filter((v): v is boolean => v !== null);
        row = {
          room: roomName,
          scenario: scenario.name,
          placed: s.placed.length / items.length,
          errors: errors.length,
          warnings: warnings.length,
          unmet: s.unmet.length,
          request: judged.length ? judged.filter(Boolean).length / judged.length : null,
          attempts: s.attempts,
          seconds: (Date.now() - t0) / 1000,
          tokens: s.inputTokens + s.outputTokens,
          errorMessages: errors.map((v) => v.message),
          warningMessages: warnings.map((v) => v.message),
          unmetMessages: s.unmet.map((u) => u.message),
          failures: s.failures.map((f) => f.message),
          summary: s.summary,
          placements: s.placed.map((p) => ({ name: p.name, x: p.x, z: p.z, rotationDeg: p.rotationDeg, reason: p.reason })),
        };
      } catch (err) {
        row = { room: roomName, scenario: scenario.name, error: String(err).slice(0, 300), seconds: (Date.now() - t0) / 1000 };
      }
      rows.push(row);
      log(roomName, scenario.name, row.error ? `ERROR ${row.error}` : `놓음 ${Math.round(Number(row.placed) * 100)}% 문제 ${row.errors} 경고 ${row.warnings} 못지킴 ${row.unmet} 요청 ${row.request ?? '-'} ${Number(row.seconds).toFixed(1)}초 ${row.attempts}회`);
    }
  }
}

// 묶어서
const ok = rows.filter((r) => !r.error);
const avg = (key: string, list = ok) => {
  const vals = list.map((r) => r[key]).filter((v): v is number => typeof v === 'number');
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
};
const byScenario = Object.fromEntries(
  SCENARIOS.map((s) => {
    const list = ok.filter((r) => r.scenario === s.name);
    return [s.name, { n: list.length, placed: avg('placed', list), errors: avg('errors', list), warnings: avg('warnings', list), unmet: avg('unmet', list), request: avg('request', list), seconds: avg('seconds', list) }];
  }),
);
const totals = {
  runs: rows.length,
  failedRuns: rows.length - ok.length,
  placed: avg('placed'),
  errors: avg('errors'),
  cleanRuns: ok.filter((r) => r.errors === 0 && r.placed === 1).length / Math.max(1, ok.length),
  warnings: avg('warnings'),
  unmet: avg('unmet'),
  request: avg('request'),
  seconds: avg('seconds'),
  attempts: avg('attempts'),
  tokens: avg('tokens'),
};
writeFileSync(path.join(resultDir, `${values.tag}-suggest.json`), JSON.stringify({ tag: values.tag, totals, byScenario, rows }, null, 1));
console.table(byScenario);
console.log('전체', JSON.stringify(totals));
