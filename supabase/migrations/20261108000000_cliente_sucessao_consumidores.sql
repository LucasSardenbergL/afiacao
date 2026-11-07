-- Sucessor declarado, entrega 3 PR C: os CONSUMIDORES do plano de rateio (a camada de dados é o PR B,
-- 20261107210000_cliente_sucessao_plano_rateio.sql, em prod desde 2026-11-07).
--
-- O que esta migration faz:
--   1. RECRIA `private._venda_sugestoes_json` (o helper de `venda_minhas_sugestoes` e `get_venda_sugestoes_for`) do
--      corpo VIVO (md5 288ace38…, lido em prod via psql-ro em 2026-11-07), só ACRESCENTANDO chaves ao JSON:
--        - por sugestão: `sucessao_origem` (o [{evento_id, revisao}] que o gerador gravou), `herdada_de` (os nomes
--          das antigas daqueles eventos) e `valor_ref_referencia_origem` (o preço de referência veio da antiga: a
--          nova NÃO herda preço — o front ROTULA, não esconde);
--        - por comprador: `valor_ref_total_referencia_origem` (o total soma ao menos um preço da antiga).
--      Nada sai, nada muda de valor: o mesmo filtro, a mesma ordem, os mesmos totais.
--   2. CRIA `public.venda_heranca_comprador(p_comprador)` (a ficha e o complemento): o que o comprador herdou
--      (papel `novo`) ou repassou (papel `antigo`) pelo plano VIGENTE, só de declaração `ativa` em
--      `private.cliente_sucessoes_vigentes(hoje SP)`. Itens, nomes, datas — nenhum valor monetário. Mesmo gate do
--      `venda_complemento_comprador` (staff + carteira).
--   3. CRIA `public.cliente_sucessao_plano_itens(p_evento_id)` (a tela do plano, gestor/master): os destinos do
--      evento, os itens que a antiga comprou ANTES do corte (o mesmo universo e o mesmo dia de
--      `private.venda_linhas_pedido`, recortado pelos cadastros da antiga para caber no statement_timeout de 8 s do
--      `authenticated`) e o sensor do dia (sugestões herdadas na lista de hoje / já mostradas).
--
-- Não muda: `venda_minhas_sugestoes`, `get_venda_sugestoes_for` (chamam o helper), `venda_complemento_comprador`,
-- `venda_painel`, o gerador, a trilha efetiva, o factual, preço, margem, repasse, crédito.
--
-- Molde TRAVA → PRE → CREATE → PÓS. Sem BEGIN/COMMIT: o SQL Editor roda o script inteiro numa transação implícita.
-- Idempotente.

SET LOCAL lock_timeout = '5s';

-- ── 0. TRAVA (antes de ler): ALTER sem efeito, com a volatilidade VIVA, na função que este arquivo recria ─────
DO $trava$
BEGIN
  IF to_regprocedure('private._venda_sugestoes_json(uuid,date)') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: private._venda_sugestoes_json(uuid,date) ausente';
  END IF;
  ALTER FUNCTION private._venda_sugestoes_json(uuid, date) STABLE;
END
$trava$;

-- ── PRE: a base (PR B em prod) e o corpo vivo do helper ∈ {o lido em prod, este} ─────────────────────────────
DO $pre$
DECLARE
  v_vivo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                   WHERE p.oid = to_regprocedure('private._venda_sugestoes_json(uuid,date)'));
