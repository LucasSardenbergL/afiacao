-- ============================================================================================
-- fin_projecao_13_semanas: saldo de conta corrente ausente ou velho NAO vira saldo inicial
-- ============================================================================================
-- Antes: com p_saldo_inicial NULL, o saldo inicial era COALESCE(SUM(saldo_atual), 0) das contas
-- ativas, sem olhar saldo_data. Lista vazia virava R$ 0, conta com saldo_atual NULL saia da soma
-- (total parcial com cara de completo) e saldo de dias atras contava como de hoje — o
-- omie-financeiro PRESERVA saldo_atual e saldo_data quando o extrato falha. A projecao alimenta a
-- decisao de compra (CaixaCompraCard: piso das 13 semanas). money-path: ausente != zero.
--
-- Agora, so no ramo p_saldo_inicial NULL: o saldo inicial e a soma das contas ativas do escopo
-- (p_company, ou todas) SO quando TODAS sao frescas; senao e NULL, e o saldo_projetado das 13
-- semanas sai NULL (entradas_previstas/saidas_previstas/fluxo_liquido seguem). NULL quando:
--   · nao ha conta ativa no escopo;
--   · alguma tem saldo_data NULL (saldo_atual tem DEFAULT 0: conta cujo 1o extrato falhou nasce
--     com 0, entao o NULL de saldo_data e o sinal), saldo_atual NULL, NaN ou ±Infinity;
--   · alguma tem saldo_data fora de [minimo, hoje].
-- A regra de frescor e a de classificarSaldoConta (src/lib/financeiro/saldo-contas.ts), ja em prod
-- nas telas e na fin-cashflow-engine: hoje = dia de SP de now(); minimo = dia de SP de now() - 4 h
-- (HORAS_TOLERANCIA_SYNC_BASE; o fin-sync-base-diario roda as 03h SP). now(), nao
-- clock_timestamp(): a funcao e STABLE. Com p_saldo_inicial informado, nada muda.
-- Consumidores ja tratam NULL: pisoProjecao pula a linha (-> "indisponivel"); dashboard mostra "—".
--
-- Corpo de partida = o de PROD, conferido em 2026-10-28 (md5 do prosrc, psql-ro):
--   fin_projecao_13_semanas ec1db10e16e975e1a09224bede8c79f9 = 20260927202603 (repo == prod).
-- Molde TRAVA -> PRE -> CREATE OR REPLACE -> POS (skill lovable-db-operator, "Recriar objeto VIVO").
-- `bun run db:aplicar` fornece a transacao (por isso NAO ha BEGIN/COMMIT aqui); quem colar no SQL
-- Editor envolve em BEGIN; … COMMIT; — colar sem envelope anula a trava.
-- CREATE OR REPLACE preserva o ACL (EXECUTE: authenticated, service_role); a POS confere.
-- Prova: db/test-projecao-13s-saldo-fresco.sh (PG17, relogio controlado, --falsificar).
-- Diario: docs/historico/saldo-cc-fresco-e-ncg-leitura-pontual.md
-- ============================================================================================

-- ── TRAVA + PRE: identidade do corpo vivo, ANTES de ler ──────────────────────────────────────
DO $pre$
DECLARE
  v_vivo text;
