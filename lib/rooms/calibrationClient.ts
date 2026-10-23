// 브라우저에서 보정을 저장한다 (방 주인). 서버가 예전 방 좌표의 것을 새 방 좌표로 옮겨 돌려준다
import { parseSavedItems, type SavedItem } from '@/lib/layout/saved';
import type { SavedCalibration } from './calibration';
import { parseFixtures, type Fixture } from './fixtures';
import { parseOpenings, type Opening } from './openings';

export type SavedCalibrationResult = { openings: Opening[]; fixtures: Fixture[]; layouts: { id: string; items: SavedItem[] }[] };

export async function saveRoomCalibration(roomId: string, calibration: SavedCalibration): Promise<SavedCalibrationResult | null> {
  try {
    const res = await fetch(`/api/rooms/${roomId}/calibration`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transform: { ...calibration.transform, flipX: calibration.flipX }, floorPolygon: calibration.floorPolygon }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { openings?: unknown; fixtures?: unknown; layouts?: { id: string; items: unknown }[] };
    return {
      openings: parseOpenings(json.openings, calibration.floorPolygon),
      fixtures: parseFixtures(json.fixtures, calibration.floorPolygon),
      layouts: (json.layouts ?? []).map((l) => ({ id: l.id, items: parseSavedItems(l.items) })),
    };
  } catch {
    return null;
  }
}
