-- ============================================================
-- Raio-X — unidade comprovada antes de qualquer número (bug 3 da 2ª revisão Codex + Fable, 2026-11-03) [money-path]
--
-- POR QUÊ: o preço piso é R$ por unidade de VENDA e o CMC é por unidade do ESTOQUE. `raio_x_planejar` fazia
-- `preco_piso - cmc` (margem) e `1 - piso/médio 12m` (desconto) sem checar se as unidades batem; a medição (TS) comparava
-- a quantidade vendida (unidade da NF) com o saldo (unidade do estoque). Vender em CX e estocar em UN fabricava margem,
-- desconto e "estoque reduzido". Regra (ausente ≠ zero): sem conversão comprovada → NULL / "sem medição", nunca número.
--
--   1) raio_x_planejar (mesma assinatura, CREATE OR REPLACE — ACL preservada): desconto só com UMA unidade de venda em
--      12m; margem só com a unidade de venda única no histórico = a do estoque. Sem venda, sem cadastro ou divergente →
--      NULL. A prova de unidade é relida a cada salvamento com piso; as bases (médio, CMC) seguem congeladas.
--   2) raio_x_medicao ganha, NO FIM, `unidade_estoque` e `unidades_venda_periodo` (unidades das NFs desde a foto; nula
--      vira ''). A regra fica no TS (`unidadeEquivalente` em src/lib/reposicao/raio-x/medir.ts, testada lá). Muda o
--      RETURNS → DROP + CREATE; ACL reemitida nomeando as roles.
--
-- Corpos de partida = os da 20261101120000_raio_x_inequivoco.sql (APLICADOS: md5 planejar 1bf86bd2fa624d5497099cad81726fcc,
-- medicao 7b7f4b18ca51bbec7804e38c9c3e6d6d, lidos da PROD em 2026-11-03 via psql-ro). Molde TRAVA → PRE → CREATE → PÓS.
-- Prova: db/test-raio-x-unidades.sh (PG17, controle verde + sabotagens, LC_ALL=C e pt_BR.UTF-8).
-- Aplicação: `bun run db:aplicar supabase/migrations/20261103120000_raio_x_unidades.sql` (sem BEGIN/COMMIT: o executor
-- fornece a transação). Ordem com o front: aplicar ANTES do Publish — sem as colunas novas, o bundle novo deixa todo SKU
-- vendido "sem medição" (fail-closed, nunca número).
-- ============================================================

-- TRAVA, antes de ler: ALTER sem efeito (a volatilidade VIVA) prende as funções até o fim da transação.
DO $trava$
BEGIN
  ALTER FUNCTION public.raio_x_planejar(text, bigint, numeric, text, uuid, date, boolean, timestamptz, numeric, text) VOLATILE;
  ALTER FUNCTION public.raio_x_medicao(text) STABLE;
END
$trava$;

-- PRE: md5 EXATO do corpo vivo ∈ {predecessor revisado, este}. Ausente ABORTA.
DO $pre$
DECLARE
  v_plan text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                   WHERE p.oid = to_regprocedure('public.raio_x_planejar(text,bigint,numeric,text,uuid,date,boolean,timestamptz,numeric,text)'));
  v_med  text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.raio_x_medicao(text)'));
BEGIN
  IF v_plan IS NULL OR v_plan NOT IN ('1bf86bd2fa624d5497099cad81726fcc', 'bf229655602a8ee1edbdaae3db745003') THEN
    RAISE EXCEPTION 'PRE FALHOU: raio_x_planejar vivo (md5 %) não é o predecessor revisado nem este — reconcilie antes', v_plan;
  END IF;
  IF v_med IS NULL OR v_med NOT IN ('7b7f4b18ca51bbec7804e38c9c3e6d6d', 'c63031075c01577d75ddda25b3b332f1') THEN
    RAISE EXCEPTION 'PRE FALHOU: raio_x_medicao vivo (md5 %) não é o predecessor revisado nem este — reconcilie antes', v_med;
  END IF;
END
$pre$;

-- ── 1) raio_x_planejar: desconto e margem só com unidade comprovada ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.raio_x_planejar(
  p_empresa text, p_sku bigint, p_preco_piso numeric, p_canal text, p_responsavel uuid, p_prazo date,
  p_concluido boolean, p_atualizado_em timestamptz, p_frete numeric DEFAULT -1, p_troca_contrapartida text DEFAULT 'manter')
