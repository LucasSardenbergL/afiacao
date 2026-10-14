-- Ciclo financeiro — fatos por parcela/cliente/coorte (frente 1+2).
-- Spec: docs/superpowers/specs/2026-10-14-ciclo-financeiro-cockpit-cliente-design.md (v2).
-- Views de FATOS: a regra (perfil, alavanca, cenário) vive em src/lib/financeiro/ciclo-cliente-helpers.ts.
-- Prova: db/test-fin-ciclo-cliente.sh (controle verde + falsificação).

BEGIN;

-- ── 1. Por parcela ───────────────────────────────────────────────────────────
-- 'paga'           : baixa derivada + vencimento em [hoje_sp−365, hoje_sp) (coorte por VENCIMENTO).
-- 'paga_sem_baixa' : RECEBIDO na janela sem baixa derivada — só cobertura, nunca média.
-- 'vencida_aberta' : ATRASADO com saldo, QUALQUER idade (envelhecimento em dias_vencido).
-- 'status_ambiguo' : status fora do vocabulário nativo (fallback do ingest) — só contado.
-- prazo_real = v_titulo_baixas.prazo_ponderado_dias (média dos movimentos; cobre parcial).
CREATE OR REPLACE VIEW public.v_ciclo_cr_titulos WITH (security_invoker=on) AS
WITH base AS (
  SELECT r.company, r.omie_codigo_cliente, r.nome_cliente, r.omie_codigo_lancamento,
         r.numero_documento, r.data_emissao, r.data_vencimento, r.valor_documento, r.saldo,
         r.status_titulo, b.data_baixa_final,
         b.prazo_ponderado_dias - (r.data_vencimento - r.data_emissao) AS atraso_calc,
         b.prazo_ponderado_dias,
         (b.omie_codigo_lancamento IS NOT NULL AND b.prazo_ponderado_dias IS NOT NULL) AS tem_baixa,
         (now() AT TIME ZONE 'America/Sao_Paulo')::date AS hoje_sp
  FROM public.fin_contas_receber r
  LEFT JOIN public.v_titulo_baixas b
    ON b.company = r.company AND b.omie_codigo_lancamento = r.omie_codigo_lancamento AND b.tipo = 'CR'
  WHERE r.status_titulo IS DISTINCT FROM 'CANCELADO'
    AND r.valor_documento IS NOT NULL AND r.valor_documento <> 'NaN'
    AND r.valor_documento < 'Infinity' AND r.valor_documento > 0
    AND r.data_emissao IS NOT NULL AND r.data_vencimento IS NOT NULL
    AND r.data_vencimento >= r.data_emissao
    AND r.omie_codigo_cliente IS NOT NULL
), classif AS (
  SELECT base.*,
    CASE
      WHEN status_titulo IS NULL
        OR status_titulo NOT IN ('RECEBIDO','A VENCER','ATRASADO','CANCELADO') THEN 'status_ambiguo'
      WHEN tem_baixa AND data_vencimento >= hoje_sp - 365 AND data_vencimento < hoje_sp THEN 'paga'
      WHEN NOT tem_baixa AND status_titulo = 'RECEBIDO'
        AND data_vencimento >= hoje_sp - 365 AND data_vencimento < hoje_sp THEN 'paga_sem_baixa'
      WHEN NOT tem_baixa AND status_titulo = 'ATRASADO'
        AND saldo IS NOT NULL AND saldo <> 'NaN' AND saldo < 'Infinity' AND saldo > 0 THEN 'vencida_aberta'
    END AS situacao
  FROM base
)
SELECT company, omie_codigo_cliente, nome_cliente, omie_codigo_lancamento, numero_documento,
       data_emissao, data_vencimento,
       CASE WHEN situacao = 'paga' THEN data_baixa_final END AS data_baixa,
       valor_documento, saldo, situacao,
       (data_vencimento - data_emissao) AS prazo_concedido_dias,
       CASE WHEN situacao = 'paga' THEN prazo_ponderado_dias END AS prazo_real_dias,
       CASE WHEN situacao = 'paga' THEN atraso_calc END AS atraso_dias,
       CASE WHEN situacao = 'vencida_aberta' THEN hoje_sp - data_vencimento END AS dias_vencido
FROM classif
WHERE situacao IS NOT NULL;

