-- ============================================================================================
-- Venda por cliente · rodada 2 · Entrega 2 — QUEM VENDEU cada pedido importado do Omie.
-- Spec: docs/superpowers/specs/2026-10-20-venda-por-cliente-design.md
-- Registro: docs/historico/vendedor-pedido-omie.md
--
-- O defeito: o `omie-vendas-sync` gravava em `created_by` de TODO pedido importado o 1º
-- `profiles.is_employee` que o PostgREST devolvesse (`limit(1)` sem ORDER BY). Em prod
-- (psql-ro, 2026-11-12): 30.447 de 32.310 importados com a Tatyana, 1.863 com o Lucas — a
-- assinatura do sync, não a autoria. Medir oferta/conversão POR FARMER sobre isso é fabricar.
--
-- O que esta migration faz (só ADITIVA/relaxante — compatível com a edge que está no ar):
--   1. `created_by` deixa de ser NOT NULL: importado não tem autor no app; ausente = NULL.
--      (O anular dos 32k históricos é o script db/2026-11-13-desfabricar-autor-importado.sql,
--      que roda DEPOIS do deploy da edge — antes disso a edge velha re-fabricaria.)
--   2. Três colunas dedicadas, com UM escritor (a RPC abaixo, chamada pela edge):
--        vendedor_omie_codigo  — o `informacoes_adicionais.codVend` do PRÓPRIO pedido no Omie
--                                (não o vendedor do cadastro do cliente: medido na Oben,
--                                285/926 pedidos desde 01/09 divergem do cadastro);
--        vendedor_user_id      — o código resolvido por `omie_vendedor_map` (por empresa);
--                                NULL = código sem mapa OU pedido ainda não lido. Nunca chute.
--        vendedor_lido_em      — quando a edge leu o pedido pela 1ª vez (ou o vendedor mudou).
--                                NULL = ainda não lido ⇒ distingue "não sei" de "Omie sem vendedor".
--   3. `sales_orders_registrar_vendedor_omie(account, pedidos)` — o escritor (service_role).
--   4. `venda_cobertura_vendedor(de, ate)` — % de pedidos com vendedor identificado, para o
--      painel /admin/venda-cliente e o resumo por e-mail (Entrega 1).
--
-- `origem` NÃO é marcado com 'omie_sync': o `fin-valor-cockpit` classifica `origem IS NULL` como
-- canal `erp_direto` e todo valor desconhecido como `outro` — marcar mudaria o cockpit. O marcador
-- canônico de importado já existe e é o que todos os leitores usam: `hash_payload LIKE 'omie\_%'`.
--
-- Caminho: `bun run db:aplicar` (a transação é do executor — sem BEGIN/COMMIT aqui).
-- ============================================================================================

-- ── 1. created_by: importado não tem autor no app ───────────────────────────────────────────
ALTER TABLE public.sales_orders ALTER COLUMN created_by DROP NOT NULL;

COMMENT ON COLUMN public.sales_orders.created_by IS
  'Quem criou o pedido NO APP (staff/cliente). NULL nos importados do Omie (hash_payload omie_*): '
  'o sync não tem autor. Quem vendeu = vendedor_user_id.';

-- ── 2. colunas do vendedor ─────────────────────────────────────────────────────────────────
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS vendedor_omie_codigo bigint,
  ADD COLUMN IF NOT EXISTS vendedor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS vendedor_lido_em timestamptz;

COMMENT ON COLUMN public.sales_orders.vendedor_omie_codigo IS
  'codVend do PRÓPRIO pedido no Omie (informacoes_adicionais.codVend). Escritor único: '
  'sales_orders_registrar_vendedor_omie. NULL = não lido ou Omie sem vendedor (ver vendedor_lido_em).';
COMMENT ON COLUMN public.sales_orders.vendedor_user_id IS
  'vendedor_omie_codigo resolvido por omie_vendedor_map (por empresa). NULL = sem mapa ou não lido — nunca chute.';
COMMENT ON COLUMN public.sales_orders.vendedor_lido_em IS
  'Quando o sync leu o vendedor deste pedido pela 1ª vez (ou ele mudou). NULL = ainda não lido.';

