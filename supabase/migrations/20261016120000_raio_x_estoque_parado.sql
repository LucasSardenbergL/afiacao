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
  q12 numeric, ncli int, ult_venda date, preco_medio_12m numeric, clientes jsonb, synced_at timestamptz,
  habilitado_reposicao_automatica boolean)  -- R17: de sku_parametros; NULL sem linha (e sempre na colacor)
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
         e.synced_at,
         sp.habilitado_reposicao_automatica
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

-- ============================================================================
-- Task 2 — escrita (money-path: raio_x_decidir altera sku_parametros, o motor de compras).
-- SECURITY DEFINER (as tabelas nao tem policy de escrita). Gate na 1a instrucao = cap_custo_ler:
-- a decisao le CMC do inventory_position como DEFINER e devolve a foto (custo). Mesmo gate nas 3 (tela unica).
-- Mapa: oben -> estoque 'oben', motor sku_parametros.empresa='OBEN'; colacor -> estoque 'colacor_vendas',
-- motor NULL (a colacor nao tem sku_parametros: tirar cai no RX001 pelas 0 linhas; nunca toca o codigo
-- homonimo da OBEN). A conta 'vendas' nunca e lida.
-- Atomicidade: a funcao e uma transacao so; nenhum bloco EXCEPTION engole erro (o RX001 desfaz o upsert).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.raio_x_decidir(
  p_empresa text, p_sku bigint, p_destino text, p_categoria text, p_observacao text, p_fornecedor text,
  p_credito_troca numeric, p_tirar_do_motor boolean, p_restaurar_motor boolean)
RETURNS public.raio_x_decisao
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid       uuid := auth.uid();
  v_est       text;
  v_sp_emp    text;
  v_tirar     boolean := coalesce(p_tirar_do_motor, false);
  v_restaurar boolean := coalesce(p_restaurar_motor, false);
  v_old       public.raio_x_decisao%ROWTYPE;
  v_mudou     boolean;
  v_alvo      text;
  v_sp_tipo   text;
  v_sp_hab    boolean;
  v_mexer     boolean := false;
  v_sp_achou  boolean;
  v_foto      boolean := false;
  v_ip_saldo  numeric;
  v_ip_cmc    numeric;
  v_cmc       numeric;
  v_n_tirar   int;
  v_n_rest    int;
  v_row       public.raio_x_decisao%ROWTYPE;
