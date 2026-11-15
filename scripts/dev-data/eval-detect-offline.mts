// 문·창문·원래 가구 찾기를 브라우저 없이 다시 재기. eval-room-prep.mjs --save-views 로 남긴 캡처 그림(eval/views/<이름>/)에
// Gemini를 직접 불러 답을 eval/views/<이름>/<도구>-raw-<n>.json 으로 남기고(이미 있으면 다시 쓴다), 서버와 같은 계산으로 후보를 만들어 정답과 비교한다.
// 그래서 후보를 만드는 계산(locateWallDetections·locateFixtures)을 고친 것은 Gemini를 다시 부르지 않고 바로 비교할 수 있다.
// DB·AI 횟수는 쓰지 않는다. 정답 보정(정답 평면도) 위에서 잰다 (eval-room-prep --mode detect 와 같다).
// 실행: npx tsx --env-file=.env.local --conditions=react-server scripts/dev-data/eval-detect-offline.mts
//        [--tool openings|fixtures] [--only 이름,…] [--repeat 2] [--fresh] [--tag 이름] [--list]
//   --repeat n : Gemini 답을 n개까지 받아 각각 재고 평균을 낸다 (답이 매번 조금씩 다르다)
//   --fresh    : 남긴 답을 쓰지 않고 새로 받는다 (프롬프트를 고쳤을 때)
//   --list     : 장면마다 맞힌 것·틀린 것을 자세히 보여 준다
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DetectedFixtures, locateFixtures, topViewPlan } from '../../lib/ai/fixturesDetect';
import { generateJson } from '../../lib/ai/gemini';
import { FIXTURES_SYSTEM_PROMPT, WALL_OPENINGS_SYSTEM_PROMPT } from '../../lib/ai/prompts';
import { DetectedWallOpenings, locateWallDetections, wallViewPlan } from '../../lib/ai/wallViews';
import { mapFixture, openingSegments, scoreFixtures, scoreOpenings, segmentOverlap, type FixtureBox, type OpeningSegment } from '../../lib/eval/roomPrepScore';
import type { Point2 } from '../../lib/three/floorDrag';

const { values } = parseArgs({
  options: {
    tool: { type: 'string', default: 'openings' },
    only: { type: 'string', default: '' },
    repeat: { type: 'string', default: '1' },
    fresh: { type: 'boolean', default: false },
    tag: { type: 'string', default: '' },
    list: { type: 'boolean', default: false },
  },
});
const tool = values.tool as 'openings' | 'fixtures';
if (tool !== 'openings' && tool !== 'fixtures') throw new Error(`모르는 --tool: ${tool}`);
const dataDir = process.env.ROOMLENS_DATA ?? path.resolve(import.meta.dirname, '../../../roomlens-data');
const evalDir = path.join(dataDir, '_e2e', 'eval');
const viewsDir = path.join(evalDir, 'views');
const only = values.only ? values.only.split(',') : [];
const repeat = Math.max(1, Number(values.repeat) || 1);

type Truth = { name: string; kind: string; polygon: Point2[]; openings: OpeningSegment[]; fixtures: FixtureBox[] };
const truths = new Map<string, Truth>(
  readdirSync(path.join(evalDir, 'truth'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(path.join(evalDir, 'truth', f), 'utf8')) as Truth)
    .map((t) => [t.name, t]),
);
const scenes = readdirSync(viewsDir)
  .filter((name) => existsSync(path.join(viewsDir, name, `${tool}.json`)) && truths.has(name))
  .filter((name) => only.length === 0 || only.includes(name))
  .sort();

