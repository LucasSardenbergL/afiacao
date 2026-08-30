-- 20260830204209_captura_corpo_vivo_authz_5_funcoes.sql
-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  CAPTURA (não mudança) — o corpo VIVO em prod de 5 funções de authz que o     ║
-- ║  repo descreve na versão FROUXA. Enquanto esta migration não existir, todo    ║
-- ║  `CREATE OR REPLACE` futuro partindo do repo REVERTE hardening de autorização ║
-- ║  em silêncio: o CI não alcança o banco e o repo é internamente consistente,   ║
-- ║  então nada fica vermelho. O repo é a bomba; o banco está certo.              ║
-- ║                                                                              ║
-- ║  Origem: docs/historico/deriva-de-corpo-prod-a-frente-do-repo.md (pendência   ║
-- ║  nº 1). Das 24 derivas triadas, 8 divergiam de fato e em TODAS o vivo era o   ║
-- ║  mais novo — em 5 delas o que só existia vivo era authz. São estas 5.         ║
-- ║                                                                              ║
-- ║  ⚠️ APLICAR ESTA MIGRATION É NO-OP SEMÂNTICO EM PROD. Ela recria cada função  ║
-- ║  com o texto que JÁ roda hoje (extraído por `pg_get_functiondef` via psql-ro  ║
-- ║  em 2026-08-30). Prova: o md5 do functiondef pós-apply tem de ser IDÊNTICO ao ║
-- ║  de antes — é a query de validação no rodapé. Se algum md5 MUDAR, a captura   ║
-- ║  não foi fiel e a migration não deve ficar: avise antes de seguir.            ║
-- ║                                                                              ║
-- ║  ── O QUE O REPO DIZIA (e que esta migration para de dizer) ──────────────── ║
-- ║  get_tint_price / get_tint_prices  (20260708234100_tint_gate_custo_staff)     ║
-- ║    repo: auth.uid() IS NOT NULL AND (has_role employee OR has_role master)    ║
-- ║    vivo: private.cap_custo_ler(auth.uid())                                    ║
-- ║  get_preco_cockpit                 (20260704120000_preco_por_tier)            ║
-- ║    repo: pode_ver_carteira_completa(auth.uid())   ← ainda inclui 'gerencial'  ║
-- ║    vivo: private.cap_custo_ler(auth.uid())                                    ║
-- ║                                                                              ║
-- ║  `private.cap_custo_ler` = master OR (employee AND commercial_role IN         ║
-- ║  ('estrategico','super_admin')). É ESTRITAMENTE mais restrito que os dois     ║
-- ║  predicados do repo. É o gate que decide se `cmc` e `markup_perc` saem como   ║
-- ║  número ou como null — aplicar a versão do repo hoje EXPORIA custo e markup a ║
-- ║  qualquer employee (e, no cockpit, também ao 'gerencial'). Nasceu no FU4F     ║
-- ║  (2026-07-18) e foi colado em prod sem virar migration para estas três.       ║
-- ║                                                                              ║
-- ║  ⚠️ get_preco_cockpit tem DOIS gates independentes, e só o SEGUNDO muda aqui: ║
-- ║  o gate de EXECUÇÃO (`RAISE 'forbidden'` 42501 p/ não-staff) segue employee   ║
-- ║  OR master, VERBATIM como no repo — quem opera o cockpit continua entrando.   ║
-- ║  O que `cap_custo_ler` gateia é só a PROJEÇÃO numérica (cmc, markup_perc,     ║
-- ║  folga_reais, piso/meta_markup, proveniencia, frescor).                       ║
-- ║                                                                              ║
-- ║  farmer_recomendacoes_substituir / farmer_bundle_recomendacoes_substituir     ║
-- ║    (20260815181500_farmer_geracao_head_sensor)                                ║
-- ║    Só o vivo tem o guard de ESCOPO DE CARTEIRA: `PERFORM … FOR SHARE` sobre   ║
-- ║    farmer_client_scores (lock causal do lote) + contagem de linhas com        ║
-- ║    `s.farmer_id IS DISTINCT FROM p_farmer_id` + RAISE ERRCODE 'FG009'. Sem    ║
-- ║    ele, um farmer grava recomendação para cliente de OUTRO farmer. `FOR       ║
-- ║    SHARE` não aparece em NENHUMA migration do repo. O raciocínio completo     ║
-- ║    (por que FOR SHARE e não FOR KEY SHARE, a janela T1/T2, por que FG009 e    ║
-- ║    não FG008) está preservado nos comentários do próprio corpo, abaixo.       ║
-- ║                                                                              ║
-- ║  Medido antes de escrever (diff por TOKEN, com o stripper compartilhado       ║
-- ║  removerComentariosSql — nunca regex local): nas 3 de preço a ÚNICA           ║
-- ║  divergência vivo×repo é o gate; nas 2 de farmer o vivo só ACRESCENTA — as    ║
-- ║  remoções são todas do renderizador (`NULL`→`NULL::text`, `SECURITY INVOKER`  ║
-- ║  implícito). Nenhuma remoção semântica: é captura, não mudança.               ║
-- ║                                                                              ║
-- ║  ACL: `CREATE OR REPLACE` PRESERVA a ACL (só `DROP`+`CREATE` a reseta) — e    ║
-- ║  aqui não há DROP nenhum, de propósito. Os grants do rodapé são reafirmação   ║
-- ║  idempotente NOMEANDO as roles, espelhando o que a ACL viva já diz            ║
-- ║  (authenticated + service_role; sem anon, sem PUBLIC).                        ║
-- ║                                                                              ║
-- ║  Prova de execução (PL/pgSQL é late-bound — CREATE passar não prova nada):    ║
-- ║  db/test-captura-authz-5-funcoes.sh (PG17 local, com falsificação).           ║
-- ║                                                                              ║
-- ║  ⚠️ MIGRATION MANUAL — Lovable não auto-aplica nome custom. SQL Editor → Run. ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