-- ── 2. Por cliente ───────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_ciclo_cliente_resumo WITH (security_invoker=on) AS
WITH t AS (SELECT * FROM public.v_ciclo_cr_titulos),
hoje AS (SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS h),
pagas AS (
  SELECT t.company, t.omie_codigo_cliente,
         count(*)::int AS n_parcelas,
         count(DISTINCT coalesce(t.numero_documento, t.omie_codigo_lancamento::text))::int AS n_documentos,
         sum(t.valor_documento) AS valor_pago,
         sum(t.valor_documento * t.prazo_concedido_dias) / sum(t.valor_documento) AS prazo_concedido_pond,
         sum(t.valor_documento * t.prazo_real_dias) / sum(t.valor_documento) AS prazo_real_pond,
         sum(t.valor_documento * t.atraso_dias) / sum(t.valor_documento) AS atraso_pond,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY t.atraso_dias) AS atraso_p50,
         percentile_cont(0.8) WITHIN GROUP (ORDER BY t.atraso_dias) AS atraso_p80,
         max(t.atraso_dias) AS atraso_max_observado,
         sum(t.valor_documento * greatest(t.atraso_dias - 3, 0)) / sum(t.valor_documento) AS excesso_carencia_pond,
         coalesce(sum(t.valor_documento) FILTER (WHERE t.atraso_dias > 0), 0) / sum(t.valor_documento) AS pct_valor_atrasado,
         max(t.data_baixa) AS ultima_baixa
  FROM t WHERE t.situacao = 'paga'
  GROUP BY t.company, t.omie_codigo_cliente
),
p80v AS ( -- percentil 80 ponderado por R$: menor atraso cujo acumulado de valor alcança 80%
  SELECT company, omie_codigo_cliente, min(atraso_dias) AS atraso_p80_valor
  FROM (
    SELECT company, omie_codigo_cliente, atraso_dias,
           sum(valor_documento) OVER (PARTITION BY company, omie_codigo_cliente
                                      ORDER BY atraso_dias, omie_codigo_lancamento)
           / sum(valor_documento) OVER (PARTITION BY company, omie_codigo_cliente) AS acum
    FROM t WHERE situacao = 'paga'
  ) x
  WHERE acum >= 0.8
  GROUP BY company, omie_codigo_cliente
),
sem_baixa AS (
  SELECT company, omie_codigo_cliente, sum(valor_documento) AS valor_pago_sem_baixa
  FROM t WHERE situacao = 'paga_sem_baixa' GROUP BY 1, 2
),
vencidas AS (
  SELECT company, omie_codigo_cliente,
         count(*)::int AS n_vencidas, sum(saldo) AS saldo_vencido,
         coalesce(sum(saldo) FILTER (WHERE dias_vencido > 90), 0) AS saldo_vencido_90,
         max(dias_vencido) AS dias_vencido_max
  FROM t WHERE situacao = 'vencida_aberta' GROUP BY 1, 2
),
ambiguos AS (
  SELECT company, omie_codigo_cliente, count(*)::int AS n_status_ambiguo
  FROM t WHERE situacao = 'status_ambiguo' GROUP BY 1, 2
),
volume AS ( -- competência por EMISSÃO (não recebimento), mesma base válida de v_ciclo_cr_titulos
  SELECT r.company, r.omie_codigo_cliente,
         sum(r.valor_documento) AS volume_emitido_12m, min(r.data_emissao) AS primeira_emissao
  FROM public.fin_contas_receber r, hoje
  WHERE r.status_titulo IS DISTINCT FROM 'CANCELADO'
    AND r.valor_documento IS NOT NULL AND r.valor_documento <> 'NaN'
    AND r.valor_documento < 'Infinity' AND r.valor_documento > 0
    AND r.data_emissao IS NOT NULL AND r.data_vencimento IS NOT NULL
    AND r.data_vencimento >= r.data_emissao AND r.omie_codigo_cliente IS NOT NULL
    AND r.data_emissao >= hoje.h - 365 AND r.data_emissao < hoje.h
  GROUP BY 1, 2
),
chaves AS (
  SELECT company, omie_codigo_cliente FROM pagas
  UNION SELECT company, omie_codigo_cliente FROM vencidas
  UNION SELECT company, omie_codigo_cliente FROM sem_baixa
  UNION SELECT company, omie_codigo_cliente FROM ambiguos
),
nomes AS (
  SELECT company, omie_codigo_cliente, max(nome_cliente) AS nome_cliente FROM t GROUP BY 1, 2
)
SELECT k.company, k.omie_codigo_cliente, n.nome_cliente,
       p.n_parcelas, p.n_documentos, p.valor_pago, sb.valor_pago_sem_baixa,
       p.prazo_concedido_pond, p.prazo_real_pond, p.atraso_pond,
       p.atraso_p50, p.atraso_p80, pv.atraso_p80_valor, p.atraso_max_observado,
       p.excesso_carencia_pond, p.pct_valor_atrasado, p.ultima_baixa,
       v.n_vencidas, v.saldo_vencido, v.saldo_vencido_90, v.dias_vencido_max,
       vol.volume_emitido_12m, vol.primeira_emissao,
       a.n_status_ambiguo
