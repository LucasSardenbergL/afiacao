-- ============================================================
-- Preço por tier (precedência de preço) — item 5 do "back to basics"
-- Spec + veredito Codex: docs/superpowers/specs/preco-por-tier.md (v2.1 APROVADA)
--
-- Fase A (esta migration): política + visibilidade + medição. NÃO há enforcement
-- na fronteira (Fase B, futura, decidida pela medição A5). O tier NUNCA é inferido:
-- é decisão de gestor (pode_ver_carteira_completa), auditada.
--
-- Semântica travada no pré-flight (psql-ro, 2026-07-04):
--   • piso_markup/meta_markup são MARKUP % SOBRE O CUSTO (CMC): o cockpit acende
--     amarelo quando preco < cmc*(1+piso/100). Os pisos do founder (A=25/B=30/C=35)
--     entram nessa MESMA unidade.
--   • get_preco_cockpit(jsonb): 1 param jsonb → CREATE OR REPLACE puro (sem overload).
--   • resolve_markup_policy(text,bigint,text): SQL puro; ganha 4º arg p_tier e passa a
--     retornar GREATEST de DUAS cascatas (produto SEM tier × tier), NULL-safe.
--   • get_ultimos_precos_cliente(uuid): passa a expor a DATA do último praticado
--     (janela de 180d precisa dela; sales_price_history.created_at é lixo de carga).
--
-- Atômica (BEGIN/COMMIT): o DROP+CREATE de resolve_markup_policy roda ao lado do
-- CREATE OR REPLACE do seu único caller (get_preco_cockpit) — nunca pode existir uma
-- janela com a função dropada e o cockpit apontando pro vazio.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) cliente_tier_preco — o tier comercial A/B/C por (conta, cliente).
--    Definido por gestor; badge visível a staff; escrita gated + auditada.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cliente_tier_preco (
  company text NOT NULL CHECK (company IN ('oben', 'colacor')),
  customer_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tier text NOT NULL CHECK (tier IN ('A', 'B', 'C')),
  motivo text,
  definido_por uuid NOT NULL REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company, customer_user_id)
);

CREATE INDEX IF NOT EXISTS idx_cliente_tier_preco_customer
  ON public.cliente_tier_preco(customer_user_id);

-- Anti-forje (padrão Fase 2): autor e updated_at FORÇADOS no servidor. Sob
-- service_role auth.uid() é NULL → mantém o payload (nenhuma via automática escreve tier).
CREATE OR REPLACE FUNCTION public.cliente_tier_preco_forca_autor()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    NEW.definido_por := auth.uid();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cliente_tier_forca_autor ON public.cliente_tier_preco;
CREATE TRIGGER trg_cliente_tier_forca_autor
  BEFORE INSERT OR UPDATE ON public.cliente_tier_preco
  FOR EACH ROW EXECUTE FUNCTION public.cliente_tier_preco_forca_autor();

ALTER TABLE public.cliente_tier_preco ENABLE ROW LEVEL SECURITY;

-- Staff lê o badge (A/B/C não é segredo — orienta o vendedor).
DROP POLICY IF EXISTS "cliente_tier_preco_select_staff" ON public.cliente_tier_preco;
CREATE POLICY "cliente_tier_preco_select_staff"
  ON public.cliente_tier_preco FOR SELECT
  USING (
    has_role((SELECT auth.uid()), 'employee'::app_role)
    OR has_role((SELECT auth.uid()), 'master'::app_role)
  );

-- Só quem vê carteira completa define/edita o tier (mesmo gate da exceção de crédito).
DROP POLICY IF EXISTS "cliente_tier_preco_insert_gestor" ON public.cliente_tier_preco;
CREATE POLICY "cliente_tier_preco_insert_gestor"
  ON public.cliente_tier_preco FOR INSERT
  WITH CHECK ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));

DROP POLICY IF EXISTS "cliente_tier_preco_update_gestor" ON public.cliente_tier_preco;
CREATE POLICY "cliente_tier_preco_update_gestor"
  ON public.cliente_tier_preco FOR UPDATE
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))))
  WITH CHECK ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));

