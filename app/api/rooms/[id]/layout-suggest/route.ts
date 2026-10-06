import { NextResponse } from 'next/server';
import { AiError, GEMINI_MODEL, generateJson } from '@/lib/ai/gemini';
import { aiLayoutName, composeAiSummary, suggestLayout, type GenerateIntent } from '@/lib/ai/layoutSuggest';
import { DAILY_AI_LIMIT } from '@/lib/ai/limits';
import { LAYOUT_SYSTEM_PROMPT } from '@/lib/ai/prompts';
import { LayoutIntent, LayoutSuggestInput } from '@/lib/ai/schemas';
import { finishAiCall, startAiCall } from '@/lib/ai/usage';
import { apiError, badRequest, notFound, readJson, unauthenticated } from '@/lib/api/http';
import { fromCatalogRow, type CatalogItem } from '@/lib/layout/catalog';
import { MAX_AI_LAYOUTS } from '@/lib/layout/store';
import type { SolverItem } from '@/lib/layout/solver';
import { fromUserFurnitureRow } from '@/lib/layout/userFurniture';
import { parseSavedCalibration } from '@/lib/rooms/calibration';
import { parseOpenings } from '@/lib/rooms/openings';
import { firstIssueMessage, RoomId } from '@/lib/rooms/schemas';
import { createClient, getCurrentUser } from '@/lib/supabase/server';

type Context = { params: Promise<{ id: string }> };

// Gemini를 최대 3번 부른다 (한 번에 몇 초~수십 초)
export const maxDuration = 120;

/**
 * 가구 배치 추천. 지금 놓인 가구 목록과 요청 글을 받아, Gemini가 "어느 벽·구역에 둘지"를 정하고
 * 솔버가 좌표를 계산한다. 결과는 내 배치를 덮어쓰지 않고 별도의 "AI 배치"로 저장한다.
 * 로그인한 사람만, 한 사람당 하루 10회.
 */
