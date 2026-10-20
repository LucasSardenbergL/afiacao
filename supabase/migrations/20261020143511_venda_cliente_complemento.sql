-- ============================================================
-- 20261020143511_venda_cliente_complemento.sql
-- Venda por cliente — Task 5: complemento ("Oferecer também") por comprador.
-- Spec: docs/superpowers/specs/2026-10-20-venda-por-cliente-design.md (§7 1c, Fase 3)
-- Plano: docs/superpowers/plans/2026-10-20-venda-por-cliente.md (Task 5)
--
-- O Mix/Gap é a fonte ÚNICA do complemento. Até aqui a fórmula morava inteira dentro de
-- `_carteira_mixgap_for_owner` (carteira inteira, top-1 por cliente). Esta migration:
--
--   1. EXTRAI o núcleo para `private._mixgap_gaps_compradores(uuid[], uuid[])`: pisos
--      (confidence ≥ 0,15 · lift ≥ 1,5 · sample_size ≥ 30), compras 12m, gap por família,
--      supressão (`convertido`; `recusado` < 90 dias) e o feedback_status — por comprador ×
--      família × empresa. Em LOTE (array), não 1 chamada por comprador: medido na prod
--      2026-10-20, a forma por comprador custava 1,0–1,5 s contra 0,3 s numa carteira de 2.399.
--      O comprador é o CANÔNICO: as compras dos aliases ativos (`customer_canonical_alias`)
--      contam para ele.
--   2. `_carteira_mixgap_for_owner` passa a chamar o núcleo, com a MESMA saída. Prova na prod
--      (psql-ro, 2026-10-20): o JSON dos 3 donos com carteira saiu byte-idêntico (md5) entre o
--      corpo antigo e este, inclusive com a resolução de alias (os 8 itens de alias em 12m não
--      mudam nenhum gap hoje). A PÓS abaixo refaz essa comparação DENTRO da transação e aborta
--      se um único dono divergir.
--   3. Cria `venda_complemento_comprador(uuid)` para a ficha da ligação: até 3 famílias
--      (confidence × lift, a mesma ordem do Mix/Gap) e, por família, até 3 SKUs — os comprados
--      por MAIS compradores (12m, universo de venda, mesma empresa) entre os que têm o
--      antecedente de uma regra que gerou o gap. Contagem de compradores, não de quantidade:
--      somar quantidade de unidades diferentes não mede nada.
--      Gate: `private.cap_carteira_ler` (master/gerencial) vê qualquer comprador; qualquer
--      outro staff só os compradores elegíveis da PRÓPRIA carteira; o resto → 42501.
--      Nunca devolve custo, preço ou estoque.
--
-- Caminho de apply: `bun run db:aplicar` (o executor dá a transação — por isso SEM BEGIN/COMMIT).
-- Molde TRAVA → PRE → CREATE → PÓS (lovable-db-operator, "Recriar objeto VIVO").
-- ============================================================

-- TRAVA, antes de ler: ALTER sem efeito (a volatilidade VIVA) em cada função que este arquivo recria.
DO $trava$
BEGIN
  IF to_regprocedure('public._carteira_mixgap_for_owner(uuid)') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: public._carteira_mixgap_for_owner(uuid) ausente — este arquivo só a recria';
  END IF;
  ALTER FUNCTION public._carteira_mixgap_for_owner(uuid) VOLATILE;
  IF to_regprocedure('private._mixgap_gaps_compradores(uuid[],uuid[])') IS NOT NULL THEN
    ALTER FUNCTION private._mixgap_gaps_compradores(uuid[], uuid[]) STABLE;
  END IF;
  IF to_regprocedure('public.venda_complemento_comprador(uuid)') IS NOT NULL THEN
    ALTER FUNCTION public.venda_complemento_comprador(uuid) STABLE;
  END IF;
END
$trava$;

