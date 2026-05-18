-- Smoke: travamento bloqueia edit em período fechado
-- Pré-requisito: existir 1 fechamento 'fechado' com aprovado_em IS NOT NULL
-- pra empresa colacor em ano/mes anteriores

BEGIN;
  -- Garantir um fechamento aprovado de 2025-01 pra colacor
  INSERT INTO fin_fechamentos (company, ano, mes, status, aprovado_em, aprovado_por)
  VALUES ('colacor', 2025, 1, 'fechado', now(), '00000000-0000-0000-0000-000000000001'::uuid)
  ON CONFLICT (company, ano, mes, versao) DO UPDATE
    SET status='fechado', aprovado_em=now();

  -- Tentar inserir CR em 2025-01-15: deve falhar com P0001
  DO $$
  BEGIN
    BEGIN
      INSERT INTO fin_contas_receber (company, omie_codigo_lancamento, data_emissao, valor_documento)
      VALUES ('colacor', 999999, '2025-01-15', 100);
      RAISE EXCEPTION 'EXPECTED_FAILURE: travamento não disparou';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      RAISE NOTICE 'OK: travamento disparou conforme esperado: %', SQLERRM;
    END;
  END $$;

  -- Inserir em 2026-01-15 (período aberto): deve passar
  INSERT INTO fin_contas_receber (company, omie_codigo_lancamento, data_emissao, valor_documento)
  VALUES ('colacor', 999998, '2026-01-15', 100);
  SELECT 'OK: insert em período aberto passou' AS resultado;

ROLLBACK;
