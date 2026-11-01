-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- 20261101120000 — Ciclo: coortes de recebimento com MATURAÇÃO FIXA (D+15 / D+30 / D+60)
-- Frente A, item 4 do plano PME/PMR da Oben (docs/superpowers/specs/2026-10-31-oben-pme-pmr-plano-design.md).
--
-- Por que existe: a `v_ciclo_empresa_coorte` publica "% pago" com o que já foi liquidado ATÉ HOJE — a
-- coorte de ontem parece pior que a de 6 meses atrás só porque teve menos tempo. Aqui cada coorte
-- (mês de VENCIMENTO) é lida em janelas fixas após o vencimento: % do valor pago em D+15, D+30 e
-- D+60, ponderado por VALOR. Uma janela só publica número quando a coorte está MADURA para ela
-- (o último dia do mês + N já passou) — coorte imatura = NULL + flag, nunca número parcial.
--
-- Fonte: `v_ciclo_cr_titulos` (universo já saneado: cancelado fora, valor > 0, emissão ≤ vencimento,
-- cliente presente). `data_baixa` = ÚLTIMA baixa do título (v_titulo_baixas): o título conta pelo
-- valor do documento inteiro na data da última baixa (mesma convenção da situação `paga`).
-- Três massas SEPARADAS (nunca somadas): antecipação (baixa < vencimento), pago no dia, pago com
-- atraso (baixa > vencimento); mais `valor_pago_sem_data` (pago sem data de baixa legível — a
-- janela não sabe onde ele cai, ausente ≠ zero) e `valor_em_aberto` (saldo das vencidas abertas).
-- Dias de antecipação/atraso ponderados por valor, cada um só na sua massa.
--
-- NÃO substitui `v_ciclo_empresa_coorte` nem `fin_ciclo_empresa_coorte()` (quem lê a tendência
-- segue lendo as duas). Mesmo gate das RPCs do ciclo (`_fin_ciclo_gate_master` + `fin_user_can_access`).
-- Prova: db/test-fin-ciclo-coorte-maturacao.sh (controle verde + sabotagens, C e pt_BR).
-- Sem BEGIN/COMMIT: a transação é do envelope `bun run db:aplicar` (idempotente — CREATE OR REPLACE em tudo).
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. View ─────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_ciclo_empresa_coorte_maturacao WITH (security_invoker=on) AS
WITH hoje AS (SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS h),
t AS (
  SELECT v.company, v.data_emissao, v.data_vencimento, v.data_baixa, v.valor_documento, v.saldo, v.situacao, hoje.h
  FROM public.v_ciclo_cr_titulos v, hoje
  WHERE v.situacao IN ('paga', 'paga_sem_baixa', 'vencida_aberta')
    AND v.data_vencimento >= hoje.h - 365
    AND v.data_vencimento <  hoje.h
),
m AS (
  SELECT company, h,
         date_trunc('month', data_vencimento)::date AS mes_vencimento,
         (date_trunc('month', data_vencimento) + interval '1 month' - interval '1 day')::date AS fim_mes,
         count(*)::integer AS titulos,
         sum(valor_documento) AS valor_vencido_no_mes,
         coalesce(sum(valor_documento) FILTER (WHERE situacao = 'paga' AND data_baixa <= data_vencimento + 15), 0) AS pago_d15,
         coalesce(sum(valor_documento) FILTER (WHERE situacao = 'paga' AND data_baixa <= data_vencimento + 30), 0) AS pago_d30,
         coalesce(sum(valor_documento) FILTER (WHERE situacao = 'paga' AND data_baixa <= data_vencimento + 60), 0) AS pago_d60,
         coalesce(sum(valor_documento) FILTER (WHERE situacao = 'paga' AND data_baixa < data_vencimento), 0) AS valor_antecipado,
         coalesce(sum(valor_documento) FILTER (WHERE situacao = 'paga' AND data_baixa = data_vencimento), 0) AS valor_pago_no_dia,
         coalesce(sum(valor_documento) FILTER (WHERE situacao = 'paga' AND data_baixa > data_vencimento), 0) AS valor_pago_com_atraso,
         coalesce(sum(valor_documento) FILTER (WHERE situacao = 'paga_sem_baixa' OR (situacao = 'paga' AND data_baixa IS NULL)), 0) AS valor_pago_sem_data,
         coalesce(sum(saldo) FILTER (WHERE situacao = 'vencida_aberta'), 0) AS valor_em_aberto,
         sum(valor_documento * (data_vencimento - data_baixa)) FILTER (WHERE situacao = 'paga' AND data_baixa < data_vencimento)
           / nullif(sum(valor_documento) FILTER (WHERE situacao = 'paga' AND data_baixa < data_vencimento), 0) AS dias_antecipacao_pond,
         sum(valor_documento * (data_baixa - data_vencimento)) FILTER (WHERE situacao = 'paga' AND data_baixa > data_vencimento)
           / nullif(sum(valor_documento) FILTER (WHERE situacao = 'paga' AND data_baixa > data_vencimento), 0) AS dias_atraso_pond
  FROM t
  GROUP BY company, h, date_trunc('month', data_vencimento)
)
SELECT m.company,
       m.mes_vencimento,
       m.titulos,
       m.valor_vencido_no_mes,
       m.valor_antecipado,
       m.valor_pago_no_dia,
       m.valor_pago_com_atraso,
       m.valor_pago_sem_data,
       m.valor_em_aberto,
       m.dias_antecipacao_pond,
       m.dias_atraso_pond,
       (m.fim_mes + 15 < m.h) AS maduro_d15,
       (m.fim_mes + 30 < m.h) AS maduro_d30,
       (m.fim_mes + 60 < m.h) AS maduro_d60,
       -- Mes CORTADO pela janela (o corrente, e o de 365 d atras quando a janela nao comeca no dia 1): a coorte
       -- e um recorte do mes, nao o mes inteiro - mesma marca da v_ciclo_empresa_coorte (Codex, 2026-11-01).
       (m.mes_vencimento = date_trunc('month', m.h)::date
        OR (m.mes_vencimento = date_trunc('month', m.h - 365)::date AND (m.h - 365) <> date_trunc('month', m.h - 365)::date)) AS mes_parcial,
       CASE WHEN m.fim_mes + 15 < m.h THEN round(m.pago_d15 / nullif(m.valor_vencido_no_mes, 0), 4) END AS pct_pago_d15,
       CASE WHEN m.fim_mes + 30 < m.h THEN round(m.pago_d30 / nullif(m.valor_vencido_no_mes, 0), 4) END AS pct_pago_d30,
       CASE WHEN m.fim_mes + 60 < m.h THEN round(m.pago_d60 / nullif(m.valor_vencido_no_mes, 0), 4) END AS pct_pago_d60