-- Invariantes: usuário só existe via código; código é positivo; leitura precede ambos.
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.sales_orders'::regclass
                    AND conname = 'sales_orders_vendedor_coerente') THEN
    ALTER TABLE public.sales_orders ADD CONSTRAINT sales_orders_vendedor_coerente CHECK (
      (vendedor_omie_codigo IS NULL OR vendedor_omie_codigo > 0)
      AND (vendedor_user_id IS NULL OR vendedor_omie_codigo IS NOT NULL)
      AND (vendedor_omie_codigo IS NULL OR vendedor_lido_em IS NOT NULL)
    );
  END IF;
END
$chk$;

CREATE INDEX IF NOT EXISTS idx_sales_orders_vendedor_user
  ON public.sales_orders (vendedor_user_id, order_date_kpi)
  WHERE vendedor_user_id IS NOT NULL;

-- Coluna nova nasce SEM grant de SELECT para `authenticated` (sales_orders é fechada por coluna,
-- 20260709163500): conceder só SELECT das três. UPDATE não — escritor único é a RPC.
GRANT SELECT (vendedor_omie_codigo, vendedor_user_id, vendedor_lido_em)
  ON public.sales_orders TO authenticated;

-- ── 3. o escritor ──────────────────────────────────────────────────────────────────────────
-- p_pedidos = [{ "codigo_pedido": <bigint>, "cod_vend": <bigint|null> }, …] de UMA conta.
-- Casa só o pedido IMPORTADO daquela conta (hash canônico omie_<conta>_<codigo>); o resto do
-- payload (pedido que não está no banco: sem cliente, desconto ilegível…) é ignorado e contado.
-- Ausente ≠ apagar: `cod_vend` null NÃO apaga um código já conhecido (coalesce).
-- Idempotente: só escreve quando não lido, ou quando código/usuário mudou — re-ler o mesmo
-- pedido a cada 2h não toca a linha (nem o updated_at).
CREATE OR REPLACE FUNCTION public.sales_orders_registrar_vendedor_omie(p_account text, p_pedidos jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
  v_recebidos   integer;
  v_distintos   integer;
  v_casados     integer;
  v_atualizados integer;
  v_sem_mapa    bigint[];
BEGIN
  IF p_account IS NULL OR p_account NOT IN ('oben', 'colacor') THEN
    RAISE EXCEPTION 'VENDEDOR_CONTA_INVALIDA: %', coalesce(p_account, '<null>') USING ERRCODE = '22023';
  END IF;
  IF p_pedidos IS NULL OR jsonb_typeof(p_pedidos) <> 'array' THEN
    RAISE EXCEPTION 'VENDEDOR_PAYLOAD_INVALIDO: p_pedidos precisa ser array' USING ERRCODE = '22023';
  END IF;

  -- Validação por elemento: tipo errado é 22023 (bug do chamador), não um "sem vendedor" gravado.
  -- CASE (não OR): só ele garante a ORDEM — o cast numérico não pode rodar antes do teste de tipo.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_pedidos) x
     WHERE CASE
             WHEN jsonb_typeof(x) <> 'object' THEN true
             WHEN jsonb_typeof(x->'codigo_pedido') IS DISTINCT FROM 'number' THEN true
             WHEN (x->>'codigo_pedido')::numeric NOT BETWEEN 1 AND 9000000000000000000 THEN true
             WHEN (x->>'codigo_pedido')::numeric <> trunc((x->>'codigo_pedido')::numeric) THEN true
             WHEN coalesce(jsonb_typeof(x->'cod_vend'), 'null') NOT IN ('number', 'null') THEN true
             WHEN jsonb_typeof(x->'cod_vend') = 'number' THEN
                  (x->>'cod_vend')::numeric NOT BETWEEN 1 AND 9000000000000000000
                  OR (x->>'cod_vend')::numeric <> trunc((x->>'cod_vend')::numeric)
             ELSE false
           END
  ) THEN
    RAISE EXCEPTION 'VENDEDOR_PAYLOAD_INVALIDO: codigo_pedido inteiro > 0 e cod_vend inteiro > 0 ou null'
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*), count(DISTINCT (x->>'codigo_pedido')::bigint)
    INTO v_recebidos, v_distintos
    FROM jsonb_array_elements(p_pedidos) x;
  -- O mesmo pedido duas vezes no lote: qual vendedor vale? Ambíguo — recusa em vez de sortear.
  IF v_recebidos <> v_distintos THEN
    RAISE EXCEPTION 'VENDEDOR_PAYLOAD_DUPLICADO: % elementos, % pedidos distintos', v_recebidos, v_distintos
      USING ERRCODE = '22023';
  END IF;

  WITH l AS (
    SELECT (x->>'codigo_pedido')::bigint AS codigo_pedido,
           (x->>'cod_vend')::bigint      AS cod_vend
      FROM jsonb_array_elements(p_pedidos) x
  ),
  alvo AS (
    SELECT so.id,
           coalesce(l.cod_vend, so.vendedor_omie_codigo) AS cod_final
      FROM l
      JOIN public.sales_orders so
        ON so.account = p_account
       AND so.omie_pedido_id = l.codigo_pedido
       AND so.hash_payload LIKE 'omie\_%'
  ),
  resolvido AS (
    SELECT a.id, a.cod_final, m.user_id
      FROM alvo a
      LEFT JOIN public.omie_vendedor_map m
        ON m.omie_account = p_account
       AND m.omie_codigo_vendedor = a.cod_final
  ),
  upd AS (
    UPDATE public.sales_orders so
       SET vendedor_omie_codigo = r.cod_final,
           vendedor_user_id     = r.user_id,
           vendedor_lido_em     = now()
      FROM resolvido r
     WHERE so.id = r.id
       AND (so.vendedor_lido_em IS NULL
            OR so.vendedor_omie_codigo IS DISTINCT FROM r.cod_final
            OR so.vendedor_user_id     IS DISTINCT FROM r.user_id)
    RETURNING so.id
  )
  SELECT (SELECT count(*) FROM resolvido),
         (SELECT count(*) FROM upd),
         (SELECT coalesce(array_agg(DISTINCT cod_final ORDER BY cod_final), '{}')
            FROM resolvido WHERE cod_final IS NOT NULL AND user_id IS NULL)
    INTO v_casados, v_atualizados, v_sem_mapa;

  RETURN jsonb_build_object(
    'recebidos', v_recebidos,
    'casados', v_casados,
    'atualizados', v_atualizados,
    'fora_do_banco', v_recebidos - v_casados,
    'codigos_sem_mapa', to_jsonb(v_sem_mapa)
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.sales_orders_registrar_vendedor_omie(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sales_orders_registrar_vendedor_omie(text, jsonb) TO service_role;

-- ── 4. a cobertura ─────────────────────────────────────────────────────────────────────────
-- Universo: pedidos IMPORTADOS do Omie (hash_payload omie_*), não apagados, não cancelados, com
-- order_date_kpi em [p_de, p_ate]. `pct_com_vendedor` é NULL quando não há pedido (ausente ≠ 0).
-- Gate: master (o mesmo do venda_painel) ou service_role (o resumo por e-mail roda na edge).
CREATE OR REPLACE FUNCTION public.venda_cobertura_vendedor(p_de date, p_ate date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_out jsonb;
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role'
          OR (v_uid IS NOT NULL AND public.has_role(v_uid, 'master'::public.app_role))) THEN
    RAISE EXCEPTION 'venda_cobertura_vendedor: requer master' USING ERRCODE = '42501';
  END IF;
  IF p_de IS NULL OR p_ate IS NULL OR p_ate < p_de OR p_ate - p_de > 400 THEN
    RAISE EXCEPTION 'COBERTURA_PERIODO: periodo invalido (de=%, ate=%; maximo 400 dias)', p_de, p_ate
      USING ERRCODE = '22023';
  END IF;

  WITH u AS (
    SELECT so.account, so.total, so.vendedor_omie_codigo, so.vendedor_user_id, so.vendedor_lido_em
      FROM public.sales_orders so
     WHERE so.hash_payload LIKE 'omie\_%'
       AND so.deleted_at IS NULL
       AND so.status IS DISTINCT FROM 'cancelado'
       AND so.order_date_kpi BETWEEN p_de AND p_ate
  ),
  por_conta AS (
    SELECT u.account,
           count(*)                                       AS pedidos,
           count(*) FILTER (WHERE vendedor_lido_em IS NOT NULL)     AS lidos,
           count(*) FILTER (WHERE vendedor_omie_codigo IS NOT NULL) AS com_codigo,
           count(*) FILTER (WHERE vendedor_user_id IS NOT NULL)     AS com_vendedor,
           coalesce(array_agg(DISTINCT vendedor_omie_codigo ORDER BY vendedor_omie_codigo)
                    FILTER (WHERE vendedor_omie_codigo IS NOT NULL AND vendedor_user_id IS NULL), '{}')
                                                          AS codigos_sem_mapa
      FROM u GROUP BY u.account
  ),
  por_vendedor AS (
    SELECT u.account, u.vendedor_user_id, p.name AS nome,
           count(*) AS pedidos, sum(u.total) AS valor
      FROM u LEFT JOIN public.profiles p ON p.user_id = u.vendedor_user_id
     WHERE u.vendedor_user_id IS NOT NULL
     GROUP BY u.account, u.vendedor_user_id, p.name
  )
  SELECT jsonb_build_object(
    'de', p_de,
    'ate', p_ate,
    'eixo', 'order_date_kpi',
    'universo', 'importados do Omie (hash_payload omie_*), nao apagados, nao cancelados',
    'total', (SELECT jsonb_build_object(
                'pedidos', coalesce(sum(pedidos), 0),
                'lidos', coalesce(sum(lidos), 0),
                'com_codigo', coalesce(sum(com_codigo), 0),
                'com_vendedor', coalesce(sum(com_vendedor), 0),
                'pct_com_vendedor', CASE WHEN coalesce(sum(pedidos), 0) = 0 THEN NULL
                                         ELSE round(100.0 * sum(com_vendedor) / sum(pedidos), 1) END)
                FROM por_conta),
    'por_conta', coalesce((SELECT jsonb_agg(jsonb_build_object(
                'account', account,
                'pedidos', pedidos,
                'lidos', lidos,
                'com_codigo', com_codigo,
                'com_vendedor', com_vendedor,
                'pct_com_vendedor', CASE WHEN pedidos = 0 THEN NULL
                                         ELSE round(100.0 * com_vendedor / pedidos, 1) END,
                'codigos_sem_mapa', to_jsonb(codigos_sem_mapa)) ORDER BY account)
                FROM por_conta), '[]'::jsonb),
    'por_vendedor', coalesce((SELECT jsonb_agg(jsonb_build_object(
                'account', account,
                'vendedor_user_id', vendedor_user_id,
                'nome', nome,
                'pedidos', pedidos,
                'valor', valor) ORDER BY account, pedidos DESC, vendedor_user_id)
                FROM por_vendedor), '[]'::jsonb)
  ) INTO v_out;

  RETURN v_out;
END
$fn$;

REVOKE ALL ON FUNCTION public.venda_cobertura_vendedor(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.venda_cobertura_vendedor(date, date) TO authenticated, service_role;

-- ── postcondição ───────────────────────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'sales_orders'
                AND column_name = 'created_by' AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'P1 FALHOU: sales_orders.created_by segue NOT NULL — a edge nova falharia todo insert';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'sales_orders'
         AND column_name IN ('vendedor_omie_codigo', 'vendedor_user_id', 'vendedor_lido_em')) <> 3 THEN
    RAISE EXCEPTION 'P2 FALHOU: faltam colunas do vendedor em sales_orders';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.sales_orders'::regclass
                    AND conname = 'sales_orders_vendedor_coerente' AND convalidated) THEN
    RAISE EXCEPTION 'P3 FALHOU: CHECK sales_orders_vendedor_coerente ausente ou NOT VALID';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.sales_orders', 'vendedor_user_id', 'SELECT') THEN
    RAISE EXCEPTION 'P4 FALHOU: authenticated sem SELECT em sales_orders.vendedor_user_id (some do PostgREST)';
  END IF;
  IF has_column_privilege('authenticated', 'public.sales_orders', 'vendedor_user_id', 'UPDATE') THEN
    RAISE EXCEPTION 'P5 FALHOU: authenticated pode UPDATE vendedor_user_id — escritor deixaria de ser único';
  END IF;
  IF has_function_privilege('anon', 'public.sales_orders_registrar_vendedor_omie(text, jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.sales_orders_registrar_vendedor_omie(text, jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.sales_orders_registrar_vendedor_omie(text, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P6 FALHOU: ACL do escritor errada (só service_role executa)';
  END IF;
  IF has_function_privilege('anon', 'public.venda_cobertura_vendedor(date, date)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.venda_cobertura_vendedor(date, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P7 FALHOU: ACL da cobertura errada (anon fora, authenticated dentro com gate master)';
  END IF;
  RAISE NOTICE 'vendedor_pedido_omie: created_by nullable, 3 colunas + CHECK, escritor service_role, cobertura master';
END
$post$;
