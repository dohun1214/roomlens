// 개발용: 내 컴퓨터의 3D 파일을 특정 계정의 방으로 바로 올린다 (화면을 거치지 않음).
// 데이터셋·샘플 장면을 여러 개 올릴 때 쓴다. secret key와 R2 키가 필요하므로 운영 화면에는 없는 기능이다.
// 실행 예:
//   node --env-file=.env.local --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/dev-data/seed-room.mjs --email me@example.com \
//     --file ../roomlens-data/samples/studio11_2m_up.sog --title "Studio 11 (200만)" \
//     --credit "Studio 11 by milanoski (SuperSplat), CC BY 4.0" [--description "..."] [--public]
//   --credit 을 주면 데이터셋 방(source=dataset), 없으면 직접 찍은 방(source=scaniverse)으로 만든다.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { checkSplatFile, SPLAT_CONTENT_TYPE, SPLAT_HEAD_BYTES, splatKeyFor } from '../../lib/upload/splatFile.ts';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    file: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string', default: '' },
    credit: { type: 'string', default: '' },
    public: { type: 'boolean', default: false },
  },
});
await main();

async function main() {
if (!values.email || !values.file || !values.title) {
  console.error('필수: --email, --file, --title');
  process.exitCode = 1; // process.exit()는 Windows에서 연결이 열린 채 끝내면 오류가 난다
  return;
}

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});

// 1) 파일 확인 (화면에서 올릴 때와 같은 규칙)
const filePath = path.resolve(values.file);
const bytes = readFileSync(filePath);
const check = checkSplatFile(bytes.length, bytes.subarray(0, SPLAT_HEAD_BYTES));
if (!check.ok) {
  console.error(`올릴 수 없는 파일: ${check.message}`);
  process.exitCode = 1; // process.exit()는 Windows에서 연결이 열린 채 끝내면 오류가 난다
  return;
}

// 2) 계정 찾기
const { data: users, error: usersError } = await admin.auth.admin.listUsers({ perPage: 1000 });
if (usersError) throw usersError;
const owner = users.users.find((u) => u.email?.toLowerCase() === values.email.toLowerCase());
if (!owner) {
  console.error('그 이메일로 가입한 계정이 없습니다. 먼저 사이트에서 가입해 주세요.');
  process.exitCode = 1; // process.exit()는 Windows에서 연결이 열린 채 끝내면 오류가 난다
  return;
}

// 3) 방 레코드 → R2 업로드 → ready
const credit = values.credit.trim();
const { data: room, error: insertError } = await admin
  .from('rooms')
  .insert({
    owner_id: owner.id,
    title: values.title,
    description: values.description,
    source: credit ? 'dataset' : 'scaniverse',
    credit,
    consent_at: new Date().toISOString(),
  })
  .select('id')
  .single();
if (insertError) throw insertError;

const key = splatKeyFor(room.id, check.format);
try {
  await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, Body: bytes, ContentType: SPLAT_CONTENT_TYPE }));
  const { error: updateError } = await admin
    .from('rooms')
    .update({ status: 'ready', splat_key: key, splat_format: check.format, splat_bytes: bytes.length, is_public: values.public })
    .eq('id', room.id);
  if (updateError) throw updateError;
} catch (err) {
  await admin.from('rooms').delete().eq('id', room.id); // 올리다 실패한 방은 남기지 않는다
  throw err;
}

const appUrl = process.env.APP_URL ?? 'https://roomlens-seven.vercel.app';
console.log(`올림: ${values.title} (${check.format}, ${(bytes.length / 1e6).toFixed(1)}MB, ${values.public ? '공개' : '비공개'})`);
console.log(`${appUrl}/rooms/${room.id}`);
}
