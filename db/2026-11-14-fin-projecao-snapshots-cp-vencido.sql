-- ============================================================================================
-- CP vencido FORA da projeção de 13 semanas, em colunas DEDICADAS do snapshot (edge fin-cashflow-engine v2.4).
-- Diagnóstico: docs/historico/cp-atrasado-fora-da-projecao.md (PR #3440).
--
-- Sem BEGIN/COMMIT: a transação é do executor (`bun run db:aplicar`, que também grava a trilha). O NOTIFY
-- do fim é entregue no COMMIT dela.
--
-- O laço de semanas só põe um CP numa semana se o vencimento cai nela, a partir da segunda-feira corrente.
-- O CP aberto vencido ANTES dessa segunda não cai em semana nenhuma e sumia calado. MEDIDO (psql-ro,
-- 14/11/2026, mesmo predicado da edge): oben 164 títulos / R$ 687.207,50 · colacor 184 / R$ 337.742,94 ·
-- colacor_sc 91 / R$ 125.026,33. DECISÃO DO FOUNDER (14/11/2026): só tornar VISÍVEL — nenhum saldo muda e
-- esses títulos não entram em semana nenhuma até a conferência título a título.
--
-- 1 writer: o cron diário da edge (`save_snapshot`). Sinal money-path nunca em `premissas` (jsonb
-- multi-chave). Os 3 cenários repetem a MESMA exposição: série histórica lê o `realista`, nunca soma.
-- Ausente = TODAS NULL (snapshot de versão anterior, não medido) — sem DEFAULT 0. Medido sem título =
-- qtd 0, valores 0, data NULL. Medido com título = qtd > 0, data presente, Σ faixas = total.
--
-- Aditiva e idempotente (ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS). ORDEM DE DEPLOY: ESTE
-- arquivo → edge v2.4 (o INSERT nomeia as colunas; sem elas o snapshot diário falha alto). Postcondição no fim.
-- Ensaio: `bun run db:aplicar db/2026-11-14-fin-projecao-snapshots-cp-vencido.sql --ensaio`.
-- ============================================================================================

ALTER TABLE public.fin_projecao_snapshots
  ADD COLUMN IF NOT EXISTS cp_vencido_fora_qtd integer,
  ADD COLUMN IF NOT EXISTS cp_vencido_fora_total numeric,
  ADD COLUMN IF NOT EXISTS cp_vencido_fora_mais_antigo date,
  ADD COLUMN IF NOT EXISTS cp_vencido_fora_ate_30 numeric,
  ADD COLUMN IF NOT EXISTS cp_vencido_fora_31_60 numeric,
  ADD COLUMN IF NOT EXISTS cp_vencido_fora_61_180 numeric,
  ADD COLUMN IF NOT EXISTS cp_vencido_fora_acima_180 numeric;

COMMENT ON COLUMN public.fin_projecao_snapshots.cp_vencido_fora_total IS
  'R$ de CP aberto vencido antes da segunda-feira corrente, FORA de todas as semanas da projeção (só medida, edge v2.4). NULL = não medido.';

-- Faixa fechada (guard numérico fecha FAIXA, não só sinal): NaN e teto de negócio.
ALTER TABLE public.fin_projecao_snapshots DROP CONSTRAINT IF EXISTS fin_projecao_snapshots_cp_vencido_faixa_ck;
ALTER TABLE public.fin_projecao_snapshots ADD CONSTRAINT fin_projecao_snapshots_cp_vencido_faixa_ck CHECK (
  (cp_vencido_fora_qtd IS NULL OR (cp_vencido_fora_qtd >= 0 AND cp_vencido_fora_qtd < 1000000))
  AND (cp_vencido_fora_total IS NULL OR (cp_vencido_fora_total <> 'NaN' AND cp_vencido_fora_total >= 0 AND cp_vencido_fora_total < 10000000000))
  AND (cp_vencido_fora_ate_30 IS NULL OR (cp_vencido_fora_ate_30 <> 'NaN' AND cp_vencido_fora_ate_30 >= 0))
  AND (cp_vencido_fora_31_60 IS NULL OR (cp_vencido_fora_31_60 <> 'NaN' AND cp_vencido_fora_31_60 >= 0))
  AND (cp_vencido_fora_61_180 IS NULL OR (cp_vencido_fora_61_180 <> 'NaN' AND cp_vencido_fora_61_180 >= 0))
  AND (cp_vencido_fora_acima_180 IS NULL OR (cp_vencido_fora_acima_180 <> 'NaN' AND cp_vencido_fora_acima_180 >= 0))
);

-- Coerência: tudo ausente, ou medição vazia (0/0/NULL), ou medição positiva com data e faixas que fecham.
ALTER TABLE public.fin_projecao_snapshots DROP CONSTRAINT IF EXISTS fin_projecao_snapshots_cp_vencido_coerencia_ck;
ALTER TABLE public.fin_projecao_snapshots ADD CONSTRAINT fin_projecao_snapshots_cp_vencido_coerencia_ck CHECK (
  (cp_vencido_fora_qtd IS NULL AND cp_vencido_fora_total IS NULL AND cp_vencido_fora_mais_antigo IS NULL
    AND cp_vencido_fora_ate_30 IS NULL AND cp_vencido_fora_31_60 IS NULL
    AND cp_vencido_fora_61_180 IS NULL AND cp_vencido_fora_acima_180 IS NULL)
  OR (cp_vencido_fora_qtd IS NOT NULL AND cp_vencido_fora_total IS NOT NULL
    AND cp_vencido_fora_ate_30 IS NOT NULL AND cp_vencido_fora_31_60 IS NOT NULL
    AND cp_vencido_fora_61_180 IS NOT NULL AND cp_vencido_fora_acima_180 IS NOT NULL
    AND cp_vencido_fora_ate_30 + cp_vencido_fora_31_60 + cp_vencido_fora_61_180 + cp_vencido_fora_acima_180 = cp_vencido_fora_total
    AND ((cp_vencido_fora_qtd = 0 AND cp_vencido_fora_total = 0 AND cp_vencido_fora_mais_antigo IS NULL)
      OR (cp_vencido_fora_qtd > 0 AND cp_vencido_fora_total > 0 AND cp_vencido_fora_mais_antigo IS NOT NULL)))
);

DO $post$
DECLARE v_col text;
BEGIN
  FOREACH v_col IN ARRAY ARRAY['cp_vencido_fora_qtd', 'cp_vencido_fora_total', 'cp_vencido_fora_mais_antigo',
                               'cp_vencido_fora_ate_30', 'cp_vencido_fora_31_60', 'cp_vencido_fora_61_180',
                               'cp_vencido_fora_acima_180'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'fin_projecao_snapshots' AND column_name = v_col) THEN
      RAISE EXCEPTION 'P1 FALHOU: coluna % ausente em fin_projecao_snapshots', v_col;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.fin_projecao_snapshots'::regclass
      AND conname IN ('fin_projecao_snapshots_cp_vencido_faixa_ck', 'fin_projecao_snapshots_cp_vencido_coerencia_ck')) <> 2 THEN
    RAISE EXCEPTION 'P2 FALHOU: CHECKs de faixa/coerencia ausentes';
  END IF;
  -- Nenhum DEFAULT: ausente tem de continuar NULL (um DEFAULT 0 fabricaria "zero vencido" nos snapshots antigos).
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'fin_projecao_snapshots'
               AND column_name LIKE 'cp\_vencido\_fora\_%' AND column_default IS NOT NULL) THEN
    RAISE EXCEPTION 'P3 FALHOU: coluna cp_vencido_fora_* com DEFAULT';
  END IF;
  -- Sem assert com corte de tempo sobre os dados: reaplicar (ou --ensaio) depois que o cron já gravou
  -- snapshots v2.4 é legítimo; a coerência de cada linha é garantida pelos CHECKs acima (achado Codex).
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.fin_projecao_snapshots'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'P4 FALHOU: fin_projecao_snapshots sem RLS';
  END IF;
  RAISE NOTICE 'FIN-PROJECAO-SNAPSHOTS-CP-VENCIDO-OK';
END
$post$;

-- O PostgREST só enxerga coluna nova depois do reload do cache de schema (etapa distinta do DDL).
NOTIFY pgrst, 'reload schema';