-- PRE: md5 EXATO do corpo vivo ∈ {predecessor revisado (prod 2026-10-20), este}; as novas ∈ {ausente, este}.
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, x.vivo, x.predecessor, x.este
      FROM (VALUES
        ('public._carteira_mixgap_for_owner(uuid)',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
           WHERE p.oid = to_regprocedure('public._carteira_mixgap_for_owner(uuid)')),
         'e35e2e5afd6095496154af13b9ad0a29', '16fcb12b22fcb890a67c331e6855f0a4'),
        ('private._mixgap_gaps_compradores(uuid[],uuid[])',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
           WHERE p.oid = to_regprocedure('private._mixgap_gaps_compradores(uuid[],uuid[])')),
         NULL, 'e7963b8a25d0445ded6c0dc37d5ffe77'),
        ('public.venda_complemento_comprador(uuid)',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
           WHERE p.oid = to_regprocedure('public.venda_complemento_comprador(uuid)')),
         NULL, '84f2e8eaa2e5e8f67f0c5e777bc15874')
      ) AS x(alvo, vivo, predecessor, este)
  LOOP
    IF r.predecessor IS NULL THEN
      IF r.vivo IS NOT NULL AND r.vivo <> r.este THEN
        RAISE EXCEPTION 'PRE FALHOU: % já existe com outro corpo (md5 %) — outra sessão a criou', r.alvo, r.vivo;
      END IF;
    ELSIF r.vivo IS NULL OR r.vivo NOT IN (r.predecessor, r.este) THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) não é o predecessor revisado nem este', r.alvo, r.vivo;
    END IF;
  END LOOP;
END
$pre$;

-- ANTES: a saída do Mix/Gap de cada dono com carteira, para a PÓS comparar (GUC local da transação).
DO $antes$
BEGIN
  PERFORM set_config('venda_complemento.mixgap_antes',
    COALESCE((SELECT jsonb_object_agg(o.owner_user_id::text, public._carteira_mixgap_for_owner(o.owner_user_id))
                FROM (SELECT DISTINCT ca.owner_user_id FROM public.carteira_assignments ca
                       WHERE ca.eligible = true AND ca.owner_user_id IS NOT NULL) o),
             '{}'::jsonb)::text,
    true);
END
$antes$;

-- 1. Núcleo do Mix/Gap, por comprador (canônico) × família × empresa.
--    p_vendedores = de quem é o feedback que suprime e que vira feedback_status.
CREATE OR REPLACE FUNCTION private._mixgap_gaps_compradores(p_compradores uuid[], p_vendedores uuid[])
RETURNS TABLE (
  customer_user_id uuid,
  familia text,
  empresa text,
  confidence numeric,
  lift numeric,
  evidence_count bigint,
  feedback_status text,
  regras uuid[]
)
LANGUAGE sql
STABLE
SET search_path = public
AS $fn$
  WITH cad AS (
    SELECT c.comprador, c.comprador AS cadastro FROM unnest(p_compradores) AS c(comprador)
    UNION
    SELECT a.canonical_user_id, a.alias_user_id
      FROM public.customer_canonical_alias a
     WHERE a.status = 'active' AND a.canonical_user_id = ANY (p_compradores)
  ),
  compras AS (
    SELECT DISTINCT cad.comprador, op.id::text AS pid, op.familia
      FROM public.order_items oi
      JOIN cad ON cad.cadastro = oi.customer_user_id
      JOIN public.omie_products op
        ON (oi.product_id = op.id
            OR (oi.product_id IS NULL AND oi.omie_codigo_produto = op.omie_codigo_produto))
     WHERE oi.created_at >= now() - interval '12 months'
       AND op.familia IS NOT NULL
  ),
  perfil AS (
    SELECT comprador, array_agg(DISTINCT pid) AS prods, array_agg(DISTINCT familia) AS fams
      FROM compras GROUP BY comprador
  ),
  regra AS (
    SELECT id, antecedent_product_ids, consequent_product_ids, confidence, lift
      FROM public.farmer_association_rules
     WHERE confidence >= 0.15 AND lift >= 1.5 AND sample_size >= 30
  ),
  gaps AS (
    SELECT pf.comprador, op.familia, op.account AS empresa, r.id AS regra_id, r.confidence, r.lift
      FROM perfil pf
      JOIN regra r ON r.antecedent_product_ids <@ pf.prods
     CROSS JOIN LATERAL unnest(r.consequent_product_ids) AS cons(pid)
      JOIN public.omie_products op ON op.id::text = cons.pid
     WHERE op.familia IS NOT NULL AND NOT (op.familia = ANY (pf.fams))
  ),
  fb AS (
    SELECT f.customer_user_id, f.familia, f.status, f.updated_at
      FROM public.farmer_mixgap_feedback f
     WHERE f.seller_user_id = ANY (p_vendedores)
       AND f.customer_user_id = ANY (p_compradores)
  )
  SELECT g.comprador, g.familia, g.empresa,
         max(g.confidence), max(g.lift), count(*)::bigint,
         (SELECT f.status FROM fb f
           WHERE f.customer_user_id = g.comprador AND f.familia = g.familia
           ORDER BY f.updated_at DESC, f.status
           LIMIT 1),
         array_agg(DISTINCT g.regra_id)
    FROM gaps g
   WHERE NOT EXISTS (
     SELECT 1 FROM fb f
      WHERE f.customer_user_id = g.comprador AND f.familia = g.familia
        AND (f.status = 'convertido'
             OR (f.status = 'recusado' AND f.updated_at > now() - interval '90 days')))
   GROUP BY g.comprador, g.familia, g.empresa