BEGIN
  IF to_regprocedure('public.pode_ver_carteira_completa(uuid)') IS NULL
     OR to_regprocedure('private.cap_carteira_ler(uuid)') IS NULL
     OR to_regprocedure('private.cliente_sucessoes_vigentes(date)') IS NULL
     OR to_regprocedure('private.cliente_resolver_documento(text)') IS NULL
     OR to_regprocedure('public.cliente_sucessao_plano_publicar(uuid,integer,jsonb,text)') IS NULL
     OR to_regclass('public.cliente_sucessao_plano_revisoes') IS NULL
     OR to_regclass('public.cliente_sucessao_plano_regras') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'venda_sugestao' AND column_name = 'sucessao_origem')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'venda_sugestao'
                       AND column_name = 'valor_ref_referencia_origem') THEN
    RAISE EXCEPTION 'PRE FALHOU: falta a base (PR B do plano de rateio, 20261107210000)';
  END IF;
  IF v_vivo IS NULL OR NOT (v_vivo = ANY (ARRAY['288ace38a44f0a70bffe5426a0ba44a3', '6e26a8360dbfc2e0af9559d6a75da893'])) THEN
    RAISE EXCEPTION 'PRE FALHOU: private._venda_sugestoes_json vivo (md5 %) não é o corpo revisado', v_vivo;
  END IF;
END
$pre$;

-- ── 1. O helper da lista: + a origem da herança, sem mudar nada do que já sai ────────────────────────────────
CREATE OR REPLACE FUNCTION private._venda_sugestoes_json(p_farmer uuid, p_dia date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ondas jsonb;
  v_out   jsonb;
BEGIN
  IF p_farmer IS NULL OR p_dia IS NULL THEN
    RAISE EXCEPTION '_venda_sugestoes_json: p_farmer/p_dia NULL' USING ERRCODE = '22023';
  END IF;

  -- Liga/desliga do servidor (vale para o aparelho da farmer). Chave ausente = desligada.
  SELECT jsonb_build_object(
           'recompra',    COALESCE(bool_or(c.chave = 'onda_recompra'    AND c.valor = 'true'::jsonb), false),
           'complemento', COALESCE(bool_or(c.chave = 'onda_complemento' AND c.valor = 'true'::jsonb), false),
           'preco',       COALESCE(bool_or(c.chave = 'onda_preco'       AND c.valor = 'true'::jsonb), false))
    INTO v_ondas
    FROM public.venda_config c;

  WITH s AS (
    SELECT s.*, op.descricao, round(vr.cadencia_dias)::int AS cadencia_dias, ho.nomes AS herdada_de
      FROM public.venda_sugestao s
      LEFT JOIN LATERAL (
        SELECT o.descricao FROM public.omie_products o
         WHERE o.omie_codigo_produto = s.omie_codigo_produto AND o.account = s.empresa
         LIMIT 1) op ON true
      LEFT JOIN public.venda_recompra vr
             ON s.tipo = 'recompra' AND vr.comprador_id = s.comprador_id
            AND vr.empresa = s.empresa AND vr.omie_codigo_produto = s.omie_codigo_produto
      -- A herança (PR B): o nome de quem passou o histórico, por evento da origem. Compara o evento como TEXTO:
      -- um elemento fora da forma vira "sem nome", nunca um cast que derruba a lista inteira.
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(DISTINCT COALESCE(
                 (SELECT r.nome FROM private.cliente_resolver_documento(cs.antigo_documento) r), cs.antigo_documento))
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.sucessao_origem) = 'array'
                                         THEN s.sucessao_origem ELSE '[]'::jsonb END) e(el)
          JOIN LATERAL (
            SELECT c.antigo_documento FROM public.cliente_sucessoes c
             WHERE c.evento_id::text = e.el ->> 'evento_id'
             ORDER BY c.declarado_em, c.id LIMIT 1) cs ON true
        ) ho(nomes) ON s.sucessao_origem IS NOT NULL
     WHERE s.fase = 'ativa'
       AND s.farmer_user_id = p_farmer
       AND s.dia_referencia = p_dia
  ),
  c AS (
    SELECT s.comprador_id,
           min(s.motivo_entrada) FILTER (WHERE s.tipo = 'recompra') AS motivo_entrada,
           -- ausente ≠ zero: total só quando TODAS as sugestões de recompra têm valor de referência.
           CASE WHEN bool_and(s.valor_ref IS NOT NULL) FILTER (WHERE s.tipo = 'recompra')
                THEN sum(s.valor_ref) FILTER (WHERE s.tipo = 'recompra') END AS valor_ref_total,
           COALESCE(bool_or(s.valor_ref_referencia_origem AND s.valor_ref IS NOT NULL)
                      FILTER (WHERE s.tipo = 'recompra'), false) AS valor_ref_total_referencia_origem,
           jsonb_agg(jsonb_build_object(
             'id', s.id, 'tipo', s.tipo, 'empresa', s.empresa,
             'omie_codigo_produto', s.omie_codigo_produto, 'descricao', s.descricao,
             'familia', s.familia, 'qtd_ref', s.qtd_ref, 'valor_ref', s.valor_ref,
             'preco_alvo', s.preco_alvo, 'cadencia_dias', s.cadencia_dias,
             'sucessao_origem', s.sucessao_origem, 'herdada_de', s.herdada_de,
             'valor_ref_referencia_origem', s.valor_ref_referencia_origem)
             ORDER BY s.tipo, s.valor_ref DESC NULLS LAST, s.omie_codigo_produto, s.familia) AS sugestoes
      FROM s
     GROUP BY s.comprador_id
  )
  SELECT jsonb_build_object(
           'dia', p_dia,
           'ondas', v_ondas,
           'compradores', COALESCE(jsonb_agg(jsonb_build_object(
               'comprador_id', c.comprador_id,
               'nome', pr.nome,
               'telefone', pr.telefone,
               'motivo_entrada', c.motivo_entrada,
               'valor_ref_total', c.valor_ref_total,
               'valor_ref_total_referencia_origem', c.valor_ref_total_referencia_origem,
               'sugestoes', c.sugestoes)
             ORDER BY c.valor_ref_total DESC NULLS LAST, c.comprador_id), '[]'::jsonb))
    INTO v_out
    FROM c
    LEFT JOIN LATERAL (
      SELECT COALESCE(p.name, p.razao_social) AS nome, p.phone AS telefone
        FROM public.profiles p WHERE p.user_id = c.comprador_id
       ORDER BY p.created_at LIMIT 1) pr ON true;

  RETURN v_out;
