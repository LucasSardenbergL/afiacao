UPDATE omie_products 
SET is_tintometric = true, tint_type = 'base' 
WHERE account = 'oben' 
  AND id IN (
    SELECT id FROM omie_products 
    WHERE account = 'oben' 
      AND is_tintometric = false 
      AND (
        descricao ILIKE '%WJOT.7585%' 
        OR descricao ILIKE '%WFBT.6045%'
      )
      AND descricao NOT ILIKE '%SPRAY%'
  );