-- ============================================================================================
-- Venda intragrupo SEM COBRANÇA: o DRE consolidado elimina o CP só do CMV do destino
-- Prova PG17: db/test-fin-consolidado-ic.sh (os dois locales + --falsificar)
-- Histórico: docs/historico/consolidado-ic-venda-sem-cobranca.md
--
-- Caminho de apply: `bun run db:aplicar` — a transação é do EXECUTOR, por isso este arquivo NÃO leva
-- BEGIN/COMMIT. Idempotente. Molde TRAVA → PRE → (CHECK, trigger, função) → ACL → PÓS.
--
-- O caso: CP intragrupo sem CR do lado vendedor, porque o founder decidiu não cobrar (prod 2026-10-21:
-- 3 CP da oben, 201.597,61, jan e fev de 2026). A mercadoria já está no CMV de quem vendeu (compra ao
-- fornecedor) e o CMV de quem comprou a conta de novo; não há receita para eliminar. O consolidado
-- SUBESTIMAVA o resultado pelo valor do CP.
--
-- Decisões (registradas no PR):
--  • Representação: status novo 'intragrupo_sem_cobranca' em fin_ic_matches. Fora dos informativos do
--    fin-ic-reconcile ⇒ a edge nunca o apaga e trava o CP fora do pool (não casa de novo).
--  • A marcação é do FOUNDER: o trigger (fecha a classe — PostgREST cru e SQL futuro passam por ele)
--    exige master para ENTRAR e para SAIR do status, só aceita entrar a partir de 'sem_contrapartida'
--    CP-only (cr_id NULL), só sai para 'sem_contrapartida' não resolvido (a próxima rodada da edge refaz
--    a linha e pode casar o CP com um CR que tenha aparecido), recusa INSERT e DELETE no status, e deixa
--    ids/empresas/carimbo imutáveis enquanto a linha estiver nele. O carimbo (resolvido_por/em) é do
--    trigger, não do cliente.
--  • RPC: a linha marcada elimina o CP só do CMV do destino quando PROVADA, como o par: CP no mês, da
--    empresa destino, não CANCELADO nem sem status, valor > 0, uso único, categoria que compôs SÓ cmv no
--    destino, soma atual da categoria = composição, origem e destino com snapshot no mês (senão é
--    transação com quem está fora da soma). E sem "CR aparecido": linha informativa da edge, na mesma
--    direção, com CR de mesmo valor ou emitido a até 30 dias do CP (ou sem data) contradiz a marcação.
--    Marcada e não provada ⇒ as 4 linhas NULL ("eliminação pendente"), como o par.
--  • Linhas: receita −E_par · cmv −(E_par + E_sem_cobranca) · despesas 0 · resultado +E_sem_cobranca.
--    O teto por categoria do destino soma par e sem cobrança.
-- ============================================================================================

-- ── 1. TRAVA (antes de ler): ALTER sem efeito na função e lock da tabela que o arquivo toca ──────────────────────
DO $trava$
BEGIN
  IF to_regprocedure('public.fin_consolidado_intercompany(integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: fin_consolidado_intercompany(integer,integer) ausente';
  END IF;
  IF to_regclass('public.fin_ic_matches') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: fin_ic_matches ausente';
  END IF;
  ALTER FUNCTION public.fin_consolidado_intercompany(integer, integer) STABLE;
  LOCK TABLE public.fin_ic_matches IN ACCESS EXCLUSIVE MODE;
END
$trava$;

-- ── 2. PRE: o que está vivo é o predecessor revisado ou este ─────────────────────────────────────
DO $pre$
DECLARE
  v_rpc text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                  WHERE p.oid = to_regprocedure('public.fin_consolidado_intercompany(integer,integer)'));
  v_trg text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                  WHERE p.oid = to_regprocedure('public.fin_ic_matches_guarda_sem_cobranca()'));
  v_chk text := (SELECT pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c
                  WHERE c.conrelid = 'public.fin_ic_matches'::regclass AND c.conname = 'fin_ic_matches_status_check');