-- ── Guard de dependências — FAIL-CLOSED ──────────────────────────────────────
-- PL/pgSQL e SQL são late-bound: se `private.cap_custo_ler` não existir, o CREATE
-- PASSA e a função só quebra em RUNTIME, no meio do money-path. Pior: `get_tint_*`
-- é SECURITY DEFINER e o erro apareceria para o CLIENTE no balcão. Falhar aqui, no
-- Run do SQL Editor, é o único lugar barato de descobrir. Idempotente.
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'private' AND p.proname = 'cap_custo_ler') THEN
    RAISE EXCEPTION 'dep ausente: private.cap_custo_ler — é O gate de custo das 3 RPCs de preço (prod divergiu?)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'private' AND p.proname = 'cap_carteira_escrever') THEN
    RAISE EXCEPTION 'dep ausente: private.cap_carteira_escrever — gate de escrita das 2 RPCs de farmer';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'has_role' AND pronamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'dep ausente: public.has_role — gate de execução do cockpit';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'uid' AND pronamespace = 'auth'::regnamespace) THEN
    RAISE EXCEPTION 'dep ausente: auth.uid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relname = 'farmer_client_scores') THEN
    RAISE EXCEPTION 'dep ausente: public.farmer_client_scores — o guard de escopo FG009 trava e conta nela';
  END IF;
END
$guard$;

