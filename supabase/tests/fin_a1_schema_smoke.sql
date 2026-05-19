-- Smoke: A1 schema funciona ponta a ponta
-- Rodar com: psql ou Supabase SQL Editor
-- Tudo em BEGIN/ROLLBACK pra não deixar lixo.

BEGIN;

INSERT INTO fin_eventos_recorrentes (
  company, descricao, valor, tipo, categoria_dre, is_folha,
  dia_do_mes, inicio
) VALUES (
  'colacor', 'Folha de pagamento', 50000, 'saida', 'despesas_administrativas', true,
  5, '2026-05-01'
);

INSERT INTO fin_eventos_eventuais (
  company, descricao, valor, tipo, data_prevista, status
) VALUES (
  'colacor', 'Aporte sócio', 100000, 'entrada', '2026-08-01', 'previsto'
);

INSERT INTO fin_alertas (company, tipo, severidade, mensagem)
VALUES ('colacor', 'caixa_negativo', 'critico', 'teste 1');

DO $$
BEGIN
  BEGIN
    INSERT INTO fin_alertas (company, tipo, severidade, mensagem)
    VALUES ('colacor', 'caixa_negativo', 'critico', 'teste 2');
    RAISE EXCEPTION 'EXPECTED_FAILURE: unique constraint não bloqueou alerta duplicado';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK: unique constraint bloqueou alerta duplicado conforme esperado';
  END;
END $$;

UPDATE fin_alertas SET dismissed_at = now()
 WHERE company = 'colacor' AND tipo = 'caixa_negativo';

INSERT INTO fin_alertas (company, tipo, severidade, mensagem)
VALUES ('colacor', 'caixa_negativo', 'critico', 'teste 3 após dismiss');

SELECT COUNT(*) AS qtd_config FROM fin_config_cashflow;
-- Expected: 3

SELECT table_name, COUNT(*) AS qtd
  FROM fin_audit_log
 WHERE table_name IN ('fin_eventos_recorrentes', 'fin_eventos_eventuais',
                      'fin_alertas', 'fin_config_cashflow')
   AND op = 'INSERT'
   AND changed_at > now() - interval '1 minute'
 GROUP BY table_name
 ORDER BY table_name;
-- Expected: 4 linhas

ROLLBACK;
