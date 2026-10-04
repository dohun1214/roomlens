-- 카탈로그 가구의 3D 모델. 파일은 R2의 furniture/catalog/{id}.glb 에 있다
-- (scripts/dev-data/build-furniture-models.mjs 가 Kenney Furniture Kit 2.0, CC0 에서 만들어 올린다).
-- 행거는 맞는 모델이 없어 상자로 둔다.
update public.furniture_catalog
set model_key = 'furniture/catalog/' || id || '.glb',
    license = 'Kenney Furniture Kit 2.0 (CC0)'
where id in ('bed-single', 'bed-super-single', 'bed-queen', 'desk', 'chair', 'wardrobe', 'drawer', 'table-2', 'bookcase');