-- ── get_tint_price — gate de custo via private.cap_custo_ler ─────────────────────────────────────────
-- Corpo VERBATIM da PROD (pg_get_functiondef, 2026-08-30). Não reescrever à mão.
CREATE OR REPLACE FUNCTION public.get_tint_price(p_formula_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_staff boolean;
  v_base_preco numeric;
  v_base_ativo boolean;
  v_base_disponivel boolean;
  v_custo_base numeric;
  v_custo_corantes numeric;
  v_corantes_completos boolean;
  v_preco_final numeric;
  v_itens jsonb;
BEGIN
  v_is_staff := private.cap_custo_ler(auth.uid());

  SELECT op.valor_unitario, op.ativo INTO v_base_preco, v_base_ativo
  FROM tint_formulas f
  LEFT JOIN tint_skus s ON s.id = f.sku_id
  LEFT JOIN omie_products op ON op.id = s.omie_product_id
  WHERE f.id = p_formula_id;

  v_base_disponivel := v_base_preco IS NOT NULL AND v_base_preco > 0 AND COALESCE(v_base_ativo, false);
  v_custo_base := CASE WHEN v_base_disponivel THEN v_base_preco ELSE NULL END;

  WITH calc AS (
    SELECT
      fi.ordem,
      COALESCE(c.descricao, '?') AS corante_descricao,
      fi.qtd_ml,
      (COALESCE(op.valor_unitario, 0) > 0 AND COALESCE(op.ativo, false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml > 0) AS custo_disponivel,
      CASE WHEN COALESCE(op.valor_unitario, 0) > 0 AND COALESCE(op.ativo, false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml > 0
           THEN op.valor_unitario / c.volume_total_ml ELSE 0 END AS custo_por_ml,
      CASE WHEN COALESCE(op.valor_unitario, 0) > 0 AND COALESCE(op.ativo, false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml > 0
           THEN fi.qtd_ml * (op.valor_unitario / c.volume_total_ml) ELSE 0 END AS custo_item
    FROM tint_formula_itens fi
    LEFT JOIN tint_corantes c  ON c.id = fi.corante_id
    LEFT JOIN omie_products op ON op.id = c.omie_product_id
    WHERE fi.formula_id = p_formula_id
  )
  SELECT
    COALESCE(SUM(custo_item), 0),
    COALESCE(bool_and(custo_disponivel), false),
    COALESCE(jsonb_agg(jsonb_build_object(
      'coranteDescricao', corante_descricao, 'qtdMl', qtd_ml, 'custoPorMl', custo_por_ml,
      'custoItem', custo_item, 'custoDisponivel', custo_disponivel
    ) ORDER BY ordem), '[]'::jsonb)
  INTO v_custo_corantes, v_corantes_completos, v_itens
  FROM calc;

  v_preco_final := CASE WHEN v_base_disponivel AND v_corantes_completos
                        THEN v_custo_base + v_custo_corantes ELSE NULL END;

  RETURN jsonb_build_object(
    'custoBase', CASE WHEN v_is_staff THEN v_custo_base ELSE NULL END,
    'baseDisponivel', v_base_disponivel,
    'custoCorantes', CASE WHEN v_is_staff THEN v_custo_corantes ELSE NULL END,
    'corantesCompletos', v_corantes_completos,
    'precoFinal', v_preco_final,
    'itensCorantes', CASE WHEN v_is_staff THEN v_itens ELSE '[]'::jsonb END
  );
END; $function$;

-- ── get_tint_prices — idem, dentro do CTE staff AS MATERIALIZED ─────────────────────────────────────────
-- Corpo VERBATIM da PROD (pg_get_functiondef, 2026-08-30). Não reescrever à mão.
CREATE OR REPLACE FUNCTION public.get_tint_prices(p_formula_ids uuid[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH staff AS MATERIALIZED (
    SELECT (private.cap_custo_ler(auth.uid())) AS is_staff
  ),
  bases AS (
    SELECT f.id AS formula_id,
           op.valor_unitario AS base_preco,
           (op.valor_unitario IS NOT NULL AND op.valor_unitario > 0 AND COALESCE(op.ativo, false)) AS base_disponivel
    FROM tint_formulas f
    LEFT JOIN tint_skus s ON s.id = f.sku_id
    LEFT JOIN omie_products op ON op.id = s.omie_product_id
    WHERE f.id = ANY(p_formula_ids)
  ),
  corantes AS (
    SELECT fi.formula_id,
           COALESCE(SUM(CASE WHEN COALESCE(op.valor_unitario,0) > 0 AND COALESCE(op.ativo, false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml > 0
                             THEN fi.qtd_ml * op.valor_unitario / c.volume_total_ml ELSE 0 END), 0) AS custo_corantes,
           COALESCE(bool_and(COALESCE(op.valor_unitario,0) > 0 AND COALESCE(op.ativo, false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml > 0), false) AS corantes_completos
    FROM tint_formula_itens fi
    LEFT JOIN tint_corantes c  ON c.id = fi.corante_id
    LEFT JOIN omie_products op ON op.id = c.omie_product_id
    WHERE fi.formula_id = ANY(p_formula_ids)
    GROUP BY fi.formula_id
  )
  SELECT COALESCE(jsonb_object_agg(b.formula_id, jsonb_build_object(
    'custoBase', CASE WHEN s.is_staff AND b.base_disponivel THEN b.base_preco ELSE NULL END,
    'baseDisponivel', b.base_disponivel,
    'custoCorantes', CASE WHEN s.is_staff THEN COALESCE(co.custo_corantes, 0) ELSE NULL END,
    'corantesCompletos', COALESCE(co.corantes_completos, false),
    'precoFinal', CASE WHEN b.base_disponivel AND COALESCE(co.corantes_completos, false)
                       THEN b.base_preco + COALESCE(co.custo_corantes, 0) ELSE NULL END
  )), '{}'::jsonb)
  FROM bases b
  LEFT JOIN corantes co ON co.formula_id = b.formula_id
  CROSS JOIN staff s;
$function$;

-- ── get_preco_cockpit — execução (employee/master) + projeção (cap_custo_ler) ─────────────────────────────────────────
-- Corpo VERBATIM da PROD (pg_get_functiondef, 2026-08-30). Não reescrever à mão.
CREATE OR REPLACE FUNCTION public.get_preco_cockpit(p_itens jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pode_num boolean; v_out jsonb := '[]'::jsonb; v_item jsonb;
  v_empresa text; v_codigo bigint; v_preco numeric; v_formula uuid;
  v_cmc numeric; v_prov text; v_fresc timestamptz; v_familia text;
  v_piso numeric; v_meta numeric; v_tem_pol boolean;
  v_faixa text; v_motivo text; v_markup numeric; v_folga numeric;
  v_accounts text[]; v_preco_ok boolean; v_cmc_ok boolean; v_customer uuid; v_tier text;
BEGIN
  IF NOT (auth.uid() IS NOT NULL AND (has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'master'::app_role))) THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  IF jsonb_array_length(p_itens) > 200 THEN RAISE EXCEPTION 'too many items (max 200)' USING errcode = '22023'; END IF;
  v_pode_num := private.cap_custo_ler(auth.uid());
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens) LOOP
    v_cmc := NULL; v_prov := NULL; v_fresc := NULL; v_familia := NULL; v_piso := NULL; v_meta := NULL; v_tier := NULL;
    v_empresa := lower(v_item->>'empresa'); v_codigo := (v_item->>'codigo')::bigint;
    v_preco := (v_item->>'preco')::numeric; v_formula := NULLIF(v_item->>'tint_formula_id','')::uuid;
    v_customer := NULLIF(v_item->>'customer_user_id','')::uuid;
    v_preco_ok := v_preco IS NOT NULL AND v_preco <> 'NaN'::numeric;
    v_accounts := CASE v_empresa WHEN 'oben' THEN ARRAY['vendas','oben'] WHEN 'colacor' THEN ARRAY['colacor_vendas','colacor']
            WHEN 'colacor_sc' THEN ARRAY['servicos','colacor_sc'] ELSE ARRAY[v_empresa] END;
    IF v_formula IS NOT NULL THEN
      DECLARE v_base_cmc numeric; v_base_synced timestamptz; v_cor_total numeric; v_cor_faltando int; v_n_itens int; v_cor_min_synced timestamptz;
      BEGIN
        SELECT ip.cmc, ip.synced_at INTO v_base_cmc, v_base_synced
        FROM tint_formulas tf
        JOIN tint_skus ts ON ts.id = tf.sku_id OR (tf.sku_id IS NULL AND ts.account = tf.account
              AND ts.produto_id = tf.produto_id AND ts.base_id = tf.base_id AND ts.embalagem_id = tf.embalagem_id)
        JOIN omie_products opb ON opb.id = ts.omie_product_id
        JOIN inventory_position ip ON ip.omie_codigo_produto = opb.omie_codigo_produto AND ip.account = ANY(v_accounts)
        WHERE tf.id = v_formula AND tf.account = v_empresa AND ip.cmc > 0 AND ip.cmc <> 'NaN'::numeric
        ORDER BY ip.synced_at DESC NULLS LAST LIMIT 1;
        SELECT count(*),
          count(*) FILTER (WHERE ipc.cmc IS NULL OR ipc.cmc <= 0 OR ipc.cmc = 'NaN'::numeric
               OR c.volume_total_ml IS NULL OR c.volume_total_ml <= 0 OR fi.qtd_ml IS NULL OR fi.qtd_ml <= 0 OR fi.qtd_ml = 'NaN'::numeric),
          COALESCE(SUM(fi.qtd_ml * ipc.cmc / NULLIF(c.volume_total_ml,0)), 0), min(ipc.synced_at)
        INTO v_n_itens, v_cor_faltando, v_cor_total, v_cor_min_synced
        FROM tint_formula_itens fi JOIN tint_corantes c ON c.id = fi.corante_id
        LEFT JOIN omie_products opc ON opc.id = c.omie_product_id
        LEFT JOIN LATERAL (SELECT ip.cmc, ip.synced_at FROM inventory_position ip
          WHERE ip.omie_codigo_produto = opc.omie_codigo_produto AND ip.cmc > 0 AND ip.cmc <> 'NaN'::numeric AND ip.account = ANY(v_accounts)
          ORDER BY ip.synced_at DESC NULLS LAST LIMIT 1) ipc ON true
        WHERE fi.formula_id = v_formula;
        IF v_base_cmc IS NULL OR v_base_cmc <= 0 OR v_base_cmc = 'NaN'::numeric OR v_n_itens = 0 OR v_cor_faltando > 0 THEN
          v_cmc := NULL; v_prov := 'tint(custo incompleto)'; v_fresc := NULL;
        ELSE v_cmc := v_base_cmc + v_cor_total; v_prov := 'tint(CMC base+corantes)'; v_fresc := LEAST(v_base_synced, v_cor_min_synced); END IF;
      END;
    ELSE
      SELECT ip.cmc, 'inventory_position('||ip.account||')', ip.synced_at INTO v_cmc, v_prov, v_fresc
      FROM inventory_position ip
      WHERE ip.omie_codigo_produto = v_codigo AND ip.cmc > 0 AND ip.cmc <> 'NaN'::numeric AND ip.account = ANY(v_accounts)
      ORDER BY ip.synced_at DESC NULLS LAST LIMIT 1;
    END IF;
    v_cmc_ok := v_cmc IS NOT NULL AND v_cmc > 0 AND v_cmc <> 'NaN'::numeric;
    SELECT op.familia INTO v_familia FROM omie_products op WHERE op.omie_codigo_produto = v_codigo AND op.account = v_empresa LIMIT 1;
    IF v_customer IS NOT NULL THEN
      SELECT ctp.tier INTO v_tier FROM cliente_tier_preco ctp WHERE ctp.company = v_empresa AND ctp.customer_user_id = v_customer;
    END IF;
    SELECT rp.piso_markup, rp.meta_markup INTO v_piso, v_meta FROM resolve_markup_policy(v_empresa, v_codigo, v_familia, v_tier) rp;
    v_tem_pol := v_piso IS NOT NULL AND v_meta IS NOT NULL AND v_piso <> 'NaN'::numeric AND v_meta <> 'NaN'::numeric;
    IF NOT v_cmc_ok OR NOT v_preco_ok THEN v_faixa := 'neutro'; v_motivo := 'sem_custo';
    ELSIF v_preco < v_cmc THEN v_faixa := 'vermelho'; v_motivo := 'abaixo_do_custo';
    ELSIF NOT v_tem_pol THEN v_faixa := 'neutro'; v_motivo := 'sem_politica';
    ELSIF v_preco < v_cmc * (1 + v_piso/100) THEN v_faixa := 'amarelo'; v_motivo := 'abaixo_do_piso';
    ELSIF v_preco < v_cmc * (1 + v_meta/100) THEN v_faixa := 'verde'; v_motivo := 'abaixo_da_meta';
    ELSE v_faixa := 'verde'; v_motivo := 'saudavel'; END IF;
    IF v_cmc_ok AND v_preco_ok THEN v_markup := (v_preco - v_cmc) / v_cmc * 100; v_folga := v_preco - v_cmc;
    ELSE v_markup := NULL; v_folga := NULL; END IF;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'codigo', v_codigo, 'empresa', v_empresa, 'faixa', v_faixa, 'motivo', v_motivo,
      'tem_custo', v_cmc_ok, 'tem_politica', v_tem_pol, 'tier', to_jsonb(v_tier), 'calculated_at', now(),
      'cmc', CASE WHEN v_pode_num THEN to_jsonb(v_cmc) ELSE 'null'::jsonb END,
      'markup_perc', CASE WHEN v_pode_num THEN to_jsonb(v_markup) ELSE 'null'::jsonb END,
      'folga_reais', CASE WHEN v_pode_num THEN to_jsonb(v_folga) ELSE 'null'::jsonb END,
      'piso_markup', CASE WHEN v_pode_num THEN to_jsonb(v_piso) ELSE 'null'::jsonb END,
      'meta_markup', CASE WHEN v_pode_num THEN to_jsonb(v_meta) ELSE 'null'::jsonb END,
      'proveniencia', CASE WHEN v_pode_num THEN to_jsonb(v_prov) ELSE 'null'::jsonb END,
      'frescor', CASE WHEN v_pode_num THEN to_jsonb(v_fresc) ELSE 'null'::jsonb END));
  END LOOP;
  RETURN v_out;
END; $function$;

-- ── farmer_recomendacoes_substituir — guard de escopo FG009 + FOR SHARE ─────────────────────────────────────────
-- Corpo VERBATIM da PROD (pg_get_functiondef, 2026-08-30). Não reescrever à mão.
CREATE OR REPLACE FUNCTION public.farmer_recomendacoes_substituir(p_farmer_id uuid, p_run_id uuid, p_geracao_vista uuid, p_linhas jsonb, p_completude text DEFAULT NULL::text, p_motivo text DEFAULT NULL::text, p_insumos jsonb DEFAULT NULL::jsonb, p_head_visto uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total          integer;
  v_invalidas      integer;
  v_fora_escopo        integer;
  v_geracao_atual  uuid;
  v_expiradas      integer;
  v_inseridas      integer;
  v_head_atual     uuid;
BEGIN
  -- 1) Gate de MENSAGEM (a RLS é quem autoriza — ver cabeçalho).
  IF p_farmer_id IS NULL OR p_run_id IS NULL THEN
    RAISE EXCEPTION 'p_farmer_id e p_run_id são obrigatórios' USING ERRCODE = 'FG001';
  END IF;
  -- ⚠️ `IS NOT TRUE`, não `NOT (...)`. Numa sessão SEM JWT (pg_cron, psql) `auth.uid()`
  -- devolve NULL, então `p_farmer_id = auth.uid()` é NULL e a disjunção inteira vira
  -- NULL — e `IF NOT NULL THEN` NÃO dispara em PL/pgSQL. Medido em prod:
  --   NOT (false OR NULL OR false)          => NULL   (o RAISE nunca acontece)
  --   (false OR NULL OR false) IS NOT TRUE  => true   (barra, como se quer)
  IF (
    coalesce(auth.role(), '') = 'service_role'
    OR p_farmer_id = auth.uid()
    OR coalesce(private.cap_carteira_escrever(auth.uid()), false)
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Acesso negado: só o próprio farmer ou quem tem cap_carteira_escrever substitui recomendações'
      USING ERRCODE = '42501';
  END IF;

  -- 2) FORMATO.
  IF p_linhas IS NULL OR jsonb_typeof(p_linhas) <> 'array' THEN
    RAISE EXCEPTION 'p_linhas deve ser um array jsonb (recebido: %)',
      coalesce(jsonb_typeof(p_linhas), 'null') USING ERRCODE = 'FG002';
  END IF;

  v_total := jsonb_array_length(p_linhas);

  -- 3) LOTE VAZIO = RECUSA, não "expira tudo e deixa o farmer sem oferta".
  -- Zero recomendação quase sempre é dado faltando a montante (catálogo, scores,
  -- get_skus_margem_positiva), não "este farmer não tem o que oferecer" — mesmo
  -- raciocínio que farmer_association_rules_substituir aplica ao lote vazio.
  -- ⚠️ Isto SEGUE valendo depois do head: quem tem geração legitimamente vazia
  -- chama `farmer_geracao_registrar` (que move o head e não toca em linha nenhuma),
  -- e não esta função. Afrouxar aqui religaria a expiração — que está FORA do escopo
  -- desta fase por decisão explícita.
  IF v_total = 0 THEN
    RAISE EXCEPTION 'lote vazio: as % recomendação(ões) pendentes deste farmer foram preservadas',
      (SELECT count(*) FROM public.farmer_recommendations
        WHERE farmer_id = p_farmer_id AND status = 'pendente')
      USING ERRCODE = 'FG003';
  END IF;

  -- Teto defensivo: a maior geração medida em prod tem ~1.000 linhas
  -- (3 cross + 2 up por cliente). 50k é ~50x isso — folga sem ficar ilimitado.
  IF v_total > 50000 THEN
    RAISE EXCEPTION 'lote de % linhas excede o teto de 50000', v_total USING ERRCODE = 'FG004';
  END IF;

  -- 4) SERIALIZAÇÃO por FARMER (não global: duas vendedoras recalculando ao mesmo
  -- tempo mexem em escopos disjuntos e não têm por que esperar uma pela outra).
  -- `xact` = o lock sai sozinho no commit/rollback.
  IF NOT pg_try_advisory_xact_lock(
        hashtext('farmer_recomendacoes_substituir'), hashtext(p_farmer_id::text)) THEN
    RAISE EXCEPTION 'outro recálculo deste farmer está em andamento — nada foi alterado'
      USING ERRCODE = 'FG005';
  END IF;

  -- 5) GUARD CAUSAL (compare-and-swap).
  -- O advisory lock acima só cobre a TRANSAÇÃO da RPC — ele não cobre a janela
  -- longa entre "o motor leu o snapshot" e "o motor chamou esta função". Sem este
  -- guard, dois recálculos sobrepostos terminam com o MAIS LENTO vencendo, e o
  -- mais lento é justamente o que leu o snapshot mais VELHO (money-path §10: o
  -- degradado terminar depois do saudável é o desfecho esperado, não o azar).
  -- NULL casa NULL: primeira execução, e as linhas legadas (run_id NULL).
  SELECT run_id INTO v_geracao_atual
  FROM public.farmer_recommendations
  WHERE farmer_id = p_farmer_id AND status = 'pendente'
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  IF v_geracao_atual IS DISTINCT FROM p_geracao_vista THEN
    RAISE EXCEPTION 'geração vigente mudou durante o cálculo (vista: %, atual: %) — nada foi alterado',
      coalesce(p_geracao_vista::text, 'nenhuma'), coalesce(v_geracao_atual::text, 'nenhuma')
      USING ERRCODE = 'FG006';
  END IF;

  -- 6) VALIDAÇÃO ANTES DE MEXER (nada é expirado se o lote tem lixo).
  SELECT count(*) INTO v_invalidas
  FROM jsonb_to_recordset(p_linhas) AS r(
    customer_user_id        uuid,
    recommendation_type     text,
    product_id              uuid,
    affinity_score          numeric
  )
  WHERE r.customer_user_id IS NULL
     OR r.product_id IS NULL
     OR r.recommendation_type IS NULL
     OR r.recommendation_type NOT IN ('cross_sell', 'up_sell')
     -- Finitude nos TRÊS lados. `>= 0` sozinho NÃO sanea: medido em prod,
     -- `'NaN' >= 0` é TRUE e `'Infinity' >= 0` é TRUE (money-path §2).
     OR r.affinity_score IS NULL
     OR NOT (
          r.affinity_score >= 0
          AND r.affinity_score < 'Infinity'::numeric
          AND r.affinity_score <> 'NaN'::numeric
        );

  IF v_invalidas > 0 THEN
    RAISE EXCEPTION '% de % linha(s) inválidas (cliente/produto/tipo ausente, ou afinidade nula/negativa/NaN/Infinita) — nada foi expirado',
      v_invalidas, v_total USING ERRCODE = 'FG007';
  END IF;
  -- 6-bis) ESCOPO DE CARTEIRA — o cliente do lote precisa ser DESTE farmer.
  --
  -- `farmer_client_scores` tem UNIQUE (customer_user_id): o dono de um cliente é uma
  -- FUNÇÃO, computável aqui dentro. Até esta versão a RPC aceitava qualquer cliente e
  -- carimbava `p_farmer_id` por cima — foi por essa porta que o fallback do browser
  -- ("carteira vazia ⇒ carregue TODOS os scores") gravou 2.676 linhas com `farmer_id` ≠
  -- dono do cliente. Medido em prod (psql-ro, 21/08/2026): o lote de abril sob o farmer
  -- 33f59dc7 cobria 166 clientes e só 25,9% eram dele, contra os 18,8% da base que ele
  -- detém — a assinatura de quem sorteou da base inteira, não de quem leu a própria carteira.
  --
  -- O gate tinha que ser AQUI, não só no browser: o cliente não pode ser a autoridade
  -- sobre o próprio escopo (#1840 — o browser reescrevia as regras do servidor por cima).
  --
  -- E o dano SOBREVIVE ao conserto do browser porque a etapa 7 expira
  -- `WHERE farmer_id = p_farmer_id`: a linha do cliente C gravada sob A, quando o dono é B,
  -- é INVISÍVEL ao recálculo de B — o dono real recalcula e ela segue pendente, dando ao
  -- mesmo cliente duas gerações vivas ao mesmo tempo.
  --
  -- `IS DISTINCT FROM`, não `<>`: o cliente SEM linha de score precisa cair do MESMO lado.
  -- `<>` com NULL devolve NULL, o `WHERE` descarta, e o cliente de dono desconhecido passaria
  -- — exatamente o caso mais suspeito. Dono desconhecido é recusa, nunca "grave assim mesmo".
  --
  -- Isto é FAIL-CLOSED sob a RLS: a função é SECURITY INVOKER e `farmer_client_scores` só
  -- se deixa ler por `cap_carteira_ler(uid) OR carteira_visivel_para(cliente, uid)`. Se a RLS
  -- esconder do chamador a linha de um cliente alheio, o LEFT JOIN devolve NULL — e NULL é
  -- recusado. A cegueira da RLS vira RECUSA, não passagem.
  -- 6-ter) LOCK CAUSAL DO ESCOPO — a metade que a trigger de troca de dono NÃO cobre.
  -- O guard do #1850 compara o lote com o dono LIDO aqui; a trigger nova
  -- (private.farmer_expirar_pendentes_do_dono_anterior) expira o que já existia quando o
  -- dono muda. Nenhum dos dois cobre a janela ENTRE eles:
  --
  --   T1 (esta RPC, farmer A)          T2 (reatribuição do cliente C para B)
  --   ------------------------         -------------------------------------
  --   FG009 lê score de C = A
  --                                    UPDATE farmer_client_scores: C -> B
  --                                    trigger expira as pendentes de C que existiam
  --   INSERT da oferta C sob A         (a linha NOVA nasce depois da varredura)
  --   COMMIT                           COMMIT
  --
  -- A oferta nova sobrevive fora de escopo. O advisory lock do passo 4 não ajuda: ele é
  -- por FARMER, e quem reatribui não o toma. Travar as linhas de score do lote até o
  -- COMMIT resolve nos dois sentidos — se a troca chega antes, ela espera e a trigger
  -- alcança a linha nova; se chega depois, esta RPC já lê o dono novo e o FG009 recusa.
  --
  -- `FOR SHARE`, não `FOR KEY SHARE`: um UPDATE que não mexe em chave toma
  -- `FOR NO KEY UPDATE`, que NÃO conflita com `FOR KEY SHARE` — o lock mais fraco
  -- deixaria a corrida exatamente como estava, e o teste do caminho feliz seguiria verde.
  -- `FOR SHARE` conflita, e é compartilhado: duas vendedoras com lotes disjuntos não se
  -- esperam (só quem tenta REATRIBUIR espera).
  --
  -- O `ORDER BY` é best-effort contra deadlock (o PG não garante ordem de travamento sob
  -- ORDER BY). A garantia real é a ordem de RECURSOS, que esta fatia mantém única em todo
  -- o domínio: farmer_client_scores -> farmer_recommendations. A trigger segue a mesma
  -- ordem (é disparada POR um UPDATE em scores e só então toca recomendações), então não
  -- há ciclo a inverter.
  --
  -- Cliente do lote SEM linha de score não trava nada — não há linha. Não é buraco: o
  -- FG009 logo abaixo recusa o lote inteiro nesse caso (dono desconhecido é recusa).
  PERFORM 1
    FROM public.farmer_client_scores s
   WHERE s.customer_user_id IN (
           SELECT DISTINCT c.customer_user_id
             FROM jsonb_to_recordset(p_linhas) AS c(customer_user_id uuid)
            WHERE c.customer_user_id IS NOT NULL
         )
   ORDER BY s.customer_user_id
     FOR SHARE;

  SELECT count(*) INTO v_fora_escopo
  FROM jsonb_to_recordset(p_linhas) AS r(customer_user_id uuid)
  LEFT JOIN public.farmer_client_scores s ON s.customer_user_id = r.customer_user_id
  WHERE s.farmer_id IS DISTINCT FROM p_farmer_id;

  -- FG009, não FG008: o 008 JÁ É de outra defesa deste mesmo domínio — a trigger que barra
  -- INSERT direto de pendente sem `run_id` (migration 20260814223445). Reusar o código
  -- tornaria dois erros distintos indistinguíveis pela SQLSTATE, que é justamente o que um
  -- chamador usa para decidir o que fazer. Verificado em prod: FG001–FG008 e FG101–FG107
  -- ocupados; 009 livre.
  IF v_fora_escopo > 0 THEN
    RAISE EXCEPTION '% de % linha(s) são de cliente fora da carteira deste farmer — nada foi expirado',
      v_fora_escopo, v_total USING ERRCODE = 'FG009';
  END IF;

  -- 7) A TROCA — os dois statements na MESMA transação.
  -- Só 'pendente' é tocado: linha com desfecho ('ofertado'/'aceito'/'rejeitado')
  -- é histórico e fica imutável. E é UPDATE, nunca DELETE.
  UPDATE public.farmer_recommendations
     SET status         = 'expirado',
         expired_at     = clock_timestamp(),
         expired_by_run = p_run_id,
         updated_at     = clock_timestamp()
   WHERE farmer_id = p_farmer_id
     AND status = 'pendente';
  GET DIAGNOSTICS v_expiradas = ROW_COUNT;

  INSERT INTO public.farmer_recommendations (
    farmer_id, customer_user_id, recommendation_type, product_id, current_product_id,
    p_ij, m_ij, lie, affinity_score, complexity_factor, cluster_volume_estimate,
    status, run_id
  )
  SELECT
    p_farmer_id, r.customer_user_id, r.recommendation_type, r.product_id, r.current_product_id,
    r.p_ij,
    -- m_ij e lie são DINHEIRO e saíram de cena no #1520 (o custo não chega mais ao
    -- browser). Fixados em NULL aqui, não copiados do payload: o cliente não tem
    -- como fabricá-los de volta.
    NULL, NULL,
    r.affinity_score, coalesce(r.complexity_factor, 1), coalesce(r.cluster_volume_estimate, 1),
    'pendente', p_run_id
  FROM jsonb_to_recordset(p_linhas) AS r(
    customer_user_id        uuid,
    recommendation_type     text,
    product_id              uuid,
    current_product_id      uuid,
    p_ij                    numeric,
    affinity_score          numeric,
    complexity_factor       numeric,
    cluster_volume_estimate numeric
  );
  GET DIAGNOSTICS v_inseridas = ROW_COUNT;

  -- 8) O HEAD, na MESMA transação — com o head que o CHAMADOR viu ANTES do cálculo.
  --
  -- ⚠️ A 1ª versão lia o head AQUI DENTRO e o passava adiante, o que satisfazia o CAS por
  -- construção e abria a assimetria que o challenge Codex xhigh encontrou: um run VAZIO
  -- que commita entre a leitura e a escrita de um run COM LINHAS não é visto pelo CAS da
  -- etapa 5 (ele compara LINHAS, e o vazio não mexeu em linha nenhuma), então o run antigo
  -- sobrescrevia um vazio mais novo. O sistema misturava duas ordens: frescor causal para
  -- o vazio e ordem-de-commit para as linhas. Comparar o head ORIGINAL alinha as duas.
  --
  -- `p_completude IS NULL` é o marcador de chamador ANTERIOR ao sensor (assinatura de 4
  -- args, bundle velho em cache): ele não tem head para declarar, então cai no head
  -- corrente em vez de ser recusado por não saber de algo que não existia quando foi
  -- escrito. Os dois sinais de "cliente antigo" são o mesmo, de propósito.
  IF p_completude IS NULL THEN
    SELECT run_id INTO v_head_atual
    FROM public.farmer_geracao_vigente
    WHERE motor = 'cross_sell' AND farmer_id = p_farmer_id;
  ELSE
    v_head_atual := p_head_visto;
  END IF;

  PERFORM public.farmer_geracao_registrar(
    'cross_sell', p_farmer_id, p_run_id, 'linhas', v_inseridas,
    p_completude, p_motivo, p_insumos, v_head_atual
  );

  RETURN jsonb_build_object(
    'run_id',    p_run_id,
    'expiradas', v_expiradas,
    'inseridas', v_inseridas
  );