-- Remover tier é raro (o default é manter a linha) → master apenas.
DROP POLICY IF EXISTS "cliente_tier_preco_delete_master" ON public.cliente_tier_preco;
CREATE POLICY "cliente_tier_preco_delete_master"
  ON public.cliente_tier_preco FOR DELETE
  USING (has_role((SELECT auth.uid()), 'master'::app_role));

-- service_role bypass (nenhuma via automática escreve tier hoje, mas mantém o padrão).
DROP POLICY IF EXISTS "cliente_tier_preco_service_all" ON public.cliente_tier_preco;
CREATE POLICY "cliente_tier_preco_service_all"
  ON public.cliente_tier_preco FOR ALL
  USING (auth.role() = 'service_role');

-- ------------------------------------------------------------
-- 2) cliente_tier_preco_log — auditoria de→para (P1-11). Escrita SÓ pelo trigger
--    SECURITY DEFINER; inescrevível direto por anon/authenticated.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cliente_tier_preco_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL,
  customer_user_id uuid NOT NULL,
  tier_de text,
  tier_para text,
  motivo text,
  mudado_por uuid,
  mudado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cliente_tier_log_cliente
  ON public.cliente_tier_preco_log(company, customer_user_id, mudado_em DESC);

CREATE OR REPLACE FUNCTION public.cliente_tier_preco_audita()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.cliente_tier_preco_log(
    company, customer_user_id, tier_de, tier_para, motivo, mudado_por, mudado_em)
  VALUES (
    NEW.company, NEW.customer_user_id,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.tier ELSE NULL END,
    NEW.tier, NEW.motivo, NEW.definido_por, now());
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_cliente_tier_audita ON public.cliente_tier_preco;
CREATE TRIGGER trg_cliente_tier_audita
  AFTER INSERT OR UPDATE ON public.cliente_tier_preco
  FOR EACH ROW EXECUTE FUNCTION public.cliente_tier_preco_audita();

ALTER TABLE public.cliente_tier_preco_log ENABLE ROW LEVEL SECURITY;

-- Staff lê o histórico. NENHUMA policy de escrita → RLS nega IUD a authenticated
-- (o trigger SECDEF roda como owner e bypassa). REVOKE explícito por cima (a regra do
-- repo: REVOKE FROM PUBLIC não tira anon/authenticated — revogar por nome).
DROP POLICY IF EXISTS "cliente_tier_log_select_staff" ON public.cliente_tier_preco_log;
CREATE POLICY "cliente_tier_log_select_staff"
  ON public.cliente_tier_preco_log FOR SELECT
  USING (
    has_role((SELECT auth.uid()), 'employee'::app_role)
    OR has_role((SELECT auth.uid()), 'master'::app_role)
  );

REVOKE INSERT, UPDATE, DELETE ON public.cliente_tier_preco_log FROM anon, authenticated, PUBLIC;

-- ------------------------------------------------------------
-- 3) tier_preco_config — multiplicador de PARTIDA por (conta, tier). Config tipada
--    (P1-13: CHECK 0,5–1,5), nunca company_config texto-livre. SELECT staff: a partida é
--    função pura no browser do vendedor (precoPartida = tabela × mult) — ele PRECISA do mult;
--    e o mult (1,00/1,05) não revela custo (≠ piso da markup_policy) — o vendedor já o infere
--    de preço÷tabela. Escrita master.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tier_preco_config (
  company text NOT NULL CHECK (company IN ('oben', 'colacor')),
  tier text NOT NULL CHECK (tier IN ('A', 'B', 'C')),
  mult_partida numeric NOT NULL CHECK (
    mult_partida >= 0.5 AND mult_partida <= 1.5 AND mult_partida <> 'NaN'::numeric
  ),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company, tier)
);

ALTER TABLE public.tier_preco_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tier_preco_config_select_carteira" ON public.tier_preco_config;
DROP POLICY IF EXISTS "tier_preco_config_select_staff" ON public.tier_preco_config;
CREATE POLICY "tier_preco_config_select_staff"
  ON public.tier_preco_config FOR SELECT
  USING (
    has_role((SELECT auth.uid()), 'employee'::app_role)
    OR has_role((SELECT auth.uid()), 'master'::app_role)
  );