END
$function$;

-- ── 2. A herança do comprador (ficha e complemento) ───────────────────────────────────────────────────────────
-- Só declaração `ativa` (os dois extremos inequívocos, o novo cadastrado, o corte alcançado) e o plano VIGENTE
-- (a maior revisão, que não revoga). Destino pendente/revogado não herda — o mesmo critério da trilha efetiva.
CREATE OR REPLACE FUNCTION public.venda_heranca_comprador(p_comprador uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_comprador uuid;
  v_cadastros uuid[];
  v_donos uuid[];
BEGIN
  IF v_uid IS NULL
     OR NOT (public.has_role(v_uid, 'master'::public.app_role)
             OR public.has_role(v_uid, 'employee'::public.app_role)) THEN
    RAISE EXCEPTION 'venda_heranca_comprador: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  IF p_comprador IS NULL THEN
    RAISE EXCEPTION 'venda_heranca_comprador: comprador obrigatório' USING ERRCODE = '22023';
  END IF;

  -- comprador = cadastro canônico; os aliases ativos são o mesmo comprador (o mesmo do complemento)
  SELECT a.canonical_user_id INTO v_comprador
    FROM public.customer_canonical_alias a
   WHERE a.alias_user_id = p_comprador AND a.status = 'active';
  v_comprador := COALESCE(v_comprador, p_comprador);
  SELECT array_agg(x.u) INTO v_cadastros
    FROM (SELECT v_comprador AS u
          UNION
          SELECT a.alias_user_id FROM public.customer_canonical_alias a
           WHERE a.canonical_user_id = v_comprador AND a.status = 'active') x;
  SELECT COALESCE(array_agg(DISTINCT ca.owner_user_id), '{}'::uuid[]) INTO v_donos
    FROM public.carteira_assignments ca
   WHERE ca.eligible = true AND ca.customer_user_id = ANY (v_cadastros)
     AND ca.owner_user_id IS NOT NULL;
  IF NOT private.cap_carteira_ler(v_uid) AND NOT (v_uid = ANY (v_donos)) THEN
    RAISE EXCEPTION 'venda_heranca_comprador: comprador fora da sua carteira' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object('herancas', COALESCE((
    WITH v AS (
      SELECT s.* FROM private.cliente_sucessoes_vigentes(v_hoje) s
       WHERE s.estado = 'ativa' AND (s.novo_user_id = v_comprador OR s.antigo_user_id = v_comprador)
    ),
    rev AS (
      SELECT DISTINCT ON (r.evento_id) r.evento_id, r.revisao, r.revoga
        FROM public.cliente_sucessao_plano_revisoes r
       WHERE r.evento_id IN (SELECT v.evento_id FROM v)
       ORDER BY r.evento_id, r.revisao DESC
    ),
    d AS (
      SELECT v.id, v.evento_id, v.tipo, v.data_corte, v.antigo_user_id, rev.revisao,
             CASE WHEN v.novo_user_id = v_comprador THEN 'novo' ELSE 'antigo' END AS papel,
             CASE WHEN v.novo_user_id = v_comprador THEN v.antigo_documento ELSE v.novo_documento END AS outro_documento
        FROM v JOIN rev ON rev.evento_id = v.evento_id AND NOT rev.revoga
    )
    SELECT jsonb_agg(jsonb_build_object(
             'papel', d.papel, 'evento_id', d.evento_id, 'declaracao_id', d.id, 'tipo', d.tipo,
             'data_corte', d.data_corte, 'revisao', d.revisao,
             'outro_documento', d.outro_documento,
             'outro_nome', (SELECT r.nome FROM private.cliente_resolver_documento(d.outro_documento) r),
             'itens', i.itens)
           ORDER BY d.papel DESC, d.data_corte, d.id)
      FROM d
      JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
                 'empresa', g.empresa, 'omie_codigo_produto', g.omie_codigo_produto,
                 'descricao', op.descricao, 'familia', op.familia)
               ORDER BY g.empresa, g.omie_codigo_produto) AS itens
          FROM public.cliente_sucessao_plano_regras g
          LEFT JOIN LATERAL (
            SELECT o.descricao, NULLIF(btrim(o.familia), '') AS familia FROM public.omie_products o
             WHERE o.account = g.empresa AND o.omie_codigo_produto = g.omie_codigo_produto
             ORDER BY o.descricao LIMIT 1) op ON true
         WHERE g.evento_id = d.evento_id AND g.revisao = d.revisao AND g.destino_sucessao_id = d.id
           -- Só o item que a trilha efetiva de fato transfere: a antiga comprou antes do corte (o universo e o dia de
           -- private.venda_linhas_pedido, recortado pelos cadastros dela). Regra explícita de SKU que ela nunca comprou
           -- não é "herdou" (Codex, P2).
           AND EXISTS (
             SELECT 1 FROM public.order_items oi
               JOIN public.sales_orders so ON so.id = oi.sales_order_id
               LEFT JOIN public.customer_canonical_alias a
                      ON a.alias_user_id = so.customer_user_id AND a.status = 'active'
              WHERE so.customer_user_id IN (SELECT d.antigo_user_id
                                            UNION ALL
                                            SELECT x.alias_user_id FROM public.customer_canonical_alias x
                                             WHERE x.canonical_user_id = d.antigo_user_id AND x.status = 'active')
                AND COALESCE(a.canonical_user_id, so.customer_user_id) = d.antigo_user_id
                AND so.account = g.empresa AND oi.omie_codigo_produto = g.omie_codigo_produto
                AND so.deleted_at IS NULL
                AND so.status NOT IN ('cancelado', 'rascunho', 'pendente', 'orcamento')
                AND so.account IN ('oben', 'colacor', 'colacor_sc')
                AND oi.quantity > 0
                AND COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) < d.data_corte)
      ) i ON i.itens IS NOT NULL
  ), '[]'::jsonb));