END;
$function$;

-- ── farmer_bundle_recomendacoes_substituir — idem ─────────────────────────────────────────
-- Corpo VERBATIM da PROD (pg_get_functiondef, 2026-08-30). Não reescrever à mão.
CREATE OR REPLACE FUNCTION public.farmer_bundle_recomendacoes_substituir(p_farmer_id uuid, p_run_id uuid, p_geracao_vista uuid, p_linhas jsonb, p_completude text DEFAULT NULL::text, p_motivo text DEFAULT NULL::text, p_insumos jsonb DEFAULT NULL::jsonb, p_head_visto uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total         integer;
  v_invalidas     integer;
  v_fora_escopo       integer;
  v_geracao_atual uuid;
  v_expiradas     integer;
  v_inseridas     integer;
  v_head_atual    uuid;
BEGIN
  IF p_farmer_id IS NULL OR p_run_id IS NULL THEN
    RAISE EXCEPTION 'p_farmer_id e p_run_id são obrigatórios' USING ERRCODE = 'FG001';
  END IF;
  IF (
    coalesce(auth.role(), '') = 'service_role'
    OR p_farmer_id = auth.uid()
    OR coalesce(private.cap_carteira_escrever(auth.uid()), false)
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Acesso negado: só o próprio farmer ou quem tem cap_carteira_escrever substitui recomendações'
      USING ERRCODE = '42501';
  END IF;

  IF p_linhas IS NULL OR jsonb_typeof(p_linhas) <> 'array' THEN
    RAISE EXCEPTION 'p_linhas deve ser um array jsonb (recebido: %)',
      coalesce(jsonb_typeof(p_linhas), 'null') USING ERRCODE = 'FG002';
  END IF;

  v_total := jsonb_array_length(p_linhas);

  IF v_total = 0 THEN
    RAISE EXCEPTION 'lote vazio: os % bundle(s) pendentes deste farmer foram preservados',
      (SELECT count(*) FROM public.farmer_bundle_recommendations
        WHERE farmer_id = p_farmer_id AND status = 'pendente')
      USING ERRCODE = 'FG003';
  END IF;

  IF v_total > 50000 THEN
    RAISE EXCEPTION 'lote de % linhas excede o teto de 50000', v_total USING ERRCODE = 'FG004';
  END IF;

  IF NOT pg_try_advisory_xact_lock(
        hashtext('farmer_bundle_recomendacoes_substituir'), hashtext(p_farmer_id::text)) THEN
    RAISE EXCEPTION 'outro recálculo de bundles deste farmer está em andamento — nada foi alterado'
      USING ERRCODE = 'FG005';
  END IF;

  SELECT run_id INTO v_geracao_atual
  FROM public.farmer_bundle_recommendations
  WHERE farmer_id = p_farmer_id AND status = 'pendente'
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  IF v_geracao_atual IS DISTINCT FROM p_geracao_vista THEN
    RAISE EXCEPTION 'geração vigente de bundles mudou durante o cálculo (vista: %, atual: %) — nada foi alterado',
      coalesce(p_geracao_vista::text, 'nenhuma'), coalesce(v_geracao_atual::text, 'nenhuma')
      USING ERRCODE = 'FG006';
  END IF;

  SELECT count(*) INTO v_invalidas
  FROM jsonb_to_recordset(p_linhas) AS r(
    customer_user_id uuid,
    bundle_products  jsonb,
    affinity_bundle  numeric
  )
  WHERE r.customer_user_id IS NULL
     OR r.bundle_products IS NULL
     OR jsonb_typeof(r.bundle_products) <> 'array'
     OR jsonb_array_length(r.bundle_products) = 0
     OR r.affinity_bundle IS NULL
     OR NOT (
          r.affinity_bundle >= 0
          AND r.affinity_bundle < 'Infinity'::numeric
          AND r.affinity_bundle <> 'NaN'::numeric
        );

  IF v_invalidas > 0 THEN
    RAISE EXCEPTION '% de % bundle(s) inválidos (cliente/produtos ausentes, ou afinidade nula/negativa/NaN/Infinita) — nada foi expirado',
      v_invalidas, v_total USING ERRCODE = 'FG007';
  END IF;
  -- 6-bis) ESCOPO DE CARTEIRA — o cliente do lote precisa ser DESTE farmer.
  --
  -- `farmer_client_scores` tem UNIQUE (customer_user_id): o dono de um cliente é uma
  -- FUNÇÃO, computável aqui dentro. Até esta versão a RPC aceitava qualquer cliente e
  -- carimbava `p_farmer_id` por cima — foi por essa porta que o fallback do browser
  -- ("carteira vazia ⇒ carregue TODOS os scores") gravou 2.676 linhas com `farmer_id` ≠
  -- dono do cliente. Medido em prod (psql-ro, 21/08/2026): o lote de abril sob o farmer
  -- 33f59dc7 cobria 166 clientes e só 25,9% eram dele, contra os 18,8% da base que ele
  -- detém — a assinatura de quem sorteou da base inteira, não de quem leu a própria carteira.
  --
  -- O gate tinha que ser AQUI, não só no browser: o cliente não pode ser a autoridade
  -- sobre o próprio escopo (#1840 — o browser reescrevia as regras do servidor por cima).
  --
  -- E o dano SOBREVIVE ao conserto do browser porque a etapa 7 expira
  -- `WHERE farmer_id = p_farmer_id`: a linha do cliente C gravada sob A, quando o dono é B,
  -- é INVISÍVEL ao recálculo de B — o dono real recalcula e ela segue pendente, dando ao
  -- mesmo cliente duas gerações vivas ao mesmo tempo.
  --
  -- `IS DISTINCT FROM`, não `<>`: o cliente SEM linha de score precisa cair do MESMO lado.
  -- `<>` com NULL devolve NULL, o `WHERE` descarta, e o cliente de dono desconhecido passaria
  -- — exatamente o caso mais suspeito. Dono desconhecido é recusa, nunca "grave assim mesmo".
  --
  -- Isto é FAIL-CLOSED sob a RLS: a função é SECURITY INVOKER e `farmer_client_scores` só
  -- se deixa ler por `cap_carteira_ler(uid) OR carteira_visivel_para(cliente, uid)`. Se a RLS
  -- esconder do chamador a linha de um cliente alheio, o LEFT JOIN devolve NULL — e NULL é
  -- recusado. A cegueira da RLS vira RECUSA, não passagem.
  -- 6-ter) LOCK CAUSAL DO ESCOPO — a metade que a trigger de troca de dono NÃO cobre.
  -- O guard do #1850 compara o lote com o dono LIDO aqui; a trigger nova
  -- (private.farmer_expirar_pendentes_do_dono_anterior) expira o que já existia quando o
  -- dono muda. Nenhum dos dois cobre a janela ENTRE eles:
  --
  --   T1 (esta RPC, farmer A)          T2 (reatribuição do cliente C para B)
  --   ------------------------         -------------------------------------
  --   FG009 lê score de C = A
  --                                    UPDATE farmer_client_scores: C -> B
  --                                    trigger expira as pendentes de C que existiam
  --   INSERT da oferta C sob A         (a linha NOVA nasce depois da varredura)
  --   COMMIT                           COMMIT
  --
  -- A oferta nova sobrevive fora de escopo. O advisory lock do passo 4 não ajuda: ele é
  -- por FARMER, e quem reatribui não o toma. Travar as linhas de score do lote até o
  -- COMMIT resolve nos dois sentidos — se a troca chega antes, ela espera e a trigger
  -- alcança a linha nova; se chega depois, esta RPC já lê o dono novo e o FG009 recusa.
  --
  -- `FOR SHARE`, não `FOR KEY SHARE`: um UPDATE que não mexe em chave toma
  -- `FOR NO KEY UPDATE`, que NÃO conflita com `FOR KEY SHARE` — o lock mais fraco
  -- deixaria a corrida exatamente como estava, e o teste do caminho feliz seguiria verde.
  -- `FOR SHARE` conflita, e é compartilhado: duas vendedoras com lotes disjuntos não se
  -- esperam (só quem tenta REATRIBUIR espera).
  --
  -- O `ORDER BY` é best-effort contra deadlock (o PG não garante ordem de travamento sob
  -- ORDER BY). A garantia real é a ordem de RECURSOS, que esta fatia mantém única em todo
  -- o domínio: farmer_client_scores -> farmer_recommendations. A trigger segue a mesma
  -- ordem (é disparada POR um UPDATE em scores e só então toca recomendações), então não
  -- há ciclo a inverter.
  --
  -- Cliente do lote SEM linha de score não trava nada — não há linha. Não é buraco: o
  -- FG009 logo abaixo recusa o lote inteiro nesse caso (dono desconhecido é recusa).
  PERFORM 1
    FROM public.farmer_client_scores s
   WHERE s.customer_user_id IN (
           SELECT DISTINCT c.customer_user_id
             FROM jsonb_to_recordset(p_linhas) AS c(customer_user_id uuid)
            WHERE c.customer_user_id IS NOT NULL
         )
   ORDER BY s.customer_user_id
     FOR SHARE;

  SELECT count(*) INTO v_fora_escopo
  FROM jsonb_to_recordset(p_linhas) AS r(customer_user_id uuid)
  LEFT JOIN public.farmer_client_scores s ON s.customer_user_id = r.customer_user_id
  WHERE s.farmer_id IS DISTINCT FROM p_farmer_id;

  IF v_fora_escopo > 0 THEN
    RAISE EXCEPTION '% de % linha(s) são de cliente fora da carteira deste farmer — nada foi expirado',
      v_fora_escopo, v_total USING ERRCODE = 'FG009';
  END IF;

  UPDATE public.farmer_bundle_recommendations
     SET status         = 'expirado',
         expired_at     = clock_timestamp(),
         expired_by_run = p_run_id,
         updated_at     = clock_timestamp()
   WHERE farmer_id = p_farmer_id
     AND status = 'pendente';
  GET DIAGNOSTICS v_expiradas = ROW_COUNT;

  INSERT INTO public.farmer_bundle_recommendations (
    farmer_id, customer_user_id, bundle_products, support, confidence, lift,
    p_bundle, m_bundle, lie_bundle, affinity_bundle, complexity_factor,
    status, run_id
  )
  SELECT
    p_farmer_id, r.customer_user_id, r.bundle_products,
    r.support, r.confidence, r.lift, r.p_bundle,
    -- m_bundle/lie_bundle: dinheiro, fora de cena desde o #1520 (ver RPC irmã).
    NULL, NULL,
    r.affinity_bundle, coalesce(r.complexity_factor, 1),
    'pendente', p_run_id
  FROM jsonb_to_recordset(p_linhas) AS r(
    customer_user_id  uuid,
    bundle_products   jsonb,
    support           numeric,
    confidence        numeric,
    lift              numeric,
    p_bundle          numeric,
    affinity_bundle   numeric,
    complexity_factor numeric
  );
  GET DIAGNOSTICS v_inseridas = ROW_COUNT;

  -- O HEAD, na MESMA transação, com o head ORIGINAL do chamador (ver RPC irmã para o
  -- racional da assimetria que isto fecha).
  IF p_completude IS NULL THEN
    SELECT run_id INTO v_head_atual
    FROM public.farmer_geracao_vigente
    WHERE motor = 'bundle' AND farmer_id = p_farmer_id;
  ELSE
    v_head_atual := p_head_visto;
  END IF;

  PERFORM public.farmer_geracao_registrar(
    'bundle', p_farmer_id, p_run_id, 'linhas', v_inseridas,
    p_completude, p_motivo, p_insumos, v_head_atual
  );

  RETURN jsonb_build_object(
    'run_id',    p_run_id,
    'expiradas', v_expiradas,
    'inseridas', v_inseridas
  );
END;
$function$;

-- ── Grants: reafirmação idempotente, NOMEANDO as roles ───────────────────────
-- `CREATE OR REPLACE` preserva a ACL — nada acima a reseta (não há DROP). Isto
-- espelha a ACL viva medida em prod: authenticated + service_role, sem anon e sem
-- PUBLIC. `REVOKE … FROM PUBLIC` não alcança anon/authenticated (grant explícito),
-- por isso `anon` aparece nomeado. Nas 3 de preço o gate é de PROJEÇÃO, não de
-- execução: o customer PRECISA executar para ver `precoFinal` no balcão — revogar
-- `authenticated` quebraria a venda.
REVOKE ALL ON FUNCTION public.get_tint_price(uuid)                FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tint_price(uuid)             TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_tint_prices(uuid[])             FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tint_prices(uuid[])          TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_preco_cockpit(jsonb)            FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_preco_cockpit(jsonb)         TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.farmer_recomendacoes_substituir(uuid, uuid, uuid, jsonb, text, text, jsonb, uuid)        FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farmer_recomendacoes_substituir(uuid, uuid, uuid, jsonb, text, text, jsonb, uuid)     TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.farmer_bundle_recomendacoes_substituir(uuid, uuid, uuid, jsonb, text, text, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farmer_bundle_recomendacoes_substituir(uuid, uuid, uuid, jsonb, text, text, jsonb, uuid) TO authenticated, service_role;
