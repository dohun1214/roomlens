import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { DEFAULT_CATALOG } from '@/lib/layout/catalog';
import { baseFurnitureId, furnitureTone, glyphKind } from '@/lib/layout/furnitureLook';

describe('가구 그림', () => {
  it('두 번째 모양(-b)은 첫 번째와 같은 그림', () => {
    expect(baseFurnitureId('desk-b')).toBe('desk');
    expect(baseFurnitureId('table-2')).toBe('table-2');
    expect(glyphKind('bed-queen-b', 'bed')).toBe(glyphKind('bed-queen', 'bed'));
    expect(glyphKind('sofa-b', 'sofa')).toBe('sofa');
    expect(glyphKind('floor-lamp', 'lamp')).toBe('lamp');
  });

  it('모르는 id는 분류로, 분류도 모르면 상자', () => {
    expect(glyphKind('u1', 'sofa')).toBe('sofa');
    expect(glyphKind('u1', 'etc')).toBe('box');
  });

  it('새 분류(소파·조명)에도 색이 있다', () => {
    expect(furnitureTone('sofa').tile).not.toBe(furnitureTone('unknown').tile);
    expect(furnitureTone('lamp').tile).not.toBe(furnitureTone('unknown').tile);
  });

  it('카탈로그 가구마다 목록에 넣을 모델 사진이 있다', () => {
    for (const item of DEFAULT_CATALOG) expect(existsSync(`public/furniture/${item.id}.webp`), item.id).toBe(true);
  });
});
