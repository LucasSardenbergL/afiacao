-- Raio-X do estoque parado — correções pós-revisão (Codex + Fable, 2026-10-30) [money-path]
--   (1) raio_x_medicao: janela de VENDA começa na FOTO (foto_em, imutável), não em decidido_em. decidido_em muda
--       quando o destino muda (raio_x_decidir), então trocar "venda dirigida" -> "liquidar" apagava do placar
--       venda já feita. Linha sem foto: qtd_vendida/receita NULL (ausente != zero; antes vinha 0). A contradição
--       de recompra (compras_apos) SEGUE por decidido_em do destino vigente, de propósito: comprar antes de
--       decidir tirar do estoque não contradiz a decisão; comprar depois, sim.
--   (2) raio_x_coorte_top + raio_x_congelar_coorte: a coorte do Top 61 congelada UMA vez por empresa (primeira
--       escrita vence). O cliente manda só a lista de SKUs (a classificação vive no TS); posição = ordem da lista;
--       valor = saldo × cmc lidos AQUI do inventory_position (foto pelo servidor, como em raio_x_decidir).
-- Spec: docs/superpowers/specs/2026-10-15-raio-x-estoque-parado-fase-b-design.md · diário docs/historico/raio-x-estoque-parado-fase-b.md
-- Predecessor de raio_x_medicao: 20261016120000_raio_x_estoque_parado.sql (aplicada em prod 17/10).
-- Aplicação: `bun run db:aplicar supabase/migrations/20261031130000_raio_x_correcoes_pos_revisao.sql`
-- (sem BEGIN/COMMIT: o executor fornece a transação; pelo SQL Editor, embrulhe em BEGIN; … COMMIT;).
-- Idempotente (IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS). Molde TRAVA → PRE → CREATE → PÓS.

-- TRAVA, antes de ler: ALTER sem efeito (a volatilidade viva da medição é STABLE) prende a função até o fim.
DO $trava$
BEGIN
  ALTER FUNCTION public.raio_x_medicao(text) STABLE;
END
$trava$;

-- PRE: md5 EXATO do corpo vivo da medição ∈ {predecessor 20261016120000, este}. Outro corpo ABORTA.
DO $pre$
DECLARE
  v_vivo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                   WHERE p.oid = to_regprocedure('public.raio_x_medicao(text)'));
BEGIN
  IF v_vivo IS NULL OR v_vivo NOT IN ('7a85f7f77967807fe4b16fe68793db1e', 'bb7005968c8af9b1a5f49bd6f301c4ad') THEN
    RAISE EXCEPTION 'PRE FALHOU: raio_x_medicao viva (md5 %) não é a predecessora nem esta — reconcilie antes', v_vivo;
  END IF;
END
$pre$;

-- ============================================================================
-- (2) Coorte do Top 61
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.raio_x_coorte_top (
  empresa         text        NOT NULL CHECK (empresa IN ('oben','colacor')),
  sku_codigo_omie bigint      NOT NULL,
  posicao         smallint    NOT NULL CHECK (posicao BETWEEN 1 AND 61),
  valor           numeric     CHECK (valor IS NULL OR valor > 0),   -- NULL = sem custo no congelamento (nunca 0)
  congelada_em    timestamptz NOT NULL,
  congelada_por   uuid,
  PRIMARY KEY (empresa, sku_codigo_omie),
  UNIQUE (empresa, posicao)
);
COMMENT ON TABLE public.raio_x_coorte_top IS
  'Coorte do Top 61 do Raio-X, congelada uma vez por empresa: o denominador da meta "100% do Top 61 decidido". Escritor único: raio_x_congelar_coorte (SECURITY DEFINER). valor = saldo × cmc no congelamento, lido pelo servidor.';

ALTER TABLE public.raio_x_coorte_top ENABLE ROW LEVEL SECURITY;
-- valor é custo: mesma capacidade de raio_x_decisao. Sem policy de escrita de propósito.
DROP POLICY IF EXISTS raio_x_coorte_top_select_custo ON public.raio_x_coorte_top;
CREATE POLICY raio_x_coorte_top_select_custo ON public.raio_x_coorte_top
  FOR SELECT TO authenticated
  USING ((SELECT private.cap_custo_ler((SELECT auth.uid()))));

-- Congela a coorte: no-op (devolve 0) se a empresa já tem coorte; senão grava e devolve quantas linhas.
CREATE OR REPLACE FUNCTION public.raio_x_congelar_coorte(p_empresa text, p_skus bigint[])
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_est text;
  v_n   integer;
