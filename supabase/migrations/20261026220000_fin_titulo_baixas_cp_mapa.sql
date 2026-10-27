-- ============================================================
-- fin_titulo_baixas_cp_mapa(p_company) — baixa REAL derivada (v_titulo_baixas, tipo CP) numa
-- ÚNICA avaliação, irmã da fin_titulo_baixas_cp_mapa (migration 20261026220000), para o
-- DRE-caixa da omie-financeiro (carregarBaixaMap).
--
-- Medido em prod (psql-ro, 2026-10-26): a omie-financeiro lia v_titulo_baixas por keyset em
-- páginas de 1.000 — colacor 29 páginas CR + 12 CP, oben 14 + 3. Cada página reavalia a view
-- INTEIRA (CTE `mov` materializado sobre fin_movimentacoes, sem pushdown de company): EXPLAIN
-- ANALYZE 512–619 ms por página, até na colacor_sc. O cron fin-dre-recalculo-diario gravou o
-- caixa da colacor 47 s depois do disparo (competência: ~10 s). A CR já tem a RPC; esta é a CP.
--
-- Corpo: o RAMO CP da view, verbatim de pg_get_viewdef da PROD (md5
-- 57e98392e33a254d924927f8e07dea5f — o MESMO da cópia CR), com `company = p_company` em `mov` e
-- em `cp`. Mesmas três travas da irmã: PRE por md5 sob LOCK, postcondição de igualdade linha a
-- linha com a view em todas as empresas, e guarda de md5 a CADA chamada (P0001).
-- Envelope {total, pares: [[omie_codigo_lancamento, data_baixa_final], …]} pelo mesmo motivo da
-- irmã (o supabase-js converte 404 com `[]` em {data: [], error: null}).
-- SECURITY INVOKER; EXECUTE só para service_role, PUBLIC/anon/authenticated revogados pelo nome.
-- ============================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- TRAVA: ninguém troca a view entre o PRE e o fim desta transação. ACCESS SHARE basta (o
-- CREATE OR REPLACE VIEW concorrente pede ACCESS EXCLUSIVE e espera) e NÃO bloqueia leitura nem
-- DML — o LOCK numa view trava recursivamente as tabelas-base (Codex challenge, 2ª rodada).
LOCK TABLE public.v_titulo_baixas IN ACCESS SHARE MODE;

-- PRE anti-deriva: o corpo abaixo é cópia do ramo CP DESTA definição da view.
DO $pre$
DECLARE vivo text := md5(pg_get_viewdef('public.v_titulo_baixas'::regclass, true));
BEGIN
  IF vivo IS DISTINCT FROM '57e98392e33a254d924927f8e07dea5f' THEN
    RAISE EXCEPTION 'PRE FALHOU: v_titulo_baixas viva (md5 %) nao e a copiada nesta funcao — refaca a copia', vivo;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.fin_titulo_baixas_cp_mapa(p_company text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Guarda de deriva em RUNTIME: o corpo abaixo é cópia do ramo CP DESTA definição da view.
  -- Se a view mudar, a função falha EXPLÍCITA (a omie-financeiro fecha em erro com P0001) em vez de
  -- divergir em silêncio — refaça a cópia (e o md5) numa migration nova.
  IF md5(pg_get_viewdef('public.v_titulo_baixas'::regclass, true)) IS DISTINCT FROM '57e98392e33a254d924927f8e07dea5f' THEN
    RAISE EXCEPTION 'fin_titulo_baixas_cp_mapa: v_titulo_baixas mudou desde a copia (migration 20261026220000) — refaca a copia do ramo CP'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN (
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
  )
  SELECT jsonb_build_object(
           'total', count(*),
           'pares', COALESCE(
                      jsonb_agg(jsonb_build_array(vb.omie_codigo_lancamento, vb.data_baixa_final)
                                ORDER BY vb.omie_codigo_lancamento),
                      '[]'::jsonb))
    FROM vb
   WHERE vb.omie_codigo_lancamento IS NOT NULL
     AND vb.data_baixa_final IS NOT NULL
  );
END
$$;
REVOKE ALL ON FUNCTION public.fin_titulo_baixas_cp_mapa(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fin_titulo_baixas_cp_mapa(text) FROM anon;
REVOKE ALL ON FUNCTION public.fin_titulo_baixas_cp_mapa(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fin_titulo_baixas_cp_mapa(text) TO service_role;

DO $post$
DECLARE
  f oid := to_regprocedure('public.fin_titulo_baixas_cp_mapa(text)');
BEGIN
  IF f IS NULL THEN
    RAISE EXCEPTION 'A1 FALHOU: fin_titulo_baixas_cp_mapa(text) ausente — o DRE-caixa da omie-financeiro falharia (fail-closed)';
  END IF;
  IF (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = f) THEN
    RAISE EXCEPTION 'A2 FALHOU: fin_titulo_baixas_cp_mapa virou SECURITY DEFINER — leria como OWNER, fora do RLS da view';
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE')
     OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'A3 FALHOU: anon/authenticated ainda executam fin_titulo_baixas_cp_mapa';
  END IF;
  IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'A4 FALHOU: service_role sem EXECUTE — a omie-financeiro receberia 42501';
  END IF;
  -- Assert por EXECUÇÃO (late-bound): a função roda e devolve {total, pares} coerente.
  DECLARE r jsonb := public.fin_titulo_baixas_cp_mapa('oben');
  BEGIN
    IF jsonb_typeof(r->'pares') IS DISTINCT FROM 'array'
       OR (r->>'total')::bigint IS DISTINCT FROM jsonb_array_length(r->'pares') THEN
      RAISE EXCEPTION 'A5 FALHOU: fin_titulo_baixas_cp_mapa(''oben'') nao devolveu {total, pares} coerente';
    END IF;
  END;
  -- A6: igualdade linha a linha com a view (o contrato da cópia), em TODA empresa das tabelas-base
  -- (inclusive as sem CP elegível, que têm de sair com total 0).
  IF EXISTS (
    WITH emp AS (SELECT company FROM public.fin_movimentacoes UNION SELECT company FROM public.fin_contas_pagar),
    novo AS (
      SELECT e.company, (p->>0)::bigint AS cod, (p->>1)::date AS d
        FROM emp e, jsonb_array_elements(public.fin_titulo_baixas_cp_mapa(e.company)->'pares') p),
    velho AS (
      SELECT company, omie_codigo_lancamento AS cod, data_baixa_final AS d
        FROM public.v_titulo_baixas
       WHERE tipo = 'CP' AND omie_codigo_lancamento IS NOT NULL AND data_baixa_final IS NOT NULL)
    (SELECT * FROM novo EXCEPT ALL SELECT * FROM velho)
    UNION ALL
    (SELECT * FROM velho EXCEPT ALL SELECT * FROM novo)
  ) THEN
    RAISE EXCEPTION 'A6 FALHOU: fin_titulo_baixas_cp_mapa diverge de v_titulo_baixas (CP) — a copia nao e o ramo CP da view';
  END IF;
  RAISE NOTICE 'fin_titulo_baixas_cp_mapa ok: invoker, so service_role executa, {total, pares} coerente, igual a view';
END
$post$;

COMMIT;