RETURNS public.raio_x_decisao
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_old public.raio_x_decisao%ROWTYPE;
  v_row public.raio_x_decisao%ROWTYPE;
  v_est text;
  v_vnd text;
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_pm12 numeric;
  v_cmc numeric;
  -- DEFAULTs-sentinela = "manter o gravado": o cliente ANTIGO (8 args) não pode apagar frete/contrapartida que não conhece
  -- (Codex P2-5). Cliente novo manda NULL explícito para limpar.
  v_frete numeric;
  v_contra text;
  v_recalc boolean;
  -- prova de unidade (bug 3 da 2ª revisão): o piso é R$ por unidade de VENDA; o CMC, por unidade do ESTOQUE.
  v_cad text;
  v_ue text;            -- unidade do estoque (cadastro)
  v_un_12m int;         -- nº de unidades de venda distintas em 12m (NULL conta como unidade desconhecida)
  v_un_hist int;        -- idem, em todo o histórico
  v_uv_hist text;       -- a unidade de venda, quando única no histórico
  v_uv_12m text;        -- a unidade de venda, quando única em 12m
  v_venda_unica boolean;
  v_un_equiv boolean;
BEGIN
  IF NOT private.cap_custo_ler(auth.uid()) THEN
    RAISE EXCEPTION 'RAIO_X_SO_CUSTO' USING ERRCODE = '42501';
  END IF;
  IF p_empresa IS NULL OR p_empresa NOT IN ('oben','colacor') THEN
    RAISE EXCEPTION 'raio_x: empresa invalida: %', coalesce(p_empresa, '<null>') USING ERRCODE = '22023';
  END IF;
  v_est := CASE p_empresa WHEN 'oben' THEN 'oben' ELSE 'colacor_vendas' END;
  v_vnd := CASE p_empresa WHEN 'oben' THEN 'OBEN' END;
  v_cad := CASE p_empresa WHEN 'oben' THEN 'oben' ELSE 'colacor' END;
  IF p_sku IS NULL THEN
    RAISE EXCEPTION 'raio_x: sku obrigatorio' USING ERRCODE = '22023';
  END IF;
  IF p_concluido IS NULL THEN
    RAISE EXCEPTION 'raio_x: concluido obrigatorio' USING ERRCODE = '22023';
  END IF;
  IF p_preco_piso < 0 THEN
    RAISE EXCEPTION 'raio_x: preco_piso negativo: %', p_preco_piso USING ERRCODE = '22023';
  END IF;
  IF p_preco_piso = 'NaN'::numeric THEN
    RAISE EXCEPTION 'raio_x: preco_piso invalido: %', p_preco_piso USING ERRCODE = '22023';
  END IF;
  IF p_frete < 0 AND p_frete IS DISTINCT FROM -1 THEN
    RAISE EXCEPTION 'raio_x: frete negativo: %', p_frete USING ERRCODE = '22023';
  END IF;
  IF p_frete = 'NaN'::numeric OR p_frete = 'Infinity'::numeric THEN
    RAISE EXCEPTION 'raio_x: frete invalido: %', p_frete USING ERRCODE = '22023';
  END IF;
  IF p_canal IS NOT NULL AND p_canal NOT IN ('cliente_especifico','promocao_carteira','outlet_queima','outro') THEN
    RAISE EXCEPTION 'raio_x: canal invalido: %', p_canal USING ERRCODE = '22023';
  END IF;
  IF p_troca_contrapartida IS NOT NULL AND p_troca_contrapartida NOT IN ('giro', 'encalhe', 'manter') THEN
    RAISE EXCEPTION 'raio_x: contrapartida invalida: %', p_troca_contrapartida USING ERRCODE = '22023';
  END IF;
  IF p_responsavel IS NOT NULL
     AND NOT (public.has_role(p_responsavel, 'employee') OR public.has_role(p_responsavel, 'master')) THEN
    RAISE EXCEPTION 'raio_x: responsavel nao e da equipe' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_old FROM public.raio_x_decisao d
   WHERE d.empresa = p_empresa AND d.sku_codigo_omie = p_sku FOR UPDATE;
  -- [rx002:inicio]
  IF NOT FOUND OR v_old.destino IS NULL THEN
    RAISE EXCEPTION 'raio_x: sem decisao para planejar (sku %)', p_sku USING ERRCODE = 'RX002';
  END IF;
  -- [rx002:fim]
  -- Concorrência otimista: o cliente manda o atualizado_em que EDITOU. Outro operador gravou no meio (decidir,
  -- contar ou planejar) → RX003, nada escrito: o estado completo velho não sobrescreve o novo em silêncio.
  IF v_old.atualizado_em IS DISTINCT FROM p_atualizado_em THEN
    RAISE EXCEPTION 'raio_x: decisao mudou desde a leitura (sku %)', p_sku USING ERRCODE = 'RX003';
  END IF;
  v_frete  := CASE WHEN p_frete IS NOT DISTINCT FROM -1 THEN v_old.frete_estimado ELSE p_frete END;
  v_contra := CASE WHEN p_troca_contrapartida IS NOT DISTINCT FROM 'manter' THEN v_old.troca_contrapartida ELSE p_troca_contrapartida END;
  IF v_old.destino <> 'liquidar' AND (p_preco_piso IS NOT NULL OR p_canal IS NOT NULL OR v_frete IS NOT NULL) THEN
    RAISE EXCEPTION 'raio_x: piso, canal e frete so no destino liquidar (destino %)', v_old.destino USING ERRCODE = '22023';
  END IF;
  IF v_old.destino <> 'trocar' AND v_contra IS NOT NULL THEN
    RAISE EXCEPTION 'raio_x: contrapartida so no destino trocar (destino %)', v_old.destino USING ERRCODE = '22023';
  END IF;

  -- Bases CONGELADAS da versão aprovada (preço médio 12m faturado e CMC atual): só se (re)leem quando o PISO muda ou
  -- ainda não há base — editar só responsável/prazo amanhã NÃO reescreve o histórico (Codex P1-4). Sem médio (0 venda
  -- em 12m) o desconto é DESCONHECIDO (NULL), nunca 0.
  v_recalc := p_preco_piso IS NOT NULL AND (p_preco_piso IS DISTINCT FROM v_old.preco_piso OR (v_old.preco_medio_base IS NULL AND v_old.cmc_base IS NULL));
  IF v_old.destino = 'liquidar' AND p_preco_piso IS NOT NULL AND NOT v_recalc THEN
    v_pm12 := v_old.preco_medio_base;
    v_cmc := v_old.cmc_base;
  END IF;
  IF v_old.destino = 'liquidar' AND v_recalc THEN
    IF v_vnd IS NOT NULL THEN
      SELECT sum(h.valor_total) / nullif(sum(h.quantidade), 0) INTO v_pm12
        FROM public.v_venda_items_history_efetivo h
       WHERE h.empresa = v_vnd AND h.sku_codigo_omie = p_sku AND h.data_emissao >= v_hoje - 365;
    END IF;
    SELECT x.cmc INTO v_cmc FROM (
      SELECT DISTINCT ON (ip.omie_codigo_produto) ip.cmc FROM public.inventory_position ip
       WHERE ip.account = v_est AND ip.omie_codigo_produto = p_sku
       ORDER BY ip.omie_codigo_produto, ip.synced_at DESC NULLS LAST) x;
    v_cmc := CASE WHEN v_cmc > 0 THEN v_cmc END;
  END IF;

  -- [unidade:inicio] Prova de unidade, relida a CADA salvamento com piso (é validade, não histórico — bases seguem
  -- congeladas). Desconto só com UMA unidade de venda em 12m (o médio de CX misturado com UN não é preço de nada);
  -- margem só com a unidade de venda ÚNICA no histórico = a do estoque. Sem venda (nada prova a unidade), sem cadastro
  -- ou divergente → NULL: ausente ≠ zero, nunca número sem conversão comprovada.
  v_venda_unica := false;
  v_un_equiv := false;
  IF v_old.destino = 'liquidar' AND p_preco_piso IS NOT NULL AND v_vnd IS NOT NULL THEN
    SELECT count(DISTINCT coalesce(h.sku_unidade, '')) FILTER (WHERE h.data_emissao >= v_hoje - 365),
           count(DISTINCT coalesce(h.sku_unidade, '')),
           min(coalesce(h.sku_unidade, '')),
           min(coalesce(h.sku_unidade, '')) FILTER (WHERE h.data_emissao >= v_hoje - 365)
      INTO v_un_12m, v_un_hist, v_uv_hist, v_uv_12m
      FROM public.v_venda_items_history_efetivo h
     WHERE h.empresa = v_vnd AND h.sku_codigo_omie = p_sku;
    SELECT op.unidade INTO v_ue FROM public.omie_products op
     WHERE op.omie_codigo_produto = p_sku AND op.account = v_cad
     ORDER BY op.created_at DESC NULLS LAST LIMIT 1;
    v_venda_unica := coalesce(v_un_12m = 1 AND v_uv_12m <> '', false);
    v_un_equiv := coalesce(v_un_hist = 1 AND v_uv_hist <> '' AND v_uv_hist = v_ue, false);
    -- médio de unidades misturadas não vira base: na releitura fica NULL (a base antiga, se houver, segue congelada)
    IF v_recalc AND NOT v_venda_unica THEN
      v_pm12 := NULL;
    END IF;
  END IF;
  -- [unidade:fim]

  UPDATE public.raio_x_decisao d SET
    preco_piso       = p_preco_piso,
    canal_liquidacao = p_canal,
    frete_estimado   = v_frete,
    preco_medio_base = CASE WHEN p_preco_piso IS NOT NULL THEN round(v_pm12::numeric, 4) END,
    cmc_base         = CASE WHEN p_preco_piso IS NOT NULL THEN v_cmc END,
    desconto_sobre_medio_pct = CASE WHEN p_preco_piso IS NOT NULL AND v_pm12 > 0 AND v_venda_unica THEN round(1 - p_preco_piso / v_pm12, 4) END,
    margem_unit      = CASE WHEN p_preco_piso IS NOT NULL AND v_cmc IS NOT NULL AND v_un_equiv THEN round(p_preco_piso - v_cmc, 4) END,
    troca_contrapartida = v_contra,
    responsavel      = p_responsavel,
    prazo            = p_prazo,
    -- re-salvar "executado" VIGENTE não move data nem autor; executado de antes do destino atual
    -- (concluido_em < decidido_em) é de outra decisão: marcar de novo registra a nova execução.
    concluido_em     = CASE WHEN p_concluido THEN
                         CASE WHEN d.concluido_em IS NOT NULL AND (d.decidido_em IS NULL OR d.concluido_em >= d.decidido_em)
                              THEN d.concluido_em ELSE now() END END,
    concluido_por    = CASE WHEN p_concluido THEN
                         CASE WHEN d.concluido_em IS NOT NULL AND (d.decidido_em IS NULL OR d.concluido_em >= d.decidido_em)
                              THEN d.concluido_por ELSE auth.uid() END END,
    atualizado_em    = now()
   WHERE d.empresa = p_empresa AND d.sku_codigo_omie = p_sku
  RETURNING d.* INTO v_row;
  RETURN v_row;
