-- 20260906164001_captura_authz_gate_custo_rpcs_preco.sql
-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  CAPTURA (não mudança) — o corpo VIVO em prod de get_tint_price,             ║
-- ║  get_tint_prices e get_preco_cockpit, cujo gate de CUSTO o repo descreve na  ║
-- ║  versão FROUXA. Enquanto esta migration não existir, todo `CREATE OR         ║
-- ║  REPLACE` futuro partindo do repo REVERTE o hardening em silêncio: o CI não  ║
-- ║  alcança o banco e o repo é internamente consistente, então nada fica        ║
-- ║  vermelho. O repo é a bomba de regressão; o banco está certo.                ║
-- ║                                                                              ║
-- ║  Origem: docs/historico/deriva-de-corpo-prod-a-frente-do-repo.md (pendência  ║
-- ║  nº 1). Das 24 derivas triadas, 8 divergiam de fato e em TODAS o vivo era o  ║
-- ║  mais novo — em 5 o que só existia vivo era authz. Estas são 3 das 5; as 2   ║
-- ║  de farmer vão na migration IRMÃ 20260906164002 (domínios e dependências     ║
-- ║  disjuntos: separadas, cada uma aplica e se prova sozinha).                  ║
-- ║                                                                              ║
-- ║  ── O QUE O REPO DIZIA (e que esta migration para de dizer) ──────────────── ║
-- ║  get_tint_price / get_tint_prices  (20260708234100_tint_gate_custo_staff)    ║
-- ║    repo: auth.uid() IS NOT NULL AND (has_role employee OR has_role master)   ║
-- ║    vivo: private.cap_custo_ler(auth.uid())                                   ║
-- ║  get_preco_cockpit                 (20260704120000_preco_por_tier)           ║
-- ║    repo: pode_ver_carteira_completa(auth.uid())   ← ainda inclui 'gerencial' ║
-- ║    vivo: private.cap_custo_ler(auth.uid())                                   ║
-- ║                                                                              ║
-- ║  `private.cap_custo_ler` = master OR (employee AND commercial_role IN        ║
-- ║  ('estrategico','super_admin')). É ESTRITAMENTE mais restrito que os dois    ║
-- ║  predicados do repo. É o gate que decide se `cmc` e `markup_perc` saem como  ║
-- ║  número ou como null — aplicar a versão do repo hoje EXPORIA custo e markup  ║
-- ║  a qualquer employee (e, no cockpit, também ao 'gerencial'). O gate nasceu   ║
-- ║  no FU4F (2026-07-18) e foi colado em prod sem virar migration para estas.   ║
-- ║                                                                              ║
-- ║  ⚠️ get_preco_cockpit tem DOIS gates independentes, e só o SEGUNDO muda:     ║
-- ║  o de EXECUÇÃO (`RAISE 'forbidden'` 42501 p/ não-staff) segue employee OR    ║
-- ║  master, VERBATIM como no repo — quem opera o cockpit continua entrando. O   ║
-- ║  que `cap_custo_ler` gateia é só a PROJEÇÃO numérica (cmc, markup_perc,      ║
-- ║  folga_reais, piso/meta_markup, proveniencia, frescor).                      ║
-- ║                                                                              ║
-- ║  ⚠️ CONTRADIÇÃO DELIBERADA que este arquivo cria no repo, e que é honesta:   ║
-- ║  db/test-tint-gate-custo-staff.sh assere `employee comum vê custoBase=200`   ║
-- ║  e segue VERDE — porque aplica explicitamente a migration de 2026-07-08. Ele ║
-- ║  descreve o que AQUELA migration fez, não o gate de hoje. O gate de hoje é   ║
-- ║  provado por db/test-captura-authz-gate-custo.sh, que aplica ESTE arquivo.   ║
-- ║                                                                              ║
-- ║  Medido antes de escrever (diff por TOKEN, com o stripper compartilhado      ║
-- ║  removerComentariosSql — nunca regex local): a ÚNICA divergência vivo×repo   ║
-- ║  nas três é o gate. Nenhuma outra: é captura, não mudança.                   ║
-- ║                                                                              ║
-- ║  ⚠️ APLICAR É NO-OP SEMÂNTICO EM PROD — recria cada função com o texto que   ║
-- ║  JÁ roda (pg_get_functiondef via psql-ro, 2026-08-30). Prova: o md5 do       ║
-- ║  functiondef pós-apply tem de ser IDÊNTICO ao de antes (query no rodapé).    ║
-- ║  Se algum md5 MUDAR, a captura não foi fiel — avise antes de seguir.         ║
-- ║                                                                              ║
-- ║  ACL: `CREATE OR REPLACE` PRESERVA a ACL (só `DROP`+`CREATE` a reseta) — e   ║
-- ║  aqui não há DROP nenhum, de propósito. Os grants do rodapé são reafirmação  ║
-- ║  idempotente NOMEANDO as roles, espelhando a ACL viva medida em prod.        ║
-- ║                                                                              ║
-- ║  ⚠️ MIGRATION MANUAL — Lovable não auto-aplica nome custom. SQL Editor → Run.║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

