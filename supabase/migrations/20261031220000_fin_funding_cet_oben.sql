-- ============================================================
-- CET (custo do dinheiro) persistido por empresa + leitura gateada para a aba Ciclo
-- (plano Oben PME/PMR, Frente B, PR3 — spec docs/superpowers/specs/2026-10-31-oben-frente-b-pedido-cobranca-cet-design.md §4 + §7)
--
-- Decisão do founder (2026-10-31, decisão 4): custo do capital da Oben ≈ 2,5% a.m. Até aqui o painel de
-- desconto por pontualidade lia o custo da URL (`useUrlState c`), efêmero; `fin_funding_inputs.funding_inputs`
-- é `{}` nas 3 empresas e `fin_dividas` está vazia (medido psql-ro 2026-10-31).
--
-- Por que COLUNA e não chave no jsonb: `useFunding.ts` faz `upsert({ company, funding_inputs })` do objeto
-- INTEIRO — uma chave nova dentro de `funding_inputs` seria apagada no próximo salvamento do Funding
-- (achado Codex de desenho, P2→P1). Coluna dedicada = 1 writer (esta migration / SQL Editor), nunca regravada
-- pelo upsert do hook (que só toca as colunas que envia).
--
-- Leitura: RPC `fin_ciclo_custo_capital()` com o MESMO gate master da aba (`_fin_ciclo_gate_master`), para o
-- painel não precisar de SELECT direto na tabela master-only. Ausente ⇒ linha com custo NULL (o painel mostra
-- "—" e NÃO calcula: ausente ≠ zero).
--
-- Caminho: `bun run db:aplicar supabase/migrations/20261031220000_fin_funding_cet_oben.sql` (sem envelope).
-- Prova PG17: db/test-fin-funding-cet.sh.
-- ============================================================

ALTER TABLE public.fin_funding_inputs
  ADD COLUMN IF NOT EXISTS custo_capital_mensal numeric,
  ADD COLUMN IF NOT EXISTS custo_capital_fonte text,
  ADD COLUMN IF NOT EXISTS custo_capital_em timestamptz;

-- Fração a.m. finita em (0, 20%] (o teto espelha CUSTO_MENSAL_MAX do helper TS); NULL = não cadastrado.
ALTER TABLE public.fin_funding_inputs DROP CONSTRAINT IF EXISTS fin_funding_inputs_custo_capital_faixa;
ALTER TABLE public.fin_funding_inputs ADD CONSTRAINT fin_funding_inputs_custo_capital_faixa
  CHECK (custo_capital_mensal IS NULL OR (custo_capital_mensal <> 'NaN' AND custo_capital_mensal > 0 AND custo_capital_mensal <= 0.2));

-- Oben: 2,5% a.m. (decisão do founder). Só se ainda não cadastrado — re-aplicar não sobrescreve ajuste posterior.
UPDATE public.fin_funding_inputs
   SET custo_capital_mensal = 0.025,
       custo_capital_fonte = 'founder 2026-10-31 (CET ~2,5% a.m.; fin_dividas vazia, sem CET bancario para derivar)',
       custo_capital_em = now()
 WHERE company = 'oben' AND custo_capital_mensal IS NULL;

CREATE OR REPLACE FUNCTION public.fin_ciclo_custo_capital()
RETURNS TABLE (company text, custo_capital_mensal numeric, custo_capital_fonte text, custo_capital_em timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public._fin_ciclo_gate_master();
  RETURN QUERY
    SELECT f.company, f.custo_capital_mensal, f.custo_capital_fonte, f.custo_capital_em
      FROM public.fin_funding_inputs f
     WHERE public.fin_user_can_access(f.company)
     ORDER BY f.company;
END;
$fn$;
REVOKE ALL ON FUNCTION public.fin_ciclo_custo_capital() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_ciclo_custo_capital() TO authenticated, service_role;

DO $post$
DECLARE
  v_fn oid := to_regprocedure('public.fin_ciclo_custo_capital()');
  v_oben numeric;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'fin_funding_inputs'
         AND column_name IN ('custo_capital_mensal', 'custo_capital_fonte', 'custo_capital_em')) <> 3 THEN
    RAISE EXCEPTION 'P1 FALHOU: colunas do CET ausentes em fin_funding_inputs';
  END IF;
  IF (SELECT convalidated FROM pg_catalog.pg_constraint WHERE conname = 'fin_funding_inputs_custo_capital_faixa') IS NOT TRUE THEN
    RAISE EXCEPTION 'P2 FALHOU: CHECK da faixa do CET ausente ou nao validado';
  END IF;
  SELECT f.custo_capital_mensal INTO v_oben FROM public.fin_funding_inputs f WHERE f.company = 'oben';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'P3 FALHOU: fin_funding_inputs sem linha da oben (o UPDATE nao tinha onde gravar)';
  END IF;
  IF v_oben IS NULL OR v_oben <> v_oben OR v_oben <= 0 OR v_oben > 0.2 THEN
    RAISE EXCEPTION 'P4 FALHOU: CET da oben ausente ou fora da faixa (%)', v_oben;
  END IF;
  IF v_fn IS NULL OR NOT (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid = v_fn)
     OR has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('public', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'P5 FALHOU: fin_ciclo_custo_capital ausente, sem SECDEF ou com ACL errada';
  END IF;
  RAISE NOTICE 'fin_funding_cet: CET da oben = % a.m.; RPC gateada — OK', v_oben;
END
$post$;
