// 원래 가구 떼어 내기의 AI 분할 (브라우저): 다듬기에서 남긴 스플랫만 방과 같은 자리에 잠시 그려 가구 둘레 네 방향에서 찍고,
// 서버(Gemini)에서 시점마다 가구·얹힌 물건·따로 선 물건의 상자를 받아 스플랫을 투영해 고른다 (lib/rooms/fixtureSegment.ts).
// 한도를 넘었거나 실패하거나 결과를 믿기 어려우면 null을 돌려준다 → AI 없이(다듬기만으로) 떼어 낸다.
import * as THREE from 'three';
import { PackedSplats, SplatMesh } from '@sparkjsdev/spark';
import type { CaptureEngine } from './capture';
import { captureFixedViews } from './topView';
import { SEGMENT_IMAGE, segmentViews, trustSegment, voteSegment, type SegmentBoxes } from '@/lib/rooms/fixtureSegment';
import type { Footprint } from './floorDrag';

/** extractFixturePiece가 다듬기를 마친 뒤 부르는 AI 분할 */
export type SegmentInput = {
  source: PackedSplats;
  /** 고른 스플랫의 원본 번호 */
  picked: number[];
  /** 고른 스플랫의 방 좌표 [x, y, z, …] */
  points: Float32Array;
  /** 다듬기에서 남긴 것 (1) */
  candidate: Uint8Array;
  /** 원본 파일 좌표 → 방 좌표 (방 스플랫 메시의 matrixWorld) */
  toRoom: THREE.Matrix4;
  box: Footprint;
  top: number;
};
export type SegmentOutcome =
  | { status: 'ok'; keep: Uint8Array; remaining: number }
  | { status: 'limit' | 'error' | 'untrusted'; remaining?: number };
export type SegmentHook = (input: SegmentInput) => Promise<SegmentOutcome>;

/** 개발 서버 실측용: window.__roomlensSegmentDump가 배열이면 찍은 그림·상자·결과를 넣는다 */
const segmentDump = (): unknown[] | null => {
  if (process.env.NODE_ENV === 'production' || typeof window === 'undefined') return null;
  const dump = (window as unknown as { __roomlensSegmentDump?: unknown }).__roomlensSegmentDump;
  return Array.isArray(dump) ? dump : null;
};

/**
 * 남긴 스플랫만 방 좌표 그대로 그린 메시로 시점마다 찍는다 (방 스플랫과 다른 것은 잠시 숨긴다).
 * 메시는 원본 파일 좌표의 스플랫을 담고 matrixWorld가 toRoom이 되게 둔다 → 방에서 보던 모습 그대로.
 */
async function capturePiece(engine: CaptureEngine, input: SegmentInput): Promise<string[]> {
  const packed = new PackedSplats();
  for (let k = 0; k < input.picked.length; k += 1) {
    if (!input.candidate[k]) continue;
    const s = input.source.getSplat(input.picked[k]);
    packed.pushSplat(s.center, s.scales, s.quaternion, s.opacity, s.color);
  }
  const mesh = new SplatMesh({ packedSplats: packed, editable: false });
  await mesh.initialized;
  // roomGroup 안에서 matrixWorld = toRoom 이 되게 (roomGroup의 보정 변환을 되돌려 곱한다)
  engine.roomGroup.updateWorldMatrix(true, false);
  const local = new THREE.Matrix4().copy(engine.roomGroup.matrixWorld).invert().multiply(input.toRoom);
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(local);
  const hidden = engine.roomGroup.children.filter((child) => child.visible);
  for (const child of hidden) child.visible = false;
  engine.roomGroup.add(mesh);
  try {
    const views = segmentViews(input.box, input.top).map((v) => ({ ...v, up: [0, 1, 0] as [number, number, number] }));
    return await captureFixedViews(engine, views, { px: SEGMENT_IMAGE, quality: 0.85, settleMs: 900 });
  } finally {
    engine.roomGroup.remove(mesh);
    for (const child of hidden) child.visible = true;
    mesh.dispose();
    packed.dispose();
  }
}

/** 서버에 그림을 보내 시점마다 상자를 받는다 */
async function requestSegment(roomId: string, fixtureId: string, images: string[]): Promise<{ status: 'ok'; views: SegmentBoxes[]; remaining: number } | { status: 'limit' | 'error' }> {
  try {
    const res = await fetch(`/api/rooms/${roomId}/fixture-segment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fixtureId, images }),
    });
    const body = (await res.json().catch(() => null)) as { views?: SegmentBoxes[]; remaining?: number; error?: { code?: string } } | null;
    if (res.status === 429 || body?.error?.code === 'AI_LIMIT') return { status: 'limit' };
    if (!res.ok || !Array.isArray(body?.views) || body.views.length !== images.length) return { status: 'error' };
    return { status: 'ok', views: body.views, remaining: body.remaining ?? 0 };
  } catch {
    return { status: 'error' };
  }
}

/** 방 화면 엔진·방·원래 가구로 AI 분할 함수를 만든다 */
export function makeSegmentHook(engine: CaptureEngine, roomId: string, fixtureId: string): SegmentHook {
  return async (input) => {
    let images: string[];
    try {
      images = await capturePiece(engine, input);
    } catch (err) {
      console.error(err);
      return { status: 'error' };
    }
    const answer = await requestSegment(roomId, fixtureId, images);
    if (answer.status !== 'ok') return { status: answer.status };
    const views = segmentViews(input.box, input.top);
    const vote = voteSegment(input.points, input.candidate, views, answer.views);
    const trusted = trustSegment(vote);
    segmentDump()?.push({ fixtureId, images, views, boxes: answer.views, keep: vote.keep, usedViews: vote.usedViews, keptShare: vote.keptShare, trusted });
    return trusted ? { status: 'ok', keep: vote.keep, remaining: answer.remaining } : { status: 'untrusted', remaining: answer.remaining };
  };
}