FROM m;

COMMENT ON VIEW public.v_ciclo_empresa_coorte_maturacao IS
  'Coortes de CR por mês de vencimento com maturação fixa: pct_pago_dN só quando maduro_dN (último dia do mês + N < hoje SP); massas separadas (antecipado / no dia / com atraso / sem data / em aberto; nao formam particao: em aberto e SALDO). Titulo conta pelo valor INTEGRAL na data da ULTIMA baixa (nao e recebimento parcial acumulado). mes_parcial = coorte cortada pela janela. Ler pela RPC fin_ciclo_empresa_coorte_maturacao().';

-- ── 2. RPC (mesmo gate das RPCs do ciclo) ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fin_ciclo_empresa_coorte_maturacao()
RETURNS SETOF public.v_ciclo_empresa_coorte_maturacao
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public._fin_ciclo_gate_master();
  RETURN QUERY
    SELECT v.* FROM public.v_ciclo_empresa_coorte_maturacao v
    WHERE public.fin_user_can_access(v.company)
    ORDER BY v.company, v.mes_vencimento;
END
$$;

-- ── 3. Grants (anon fora nas DUAS pontas; authenticated passa pelo gate) ───────────────────
REVOKE ALL ON public.v_ciclo_empresa_coorte_maturacao FROM PUBLIC, anon;
GRANT SELECT ON public.v_ciclo_empresa_coorte_maturacao TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fin_ciclo_empresa_coorte_maturacao() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_ciclo_empresa_coorte_maturacao() TO authenticated, service_role;

-- ── 4. Postcondição embutida ───────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_ok boolean;
  v_def text;
BEGIN
  SELECT 'security_invoker=on' = ANY (coalesce(c.reloptions, '{}')) INTO v_ok
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'v_ciclo_empresa_coorte_maturacao' AND c.relkind = 'v';
  IF v_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'postcondicao: view sem security_invoker';
  END IF;
  IF has_table_privilege('anon', 'public.v_ciclo_empresa_coorte_maturacao', 'SELECT') THEN
    RAISE EXCEPTION 'postcondicao: anon le a view';
  END IF;
  IF has_function_privilege('anon', 'public.fin_ciclo_empresa_coorte_maturacao()', 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondicao: anon executa';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fin_ciclo_empresa_coorte_maturacao()', 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondicao: authenticated sem EXECUTE';
  END IF;
  v_def := pg_get_functiondef('public.fin_ciclo_empresa_coorte_maturacao()'::regprocedure);
  IF v_def NOT LIKE '%_fin_ciclo_gate_master()%' OR v_def NOT LIKE '%fin_user_can_access(v.company)%' THEN
    RAISE EXCEPTION 'postcondicao: RPC sem gate';
  END IF;
  RAISE NOTICE 'CICLO-COORTE-MATURACAO-OK';
END
$post$;

