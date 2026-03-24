UPDATE tint_skus 
SET ativo = false 
WHERE embalagem_id IN (
  SELECT id FROM tint_embalagens WHERE descricao ILIKE '%405%'
) AND ativo = true;