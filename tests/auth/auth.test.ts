import { describe, expect, it } from 'vitest';
import { authErrorMessage, validateNickname, validateSignUp } from '@/lib/auth/messages';
import { isProtectedPath, loginUrlFor, safeNextPath } from '@/lib/auth/paths';

describe('safeNextPath', () => {
  it('사이트 안의 경로는 그대로 둔다', () => {
    expect(safeNextPath('/rooms/new')).toBe('/rooms/new');
    expect(safeNextPath('/rooms/abc?tab=layout')).toBe('/rooms/abc?tab=layout');
  });

  it('다른 사이트로 가는 값은 기본 경로로 바꾼다', () => {
    expect(safeNextPath('https://evil.example')).toBe('/');
    expect(safeNextPath('//evil.example/path')).toBe('/');
    expect(safeNextPath('/\\evil.example')).toBe('/');
    expect(safeNextPath('javascript:alert(1)')).toBe('/');
  });

  it('비어 있거나 로그인 화면이면 기본 경로', () => {
    expect(safeNextPath(null)).toBe('/');
    expect(safeNextPath('')).toBe('/');
    expect(safeNextPath('/login')).toBe('/');
    expect(safeNextPath('/login?next=/account')).toBe('/');
    expect(safeNextPath(undefined, '/account')).toBe('/account');
  });
});

describe('isProtectedPath / loginUrlFor', () => {
  it('로그인이 필요한 경로를 구분한다', () => {
    expect(isProtectedPath('/account')).toBe(true);
    expect(isProtectedPath('/rooms/new')).toBe(true);
    expect(isProtectedPath('/rooms/new/guide')).toBe(true);
    expect(isProtectedPath('/')).toBe(false);
    expect(isProtectedPath('/viewer')).toBe(false);
    expect(isProtectedPath('/rooms/newest')).toBe(false);
    expect(isProtectedPath('/accounting')).toBe(false);
  });

  it('돌아갈 경로를 next에 담는다', () => {
    expect(loginUrlFor('/rooms/new')).toBe('/login?next=%2Frooms%2Fnew');
    expect(loginUrlFor('/')).toBe('/login');
    expect(loginUrlFor('https://evil.example')).toBe('/login');
  });
});

describe('가입 입력값 검사', () => {
  const ok = { email: 'a@b.co', password: '12345678', isAdult: true };

  it('문제없으면 null', () => {
    expect(validateSignUp(ok)).toBeNull();
  });

  it('이메일 형식, 비밀번호 길이, 만 18세 확인을 차례로 검사한다', () => {
    expect(validateSignUp({ ...ok, email: 'not-an-email' })).toContain('이메일');
    expect(validateSignUp({ ...ok, password: '1234567' })).toContain('8자');
    expect(validateSignUp({ ...ok, isAdult: false })).toContain('만 18세');
  });
});

describe('닉네임 검사', () => {
  it('비어 있거나 30자를 넘으면 안 된다 (한글도 글자 수로 센다)', () => {
    expect(validateNickname('  ')).not.toBeNull();
    expect(validateNickname('가'.repeat(30))).toBeNull();
    expect(validateNickname('가'.repeat(31))).not.toBeNull();
  });
});

describe('authErrorMessage', () => {
  it('알려진 오류 코드는 한국어 문구로, 모르는 오류는 일반 문구로', () => {
    expect(authErrorMessage({ code: 'invalid_credentials' })).toContain('맞지 않습니다');
    expect(authErrorMessage({ code: 'user_already_exists' })).toContain('이미 가입');
    expect(authErrorMessage({ code: 'something_new' })).toContain('문제가 생겼습니다');
    expect(authErrorMessage(null)).toContain('문제가 생겼습니다');
  });
});
