-- ============================================================
-- desconto_backfill_aplicar — `ja_apuradas` contada ANTES do UPDATE
--
-- Correção da `20260908220625_desconto_backfill_aplicar.sql` (que continua lá: é DR, imutável).
-- Muda UMA coisa: a contagem de `ja_apuradas` passa para antes do UPDATE. A escrita, a
-- precondição por linha, o guard de concorrência e o ACL ficam como estavam.
--
-- O DEFEITO (achado em 2026-09-10 na execução do backfill Oben/TTM; conferido no
-- `pg_get_functiondef` da PROD): a contagem rodava no statement seguinte ao UPDATE e enxergava
-- as linhas que a própria chamada tinha acabado de aplicar. No cenário misto — 3 linhas no plano,
-- 1 já preenchida por outro writer, 2 aplicáveis — ela devolvia ja_apuradas=3, e o certo é 1.
-- A edge `omie-desconto-backfill` não lê `ja_apuradas` (só `aplicadas`/`recusadas`), então nada
-- foi escrito errado. O dano era de observabilidade: o campo que existe para separar "corrida
-- perdida" de "base mudou" dizia que toda linha aplicada tinha perdido a corrida.
--
-- Prova executada e falsificação: db/test-desconto-backfill-aplicar.sh (grupo J).
-- ============================================================

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
  v_ja_apuradas integer := 0;
BEGIN
  IF p_linhas IS NULL OR jsonb_typeof(p_linhas) <> 'array' THEN
    RAISE EXCEPTION 'desconto_backfill_aplicar: p_linhas tem de ser um array jsonb (veio %)',
      coalesce(jsonb_typeof(p_linhas), 'null');
  END IF;

  SELECT count(*) INTO v_pedidas FROM jsonb_array_elements(p_linhas);

  -- `ja_apuradas`: linhas do plano que JÁ tinham desconto quando esta chamada começou — outro
  -- writer ganhou a corrida, ou um run anterior já as escreveu. O guard de concorrência do UPDATE
  -- abaixo as recusa; contá-las à parte é o que deixa o chamador separar, dentro de `recusadas`,
  -- "corrida perdida" de "base mudou" — consertos opostos.
  --
  -- CONTADA ANTES DO UPDATE, e a ordem é o conserto. Até 2026-09-10 esta contagem vinha DEPOIS
  -- dele: em plpgsql o statement seguinte enxerga o que a própria transação acabou de escrever, e
  -- ela contava junto as linhas que ESTA chamada aplicou. Um plano de 40 linhas, todas aplicadas,
  -- devolvia ja_apuradas=40 contra recusadas=0 — estado impossível.
  --
  -- Por que não `preenchidas_depois - aplicadas`: só coincide se cada id aparece UMA vez no plano.
  -- Um id repetido, aplicado por esta chamada, sairia como "já apurado" (1 onde o certo é 0): o
  -- `UPDATE ... FROM` escreve a linha uma vez só e o RETURNING devolve uma linha só.
  --
  -- Limite aceito: são dois statements. Um writer que comite ENTRE eles (microssegundos) faz a
  -- linha cair em `recusadas` sem cair aqui, e ela é lida como "base mudou". Fechar essa janela
  -- pediria `FOR UPDATE` nas linhas recusadas — lock a mais num writer de money-path, pela
  -- exatidão de um contador de observabilidade. Não compensa.
  SELECT count(*) INTO v_ja_apuradas
    FROM jsonb_to_recordset(p_linhas) AS x(id uuid)
    JOIN public.order_items oi ON oi.id = x.id
   WHERE oi.desconto_valor IS NOT NULL;

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
       -- SO ESCREVE O QUE AINDA NAO FOI APURADO. Sem isto, um writer que preencha a linha entre a
       -- leitura que montou o plano e esta escrita seria SOBRESCRITO -- e sem divergencia visivel,
       -- porque o trio (SKU, qtd, preco) continua batendo: o guard de base nao ve mudanca de
       -- desconto. Reapurar nao e' inofensivo: o valor do plano foi lido ANTES, e o do outro
       -- writer pode ser mais novo. Repetir o mesmo plano segue idempotente no que importa (a
       -- linha ja tem o valor); o que muda e' que a corrida deixa de ter vencedor por sorte.
       AND oi.desconto_valor IS NULL
     RETURNING 1
  )
  SELECT count(*) INTO v_aplicadas FROM aplicado;

  -- O chamador precisa das DUAS contagens. Só "aplicadas" não distingue "o plano tinha 40 linhas
  -- e 40 foram escritas" de "tinha 900 e 40 foram escritas porque 860 mudaram no meio do caminho".
  RETURN jsonb_build_object(
    'pedidas',      v_pedidas,
    'aplicadas',    v_aplicadas,
    'recusadas',    v_pedidas - v_aplicadas,
    'ja_apuradas',  v_ja_apuradas
  );
END
$fn$;

-- SECURITY DEFINER bypassa RLS ⇒ o gate tem de estar na FRONTEIRA. Só o service_role (edge com
-- `authorizeCronOrStaff`) chama. `authenticated`/`anon` não têm por que reescrever desconto de
-- item, e um EXECUTE aberto aqui seria escrita de money-path exposta ao cliente.
-- `CREATE OR REPLACE` preserva o ACL (não há DROP); o bloco é reemitido por idempotência.
REVOKE ALL ON FUNCTION public.desconto_backfill_aplicar(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.desconto_backfill_aplicar(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.desconto_backfill_aplicar(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.desconto_backfill_aplicar(jsonb) TO service_role;

DO $post$
DECLARE
  v_src     text;
  v_pos_ja  integer;
  v_pos_upd integer;
  v_pub  boolean;
  v_anon boolean;
  v_auth boolean;
  v_svc  boolean;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.desconto_backfill_aplicar(jsonb)');
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'FALHOU: desconto_backfill_aplicar(jsonb) não existe.';
  END IF;

  -- O que esta migration muda é a ORDEM. A função já existia, então existir não prova nada
  -- (database.md §2: objeto MODIFICADO se verifica pelo CORPO). Os dois marcadores são texto de
  -- statement — nenhum comentário do corpo os contém.
  v_pos_ja  := position('INTO v_ja_apuradas' IN v_src);
  v_pos_upd := position('WITH plano AS' IN v_src);
  IF v_pos_ja = 0 OR v_pos_upd = 0 OR v_pos_ja > v_pos_upd THEN
    RAISE EXCEPTION 'FALHOU: ja_apuradas contada DEPOIS do UPDATE (pos %, UPDATE em %) — conta as próprias escritas.',
      v_pos_ja, v_pos_upd;
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

  RAISE NOTICE 'OK: desconto_backfill_aplicar conta ja_apuradas ANTES do UPDATE; fechada a PUBLIC/anon/authenticated, aberta a service_role.';
END
$post$;

COMMIT;