$fn$;

-- 2. Mix/Gap da carteira (get_meu_mixgap / get_meu_mixgap_for): mesma assinatura, mesma saída.
CREATE OR REPLACE FUNCTION public._carteira_mixgap_for_owner(p_owner uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  uid uuid := p_owner;
  v_eleg uuid[];
  result jsonb;
BEGIN
  IF uid IS NULL THEN RETURN NULL; END IF;
  SELECT array_agg(DISTINCT customer_user_id) INTO v_eleg
    FROM public.carteira_assignments
   WHERE owner_user_id = uid AND eligible = true;
  WITH g AS (
    SELECT * FROM private._mixgap_gaps_compradores(v_eleg, ARRAY[uid])
  ),
  gap_visivel AS (
    SELECT g.customer_user_id, g.familia AS familia_faltante,
           max(g.confidence) AS confidence, max(g.lift) AS lift,
           sum(g.evidence_count)::bigint AS evidence_count,
           min(g.feedback_status) AS feedback_status
      FROM g GROUP BY g.customer_user_id, g.familia
  ),
  top1 AS (
    SELECT DISTINCT ON (customer_user_id)
      customer_user_id, familia_faltante, confidence, lift, evidence_count, feedback_status
    FROM gap_visivel ORDER BY customer_user_id, (confidence * lift) DESC, evidence_count DESC
  )
  SELECT jsonb_build_object(
    'total_com_gap', (SELECT count(*) FROM top1),
    'lista', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'customer_user_id', t.customer_user_id,
        'nome', COALESCE(p.razao_social, p.name),
        'familia_faltante', t.familia_faltante,
        'confidence', t.confidence, 'lift', t.lift, 'evidence_count', t.evidence_count,
        'feedback_status', t.feedback_status
      ) ORDER BY (t.confidence * t.lift) DESC, t.evidence_count DESC)
      FROM (SELECT * FROM top1 ORDER BY (confidence * lift) DESC, evidence_count DESC LIMIT 100) t
      LEFT JOIN public.profiles p ON p.user_id = t.customer_user_id
    ), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END;
$function$;

