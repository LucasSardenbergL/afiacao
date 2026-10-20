-- ============================================================
-- fin_capital_giro_prazos_empresa(p_company) — a linha de v_capital_giro_prazos de UMA empresa
-- (PMR/PMP + cobertura da baixa derivada), com custo O(empresa) e não O(todas).
--
-- Incidente (2026-10-14 → 20): o fin-cashflow-engine devolvia 500 (57014) para a colacor depois
-- do backfill de 84.795 movimentos em 13/10. O #3184 tirou a paginação de v_titulo_baixas
-- (RPC fin_titulo_baixas_cr_mapa), mas no cron de 2026-10-20 10:00Z a RPC ainda estourou: cada
-- chamada do engine também lê v_capital_giro_prazos .eq('company', X), e essa view agrega
-- v_titulo_baixas 2× (cr_baixa e cp_baixa). v_titulo_baixas materializa o CTE `mov`
-- (referenciado 2×) sobre fin_movimentacoes INTEIRA, sem pushdown de company. O #3208 escalonou
-- o cron por empresa como mitigação; esta função remove a causa no caminho quente.
-- Medido em prod (psql-ro, 2026-10-20, `select pmr, pmp, pmr_cobertura, pmp_cobertura` — NÃO
-- count(*), que deixa o planner podar os LEFT JOINs):
--   - view, colacor: 1,28 s, 2 Seq Scans de fin_movimentacoes com 117.307 linhas cada;
--     9 simultâneas (3 por empresa): 4,4–6,3 s (statement_timeout do authenticator: 8 s);
--   - este corpo, colacor: 0,68 s, 1 Bitmap Heap Scan com 81.669 linhas (só a colacor);
--     9 simultâneas: 0,40–2,06 s.
-- O corpo é cópia VERBATIM de pg_get_viewdef da PROD das duas views (v_titulo_baixas md5
-- 57e98392e33a254d924927f8e07dea5f como CTE `vb`; v_capital_giro_prazos md5 795031892dfb09f69f166648affec5d7), com
-- `company = p_company` em `mov`, `cr`, `cp`, nas duas pernas de `companies`, em `cr_set` e
-- `cp_set`, e `FROM vb v_titulo_baixas` no lugar de `FROM v_titulo_baixas`. Nenhuma regra nova
-- de negócio. Travas contra deriva (molde da 20261019110100): PRE por md5 das DUAS views, LOCK
-- das duas, A6 de igualdade com a view em toda empresa, e guarda de md5 das duas em RUNTIME
-- (P0001: o engine trata como leitura que falhou e mostra "—" com o motivo, nunca número velho).
-- Retorno em envelope jsonb {existe, pmr, pmp, pmr_cobertura, pmp_cobertura}: existe=false
-- quando a view não teria linha para a empresa. Objeto e não linha/array cru porque o
-- supabase-js converte HTTP 404 com corpo `[]` em {data: [], error: null}.
-- SECURITY INVOKER (lê com o RLS de quem chama, como a view security_invoker=on); EXECUTE só
-- para service_role (o engine); PUBLIC/anon/authenticated revogados pelo nome. As views não mudam.
-- Sem BEGIN/COMMIT: aplicada por `bun run db:aplicar`, cuja transação é do executor (ele recusa
-- arquivo com envelope). A prova PG17 aplica com --single-transaction pelo mesmo motivo.
-- ============================================================

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- TRAVA: ninguém troca as views entre o PRE e o fim desta transação (ACCESS SHARE não bloqueia
-- leitura nem DML; o CREATE OR REPLACE VIEW concorrente pede ACCESS EXCLUSIVE e espera).
LOCK TABLE public.v_titulo_baixas, public.v_capital_giro_prazos IN ACCESS SHARE MODE;

-- PRE anti-deriva: o corpo abaixo é cópia DESTAS definições das duas views.
DO $pre$
DECLARE
  vivo_tb text := md5(pg_get_viewdef('public.v_titulo_baixas'::regclass, true));
  vivo_pz text := md5(pg_get_viewdef('public.v_capital_giro_prazos'::regclass, true));
