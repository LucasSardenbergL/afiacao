-- ============================================================================================
-- Composição da NCG em colunas DEDICADAS do snapshot (edge fin-cashflow-engine v2.5).
-- Fase 5 da Visão do CEO — diário: docs/historico/ceo-placar-honesto.md.
--
-- Sem BEGIN/COMMIT: a transação é do executor (`bun run db:aplicar`, que também grava a trilha). O NOTIFY
-- do fim é entregue no COMMIT dela.
--
-- Até a v2.4 o snapshot só gravava `ncg` (o total). `calcularNCG` já separava ACO (CR aberto + estoque +
-- adiantamentos) e PCO (CP fornecedor + folha 30 d + tributos a pagar), mas a separação morria na resposta.
-- A v2.5 grava as 6 parcelas. 1 writer: o cron diário da edge (`save_snapshot`). Sinal money-path nunca em
-- `premissas` (jsonb multi-chave).
--
-- Ausente ≠ zero:
--   - snapshot anterior à v2.5 = as 6 colunas NULL (não medido) — sem DEFAULT 0;
--   - medido = CR, CP fornecedor, folha e tributos presentes, fechando com `ncg` (folga de 5 centavos; o
--     helper da edge exige 4, para o float do JS nunca cruzar a fronteira que o numeric recusa);
--   - estoque sem fonte = `ncg_estoque` NULL com o CR presente = NCG PARCIAL;
--   - empresa sem categoria de adiantamento configurada = `ncg_adiantamentos` NULL (não segregado: o
--     adiantamento, se houver, está dentro de `ncg_cp_fornecedor`).
-- Leitor: `ncg_cr_aberto IS NULL` = não medido; só com ele presente os outros NULL têm significado.
--
-- Aditiva e idempotente (ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS). ORDEM DE DEPLOY: ESTE
-- arquivo → edge v2.5 (o INSERT nomeia as colunas; sem elas o snapshot diário falha alto). Postcondição no fim.
-- Ensaio: `bun run db:aplicar db/2026-11-22-fin-projecao-snapshots-ncg-composicao.sql --ensaio`.
-- ============================================================================================

ALTER TABLE public.fin_projecao_snapshots
  ADD COLUMN IF NOT EXISTS ncg_cr_aberto numeric,
  ADD COLUMN IF NOT EXISTS ncg_estoque numeric,
  ADD COLUMN IF NOT EXISTS ncg_adiantamentos numeric,
  ADD COLUMN IF NOT EXISTS ncg_cp_fornecedor numeric,
  ADD COLUMN IF NOT EXISTS ncg_folha_30d numeric,
  ADD COLUMN IF NOT EXISTS ncg_tributos_a_pagar numeric;

COMMENT ON COLUMN public.fin_projecao_snapshots.ncg_estoque IS
  'R$ de estoque no ACO da NCG (edge v2.5). NULL com ncg_cr_aberto presente = NCG parcial (sem fonte de estoque); tudo NULL = não medido.';

-- Faixa fechada (guard numérico fecha FAIXA, não só sinal): NaN e teto de negócio.
ALTER TABLE public.fin_projecao_snapshots DROP CONSTRAINT IF EXISTS fin_projecao_snapshots_ncg_composicao_faixa_ck;
ALTER TABLE public.fin_projecao_snapshots ADD CONSTRAINT fin_projecao_snapshots_ncg_composicao_faixa_ck CHECK (
  (ncg_cr_aberto IS NULL OR (ncg_cr_aberto <> 'NaN' AND ncg_cr_aberto >= 0 AND ncg_cr_aberto < 10000000000))
  AND (ncg_estoque IS NULL OR (ncg_estoque <> 'NaN' AND ncg_estoque >= 0 AND ncg_estoque < 10000000000))
  AND (ncg_adiantamentos IS NULL OR (ncg_adiantamentos <> 'NaN' AND ncg_adiantamentos >= 0 AND ncg_adiantamentos < 10000000000))
  AND (ncg_cp_fornecedor IS NULL OR (ncg_cp_fornecedor <> 'NaN' AND ncg_cp_fornecedor >= 0 AND ncg_cp_fornecedor < 10000000000))
  AND (ncg_folha_30d IS NULL OR (ncg_folha_30d <> 'NaN' AND ncg_folha_30d >= 0 AND ncg_folha_30d < 10000000000))
  AND (ncg_tributos_a_pagar IS NULL OR (ncg_tributos_a_pagar <> 'NaN' AND ncg_tributos_a_pagar >= 0 AND ncg_tributos_a_pagar < 10000000000))
);