END
$function$;
REVOKE ALL ON FUNCTION public.venda_heranca_comprador(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.venda_heranca_comprador(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.venda_heranca_comprador(uuid) IS
  'Ficha/complemento: o que o comprador herdou (novo) ou repassou (antigo) pelo plano de rateio VIGENTE de uma '
  'sucessão ativa. Itens e datas, sem valor. Staff + carteira (o gate do venda_complemento_comprador).';

-- ── 3. Os itens e destinos do plano (a tela do gestor) ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cliente_sucessao_plano_itens(p_evento_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_doc text;
  v_tipo text;
  v_corte date;
  v_antigo uuid;
  v_nome text;
  v_cadastros uuid[];
BEGIN
  IF NOT (COALESCE(public.pode_ver_carteira_completa(v_uid), false)) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only' USING ERRCODE = '42501';
  END IF;
  IF p_evento_id IS NULL THEN
    RAISE EXCEPTION 'cliente_sucessao_plano_itens: evento obrigatório' USING ERRCODE = '22023';
  END IF;

  -- A antiga e o corte como o publicar os lê (a 1ª declaração ativa do evento).
  SELECT s.antigo_documento, s.tipo, s.data_corte INTO v_doc, v_tipo, v_corte
    FROM public.cliente_sucessoes s
   WHERE s.evento_id = p_evento_id AND s.revogado_em IS NULL
   ORDER BY s.declarado_em, s.id
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('evento_id', p_evento_id, 'ativo', false, 'destinos', '[]'::jsonb, 'itens', '[]'::jsonb);
  END IF;
  SELECT r.user_id, r.nome INTO v_antigo, v_nome FROM private.cliente_resolver_documento(v_doc) r;
  IF v_antigo IS NOT NULL THEN
    SELECT array_agg(x.u) INTO v_cadastros
      FROM (SELECT v_antigo AS u
            UNION
            SELECT a.alias_user_id FROM public.customer_canonical_alias a
             WHERE a.canonical_user_id = v_antigo AND a.status = 'active') x;
  END IF;

  RETURN jsonb_build_object(
    'evento_id', p_evento_id,
    'ativo', true,
    'tipo', v_tipo,
    'data_corte', v_corte,
    'antigo_documento', v_doc,
    'antigo_nome', COALESCE(v_nome, (SELECT e.razao_social FROM public.radar_empresas e WHERE e.cnpj = v_doc)),
    'antigo_resolvido', v_antigo IS NOT NULL,
    'destinos', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'destino_sucessao_id', s.id, 'novo_documento', s.novo_documento,
               'novo_nome', COALESCE((SELECT r.nome FROM private.cliente_resolver_documento(s.novo_documento) r),
                                     (SELECT e.razao_social FROM public.radar_empresas e WHERE e.cnpj = s.novo_documento)),
               'estado', COALESCE(v.estado, 'revogada'), 'impedimento', v.impedimento)
             ORDER BY s.declarado_em, s.id)
        FROM public.cliente_sucessoes s
        LEFT JOIN private.cliente_sucessoes_vigentes(v_hoje) v ON v.id = s.id
       WHERE s.evento_id = p_evento_id AND s.revogado_em IS NULL), '[]'::jsonb),
    -- O universo e o dia de private.venda_linhas_pedido (a família do publicar expande por ela), recortado pelos
    -- cadastros da antiga: o predicado do comprador é o MESMO COALESCE; o `= ANY` só deixa a busca indexável.
    'itens', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'empresa', it.empresa, 'omie_codigo_produto', it.omie_codigo_produto,
               'descricao', op.descricao, 'familia', op.familia,
               'pedidos', it.pedidos, 'ultimo_pedido', it.ultimo_pedido)
             ORDER BY it.empresa, op.familia NULLS LAST, op.descricao, it.omie_codigo_produto)
        FROM (
          SELECT x.empresa, x.omie_codigo_produto, count(DISTINCT x.sales_order_id)::int AS pedidos,
                 max(x.data_pedido) AS ultimo_pedido
            FROM (
              SELECT COALESCE(a.canonical_user_id, so.customer_user_id) AS comprador_id,
                     so.account AS empresa, oi.omie_codigo_produto, so.id AS sales_order_id,
                     COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) AS data_pedido
                FROM public.order_items oi
                JOIN public.sales_orders so ON so.id = oi.sales_order_id
                LEFT JOIN public.customer_canonical_alias a
                       ON a.alias_user_id = so.customer_user_id AND a.status = 'active'
               WHERE so.customer_user_id = ANY (v_cadastros)
                 AND so.deleted_at IS NULL
                 AND so.status NOT IN ('cancelado', 'rascunho', 'pendente', 'orcamento')
                 AND so.customer_user_id IS NOT NULL
                 AND so.account IN ('oben', 'colacor', 'colacor_sc')
                 AND oi.omie_codigo_produto IS NOT NULL
                 AND oi.quantity > 0
            ) x
           WHERE x.comprador_id = v_antigo AND x.data_pedido < v_corte
           GROUP BY x.empresa, x.omie_codigo_produto
        ) it
        LEFT JOIN LATERAL (
          SELECT o.descricao, NULLIF(btrim(o.familia), '') AS familia FROM public.omie_products o
           WHERE o.account = it.empresa AND o.omie_codigo_produto = it.omie_codigo_produto
           ORDER BY o.descricao LIMIT 1) op ON true), '[]'::jsonb),
    -- O sensor do dia, com denominador: quantas sugestões da lista de HOJE herdam deste evento, e quantas a
    -- farmer já viu. Contagem, sem valor.
    'sugestoes_hoje', (
      SELECT jsonb_build_object('herdadas', count(*), 'mostradas', count(*) FILTER (WHERE vs.mostrada_em IS NOT NULL))
        FROM public.venda_sugestao vs
       WHERE vs.dia_referencia = v_hoje AND vs.fase = 'ativa'
         AND vs.sucessao_origem @> jsonb_build_array(jsonb_build_object('evento_id', p_evento_id))));