-- 3. Complemento da ficha da ligação.
CREATE OR REPLACE FUNCTION public.venda_complemento_comprador(p_comprador uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_comprador uuid;
  v_cadastros uuid[];
  v_donos uuid[];
  v_result jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT (public.has_role(v_uid, 'master'::public.app_role)
             OR public.has_role(v_uid, 'employee'::public.app_role)) THEN
    RAISE EXCEPTION 'venda_complemento_comprador: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  IF p_comprador IS NULL THEN
    RAISE EXCEPTION 'venda_complemento_comprador: comprador obrigatório' USING ERRCODE = '22004';
  END IF;

  -- comprador = cadastro canônico; os aliases ativos são o mesmo comprador
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
    RAISE EXCEPTION 'venda_complemento_comprador: comprador fora da sua carteira' USING ERRCODE = '42501';
  END IF;

  WITH g AS (
    SELECT * FROM private._mixgap_gaps_compradores(ARRAY[v_comprador], v_donos || v_uid)
  ),
  fam AS (
    SELECT g.familia, max(g.confidence) AS confidence, max(g.lift) AS lift,
           sum(g.evidence_count)::bigint AS evidence_count, min(g.feedback_status) AS feedback_status
      FROM g GROUP BY g.familia
  ),
  top3 AS (
    SELECT * FROM fam ORDER BY (confidence * lift) DESC, evidence_count DESC, familia LIMIT 3
  ),
  -- a empresa da família = a da linha mais forte do gap (é nela que os SKUs são buscados)
  emp AS (
    SELECT DISTINCT ON (g.familia) g.familia, g.empresa, g.regras
      FROM g JOIN top3 t ON t.familia = g.familia
     ORDER BY g.familia, (g.confidence * g.lift) DESC, g.evidence_count DESC, g.empresa
  ),
  antecedente AS (
    SELECT DISTINCT e.familia, e.empresa, r.antecedent_product_ids AS ant
      FROM emp e
     CROSS JOIN LATERAL unnest(e.regras) AS rid(id)
      JOIN public.farmer_association_rules r ON r.id = rid.id
  ),
  -- universo de venda (src/lib/farmer/universo-pedidos.ts), 12 meses no relógio de São Paulo
  vendas AS (
    SELECT COALESCE(al.canonical_user_id, so.customer_user_id) AS comprador,
           so.id AS pedido, so.account, op.id::text AS pid, op.familia,
           op.account AS conta_produto, op.omie_codigo_produto, op.descricao, op.ativo
      FROM public.order_items oi
      JOIN public.sales_orders so ON so.id = oi.sales_order_id
      JOIN public.omie_products op
        ON op.id = COALESCE(oi.product_id,
                            (SELECT x.id FROM public.omie_products x
                              WHERE x.omie_codigo_produto = oi.omie_codigo_produto
                                AND x.account = so.account))
      LEFT JOIN public.customer_canonical_alias al
        ON al.alias_user_id = so.customer_user_id AND al.status = 'active'
     WHERE so.deleted_at IS NULL
       AND so.status NOT IN ('cancelado', 'rascunho', 'pendente', 'orcamento')
       AND COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date)
           >= ((now() AT TIME ZONE 'America/Sao_Paulo')::date - interval '12 months')::date
  ),
  perfis AS (
    SELECT comprador, array_agg(DISTINCT pid) AS prods FROM vendas GROUP BY comprador
  ),
  parecidos AS (
    SELECT DISTINCT a.familia, a.empresa, pf.comprador
      FROM antecedente a JOIN perfis pf ON a.ant <@ pf.prods
     WHERE pf.comprador <> v_comprador
  ),
  sku AS (
    SELECT pa.familia, pa.empresa, v.omie_codigo_produto, v.descricao,
           count(DISTINCT v.comprador) AS compradores, count(DISTINCT v.pedido) AS pedidos
      FROM parecidos pa
      JOIN vendas v ON v.comprador = pa.comprador AND v.familia = pa.familia
                   AND v.conta_produto = pa.empresa AND v.account = pa.empresa
     WHERE v.ativo IS DISTINCT FROM false
     GROUP BY pa.familia, pa.empresa, v.omie_codigo_produto, v.descricao
  ),
  sku_rank AS (
    SELECT s.*, row_number() OVER (PARTITION BY s.familia, s.empresa
                                   ORDER BY s.compradores DESC, s.pedidos DESC,
                                            s.descricao, s.omie_codigo_produto) AS rn
      FROM sku s
  )
  SELECT jsonb_build_object('familias', COALESCE(jsonb_agg(jsonb_build_object(
           'familia', t.familia,
           'empresa', e.empresa,
           'confidence', t.confidence,
           'lift', t.lift,
           'evidence_count', t.evidence_count,
           'feedback_status', t.feedback_status,
           'skus', COALESCE((
             SELECT jsonb_agg(jsonb_build_object('omie_codigo_produto', s.omie_codigo_produto,
                                                 'descricao', s.descricao) ORDER BY s.rn)
               FROM sku_rank s
              WHERE s.familia = t.familia AND s.empresa = e.empresa AND s.rn <= 3), '[]'::jsonb)
         ) ORDER BY (t.confidence * t.lift) DESC, t.evidence_count DESC, t.familia), '[]'::jsonb))
    INTO v_result
    FROM top3 t JOIN emp e ON e.familia = t.familia;

  RETURN v_result;
END;
$fn$;

