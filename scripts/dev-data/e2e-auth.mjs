// 가입·로그인 실측: 실제 브라우저로 가입 → 닉네임 변경 → 로그아웃 → 로그인을 해 본다.
// 시험용 계정은 끝나면 지운다 (secret key 필요).
// 준비: npm run dev, ../roomlens-data/_e2e 에 playwright-core
// 실행: node --env-file=.env.local scripts/dev-data/e2e-auth.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.ROOMLENS_DATA ?? path.resolve(here, '../../../roomlens-data');
const require = createRequire(path.join(dataDir, '_e2e', 'package.json'));
const { chromium } = require('playwright-core');

const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
const email = `e2e-${Date.now()}@${process.env.E2E_EMAIL_DOMAIN ?? 'roomlens.test'}`;
const password = `pw-${Math.random().toString(36).slice(2, 12)}A1`;
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));
const alertText = async () => (await page.getByTestId('auth-error').textContent({ timeout: 8000 }).catch(() => null)) ?? '';

try {
  // 1) 로그인 없이 보호된 경로
  await page.goto(`${appUrl}/account`);
  check('비로그인으로 /account → 로그인 화면으로 이동', page.url().includes('/login?next=%2Faccount'), page.url());

  // 2) 가입: 만 18세 체크 없이는 안 됨
  await page.getByRole('tab', { name: '가입' }).click();
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel(/비밀번호/).fill(password);
  await page.getByRole('button', { name: '가입하기' }).click();
  check('만 18세 체크 없이 가입 → 거부', (await alertText()).includes('만 18세'), null);

  // 3) 체크 후 가입 → 바로 로그인되어 원래 가려던 /account 로
  await page.getByLabel('만 18세 이상입니다.').check();
  await page.getByRole('button', { name: '가입하기' }).click();
  await page.waitForURL('**/account', { timeout: 15000 });
  check('가입 즉시 로그인되어 /account 로 이동', true, null);
  check('내 정보에 이메일 표시', (await page.getByTestId('account-email').textContent()) === email, null);
  check('만 18세 확인이 프로필에 저장됨', (await page.getByTestId('account-adult').textContent()) === '확인함', null);
  const firstNick = await page.getByTestId('header-nickname').textContent();
  check('가입 시 프로필(닉네임) 자동 생성', firstNick?.startsWith('사용자'), firstNick);

  // 4) 닉네임 변경
  await page.getByLabel('닉네임').fill('테스트 닉네임');
  await page.getByRole('button', { name: '저장' }).click();
  await page.getByText('저장했습니다.').waitFor({ timeout: 8000 });
  await page.waitForFunction(() => document.querySelector('[data-testid=header-nickname]')?.textContent === '테스트 닉네임', null, { timeout: 8000 });
  check('닉네임 변경이 상단 메뉴에 반영됨', true, null);

  // 5) 로그아웃
  await page.getByRole('button', { name: '로그아웃' }).click();
  await page.getByRole('link', { name: '로그인' }).waitFor({ timeout: 8000 });
  await page.goto(`${appUrl}/account`);
  check('로그아웃 후 /account 접근 불가', page.url().includes('/login'), page.url());

  // 6) 로그인: 틀린 비밀번호 → 오류, 맞는 비밀번호 → 성공
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel(/비밀번호/).fill('wrong-password-123');
  await page.getByRole('button', { name: '로그인', exact: true }).last().click();
  check('틀린 비밀번호 → 오류 문구', (await alertText()).includes('맞지 않습니다'), null);
  await page.getByLabel(/비밀번호/).fill(password);
  await page.getByRole('button', { name: '로그인', exact: true }).last().click();
  await page.waitForURL('**/account', { timeout: 15000 });
  check('로그인 후 /account 로 이동, 닉네임 유지', (await page.getByTestId('header-nickname').textContent()) === '테스트 닉네임', null);

  // 7) 새로고침해도 로그인 유지 (proxy.ts 세션 갱신)
  await page.reload();
  check('새로고침 후에도 로그인 유지', (await page.getByTestId('account-email').textContent()) === email, null);

  // 8) 같은 이메일로 다시 가입
  await page.getByRole('button', { name: '로그아웃' }).click();
  await page.getByRole('link', { name: '로그인' }).click();
  await page.getByRole('tab', { name: '가입' }).click();
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel(/비밀번호/).fill(password);
  await page.getByLabel('만 18세 이상입니다.').check();
  await page.getByRole('button', { name: '가입하기' }).click();
  check('이미 가입된 이메일 → 안내 문구', (await alertText()).includes('이미 가입'), null);

  check('브라우저 콘솔 오류 없음', errors.filter((e) => !e.includes('400') && !e.includes('422')).length === 0, errors.slice(0, 3));
} catch (err) {
  check('예외 없이 끝까지 실행', false, String(err).slice(0, 300));
  await page.screenshot({ path: path.join(dataDir, '_e2e', 'auth-failure.png') }).catch(() => {});
} finally {
  await browser.close();
  // 시험용 계정 삭제 (profiles 는 on delete cascade)
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  const mine = data?.users.filter((u) => u.email === email) ?? [];
  for (const u of mine) await admin.auth.admin.deleteUser(u.id);
  check('시험용 계정 삭제', mine.length === 1, `${mine.length}개`);
}

for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