BEGIN
  IF vivo_tb IS DISTINCT FROM '57e98392e33a254d924927f8e07dea5f' THEN
    RAISE EXCEPTION 'PRE FALHOU: v_titulo_baixas viva (md5 %) nao e a copiada nesta funcao — refaca a copia', vivo_tb;
  END IF;
  IF vivo_pz IS DISTINCT FROM '795031892dfb09f69f166648affec5d7' THEN
    RAISE EXCEPTION 'PRE FALHOU: v_capital_giro_prazos viva (md5 %) nao e a copiada nesta funcao — refaca a copia', vivo_pz;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.fin_capital_giro_prazos_empresa(p_company text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Empresa nula não é "empresa sem linha": é chamada errada (a view não tem linha de company NULL
  -- que se possa pedir). Falha alta, nunca envelope existe=false (Codex challenge).
  IF p_company IS NULL THEN
    RAISE EXCEPTION 'fin_capital_giro_prazos_empresa: p_company nulo' USING ERRCODE = '22004';
  END IF;
  -- Guarda de deriva em RUNTIME: se qualquer das duas views mudar, a função falha EXPLÍCITA em
  -- vez de divergir em silêncio — refaça a cópia (e os md5) numa migration nova.
  IF md5(pg_get_viewdef('public.v_titulo_baixas'::regclass, true)) IS DISTINCT FROM '57e98392e33a254d924927f8e07dea5f'
     OR md5(pg_get_viewdef('public.v_capital_giro_prazos'::regclass, true)) IS DISTINCT FROM '795031892dfb09f69f166648affec5d7' THEN
    RAISE EXCEPTION 'fin_capital_giro_prazos_empresa: v_titulo_baixas ou v_capital_giro_prazos mudou desde a copia (migration 20261020150000) — refaca a copia'
      USING ERRCODE = 'P0001';
  END IF;
  -- Mais de uma linha (impossível: companies é UNION) faria o RETURN falhar alto, não escolher uma.
  RETURN (
  WITH prazos AS (
    WITH vb AS (
       WITH mov AS (
               SELECT fin_movimentacoes.company,
                  fin_movimentacoes.omie_codigo_lancamento AS cod,
                  fin_movimentacoes.tipo,
                  fin_movimentacoes.data_movimento,
                  fin_movimentacoes.valor,
                  fin_movimentacoes.categoria_descricao AS grupo
                 FROM fin_movimentacoes
                WHERE fin_movimentacoes.company = p_company AND fin_movimentacoes.omie_codigo_lancamento IS NOT NULL AND fin_movimentacoes.data_movimento IS NOT NULL AND (fin_movimentacoes.tipo = ANY (ARRAY['E'::text, 'S'::text])) AND fin_movimentacoes.valor > 0::numeric AND (fin_movimentacoes.categoria_descricao = ANY (ARRAY['CONTA_A_RECEBER'::text, 'CONTA_A_PAGAR'::text, 'CONTA_CORRENTE_REC'::text, 'CONTA_CORRENTE_PAG'::text]))
              ), canon AS (
               SELECT mov.company,
                  mov.cod,
                  mov.tipo,
                  bool_or(mov.grupo = ANY (ARRAY['CONTA_A_RECEBER'::text, 'CONTA_A_PAGAR'::text])) AS tem_otica_titulo
                 FROM mov
                GROUP BY mov.company, mov.cod, mov.tipo
              ), base AS (
               SELECT m.company,
                  m.cod,
                  m.tipo,
                  m.data_movimento,
                  m.valor,
                      CASE
                          WHEN c.tem_otica_titulo THEN 'titulo'::text
                          ELSE 'conta_corrente'::text
                      END AS origem
                 FROM mov m
                   JOIN canon c ON c.company = m.company AND c.cod = m.cod AND c.tipo = m.tipo
                WHERE c.tem_otica_titulo AND (m.grupo = ANY (ARRAY['CONTA_A_RECEBER'::text, 'CONTA_A_PAGAR'::text])) OR NOT c.tem_otica_titulo
              ), mov_canon AS (
              ( SELECT DISTINCT ON (base.company, base.cod, base.tipo) base.company,
                  base.cod,
                  base.tipo,
                  base.data_movimento,
                  base.valor,
                  base.origem
                 FROM base
                WHERE base.origem = 'titulo'::text
                ORDER BY base.company, base.cod, base.tipo, base.valor DESC, base.data_movimento DESC)
              UNION ALL
               SELECT base.company,
                  base.cod,
                  base.tipo,
                  base.data_movimento,
                  base.valor,
                  base.origem
                 FROM base
                WHERE base.origem = 'conta_corrente'::text
              )
       SELECT cr.company,
          cr.omie_codigo_lancamento,
          'CR'::text AS tipo,
          max(m.data_movimento) AS data_baixa_final,
          sum(m.valor) AS valor_baixado,
          count(*)::integer AS n_movimentos,
              CASE
                  WHEN cr.data_emissao IS NOT NULL AND sum(m.valor) > 0::numeric THEN round(sum(m.valor * (m.data_movimento - cr.data_emissao)::numeric) / sum(m.valor))
                  ELSE NULL::numeric
              END AS prazo_ponderado_dias,
          max(m.origem) AS origem_baixa
         FROM fin_contas_receber cr
           JOIN mov_canon m ON m.company = cr.company AND m.cod = cr.omie_codigo_lancamento AND m.tipo = 'E'::text
        WHERE cr.company = p_company AND cr.omie_codigo_lancamento IS NOT NULL AND (cr.status_titulo = ANY (ARRAY['RECEBIDO'::text, 'LIQUIDADO'::text]))
        GROUP BY cr.company, cr.omie_codigo_lancamento, cr.data_emissao
      UNION ALL
       SELECT cp.company,
          cp.omie_codigo_lancamento,
          'CP'::text AS tipo,
          max(m.data_movimento) AS data_baixa_final,
          sum(m.valor) AS valor_baixado,
          count(*)::integer AS n_movimentos,
              CASE
                  WHEN cp.data_emissao IS NOT NULL AND sum(m.valor) > 0::numeric THEN round(sum(m.valor * (m.data_movimento - cp.data_emissao)::numeric) / sum(m.valor))
                  ELSE NULL::numeric
              END AS prazo_ponderado_dias,
          max(m.origem) AS origem_baixa
         FROM fin_contas_pagar cp
           JOIN mov_canon m ON m.company = cp.company AND m.cod = cp.omie_codigo_lancamento AND m.tipo = 'S'::text
        WHERE cp.company = p_company AND cp.omie_codigo_lancamento IS NOT NULL AND (cp.status_titulo = ANY (ARRAY['PAGO'::text, 'LIQUIDADO'::text]))
        GROUP BY cp.company, cp.omie_codigo_lancamento, cp.data_emissao
    ), companies AS (
             SELECT DISTINCT fin_contas_receber.company
               FROM fin_contas_receber
              WHERE fin_contas_receber.company = p_company
            UNION
             SELECT DISTINCT fin_contas_pagar.company
               FROM fin_contas_pagar
              WHERE fin_contas_pagar.company = p_company
            ), cr_baixa AS (
             SELECT v_titulo_baixas.company,
                round(sum(v_titulo_baixas.prazo_ponderado_dias * v_titulo_baixas.valor_baixado) / NULLIF(sum(v_titulo_baixas.valor_baixado), 0::numeric)) AS pmr,
                count(*) AS n
               FROM vb v_titulo_baixas
              WHERE v_titulo_baixas.tipo = 'CR'::text AND v_titulo_baixas.prazo_ponderado_dias IS NOT NULL
              GROUP BY v_titulo_baixas.company
            ), cp_baixa AS (
             SELECT v_titulo_baixas.company,
                round(sum(v_titulo_baixas.prazo_ponderado_dias * v_titulo_baixas.valor_baixado) / NULLIF(sum(v_titulo_baixas.valor_baixado), 0::numeric)) AS pmp,
                count(*) AS n
               FROM vb v_titulo_baixas
              WHERE v_titulo_baixas.tipo = 'CP'::text AND v_titulo_baixas.prazo_ponderado_dias IS NOT NULL
              GROUP BY v_titulo_baixas.company
            ), cr_set AS (
             SELECT fin_contas_receber.company,
                count(*) AS n
               FROM fin_contas_receber
              WHERE fin_contas_receber.company = p_company AND fin_contas_receber.status_titulo = ANY (ARRAY['RECEBIDO'::text, 'LIQUIDADO'::text])
              GROUP BY fin_contas_receber.company
            ), cp_set AS (
             SELECT fin_contas_pagar.company,
                count(*) AS n
               FROM fin_contas_pagar
              WHERE fin_contas_pagar.company = p_company AND fin_contas_pagar.status_titulo = ANY (ARRAY['PAGO'::text, 'LIQUIDADO'::text])
              GROUP BY fin_contas_pagar.company
            )
     SELECT c.company,
        crb.pmr,
        cpb.pmp,
        round(COALESCE(crb.n, 0::bigint)::numeric / NULLIF(crs.n, 0)::numeric, 3) AS pmr_cobertura,
        round(COALESCE(cpb.n, 0::bigint)::numeric / NULLIF(cps.n, 0)::numeric, 3) AS pmp_cobertura
       FROM companies c
         LEFT JOIN cr_baixa crb ON crb.company = c.company
         LEFT JOIN cp_baixa cpb ON cpb.company = c.company
         LEFT JOIN cr_set crs ON crs.company = c.company
         LEFT JOIN cp_set cps ON cps.company = c.company
  )
  SELECT jsonb_build_object(
           'existe', p.company IS NOT NULL,
           'pmr', p.pmr,
           'pmp', p.pmp,
           'pmr_cobertura', p.pmr_cobertura,
           'pmp_cobertura', p.pmp_cobertura)
    FROM (SELECT 1) um
    LEFT JOIN prazos p ON true
  );
END
$$;
REVOKE ALL ON FUNCTION public.fin_capital_giro_prazos_empresa(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fin_capital_giro_prazos_empresa(text) FROM anon;
REVOKE ALL ON FUNCTION public.fin_capital_giro_prazos_empresa(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fin_capital_giro_prazos_empresa(text) TO service_role;

DO $post$
DECLARE
  f oid := to_regprocedure('public.fin_capital_giro_prazos_empresa(text)');
BEGIN
  IF f IS NULL THEN
    RAISE EXCEPTION 'A1 FALHOU: fin_capital_giro_prazos_empresa(text) ausente';
  END IF;
  IF (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = f) THEN
    RAISE EXCEPTION 'A2 FALHOU: fin_capital_giro_prazos_empresa virou SECURITY DEFINER — leria como OWNER, fora do RLS da view';
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE')
     OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'A3 FALHOU: anon/authenticated ainda executam fin_capital_giro_prazos_empresa';
  END IF;
  IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'A4 FALHOU: service_role sem EXECUTE — o engine receberia 42501';
  END IF;
  -- Assert por EXECUÇÃO (late-bound): empresa inexistente devolve o envelope com existe=false.
  IF public.fin_capital_giro_prazos_empresa('__empresa_inexistente__')
     IS DISTINCT FROM '{"existe": false, "pmr": null, "pmp": null, "pmr_cobertura": null, "pmp_cobertura": null}'::jsonb THEN
    RAISE EXCEPTION 'A5 FALHOU: empresa inexistente nao devolveu o envelope com existe=false';
  END IF;
  -- A7: empresa nula falha alta com 22004 (nunca envelope). Captura SÓ a SQLSTATE esperada; a
  -- falha da asserção (P0001) e qualquer outro erro sobem.
  BEGIN
    PERFORM public.fin_capital_giro_prazos_empresa(NULL);
    RAISE EXCEPTION 'A7 FALHOU: p_company nulo devolveu envelope em vez de 22004';
  EXCEPTION WHEN SQLSTATE '22004' THEN
    NULL;
  END;
  -- A6: igualdade com a view (o contrato da cópia) em TODA empresa das tabelas-base, inclusive as
  -- que a view não tem (existe=false) — EXCEPT ALL nos dois sentidos (trata NULL como igual).
  IF EXISTS (
    WITH emp AS (
      SELECT company FROM public.fin_movimentacoes WHERE company IS NOT NULL
      UNION SELECT company FROM public.fin_contas_receber WHERE company IS NOT NULL
      UNION SELECT company FROM public.fin_contas_pagar WHERE company IS NOT NULL),
    novo AS (
      SELECT e.company, (j->>'existe')::boolean AS existe, (j->>'pmr')::numeric AS pmr,
             (j->>'pmp')::numeric AS pmp, (j->>'pmr_cobertura')::numeric AS pmr_cob,
             (j->>'pmp_cobertura')::numeric AS pmp_cob
        FROM emp e, LATERAL public.fin_capital_giro_prazos_empresa(e.company) j),
    velho AS (
      SELECT e.company, v.company IS NOT NULL, v.pmr, v.pmp, v.pmr_cobertura, v.pmp_cobertura
        FROM emp e LEFT JOIN public.v_capital_giro_prazos v ON v.company = e.company)
    (SELECT * FROM novo EXCEPT ALL SELECT * FROM velho)
    UNION ALL
    (SELECT * FROM velho EXCEPT ALL SELECT * FROM novo)
  ) THEN
    RAISE EXCEPTION 'A6 FALHOU: fin_capital_giro_prazos_empresa diverge de v_capital_giro_prazos — a copia nao e a da view';
  END IF;
  RAISE NOTICE 'fin_capital_giro_prazos_empresa ok: invoker, so service_role executa, envelope coerente, igual a view';
END
$post$;