-- ACL: fechar nas DUAS pontas (PUBLIC e anon). O núcleo e o interno da carteira não são RPC.
REVOKE ALL ON FUNCTION private._mixgap_gaps_compradores(uuid[], uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._carteira_mixgap_for_owner(uuid)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.venda_complemento_comprador(uuid)          FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.venda_complemento_comprador(uuid)       TO authenticated, service_role;

-- PÓS: corpos, ACL, saída do Mix/Gap idêntica por dono, e as funções EXECUTADAS (PL/pgSQL é late-bound).
DO $post$
DECLARE
  v_antes jsonb := current_setting('venda_complemento.mixgap_antes')::jsonb;
  v_dono text;
  v_master uuid;
  v_comprador uuid;
  v_out jsonb;
  v_fam jsonb;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = 'public._carteira_mixgap_for_owner(uuid)'::regprocedure)
       IS DISTINCT FROM '16fcb12b22fcb890a67c331e6855f0a4'
     OR (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = 'private._mixgap_gaps_compradores(uuid[],uuid[])'::regprocedure)
       IS DISTINCT FROM 'e7963b8a25d0445ded6c0dc37d5ffe77'
     OR (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = 'public.venda_complemento_comprador(uuid)'::regprocedure)
       IS DISTINCT FROM '84f2e8eaa2e5e8f67f0c5e777bc15874' THEN
    RAISE EXCEPTION 'POS FALHOU: corpo vivo não é o deste arquivo';
  END IF;

  IF has_function_privilege('anon', 'public.venda_complemento_comprador(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'private._mixgap_gaps_compradores(uuid[],uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private._mixgap_gaps_compradores(uuid[],uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public._carteira_mixgap_for_owner(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._carteira_mixgap_for_owner(uuid)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(p.proacl) a
                 WHERE p.oid IN ('public.venda_complemento_comprador(uuid)'::regprocedure,
                                 'private._mixgap_gaps_compradores(uuid[],uuid[])'::regprocedure,
                                 'public._carteira_mixgap_for_owner(uuid)'::regprocedure)
                   AND a.grantee = 0)
     OR NOT has_function_privilege('authenticated', 'public.venda_complemento_comprador(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: ACL — anon/PUBLIC executa, ou authenticated alcança o interno, ou a RPC ficou fechada';
  END IF;

  FOR v_dono IN SELECT jsonb_object_keys(v_antes) LOOP
    IF public._carteira_mixgap_for_owner(v_dono::uuid) IS DISTINCT FROM v_antes -> v_dono THEN
      RAISE EXCEPTION 'POS FALHOU: Mix/Gap do dono % mudou com a extração do núcleo', v_dono;
    END IF;
  END LOOP;

  -- execução real da RPC nova, como master (auth.uid() lê o JWT da requisição)
  SELECT ur.user_id INTO v_master FROM public.user_roles ur
   WHERE ur.role = 'master'::public.app_role ORDER BY ur.user_id LIMIT 1;
  SELECT (e ->> 'customer_user_id')::uuid INTO v_comprador
    FROM jsonb_each(v_antes) d, jsonb_array_elements(d.value -> 'lista') e
   ORDER BY e ->> 'customer_user_id' LIMIT 1;
  IF v_comprador IS NOT NULL AND v_master IS NULL THEN
    RAISE EXCEPTION 'POS FALHOU: há comprador com gap mas nenhum master para executar a RPC nova';
  END IF;
  IF v_comprador IS NOT NULL THEN
    PERFORM set_config('request.jwt.claim.sub', v_master::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_master, 'role', 'authenticated')::text, true);
    v_out := public.venda_complemento_comprador(v_comprador);
    IF jsonb_typeof(v_out -> 'familias') IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_out -> 'familias') NOT BETWEEN 1 AND 3 THEN
      RAISE EXCEPTION 'POS FALHOU: complemento de % (que tem gap no Mix/Gap) veio %', v_comprador, v_out;
    END IF;
    FOR v_fam IN SELECT jsonb_array_elements(v_out -> 'familias') LOOP
      IF jsonb_array_length(v_fam -> 'skus') > 3 OR v_fam ->> 'familia' IS NULL OR v_fam ->> 'empresa' IS NULL THEN
        RAISE EXCEPTION 'POS FALHOU: família fora do contrato: %', v_fam;
      END IF;
    END LOOP;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '', true);
  END IF;
  RAISE NOTICE 'POS OK: % donos com Mix/Gap idêntico; complemento executado para %', (SELECT count(*) FROM jsonb_object_keys(v_antes)), v_comprador;
END
$post$;