DROP POLICY IF EXISTS "tier_preco_config_write_master" ON public.tier_preco_config;
CREATE POLICY "tier_preco_config_write_master"
  ON public.tier_preco_config FOR ALL
  USING (has_role((SELECT auth.uid()), 'master'::app_role))
  WITH CHECK (has_role((SELECT auth.uid()), 'master'::app_role));

DROP POLICY IF EXISTS "tier_preco_config_service_all" ON public.tier_preco_config;
CREATE POLICY "tier_preco_config_service_all"
  ON public.tier_preco_config FOR ALL
  USING (auth.role() = 'service_role');

-- Seed (decisão do founder §7): mult A/B=1,00 · C=1,05 nas DUAS contas.
INSERT INTO public.tier_preco_config(company, tier, mult_partida) VALUES
  ('oben',    'A', 1.00), ('oben',    'B', 1.00), ('oben',    'C', 1.05),
  ('colacor', 'A', 1.00), ('colacor', 'B', 1.00), ('colacor', 'C', 1.05)
ON CONFLICT (company, tier) DO NOTHING;

-- ------------------------------------------------------------
-- 4) markup_policy — ganha `tier` + UNIQUE anti-empate; seed dos pisos por tier e da
--    política-base da Colacor; RLS APERTADA (P1-12: staff-wide → carteira completa).
-- ------------------------------------------------------------
ALTER TABLE public.markup_policy ADD COLUMN IF NOT EXISTS tier text;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'markup_policy_tier_check' AND conrelid = 'public.markup_policy'::regclass
  ) THEN
    ALTER TABLE public.markup_policy
      ADD CONSTRAINT markup_policy_tier_check CHECK (tier IS NULL OR tier IN ('A', 'B', 'C'));
  END IF;
END $$;

-- Para escopo='sku', familia é IRRELEVANTE e DEVE ser NULL (review Codex P1). Sem isto, duas
-- linhas sku de mesmo (account,sku,tier) com familia NULL vs 'x' escapam da UNIQUE (familia
-- difere) e resolve_markup_policy(LIMIT 1) — que só filtra sku_codigo no ramo sku — fica
-- NÃO-determinística entre elas. O CHECK força familia NULL → a UNIQUE passa a barrá-las.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'markup_policy_sku_sem_familia' AND conrelid = 'public.markup_policy'::regclass
  ) THEN
    ALTER TABLE public.markup_policy
      ADD CONSTRAINT markup_policy_sku_sem_familia CHECK (escopo <> 'sku' OR familia IS NULL);
  END IF;
END $$;

-- Índices únicos parciais VIGENTES (por escopo, SEM tier) impedem múltiplas linhas por tier:
--   uq_markup_policy_conta  UNIQUE(account)             WHERE escopo='conta'
--   uq_markup_policy_fam    UNIQUE(account, familia)    WHERE escopo='familia'
--   uq_markup_policy_sku    UNIQUE(account, sku_codigo) WHERE escopo='sku'
-- Sem tier na chave, o seed (conta,tier) colide com a linha-base (23505). A constraint global
-- abaixo (COM tier, NULLS NOT DISTINCT) cobre tudo o que eles cobriam + o tier → dropa-se os 3.
DROP INDEX IF EXISTS public.uq_markup_policy_conta;
DROP INDEX IF EXISTS public.uq_markup_policy_fam;
DROP INDEX IF EXISTS public.uq_markup_policy_sku;

-- Empate barrado (P1-6): 2 linhas mesmo (conta,escopo,sku,familia,tier) é ilegal.
-- NULLS NOT DISTINCT trata NULL como valor → (conta,NULL,NULL,NULL) é único. Com o CHECK
-- acima (familia NULL p/ sku), cobre também o empate (sku,tier) de familias divergentes.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'markup_policy_escopo_tier_uq' AND conrelid = 'public.markup_policy'::regclass
  ) THEN
    ALTER TABLE public.markup_policy
      ADD CONSTRAINT markup_policy_escopo_tier_uq
      UNIQUE NULLS NOT DISTINCT (account, escopo, sku_codigo, familia, tier);
  END IF;