BEGIN
  IF NOT private.cap_custo_ler(auth.uid()) THEN
    RAISE EXCEPTION 'RAIO_X_SO_CUSTO' USING ERRCODE = '42501';
  END IF;
  CASE p_empresa
    WHEN 'oben'    THEN v_est := 'oben';
    WHEN 'colacor' THEN v_est := 'colacor_vendas';
    ELSE RAISE EXCEPTION 'raio_x: empresa invalida: %', coalesce(p_empresa, '<null>') USING ERRCODE = '22023';
  END CASE;
  IF p_skus IS NULL OR cardinality(p_skus) = 0 OR cardinality(p_skus) > 61 THEN
    RAISE EXCEPTION 'raio_x: coorte precisa de 1 a 61 skus (veio %)', coalesce(cardinality(p_skus), 0) USING ERRCODE = '22023';
  END IF;
  IF array_position(p_skus, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'raio_x: coorte com sku nulo' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(DISTINCT s) FROM unnest(p_skus) s) <> cardinality(p_skus) THEN
    RAISE EXCEPTION 'raio_x: coorte com sku repetido' USING ERRCODE = '22023';
  END IF;

  -- Serializa congelamentos concorrentes da MESMA empresa; o 2º vê a coorte do 1º e sai sem escrever.
  PERFORM pg_advisory_xact_lock(hashtext('raio_x_coorte_top'), hashtext(p_empresa));
  -- [guarda:inicio]
  IF EXISTS (SELECT 1 FROM public.raio_x_coorte_top c WHERE c.empresa = p_empresa) THEN
    RETURN 0;
  END IF;
  -- [guarda:fim]

  INSERT INTO public.raio_x_coorte_top (empresa, sku_codigo_omie, posicao, valor, congelada_em, congelada_por)
  SELECT p_empresa, u.sku, u.ord::smallint,
         CASE WHEN ip.cmc > 0 AND ip.saldo > 0 THEN ip.saldo * ip.cmc END,   -- ausente/zero != custo
         now(), auth.uid()
    FROM unnest(p_skus) WITH ORDINALITY AS u(sku, ord)
    LEFT JOIN LATERAL (
      SELECT x.saldo, x.cmc
        FROM public.inventory_position x
       WHERE x.account = v_est AND x.omie_codigo_produto = u.sku
       ORDER BY x.synced_at DESC NULLS LAST
       LIMIT 1) ip ON true;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

REVOKE ALL ON FUNCTION public.raio_x_congelar_coorte(text, bigint[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raio_x_congelar_coorte(text, bigint[]) TO authenticated;

-- ============================================================================
-- (1) Medição: janela de venda pela FOTO. Mesma assinatura e mesmo RETURNS TABLE da predecessora (REPLACE
-- preserva o ACL; o REVOKE é reemitido mesmo assim). Fronteira ESTRITA: data_emissao > dia (SP) de foto_em —
-- a NF só tem dia, a do próprio dia da foto pode ser anterior a ela e NÃO conta (viés conservador).
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
           (x.foto_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia   -- NULL sem foto
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
         CASE WHEN v_vnd IS NULL OR d.dia IS NULL THEN NULL::numeric ELSE coalesce(v.qtd, 0) END,
         CASE WHEN v_vnd IS NULL OR d.dia IS NULL THEN NULL::numeric ELSE coalesce(v.rec, 0) END,
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

-- Postcondição (aborta o apply se o corpo, a ACL ou o RLS não ficaram como o desenho).
DO $post$
DECLARE
  f text;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.raio_x_medicao(text)'))
       IS DISTINCT FROM 'bb7005968c8af9b1a5f49bd6f301c4ad' THEN
    RAISE EXCEPTION 'postcondicao: corpo vivo de raio_x_medicao não é o desta migration';
  END IF;
  IF (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'public.raio_x_medicao(text)'::regprocedure) THEN
    RAISE EXCEPTION 'postcondicao: raio_x_medicao virou SECURITY DEFINER';
  END IF;
  FOREACH f IN ARRAY ARRAY['public.raio_x_medicao(text)', 'public.raio_x_congelar_coorte(text,bigint[])'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'postcondicao: anon executa %', f;
    END IF;
    IF has_function_privilege('public', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'postcondicao: public executa %', f;
    END IF;
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'postcondicao: authenticated sem EXECUTE em %', f;
    END IF;
  END LOOP;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'public.raio_x_congelar_coorte(text,bigint[])'::regprocedure) THEN
    RAISE EXCEPTION 'postcondicao: raio_x_congelar_coorte nao e SECURITY DEFINER';
  END IF;
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.raio_x_coorte_top'::regclass) THEN
    RAISE EXCEPTION 'postcondicao: RLS desligada em raio_x_coorte_top';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'raio_x_coorte_top' AND cmd <> 'SELECT') THEN
    RAISE EXCEPTION 'postcondicao: policy de escrita em raio_x_coorte_top';
  END IF;
  -- PL/pgSQL é late-bound: o congelamento compara omie_codigo_produto com bigint em runtime.
  IF (SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a
       WHERE a.attrelid = 'public.inventory_position'::regclass AND a.attname = 'omie_codigo_produto')
       NOT IN ('bigint', 'integer', 'numeric') THEN
    RAISE EXCEPTION 'postcondicao: inventory_position.omie_codigo_produto nao e numerico';
  END IF;
END $post$;
