// 계정 삭제: 실수로 지우지 않게 확인 칸에 이 글을 적어야 한다
export const ACCOUNT_DELETE_CONFIRM = '계정 삭제';

export function canConfirmDelete(text: string): boolean {
  return text.trim() === ACCOUNT_DELETE_CONFIRM;
}
