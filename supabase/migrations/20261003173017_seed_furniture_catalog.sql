-- 기본 가구 카탈로그 (원룸 기준 치수, 박스 모델). GLB는 이후 model_key로 연결한다.
insert into public.furniture_catalog (id, name_ko, category, width_m, depth_m, height_m, clearance_m, sort_order) values
  ('bed-single', '싱글 침대', 'bed', 1.00, 2.00, 0.45, 0.60, 10),
  ('bed-super-single', '슈퍼싱글 침대', 'bed', 1.10, 2.00, 0.45, 0.60, 20),
  ('bed-queen', '퀸 침대', 'bed', 1.50, 2.00, 0.45, 0.60, 30),
  ('desk', '책상', 'desk', 1.20, 0.60, 0.73, 0.70, 40),
  ('chair', '의자', 'chair', 0.50, 0.50, 0.80, 0.00, 50),
  ('wardrobe', '옷장', 'storage', 0.90, 0.60, 2.00, 0.60, 60),
  ('hanger', '행거', 'storage', 1.00, 0.45, 1.80, 0.60, 70),
  ('drawer', '서랍장', 'storage', 0.80, 0.45, 0.80, 0.60, 80),
  ('table-2', '2인 식탁', 'table', 0.80, 0.60, 0.72, 0.60, 90),
  ('bookcase', '책장', 'storage', 0.80, 0.30, 1.80, 0.60, 100)
on conflict (id) do nothing;