BEGIN
  IF v_rpc IS NULL OR v_rpc NOT IN ('11832f17b7551cabe02a2224cb495aaf', '93632843a0f32c133994323d69d715c7') THEN
    RAISE EXCEPTION 'PRE FALHOU: fin_consolidado_intercompany vivo (md5 %) nao e o predecessor revisado nem este', v_rpc;
  END IF;
  IF v_trg IS NOT NULL AND v_trg <> '1a3a3cc94fda97a7c618c8c5dfb78074' THEN
    RAISE EXCEPTION 'PRE FALHOU: fin_ic_matches_guarda_sem_cobranca viva (md5 %) nao e esta', v_trg;
  END IF;
  IF v_chk IS NULL OR v_chk NOT IN (
       'CHECK ((status = ANY (ARRAY[''auto_matched''::text, ''manual_matched''::text, ''divergencia_valor''::text, ''divergencia_data''::text, ''sem_contrapartida''::text, ''duplicidade_possivel''::text, ''desconsiderado''::text])))',
       'CHECK ((status = ANY (ARRAY[''auto_matched''::text, ''manual_matched''::text, ''divergencia_valor''::text, ''divergencia_data''::text, ''sem_contrapartida''::text, ''duplicidade_possivel''::text, ''desconsiderado''::text, ''intragrupo_sem_cobranca''::text])))') THEN
    RAISE EXCEPTION 'PRE FALHOU: fin_ic_matches_status_check vivo (%) nao e o revisado nem este', v_chk;
  END IF;
END
$pre$;

-- ── 3. O status novo no CHECK ───────────────────────────────────────────────────────────────────
ALTER TABLE public.fin_ic_matches DROP CONSTRAINT IF EXISTS fin_ic_matches_status_check;
ALTER TABLE public.fin_ic_matches ADD CONSTRAINT fin_ic_matches_status_check CHECK (status IN (
  'auto_matched', 'manual_matched', 'divergencia_valor', 'divergencia_data', 'sem_contrapartida',
  'duplicidade_possivel', 'desconsiderado', 'intragrupo_sem_cobranca'));

-- ── 4. O trigger: só o founder (master) põe e tira a marcação ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.fin_ic_matches_guarda_sem_cobranca()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $g$
DECLARE
  -- Só lido nas transições do status: as escritas da edge (INSERT/DELETE de outros status) não tocam
  -- auth.uid() nem has_role.
  v_master boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'intragrupo_sem_cobranca' THEN
      RAISE EXCEPTION 'venda sem cobranca: a linha marcada nao se apaga (desfaca a marcacao)' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'intragrupo_sem_cobranca' THEN
      RAISE EXCEPTION 'venda sem cobranca: nasce so pela marcacao de uma linha sem_contrapartida' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'intragrupo_sem_cobranca' AND OLD.status IS DISTINCT FROM 'intragrupo_sem_cobranca' THEN
    -- ENTRA: decisão do founder, sobre um CP sem CR que a edge classificou sem contrapartida.
    v_master := COALESCE(public.has_role(auth.uid(), 'master'::public.app_role), false);
    IF NOT v_master THEN
      RAISE EXCEPTION 'venda sem cobranca: so o master marca' USING ERRCODE = '42501';
    END IF;
    IF OLD.status <> 'sem_contrapartida' OR NEW.cr_id IS NOT NULL OR NEW.cp_id IS NULL
       OR NEW.cr_id IS DISTINCT FROM OLD.cr_id OR NEW.cp_id IS DISTINCT FROM OLD.cp_id
       OR NEW.empresa_origem IS DISTINCT FROM OLD.empresa_origem
       OR NEW.empresa_destino IS DISTINCT FROM OLD.empresa_destino THEN
      RAISE EXCEPTION 'venda sem cobranca: so marca linha sem_contrapartida com CP e sem CR, sem mudar titulos' USING ERRCODE = '23514';
    END IF;
    NEW.resolvido_por := auth.uid();
    NEW.resolvido_em := now();
  ELSIF OLD.status = 'intragrupo_sem_cobranca' AND NEW.status IS DISTINCT FROM 'intragrupo_sem_cobranca' THEN
    -- SAI: só de volta para a edge recalcular (sem_contrapartida não resolvido).
    v_master := COALESCE(public.has_role(auth.uid(), 'master'::public.app_role), false);
    IF NOT v_master THEN
      RAISE EXCEPTION 'venda sem cobranca: so o master desfaz' USING ERRCODE = '42501';
    END IF;
    IF NEW.status <> 'sem_contrapartida'
       OR NEW.cr_id IS DISTINCT FROM OLD.cr_id OR NEW.cp_id IS DISTINCT FROM OLD.cp_id
       OR NEW.empresa_origem IS DISTINCT FROM OLD.empresa_origem
       OR NEW.empresa_destino IS DISTINCT FROM OLD.empresa_destino THEN
      RAISE EXCEPTION 'venda sem cobranca: desfazer volta para sem_contrapartida, sem mudar titulos' USING ERRCODE = '23514';
    END IF;
    NEW.resolvido_por := NULL;
    NEW.resolvido_em := NULL;
  ELSIF OLD.status = 'intragrupo_sem_cobranca' THEN
    -- FICA: títulos, empresas e carimbo imutáveis (observação pode mudar).
    IF NEW.cr_id IS DISTINCT FROM OLD.cr_id OR NEW.cp_id IS DISTINCT FROM OLD.cp_id
       OR NEW.empresa_origem IS DISTINCT FROM OLD.empresa_origem
       OR NEW.empresa_destino IS DISTINCT FROM OLD.empresa_destino
       OR NEW.resolvido_por IS DISTINCT FROM OLD.resolvido_por
       OR NEW.resolvido_em IS DISTINCT FROM OLD.resolvido_em THEN
      RAISE EXCEPTION 'venda sem cobranca: titulos, empresas e carimbo da linha marcada sao imutaveis' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$g$;

