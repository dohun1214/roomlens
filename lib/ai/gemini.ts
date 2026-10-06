import 'server-only';
import { GoogleGenAI, ThinkingLevel, type Part } from '@google/genai';
import { z } from 'zod';

// Gemini 호출 묶음. 키는 서버에서만 쓰고(GEMINI_API_KEY), 응답은 항상 JSON 스키마로 받고 다시 검증한다.
// 구조화 출력은 `responseMimeType` + `responseJsonSchema` 조합이 동작한다 (scripts/check-gemini.ts 로 확인).

export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.8-flash';

/** NO_KEY: 키 없음, UPSTREAM: Gemini가 실패하거나 시간 초과, BAD_OUTPUT: 응답이 스키마와 다름 */
export class AiError extends Error {
  constructor(
    public readonly code: 'NO_KEY' | 'UPSTREAM' | 'BAD_OUTPUT',
    message: string,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export type AiUsage = { inputTokens: number; outputTokens: number };

let client: GoogleGenAI | null = null;

/**
 * 글·그림을 보내고 schema 모양의 JSON을 받는다.
 * @param input.parts 사용자 메시지의 조각들 (글, inline 이미지)
 */
export async function generateJson<T>(
  schema: z.ZodType<T>,
  input: { system: string; parts: Part[]; timeoutMs?: number; thinking?: 'low' | 'medium' },
): Promise<{ data: T } & AiUsage> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new AiError('NO_KEY', 'GEMINI_API_KEY가 없습니다.');
  client ??= new GoogleGenAI({ apiKey });

  let text: string;
  let usage: AiUsage;
  try {
    const res = await client.models.generateContent({
      model: GEMINI_MODEL,
      contents: [{ role: 'user', parts: input.parts }],
      config: {
        systemInstruction: input.system,
        responseMimeType: 'application/json',
        responseJsonSchema: z.toJSONSchema(schema),
        // 생각 토큰이 응답 시간의 대부분이라 낮게 둔다 (계획은 단순하고, 좌표는 코드가 계산한다)
        thinkingConfig: { thinkingLevel: input.thinking === 'medium' ? ThinkingLevel.MEDIUM : ThinkingLevel.LOW },
        httpOptions: { timeout: input.timeoutMs ?? 60_000 },
      },
    });
    text = res.text ?? '';
    usage = {
      inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
      // 생각 토큰도 출력 요금으로 청구된다
      outputTokens: (res.usageMetadata?.candidatesTokenCount ?? 0) + (res.usageMetadata?.thoughtsTokenCount ?? 0),
    };
  } catch (err) {
    const e = err as { status?: number; message?: string };
    console.error('[gemini] 호출 실패', e.status ?? '', String(e.message ?? err).slice(0, 300));
    throw new AiError('UPSTREAM', 'Gemini 호출에 실패했습니다.');
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AiError('BAD_OUTPUT', 'Gemini 응답이 JSON이 아닙니다.');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new AiError('BAD_OUTPUT', 'Gemini 응답이 정해진 형식과 다릅니다.');
  return { data: parsed.data, ...usage };
}
