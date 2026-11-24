-- ============================================================================================
-- Confiança do CMV em colunas DEDICADAS da DRE (edge omie-financeiro v1.14).
-- Placar do CEO, entrega 3 — diário: docs/historico/ceo-placar-honesto.md.
--
-- Sem BEGIN/COMMIT: a transação é do executor (`bun run db:aplicar`, que também grava a trilha). O NOTIFY
-- do fim é entregue no COMMIT dela.
--
-- `qtd_categorias_sem_mapeamento` conta categorias da DRE INTEIRA, então não diz se a margem bruta é medida ou
-- adivinhada. A v1.14 grava o CMV que entrou pela heurística de descrição:
--   - cmv_heuristica      = R$ do CMV classificado por heurística (inclui lançamento sem código de categoria);
--   - cmv_heuristica_pct  = cmv_heuristica / cmv (0..1). NULL com CMV ≤ 0 (sem base — nunca 0%).
-- 1 writer: o upsert de `calcularDRE` na edge. Sinal money-path nunca em `detalhamento` (jsonb).
--
-- Ausente ≠ zero: snapshot anterior à v1.14 = as 2 colunas NULL (não medido) — sem DEFAULT 0.
-- CHECKs espelhados pelo helper `supabase/functions/omie-financeiro/cmv-heuristica.ts` (folga do helper
-- 0,00006 < 0,0001 do banco): o CHECK nunca pode derrubar o upsert da DRE.
--
-- Gatilho: um bundle que NÃO nomeia as colunas (anterior à v1.14, ou rollback) num UPDATE do upsert manteria o
-- valor de outra apuração ao lado do `cmv` novo — o percentual mentiria (ou o CHECK de coerência derrubaria o
-- upsert). Sem a marca `detalhamento.contrato.cmv_heuristica`, o BEFORE trigger anula as 2 colunas — mesmo
-- molde do `fin_dre_snapshots_contrato_fase2` (que não é tocado aqui).
--
-- Aditiva e idempotente. ORDEM DE DEPLOY: ESTE arquivo → edge v1.14 → Publish do front (o front lê `select *`,
-- então coluna ausente só aparece como "—"; a edge v1.14 antes daqui daria 42703 no upsert e a DRE falha alto).
-- Ensaio: `bun run db:aplicar db/2026-11-22-fin-dre-snapshots-cmv-heuristica.sql --ensaio`.
-- ============================================================================================

ALTER TABLE public.fin_dre_snapshots
  ADD COLUMN IF NOT EXISTS cmv_heuristica numeric,
  ADD COLUMN IF NOT EXISTS cmv_heuristica_pct numeric;

COMMENT ON COLUMN public.fin_dre_snapshots.cmv_heuristica IS
  'R$ do CMV do mês classificado pela heurística de descrição (edge omie-financeiro v1.14). NULL = não medido (snapshot anterior, bundle sem a marca do contrato, ou valor fora de faixa).';
COMMENT ON COLUMN public.fin_dre_snapshots.cmv_heuristica_pct IS
  'cmv_heuristica / cmv, de 0 a 1. NULL com cmv_heuristica presente = sem fração interpretável (CMV ≤ 0, ou heurística fora de 0..100% do CMV, ex.: estorno mapeado maior que o CMV mapeado); NULL nas duas = não medido.';

-- Faixa (guard numérico fecha FAIXA, não só sinal): NaN, teto de magnitude, fração fora de 0..1.
ALTER TABLE public.fin_dre_snapshots DROP CONSTRAINT IF EXISTS fin_dre_snapshots_cmv_heuristica_faixa_ck;
ALTER TABLE public.fin_dre_snapshots ADD CONSTRAINT fin_dre_snapshots_cmv_heuristica_faixa_ck CHECK (
  (cmv_heuristica IS NULL OR (cmv_heuristica <> 'NaN' AND abs(cmv_heuristica) < 10000000000))
  AND (cmv_heuristica_pct IS NULL OR (cmv_heuristica_pct <> 'NaN' AND cmv_heuristica_pct >= 0 AND cmv_heuristica_pct <= 1))
);

-- Coerência: percentual só com valor medido E CMV positivo, e batendo com valor/cmv (folga de arredondamento).
-- CASE, não AND: o Postgres não garante a ordem de avaliação do AND, e `valor / cmv` com cmv = 0 lançaria
-- division_by_zero (22012) em vez de check_violation — um erro que o helper não prevê.
ALTER TABLE public.fin_dre_snapshots DROP CONSTRAINT IF EXISTS fin_dre_snapshots_cmv_heuristica_coerencia_ck;
ALTER TABLE public.fin_dre_snapshots ADD CONSTRAINT fin_dre_snapshots_cmv_heuristica_coerencia_ck CHECK (
  cmv_heuristica_pct IS NULL
  OR (cmv_heuristica IS NOT NULL
      AND CASE WHEN cmv > 0 THEN abs(cmv_heuristica_pct - cmv_heuristica / cmv) <= 0.0001 ELSE false END)
);

CREATE OR REPLACE FUNCTION public.fin_dre_snapshots_contrato_cmv_heuristica()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.detalhamento IS NULL
     OR jsonb_typeof(NEW.detalhamento -> 'contrato') IS DISTINCT FROM 'object'
     OR NOT ((NEW.detalhamento -> 'contrato') ? 'cmv_heuristica') THEN
    NEW.cmv_heuristica := NULL;
    NEW.cmv_heuristica_pct := NULL;
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS trg_fin_dre_snapshots_contrato_cmv_heuristica ON public.fin_dre_snapshots;
CREATE TRIGGER trg_fin_dre_snapshots_contrato_cmv_heuristica
  BEFORE INSERT OR UPDATE ON public.fin_dre_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.fin_dre_snapshots_contrato_cmv_heuristica();

DO $post$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'fin_dre_snapshots'
        AND column_name IN ('cmv_heuristica', 'cmv_heuristica_pct')) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'P1 FALHOU: colunas cmv_heuristica* ausentes em fin_dre_snapshots';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.fin_dre_snapshots'::regclass
      AND conname IN ('fin_dre_snapshots_cmv_heuristica_faixa_ck', 'fin_dre_snapshots_cmv_heuristica_coerencia_ck')) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'P2 FALHOU: CHECKs de faixa/coerencia do CMV por heuristica ausentes';
  END IF;
  -- Nenhum DEFAULT: ausente tem de continuar NULL (DEFAULT 0 fabricaria "CMV 100%% mapeado" nos snapshots antigos).
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'fin_dre_snapshots'
               AND column_name IN ('cmv_heuristica', 'cmv_heuristica_pct') AND column_default IS NOT NULL) THEN
    RAISE EXCEPTION 'P3 FALHOU: coluna cmv_heuristica* com DEFAULT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.fin_dre_snapshots'::regclass
                 AND tgname = 'trg_fin_dre_snapshots_contrato_cmv_heuristica' AND NOT tgisinternal AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'P4 FALHOU: gatilho do contrato cmv_heuristica ausente ou desligado';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.fin_dre_snapshots'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'P5 FALHOU: fin_dre_snapshots sem RLS';
  END IF;
  RAISE NOTICE 'FIN-DRE-SNAPSHOTS-CMV-HEURISTICA-OK';
END
$post$;

-- O PostgREST só enxerga coluna nova depois do reload do cache de schema (etapa distinta do DDL).
NOTIFY pgrst, 'reload schema';