END $$;

-- Colacor ATIVA desde o dia 1 (decisão do founder §7.4): política-base de conta
-- 30/50, espelhando a Oben → o cockpit da Colacor sai do neutro pra TODOS os pedidos.
INSERT INTO public.markup_policy(account, escopo, familia, sku_codigo, piso_markup, meta_markup, tier)
VALUES ('colacor', 'conta', NULL, NULL, 30, 50, NULL)
ON CONFLICT (account, escopo, sku_codigo, familia, tier) DO NOTHING;

-- Pisos por tier (ambas as contas): A=25 · B=30 · C=35 (markup% sobre custo).
-- meta = a da conta (50), não diferenciada por tier na largada (§7.3).
INSERT INTO public.markup_policy(account, escopo, familia, sku_codigo, piso_markup, meta_markup, tier) VALUES
  ('oben',    'conta', NULL, NULL, 25, 50, 'A'),
  ('oben',    'conta', NULL, NULL, 30, 50, 'B'),
  ('oben',    'conta', NULL, NULL, 35, 50, 'C'),
  ('colacor', 'conta', NULL, NULL, 25, 50, 'A'),
  ('colacor', 'conta', NULL, NULL, 30, 50, 'B'),
  ('colacor', 'conta', NULL, NULL, 35, 50, 'C')
ON CONFLICT (account, escopo, sku_codigo, familia, tier) DO NOTHING;

-- Aperta a leitura da política crua: pisos/multiplicadores por tier viram âncora de
-- negociação se um vendedor os lê. Fato verificado: zero leitura direta de markup_policy
-- no frontend (tudo via RPC SECDEF que já oculta números). Vendedor segue vendo a FAIXA.
DROP POLICY IF EXISTS "markup_policy_select_staff" ON public.markup_policy;
DROP POLICY IF EXISTS "markup_policy_select_carteira" ON public.markup_policy;
CREATE POLICY "markup_policy_select_carteira"
  ON public.markup_policy FOR SELECT
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));

-- ------------------------------------------------------------
-- 5) resolve_markup_policy — 4º arg p_tier + GREATEST de DUAS cascatas (P1-5/P1-7).
--    DROP da assinatura de 3 args (evita overload/ambiguidade) + CREATE da de 4.
--    O único caller SQL (get_preco_cockpit) é reescrito na Seção 6 (mesma migration).
-- ------------------------------------------------------------
-- DROP da assinatura de 3 args garante o anti-overload (é a única outra assinatura em prod).
-- CREATE OR REPLACE na de 4 args mantém a migration idempotente (re-run pelo founder não colide:
-- DROP 3-args vira no-op e OR REPLACE substitui a de 4). Só a de 4 args existe ao fim (assert N15).
DROP FUNCTION IF EXISTS public.resolve_markup_policy(text, bigint, text);

CREATE OR REPLACE FUNCTION public.resolve_markup_policy(
  p_empresa text, p_codigo bigint, p_familia text, p_tier text DEFAULT NULL)