DROP TRIGGER IF EXISTS fin_ic_matches_guarda_sem_cobranca ON public.fin_ic_matches;
CREATE TRIGGER fin_ic_matches_guarda_sem_cobranca
  BEFORE INSERT OR UPDATE OR DELETE ON public.fin_ic_matches
  FOR EACH ROW EXECUTE FUNCTION public.fin_ic_matches_guarda_sem_cobranca();

-- ── 5. A RPC ────────────────────────────────────────────────────────────────────────────────────
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
  -- Venda intragrupo SEM COBRANÇA (marcada pelo founder): só o CP, no mês da emissão, entre duas empresas
  -- que estão na soma. Uso do CP contado entre TODAS as linhas que eliminam (par ou sem cobrança).
  sem_cobranca AS (
    SELECT m.empresa_origem, m.empresa_destino, m.cr_id AS marca_cr_id,
           (SELECT count(*) FROM fin_ic_matches m2
             WHERE m2.cp_id = m.cp_id
               AND m2.status IN ('auto_matched', 'manual_matched', 'intragrupo_sem_cobranca')) AS usos_cp,
           cp.id AS cp_id, cp.company AS cp_empresa, cp.valor_documento AS cp_valor,
           cp.status_titulo AS cp_status, cp.data_emissao AS cp_emissao,
           COALESCE(NULLIF(cp.categoria_descricao, ''), NULLIF(cp.categoria_codigo, ''), 'Sem categoria') AS cp_chave,
           (EXTRACT(YEAR FROM cp.data_emissao) = p_ano AND EXTRACT(MONTH FROM cp.data_emissao) = p_mes) AS cp_no_mes,
           sd.detalhamento -> 'composicao_despesas' AS sd_comp
      FROM fin_ic_matches m
      JOIN snap so ON so.company = m.empresa_origem
      JOIN snap sd ON sd.company = m.empresa_destino
      JOIN fin_contas_pagar cp ON cp.id = m.cp_id
     WHERE m.status = 'intragrupo_sem_cobranca'
  ),
  -- Elegível = PROVADO que o CP compôs SÓ cmv do destino, com o snapshot fiel aos títulos atuais, e que
  -- nada contradiz a marcação: uma linha informativa da edge com CR na mesma direção, de mesmo valor ou
  -- emitido a até 30 dias do CP (ou sem data), pode ser a cobrança que a marcação diz não existir.
  sc_eleg AS (
    SELECT u.*,
           (SELECT a.soma FROM atual a WHERE a.lado = 'd' AND a.company = u.empresa_destino AND a.chave = u.cp_chave) AS cp_cat_atual,
           CASE WHEN jsonb_typeof(u.sd_comp -> u.cp_chave) = 'object'
                     AND jsonb_typeof(u.sd_comp -> u.cp_chave -> 'cmv') = 'number'
                     AND ((u.sd_comp -> u.cp_chave) - 'cmv') = '{}'::jsonb
                THEN (u.sd_comp -> u.cp_chave ->> 'cmv')::numeric END AS comp_d_valor,
           EXISTS (SELECT 1 FROM fin_ic_matches m3 JOIN fin_contas_receber r3 ON r3.id = m3.cr_id
                    WHERE m3.status IN ('divergencia_valor', 'divergencia_data', 'sem_contrapartida', 'duplicidade_possivel')
                      AND m3.empresa_origem = u.empresa_origem AND m3.empresa_destino = u.empresa_destino
                      AND (r3.valor_documento = u.cp_valor OR r3.data_emissao IS NULL
                           OR abs(r3.data_emissao - u.cp_emissao) <= 30)) AS cr_aparecido
      FROM sem_cobranca u
     WHERE u.cp_no_mes IS TRUE
  ),
  sc_julgado AS (
    SELECT v.*,
           (v.marca_cr_id IS NULL AND v.usos_cp = 1
            AND v.cp_empresa = v.empresa_destino
            AND v.cp_status <> 'CANCELADO'
            AND v.cp_valor > 0
            AND abs(v.cp_cat_atual - v.comp_d_valor) <= 0.005
            AND NOT v.cr_aparecido) IS TRUE AS ok
      FROM sc_eleg v
  ),
  -- O que se elimina de uma categoria não passa do que ela compôs no snapshot (folga de meio centavo
  -- para o float do motor). No destino, par e sem cobrança disputam o mesmo CMV da categoria.
  teto AS (
    SELECT bool_and(t.soma <= t.composto + 0.005) AS ok
      FROM (SELECT j.empresa_origem AS empresa, j.cr_chave AS chave, sum(j.cr_valor) AS soma,
                   max(j.comp_r_valor) AS composto
              FROM julgado j WHERE j.ok GROUP BY 1, 2
            UNION ALL
            SELECT d.empresa, d.chave, sum(d.valor), max(d.composto)
              FROM (SELECT j.empresa_destino AS empresa, j.cp_chave AS chave, j.cr_valor AS valor, j.comp_d_valor AS composto
                      FROM julgado j WHERE j.ok
                    UNION ALL
                    SELECT v.empresa_destino, v.cp_chave, v.cp_valor, v.comp_d_valor
                      FROM sc_julgado v WHERE v.ok) d
             GROUP BY 1, 2) t
  ),
  -- Um par confirmado (ou uma venda sem cobrança) que não dá para eliminar torna o consolidado do mês
  -- DESCONHECIDO (NULL).
  ic_elim AS (
    SELECT (pp.pendente OR sc.pendente OR (SELECT t.ok FROM teto t) IS FALSE) AS pendente,
           pp.valor AS valor_par, sc.valor AS valor_sc
      FROM (SELECT count(*) FILTER (WHERE NOT j.ok) > 0 AS pendente,
                   COALESCE(sum(j.cr_valor) FILTER (WHERE j.ok), 0) AS valor
              FROM julgado j) pp
     CROSS JOIN
           (SELECT count(*) FILTER (WHERE NOT v.ok) > 0 AS pendente,
                   COALESCE(sum(v.cp_valor) FILTER (WHERE v.ok), 0) AS valor
              FROM sc_julgado v) sc
  ),
  -- Par: receita e CMV caem pelo MESMO valor (CMV é positivo no snapshot), o resultado fica intacto.
  -- Sem cobrança: não há receita a eliminar; o CMV cai e o resultado sobe pelo mesmo valor.
  elim AS (
    SELECT d.ordem, d.conta, d.total,
           CASE WHEN e.pendente THEN NULL
                WHEN d.conta = 'receita_bruta' THEN -e.valor_par
                WHEN d.conta = 'cmv' THEN -(e.valor_par + e.valor_sc)
                WHEN d.conta = 'resultado_liquido' THEN e.valor_sc
                ELSE 0::numeric END AS valor
      FROM dre_all d CROSS JOIN ic_elim e
  )
  SELECT x.conta, x.total, x.valor, x.total + x.valor
    FROM elim x
   ORDER BY x.ordem;
