// Gemini 키와 구조화 출력(JSON 스키마) 방식 확인.
// 실행: node --env-file=.env.local scripts/check-gemini.ts
// 키 값은 출력하지 않는다.
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { LayoutIntent } from '../lib/ai/schemas.ts';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('GEMINI_API_KEY가 없습니다 (.env.local 확인).');
  process.exit(1);
}
const model = process.env.GEMINI_MODEL ?? 'gemini-3.8-flash';
const ai = new GoogleGenAI({ apiKey });

const system = [
  '너는 한국 원룸·기숙사의 가구 배치를 계획하는 도우미다.',
  '- 좌표나 치수를 만들지 말고, 주어진 벽 id와 가구 id만 사용하라.',
  '- 문 앞은 비워두고, 문에서 모든 가구로 가는 통로(60cm 이상)를 남겨라.',
  '- 키 큰 가구는 창문을 가리지 않게 하라.',
  '- 사용자 요청을 가장 먼저 고려하고, 각 가구의 이유를 한국어 한 문장으로 적어라.',
].join('\n');
const room = [
  '방: 3.2m x 4.0m 직사각형',
  'W1 (3.2m): 문 있음 (왼쪽 끝에서 0.2~1.1m)',
  'W2 (4.0m): 벽',
  'W3 (3.2m): 창문 있음 (0.8~2.4m)',
  'W4 (4.0m): 벽',
  '가구: bed1 슈퍼싱글 침대 1.1x2.0m, desk1 책상 1.2x0.6m, ward1 옷장 0.9x0.6m (높이 2.0m)',
  '사용자 요청: 책상은 창가에 두고 싶어요',
].join('\n');
const jsonSchema = z.toJSONSchema(LayoutIntent);

// 문서와 SDK 타입에 나오는 설정 방식들
const variants: Record<string, Record<string, unknown>> = {
  'responseMimeType + responseJsonSchema': { responseMimeType: 'application/json', responseJsonSchema: jsonSchema },
  'responseFormat.text (문서 예제)': { responseFormat: { text: { mimeType: 'application/json', schema: jsonSchema } } },
  'responseMimeType만 (스키마 없음)': { responseMimeType: 'application/json' },
};

let failed = false;
for (const [name, config] of Object.entries(variants)) {
  const t0 = performance.now();
  try {
    const res = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: room }] }],
      config: { systemInstruction: system, ...config } as never,
    });
    const ms = Math.round(performance.now() - t0);
    const text = res.text ?? '';
    let verdict: string;
    try {
      const parsed = LayoutIntent.safeParse(JSON.parse(text));
      verdict = parsed.success
        ? `스키마 통과 (가구 ${parsed.data.placements.length}개: ${parsed.data.placements.map((p) => `${p.itemId}→${p.zone}/${p.wallId || '-'}`).join(', ')})`
        : `JSON이지만 스키마 불일치: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`;
    } catch {
      verdict = `JSON 아님: ${text.slice(0, 80).replace(/\s+/g, ' ')}`;
    }
    const usage = res.usageMetadata;
    console.log(`[${name}] ${ms}ms, 입력 ${usage?.promptTokenCount} / 출력 ${usage?.candidatesTokenCount} 토큰 (생각 ${usage?.thoughtsTokenCount ?? 0}) → ${verdict}`);
  } catch (err) {
    failed = true;
    const e = err as { status?: number; message?: string };
    console.log(`[${name}] 실패: ${e.status ?? ''} ${String(e.message ?? err).replace(/\s+/g, ' ').slice(0, 300)}`);
  }
}
console.log(`모델: ${model}, SDK 스키마 키: ${Object.keys(jsonSchema).join(', ')}`);
process.exit(failed ? 1 : 0);
