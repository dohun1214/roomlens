import { NextResponse } from 'next/server';

/** API 오류 응답 형식: { error: { code, message } } */
export function apiError(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

/** 요청 본문을 JSON으로 읽는다. JSON이 아니면 null */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export const unauthenticated = () => apiError(401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
export const badRequest = (message = '요청 형식이 올바르지 않습니다.') => apiError(400, 'BAD_REQUEST', message);
export const notFound = (message = '방을 찾을 수 없습니다.') => apiError(404, 'NOT_FOUND', message);