-- Coerência: tudo ausente (não medido), ou as 4 obrigatórias presentes fechando com o total `ncg`.
-- Estoque e adiantamentos entram por COALESCE: NULL é a parcela que o total também somou como ausente.
ALTER TABLE public.fin_projecao_snapshots DROP CONSTRAINT IF EXISTS fin_projecao_snapshots_ncg_composicao_coerencia_ck;
ALTER TABLE public.fin_projecao_snapshots ADD CONSTRAINT fin_projecao_snapshots_ncg_composicao_coerencia_ck CHECK (
  (ncg_cr_aberto IS NULL AND ncg_estoque IS NULL AND ncg_adiantamentos IS NULL
    AND ncg_cp_fornecedor IS NULL AND ncg_folha_30d IS NULL AND ncg_tributos_a_pagar IS NULL)
  OR (ncg_cr_aberto IS NOT NULL
    AND ncg_cp_fornecedor IS NOT NULL
    AND ncg_folha_30d IS NOT NULL
    AND ncg_tributos_a_pagar IS NOT NULL
    AND ncg IS NOT NULL
    AND abs(ncg_cr_aberto + COALESCE(ncg_estoque, 0) + COALESCE(ncg_adiantamentos, 0)
            - ncg_cp_fornecedor - ncg_folha_30d - ncg_tributos_a_pagar - ncg) <= 0.05)
);

DO $post$
DECLARE v_col text;
BEGIN
  FOREACH v_col IN ARRAY ARRAY['ncg_cr_aberto', 'ncg_estoque', 'ncg_adiantamentos',
                               'ncg_cp_fornecedor', 'ncg_folha_30d', 'ncg_tributos_a_pagar'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'fin_projecao_snapshots' AND column_name = v_col) THEN
      RAISE EXCEPTION 'P1 FALHOU: coluna % ausente em fin_projecao_snapshots', v_col;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.fin_projecao_snapshots'::regclass
      AND conname IN ('fin_projecao_snapshots_ncg_composicao_faixa_ck', 'fin_projecao_snapshots_ncg_composicao_coerencia_ck')) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'P2 FALHOU: CHECKs de faixa/coerencia da composicao da NCG ausentes';
  END IF;
  -- Nenhum DEFAULT: ausente tem de continuar NULL (um DEFAULT 0 fabricaria "NCG sem recebível" nos snapshots antigos).
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'fin_projecao_snapshots'
               AND column_name IN ('ncg_cr_aberto', 'ncg_estoque', 'ncg_adiantamentos',
                                   'ncg_cp_fornecedor', 'ncg_folha_30d', 'ncg_tributos_a_pagar')
               AND column_default IS NOT NULL) THEN
    RAISE EXCEPTION 'P3 FALHOU: coluna ncg_* com DEFAULT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.fin_projecao_snapshots'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'P4 FALHOU: fin_projecao_snapshots sem RLS';
  END IF;
  RAISE NOTICE 'FIN-PROJECAO-SNAPSHOTS-NCG-COMPOSICAO-OK';
END
$post$;

-- O PostgREST só enxerga coluna nova depois do reload do cache de schema (etapa distinta do DDL).
NOTIFY pgrst, 'reload schema';
