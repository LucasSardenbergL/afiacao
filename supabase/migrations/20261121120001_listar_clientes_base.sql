-- ============================================================
-- listar_clientes_base — lista da base completa de /admin/customers (master/gestor) com
-- ORDENAÇÃO e FILTRO DE SAÚDE no SERVIDOR, antes da paginação.
--
-- Por quê: a tela paginava `profiles` por nome (100/página) e só depois buscava os scores da
-- página. Ordenar/filtrar no cliente enxergava só as páginas já carregadas: o filtro "Crítico"
-- dizia "nenhum nas páginas carregadas" e "priorizar" ordenaria 100 de 17 mil. O teto é o EIXO,
-- não o tamanho (CLAUDE.md, corte por ranking): a ordem tem de nascer onde o score mora.
--
-- Escopo/RLS: SECURITY INVOKER — roda com a sessão de quem chama, então valem as MESMAS RLS da
-- leitura direta de hoje: `profiles` (staff vê tudo, o resto vê o próprio) e
-- `farmer_client_scores` (fcs_select_carteira). Score invisível ao chamador → LEFT JOIN dá NULL,
-- exatamente o "sem score" que a tela já mostrava. Nenhum bypass, nenhum gate novo a manter.
--
-- Semântica (espelha o filtro que CustomerListView fazia em memória):
--   * p_saude = 'sem_historico' → sales_history_status = 'sem_historico'.
--   * p_saude = classe          → health_class = classe E NÃO sem_historico (o badge do
--     sem_historico é "Sem histórico", não uma classe — senão "Crítico" mentiria).
--   * p_ordem = 'prioridade' → prioridade DESC NULLS LAST, desempate name, user_id. A prioridade
--     de sem_historico conta como NULL (a tela também não a exibe — metricasExibiveis), então
--     nunca-compradores vão para o fim mesmo se a edge voltar a gravar número para eles.
--   * p_ordem = 'nome' → name, user_id (a ordem de antes).
--   * p_busca: ILIKE em name/email/document/phone via private.padrao_like_contem (curinga do
--     usuário é literal). Termo só de curinga/espaço → padrão NULL → NENHUMA linha (nunca "%%",
--     que casaria a base inteira, nem "sem filtro").
--   * total = contagem do recorte filtrado (antes de LIMIT/OFFSET), repetida em toda linha.
-- Ordem TOTAL (user_id é único) → LIMIT/OFFSET não repete nem pula na fronteira de páginas.
-- Teto: p_limite ≤ 500 (abaixo do corte silencioso de 1.000 linhas do PostgREST).
-- Prova: db/test-listar-clientes-base.sh (PG17, RLS sob SET ROLE authenticated, falsificação).
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.listar_clientes_base(
  p_busca  text    DEFAULT NULL,
  p_saude  text    DEFAULT NULL,
  p_ordem  text    DEFAULT 'prioridade',
  p_limite integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  user_id uuid,
  name text,
  email text,
  phone text,
  document text,
  customer_type text,
  created_at timestamptz,
  requires_po boolean,
  prioridade_ordenacao numeric,
  total bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_saude text := nullif(btrim(coalesce(p_saude, '')), '');
  v_busca text := nullif(btrim(coalesce(p_busca, '')), '');
BEGIN
  IF v_saude = 'all' THEN v_saude := NULL; END IF;
  IF v_saude IS NOT NULL
     AND v_saude NOT IN ('saudavel', 'estavel', 'atencao', 'critico', 'sem_historico') THEN
    RAISE EXCEPTION 'listar_clientes_base: p_saude invalido (%)', v_saude USING ERRCODE = '22023';
  END IF;
  IF p_ordem IS NULL OR p_ordem NOT IN ('prioridade', 'nome') THEN
    RAISE EXCEPTION 'listar_clientes_base: p_ordem invalido (%)', p_ordem USING ERRCODE = '22023';
  END IF;
  IF p_limite IS NULL OR p_limite < 1 OR p_limite > 500 THEN
    RAISE EXCEPTION 'listar_clientes_base: p_limite fora de 1..500 (%)', p_limite USING ERRCODE = '22023';
  END IF;
  IF p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'listar_clientes_base: p_offset negativo (%)', p_offset USING ERRCODE = '22023';
  END IF;

  -- Aliases próprios (uid/nome/…) no CTE: as colunas de saída do RETURNS TABLE são variáveis
  -- plpgsql e colidiriam com p.user_id/p.name (42702 só em RUNTIME — late-bound).
  RETURN QUERY
  WITH recorte AS (
    SELECT
      p.user_id AS uid, p.name AS nome, p.email AS mail, p.phone AS fone, p.document AS doc,
      p.customer_type AS tipo, p.created_at AS criado, p.requires_po AS exige_po,
      CASE WHEN s.sales_history_status = 'sem_historico' THEN NULL ELSE s.priority_score END AS prio
    FROM public.profiles p
    LEFT JOIN public.farmer_client_scores s ON s.customer_user_id = p.user_id
    WHERE p.is_employee = false
      -- v_busca decide se HÁ busca; o padrão escapado vem do helper (IMMUTABLE: avaliado 1x).
      -- Termo sem conteúdo útil → padrão NULL → ILIKE NULL → nenhuma linha (não "sem filtro").
      AND (v_busca IS NULL
           OR p.name     ILIKE private.padrao_like_contem(v_busca) ESCAPE '\'
           OR p.email    ILIKE private.padrao_like_contem(v_busca) ESCAPE '\'
           OR p.document ILIKE private.padrao_like_contem(v_busca) ESCAPE '\'
           OR p.phone    ILIKE private.padrao_like_contem(v_busca) ESCAPE '\')
      AND (v_saude IS NULL
           OR (v_saude = 'sem_historico' AND s.sales_history_status = 'sem_historico')
           OR (v_saude <> 'sem_historico'
               AND s.health_class = v_saude
               AND s.sales_history_status IS DISTINCT FROM 'sem_historico'))
  )
  -- prioridade_ordenacao = a chave de prioridade DESTA ordenação: NULL na ordem 'nome', para o
  -- `.order()` estável do cliente (mesmas chaves, por cima) não re-ordenar a página A–Z.
  SELECT r.uid, r.nome, r.mail, r.fone, r.doc, r.tipo, r.criado, r.exige_po,
         CASE WHEN p_ordem = 'prioridade' THEN r.prio END, count(*) OVER ()
  FROM recorte r
  ORDER BY
    CASE WHEN p_ordem = 'prioridade' THEN r.prio END DESC NULLS LAST,
    r.nome,
    r.uid
  LIMIT p_limite OFFSET p_offset;
END
$fn$;

-- ACL: as DUAS pontas (PUBLIC e anon) — o default do Postgres dá EXECUTE a PUBLIC.
REVOKE ALL ON FUNCTION public.listar_clientes_base(text, text, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.listar_clientes_base(text, text, text, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.listar_clientes_base(text, text, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.listar_clientes_base(text, text, text, integer, integer) TO service_role;

DO $post$
DECLARE
  v_oid regprocedure := to_regprocedure('public.listar_clientes_base(text, text, text, integer, integer)');
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'A1 FALHOU: listar_clientes_base ausente — a tela /admin/customers (base) quebra';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'A2 FALHOU: listar_clientes_base virou SECURITY DEFINER — bypassaria a RLS de profiles/scores';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'A3 FALHOU: anon executa listar_clientes_base (REVOKE de PUBLIC/anon nao pegou)';
  END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'A4 FALHOU: authenticated sem EXECUTE — a tela recebe 42501';
  END IF;
  RAISE NOTICE 'listar_clientes_base OK: invoker, anon fechado, authenticated aberto';
END
$post$;

COMMIT;