-- ── Guard de VALIDADE DA EVIDÊNCIA — fail-closed ─────────────────────────────
-- Evidência de banco tem prazo (database.md §2). Estes corpos foram lidos da PROD em
-- 2026-08-30 e reconferidos em 2026-09-06; o founder cola isto depois, e "a última a
-- recriar VENCE". Se alguém tiver colado uma versão MAIS NOVA no intervalo, aplicar
-- esta migration a sobrescreveria com a de setembro — reintroduzindo, em silêncio,
-- exatamente a deriva que ela existe para consertar.
-- Por isso: se o corpo vivo não for o que capturei, ABORTA e não recria nada.
-- É idempotente: re-colar depois de aplicada encontra o MESMO md5 (a captura é fiel),
-- então passa. Padrão herdado de 20260830214547 (pendência 2 da mesma triagem).
DO $validade$
DECLARE
  r record;
  v_md5 text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.get_tint_price(uuid)',     '88d019125c82d38b3ef404f90f5d8f49'),
      ('public.get_tint_prices(uuid[])',  '3493bbd6f41da68a7e05256df459d682'),
      ('public.get_preco_cockpit(jsonb)', '2f1af0f994b304660303bcc6ec987d36')
    ) AS t(assinatura, md5_capturado)
  LOOP
    -- to_regprocedure (não `::regprocedure`): devolve NULL quando a função não existe,
    -- em vez de lançar. Função ausente = criação nova, não sobrescrita — nada a proteger,
    -- e é o caso do PG17 descartável dos harnesses, que aplica a migration num banco limpo.
    IF to_regprocedure(r.assinatura) IS NULL THEN
      CONTINUE;
    END IF;
    SELECT md5(pg_get_functiondef(to_regprocedure(r.assinatura))) INTO v_md5;
    IF v_md5 IS DISTINCT FROM r.md5_capturado THEN
      RAISE EXCEPTION
        'ABORTADO: o corpo vivo de % não é o que esta migration capturou (vivo=%, capturado=%). Alguém recriou a função depois de 2026-09-06. NÃO aplique às cegas: releia o corpo vivo com pg_get_functiondef e refaça a captura, senão isto REVERTE o que está em produção.',
        r.assinatura, v_md5, r.md5_capturado
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
END
$validade$;

-- ── Guard de dependências — FAIL-CLOSED ──────────────────────────────────────
-- plpgsql/sql são late-bound: sem `private.cap_custo_ler` o CREATE PASSA e a função
-- só quebra em RUNTIME, no meio do money-path — e como get_tint_* é SECURITY DEFINER
-- chamada pelo balcão, o erro apareceria para o CLIENTE. Falhar aqui, no Run, é o
-- único lugar barato de descobrir. Idempotente.
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'private' AND p.proname = 'cap_custo_ler') THEN
    RAISE EXCEPTION 'dep ausente: private.cap_custo_ler — é O gate de custo destas 3 RPCs (prod divergiu?)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'has_role' AND pronamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'dep ausente: public.has_role — gate de EXECUÇÃO do cockpit';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'uid' AND pronamespace = 'auth'::regnamespace) THEN
    RAISE EXCEPTION 'dep ausente: auth.uid';
  END IF;
