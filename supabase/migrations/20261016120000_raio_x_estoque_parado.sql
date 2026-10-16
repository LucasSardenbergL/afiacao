-- Raio-X do estoque parado, fase B (spec 2026-10-15), PR 1 / Task 1:
--   * raio_x_classificacao_manual / raio_x_decisao (RLS: so staff le; NENHUMA policy de escrita,
--     a escrita entra pelas RPCs SECURITY DEFINER da Task 2);
--   * raio_x_estoque_fatos(p_empresa) - fatos por SKU, read-only, SECURITY INVOKER + gate staff explicito.
-- Idempotente (IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS). Postcondicao no fim.
-- Mapa de contas (so aqui): oben -> estoque 'oben', cadastro 'oben', venda NF 'OBEN';
--                           colacor -> estoque 'colacor_vendas', cadastro 'colacor', venda nenhuma.
-- A conta 'vendas' (duplica a Oben) NUNCA e lida.

BEGIN;

CREATE TABLE IF NOT EXISTS public.raio_x_classificacao_manual (
  empresa         text        NOT NULL CHECK (empresa IN ('oben','colacor')),
  sku_codigo_omie bigint      NOT NULL,
  categoria       text        NOT NULL CHECK (categoria IN ('nao_mercadoria','uso_consumo','mercadoria')),
  motivo          text        NOT NULL CHECK (length(btrim(motivo)) > 0),
  marcado_por     uuid,
  marcado_em      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa, sku_codigo_omie)
);

CREATE TABLE IF NOT EXISTS public.raio_x_decisao (
  empresa             text        NOT NULL CHECK (empresa IN ('oben','colacor')),
  sku_codigo_omie     bigint      NOT NULL,
  destino             text        CHECK (destino IS NULL OR destino IN
                        ('trocar','venda_dirigida','liquidar','manter_suspender_recompra','estrategico','erro_cadastro')),
  observacao          text,
  fornecedor_informado text,
  credito_troca       numeric,
  decidido_por        uuid,
  decidido_em         timestamptz,
  foto_saldo          numeric,
  foto_cmc            numeric,
  foto_valor          numeric,
  foto_categoria      text,
  foto_em             timestamptz,
  tirou_do_motor      boolean     NOT NULL DEFAULT false,
  motor_antes         jsonb,
  qtd_contada         numeric,
  contado_por         uuid,
  contado_em          timestamptz,
  origem              text        NOT NULL DEFAULT 'app' CHECK (origem IN ('app','artifact_fase_a')),
  atualizado_em       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa, sku_codigo_omie)
);

ALTER TABLE public.raio_x_classificacao_manual ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.raio_x_decisao              ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS raio_x_classificacao_manual_select_staff ON public.raio_x_classificacao_manual;
CREATE POLICY raio_x_classificacao_manual_select_staff ON public.raio_x_classificacao_manual
  FOR SELECT TO authenticated
  USING ((SELECT public.has_role(auth.uid(), 'employee') OR public.has_role(auth.uid(), 'master')));

-- raio_x_decisao carrega foto_cmc/foto_valor (custo): mesma capacidade de ler custo do inventory_position.
DROP POLICY IF EXISTS raio_x_decisao_select_staff ON public.raio_x_decisao;
CREATE POLICY raio_x_decisao_select_staff ON public.raio_x_decisao
  FOR SELECT TO authenticated
  USING ((SELECT private.cap_custo_ler((SELECT auth.uid()))));
-- Sem policy de INSERT/UPDATE/DELETE de proposito: so as RPCs SECURITY DEFINER (Task 2) escrevem.