RETURNS TABLE(piso_markup numeric, meta_markup numeric)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  WITH produto AS (
    -- cascata vigente (linhas SEM tier): sku > familia > conta
    SELECT mp.piso_markup, mp.meta_markup
    FROM public.markup_policy mp
    WHERE mp.account = lower(p_empresa) AND mp.tier IS NULL
      AND (
        (mp.escopo = 'sku'     AND mp.sku_codigo = p_codigo) OR
        (mp.escopo = 'familia' AND p_familia IS NOT NULL AND mp.familia = p_familia) OR
        (mp.escopo = 'conta')
      )
    ORDER BY CASE mp.escopo WHEN 'sku' THEN 1 WHEN 'familia' THEN 2 ELSE 3 END
    LIMIT 1
  ),
  por_tier AS (
    -- cascata por tier (linhas COM tier = p_tier): (sku,tier) > (familia,tier) > (conta,tier)
    SELECT mp.piso_markup, mp.meta_markup
    FROM public.markup_policy mp
    WHERE mp.account = lower(p_empresa) AND p_tier IS NOT NULL AND mp.tier = p_tier
      AND (
        (mp.escopo = 'sku'     AND mp.sku_codigo = p_codigo) OR
        (mp.escopo = 'familia' AND p_familia IS NOT NULL AND mp.familia = p_familia) OR
        (mp.escopo = 'conta')
      )
    ORDER BY CASE mp.escopo WHEN 'sku' THEN 1 WHEN 'familia' THEN 2 ELSE 3 END
    LIMIT 1
  )
  -- piso/meta efetivos = GREATEST das duas cascatas (NULL-safe: GREATEST ignora NULL;
  -- só é NULL se AMBAS ausentes). SKU commodity de piso baixo nunca fura o piso do tier.
  -- Invariante meta>=piso preservada: cada linha respeita o CHECK meta>=piso, então a
  -- linha que dita GREATEST(piso) tem meta>=esse piso e GREATEST(meta) a inclui.
  SELECT
    GREATEST((SELECT piso_markup FROM produto), (SELECT piso_markup FROM por_tier)) AS piso_markup,
    GREATEST((SELECT meta_markup FROM produto), (SELECT meta_markup FROM por_tier)) AS meta_markup
  WHERE (SELECT piso_markup FROM produto) IS NOT NULL
     OR (SELECT piso_markup FROM por_tier) IS NOT NULL;
$function$;

-- Higiene: anon/PUBLIC não chamam (authenticated mantém — a RLS apertada da
-- markup_policy já devolve 0 linhas pra quem não vê carteira).
REVOKE EXECUTE ON FUNCTION public.resolve_markup_policy(text, bigint, text, text) FROM anon, PUBLIC;

