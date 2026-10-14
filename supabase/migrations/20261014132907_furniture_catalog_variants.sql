-- 카탈로그를 종류마다 두 가지 모양으로 늘리고(두 번째 id는 끝에 -b), 새 종류 8개를 더한다:
-- 소파, TV장, 협탁, 커피테이블, 신발장, 화장대, 수납 벤치, 스탠드 조명.
-- name_ko는 종류("책상", 배치 검사 문구·AI에 쓴다), style_ko는 같은 종류 안의 모양("서랍형", 목록에만 보인다).
-- 모델은 R2의 furniture/catalog/v2/{id}.glb (scripts/dev-data/build-furniture-models.mjs), 치수는 모델의 실제 크기.
alter table public.furniture_catalog add column if not exists style_ko text;

insert into public.furniture_catalog (id, name_ko, style_ko, category, width_m, depth_m, height_m, clearance_m, sort_order, license) values
  ('bed-single', '싱글 침대', '원목', 'bed', 0.99, 2.14, 0.92, 0.60, 10, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('bed-single-b', '싱글 침대', '철제', 'bed', 0.99, 1.93, 0.97, 0.60, 20, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('bed-super-single', '슈퍼싱글 침대', '원목', 'bed', 1.10, 2.14, 0.92, 0.60, 30, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('bed-super-single-b', '슈퍼싱글 침대', '철제', 'bed', 1.10, 1.93, 0.97, 0.60, 40, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('bed-queen', '퀸 침대', '원목', 'bed', 1.47, 1.99, 0.94, 0.60, 50, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('bed-queen-b', '퀸 침대', '철제', 'bed', 1.52, 2.06, 0.97, 0.60, 60, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('desk', '책상', '서랍형', 'desk', 1.25, 0.60, 0.77, 0.70, 70, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('desk-b', '책상', '철제 다리', 'desk', 1.20, 0.60, 0.75, 0.70, 80, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('chair', '의자', '회전', 'chair', 0.66, 0.60, 0.82, 0.00, 90, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('chair-b', '의자', '원목', 'chair', 0.50, 0.50, 0.80, 0.00, 100, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('wardrobe', '옷장', '원목', 'storage', 1.00, 0.60, 1.96, 0.60, 110, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('wardrobe-b', '옷장', '화이트', 'storage', 0.86, 0.60, 2.04, 0.60, 120, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('hanger', '행거', '선반형', 'storage', 1.01, 0.40, 1.50, 0.60, 130, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('hanger-b', '행거', '심플', 'storage', 0.90, 0.50, 1.50, 0.60, 140, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('drawer', '서랍장', '원목', 'storage', 0.80, 0.43, 0.80, 0.60, 150, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('drawer-b', '서랍장', '화이트', 'storage', 0.91, 0.46, 0.72, 0.60, 160, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('table-2', '2인 식탁', '정사각', 'table', 0.75, 0.75, 0.74, 0.60, 170, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('table-2-b', '2인 식탁', '원목', 'table', 1.03, 0.76, 0.76, 0.60, 180, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('bookcase', '책장', '철제', 'storage', 0.87, 0.36, 1.86, 0.60, 190, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('bookcase-b', '책장', '화이트', 'storage', 1.00, 0.26, 2.08, 0.60, 200, 'Poly Haven (CC0)'),
  ('sofa', '소파', '화이트', 'sofa', 1.70, 0.96, 0.89, 0.60, 210, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('sofa-b', '소파', '차콜', 'sofa', 1.75, 0.97, 0.92, 0.60, 220, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('tv-stand', 'TV장', '원목', 'storage', 1.60, 0.42, 0.55, 0.50, 230, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('tv-stand-b', 'TV장', '블랙', 'storage', 1.31, 0.39, 0.52, 0.50, 240, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('nightstand', '협탁', '원목', 'storage', 0.56, 0.44, 0.47, 0.00, 250, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('nightstand-b', '협탁', '화이트', 'storage', 0.40, 0.36, 0.56, 0.00, 260, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('coffee-table', '커피테이블', '화이트', 'table', 1.20, 0.60, 0.45, 0.00, 270, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('coffee-table-b', '커피테이블', '원목', 'table', 1.19, 0.61, 0.33, 0.00, 280, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('shoe-cabinet', '신발장', '화이트', 'storage', 0.52, 0.26, 1.63, 0.50, 290, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('shoe-cabinet-b', '신발장', '블랙', 'storage', 0.75, 0.25, 1.28, 0.50, 300, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('vanity', '화장대', '거울·의자 세트', 'desk', 0.88, 1.21, 1.63, 0.30, 310, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('vanity-b', '화장대', '서랍형', 'desk', 0.93, 0.38, 0.79, 0.70, 320, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('bench', '수납 벤치', '블랙', 'chair', 0.97, 0.35, 0.56, 0.00, 330, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('bench-b', '수납 벤치', '화이트', 'chair', 1.14, 0.40, 0.50, 0.00, 340, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('floor-lamp', '스탠드 조명', '갓', 'lamp', 0.34, 0.34, 1.54, 0.00, 350, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'),
  ('floor-lamp-b', '스탠드 조명', '구형', 'lamp', 0.22, 0.22, 1.75, 0.00, 360, 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0')
on conflict (id) do update set
  name_ko = excluded.name_ko,
  style_ko = excluded.style_ko,
  category = excluded.category,
  width_m = excluded.width_m,
  depth_m = excluded.depth_m,
  height_m = excluded.height_m,
  clearance_m = excluded.clearance_m,
  sort_order = excluded.sort_order,
  license = excluded.license;

update public.furniture_catalog set model_key = 'furniture/catalog/v2/' || id || '.glb';