/** n번째 Gemini 답. 남겨 둔 것이 있으면 그것을 쓴다 */
async function raw(name: string, n: number, body: { images: { data: string }[] }): Promise<unknown> {
  const file = path.join(viewsDir, name, `${tool}-raw-${n}.json`);
  if (!values.fresh && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const parts = body.images.map((image) => ({ inlineData: { mimeType: 'image/jpeg', data: image.data } }));
  const generated =
    tool === 'openings'
      ? await generateJson(DetectedWallOpenings, {
          system: WALL_OPENINGS_SYSTEM_PROMPT,
          parts: [...parts, { text: `벽 정면 그림 ${parts.length}장에서 문과 창문을 찾아라.` }],
          timeoutMs: 90_000,
        })
      : await generateJson(DetectedFixtures, {
          system: FIXTURES_SYSTEM_PROMPT,
          parts: [...parts, { text: parts.length === 1 ? '이 그림에서 바닥에 놓인 가구를 모두 찾아라.' : `그림 ${parts.length}장에서 바닥에 놓인 가구를 모두 찾아라.` }],
          timeoutMs: 90_000,
        });
  writeFileSync(file, JSON.stringify(generated.data, null, 1));
  return generated.data;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const fmtSeg = (s: OpeningSegment) => `${s.type} (${r2(s.a[0])},${r2(s.a[1])})-(${r2(s.b[0])},${r2(s.b[1])}) ${r2(Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]))}m`;
const total = { truth: 0, pred: 0, matched: 0, sameType: 0, runs: 0 };
const rows: unknown[] = [];
for (const name of scenes) {
  const truth = truths.get(name)!;
  const body = JSON.parse(readFileSync(path.join(viewsDir, name, `${tool}.json`), 'utf8')) as { images: { data: string }[]; ceiling?: number };
  for (let n = 1; n <= repeat; n += 1) {
    let data: unknown;
    try {
      data = await raw(name, n, body);
    } catch (err) {
      console.log(name, n, '실패', String(err).slice(0, 200));
      continue;
    }
    let score;
    if (tool === 'openings') {
      const plan = wallViewPlan(truth.polygon, body.ceiling ?? 2.5);
      const parsed = DetectedWallOpenings.parse(data);
      const pred = openingSegments(locateWallDetections(parsed.openings, plan, truth.polygon), truth.polygon);
      score = scoreOpenings(pred, truth.openings);
      if (values.list) {
        console.log(`## ${name} #${n} 답 ${parsed.openings.length}개 → 후보 ${pred.length} / 정답 ${truth.openings.length}`);
        for (const p of pred) {
          const best = Math.max(0, ...truth.openings.map((t) => segmentOverlap(p, t)));
          console.log(`   ${best >= 0.3 ? 'O' : 'X'} ${fmtSeg(p)}`);
        }
        for (const t of truth.openings) if (!pred.some((p) => segmentOverlap(p, t) >= 0.3)) console.log(`   놓침 ${fmtSeg(t)}`);
      }
    } else {
      const parsed = DetectedFixtures.parse(data);
      const pred = locateFixtures(parsed.fixtures, topViewPlan(truth.polygon), truth.polygon).map((f) => mapFixture(f, (p) => p, 1));
      score = scoreFixtures(pred, truth.fixtures);
      if (values.list) {
        console.log(`## ${name} #${n} 답 ${parsed.fixtures.length}개 → 후보 ${pred.length} / 정답 ${truth.fixtures.length}`);
        for (const p of pred) console.log(`   ${p.label} (${r2(p.x)},${r2(p.z)}) ${r2(p.w)}×${r2(p.d)}`);
        for (const t of truth.fixtures) console.log(`   정답 ${t.label} (${r2(t.x)},${r2(t.z)}) ${r2(t.w)}×${r2(t.d)}`);
      }
    }
    total.truth += score.truth;
    total.pred += score.pred;
    total.matched += score.matched;
    total.sameType += score.typeAccuracy * score.matched;
    total.runs += 1;
    rows.push({ name, kind: truth.kind, n, score });
    if (!values.list) console.log(name.padEnd(18), `#${n}`, `정답 ${score.truth} 후보 ${score.pred} 맞음 ${score.matched}`);
  }
}
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const summary = { scenes: scenes.length, runs: total.runs, recall: r3(total.matched / total.truth), precision: r3(total.matched / total.pred), type: r3(total.sameType / total.matched) };
console.log(tool, JSON.stringify(summary));
if (values.tag) {
  const out = path.join(evalDir, 'results', `${values.tag}-${tool}-offline.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ tool, at: new Date().toISOString(), summary, rows }, null, 1));
}
