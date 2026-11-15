// 사용 기록 요약: 날마다 방문자 수, 홈·방 조회, 가구를 놓아 본 방 화면 수, 저장한 배치, AI 사용 횟수.
// 시험 계정(e2e-*@roomlens.test)과 개발자 계정(USAGE_EXCLUDE_EMAILS, 쉼표로)의 배치·AI 사용은 뺀다.
// 실행: node --env-file=.env.local scripts/dev-data/usage-report.mjs [--since 2026-11-16] [--until 2026-11-24]
import { parseArgs } from 'node:util';
import { createClient } from '@supabase/supabase-js';

const { values } = parseArgs({ options: { since: { type: 'string', default: '2026-11-16' }, until: { type: 'string', default: '' } } });
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const from = new Date(`${values.since}T00:00:00+09:00`).toISOString();
const to = values.until ? new Date(`${values.until}T24:00:00+09:00`).toISOString() : new Date().toISOString();
/** 한국 날짜 (YYYY-MM-DD) */
const day = (iso) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 10);

async function all(table, columns) {
  const rows = [];
  for (let page = 0; ; page += 1) {
    const { data, error } = await admin.from(table).select(columns).gte('created_at', from).lt('created_at', to).range(page * 1000, page * 1000 + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
const excludeEmails = (process.env.USAGE_EXCLUDE_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const excluded = new Set(users.users.filter((u) => /^e2e-/.test(u.email ?? '') || excludeEmails.includes((u.email ?? '').toLowerCase())).map((u) => u.id));
const signups = users.users.filter((u) => !excluded.has(u.id) && u.created_at >= from && u.created_at < to);

const events = await all('usage_events', 'kind, room_id, visitor, created_at');
const layouts = (await all('layouts', 'owner_id, created_by, created_at')).filter((r) => !excluded.has(r.owner_id));
const ai = (await all('ai_calls', 'owner_id, kind, status, created_at')).filter((r) => !excluded.has(r.owner_id));

const days = new Map();
const at = (d) => days.get(d) ?? days.set(d, { visitors: new Set(), home: 0, room: 0, place: 0, layouts: 0, ai: 0, signups: 0 }).get(d);
for (const e of events) {
  const d = at(day(e.created_at));
  d.visitors.add(e.visitor);
  if (e.kind === 'home_view') d.home += 1;
  if (e.kind === 'room_view') d.room += 1;
  if (e.kind === 'furniture_place') d.place += 1;
}
for (const r of layouts) at(day(r.created_at)).layouts += 1;
for (const r of ai) if (r.status === 'done') at(day(r.created_at)).ai += 1;
for (const u of signups) at(day(u.created_at)).signups += 1;

const rows = [...days].sort(([a], [b]) => a.localeCompare(b));
console.log('날짜        방문자 홈조회 방조회 가구놓기 배치저장 AI사용 가입');
for (const [d, r] of rows) console.log(d, String(r.visitors.size).padStart(6), String(r.home).padStart(6), String(r.room).padStart(6), String(r.place).padStart(8), String(r.layouts).padStart(8), String(r.ai).padStart(6), String(r.signups).padStart(4));
const visitors = new Set(events.map((e) => e.visitor));
const rooms = new Set(events.filter((e) => e.kind === 'room_view').map((e) => e.room_id));
console.log(`\n${values.since} ~ ${values.until || '지금'}: 방문자 ${visitors.size}명, 방 조회 ${events.filter((e) => e.kind === 'room_view').length}회(방 ${rooms.size}곳), 가구를 놓아 본 방 화면 ${events.filter((e) => e.kind === 'furniture_place').length}회, 배치 저장 ${layouts.length}회, AI 사용 ${ai.filter((r) => r.status === 'done').length}회, 새 가입 ${signups.length}명`);