BEGIN
  IF NOT private.cap_custo_ler(auth.uid()) THEN
    RAISE EXCEPTION 'RAIO_X_SO_CUSTO' USING ERRCODE = '42501';
  END IF;

  -- ---- validacao (nada e escrito antes daqui) ----
  CASE p_empresa
    WHEN 'oben'    THEN v_est := 'oben';    v_sp_emp := 'OBEN';
    WHEN 'colacor' THEN v_est := 'colacor_vendas'; v_sp_emp := NULL;
    ELSE RAISE EXCEPTION 'raio_x: empresa invalida: %', coalesce(p_empresa, '<null>') USING ERRCODE = '22023';
  END CASE;
  IF p_sku IS NULL THEN
    RAISE EXCEPTION 'raio_x: sku nulo' USING ERRCODE = '22023';
  END IF;
  IF p_destino IS NOT NULL AND p_destino NOT IN
     ('trocar','venda_dirigida','liquidar','manter_suspender_recompra','estrategico','erro_cadastro') THEN
    RAISE EXCEPTION 'raio_x: destino invalido: %', p_destino USING ERRCODE = '22023';
  END IF;
  IF p_categoria IS NOT NULL AND p_categoria NOT IN ('nao_mercadoria','uso_consumo','mercadoria') THEN
    RAISE EXCEPTION 'raio_x: categoria invalida: %', p_categoria USING ERRCODE = '22023';
  END IF;
  IF v_tirar AND v_restaurar THEN
    RAISE EXCEPTION 'raio_x: tirar e restaurar na mesma chamada' USING ERRCODE = '22023';
  END IF;
  v_alvo := CASE p_destino WHEN 'trocar' THEN 'descontinuado' WHEN 'liquidar' THEN 'descontinuado'
                           WHEN 'manter_suspender_recompra' THEN 'sob_encomenda' END;
  IF v_tirar AND v_alvo IS NULL THEN
    RAISE EXCEPTION 'raio_x: tirar do motor exige destino trocar, liquidar ou manter_suspender_recompra'
      USING ERRCODE = '22023';
  END IF;

  IF p_destino IS NOT NULL AND p_categoria IS NULL THEN
    RAISE EXCEPTION 'raio_x: categoria obrigatoria com destino' USING ERRCODE = '22023';
  END IF;
  IF p_credito_troca < 0 THEN
    RAISE EXCEPTION 'raio_x: credito_troca negativo: %', p_credito_troca USING ERRCODE = '22023';
  END IF;
  -- R18: NaN e maior que tudo no numeric do Postgres; o `< 0` nao pega.
  IF p_credito_troca = 'NaN'::numeric THEN
    RAISE EXCEPTION 'raio_x: credito_troca invalido: %', p_credito_troca USING ERRCODE = '22023';
  END IF;

  -- Linha-base primeiro e trava (R14): duas 1as decisoes concorrentes serializam aqui, e a 2a ja ve a foto
  -- da 1a. Tudo abaixo (foto, decidido_em, motor) deriva da linha TRAVADA. Erro adiante desfaz a linha-base.
  INSERT INTO public.raio_x_decisao (empresa, sku_codigo_omie) VALUES (p_empresa, p_sku)
  ON CONFLICT (empresa, sku_codigo_omie) DO NOTHING;
  SELECT * INTO v_old FROM public.raio_x_decisao d
   WHERE d.empresa = p_empresa AND d.sku_codigo_omie = p_sku FOR UPDATE;
  IF v_restaurar AND v_old.motor_antes IS NULL THEN
    RAISE EXCEPTION 'raio_x: nada a restaurar (%/%)', p_empresa, p_sku USING ERRCODE = '22023';
  END IF;

  v_mudou := (v_old.destino IS DISTINCT FROM p_destino);

  -- Estado atual do motor (trava a linha). Sem linha -> RX001 JA (R13): nunca gravar motor_antes de uma
  -- leitura vazia (uma linha inserida entre o SELECT e o UPDATE faria o restaurar apagar o estado real).
  -- (os marcadores [motor-sel:*] e [motor:*] delimitam o motor para a prova sabotar com um bloco que engole erro)
  -- [motor-sel:inicio]
  IF v_tirar THEN
    SELECT sp.tipo_reposicao, sp.habilitado_reposicao_automatica INTO v_sp_tipo, v_sp_hab
      FROM public.sku_parametros sp
     WHERE sp.empresa = v_sp_emp AND sp.sku_codigo_omie = p_sku FOR UPDATE;
    v_sp_achou := FOUND;
    IF NOT v_sp_achou THEN
      RAISE EXCEPTION 'raio_x: sku sem sku_parametros (%/%)', p_empresa, p_sku USING ERRCODE = 'RX001';
    END IF;
    -- Ja no alvo (false + mesmo tipo): nao escreve e nao marca tirou_do_motor.
    v_mexer := NOT (v_sp_hab IS NOT DISTINCT FROM false AND v_sp_tipo IS NOT DISTINCT FROM v_alvo);
  END IF;
  -- [motor-sel:fim]

  -- Foto: so na 1a decisao (foto_em is null) e com estoque presente; sem linha ou saldo NULL -> tudo NULL,
  -- tenta de novo depois.
  IF p_destino IS NOT NULL AND v_old.foto_em IS NULL THEN
    SELECT x.saldo, x.cmc INTO v_ip_saldo, v_ip_cmc FROM (
      SELECT DISTINCT ON (ip.omie_codigo_produto) ip.saldo, ip.cmc
        FROM public.inventory_position ip
       WHERE ip.account = v_est AND ip.omie_codigo_produto = p_sku
       ORDER BY ip.omie_codigo_produto, ip.synced_at DESC NULLS LAST) x;
    IF FOUND AND v_ip_saldo IS NOT NULL THEN
      v_foto := true;
      v_cmc := CASE WHEN v_ip_cmc > 0 THEN v_ip_cmc END;   -- ausente/zero != custo
    END IF;
  END IF;

  -- ---- escrita ----
  INSERT INTO public.raio_x_decisao AS r (
    empresa, sku_codigo_omie, destino, observacao, fornecedor_informado, credito_troca,
    decidido_por, decidido_em, foto_saldo, foto_cmc, foto_valor, foto_categoria, foto_em,
    tirou_do_motor, motor_antes, atualizado_em)
  VALUES (
    p_empresa, p_sku, p_destino, p_observacao, p_fornecedor, p_credito_troca,
    CASE WHEN p_destino IS NOT NULL THEN v_uid END, CASE WHEN p_destino IS NOT NULL THEN now() END,
    CASE WHEN v_foto THEN v_ip_saldo END, CASE WHEN v_foto THEN v_cmc END,
    CASE WHEN v_foto THEN v_ip_saldo * v_cmc END, CASE WHEN v_foto THEN p_categoria END,
    CASE WHEN v_foto THEN now() END,
    v_mexer,
    CASE WHEN v_mexer THEN jsonb_build_object('tipo_reposicao', v_sp_tipo, 'habilitado', v_sp_hab) END,
    now())
  ON CONFLICT (empresa, sku_codigo_omie) DO UPDATE SET
    destino              = EXCLUDED.destino,
    observacao           = EXCLUDED.observacao,
    fornecedor_informado = EXCLUDED.fornecedor_informado,
    credito_troca        = EXCLUDED.credito_troca,
    decidido_por   = CASE WHEN v_mudou THEN EXCLUDED.decidido_por ELSE r.decidido_por END,
    decidido_em    = CASE WHEN v_mudou THEN EXCLUDED.decidido_em  ELSE r.decidido_em  END,
    foto_saldo     = CASE WHEN v_foto AND r.foto_em IS NULL THEN EXCLUDED.foto_saldo     ELSE r.foto_saldo     END,
    foto_cmc       = CASE WHEN v_foto AND r.foto_em IS NULL THEN EXCLUDED.foto_cmc       ELSE r.foto_cmc       END,
    foto_valor     = CASE WHEN v_foto AND r.foto_em IS NULL THEN EXCLUDED.foto_valor     ELSE r.foto_valor     END,
    foto_categoria = CASE WHEN v_foto AND r.foto_em IS NULL THEN EXCLUDED.foto_categoria ELSE r.foto_categoria END,
    foto_em        = CASE WHEN v_foto AND r.foto_em IS NULL THEN EXCLUDED.foto_em        ELSE r.foto_em        END,
    tirou_do_motor = CASE WHEN v_mexer THEN true ELSE r.tirou_do_motor END,
    motor_antes    = coalesce(r.motor_antes, EXCLUDED.motor_antes),
    atualizado_em  = now();

  -- Foto protegida como CONJUNTO: so escreve foto_* se a linha atual ainda tem foto_em NULL (2a camada do R14).
  -- [motor:inicio]
  IF v_mexer THEN
    UPDATE public.sku_parametros sp
       SET tipo_reposicao = v_alvo, habilitado_reposicao_automatica = false
     WHERE sp.empresa = v_sp_emp AND sp.sku_codigo_omie = p_sku;
    GET DIAGNOSTICS v_n_tirar = ROW_COUNT;
    IF v_n_tirar = 0 THEN
      RAISE EXCEPTION 'raio_x: sku sem sku_parametros (%/%)', p_empresa, p_sku USING ERRCODE = 'RX001';
    END IF;
  END IF;
  -- [motor:fim]

  IF v_restaurar THEN
    UPDATE public.sku_parametros sp
       SET tipo_reposicao = v_old.motor_antes->>'tipo_reposicao',
           habilitado_reposicao_automatica = (v_old.motor_antes->>'habilitado')::boolean
     WHERE sp.empresa = v_sp_emp AND sp.sku_codigo_omie = p_sku;
    GET DIAGNOSTICS v_n_rest = ROW_COUNT;
    IF v_n_rest = 0 THEN
      RAISE EXCEPTION 'raio_x: sku sem sku_parametros (%/%)', p_empresa, p_sku USING ERRCODE = 'RX001';
    END IF;
    UPDATE public.raio_x_decisao d SET tirou_do_motor = false, motor_antes = NULL, atualizado_em = now()
     WHERE d.empresa = p_empresa AND d.sku_codigo_omie = p_sku;
  END IF;

  SELECT * INTO v_row FROM public.raio_x_decisao d WHERE d.empresa = p_empresa AND d.sku_codigo_omie = p_sku;
  RETURN v_row;
