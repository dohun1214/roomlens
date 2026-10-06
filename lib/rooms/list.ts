// 방 목록(홈)에서 쓰는 표시용 함수. DB 행을 화면에 보여줄 모양으로 바꾼다.
import { parseSavedCalibration } from '@/lib/rooms/calibration';
import { openingSegment, parseOpenings, type OpeningType } from '@/lib/rooms/openings';

type Point2 = [number, number];

export type RoomListRow = {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  is_public: boolean;
  status: string;
  source: string;
  created_at: string;
  /** 보정 값과 문·창문. 카드의 작은 평면도와 상태 표시에 쓴다 (없어도 된다) */
  transform?: unknown;
  floor_polygon?: unknown;
  openings?: unknown;
};

/** 카드에 그리는 작은 평면도: 방의 바닥 모양과 문·창문 자리 (방 좌표, m) */
export type RoomOutline = {
  polygon: Point2[];
  openings: { type: OpeningType; a: Point2; b: Point2 }[];
};

/** 내 방 카드에 보여주는 진행 상태 */
export type RoomStats = {
  calibrated: boolean;
  openings: number;
  /** 이 방에 내가 저장한 배치 수 */
  layouts: number;
  hasReport: boolean;
};

/** 방마다 따로 센 값 (홈이 한 번에 읽어서 넘긴다) */
export type RoomExtras = {
  layoutCounts?: Map<string, number>;
  reportRoomIds?: Set<string>;
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
  /** 보정한 방이면 바닥 모양. 아니면 null */
  outline: RoomOutline | null;
  /** 내 방 목록에서만 채운다 */
  stats: RoomStats | null;
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

/** 보정 값이 있으면 바닥 모양과 문·창문 자리를 꺼낸다 */
export function roomOutline(room: Pick<RoomListRow, 'transform' | 'floor_polygon' | 'openings'>): RoomOutline | null {
  const calibration = parseSavedCalibration(room.transform, room.floor_polygon);
  if (!calibration) return null;
  const polygon = calibration.floorPolygon;
  const openings = parseOpenings(room.openings, polygon).flatMap((opening) => {
    const segment = openingSegment(opening, polygon);
    return segment ? [{ type: opening.type, a: segment[0], b: segment[1] }] : [];
  });
  return { polygon, openings };
}

export function toRoomCards(rows: RoomListRow[], nicknames: Map<string, string>, mine: boolean, extras: RoomExtras = {}): RoomCardData[] {
  return rows.map((room) => {
    const outline = roomOutline(room);
    return {
      id: room.id,
      title: room.title,
      description: room.description,
      ownerNickname: nicknames.get(room.owner_id) ?? '알 수 없음',
      createdLabel: formatRoomDate(room.created_at),
      badges: roomBadges(room, mine),
      outline,
      stats:
        mine && room.status === 'ready'
          ? {
              calibrated: outline !== null,
              openings: outline?.openings.length ?? 0,
              layouts: extras.layoutCounts?.get(room.id) ?? 0,
              hasReport: extras.reportRoomIds?.has(room.id) ?? false,
            }
          : null,
    };
  });
}

/** 여러 행에서 방 id별 개수를 센다 */
export function countByRoom(rows: { room_id: string }[] | null | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows ?? []) counts.set(row.room_id, (counts.get(row.room_id) ?? 0) + 1);
  return counts;
}

/** 홈에 보여줄 공개 방 개수 */
export const PUBLIC_ROOMS_LIMIT = 24;
