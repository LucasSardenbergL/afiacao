-- ============================================================================================
-- Série diária de ESTOQUE DE GIRO no snapshot de projeção — PME por estoque MÉDIO (Frente A, item 3).
-- Spec: docs/superpowers/specs/2026-10-31-oben-pme-pmr-plano-design.md §4. Diário: docs/historico/oben-pme-pmr-frente-a.md.
--
-- MEDIDO (psql-ro, 2026-10-31): `fin_projecao_snapshots` NÃO guarda o estoque — só `dados` (semanas), `ncg`,
-- `liquidez_operacional_liquida`, `saldo_tesouraria`, `dias_cobertura` e `premissas` (jsonb multi-chave, onde
-- `estoque_fonte` só entra como marca). Não há histórico diário de saldo por SKU em lugar nenhum
-- (`cmc_ledger.saldo` só muda com o CMC). Logo o PME por estoque médio dos 90 d não é reconstruível: a série
-- NASCE AQUI, em colunas dedicadas (sinal money-path nunca em jsonb multi-writer), com 1 writer — o cron
-- diário da edge `fin-cashflow-engine` (`save_snapshot`, cenário realista, 10:00Z). Ausente = NULL (estoque
-- sem fonte), nunca 0; `estoque_cobertura_ok=false` marca subtotal (custo < 95% dos SKUs de giro).
--
-- Aditiva e idempotente (ADD COLUMN IF NOT EXISTS). Ordem de deploy: ESTA migration → edge (o INSERT da edge
-- nomeia as colunas; sem elas o snapshot diário falharia alto). Postcondição no fim.
-- Aplicação: `bun run db:aplicar supabase/migrations/20261031210000_fin_projecao_snapshots_estoque.sql`.
-- ============================================================================================

ALTER TABLE public.fin_projecao_snapshots
  ADD COLUMN IF NOT EXISTS estoque_valor numeric,
  ADD COLUMN IF NOT EXISTS estoque_fonte text,
  ADD COLUMN IF NOT EXISTS estoque_cobertura_ok boolean,
  ADD COLUMN IF NOT EXISTS cmv_ttm numeric;

-- Faixa fechada (money-path: guard numérico fecha FAIXA, não só sinal): NaN/Infinity e teto de negócio.
ALTER TABLE public.fin_projecao_snapshots DROP CONSTRAINT IF EXISTS fin_projecao_snapshots_estoque_valor_ck;
ALTER TABLE public.fin_projecao_snapshots ADD CONSTRAINT fin_projecao_snapshots_estoque_valor_ck
  CHECK (estoque_valor IS NULL OR (estoque_valor <> 'NaN' AND estoque_valor >= 0 AND estoque_valor < 100000000));
ALTER TABLE public.fin_projecao_snapshots DROP CONSTRAINT IF EXISTS fin_projecao_snapshots_estoque_fonte_ck;
ALTER TABLE public.fin_projecao_snapshots ADD CONSTRAINT fin_projecao_snapshots_estoque_fonte_ck
  CHECK (estoque_fonte IS NULL OR estoque_fonte IN ('manual', 'omie'));
ALTER TABLE public.fin_projecao_snapshots DROP CONSTRAINT IF EXISTS fin_projecao_snapshots_cmv_ttm_ck;
ALTER TABLE public.fin_projecao_snapshots ADD CONSTRAINT fin_projecao_snapshots_cmv_ttm_ck
  CHECK (cmv_ttm IS NULL OR (cmv_ttm <> 'NaN' AND cmv_ttm > 0 AND cmv_ttm < 1000000000));
-- Valor sem fonte é fabricação: ou os dois vêm, ou nenhum.
ALTER TABLE public.fin_projecao_snapshots DROP CONSTRAINT IF EXISTS fin_projecao_snapshots_estoque_par_ck;
ALTER TABLE public.fin_projecao_snapshots ADD CONSTRAINT fin_projecao_snapshots_estoque_par_ck
  CHECK ((estoque_valor IS NULL) = (estoque_fonte IS NULL));

-- Leitura da série (90 d, cenário realista) por empresa e dia — o consumidor é a aba Ciclo.
CREATE INDEX IF NOT EXISTS idx_fin_projecao_snapshots_serie_estoque
  ON public.fin_projecao_snapshots (company, cenario, snapshot_at DESC)
  WHERE estoque_fonte IS NOT NULL;

DO $post$
DECLARE v_col text;
BEGIN
  FOREACH v_col IN ARRAY ARRAY['estoque_valor', 'estoque_fonte', 'estoque_cobertura_ok', 'cmv_ttm'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'fin_projecao_snapshots' AND column_name = v_col) THEN
      RAISE EXCEPTION 'P1 FALHOU: coluna % ausente em fin_projecao_snapshots', v_col;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.fin_projecao_snapshots'::regclass
      AND conname IN ('fin_projecao_snapshots_estoque_valor_ck', 'fin_projecao_snapshots_estoque_fonte_ck',
                      'fin_projecao_snapshots_cmv_ttm_ck', 'fin_projecao_snapshots_estoque_par_ck')) <> 4 THEN
    RAISE EXCEPTION 'P2 FALHOU: CHECKs de faixa/par ausentes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_fin_projecao_snapshots_serie_estoque') THEN
    RAISE EXCEPTION 'P3 FALHOU: indice da serie ausente';
  END IF;
  -- RLS da tabela continua ligada (a migration não a toca; conferir é barato).
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.fin_projecao_snapshots'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'P4 FALHOU: fin_projecao_snapshots sem RLS';
  END IF;
  RAISE NOTICE 'FIN-PROJECAO-SNAPSHOTS-ESTOQUE-OK';
END
$post$;
