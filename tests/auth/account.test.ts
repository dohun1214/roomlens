import { describe, expect, it } from 'vitest';
import { ACCOUNT_DELETE_CONFIRM, canConfirmDelete } from '@/lib/auth/account';

describe('계정 삭제 확인 글', () => {
  it('정확히 적어야 한다 (앞뒤 공백은 괜찮음)', () => {
    expect(canConfirmDelete(ACCOUNT_DELETE_CONFIRM)).toBe(true);
    expect(canConfirmDelete(`  ${ACCOUNT_DELETE_CONFIRM} `)).toBe(true);
    expect(canConfirmDelete('계정삭제')).toBe(false);
    expect(canConfirmDelete('')).toBe(false);
  });
});