CREATE OR REPLACE FUNCTION public.raio_x_estoque_fatos(p_empresa text)
RETURNS TABLE (
  sku_codigo_omie bigint, codigo text, descricao text, familia text, tipo_produto text, ativo boolean,
  saldo numeric, cmc numeric, unidade_estoque text, unidades_venda text[], no_motor boolean,
  tipo_reposicao text, classe_abc text, cadastro_em date, ult_entrada date, fornecedor text,
  q12 numeric, ncli int, ult_venda date, preco_medio_12m numeric, clientes jsonb, synced_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_est  text;
  v_cad  text;
  v_vnd  text;
  v_wh   text;
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  -- Gate na 1a instrucao: mesma capacidade que o RLS de inventory_position exige em prod (master, ou employee
  -- estrategico/super_admin). Sem ela o INVOKER devolveria 0 linhas mudas. (INVOKER: o RLS das fontes vale por cima.)
  IF NOT private.cap_custo_ler(auth.uid()) THEN
    RAISE EXCEPTION 'RAIO_X_SO_STAFF' USING ERRCODE = '42501';
  END IF;

  CASE p_empresa
    WHEN 'oben'    THEN v_est := 'oben';           v_cad := 'oben';    v_vnd := 'OBEN';    v_wh := 'OB';
    WHEN 'colacor' THEN v_est := 'colacor_vendas'; v_cad := 'colacor'; v_vnd := NULL;     v_wh := 'CC';
    ELSE RAISE EXCEPTION 'RAIO_X_EMPRESA_INVALIDA: %', coalesce(p_empresa, '<null>') USING ERRCODE = '22023';
  END CASE;

  RETURN QUERY
  WITH e AS (  -- posicao mais recente por SKU (a tabela guarda varias synced_at); saldo > 0 depois de deduplicar
    SELECT x.* FROM (
      SELECT DISTINCT ON (ip.omie_codigo_produto)
             ip.omie_codigo_produto::bigint AS sku, ip.saldo, ip.cmc, ip.synced_at
        FROM public.inventory_position ip
       WHERE ip.account = v_est
       ORDER BY ip.omie_codigo_produto, ip.synced_at DESC NULLS LAST) x
    WHERE x.saldo > 0),
  vh AS (
    SELECT h.sku_codigo_omie AS sku, h.data_emissao, h.quantidade, h.valor_total,
           h.cliente_codigo_omie, h.cliente_razao_social, h.sku_unidade
      FROM public.v_venda_items_history_efetivo h
     WHERE v_vnd IS NOT NULL AND h.empresa = v_vnd),
  v AS (
    SELECT vh.sku, max(vh.data_emissao) AS uv,
           sum(vh.quantidade)  FILTER (WHERE vh.data_emissao >= v_hoje - 365) AS q12,
           count(DISTINCT vh.cliente_codigo_omie) FILTER (WHERE vh.data_emissao >= v_hoje - 365) AS ncli,
           sum(vh.valor_total) FILTER (WHERE vh.data_emissao >= v_hoje - 365)
             / nullif(sum(vh.quantidade) FILTER (WHERE vh.data_emissao >= v_hoje - 365), 0) AS pm12,
           array_agg(DISTINCT vh.sku_unidade) FILTER (WHERE vh.sku_unidade IS NOT NULL) AS unidades
      FROM vh GROUP BY vh.sku),
  cli AS (  -- top 5 por codigo de cliente (homonimos nao fundem); nome = razao social da NF mais recente
    SELECT t.sku, jsonb_agg(jsonb_build_object('nome', t.nome, 'ult', t.ult, 'qtd', t.qtd) ORDER BY t.qtd DESC, t.cod) AS clientes
      FROM (
        SELECT vh.sku, min(vh.cliente_codigo_omie) AS cod,
               (array_agg(vh.cliente_razao_social ORDER BY vh.data_emissao DESC, vh.cliente_razao_social))[1] AS nome,
               max(vh.data_emissao)::date AS ult, sum(vh.quantidade) AS qtd,
               row_number() OVER (PARTITION BY vh.sku ORDER BY sum(vh.quantidade) DESC, min(vh.cliente_codigo_omie)) AS rn
          FROM vh WHERE vh.data_emissao >= v_hoje - 365
         GROUP BY vh.sku, vh.cliente_codigo_omie) t
     WHERE t.rn <= 5 GROUP BY t.sku),
  rec AS (  -- ultima NF de entrada por produto, SO do armazem da empresa (codigos Omie colidem entre contas)
    SELECT DISTINCT ON (ri.produto_omie_id)
           ri.produto_omie_id AS pid, r.razao_social_emitente AS forn_rec, r.data_emissao::date AS ult_entrada
      FROM public.nfe_recebimento_itens ri
      JOIN public.nfe_recebimentos r ON r.id = ri.nfe_recebimento_id
      JOIN public.warehouses w ON w.id = r.warehouse_id
     WHERE w.code = v_wh AND ri.produto_omie_id IS NOT NULL
     ORDER BY ri.produto_omie_id, r.data_emissao DESC NULLS LAST, r.id DESC)
  SELECT e.sku,
         p.codigo, p.descricao, p.familia, p.tipo_produto, p.ativo,
         e.saldo,
         CASE WHEN e.cmc > 0 THEN e.cmc END,
         p.unidade,
         CASE WHEN v_vnd IS NULL THEN NULL::text[] ELSE coalesce(v.unidades, '{}'::text[]) END,
         (sp.sku_codigo_omie IS NOT NULL),
         sp.tipo_reposicao, sp.classe_abc,
         p.created_at::date,
         rec.ult_entrada,
         coalesce(sp.fornecedor_nome, rec.forn_rec),
         CASE WHEN v_vnd IS NULL THEN NULL::numeric ELSE coalesce(v.q12, 0) END AS q12,
         CASE WHEN v_vnd IS NULL THEN NULL::int     ELSE coalesce(v.ncli, 0)::int END,
         CASE WHEN v_vnd IS NULL THEN NULL::date    ELSE v.uv::date END,
         CASE WHEN v_vnd IS NULL THEN NULL::numeric ELSE round(v.pm12::numeric, 4) END,
         CASE WHEN v_vnd IS NULL THEN NULL::jsonb   ELSE coalesce(cli.clientes, '[]'::jsonb) END,
         e.synced_at
    FROM e
    LEFT JOIN public.sku_parametros sp ON sp.empresa = 'OBEN' AND p_empresa = 'oben' AND sp.sku_codigo_omie = e.sku
    LEFT JOIN LATERAL (SELECT op.* FROM public.omie_products op
                        WHERE op.omie_codigo_produto = e.sku AND op.account = v_cad
                        ORDER BY op.created_at DESC NULLS LAST LIMIT 1) p ON true
    LEFT JOIN v   ON v.sku   = e.sku
    LEFT JOIN cli ON cli.sku = e.sku
    LEFT JOIN rec ON rec.pid = e.sku
   ORDER BY e.sku;
END
$fn$;

REVOKE ALL ON FUNCTION public.raio_x_estoque_fatos(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raio_x_estoque_fatos(text) TO authenticated;

-- Postcondicao (aborta o apply se a ACL ou o RLS nao ficaram como o desenho).
DO $post$
BEGIN
  IF has_function_privilege('anon', 'public.raio_x_estoque_fatos(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondicao: anon executa raio_x_estoque_fatos';
  END IF;
  IF has_function_privilege('public', 'public.raio_x_estoque_fatos(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondicao: public executa raio_x_estoque_fatos';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.raio_x_estoque_fatos(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondicao: authenticated sem EXECUTE em raio_x_estoque_fatos';
  END IF;
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname IN ('raio_x_decisao','raio_x_classificacao_manual')
         AND c.relrowsecurity) <> 2 THEN
    RAISE EXCEPTION 'postcondicao: RLS desligada nas tabelas do raio-x';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
              AND tablename IN ('raio_x_decisao','raio_x_classificacao_manual') AND cmd <> 'SELECT') THEN
    RAISE EXCEPTION 'postcondicao: policy de escrita nas tabelas do raio-x';
  END IF;
END $post$;

COMMIT;
