-- 카탈로그 가구를 실사 3D 모델로 바꾼다. 파일은 R2의 furniture/catalog/v2/{id}.glb 에 있다
-- (scripts/dev-data/build-furniture-models.mjs 가 Amazon Berkeley Objects(CC BY 4.0) 원본을 압축해 올린다).
-- 치수는 모델(실제 판매 상품)의 실제 크기를 cm로 반올림한 값이다. 침대 높이는 머리판까지 잰다.
-- 슈퍼싱글은 싱글과 같은 모델을 폭만 넓혀 쓴다. 행거도 이제 모델이 있다.
update public.furniture_catalog as c
set width_m = v.width_m,
    depth_m = v.depth_m,
    height_m = v.height_m,
    model_key = 'furniture/catalog/v2/' || c.id || '.glb',
    license = 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0'
from (values
  ('bed-single', 0.99, 2.14, 0.92),
  ('bed-super-single', 1.10, 2.14, 0.92),
  ('bed-queen', 1.47, 1.99, 0.94),
  ('desk', 1.25, 0.60, 0.77),
  ('chair', 0.66, 0.60, 0.82),
  ('wardrobe', 1.00, 0.60, 1.96),
  ('hanger', 1.01, 0.40, 1.50),
  ('drawer', 0.80, 0.43, 0.80),
  ('table-2', 0.75, 0.75, 0.74),
  ('bookcase', 0.87, 0.36, 1.86)
) as v(id, width_m, depth_m, height_m)
where c.id = v.id;
