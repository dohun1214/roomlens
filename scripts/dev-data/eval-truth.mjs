// 방 준비 성능을 잴 정답 파일을 만든다 → ../roomlens-data/_e2e/eval/truth/<이름>.json
//   InteriorGS 장면: structure.json(방 모양·문·창문)과 labels.json(가구 상자). 장면 좌표가 곧 방 좌표(m, 바닥 y=0)
//   샘플 방: seed-all/final/<slug>.json (사람이 그림을 보며 고친 보정·문창문·원래 가구)
// 실행: node scripts/dev-data/eval-truth.mjs igs 0056_839909 0177_840100 …   /   node scripts/dev-data/eval-truth.mjs samples
// 정답 파일: { name, kind, file(데이터 폴더 기준), frame: { transform, flipX }, polygon, openings: [{ type, a, b }], fixtures: [{ label, x, z, w, d, rotationDeg, h }] }
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from './e2e-common.mjs';
import { openingSegments } from '../../lib/eval/roomPrepScore.ts';
import { pointInPolygon } from '../../lib/three/floorDrag.ts';
import { distanceToPolygon } from '../../lib/layout/geometry.ts';

const outDir = path.join(dataDir, '_e2e', 'eval', 'truth');
mkdirSync(outDir, { recursive: true });
const r3 = (v) => Math.round(v * 1000) / 1000 + 0;
const [kind, ...names] = process.argv.slice(2);

// InteriorGS 가구 이름 → 앱의 이름 (앞의 것부터 맞춘다)
const LABELS = [
  [/bedside|nightstand|night stand/, '수납장'],
  [/bed/, '침대'],
  [/sofa|couch/, '소파'],
  [/tv.?(cabinet|stand)|media/, 'TV장'],
  [/dining.?table/, '식탁'],
  [/desk/, '책상'],
  [/table/, '테이블'],
  [/chair|stool|bench/, '의자'],
  [/wardrobe|closet/, '옷장'],
  [/book.?(case|shelf)|shelf|shelves/, '책장'],
  [/refrigerator|fridge/, '냉장고'],
  [/washing machine|^washer/, '세탁기'],
  [/cabinet|sideboard|drawer|dresser|chest|shoe|storage|counter|locker/, '수납장'],
];
// 정답에서 뺄 것: 바닥 가구가 아닌 것
const SKIP = /door|window|plant|curtain|carpet|rug|lamp|book$|books|painting|picture|frame|mirror|decor|chandelier|light|pillow|cushion|towel|clothes|toy|bag|box|vase|ornament|cup|bottle|plate|bowl|kettle|laptop|computer|monitor|tv$|television|speaker|clock|blanket|basket|sculpture|candle|tray|appliance|air.?condition|radiator|switch|socket|pen.?holder|trash|wall design|exhibition wall|streaming/i;
const labelOf = (name) => LABELS.find(([re]) => re.test(name.toLowerCase()))?.[1] ?? '가구';

const IDENTITY = { transform: { s: 1, q: [0, 0, 0, 1], t: [0, 0, 0] }, flipX: false };

if (kind === 'igs') {
  for (const scene of names) {
    const dir = path.join(dataDir, 'interiorgs', scene);
    const structure = JSON.parse(readFileSync(path.join(dir, 'structure.json'), 'utf8'));
    const polygon = structure.rooms[0].profile.map(([x, y]) => [r3(x), r3(-y)]);
    // 문·창문: 구멍의 바닥 쪽 두 점. 이 방의 벽 위에 있는 것만
    const openings = (structure.holes ?? []).flatMap((h) => {
      const pts = h.profile.map(([x, y]) => [r3(x), r3(-y)]);
      const xs = pts.map((p) => p[0]);
      const zs = pts.map((p) => p[1]);
      const horizontal = Math.max(...xs) - Math.min(...xs) >= Math.max(...zs) - Math.min(...zs);
      const a = horizontal ? [Math.min(...xs), (Math.min(...zs) + Math.max(...zs)) / 2] : [(Math.min(...xs) + Math.max(...xs)) / 2, Math.min(...zs)];
      const b = horizontal ? [Math.max(...xs), a[1]] : [a[0], Math.max(...zs)];
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (distanceToPolygon(mid, polygon) > (h.thickness ?? 0.24) + 0.1) return [];
      return [{ type: h.type === 'WINDOW' ? 'window' : 'door', a, b }];
    });
    const labels = JSON.parse(readFileSync(path.join(dir, 'labels.json'), 'utf8'));
    const fixtures = labels
      .filter((o) => o.bounding_box && !SKIP.test(o.label))
      .map((o) => {
        const xs = o.bounding_box.map((p) => p.x);
        const zs = o.bounding_box.map((p) => -p.y);
        const hs = o.bounding_box.map((p) => p.z);
        const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
        return { name: o.label, label: labelOf(o.label), x: r3((x0 + x1) / 2), z: r3((z0 + z1) / 2), w: r3(x1 - x0), d: r3(z1 - z0), rotationDeg: 0, h: r3(Math.max(...hs)), bottom: Math.min(...hs) };
      })
      .filter((f) => f.bottom < 0.15 && f.w * f.d >= 0.09 && f.h >= 0.25 && pointInPolygon([f.x, f.z], polygon))
      .map((f) => {
        delete f.bottom;
        return f;
      });
    const truth = { name: scene, kind: 'igs', file: `converted/${scene}.sog`, frame: IDENTITY, polygon, openings, fixtures };
    writeFileSync(path.join(outDir, `${scene}.json`), JSON.stringify(truth, null, 1));
    console.log(scene, `모서리 ${polygon.length}, 문·창문 ${openings.length}, 가구 ${fixtures.length}`);
  }
} else if (kind === 'samples') {
  const seedDir = path.join(dataDir, '_e2e', 'seed-all');
  const list = JSON.parse(readFileSync(path.join(seedDir, 'seed-list.json'), 'utf8'));
  for (const item of list) {
    if (names.length && !names.includes(item.slug)) continue;
    const final = JSON.parse(readFileSync(path.join(seedDir, 'final', `${item.slug}.json`), 'utf8'));
    const { flipX = false, ...transform } = final.transform;
    const truth = {
      name: item.slug,
      kind: 'sample',
      file: item.file,
      frame: { transform, flipX },
      polygon: final.floor_polygon,
      openings: openingSegments(final.openings, final.floor_polygon),
      fixtures: final.fixtures.map((f) => ({ label: f.label, x: f.x, z: f.z, w: f.w, d: f.d, rotationDeg: f.rotationDeg, h: f.h })),
    };
    writeFileSync(path.join(outDir, `${item.slug}.json`), JSON.stringify(truth, null, 1));
    console.log(item.slug, `모서리 ${truth.polygon.length}, 문·창문 ${truth.openings.length}, 가구 ${truth.fixtures.length}`);
  }
} else {
  console.log('사용: eval-truth.mjs igs <장면…> | samples [slug…]');
}
