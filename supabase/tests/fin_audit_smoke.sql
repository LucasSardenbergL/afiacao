-- Smoke test: audit trail captura INSERT, UPDATE, DELETE
-- Rodar com: bunx supabase db execute < supabase/tests/fin_audit_smoke.sql
-- Cada bloco é BEGIN/ROLLBACK pra não deixar lixo.

BEGIN;
  -- INSERT
  INSERT INTO fin_categoria_dre_mapping (company, omie_codigo, dre_linha)
  VALUES ('_default', 'smoke_test_999', 'despesas_operacionais');

  -- UPDATE
  UPDATE fin_categoria_dre_mapping
     SET dre_linha = 'despesas_administrativas'
   WHERE omie_codigo = 'smoke_test_999';

  -- DELETE
  DELETE FROM fin_categoria_dre_mapping WHERE omie_codigo = 'smoke_test_999';

  -- Verificar que 3 entries de audit foram criadas
  SELECT op, COUNT(*) AS qtd
    FROM fin_audit_log
   WHERE table_name = 'fin_categoria_dre_mapping'
     AND (changed_fields->>'omie_codigo' = 'smoke_test_999'
          OR changed_fields->'omie_codigo'->>'after' = 'smoke_test_999'
          OR changed_fields->'omie_codigo'->>'before' = 'smoke_test_999')
   GROUP BY op
   ORDER BY op;
  -- Expected: DELETE 1, INSERT 1, UPDATE 1

ROLLBACK;