END
$guard$;

-- ── get_tint_price — gate de custo via private.cap_custo_ler ──
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

-- ── get_tint_prices — idem, dentro do CTE staff AS MATERIALIZED ──
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

-- ── get_preco_cockpit — execução (employee/master) + projeção (cap_custo_ler) ──
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

-- ── Grants: reafirmação idempotente, NOMEANDO as roles ───────────────────────
-- `REVOKE … FROM PUBLIC` não alcança anon/authenticated (grant explícito), por isso
-- `anon` aparece nomeado. O gate aqui é de PROJEÇÃO, não de execução: o customer
-- PRECISA executar get_tint_* para ver `precoFinal` no balcão — revogar
-- `authenticated` quebraria a venda.
REVOKE ALL ON FUNCTION public.get_tint_price(uuid)        FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tint_price(uuid)     TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_tint_prices(uuid[])     FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tint_prices(uuid[])  TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_preco_cockpit(jsonb)    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_preco_cockpit(jsonb) TO authenticated, service_role;

-- ── SENSOR DE APPLY — a única coisa aqui que NÃO é no-op, de propósito ───────
-- Problema real: como esta migration recria as funções com o corpo que JÁ roda,
-- NENHUMA query sobre o corpo distingue "aplicada" de "esqueci de colar" — ela é
-- verde nos dois casos. Isso é precisamente a falha silenciosa que o ritual de
-- migration manual existe para evitar (ausência de sinal não é aprovação).
-- COMMENT ON FUNCTION resolve: não entra em pg_get_functiondef (o md5 do corpo
-- segue idêntico — provado por assert no harness, não assumido), não muda
-- comportamento, é idempotente, e só passa a existir DEPOIS do Run. Vira o
-- carimbo que a validação lê para saber que o SQL rodou de verdade.
COMMENT ON FUNCTION public.get_tint_price(uuid) IS
  'Gate de custo = private.cap_custo_ler (master ou employee estrategico/super_admin). Corpo capturado do VIVO em prod pela migration 20260906164001 — captura-deriva-authz 2026-08-30. Ver docs/historico/deriva-de-corpo-prod-a-frente-do-repo.md.';
COMMENT ON FUNCTION public.get_tint_prices(uuid[]) IS
  'Gate de custo = private.cap_custo_ler, dentro do CTE staff AS MATERIALIZED. Corpo capturado do VIVO em prod pela migration 20260906164001 — captura-deriva-authz 2026-08-30.';
COMMENT ON FUNCTION public.get_preco_cockpit(jsonb) IS
  'DOIS gates: execucao (employee OR master -> 42501) e projecao numerica (private.cap_custo_ler). Corpo capturado do VIVO em prod pela migration 20260906164001 — captura-deriva-authz 2026-08-30.';

-- ── Validação pós-apply (read-only) — cole DEPOIS do Run ─────────────────────
-- Captura fiel ⇒ o md5 do functiondef NÃO pode mudar. Os esperados foram medidos na
-- PROD em 2026-08-30, ANTES desta migration existir.
--   SELECT p.proname,
--          md5(pg_get_functiondef(p.oid)) AS md5_atual,
--          CASE p.proname
--            WHEN 'get_tint_price'    THEN '88d019125c82d38b3ef404f90f5d8f49'
--            WHEN 'get_tint_prices'   THEN '3493bbd6f41da68a7e05256df459d682'
--            WHEN 'get_preco_cockpit' THEN '2f1af0f994b304660303bcc6ec987d36'
--          END AS md5_esperado,
--          CASE WHEN md5(pg_get_functiondef(p.oid)) = CASE p.proname
--            WHEN 'get_tint_price'    THEN '88d019125c82d38b3ef404f90f5d8f49'
--            WHEN 'get_tint_prices'   THEN '3493bbd6f41da68a7e05256df459d682'
--            WHEN 'get_preco_cockpit' THEN '2f1af0f994b304660303bcc6ec987d36'
--          END THEN '✅ captura fiel (no-op)' ELSE '❌ o corpo MUDOU — pare e avise' END AS status
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname IN ('get_tint_price','get_tint_prices','get_preco_cockpit');
