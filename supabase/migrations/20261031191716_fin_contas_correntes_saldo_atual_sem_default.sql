-- ============================================================================================
-- fin_contas_correntes.saldo_atual sem DEFAULT 0 — conta sem extrato nasce NULL, nao "R$ 0"
-- (plano v3, item 2: o PRODUTOR do saldo ausente)
-- ============================================================================================
-- O unico writer da tabela e o omie-financeiro (sync_contas_correntes): upsert onConflict
-- (company, omie_ncodcc) que so inclui saldo_atual/saldo_data quando o ListarExtrato respondeu.
-- Conta EXISTENTE com extrato falho: o upsert nao toca as duas colunas (preserva o saldo anterior).
-- Conta NOVA com extrato falho: o INSERT omite as duas, e o DEFAULT 0 fabricava saldo_atual = 0 com
-- saldo_data NULL. Os consumidores ja leem saldo_data NULL como ausente (#3347, #3383, #3400 e o
-- sensor saldo_bancario), entao o 0 nao chega mais a soma; esta migration fecha o produtor
-- (money-path §2: consumidor antes do produtor; o par certo e os dois).
--
-- Medido em prod (psql-ro, 2026-10-31 ~19:00Z): saldo_atual numeric, nullable, DEFAULT 0; 62 linhas
-- (40 ativas), 0 com saldo_data NULL, 0 com saldo_atual NULL. Nenhuma funcao SQL escreve na tabela
-- (pg_proc), nenhum trigger. Sem backfill: nao ha linha nascida do DEFAULT sem extrato.
-- Idempotente: DROP DEFAULT sem default e no-op.
-- `bun run db:aplicar` fornece a transacao (por isso NAO ha BEGIN/COMMIT aqui).
-- Prova: db/test-data-health-saldo-bancario-conta-a-conta.sh (bloco do DEFAULT).
-- ============================================================================================

ALTER TABLE public.fin_contas_correntes ALTER COLUMN saldo_atual DROP DEFAULT;

DO $post$
DECLARE
  v_default text;
  v_nullable text;
  v_existe boolean;
BEGIN
  SELECT true, c.column_default, c.is_nullable INTO v_existe, v_default, v_nullable
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'fin_contas_correntes' AND c.column_name = 'saldo_atual';
  IF v_existe IS NOT TRUE THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: public.fin_contas_correntes.saldo_atual ausente.';
  END IF;
  IF v_default IS NOT NULL OR v_nullable IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: saldo_atual com default % e nullable % (esperado sem default e nullable YES).',
                    COALESCE(v_default, '<NULL>'), COALESCE(v_nullable, '<NULL>');
  END IF;
END
$post$;
