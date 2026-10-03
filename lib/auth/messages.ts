export const PASSWORD_MIN_LENGTH = 8;

/** Supabase Auth 오류를 사용자에게 보여줄 한국어 문구로 바꾼다. */
export function authErrorMessage(error: { code?: string; message?: string } | null | undefined): string {
  switch (error?.code) {
    case 'invalid_credentials':
      return '이메일 또는 비밀번호가 맞지 않습니다.';
    case 'user_already_exists':
    case 'email_exists':
      return '이미 가입된 이메일입니다. 로그인해 주세요.';
    case 'weak_password':
      return `비밀번호는 ${PASSWORD_MIN_LENGTH}자 이상이어야 합니다.`;
    case 'email_address_invalid':
    case 'validation_failed':
      return '이메일 주소를 확인해 주세요.';
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
      return '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
    case 'signup_disabled':
      return '지금은 가입할 수 없습니다.';
    case 'email_not_confirmed':
      return '이메일 확인이 필요합니다.';
    default:
      return '문제가 생겼습니다. 잠시 후 다시 시도해 주세요.';
  }
}

export type SignUpInput = { email: string; password: string; isAdult: boolean };

/** 가입 입력값 검사. 문제가 없으면 null */
export function validateSignUp(input: SignUpInput): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) return '이메일 주소를 확인해 주세요.';
  if (input.password.length < PASSWORD_MIN_LENGTH) return `비밀번호는 ${PASSWORD_MIN_LENGTH}자 이상이어야 합니다.`;
  if (!input.isAdult) return '만 18세 이상만 가입할 수 있습니다.';
  return null;
}

export const NICKNAME_MAX_LENGTH = 30;

export function validateNickname(nickname: string): string | null {
  const value = nickname.trim();
  if (!value) return '닉네임을 입력해 주세요.';
  if ([...value].length > NICKNAME_MAX_LENGTH) return `닉네임은 ${NICKNAME_MAX_LENGTH}자 이하여야 합니다.`;
  return null;
}