END
$function$;
REVOKE ALL ON FUNCTION public.cliente_sucessao_plano_itens(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cliente_sucessao_plano_itens(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.cliente_sucessao_plano_itens(uuid) IS
  'Gestor/master: para montar o plano de rateio do evento — os destinos (declarações ativas e o estado em vigentes), '
  'os itens que a antiga comprou antes do corte (contagem de pedidos e última data, sem valor) e as sugestões de hoje '
  'que herdam do evento.';

-- ── PÓS: relê o catálogo; qualquer estado insuficiente aborta a transação inteira ───────────────────────────
DO $post$
DECLARE
  f text;
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
       WHERE p.oid = to_regprocedure('private._venda_sugestoes_json(uuid,date)')) IS DISTINCT FROM '6e26a8360dbfc2e0af9559d6a75da893' THEN
    RAISE EXCEPTION 'PÓS FALHOU: private._venda_sugestoes_json não ficou com o corpo deste arquivo';
  END IF;
  FOREACH f IN ARRAY ARRAY['public.venda_heranca_comprador(uuid)', 'public.cliente_sucessao_plano_itens(uuid)'] LOOP
    IF to_regprocedure(f) IS NULL
       OR NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(f)) THEN
      RAISE EXCEPTION 'PÓS FALHOU: % ausente ou sem SECURITY DEFINER', f;
    END IF;
    IF has_function_privilege('anon', f, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x
                   WHERE p.oid = to_regprocedure(f) AND x.grantee = 0 AND x.privilege_type = 'EXECUTE')
       OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'PÓS FALHOU: ACL de % (anon/PUBLIC fechados, authenticated aberto)', f;
    END IF;
  END LOOP;
END
$post$;