FROM chaves k
LEFT JOIN nomes n     USING (company, omie_codigo_cliente)
LEFT JOIN pagas p     USING (company, omie_codigo_cliente)
LEFT JOIN p80v pv     USING (company, omie_codigo_cliente)
LEFT JOIN sem_baixa sb USING (company, omie_codigo_cliente)
LEFT JOIN vencidas v  USING (company, omie_codigo_cliente)
LEFT JOIN ambiguos a  USING (company, omie_codigo_cliente)
LEFT JOIN volume vol  USING (company, omie_codigo_cliente);

-- ── 3. Por empresa × mês de VENCIMENTO (coorte com censura) ─────────────────
CREATE OR REPLACE VIEW public.v_ciclo_empresa_coorte WITH (security_invoker=on) AS
WITH t AS (
  SELECT * FROM public.v_ciclo_cr_titulos
  WHERE situacao IN ('paga','paga_sem_baixa','vencida_aberta')
    AND data_vencimento >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - 365
    AND data_vencimento <  (now() AT TIME ZONE 'America/Sao_Paulo')::date
)
SELECT company,
       date_trunc('month', data_vencimento)::date AS mes_vencimento,
       sum(valor_documento) AS valor_vencido_no_mes,
       coalesce(sum(valor_documento) FILTER (WHERE situacao IN ('paga','paga_sem_baixa')), 0) AS valor_pago,
       coalesce(sum(saldo) FILTER (WHERE situacao = 'vencida_aberta'), 0) AS valor_em_aberto,
       coalesce(sum(valor_documento) FILTER (WHERE situacao IN ('paga','paga_sem_baixa')), 0)
         / sum(valor_documento) AS pct_valor_pago,
       sum(valor_documento * prazo_concedido_dias) FILTER (WHERE situacao = 'paga')
         / nullif(sum(valor_documento) FILTER (WHERE situacao = 'paga'), 0) AS prazo_concedido_pond,
       sum(valor_documento * prazo_real_dias) FILTER (WHERE situacao = 'paga')
         / nullif(sum(valor_documento) FILTER (WHERE situacao = 'paga'), 0) AS prazo_real_pond_pagas,
       sum(valor_documento * atraso_dias) FILTER (WHERE situacao = 'paga')
         / nullif(sum(valor_documento) FILTER (WHERE situacao = 'paga'), 0) AS atraso_pond_pagas,
       date_trunc('month', data_vencimento)::date
         = date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo')::date)::date AS mes_parcial
FROM t
GROUP BY company, date_trunc('month', data_vencimento);

-- ── 4. Grants (anon fora; RLS das bases via security_invoker) ───────────────
REVOKE ALL ON public.v_ciclo_cr_titulos, public.v_ciclo_cliente_resumo, public.v_ciclo_empresa_coorte FROM PUBLIC, anon;
GRANT SELECT ON public.v_ciclo_cr_titulos, public.v_ciclo_cliente_resumo, public.v_ciclo_empresa_coorte TO authenticated, service_role;

-- ── 5. Postcondição embutida ────────────────────────────────────────────────
DO $post$
DECLARE v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['v_ciclo_cr_titulos','v_ciclo_cliente_resumo','v_ciclo_empresa_coorte'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public' AND c.relname = v AND c.relkind = 'v'
                     AND 'security_invoker=on' = ANY(coalesce(c.reloptions, '{}'))) THEN
      RAISE EXCEPTION 'postcondicao: view % ausente ou sem security_invoker', v;
    END IF;
    IF has_table_privilege('anon', 'public.' || v, 'SELECT') THEN
      RAISE EXCEPTION 'postcondicao: anon le %', v;
    END IF;
  END LOOP;
  RAISE NOTICE 'CICLO-CLIENTE-VIEWS-OK';
END
$post$;

COMMIT;
