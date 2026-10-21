-- ============================================================================================
-- fin_consolidado_intercompany: a eliminação intercompany REDUZ o CMV (antes somava)
-- Prova PG17: db/test-fin-consolidado-ic.sh (os dois locales + --falsificar)
-- Histórico: docs/historico/consolidado-ic-sinal-cmv.md
--
-- Caminho de apply: `bun run db:aplicar` — a transação é do EXECUTOR, por isso este arquivo NÃO leva
-- BEGIN/COMMIT. Idempotente. Molde TRAVA → PRE → CREATE → ACL → PÓS. Mesma assinatura (CREATE OR
-- REPLACE preserva o ACL; ainda assim a ACL é reemitida nomeando as roles).
--
-- O defeito: o CMV é gravado POSITIVO em fin_dre_snapshots (lucro_bruto = receita_liquida - cmv; prod
-- 2026-10-20: 91 linhas > 0, 23 = 0, nenhuma < 0) e a v2 fazia `cmv + valor_elim`. A venda IC entra como
-- receita de quem vende e como CMV (compra de mercadoria) de quem compra; o consolidado tira o MESMO
-- valor das duas linhas e o resultado fica intacto. O consolidado do CMV saía INFLADO em 2×valor_elim.
-- Latente em prod: fin_ic_matches tem 0 linhas (o reconcile não casa — cnpj_cpf vazio em CR/CP).
--
-- Decisões (registradas no PR; desenho revisto após o parecer Codex de DESENHO):
--  • Receita e CMV: eliminação = -E, o MESMO valor. despesas e resultado: 0 (o resultado fica intacto).
--  • Escopo: só pares confirmados cujas DUAS empresas têm snapshot competência no mês. Numa soma parcial,
--    o par com uma empresa ausente é transação com quem está FORA da soma — nem elimina, nem pende.
--  • Elegível = PROVADO pelo próprio snapshot, sem espelhar o classificador do motor: a categoria do CR
--    compôs SÓ receita_bruta na origem e a do CP SÓ cmv no destino (detalhamento.composicao_*), CR e CP
--    emitidos no mês, mesma empresa do par, nenhum CANCELADO ou sem status (o motor os exclui),
--    valor_documento igual e > 0, cada título em um único par, a soma eliminada de uma categoria ≤ o que
--    ela compôs, e o snapshot FIEL aos títulos de hoje: a soma atual da categoria (mesmo recorte do motor)
--    bate com a composição — senão o valor mudou depois do cálculo ou o título entrou entre a leitura e o
--    carimbo (parecer Codex adversarial). E = valor_documento (o valor que o motor usa em competência).
--  • Par confirmado que toca o mês e NÃO é elegível (sem contrapartida, valor divergente, CP em outro
--    mês, categoria fora de receita/CMV, snapshot anterior ao título) → consolidado DESCONHECIDO: as 4
--    linhas saem com eliminacoes/total_consolidado NULL ("—" na tela). Precisão > recall.
--  • Ausente ≠ zero: conta sem snapshot (ou com a coluna NULL em algum) → total_bruto NULL (era 0 pelo
--    COALESCE).
--  • Linhas em ordem fixa (receita, cmv, despesas, resultado) por ORDER BY explícito.
--  • Fora do escopo (limitação do MODELO, não da RPC): o CMV do motor é COMPRA por emissão, não custo da
--    mercadoria vendida — mercadoria IC ainda em estoque não tem o lucro não realizado eliminado.
-- ============================================================================================

-- ── 1. TRAVA (antes de ler): ALTER sem efeito (a volatilidade VIVA) na função recriada ─────────
DO $trava$
BEGIN
  IF to_regprocedure('public.fin_consolidado_intercompany(integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: fin_consolidado_intercompany(integer,integer) ausente';
  END IF;
  ALTER FUNCTION public.fin_consolidado_intercompany(integer, integer) STABLE;
END
$trava$;

-- ── 2. PRE: corpo vivo ∈ {predecessor revisado (prod 2026-10-21), este} ──────────────────────────
DO $pre$
DECLARE
  v_vivo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                   WHERE p.oid = to_regprocedure('public.fin_consolidado_intercompany(integer,integer)'));
