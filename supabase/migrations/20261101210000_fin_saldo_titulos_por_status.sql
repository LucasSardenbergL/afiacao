-- ============================================================
-- fin_saldo_titulos_por_status(p_companies, p_statuses) — soma de `saldo` de CR e CP agrupada por
-- (tabela, empresa, status), calculada NO BANCO. Plano v4, lote 13 (item C6), entrega 1 de 2.
--
-- Hoje o resumo do cockpit (getResumoFinanceiro → somarSaldoPorStatus, financeiroService.ts) baixa
-- a coluna `saldo` título a título, paginada, e soma no navegador (`total += r.saldo ?? 0`).
-- Medido em prod (psql-ro, 2026-11-01): 3.428 linhas em 12 requests por abertura, refeitas a cada
-- mount e a cada troca de regime. Esta função devolve os mesmos subtotais em 1 request; a troca do
-- cliente é a entrega 2 (só depois desta estar em prod).
--
-- MESMO universo do código atual: `company = ANY(p_companies) AND status_titulo = ANY(p_statuses)`
-- é o `.eq('company').in('status_titulo')` do PostgREST (status NULL não casa em nenhum dos dois;
-- comparação exata, sem trim/caixa). Os conjuntos de status continuam vindo do TS
-- (OPEN_TITLE_STATUSES / VENCIDO_TITLE_STATUSES): o SQL não tem lista própria para derivar.
--
-- Ausente ≠ zero (money-path §2) — parecer Codex do desenho, 2026-11-01:
--   - Estado POR EMPRESA no envelope: `ok` (leitura feita, inclusive vazia), `sem_acesso`
--     (fin_user_can_access falso — o MESMO predicado das policies fin_cr_select/fin_cp_select; sem
--     isto a RLS devolveria zero linhas e o cliente leria "carteira vazia = R$ 0") e `desconhecida`
--     (nenhum título da empresa em NENHUM status nas duas tabelas: "obne" passaria no gate de um
--     employee e viraria R$ 0 legítimo). Só empresa `ok` tem grupos, e só nela grupo ausente quer
--     dizer "sem título nesses status". Não é RAISE: o usuário com fin_permissoes de UMA empresa
--     perderia também os números que pode ver.
--   - `saldo` sai como STRING decimal (sum numeric exato): número JSON → `Number` perde centavo
--     acima de 2^53 centavos, e a composição no cliente é em centavos inteiros.
--   - `n_saldo_nulo` conta título com saldo NULL (impossível hoje — saldo é GERADA de
--     valor_documento NOT NULL —, mas a coluna aceita NULL): a função não converte NULL em 0.
--   - Envelope jsonb e não SETOF: o supabase-js converte 404 com corpo `[]` em
--     {data: [], error: null}; o cliente rejeita o que não for o envelope desta versão.
-- SECURITY INVOKER: lê com a RLS de quem chama. search_path = pg_catalog, pg_temp e tudo do
-- schema public qualificado. EXECUTE só para authenticated; PUBLIC, anon e service_role revogados
-- pelo nome (o default privilege do Supabase concede aos três).
-- Sem BEGIN/COMMIT: aplicada por `bun run db:aplicar`, cuja transação é do executor. A prova
-- PG17 (db/test-fin-saldo-titulos-por-status.sh) aplica com --single-transaction pelo mesmo motivo.
-- ============================================================

