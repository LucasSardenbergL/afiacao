-- Step 1: Transfer 5 omie mappings to the numeric SKUs (that we're keeping)
UPDATE tint_skus SET omie_product_id = '48cf30a7-6c74-4f88-bb45-5cccc372cc0b' WHERE id = '553f0bd7-dfc5-4172-b46c-3ea5d083c4dc' AND omie_product_id IS NULL;
UPDATE tint_skus SET omie_product_id = 'a25de0c6-c2c5-47da-9d56-dad59d212ae2' WHERE id = '47f05a85-ac93-4f69-85ca-7eb9d67a165c' AND omie_product_id IS NULL;
UPDATE tint_skus SET omie_product_id = '97251836-a709-49d9-8da6-366c9595ab6d' WHERE id = 'f717c572-137a-4dd5-8c07-3e21b7dec516' AND omie_product_id IS NULL;
UPDATE tint_skus SET omie_product_id = '81728370-1266-4321-9a19-5496f12d3b44' WHERE id = '0fbe5700-d251-4a37-ab97-ab0dc9bbda98' AND omie_product_id IS NULL;
UPDATE tint_skus SET omie_product_id = '563592e1-509b-47db-9b9a-b221b63009d4' WHERE id = 'c3823aca-f57f-47a3-8c46-10afe101bca1' AND omie_product_id IS NULL;

-- Step 2: Delete the descriptive SKUs (0 formulas, safe to delete)
DELETE FROM tint_skus 
WHERE account = 'oben'
AND embalagem_id IN (
  '7661aeec-20c7-435b-b7ba-de727cafd576',
  '4faa29e7-98d5-46ed-8ed6-5a6410babfbe',
  '3d6d2db1-5997-4af3-962e-73eba872f466',
  'a7d45160-7b9b-4e57-b53d-388af124360d'
);

-- Step 3: Delete the descriptive embalagens (now orphaned)
DELETE FROM tint_embalagens WHERE id IN (
  '7661aeec-20c7-435b-b7ba-de727cafd576',
  '4faa29e7-98d5-46ed-8ed6-5a6410babfbe',
  '3d6d2db1-5997-4af3-962e-73eba872f466',
  'a7d45160-7b9b-4e57-b53d-388af124360d'
);

-- Step 4: Rename the remaining embalagens to descriptive names
UPDATE tint_embalagens SET descricao = '405 ML', volume_ml = 405 WHERE id = '35a875d9-c673-4ad7-9781-629e4aee6d99';
UPDATE tint_embalagens SET descricao = 'QT (0.810 L)', volume_ml = 810 WHERE id = 'd94969a2-badf-46d5-85ca-f0bf3cb9d72b';
UPDATE tint_embalagens SET descricao = 'GL (3.240 L)', volume_ml = 3240 WHERE id = '9179e165-2ea2-42c3-a9d4-c962f1cfc00f';
UPDATE tint_embalagens SET descricao = 'BH (18 L)', volume_ml = 18000 WHERE id = 'a0da0890-26dd-4688-aaed-fba90d9f7461';

-- Step 5: Clean up orphaned bases (those not referenced by any SKU)
DELETE FROM tint_bases tb
WHERE tb.account = 'oben'
AND NOT EXISTS (SELECT 1 FROM tint_skus ts WHERE ts.base_id = tb.id);

-- Step 6: Clean up orphaned produtos
DELETE FROM tint_produtos tp
WHERE tp.account = 'oben'
AND NOT EXISTS (SELECT 1 FROM tint_skus ts WHERE ts.produto_id = tp.id);