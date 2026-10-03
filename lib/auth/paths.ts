/** 로그인해야 들어갈 수 있는 경로 (앞부분 일치) */
const PROTECTED_PREFIXES = ['/account', '/rooms/new'];

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * 로그인 뒤 돌아갈 경로. 사이트 안의 경로만 허용한다
 * (`?next=https://evil.example` 같은 값으로 다른 사이트에 보내는 것을 막는다).
 */
export function safeNextPath(next: string | null | undefined, fallback = '/'): string {
  if (!next) return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return fallback;
  if (next === '/login' || next.startsWith('/login?')) return fallback;
  return next;
}

export function loginUrlFor(next: string): string {
  const safe = safeNextPath(next);
  return safe === '/' ? '/login' : `/login?next=${encodeURIComponent(safe)}`;
}
