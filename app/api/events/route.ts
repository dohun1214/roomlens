import { NextResponse } from 'next/server';
import { badRequest, readJson } from '@/lib/api/http';
import { createAdminClient } from '@/lib/supabase/admin';
import { isAutomated, UsageEventInput } from '@/lib/usage/events';

/**
 * 사용 기록 하나를 남긴다 (로그인 없이). 종류·방·무작위 방문자 값만 받고, 사람을 알아볼 수 있는 값은 저장하지 않는다.
 * 자동화 브라우저는 세지 않고, 저장에 실패해도 화면에는 영향이 없게 늘 204로 답한다.
 */
export async function POST(request: Request) {
  const parsed = UsageEventInput.safeParse(await readJson(request));
  if (!parsed.success) return badRequest();
  if (isAutomated(request.headers.get('user-agent'))) return new NextResponse(null, { status: 204 });
  const { kind, roomId, visitor } = parsed.data;
  const admin = createAdminClient();
  const { error } = await admin.from('usage_events').insert({ kind, room_id: roomId ?? null, visitor });
  if (error) console.error('usage_events', error.code);
  return new NextResponse(null, { status: 204 });
}