-- Sem statement_timeout próprio: dentro do aplicar_sql() o SET LOCAL não rearma o timer do comando
-- em curso — vale o do executor (scripts/db-aplicar.sh, 300 s). Parecer Codex do código, 2026-11-01.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fin_saldo_titulos_por_status(p_companies text[], p_statuses text[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_company text;
  v_estado text;
  v_ok text[] := '{}';
  v_empresas jsonb := '[]'::jsonb;
  v_grupos jsonb;
BEGIN
  IF p_companies IS NULL OR cardinality(p_companies) = 0 OR array_position(p_companies, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'fin_saldo_titulos_por_status: p_companies precisa de ao menos uma empresa e nenhuma nula'
      USING ERRCODE = '22023';
  END IF;
  IF p_statuses IS NULL OR cardinality(p_statuses) = 0 OR array_position(p_statuses, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'fin_saldo_titulos_por_status: p_statuses precisa de ao menos um status e nenhum nulo'
      USING ERRCODE = '22023';
  END IF;

  FOR v_company IN SELECT DISTINCT c FROM unnest(p_companies) AS u(c) ORDER BY c LOOP
    IF public.fin_user_can_access(v_company) IS NOT TRUE THEN
      v_estado := 'sem_acesso';
    ELSIF NOT EXISTS (SELECT 1 FROM public.fin_contas_receber cr WHERE cr.company = v_company)
      AND NOT EXISTS (SELECT 1 FROM public.fin_contas_pagar cp WHERE cp.company = v_company) THEN
      v_estado := 'desconhecida';
    ELSE
      v_estado := 'ok';
      v_ok := v_ok || v_company;
    END IF;
    v_empresas := v_empresas || jsonb_build_array(jsonb_build_object('company', v_company, 'estado', v_estado));
  END LOOP;

  SELECT coalesce(
           jsonb_agg(jsonb_build_object(
             'tabela', g.tabela,
             'company', g.company,
             'status_titulo', g.status_titulo,
             'n_titulos', g.n_titulos,
             'n_saldo_nulo', g.n_saldo_nulo,
             'saldo', g.saldo::text)
           ORDER BY g.tabela, g.company, g.status_titulo),
           '[]'::jsonb)
    INTO v_grupos
    FROM (
      SELECT 'receber'::text AS tabela, cr.company, cr.status_titulo,
             count(*) AS n_titulos,
             count(*) FILTER (WHERE cr.saldo IS NULL) AS n_saldo_nulo,
             sum(cr.saldo) AS saldo
        FROM public.fin_contas_receber cr
       WHERE cr.company = ANY(v_ok) AND cr.status_titulo = ANY(p_statuses)
       GROUP BY cr.company, cr.status_titulo
      UNION ALL
      SELECT 'pagar'::text, cp.company, cp.status_titulo,
             count(*),
             count(*) FILTER (WHERE cp.saldo IS NULL),
             sum(cp.saldo)
        FROM public.fin_contas_pagar cp
       WHERE cp.company = ANY(v_ok) AND cp.status_titulo = ANY(p_statuses)
       GROUP BY cp.company, cp.status_titulo
    ) g;

  RETURN jsonb_build_object('versao', 1, 'empresas', v_empresas, 'grupos', v_grupos);
END
$fn$;

COMMENT ON FUNCTION public.fin_saldo_titulos_por_status(text[], text[]) IS
  'Soma de saldo (string decimal) de fin_contas_receber/fin_contas_pagar por (tabela, empresa, status), '
  'com os filtros do getResumoFinanceiro. Envelope {versao:1, empresas[{company, estado ok|sem_acesso|desconhecida}], grupos[]}; '
  'grupo ausente = sem título só em empresa ok. Plano v4 lote 13.';

REVOKE ALL ON FUNCTION public.fin_saldo_titulos_por_status(text[], text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fin_saldo_titulos_por_status(text[], text[]) FROM anon;
REVOKE ALL ON FUNCTION public.fin_saldo_titulos_por_status(text[], text[]) FROM service_role;
GRANT EXECUTE ON FUNCTION public.fin_saldo_titulos_por_status(text[], text[]) TO authenticated;

DO $post$
DECLARE
  f constant text := 'public.fin_saldo_titulos_por_status(text[], text[])';
  v_master uuid;
  v jsonb;
BEGIN
  IF (SELECT prosecdef FROM pg_proc WHERE oid = f::regprocedure) IS NOT FALSE THEN
    RAISE EXCEPTION 'A1 FALHOU: fin_saldo_titulos_por_status não é SECURITY INVOKER';
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('service_role', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'A2 FALHOU: anon ou service_role executa fin_saldo_titulos_por_status';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
              WHERE p.oid = f::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'A3 FALHOU: PUBLIC ainda tem EXECUTE em fin_saldo_titulos_por_status';
  END IF;
  IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'A4 FALHOU: authenticated sem EXECUTE — o cockpit receberia 42501';
  END IF;

  -- A5 (late-bound): sem identidade, toda empresa sai `sem_acesso` e nenhum grupo — nunca R$ 0 de RLS.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{}', true);
  v := public.fin_saldo_titulos_por_status(ARRAY['oben', 'colacor'], ARRAY['ATRASADO']);
  IF v IS DISTINCT FROM jsonb_build_object('versao', 1, 'grupos', '[]'::jsonb, 'empresas', jsonb_build_array(
       jsonb_build_object('company', 'colacor', 'estado', 'sem_acesso'),
       jsonb_build_object('company', 'oben', 'estado', 'sem_acesso'))) THEN
    RAISE EXCEPTION 'A5 FALHOU: sem identidade a função não devolveu só sem_acesso: %', v;
  END IF;

  -- A6 (late-bound, dado de prod): como um master, toda empresa existente sai `ok` e os grupos são
  -- IGUAIS ao agregado direto sobre todo status não-nulo — EXCEPT ALL nos dois sentidos.
  SELECT ur.user_id INTO v_master FROM public.user_roles ur WHERE ur.role = 'master' ORDER BY ur.user_id LIMIT 1;
  IF v_master IS NULL THEN
    RAISE EXCEPTION 'A6 FALHOU: nenhum master em user_roles para exercitar o corpo da função';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_master::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_master, 'role', 'authenticated')::text, true);
  IF EXISTS (
    WITH emp AS (
      SELECT array_agg(DISTINCT company) AS a FROM (
        SELECT company FROM public.fin_contas_receber UNION SELECT company FROM public.fin_contas_pagar) e),
    sts AS (
      SELECT array_agg(DISTINCT status_titulo) AS a FROM (
        SELECT status_titulo FROM public.fin_contas_receber WHERE status_titulo IS NOT NULL
        UNION SELECT status_titulo FROM public.fin_contas_pagar WHERE status_titulo IS NOT NULL) s),
    resp AS (SELECT public.fin_saldo_titulos_por_status(emp.a, sts.a) AS j FROM emp, sts),
    -- empresas: o multiconjunto (company, estado) tem de ser EXATAMENTE "toda empresa existente, ok, 1×"
    -- — checar só as presentes aprovaria `empresas=[]` ou uma empresa duplicada (parecer Codex).
    emp_novo AS (SELECT e->>'company' AS company, e->>'estado' AS estado FROM resp, jsonb_array_elements(resp.j->'empresas') e),
    emp_velho AS (SELECT unnest(emp.a) AS company, 'ok'::text AS estado FROM emp),
    nao_ok AS (
      (SELECT * FROM emp_novo EXCEPT ALL SELECT * FROM emp_velho)
      UNION ALL
      (SELECT * FROM emp_velho EXCEPT ALL SELECT * FROM emp_novo)),
    novo AS (
      SELECT x->>'tabela' AS tabela, x->>'company' AS company, x->>'status_titulo' AS status_titulo,
             (x->>'n_titulos')::bigint AS n, (x->>'n_saldo_nulo')::bigint AS n_nulo, (x->>'saldo')::numeric AS saldo
        FROM resp, jsonb_array_elements(resp.j->'grupos') x),
    velho AS (
      SELECT 'receber', company, status_titulo, count(*), count(*) FILTER (WHERE saldo IS NULL), sum(saldo)
        FROM public.fin_contas_receber WHERE status_titulo IS NOT NULL GROUP BY company, status_titulo
      UNION ALL
      SELECT 'pagar', company, status_titulo, count(*), count(*) FILTER (WHERE saldo IS NULL), sum(saldo)
        FROM public.fin_contas_pagar WHERE status_titulo IS NOT NULL GROUP BY company, status_titulo)
    SELECT 1 FROM nao_ok
    UNION ALL
    (SELECT 1 FROM (SELECT * FROM novo EXCEPT ALL SELECT * FROM velho) d)
    UNION ALL
    (SELECT 1 FROM (SELECT * FROM velho EXCEPT ALL SELECT * FROM novo) d)
  ) THEN
    RAISE EXCEPTION 'A6 FALHOU: fin_saldo_titulos_por_status diverge do agregado direto das tabelas (ou empresa não-ok para master)';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{}', true);
  RAISE NOTICE 'fin_saldo_titulos_por_status ok: invoker, só authenticated executa, sem identidade = sem_acesso, igual ao agregado direto';
END
$post$;
