// 방 목록(홈)에서 쓰는 표시용 함수. DB 행을 화면에 보여줄 모양으로 바꾼다.

export type RoomListRow = {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  is_public: boolean;
  status: string;
  source: string;
  created_at: string;
};

export type RoomCardData = {
  id: string;
  title: string;
  description: string;
  ownerNickname: string;
  /** 예: "2026. 10. 5." (한국 시간) */
  createdLabel: string;
  /** 제목 옆에 붙는 짧은 표시. 예: ["데이터셋"], ["비공개", "올리는 중"] */
  badges: string[];
};

const dateFormat = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeZone: 'Asia/Seoul' });

export function formatRoomDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : dateFormat.format(date);
}

/**
 * @param mine true면 내 방 목록: 공개 여부와 올리는 중 상태도 표시한다.
 *             false면 공개 방 목록: 어차피 모두 공개·완료이므로 데이터셋 표시만 한다.
 */
export function roomBadges(room: Pick<RoomListRow, 'is_public' | 'status' | 'source'>, mine: boolean): string[] {
  const badges: string[] = [];
  if (mine) {
    badges.push(room.is_public ? '공개' : '비공개');
    if (room.status === 'uploading') badges.push('올리는 중');
    if (room.status === 'failed') badges.push('올리기 실패');
  }
  if (room.source === 'dataset') badges.push('데이터셋');
  return badges;
}

export function toRoomCards(rows: RoomListRow[], nicknames: Map<string, string>, mine: boolean): RoomCardData[] {
  return rows.map((room) => ({
    id: room.id,
    title: room.title,
    description: room.description,
    ownerNickname: nicknames.get(room.owner_id) ?? '알 수 없음',
    createdLabel: formatRoomDate(room.created_at),
    badges: roomBadges(room, mine),
  }));
}

/** 홈에 보여줄 공개 방 개수 */
export const PUBLIC_ROOMS_LIMIT = 24;