END
$fn$;

REVOKE ALL ON FUNCTION public.raio_x_decidir(text, bigint, text, text, text, text, numeric, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raio_x_decidir(text, bigint, text, text, text, text, numeric, boolean, boolean) TO authenticated;

-- Contagem fisica: p_qtd NULL limpa (qtd, quem, quando). SKU sem linha -> cria com destino NULL e sem foto.
CREATE OR REPLACE FUNCTION public.raio_x_contar(p_empresa text, p_sku bigint, p_qtd numeric)
RETURNS public.raio_x_decisao
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row public.raio_x_decisao%ROWTYPE;
BEGIN
  IF NOT private.cap_custo_ler(auth.uid()) THEN
    RAISE EXCEPTION 'RAIO_X_SO_CUSTO' USING ERRCODE = '42501';
  END IF;
  IF p_empresa IS NULL OR p_empresa NOT IN ('oben','colacor') THEN
    RAISE EXCEPTION 'raio_x: empresa invalida: %', coalesce(p_empresa, '<null>') USING ERRCODE = '22023';
  END IF;
  IF p_sku IS NULL THEN
    RAISE EXCEPTION 'raio_x: sku nulo' USING ERRCODE = '22023';
  END IF;
  IF p_qtd < 0 THEN
    RAISE EXCEPTION 'raio_x: quantidade negativa: %', p_qtd USING ERRCODE = '22023';
  END IF;
  IF p_qtd = 'NaN'::numeric THEN  -- R18
    RAISE EXCEPTION 'raio_x: quantidade invalida: %', p_qtd USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.raio_x_decisao AS r (empresa, sku_codigo_omie, qtd_contada, contado_por, contado_em, atualizado_em)
  VALUES (p_empresa, p_sku, p_qtd,
          CASE WHEN p_qtd IS NOT NULL THEN auth.uid() END, CASE WHEN p_qtd IS NOT NULL THEN now() END, now())
  ON CONFLICT (empresa, sku_codigo_omie) DO UPDATE SET
    qtd_contada = EXCLUDED.qtd_contada, contado_por = EXCLUDED.contado_por,
    contado_em = EXCLUDED.contado_em, atualizado_em = now()
  RETURNING r.* INTO v_row;
  RETURN v_row;
END
$fn$;

REVOKE ALL ON FUNCTION public.raio_x_contar(text, bigint, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raio_x_contar(text, bigint, numeric) TO authenticated;

-- Marcacao manual de categoria: p_categoria NULL apaga a marcacao e devolve NULL. Motivo vazio -> CHECK (23514).
CREATE OR REPLACE FUNCTION public.raio_x_classificar(p_empresa text, p_sku bigint, p_categoria text, p_motivo text)
RETURNS public.raio_x_classificacao_manual
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row public.raio_x_classificacao_manual%ROWTYPE;
BEGIN
  IF NOT private.cap_custo_ler(auth.uid()) THEN
    RAISE EXCEPTION 'RAIO_X_SO_CUSTO' USING ERRCODE = '42501';
  END IF;
  IF p_empresa IS NULL OR p_empresa NOT IN ('oben','colacor') THEN
    RAISE EXCEPTION 'raio_x: empresa invalida: %', coalesce(p_empresa, '<null>') USING ERRCODE = '22023';
  END IF;
  IF p_sku IS NULL THEN
    RAISE EXCEPTION 'raio_x: sku nulo' USING ERRCODE = '22023';
  END IF;
  IF p_categoria IS NULL THEN
    DELETE FROM public.raio_x_classificacao_manual c WHERE c.empresa = p_empresa AND c.sku_codigo_omie = p_sku;
    RETURN NULL;
  END IF;
  IF p_categoria NOT IN ('nao_mercadoria','uso_consumo','mercadoria') THEN
    RAISE EXCEPTION 'raio_x: categoria invalida: %', p_categoria USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.raio_x_classificacao_manual AS c (empresa, sku_codigo_omie, categoria, motivo, marcado_por, marcado_em)
  VALUES (p_empresa, p_sku, p_categoria, p_motivo, auth.uid(), now())
  ON CONFLICT (empresa, sku_codigo_omie) DO UPDATE SET
    categoria = EXCLUDED.categoria, motivo = EXCLUDED.motivo,
    marcado_por = EXCLUDED.marcado_por, marcado_em = EXCLUDED.marcado_em
  RETURNING c.* INTO v_row;
  RETURN v_row;
END
$fn$;

REVOKE ALL ON FUNCTION public.raio_x_classificar(text, bigint, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raio_x_classificar(text, bigint, text, text) TO authenticated;

-- ============================================================================
-- Task 3 - medicao desde a decisao (read-only). Mesma capacidade de custo das demais (devolve foto_cmc/valor).
-- Fronteira de venda ESTRITA: data_emissao > dia (America/Sao_Paulo) de decidido_em. A NF so tem dia, nao hora:
-- a do proprio dia da decisao pode ter sido emitida antes dela e NAO conta. Vies conservador de proposito:
-- money-path prefere subcontar a inflar o caixa liberado atribuido a decisao.
-- Venda NF so oben; colacor -> qtd_vendida/receita/preco NULL (nunca 0). saldo_atual: linha mais recente por
-- synced_at, INCLUINDO saldo 0; sem linha -> NULL. compras_apos: itens de pedido de compra (cabecalho
-- pedido_compra_sugerido, empresa 'OBEN', status disparado/split_em_filhos) criados depois da decisao; so oben
-- (colacor -> NULL: o motor de compras e so da Oben). sku_codigo_omie do item e TEXT: compara como texto.
-- R16: pedido_compra_item so e legivel com private.cap_compras_ler (master). Sem ela o RLS devolve 0 linhas
-- e o coalesce fabricaria "nenhuma recompra" -> NULL (ausente != vazio).
-- Linha sem foto (foto_em NULL) tambem volta, com foto_* NULL; quem decide "sem medicao" e o app.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.raio_x_medicao(p_empresa text)
RETURNS TABLE (
  sku_codigo_omie bigint, destino text, decidido_em timestamptz,
  foto_saldo numeric, foto_cmc numeric, foto_valor numeric, foto_categoria text, credito_troca numeric,
  saldo_atual numeric, qtd_vendida numeric, receita numeric, preco_medio_12m numeric,
  compras_apos timestamptz[])
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_est  text;
  v_vnd  text;
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  IF NOT private.cap_custo_ler(auth.uid()) THEN
    RAISE EXCEPTION 'RAIO_X_SO_STAFF' USING ERRCODE = '42501';
  END IF;

  CASE p_empresa
    WHEN 'oben'    THEN v_est := 'oben';           v_vnd := 'OBEN';
    WHEN 'colacor' THEN v_est := 'colacor_vendas'; v_vnd := NULL;
    ELSE RAISE EXCEPTION 'RAIO_X_EMPRESA_INVALIDA: %', coalesce(p_empresa, '<null>') USING ERRCODE = '22023';
  END CASE;

  RETURN QUERY
  WITH d AS (
    SELECT x.sku_codigo_omie AS sku, x.destino, x.decidido_em, x.foto_saldo, x.foto_cmc, x.foto_valor,
           x.foto_categoria, x.credito_troca,
           (x.decidido_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia
      FROM public.raio_x_decisao x
     WHERE x.empresa = p_empresa AND x.destino IS NOT NULL),
  e AS (
    SELECT DISTINCT ON (ip.omie_codigo_produto) ip.omie_codigo_produto::bigint AS sku, ip.saldo
      FROM public.inventory_position ip
     WHERE ip.account = v_est
     ORDER BY ip.omie_codigo_produto, ip.synced_at DESC NULLS LAST),
  vh AS (
    SELECT h.sku_codigo_omie AS sku, h.data_emissao, h.quantidade, h.valor_total
      FROM public.v_venda_items_history_efetivo h
     WHERE v_vnd IS NOT NULL AND h.empresa = v_vnd),
  v AS (
    SELECT d.sku,
           coalesce(sum(vh.quantidade)  FILTER (WHERE vh.data_emissao > d.dia), 0) AS qtd,
           coalesce(sum(vh.valor_total) FILTER (WHERE vh.data_emissao > d.dia), 0) AS rec,
           sum(vh.valor_total) FILTER (WHERE vh.data_emissao >= v_hoje - 365)
             / nullif(sum(vh.quantidade) FILTER (WHERE vh.data_emissao >= v_hoje - 365), 0) AS pm12
      FROM d JOIN vh ON vh.sku = d.sku
     GROUP BY d.sku),
  c AS (
    SELECT d.sku, array_agg(i.criado_em ORDER BY i.criado_em) AS compras
      FROM d
      JOIN public.pedido_compra_item i ON i.sku_codigo_omie = d.sku::text
      JOIN public.pedido_compra_sugerido pc ON pc.id = i.pedido_id
     WHERE p_empresa = 'oben' AND pc.empresa = 'OBEN'
       AND pc.status IN ('disparado','split_em_filhos')
       AND i.criado_em > d.decidido_em
     GROUP BY d.sku)
  SELECT d.sku, d.destino, d.decidido_em, d.foto_saldo, d.foto_cmc, d.foto_valor, d.foto_categoria, d.credito_troca,
         e.saldo,
         CASE WHEN v_vnd IS NULL THEN NULL::numeric ELSE coalesce(v.qtd, 0) END,
         CASE WHEN v_vnd IS NULL THEN NULL::numeric ELSE coalesce(v.rec, 0) END,
         CASE WHEN v_vnd IS NULL THEN NULL::numeric ELSE round(v.pm12::numeric, 4) END,
         CASE WHEN p_empresa = 'oben' AND private.cap_compras_ler(auth.uid()) THEN coalesce(c.compras, '{}'::timestamptz[])
              ELSE NULL::timestamptz[] END
    FROM d
    LEFT JOIN e ON e.sku = d.sku
    LEFT JOIN v ON v.sku = d.sku
    LEFT JOIN c ON c.sku = d.sku
   ORDER BY d.sku;
END
$fn$;

REVOKE ALL ON FUNCTION public.raio_x_medicao(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raio_x_medicao(text) TO authenticated;

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
  IF has_function_privilege('anon', 'public.raio_x_medicao(text)', 'EXECUTE')
     OR has_function_privilege('public', 'public.raio_x_medicao(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.raio_x_medicao(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondicao: ACL de raio_x_medicao';
  END IF;
  -- PL/pgSQL e late-bound: a medicao chama private.cap_compras_ler em runtime (R16) - tem de existir.
  IF to_regprocedure('private.cap_compras_ler(uuid)') IS NULL THEN
    RAISE EXCEPTION 'postcondicao: private.cap_compras_ler(uuid) ausente';
  END IF;
  DECLARE
    f text;
  BEGIN
    FOREACH f IN ARRAY ARRAY[
      'public.raio_x_decidir(text,bigint,text,text,text,text,numeric,boolean,boolean)',
      'public.raio_x_contar(text,bigint,numeric)',
      'public.raio_x_classificar(text,bigint,text,text)'] LOOP
      IF has_function_privilege('anon', f, 'EXECUTE') THEN
        RAISE EXCEPTION 'postcondicao: anon executa %', split_part(substr(f, 8), '(', 1);
      END IF;
      IF has_function_privilege('public', f, 'EXECUTE') THEN
        RAISE EXCEPTION 'postcondicao: public executa %', split_part(substr(f, 8), '(', 1);
      END IF;
      IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
        RAISE EXCEPTION 'postcondicao: authenticated sem EXECUTE em %', f;
      END IF;
      IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = f::regprocedure) THEN
        RAISE EXCEPTION 'postcondicao: % nao e SECURITY DEFINER', f;
      END IF;
    END LOOP;
  END;
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