-- ------------------------------------------------------------
-- 6) get_preco_cockpit — tier-aware (P1-8: tier resolvido SERVER-SIDE por customer,
--    jamais do payload). CREATE OR REPLACE (assinatura jsonb inalterada). Corpo
--    reproduzido verbatim do pré-flight, com 3 inserções cirúrgicas marcadas [TIER].
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_preco_cockpit(p_itens jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_pode_num boolean;
  v_out jsonb := '[]'::jsonb;
  v_item jsonb;
  v_empresa text; v_codigo bigint; v_preco numeric; v_formula uuid;
  v_cmc numeric; v_prov text; v_fresc timestamptz; v_familia text;
  v_piso numeric; v_meta numeric; v_tem_pol boolean;
  v_faixa text; v_motivo text; v_markup numeric; v_folga numeric;
  v_accounts text[];
  v_preco_ok boolean;
  v_cmc_ok boolean;
  v_customer uuid; v_tier text;  -- [TIER]
BEGIN
  IF NOT (auth.uid() IS NOT NULL
    AND (has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'master'::app_role))) THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  IF jsonb_array_length(p_itens) > 200 THEN
    RAISE EXCEPTION 'too many items (max 200)' USING errcode = '22023';
  END IF;
  v_pode_num := pode_ver_carteira_completa(auth.uid());

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    v_cmc := NULL; v_prov := NULL; v_fresc := NULL; v_familia := NULL;
    v_piso := NULL; v_meta := NULL;
    v_tier := NULL;  -- [TIER] reset por item

    v_empresa := lower(v_item->>'empresa');
    v_codigo  := (v_item->>'codigo')::bigint;
    v_preco   := (v_item->>'preco')::numeric;
    v_formula := NULLIF(v_item->>'tint_formula_id','')::uuid;
    v_customer := NULLIF(v_item->>'customer_user_id','')::uuid;  -- [TIER]
    v_preco_ok := v_preco IS NOT NULL AND v_preco <> 'NaN'::numeric;

    v_accounts := CASE v_empresa
            WHEN 'oben'       THEN ARRAY['vendas','oben']
            WHEN 'colacor'    THEN ARRAY['colacor_vendas','colacor']
            WHEN 'colacor_sc' THEN ARRAY['servicos','colacor_sc']
            ELSE ARRAY[v_empresa] END;

    IF v_formula IS NOT NULL THEN
      DECLARE
        v_base_cmc numeric;
        v_base_synced timestamptz;
        v_cor_total numeric;
        v_cor_faltando int;
        v_n_itens int;
        v_cor_min_synced timestamptz;
      BEGIN
        SELECT ip.cmc, ip.synced_at INTO v_base_cmc, v_base_synced
        FROM tint_formulas tf
        JOIN tint_skus ts
          ON ts.id = tf.sku_id
          OR (tf.sku_id IS NULL AND ts.account = tf.account
              AND ts.produto_id = tf.produto_id AND ts.base_id = tf.base_id
              AND ts.embalagem_id = tf.embalagem_id)
        JOIN omie_products opb ON opb.id = ts.omie_product_id
        JOIN inventory_position ip ON ip.omie_codigo_produto = opb.omie_codigo_produto
              AND ip.account = ANY(v_accounts)
        WHERE tf.id = v_formula
          AND tf.account = v_empresa
          AND ip.cmc > 0 AND ip.cmc <> 'NaN'::numeric
        ORDER BY ip.synced_at DESC NULLS LAST LIMIT 1;

        SELECT
          count(*),
          count(*) FILTER (
            WHERE ipc.cmc IS NULL OR ipc.cmc <= 0 OR ipc.cmc = 'NaN'::numeric
               OR c.volume_total_ml IS NULL OR c.volume_total_ml <= 0
               OR fi.qtd_ml IS NULL OR fi.qtd_ml <= 0 OR fi.qtd_ml = 'NaN'::numeric),
          COALESCE(SUM(fi.qtd_ml * ipc.cmc / NULLIF(c.volume_total_ml,0)), 0),
          min(ipc.synced_at)
        INTO v_n_itens, v_cor_faltando, v_cor_total, v_cor_min_synced
        FROM tint_formula_itens fi
        JOIN tint_corantes c       ON c.id = fi.corante_id
        LEFT JOIN omie_products opc ON opc.id = c.omie_product_id
        LEFT JOIN LATERAL (
          SELECT ip.cmc, ip.synced_at FROM inventory_position ip
          WHERE ip.omie_codigo_produto = opc.omie_codigo_produto AND ip.cmc > 0 AND ip.cmc <> 'NaN'::numeric
            AND ip.account = ANY(v_accounts)
          ORDER BY ip.synced_at DESC NULLS LAST LIMIT 1
        ) ipc ON true
        WHERE fi.formula_id = v_formula;

        IF v_base_cmc IS NULL OR v_base_cmc <= 0 OR v_base_cmc = 'NaN'::numeric
           OR v_n_itens = 0 OR v_cor_faltando > 0 THEN
          v_cmc := NULL; v_prov := 'tint(custo incompleto)'; v_fresc := NULL;
        ELSE
          v_cmc := v_base_cmc + v_cor_total;
          v_prov := 'tint(CMC base+corantes)';
          v_fresc := LEAST(v_base_synced, v_cor_min_synced);
        END IF;
      END;
    ELSE
      SELECT ip.cmc, 'inventory_position('||ip.account||')', ip.synced_at
        INTO v_cmc, v_prov, v_fresc
      FROM inventory_position ip
      WHERE ip.omie_codigo_produto = v_codigo
        AND ip.cmc > 0 AND ip.cmc <> 'NaN'::numeric
        AND ip.account = ANY(v_accounts)
      ORDER BY ip.synced_at DESC NULLS LAST
      LIMIT 1;
    END IF;

    v_cmc_ok := v_cmc IS NOT NULL AND v_cmc > 0 AND v_cmc <> 'NaN'::numeric;

    SELECT op.familia INTO v_familia
    FROM omie_products op
    WHERE op.omie_codigo_produto = v_codigo AND op.account = v_empresa
    LIMIT 1;

    -- [TIER] tier resolvido no SERVIDOR (nunca do payload): forjar customer alheio só
    -- mudaria a cor do próprio semáforo, jamais o preço nem a medição A5 (usa o real).
    IF v_customer IS NOT NULL THEN
      SELECT ctp.tier INTO v_tier
      FROM cliente_tier_preco ctp
      WHERE ctp.company = v_empresa AND ctp.customer_user_id = v_customer;
    END IF;

    SELECT rp.piso_markup, rp.meta_markup INTO v_piso, v_meta
    FROM resolve_markup_policy(v_empresa, v_codigo, v_familia, v_tier) rp;  -- [TIER] 4º arg
    v_tem_pol := v_piso IS NOT NULL AND v_meta IS NOT NULL
                 AND v_piso <> 'NaN'::numeric AND v_meta <> 'NaN'::numeric;

    IF NOT v_cmc_ok OR NOT v_preco_ok THEN
      v_faixa := 'neutro'; v_motivo := 'sem_custo';
    ELSIF v_preco < v_cmc THEN
      v_faixa := 'vermelho'; v_motivo := 'abaixo_do_custo';
    ELSIF NOT v_tem_pol THEN
      v_faixa := 'neutro'; v_motivo := 'sem_politica';
    ELSIF v_preco < v_cmc * (1 + v_piso/100) THEN
      v_faixa := 'amarelo'; v_motivo := 'abaixo_do_piso';
    ELSIF v_preco < v_cmc * (1 + v_meta/100) THEN
      v_faixa := 'verde'; v_motivo := 'abaixo_da_meta';
    ELSE
      v_faixa := 'verde'; v_motivo := 'saudavel';
    END IF;

    IF v_cmc_ok AND v_preco_ok THEN
      v_markup := (v_preco - v_cmc) / v_cmc * 100;
      v_folga  := v_preco - v_cmc;
    ELSE
      v_markup := NULL; v_folga := NULL;
    END IF;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'codigo', v_codigo, 'empresa', v_empresa,
      'faixa', v_faixa, 'motivo', v_motivo,
      'tem_custo', v_cmc_ok,
      'tem_politica', v_tem_pol,
      'tier', to_jsonb(v_tier),  -- [TIER] badge (não-sensível): o tier resolvido server-side
      'calculated_at', now(),
      'cmc',          CASE WHEN v_pode_num THEN to_jsonb(v_cmc)    ELSE 'null'::jsonb END,
      'markup_perc',  CASE WHEN v_pode_num THEN to_jsonb(v_markup) ELSE 'null'::jsonb END,
      'folga_reais',  CASE WHEN v_pode_num THEN to_jsonb(v_folga)  ELSE 'null'::jsonb END,
      'piso_markup',  CASE WHEN v_pode_num THEN to_jsonb(v_piso)   ELSE 'null'::jsonb END,
      'meta_markup',  CASE WHEN v_pode_num THEN to_jsonb(v_meta)   ELSE 'null'::jsonb END,
      'proveniencia', CASE WHEN v_pode_num THEN to_jsonb(v_prov)   ELSE 'null'::jsonb END,
      'frescor',      CASE WHEN v_pode_num THEN to_jsonb(v_fresc)  ELSE 'null'::jsonb END
    ));
  END LOOP;

  RETURN v_out;
