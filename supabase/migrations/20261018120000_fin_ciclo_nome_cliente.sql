-- Ciclo financeiro — nome do cliente na view por cliente (v_ciclo_cliente_resumo).
-- Por que: fin_contas_receber.nome_cliente vem SEMPRE vazio em prod (conferido 2026-10-18), então a
-- coluna Cliente da aba Ciclo mostrava só "#<codigo>". O nome passa a ser resolvido em cascata:
--   1) fin_contas_receber.nome_cliente (se algum dia vier preenchido);
--   2) vínculo Omie→perfil (omie_customer_account_map → profiles.name);
--   3) cadastro Omie não vinculado (omie_clientes_nao_vinculados: nome_fantasia, senão razao_social).
-- Sem nenhum dos três, continua NULL (a UI mostra #codigo) — nunca se fabrica nome.
-- Corpo IDÊNTICO ao da 20261014120000_fin_ciclo_cliente_views.sql (seção 2); só o CTE `nomes` muda.
-- Colunas da view (nomes, tipos, ordem) NÃO mudam: as fin_ciclo_* retornam SETOF dela.
-- CREATE OR REPLACE repete WITH (security_invoker=on) (omitir RESETA e bypassa RLS) e os grants.
-- Prova: db/test-fin-ciclo-rpc.sh.

BEGIN;

-- ── 2. Por cliente ───────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_ciclo_cliente_resumo WITH (security_invoker=on) AS
WITH t AS (SELECT * FROM public.v_ciclo_cr_titulos),
hoje AS (SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS h),
pagas AS (
  SELECT t.company, t.omie_codigo_cliente,
         count(*)::int AS n_parcelas,
         count(DISTINCT coalesce('d:' || t.numero_documento, 'l:' || t.omie_codigo_lancamento::text))::int AS n_documentos,
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
nomes AS ( -- fin_contas_receber.nome_cliente vem vazio em prod (2026-10-18): resolve pelo vínculo Omie→perfil, depois pelo cadastro não vinculado
  SELECT k.company, k.omie_codigo_cliente, coalesce(nt.nome, nm.nome, nv.nome) AS nome_cliente
  FROM chaves k
  LEFT JOIN (SELECT company, omie_codigo_cliente, max(nullif(btrim(nome_cliente), '')) AS nome
             FROM t GROUP BY 1, 2) nt USING (company, omie_codigo_cliente)
  LEFT JOIN LATERAL (SELECT max(nullif(btrim(p.name), '')) AS nome
                     FROM public.omie_customer_account_map m JOIN public.profiles p ON p.user_id = m.user_id
                     WHERE m.account = k.company AND m.omie_codigo_cliente = k.omie_codigo_cliente) nm ON true
  LEFT JOIN LATERAL (SELECT max(coalesce(nullif(btrim(u.nome_fantasia), ''), nullif(btrim(u.razao_social), ''))) AS nome
                     FROM public.omie_clientes_nao_vinculados u
                     WHERE u.empresa = k.company AND u.omie_codigo_cliente = k.omie_codigo_cliente) nv ON true
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

REVOKE ALL ON public.v_ciclo_cliente_resumo FROM PUBLIC, anon;
GRANT SELECT ON public.v_ciclo_cliente_resumo TO authenticated, service_role;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relname = 'v_ciclo_cliente_resumo' AND c.relkind = 'v'
                   AND 'security_invoker=on' = ANY(coalesce(c.reloptions, '{}'))) THEN
    RAISE EXCEPTION 'postcondicao: view v_ciclo_cliente_resumo ausente ou sem security_invoker';
  END IF;
  IF has_table_privilege('anon', 'public.v_ciclo_cliente_resumo', 'SELECT') THEN
    RAISE EXCEPTION 'postcondicao: anon le v_ciclo_cliente_resumo';
  END IF;
  IF to_regprocedure('public.fin_ciclo_cliente_resumo()') IS NULL THEN
    RAISE EXCEPTION 'postcondicao: fin_ciclo_cliente_resumo() ausente';
  END IF;
  RAISE NOTICE 'CICLO-NOME-OK';
END
$post$;

COMMIT;
