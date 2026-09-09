-- ============================================================
-- desconto_backfill_aplicar — escreve o plano de apuração já conciliado
--
-- POR QUE UMA RPC, e não `UPDATE` via PostgREST:
--   Cada linha recebe um valor DIFERENTE, endereçada pela PK. Via PostgREST isso vira uma
--   requisição por linha (10.647 no recorte Oben/TTM). Aqui é um `UPDATE ... FROM
--   jsonb_to_recordset` por lote.
--
-- POR QUE ELA NÃO CALCULA NADA:
--   Quem decide o desconto é `_shared/desconto-omie.ts`; quem decide DE QUEM ele é, com a chave
--   (SKU, quantidade, preço) e unicidade dos dois lados, é `_shared/desconto-backfill.ts`. As
--   duas têm contrato de mutação. Reimplementar qualquer pedaço da régua aqui criaria uma
--   segunda semântica sobre o mesmo dado — que é literalmente o defeito que esta frente conserta.
--   Esta função só ESCREVE, e recusa o que não reconhece.
--
-- PRECONDIÇÃO POR LINHA (fail-closed, dentro da MESMA transação da escrita):
--   O plano foi montado a partir de uma leitura do banco que aconteceu ANTES — o sync, a edição
--   ou a reconciliação podem ter mexido na linha nesse intervalo. Escrever o desconto sobre uma
--   base que mudou é exatamente o erro que a conciliação por trio existe para evitar, e ele
--   voltaria pela porta dos fundos. Por isso o `UPDATE` reexige (quantity, unit_price,
--   omie_codigo_produto) idênticos aos que o plano viu. Linha que mudou não é escrita, e o
--   chamador vê a diferença entre pedidas e aplicadas.
--
-- IDEMPOTENTE: reaplicar o mesmo plano reescreve os mesmos valores. Não há acumulação.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.desconto_backfill_aplicar(p_linhas jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_pedidas   integer := 0;
  v_aplicadas integer := 0;
BEGIN
  IF p_linhas IS NULL OR jsonb_typeof(p_linhas) <> 'array' THEN
    RAISE EXCEPTION 'desconto_backfill_aplicar: p_linhas tem de ser um array jsonb (veio %)',
      coalesce(jsonb_typeof(p_linhas), 'null');
  END IF;

  SELECT count(*) INTO v_pedidas FROM jsonb_array_elements(p_linhas);

  WITH plano AS (
    SELECT * FROM jsonb_to_recordset(p_linhas) AS x(
      id uuid,
      desconto_valor numeric,
      base_quantity numeric,
      base_unit_price numeric,
      base_sku bigint
    )
  ),
  aplicado AS (
    UPDATE public.order_items oi
       SET desconto_valor = pl.desconto_valor
      FROM plano pl
     WHERE oi.id = pl.id
       -- Sem `coalesce(...,0)` em nenhum lado: `IS NOT DISTINCT FROM` é NULL-safe e trata
       -- ausência como ausência. Um `coalesce(oi.unit_price, 0) = coalesce(pl.base_unit_price, 0)`
       -- casaria "preço desconhecido" com "preço zero" e escreveria sobre a linha errada.
       AND oi.quantity            IS NOT DISTINCT FROM pl.base_quantity
       AND oi.unit_price          IS NOT DISTINCT FROM pl.base_unit_price
       AND oi.omie_codigo_produto IS NOT DISTINCT FROM pl.base_sku
       -- O plano NUNCA carrega `null` como valor a gravar: "não apurado" é a AUSÊNCIA de entrada
       -- no plano, não uma entrada com null. Aceitar null aqui deixaria um bug do chamador
       -- apagar apuração já feita, em massa e sem sinal.
       AND pl.desconto_valor IS NOT NULL
     RETURNING 1
  )
  SELECT count(*) INTO v_aplicadas FROM aplicado;

  -- O chamador precisa das DUAS contagens. Só "aplicadas" não distingue "o plano tinha 40 linhas
  -- e 40 foram escritas" de "tinha 900 e 40 foram escritas porque 860 mudaram no meio do caminho".
  RETURN jsonb_build_object(
    'pedidas',   v_pedidas,
    'aplicadas', v_aplicadas,
    'recusadas', v_pedidas - v_aplicadas
  );
END
$fn$;

-- SECURITY DEFINER bypassa RLS ⇒ o gate tem de estar na FRONTEIRA. Só o service_role (edge com
-- `authorizeCronOrStaff`) chama. `authenticated`/`anon` não têm por que reescrever desconto de
-- item, e um EXECUTE aberto aqui seria escrita de money-path exposta ao cliente.
REVOKE ALL ON FUNCTION public.desconto_backfill_aplicar(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.desconto_backfill_aplicar(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.desconto_backfill_aplicar(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.desconto_backfill_aplicar(jsonb) TO service_role;

DO $post$
DECLARE
  v_pub boolean;
  v_anon boolean;
  v_auth boolean;
  v_svc boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'desconto_backfill_aplicar'
  ) THEN
    RAISE EXCEPTION 'FALHOU: desconto_backfill_aplicar não existe.';
  END IF;

  -- Fechar por REVOKE exige as DUAS pontas (PUBLIC e anon) — CLAUDE.md/database.md. Provar por
  -- `has_function_privilege` e não pela presença do REVOKE no arquivo: um GRANT anterior no
  -- banco pode sobreviver ao que este arquivo acha que revogou.
  v_pub  := has_function_privilege('public',        'public.desconto_backfill_aplicar(jsonb)', 'EXECUTE');
  v_anon := has_function_privilege('anon',          'public.desconto_backfill_aplicar(jsonb)', 'EXECUTE');
  v_auth := has_function_privilege('authenticated', 'public.desconto_backfill_aplicar(jsonb)', 'EXECUTE');
  v_svc  := has_function_privilege('service_role',  'public.desconto_backfill_aplicar(jsonb)', 'EXECUTE');

  IF v_pub OR v_anon OR v_auth THEN
    RAISE EXCEPTION 'FALHOU: escrita de money-path aberta — PUBLIC=% anon=% authenticated=%', v_pub, v_anon, v_auth;
  END IF;
  IF NOT v_svc THEN
    RAISE EXCEPTION 'FALHOU: service_role não executa — a edge de backfill não teria como escrever.';
  END IF;

  RAISE NOTICE 'OK: desconto_backfill_aplicar criada, fechada a PUBLIC/anon/authenticated, aberta a service_role.';
END
$post$;

COMMIT;