BEGIN
  IF v_vivo IS NULL OR v_vivo NOT IN ('c645a48b2803e122e770341d44b9aaaf', '11832f17b7551cabe02a2224cb495aaf') THEN
    RAISE EXCEPTION 'PRE FALHOU: fin_consolidado_intercompany vivo (md5 %) nao e o predecessor revisado nem este', v_vivo;
  END IF;
END
$pre$;

-- ── 3. A função ───────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fin_consolidado_intercompany(p_ano integer, p_mes integer)
RETURNS TABLE(conta text, total_bruto numeric, eliminacoes numeric, total_consolidado numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
#variable_conflict use_column
BEGIN
  IF NOT (
    COALESCE(auth.role() = 'service_role', false)
    OR COALESCE(public.has_role(auth.uid(), 'employee'::public.app_role), false)
    OR COALESCE(public.has_role(auth.uid(), 'master'::public.app_role), false)
  ) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH snap AS (
    SELECT s.company, s.receita_bruta, s.cmv, s.despesas_operacionais, s.resultado_liquido,
           s.detalhamento
      FROM fin_dre_snapshots s
     WHERE s.ano = p_ano AND s.mes = p_mes AND s.regime = 'competencia'
  ),
  -- Ausente ≠ zero: sem snapshot (ou com a coluna NULL em algum) a conta sai NULL, nunca 0.
  dre_all AS (
    SELECT 1 AS ordem, 'receita_bruta'::text AS conta,
           CASE WHEN count(s.receita_bruta) = count(*) THEN sum(s.receita_bruta) END AS total FROM snap s
    UNION ALL
    SELECT 2, 'cmv',
           CASE WHEN count(s.cmv) = count(*) THEN sum(s.cmv) END FROM snap s
    UNION ALL
    SELECT 3, 'despesas_operacionais',
           CASE WHEN count(s.despesas_operacionais) = count(*) THEN sum(s.despesas_operacionais) END FROM snap s
    UNION ALL
    SELECT 4, 'resultado_liquido',
           CASE WHEN count(s.resultado_liquido) = count(*) THEN sum(s.resultado_liquido) END FROM snap s
  ),
  -- Pares confirmados que TOCAM o mês (CR ou CP emitido nele) entre duas empresas que estão na soma.
  -- Par com uma empresa fora da soma é transação com quem está fora: nem se elimina, nem fica pendente.
  confirmado AS (
    SELECT m.empresa_origem, m.empresa_destino, m.cr_id, m.cp_id,
           CASE WHEN m.cr_id IS NULL THEN 1 ELSE count(*) OVER (PARTITION BY m.cr_id) END AS usos_cr,
           CASE WHEN m.cp_id IS NULL THEN 1 ELSE count(*) OVER (PARTITION BY m.cp_id) END AS usos_cp
      FROM fin_ic_matches m
     WHERE m.status IN ('auto_matched', 'manual_matched')
  ),
  par AS (
    SELECT c.empresa_origem, c.empresa_destino, c.usos_cr, c.usos_cp,
           cr.id AS cr_id, cr.company AS cr_empresa, cr.valor_documento AS cr_valor,
           cr.status_titulo AS cr_status,
           COALESCE(NULLIF(cr.categoria_descricao, ''), NULLIF(cr.categoria_codigo, ''), 'Sem categoria') AS cr_chave,
           (EXTRACT(YEAR FROM cr.data_emissao) = p_ano AND EXTRACT(MONTH FROM cr.data_emissao) = p_mes) AS cr_no_mes,
           cp.id AS cp_id, cp.company AS cp_empresa, cp.valor_documento AS cp_valor,
           cp.status_titulo AS cp_status,
           COALESCE(NULLIF(cp.categoria_descricao, ''), NULLIF(cp.categoria_codigo, ''), 'Sem categoria') AS cp_chave,
           (EXTRACT(YEAR FROM cp.data_emissao) = p_ano AND EXTRACT(MONTH FROM cp.data_emissao) = p_mes) AS cp_no_mes,
           so.detalhamento -> 'composicao_receitas' AS so_comp,
           sd.detalhamento -> 'composicao_despesas' AS sd_comp
      FROM confirmado c
      JOIN snap so ON so.company = c.empresa_origem
      JOIN snap sd ON sd.company = c.empresa_destino
      LEFT JOIN fin_contas_receber cr ON cr.id = c.cr_id
      LEFT JOIN fin_contas_pagar   cp ON cp.id = c.cp_id
  ),
  par_mes AS (
    SELECT p.*, p.so_comp -> p.cr_chave AS comp_r, p.sd_comp -> p.cp_chave AS comp_d
      FROM par p
     WHERE p.cr_no_mes IS TRUE OR p.cp_no_mes IS TRUE
  ),
  -- Soma ATUAL de cada categoria no mês, com o MESMO recorte do motor de competência (empresa, emissão no
  -- mês, status <> 'CANCELADO' — o `.neq` do PostgREST também exclui NULL) e a MESMA chave da composição.
  -- Se ela não bate com o que o snapshot compôs, o snapshot não reflete os títulos de hoje (valor mudou
  -- depois do cálculo, título entrou entre a leitura e o carimbo): o par não prova que entrou no bruto.
  atual AS (
    SELECT 'r'::text AS lado, r.company,
           COALESCE(NULLIF(r.categoria_descricao, ''), NULLIF(r.categoria_codigo, ''), 'Sem categoria') AS chave,
           sum(r.valor_documento) AS soma
      FROM fin_contas_receber r
     WHERE r.company IN (SELECT s.company FROM snap s)
       AND r.status_titulo <> 'CANCELADO'
       AND EXTRACT(YEAR FROM r.data_emissao) = p_ano AND EXTRACT(MONTH FROM r.data_emissao) = p_mes
     GROUP BY 1, 2, 3
    UNION ALL
    SELECT 'd', d.company,
           COALESCE(NULLIF(d.categoria_descricao, ''), NULLIF(d.categoria_codigo, ''), 'Sem categoria'),
           sum(d.valor_documento)
      FROM fin_contas_pagar d
     WHERE d.company IN (SELECT s.company FROM snap s)
       AND d.status_titulo <> 'CANCELADO'
       AND EXTRACT(YEAR FROM d.data_emissao) = p_ano AND EXTRACT(MONTH FROM d.data_emissao) = p_mes
     GROUP BY 1, 2, 3
  ),
  -- Elegível = PROVADO que o CR compôs SÓ receita_bruta da origem e o CP SÓ cmv do destino, no mesmo mês,
  -- pelo mesmo valor, sem cancelamento, com o snapshot fiel aos títulos atuais, cada título num par só.
  eleg AS (
    SELECT x.*,
           (SELECT a.soma FROM atual a WHERE a.lado = 'r' AND a.company = x.empresa_origem AND a.chave = x.cr_chave) AS cr_cat_atual,
           (SELECT a.soma FROM atual a WHERE a.lado = 'd' AND a.company = x.empresa_destino AND a.chave = x.cp_chave) AS cp_cat_atual,
           CASE WHEN jsonb_typeof(x.comp_r) = 'object' AND jsonb_typeof(x.comp_r -> 'receita_bruta') = 'number'
                     AND (x.comp_r - 'receita_bruta') = '{}'::jsonb
                THEN (x.comp_r ->> 'receita_bruta')::numeric END AS comp_r_valor,
           CASE WHEN jsonb_typeof(x.comp_d) = 'object' AND jsonb_typeof(x.comp_d -> 'cmv') = 'number'
                     AND (x.comp_d - 'cmv') = '{}'::jsonb
                THEN (x.comp_d ->> 'cmv')::numeric END AS comp_d_valor
      FROM par_mes x
  ),
  julgado AS (
    SELECT e.*,
           (e.cr_id IS NOT NULL AND e.cp_id IS NOT NULL
            AND e.usos_cr = 1 AND e.usos_cp = 1
            AND e.cr_empresa = e.empresa_origem AND e.cp_empresa = e.empresa_destino
            AND e.cr_no_mes AND e.cp_no_mes
            AND e.cr_status <> 'CANCELADO' AND e.cp_status <> 'CANCELADO'
            AND e.cr_valor > 0 AND e.cr_valor = e.cp_valor
            -- composição ausente/fora da linha (comp_*_valor NULL) reprova aqui pelo IS TRUE
            AND abs(e.cr_cat_atual - e.comp_r_valor) <= 0.005
            AND abs(e.cp_cat_atual - e.comp_d_valor) <= 0.005) IS TRUE AS ok
      FROM eleg e
  ),
  -- O que se elimina de uma categoria não passa do que ela compôs no snapshot (folga de meio centavo
  -- para o float do motor).
  teto AS (
    SELECT bool_and(t.soma <= t.composto + 0.005) AS ok
      FROM (SELECT j.empresa_origem AS empresa, j.cr_chave AS chave, sum(j.cr_valor) AS soma,
                   max(j.comp_r_valor) AS composto
              FROM julgado j WHERE j.ok GROUP BY 1, 2
            UNION ALL
            SELECT j.empresa_destino, j.cp_chave, sum(j.cr_valor), max(j.comp_d_valor)
              FROM julgado j WHERE j.ok GROUP BY 1, 2) t
  ),
  -- Um par confirmado que não dá para eliminar torna o consolidado do mês DESCONHECIDO (NULL).
  ic_elim AS (
    SELECT CASE WHEN count(*) FILTER (WHERE NOT j.ok) > 0 OR (SELECT t.ok FROM teto t) IS FALSE THEN NULL
                ELSE COALESCE(sum(j.cr_valor) FILTER (WHERE j.ok), 0) END AS valor_elim
      FROM julgado j
  ),
  -- Receita e CMV caem pelo MESMO valor (CMV é positivo no snapshot); o resultado fica intacto.
  elim AS (
    SELECT d.ordem, d.conta, d.total,
           CASE WHEN e.valor_elim IS NULL THEN NULL
                WHEN d.conta IN ('receita_bruta', 'cmv') THEN -e.valor_elim
                ELSE 0::numeric END AS valor
      FROM dre_all d CROSS JOIN ic_elim e
  )
  SELECT x.conta, x.total, x.valor, x.total + x.valor
    FROM elim x
   ORDER BY x.ordem;
END;
$$;

-- ── 4. ACL (reemitida nomeando as roles; REPLACE já preserva) ────────────────────────────────
REVOKE ALL ON FUNCTION public.fin_consolidado_intercompany(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_consolidado_intercompany(integer, integer) TO authenticated, service_role;

-- ── 5. PÓS: aborta o apply se qualquer peça não pegou ────────────────────────────────────────
DO $post$
DECLARE
  f      constant text := 'public.fin_consolidado_intercompany(integer,integer)';
  v_vivo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(f));
BEGIN
  -- P1 corpo = o deste arquivo
  IF v_vivo IS DISTINCT FROM '11832f17b7551cabe02a2224cb495aaf' THEN
    RAISE EXCEPTION 'P1 FALHOU: % vivo md5 % (esperado o deste arquivo)', f, v_vivo;
  END IF;

  -- P2 ACL: anon e PUBLIC sem; authenticated e service_role com
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', f, 'EXECUTE')
     OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'P2 FALHOU: ACL de % (anon/PUBLIC sem, authenticated/service_role com)', f;
  END IF;

  -- P3 SECURITY DEFINER + STABLE + search_path fixo, sem sobrecarga
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'fin_consolidado_intercompany'
         AND p.prosecdef AND p.provolatile = 's'
         AND p.proconfig @> ARRAY['search_path=public, pg_temp']) <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'fin_consolidado_intercompany') <> 1 THEN
    RAISE EXCEPTION 'P3 FALHOU: % sem SECURITY DEFINER/STABLE/search_path fixo, ou com sobrecarga', f;
  END IF;
END
$post$;