END;
$$;

-- ── 6. ACL (reemitida nomeando as roles; REPLACE já preserva) ────────────────────────────────
REVOKE ALL ON FUNCTION public.fin_consolidado_intercompany(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_consolidado_intercompany(integer, integer) TO authenticated, service_role;
-- Função de trigger não precisa de EXECUTE de ninguém para disparar.
REVOKE ALL ON FUNCTION public.fin_ic_matches_guarda_sem_cobranca() FROM PUBLIC, anon, authenticated, service_role;

-- ── 7. PÓS: aborta o apply se qualquer peça não pegou ────────────────────────────────────────
DO $post$
DECLARE
  f      constant text := 'public.fin_consolidado_intercompany(integer,integer)';
  g      constant text := 'public.fin_ic_matches_guarda_sem_cobranca()';
  v_rpc  text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(f));
  v_trg  text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(g));
BEGIN
  -- P1 corpos = os deste arquivo
  IF v_rpc IS DISTINCT FROM '93632843a0f32c133994323d69d715c7' THEN
    RAISE EXCEPTION 'P1 FALHOU: % vivo md5 % (esperado o deste arquivo)', f, v_rpc;
  END IF;
  IF v_trg IS DISTINCT FROM '1a3a3cc94fda97a7c618c8c5dfb78074' THEN
    RAISE EXCEPTION 'P1 FALHOU: % vivo md5 % (esperado o deste arquivo)', g, v_trg;
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

  -- P4 CHECK com o status novo
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'public.fin_ic_matches'::regclass AND c.conname = 'fin_ic_matches_status_check')
     IS DISTINCT FROM 'CHECK ((status = ANY (ARRAY[''auto_matched''::text, ''manual_matched''::text, ''divergencia_valor''::text, ''divergencia_data''::text, ''sem_contrapartida''::text, ''duplicidade_possivel''::text, ''desconsiderado''::text, ''intragrupo_sem_cobranca''::text])))' THEN
    RAISE EXCEPTION 'P4 FALHOU: fin_ic_matches_status_check sem o status intragrupo_sem_cobranca';
  END IF;

  -- P5 trigger ligado: BEFORE INSERT OR UPDATE OR DELETE, por linha, chamando a função (tgtype 31 =
  -- ROW|BEFORE|INSERT|DELETE|UPDATE), sem SECURITY DEFINER e com search_path fixo
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgrelid = 'public.fin_ic_matches'::regclass AND t.tgname = 'fin_ic_matches_guarda_sem_cobranca'
         AND t.tgfoid = to_regprocedure(g) AND t.tgenabled = 'O' AND t.tgtype = 31) <> 1
     OR (SELECT p.prosecdef OR NOT (p.proconfig @> ARRAY['search_path=public, pg_temp'])
           FROM pg_proc p WHERE p.oid = to_regprocedure(g)) IS NOT FALSE THEN
    RAISE EXCEPTION 'P5 FALHOU: trigger fin_ic_matches_guarda_sem_cobranca ausente, desligado ou com outra forma';
  END IF;

  -- P6 RLS ligada na tabela da marcação
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.fin_ic_matches'::regclass) THEN
    RAISE EXCEPTION 'P6 FALHOU: RLS desligada em fin_ic_matches';
  END IF;
END
$post$;