END;
$function$;

-- ------------------------------------------------------------
-- 7) get_ultimos_precos_cliente — passa a EXPOR a data do último praticado (janela
--    180d). DROP+CREATE (retorno muda). Retrocompatível: o frontend antigo lê
--    product_id/unit_price e ignora a 3ª coluna. Comportamento de ordenação intacto.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_ultimos_precos_cliente(uuid);

CREATE FUNCTION public.get_ultimos_precos_cliente(p_customer uuid)
RETURNS TABLE(product_id uuid, unit_price numeric, ultimo_praticado_em date)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'employee'::public.app_role)
          OR public.has_role(auth.uid(), 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'forbidden: get_ultimos_precos_cliente exige staff' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT DISTINCT ON (oi.product_id)
    oi.product_id, oi.unit_price,
    COALESCE(so.order_date_kpi,
             (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) AS ultimo_praticado_em
  FROM public.order_items oi
  JOIN public.sales_orders so ON so.id = oi.sales_order_id
  WHERE oi.customer_user_id = p_customer
    AND oi.customer_user_id = so.customer_user_id
    AND so.deleted_at IS NULL
    AND COALESCE(so.status, '') NOT IN ('cancelado', 'orcamento')
    AND oi.unit_price > 0
    AND oi.product_id IS NOT NULL
    AND COALESCE(so.order_date_kpi,
                 (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) <= current_date
  ORDER BY oi.product_id,
           COALESCE(so.order_date_kpi,
                    (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) DESC,
           so.created_at DESC, oi.created_at DESC, oi.id DESC;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_ultimos_precos_cliente(uuid) FROM anon, PUBLIC;

-- ------------------------------------------------------------
-- 8) medir_abaixo_piso_tier — medição A5 (Fase A → decide Fase B). Mede o que foi
--    EFETIVADO (order_items), todas as vias por construção; imune a spoof/retry.
--    Requisito do challenge: usa a MESMA resolve_markup_policy(...tier) do cockpit —
--    1 fonte de verdade, nunca reimplementa o GREATEST. Números de custo → gate
--    pode_ver_carteira_completa (coerente com o cockpit).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.medir_abaixo_piso_tier(p_dias int DEFAULT 90)
RETURNS TABLE(company text, tier text, itens_abaixo bigint, total_itens bigint, folga_negativa_reais numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT pode_ver_carteira_completa(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden: medir_abaixo_piso_tier exige carteira completa' USING errcode = '42501';
  END IF;

  RETURN QUERY
  WITH itens AS (
    SELECT
      so.account AS company,
      ctp.tier,
      oi.unit_price, oi.quantity, oi.omie_codigo_produto, op.familia,
      (SELECT ip.cmc FROM inventory_position ip
        WHERE ip.omie_codigo_produto = oi.omie_codigo_produto
          AND ip.cmc > 0 AND ip.cmc <> 'NaN'::numeric
          AND ip.account = ANY(CASE so.account
                WHEN 'oben'    THEN ARRAY['vendas','oben']
                WHEN 'colacor' THEN ARRAY['colacor_vendas','colacor']
                ELSE ARRAY[so.account] END)
        ORDER BY ip.synced_at DESC NULLS LAST LIMIT 1) AS cmc
    FROM public.order_items oi
    JOIN public.sales_orders so ON so.id = oi.sales_order_id
    LEFT JOIN public.cliente_tier_preco ctp
      ON ctp.company = so.account AND ctp.customer_user_id = so.customer_user_id
    LEFT JOIN public.omie_products op
      ON op.omie_codigo_produto = oi.omie_codigo_produto AND op.account = so.account
    WHERE so.deleted_at IS NULL
      AND COALESCE(so.status, '') NOT IN ('cancelado', 'orcamento')
      -- PV efetivado no Omie (review Codex P2): sem isto, um pedido local bloqueado por
      -- crédito / com erro de ERP (sem PV) entraria como "vendido" e inflaria a métrica.
      -- Mede só o que virou pedido no Omie (todas as vias). Hoje 29.730/29.730 têm PV.
      AND so.omie_numero_pedido IS NOT NULL
      AND so.omie_numero_pedido::text <> ''
      AND so.account IN ('oben', 'colacor')
      AND COALESCE(so.order_date_kpi,
                   (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= current_date - p_dias
      AND oi.unit_price > 0
  ),
  avaliado AS (
    SELECT i.company, i.tier, i.unit_price, i.quantity, i.cmc, rp.piso_markup
    FROM itens i
    LEFT JOIN LATERAL public.resolve_markup_policy(i.company, i.omie_codigo_produto, i.familia, i.tier) rp ON true
    WHERE i.cmc IS NOT NULL AND i.cmc > 0
  )
  SELECT
    a.company, a.tier,
    count(*) FILTER (WHERE a.piso_markup IS NOT NULL AND a.unit_price < a.cmc * (1 + a.piso_markup/100)) AS itens_abaixo,
    count(*) AS total_itens,
    COALESCE(SUM((a.cmc * (1 + a.piso_markup/100) - a.unit_price) * a.quantity)
             FILTER (WHERE a.piso_markup IS NOT NULL AND a.unit_price < a.cmc * (1 + a.piso_markup/100)), 0) AS folga_negativa_reais
  FROM avaliado a
  GROUP BY a.company, a.tier
  ORDER BY a.company, a.tier NULLS FIRST;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.medir_abaixo_piso_tier(int) FROM anon, PUBLIC;

COMMIT;