BEGIN
  IF to_regprocedure('public.fin_projecao_13_semanas(text,numeric)') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: public.fin_projecao_13_semanas(text,numeric) ausente.';
  END IF;
  ALTER FUNCTION public.fin_projecao_13_semanas(text, numeric) STABLE;
  SELECT md5(p.prosrc) INTO v_vivo FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.fin_projecao_13_semanas(text,numeric)');
  IF v_vivo IS NULL OR v_vivo NOT IN ('ec1db10e16e975e1a09224bede8c79f9', 'dc22fe016ea307694ea1426cd75e011f') THEN
    RAISE EXCEPTION 'PRE FALHOU: fin_projecao_13_semanas vivo (md5 %) nao e o predecessor revisado nem este.', v_vivo;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.fin_projecao_13_semanas(p_company text DEFAULT NULL::text, p_saldo_inicial numeric DEFAULT NULL::numeric)
 RETURNS TABLE(semana_inicio date, semana_fim date, semana_label text, entradas_previstas numeric, saidas_previstas numeric, fluxo_liquido numeric, saldo_projetado numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_saldo numeric;
  v_week_start date;
  v_week_end date;
  v_hoje date;
  v_minimo date;
  v_contas integer;
  v_invalidas integer;
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  IF p_saldo_inicial IS NOT NULL THEN
    v_saldo := p_saldo_inicial;
  ELSE
    -- Mesma regra de classificarSaldoConta (src/lib/financeiro/saldo-contas.ts): fresca <=> minimo <= saldo_data <= hoje,
    -- em dias de SP, com minimo = dia de SP de now() - HORAS_TOLERANCIA_SYNC_BASE (4 h). Uma conta ausente/velha anula tudo.
    v_hoje := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
    v_minimo := ((now() - interval '4 hours') AT TIME ZONE 'America/Sao_Paulo')::date;
    SELECT count(*),
           count(*) FILTER (WHERE saldo_data IS NULL OR saldo_atual IS NULL
                              OR saldo_atual IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
                              OR saldo_data NOT BETWEEN v_minimo AND v_hoje),
           SUM(saldo_atual)
      INTO v_contas, v_invalidas, v_saldo
      FROM fin_contas_correntes
     WHERE (p_company IS NULL OR company = p_company) AND ativo;
    IF v_contas = 0 OR v_invalidas > 0 THEN
      v_saldo := NULL;
    END IF;
  END IF;

  FOR i IN 0..12 LOOP
    v_week_start := date_trunc('week', now() AT TIME ZONE 'America/Sao_Paulo')::date + (i * 7);
    v_week_end := v_week_start + 6;
    SELECT COALESCE(SUM(valor_documento - COALESCE(valor_recebido, 0)), 0) INTO entradas_previstas
    FROM fin_contas_receber
    WHERE (p_company IS NULL OR company = p_company)
      AND data_vencimento BETWEEN v_week_start AND v_week_end
      AND status_titulo IN ('A VENCER','ATRASADO','VENCE HOJE');
    SELECT COALESCE(SUM(valor_documento - COALESCE(valor_pago, 0)), 0) INTO saidas_previstas
    FROM fin_contas_pagar
    WHERE (p_company IS NULL OR company = p_company)
      AND data_vencimento BETWEEN v_week_start AND v_week_end
      AND status_titulo IN ('A VENCER','ATRASADO','VENCE HOJE');
    fluxo_liquido := entradas_previstas - saidas_previstas;
    v_saldo := v_saldo + fluxo_liquido;
    semana_inicio := v_week_start;
    semana_fim := v_week_end;
    semana_label := to_char(v_week_start, 'DD/MM') || '-' || to_char(v_week_end, 'DD/MM');
    saldo_projetado := v_saldo;
    RETURN NEXT;
  END LOOP;
END;
$function$;

-- ── POS: o corpo vivo e ESTE, com a mesma moldura e o mesmo ACL ──────────────────────────────
DO $pos$
DECLARE
  v_oid oid := to_regprocedure('public.fin_projecao_13_semanas(text,numeric)');
  p record;
BEGIN
  SELECT md5(x.prosrc) AS md5, x.provolatile, x.prosecdef, x.proisstrict, x.proconfig, x.pronargdefaults,
         pg_catalog.pg_get_userbyid(x.proowner) AS dono INTO p
    FROM pg_catalog.pg_proc x WHERE x.oid = v_oid;
  IF p.md5 IS DISTINCT FROM 'dc22fe016ea307694ea1426cd75e011f' THEN
    RAISE EXCEPTION 'POS FALHOU: fin_projecao_13_semanas com md5 % (esperado o deste arquivo).', p.md5;
  END IF;
  IF p.provolatile IS DISTINCT FROM 's' OR p.prosecdef IS NOT TRUE OR p.proisstrict IS NOT FALSE
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public'] OR p.pronargdefaults IS DISTINCT FROM 2::int2
     OR p.dono IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION 'POS FALHOU: moldura mudou (volatilidade %, secdef %, strict %, config %, defaults %, dono %).',
      p.provolatile, p.prosecdef, p.proisstrict, p.proconfig, p.pronargdefaults, p.dono;
  END IF;
  IF has_function_privilege('public', v_oid, 'EXECUTE') OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: ACL de EXECUTE mudou (esperado so authenticated, service_role).';
  END IF;
END
$pos$;