export async function POST(request: Request, { params }: Context) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();

  const id = RoomId.safeParse((await params).id);
  if (!id.success) return notFound();
  const parsed = LayoutSuggestInput.safeParse(await readJson(request));
  if (!parsed.success) return badRequest(firstIssueMessage(parsed.error));
  const input = parsed.data;
  if (new Set(input.items.map((item) => item.id)).size !== input.items.length) return badRequest('가구 목록에 같은 id가 두 번 들어 있습니다.');

  // 로그인한 사용자의 권한(RLS)으로 읽으므로 공개 방이거나 본인 방일 때만 보인다
  const supabase = await createClient();
  const { data: room, error } = await supabase.from('rooms').select('id, status, transform, floor_polygon, openings').eq('id', id.data).maybeSingle();
  if (error) return apiError(500, 'DB_ERROR', '방 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
  if (!room || room.status !== 'ready') return notFound();
  const calibration = parseSavedCalibration(room.transform, room.floor_polygon);
  if (!calibration) return apiError(400, 'NOT_CALIBRATED', '방의 크기·바닥 보정을 먼저 저장해 주세요.');
  const openings = parseOpenings(room.openings, calibration.floorPolygon);

  // 가구의 이름·치수는 브라우저가 보낸 값을 믿지 않고 DB에서 다시 읽는다 (내 가구는 RLS로 본인 것만 보인다)
  const catalogIds = [...new Set(input.items.filter((item) => item.kind === 'catalog').map((item) => item.furnitureRef))];
  const userIds = [...new Set(input.items.filter((item) => item.kind === 'user').map((item) => item.furnitureRef))];
  const [catalogRows, userRows] = await Promise.all([
    catalogIds.length > 0
      ? supabase.from('furniture_catalog').select('id, name_ko, category, width_m, depth_m, height_m, clearance_m').in('id', catalogIds)
      : { data: [], error: null },
    userIds.length > 0
      ? supabase.from('user_furniture').select('id, name, category, width_m, depth_m, height_m').in('id', userIds).eq('owner_id', user.id)
      : { data: [], error: null },
  ]);
  if (catalogRows.error || userRows.error) return apiError(500, 'DB_ERROR', '가구 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
  const furniture = new Map<string, CatalogItem>();
  for (const row of catalogRows.data ?? []) furniture.set(`catalog:${row.id}`, fromCatalogRow(row));
  for (const row of userRows.data ?? []) furniture.set(`user:${row.id}`, fromUserFurnitureRow(row));

  const items: SolverItem[] = [];
  for (const item of input.items) {
    const entry = furniture.get(`${item.kind}:${item.furnitureRef}`);
    if (!entry) return badRequest('목록에 없는 가구가 들어 있습니다. 화면을 새로 고친 뒤 다시 해 주세요.');
    items.push({ id: item.id, name: entry.nameKo, category: entry.category, w: entry.w, d: entry.d, h: entry.h, clearance: entry.clearance });
  }

  const call = await startAiCall(user.id, room.id, 'layout', GEMINI_MODEL);
  if (!call.ok) {
    return call.reason === 'limit'
      ? apiError(429, 'AI_LIMIT', `오늘 쓸 수 있는 AI 횟수(${DAILY_AI_LIMIT}회)를 모두 썼습니다. 내일 다시 해 주세요.`)
      : apiError(500, 'DB_ERROR', 'AI 사용 횟수를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }

  const generate: GenerateIntent = async (prompt) => {
    const { data, inputTokens, outputTokens } = await generateJson(LayoutIntent, { system: LAYOUT_SYSTEM_PROMPT, parts: [{ text: prompt }] });
    return { intent: data, inputTokens, outputTokens };
  };

  let suggestion;
  try {
    suggestion = await suggestLayout({ polygon: calibration.floorPolygon, openings }, items, input.request, generate);
  } catch (err) {
    // 실패한 호출은 하루 횟수에서 빠진다
    await finishAiCall(call.callId, { status: 'failed', error: err instanceof AiError ? err.code : 'UNKNOWN' });
    if (!(err instanceof AiError)) console.error(err);
    return apiError(502, 'AI_ERROR', 'AI가 답하지 못했습니다. 잠시 뒤에 다시 해 주세요.');
  }
  const usage = { attempts: suggestion.attempts, inputTokens: suggestion.inputTokens, outputTokens: suggestion.outputTokens };

  if (suggestion.placed.length === 0) {
    await finishAiCall(call.callId, { status: 'done', ...usage, error: 'NOTHING_PLACED' });
    return apiError(422, 'NOTHING_PLACED', '가구를 놓을 자리를 찾지 못했습니다. 가구를 줄이거나 방의 보정을 확인해 주세요.');
  }

  // AI 배치는 본인 권한(RLS)으로 저장한다: 볼 수 있는 방에 내 배치를 만드는 것과 같다
  const refs = new Map(input.items.map((item) => [item.id, item]));
  const savedItems = suggestion.placed.map((p) => ({
    id: p.id,
    furnitureRef: refs.get(p.id)?.furnitureRef ?? '',
    kind: refs.get(p.id)?.kind ?? 'catalog',
    x: p.x,
    z: p.z,
    rotationDeg: Math.round(p.rotationDeg) % 360,
  }));
  const aiSummary = composeAiSummary(suggestion.summary, suggestion.placed);
  const { data: layout, error: insertError } = await supabase
    .from('layouts')
    .insert({ room_id: room.id, name: aiLayoutName(), items: savedItems, created_by: 'ai', ai_summary: aiSummary })
    .select('id, name, items, created_by, ai_summary')
    .maybeSingle();
  if (insertError || !layout) {
    await finishAiCall(call.callId, { status: 'failed', ...usage, error: 'SAVE_FAILED' });
    return apiError(500, 'DB_ERROR', '추천 결과를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }

  // 이 방의 내 AI 배치는 최근 것 몇 개만 남긴다
  const { data: mine } = await supabase
    .from('layouts')
    .select('id')
    .eq('room_id', room.id)
    .eq('owner_id', user.id)
    .eq('created_by', 'ai')
    .order('created_at', { ascending: false });
  const old = (mine ?? []).slice(MAX_AI_LAYOUTS).map((row) => row.id);
  if (old.length > 0) await supabase.from('layouts').delete().in('id', old);

  await finishAiCall(call.callId, { status: 'done', ...usage });
  return NextResponse.json({
    layout: { id: layout.id, name: layout.name, items: savedItems, createdBy: 'ai', aiSummary },
    removedLayoutIds: old,
    summary: suggestion.summary,
    reasons: suggestion.placed.filter((p) => p.reason !== '').map((p) => ({ itemId: p.id, name: p.name, reason: p.reason })),
    failures: suggestion.failures,
    unmet: suggestion.unmet,
    attempts: suggestion.attempts,
    remaining: call.remaining,
  });
}