END;
$fn$;

REVOKE ALL ON FUNCTION public.raio_x_planejar(text, bigint, numeric, text, uuid, date, boolean, timestamptz, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raio_x_planejar(text, bigint, numeric, text, uuid, date, boolean, timestamptz, numeric, text) TO authenticated;

-- ── 2) raio_x_medicao: unidade do estoque e unidades das NFs desde a foto (colunas no FIM) ─────────────────────────
DROP FUNCTION IF EXISTS public.raio_x_medicao(text);
CREATE FUNCTION public.raio_x_medicao(p_empresa text)
RETURNS TABLE (
  sku_codigo_omie bigint, destino text, decidido_em timestamptz,
  foto_saldo numeric, foto_cmc numeric, foto_valor numeric, foto_categoria text, credito_troca numeric,
  saldo_atual numeric, qtd_vendida numeric, receita numeric, preco_medio_12m numeric,
  compras_apos timestamptz[], troca_contrapartida text, unidade_estoque text, unidades_venda_periodo text[])
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_est  text;
  v_vnd  text;
  v_cad  text;
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  IF NOT private.cap_custo_ler(auth.uid()) THEN
    RAISE EXCEPTION 'RAIO_X_SO_STAFF' USING ERRCODE = '42501';
  END IF;

  CASE p_empresa
    WHEN 'oben'    THEN v_est := 'oben';           v_vnd := 'OBEN'; v_cad := 'oben';
    WHEN 'colacor' THEN v_est := 'colacor_vendas'; v_vnd := NULL;   v_cad := 'colacor';
    ELSE RAISE EXCEPTION 'RAIO_X_EMPRESA_INVALIDA: %', coalesce(p_empresa, '<null>') USING ERRCODE = '22023';
  END CASE;

  RETURN QUERY
  WITH d AS (
    SELECT x.sku_codigo_omie AS sku, x.destino, x.decidido_em, x.foto_saldo, x.foto_cmc, x.foto_valor,
           x.foto_categoria, x.credito_troca, x.troca_contrapartida,
           (x.foto_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia   -- NULL sem foto
      FROM public.raio_x_decisao x
     WHERE x.empresa = p_empresa AND x.destino IS NOT NULL),
  e AS (
    SELECT DISTINCT ON (ip.omie_codigo_produto) ip.omie_codigo_produto::bigint AS sku, ip.saldo
      FROM public.inventory_position ip
     WHERE ip.account = v_est
     ORDER BY ip.omie_codigo_produto, ip.synced_at DESC NULLS LAST),
  vh AS (
    SELECT h.sku_codigo_omie AS sku, h.data_emissao, h.quantidade, h.valor_total, h.sku_unidade
      FROM public.v_venda_items_history_efetivo h
     WHERE v_vnd IS NOT NULL AND h.empresa = v_vnd),
  v AS (
    SELECT d.sku,
           coalesce(sum(vh.quantidade)  FILTER (WHERE vh.data_emissao > d.dia), 0) AS qtd,
           coalesce(sum(vh.valor_total) FILTER (WHERE vh.data_emissao > d.dia), 0) AS rec,
           sum(vh.valor_total) FILTER (WHERE vh.data_emissao >= v_hoje - 365)
             / nullif(sum(vh.quantidade) FILTER (WHERE vh.data_emissao >= v_hoje - 365), 0) AS pm12,
           -- unidades das NFs na MESMA janela da quantidade (desde a foto); unidade nula vira '' (desconhecida, nunca prova)
           array_agg(DISTINCT coalesce(vh.sku_unidade, '')) FILTER (WHERE vh.data_emissao > d.dia) AS unidades
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
     GROUP BY d.sku),
  u AS (  -- unidade do estoque: cadastro mais recente (como o LATERAL de raio_x_estoque_fatos)
    SELECT DISTINCT ON (op.omie_codigo_produto) op.omie_codigo_produto::bigint AS sku, op.unidade
      FROM public.omie_products op
      JOIN d ON d.sku = op.omie_codigo_produto
     WHERE op.account = v_cad
     ORDER BY op.omie_codigo_produto, op.created_at DESC NULLS LAST)
  SELECT d.sku, d.destino, d.decidido_em, d.foto_saldo, d.foto_cmc, d.foto_valor, d.foto_categoria, d.credito_troca,
         e.saldo,
         CASE WHEN v_vnd IS NULL OR d.dia IS NULL THEN NULL::numeric ELSE coalesce(v.qtd, 0) END,
         CASE WHEN v_vnd IS NULL OR d.dia IS NULL THEN NULL::numeric ELSE coalesce(v.rec, 0) END,
         CASE WHEN v_vnd IS NULL THEN NULL::numeric ELSE round(v.pm12::numeric, 4) END,
         CASE WHEN p_empresa = 'oben' AND private.cap_compras_ler(auth.uid()) THEN coalesce(c.compras, '{}'::timestamptz[])
              ELSE NULL::timestamptz[] END,
         d.troca_contrapartida,
         u.unidade,
         CASE WHEN v_vnd IS NULL OR d.dia IS NULL THEN NULL::text[] ELSE coalesce(v.unidades, '{}'::text[]) END
    FROM d
    LEFT JOIN e ON e.sku = d.sku
    LEFT JOIN v ON v.sku = d.sku
    LEFT JOIN c ON c.sku = d.sku
    LEFT JOIN u ON u.sku = d.sku
   ORDER BY d.sku;
END
$fn$;

REVOKE ALL ON FUNCTION public.raio_x_medicao(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raio_x_medicao(text) TO authenticated;

-- ── PÓS ──────────────────────────────────────────────────────────────────────────────────────────────────────────
DO $pos$
DECLARE
  v_plan oid := to_regprocedure('public.raio_x_planejar(text,bigint,numeric,text,uuid,date,boolean,timestamptz,numeric,text)');
  v_med  oid := to_regprocedure('public.raio_x_medicao(text)');
BEGIN
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_plan) IS DISTINCT FROM 'bf229655602a8ee1edbdaae3db745003' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: corpo vivo de raio_x_planejar não é o desta migration';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_med) IS DISTINCT FROM 'c63031075c01577d75ddda25b3b332f1' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: corpo vivo de raio_x_medicao não é o desta migration';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid = v_plan) THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: raio_x_planejar perdeu SECURITY DEFINER';
  END IF;
  IF (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid = v_med) THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: raio_x_medicao virou SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', v_plan, 'EXECUTE') OR has_function_privilege('public', v_plan, 'EXECUTE')
     OR has_function_privilege('anon', v_med, 'EXECUTE') OR has_function_privilege('public', v_med, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: anon/public executa planejar ou medicao';
  END IF;
  IF NOT has_function_privilege('authenticated', v_plan, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_med, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: authenticated não executa planejar ou medicao';
  END IF;
  RAISE NOTICE 'RAIO-X-UNIDADES-OK';
END
$pos$;
