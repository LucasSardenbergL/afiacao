-- ════════════════════════════════════════════════════════════════════════════════════════════
-- FU4-F fase 2 — o subsistema RÉGUA DE PREÇO decide no SERVIDOR e para de devolver custo
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- CONTEXTO. Continuação do #1465 (fase 1). A decisão de produto (dono, 2026-07-20) é a mesma:
-- **o NÚMERO de custo fecha, o SINAL fica.** A vendedora deixa de ver "CMC R$ 12,40" e continua
-- vendo "abaixo do piso". Afeta 2 pessoas reais (os 2 employees em prod, ambos `farmer`).
--
-- ────────────────────────────────────────────────────────────────────────────────────────────
-- POR QUE A ASSINATURA MUDA (o cerne — não é refactor cosmético)
-- ────────────────────────────────────────────────────────────────────────────────────────────
-- Hoje a RPC é um FETCHER: devolve `cmc` + `aliquota_venda` e a DECISÃO roda no browser
-- (`calcPisoMC` em regua-preco-helpers.ts). Mascarar o `cmc` sem mais nada mata a régua inteira.
--
-- E não basta mover o número: **se o cliente consegue avaliar `preço < piso` offline para um preço
-- qualquer, ele acha o piso por busca binária** (~15 avaliações). Não existe predicado avaliável no
-- cliente que esconda o próprio limiar. Logo a COMPARAÇÃO tem de acontecer aqui, com o preço como
-- argumento — daí `p_preco_atual`. A de 3 args é DROPADA: sobrevivendo, ela continuaria devolvendo
-- `cmc` e a fase seria teatro.
--
-- ⚠️ MEDIDO (psql-ro, prod 2026-07-20) — corrige a premissa do enunciado: `piso_mc` **também** é
-- custo. A alíquota NÃO é por SKU: é UMA linha de company_config
-- (`regua_preco_aliquota_venda_oben` = 0.078), então `cmc = piso_mc × 0,922`. Tirar
-- `aliquota_venda` do payload não impede derivar nada — quem aprende 7,8% uma vez inverte todo
-- piso pra sempre. Por isso `piso_mc` sai gateado por cap_custo_ler junto com o cmc, que é o que o
-- §7 do spec já mandava ("`pisoOculto` mostra 'abaixo do piso' sem valor") e o que
-- ReguaPrecoSinal.tsx:31 já comentava ("o valor do piso vaza o custo → não expõe").
--
-- O CUSTO DO PRAZO (F2) vem junto por obrigação, não por escopo: `pisoComPrazo` também precisa do
-- cmc. Deixá-lo no cliente sem cmc faria o piso DEGRADAR PARA À VISTA em silêncio — piso menor,
-- "abaixo do piso" disparando menos, vendedora fechando abaixo do piso real. Regressão money-path.
-- O PARSE do texto da condição ("A Vista/30/60" → [0,30,60]) fica no cliente: é texto, não custo,
-- e portá-lo para plpgsql criaria divergência de parser sem fechar nada.
--
-- ⚠️ LIMITE HONESTO (mesmo do #1465 §9.2 do spec, repetido porque vale igual aqui): manter o sinal
-- e tirar o número NÃO é barreira de segurança. A régua continua sendo oráculo por bisseção pela
-- UI — a vendedora digita preços e lê o semáforo. É barreira de CONVENIÊNCIA, escolhida
-- conscientemente em troca da ferramenta de venda. A barreira real é contrato e offboarding.
--
-- ESCOPO:
--   1) private.cap_regua_log_escrever  — capability de ESCRITA, separada da de leitura (§4.2)
--   2) private.regua_piso_calc         — a fórmula do piso, uma vez só, no servidor
--   3) get_regua_preco                 — nova assinatura; decide o piso; DROP da de 3 args
--   4) get_regua_preco_customer360     — repassa o preço que ela JÁ resolve no servidor
--   5) registrar_exibicao/aplicacao_regua — writers SECURITY DEFINER (log fecha para leitura)
--   6) regua_preco_log                 — SELECT em cap_custo_ler; ESCRITA só por RPC
--
-- ⚠️ §4.2 do spec do #1434: NÃO reutilizar a mesma função em leitura e escrita. Foi o 2º bloqueador
-- P1 do Codex na fase 1 (cap_custo_ler no WITH CHECK deixava `estrategico` forjar salesperson_id de
-- outro vendedor). Aqui a escrita não tem policy nenhuma: só a RPC escreve, e ela FIXA
-- salesperson_id := auth.uid() internamente — o cliente não tem como informá-lo.
--
-- Reescrita completa (não troca cirúrgica por regexp como no #1465) porque o CONTRATO muda. É
-- seguro aqui e só aqui: o pré-voo psql-ro de 2026-07-20 confirmou que prod == repo nas duas RPCs
-- (só whitespace). A precondição abaixo re-verifica isso no momento do apply — se alguém tiver
-- mexido no meio tempo, aborta em vez de reverter em silêncio.
--
-- Régua DESLIGADA em prod na escrita desta migration: regua_preco_log com 0 linhas e as 2
-- feature-flags `false` por default (useFeatureFlag.ts:19-20). Dá para reescrever sem quebrar
-- ninguém. Isso é FACILITADOR, não pré-condição — a migration não depende do estado das flags.
--
-- Aplicada À MÃO pelo dono no SQL Editor do Lovable.
-- Prova: db/test-authz-custo-fu4f-fase2-regua.sh (PG17, baseline pré-migration + falsificação).
-- ════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 0) PRECONDIÇÕES — aborta em vez de aplicar num banco divergente do medido
-- ────────────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE v_faltando text; v_def text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'private' AND p.proname = 'cap_custo_ler'
  ) THEN
    RAISE EXCEPTION 'FU4-F2: private.cap_custo_ler ausente — aplique o #1434 (20260718190000) ANTES'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- As duas RPCs e a de custo de capital têm de existir (a 3ª é reusada, não reimplementada).
  SELECT string_agg(f, ', ') INTO v_faltando
    FROM unnest(ARRAY['get_regua_preco','get_regua_preco_customer360','fin_regua_custo_capital']) AS f
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                      WHERE n.nspname='public' AND p.proname = f);
  IF v_faltando IS NOT NULL THEN
    RAISE EXCEPTION 'FU4-F2: funcao(oes) ausente(s): % — banco divergente do medido', v_faltando
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='regua_preco_log') THEN
    RAISE EXCEPTION 'FU4-F2: public.regua_preco_log ausente — banco divergente do medido'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Anti-atropelo: esta migration REESCREVE as RPCs. Se a de 3 args ainda existe, ela tem de ser a
  -- que foi medida (fetcher que devolve 'cmc'). Se alguém a reescreveu no meio tempo, o
  -- CREATE OR REPLACE abaixo apagaria o trabalho dele em silêncio — aborta e obriga a reconciliar.
  -- Na 2ª aplicação a de 3 args não existe mais e este bloco é pulado (idempotência).
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_regua_preco'
     AND pg_get_function_identity_arguments(p.oid) = 'uuid, uuid, numeric';
  IF v_def IS NOT NULL AND v_def !~ '''cmc''\s*,\s*v_cmc' THEN
    RAISE EXCEPTION 'FU4-F2: get_regua_preco(uuid,uuid,numeric) divergente do medido em 2026-07-20 — reconcilie antes de reescrever'
      USING ERRCODE = 'raise_exception';
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 1) private.cap_regua_log_escrever — capability de ESCRITA do log
--
--    Preserva EXATAMENTE a concessão de escrita de hoje (employee OR master) — esta fase fecha
--    LEITURA de custo, não muda quem registra. Existe como função PRÓPRIA por causa do §4.2 do
--    spec do #1434 ("não reutilizar a mesma função em leitura e escrita"): sem ela, a tentação é
--    gatear o writer por cap_custo_ler e repetir o bloqueador P1 da fase 1. Mesma linhagem de
--    private.cap_compras_escrever (FU4-E).
-- ────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.cap_regua_log_escrever(_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    _uid IS NOT NULL
    AND (
      public.has_role(_uid, 'employee'::public.app_role)
      OR public.has_role(_uid, 'master'::public.app_role)
    ), false);
$$;

COMMENT ON FUNCTION private.cap_regua_log_escrever(uuid) IS
  'FU4-F fase 2: capability de ESCRITA do regua_preco_log (employee OR master — a concessão de '
  'sempre). SEPARADA de cap_custo_ler DE PROPÓSITO: §4.2 do spec de 2026-07-18 proíbe reusar a '
  'mesma função em leitura e escrita, e reusá-la deixaria estrategico/super_admin forjar registro '
  'de outro vendedor (bloqueador P1 do Codex na fase 1).';

REVOKE ALL ON FUNCTION private.cap_regua_log_escrever(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.cap_regua_log_escrever(uuid) TO authenticated;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 2) private.regua_piso_calc — A FÓRMULA DO PISO, uma vez só, no servidor
--
--    Espelha o que era `calcPisoMC` + `pisoComPrazo` (regua-preco-helpers.ts / prazo-helpers.ts),
--    que este PR DELETA do TS. Não é código duplicado: é a MIGRAÇÃO da fórmula, e por isso não há
--    harness de paridade TS×SQL — passa a existir uma fonte só. Os casos de teste do vitest foram
--    portados para o harness PG17 para a cobertura não sumir junto.
--
--    À vista:   piso = cmc / (1 − aliquota)
--    Com prazo: S = média (1+r)^(−diasᵢ/365);  piso = cmc / (S − aliquota)      [Candidato A, LC 87/96]
--
--    Degradação idêntica à do TS: QUALQUER guard do prazo que falhar cai de volta no piso À VISTA
--    (nunca NULL, nunca fabricado) — é o `if (adj != null)` do helper antigo.
--
--    PURA (sem acesso a tabela) e por isso deliberadamente NÃO é SECURITY DEFINER: quem a chama já
--    precisa saber o cmc, então ela não revela nada. Ainda assim revogada — `private` NÃO é
--    barreira: `authenticated` tem USAGE no schema (nspacl medido 2026-07-20) e o schema não tem
--    default ACL, então função nova nasce executável por PUBLIC.
-- ────────────────────────────────────────────────────────────────────────────────────────────
-- ⚠️ `numeric` do Postgres ACEITA 'NaN' e '±Infinity', e as comparações mentem: `'NaN' > 0` é
-- TRUE e `12.00 < 'NaN'` é TRUE (NaN ordena como o MAIOR valor). Sem este guard, um cmc NaN em
-- inventory_position faria `piso_disponivel=true` e marcaria QUALQUER preço como abaixo do piso —
-- a régua gritando vermelho no catálogo inteiro. O TS que saiu daqui usava `Number.isFinite`;
-- a tradução para plpgsql tinha PERDIDO o guard (achado P1 do Codex, verificado no PG17).
-- Nota: `NaN = NaN` é TRUE em numeric (≠ IEEE), então o truque `v <> v` NÃO detecta NaN — daí a
-- comparação explícita com 'NaN'.
CREATE OR REPLACE FUNCTION private.regua_num_finito(v numeric)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT v IS NOT NULL
     AND v <> 'NaN'::numeric
     AND v > '-Infinity'::numeric
     AND v < 'Infinity'::numeric;
$$;

REVOKE ALL ON FUNCTION private.regua_num_finito(numeric) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.regua_piso_calc(
  p_cmc      numeric,
  p_aliquota numeric,
  p_dias     numeric[],
  p_taxa     numeric,
  OUT piso           numeric,
  OUT prazo_aplicado boolean
)
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_s          numeric;
  v_piso_prazo numeric;
  c_dia_max    constant numeric := 180;    -- p95 real OBEN = 60d; acima de 180 degrada
  c_max_parc   constant int     := 12;     -- espelha MAX_PARCELAS do parser TS
  c_eps        constant numeric := 1e-6;   -- gate de denominador (impede piso explosivo/negativo)
BEGIN
  piso := NULL;
  prazo_aplicado := false;

  -- ausente ≠ zero: sem cmc finito ou com alíquota fora de [0,1) não há piso — NULL, nunca número.
  IF NOT private.regua_num_finito(p_cmc) OR p_cmc <= 0 THEN RETURN; END IF;
  IF NOT private.regua_num_finito(p_aliquota) OR NOT (p_aliquota >= 0 AND p_aliquota < 1) THEN RETURN; END IF;

  -- ⚠️ SEM round() aqui: o piso ÍNTEGRO é o que decide `abaixo_piso`. Arredondar antes de comparar
  -- move a fronteira (cmc 12,40 / alíq 0,078 → piso 13,449023861…; a 4 casas, 13,44901 deixaria de
  -- ser "abaixo" e passaria a "saudável"). O arredondamento é de APRESENTAÇÃO e mora no payload/log.
  piso := p_cmc / (1 - p_aliquota);

  -- A partir daqui é o AJUSTE de prazo. Qualquer falha → mantém o piso à vista já calculado.
  IF p_dias IS NULL OR array_length(p_dias, 1) IS NULL THEN RETURN; END IF;
  -- o array vem do CLIENTE direto (antes passava por parsePrazoRecebimento, que capa em 12).
  -- ⚠️ `array_length(a,1)` só mede a PRIMEIRA dimensão: um 2×7 devolve 2, passa no cap, e o
  -- `unnest` processa 14 parcelas assim mesmo. Medido no PG17. Por isso ndims + cardinality.
  IF array_ndims(p_dias) <> 1 THEN RETURN; END IF;
  IF cardinality(p_dias) > c_max_parc THEN RETURN; END IF;
  IF NOT private.regua_num_finito(p_taxa) OR NOT (p_taxa > 0 AND p_taxa < 1) THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_dias) d
              WHERE NOT private.regua_num_finito(d) OR d < 0 OR d > c_dia_max) THEN RETURN; END IF;

  SELECT avg(power(1 + p_taxa, -d / 365.0)) INTO v_s FROM unnest(p_dias) d;
  IF NOT private.regua_num_finito(v_s) OR NOT (v_s - p_aliquota > c_eps) THEN RETURN; END IF;

  v_piso_prazo := p_cmc / (v_s - p_aliquota);
  IF NOT private.regua_num_finito(v_piso_prazo) OR v_piso_prazo <= 0 THEN RETURN; END IF;

  piso := v_piso_prazo;
  prazo_aplicado := true;
END;
$$;

COMMENT ON FUNCTION private.regua_piso_calc(numeric, numeric, numeric[], numeric) IS
  'FU4-F fase 2: fórmula do piso de MC (à vista e ajustada ao prazo). Migrada de calcPisoMC/'
  'pisoComPrazo, que saíram do TS — fonte ÚNICA. Pura; qualquer guard do prazo que falhe degrada '
  'para o piso à vista, nunca para NULL nem para número fabricado.';

REVOKE ALL ON FUNCTION private.regua_piso_calc(numeric, numeric, numeric[], numeric)
  FROM PUBLIC, anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 3) get_regua_preco — decide o piso no servidor e devolve SINAL, não custo
--
--    Sai do payload: `cmc` e `aliquota_venda` (juntos com o piso, dão o custo por aritmética).
--    Entra: `abaixo_piso` (a decisão) e `piso_disponivel` (distingue "acima do piso" de "sem dado
--    de custo" — sem ele o cliente leria ausência como folga, que é fabricar sinal).
--    `piso_mc`/`piso_gap_pct` só saem preenchidos para quem tem cap_custo_ler, pelo mesmo padrão
--    `v_pode_num` que o get_preco_cockpit já usa.
--
--    `precos_cliente` e `comparaveis` seguem ABERTOS de propósito: são preços de VENDA que a
--    própria vendedora praticou/pratica, não custo. Fechá-los mataria o benchmark sem fechar nada.
-- ────────────────────────────────────────────────────────────────────────────────────────────

-- A de 3 args tem de MORRER: sobrevivendo, ela continua devolvendo `cmc` e o fechamento é teatro.
-- (Nenhuma view e nenhuma outra função a referenciam — só a _customer360, recriada logo abaixo.)
DROP FUNCTION IF EXISTS public.get_regua_preco(uuid, uuid, numeric);

CREATE OR REPLACE FUNCTION public.get_regua_preco(
  p_customer    uuid,
  p_product     uuid,
  p_qty         numeric,
  p_preco_atual numeric,
  p_prazo_dias  numeric[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account      text := 'oben';
  v_cmc          numeric;
  v_aliquota     numeric;
  v_taxa         numeric;
  v_piso         numeric;   -- ÍNTEGRO: é o que decide `abaixo_piso`
  v_piso_exib    numeric;   -- APLICÁVEL: o mesmo piso arredondado p/ CIMA (ver abaixo)
  v_prazo_ok     boolean;
  v_abaixo       boolean;
  v_pode_num     boolean;
  v_precos_cli   numeric[];
  v_comparaveis  jsonb;
  -- p_qty não persiste, mas define a banda de comparáveis: não-finito faria BETWEEN sem sentido.
  v_qty_lo       numeric := CASE WHEN private.regua_num_finito(p_qty) THEN p_qty ELSE 0 END * 0.5;
  v_qty_hi       numeric := CASE WHEN private.regua_num_finito(p_qty) THEN p_qty ELSE 0 END * 2;
BEGIN
  -- gate de ENTRADA: somente staff (inalterado — a vendedora precisa do sinal)
  IF NOT (public.has_role((SELECT auth.uid()), 'employee') OR public.has_role((SELECT auth.uid()), 'master')) THEN
    RAISE EXCEPTION 'forbidden: regua_preco exige staff' USING ERRCODE = '42501';
  END IF;

  -- gate do NÚMERO: mesmo padrão de v_pode_num do get_preco_cockpit
  v_pode_num := private.cap_custo_ler((SELECT auth.uid()));

  -- CMC: account 'oben' preferido, fallback 'vendas' (espelhos)
  SELECT ip.cmc INTO v_cmc FROM public.inventory_position ip
   WHERE ip.product_id = p_product AND ip.account IN ('oben', 'vendas')
     AND private.regua_num_finito(ip.cmc) AND ip.cmc > 0
   ORDER BY (ip.account = 'oben') DESC LIMIT 1;

  SELECT COALESCE(
           (SELECT cc.value::numeric FROM public.company_config cc
             WHERE cc.key = 'regua_preco_aliquota_venda_oben'), 0.15) INTO v_aliquota;

  -- taxa do custo de capital: REUSA a RPC já provada (db/test-regua-custo-capital-money-path.sh)
  -- em vez de reimplementar o unit gate. Só é consultada quando há prazo a aplicar.
  IF p_prazo_dias IS NOT NULL AND array_length(p_prazo_dias, 1) IS NOT NULL THEN
    v_taxa := public.fin_regua_custo_capital(v_account);
  END IF;

  SELECT piso, prazo_aplicado INTO v_piso, v_prazo_ok
    FROM private.regua_piso_calc(v_cmc, v_aliquota, p_prazo_dias, v_taxa);

  -- ⚠️ CEIL, não ROUND (regressão introduzida pela correção de arredondamento da rodada 1 e pega
  -- na rodada 2). O número exposto vira `precoReferencia` e o botão "Aplicar piso" o joga no
  -- carrinho. Com round(), 13.449023861… vira 13.4490 — que continua ABAIXO do piso íntegro, então
  -- aplicar a sugestão mantém o vermelho e a vendedora fica num laço. Arredondar para CIMA na
  -- mesma escala garante que o valor devolvido, se aplicado, LIMPA o piso. Verificado no PG17.
  -- o round(,4) externo NÃO muda o valor (já está em 4 casas): normaliza a ESCALA, que a
  -- divisão infla para 16+ e vazaria como "13.4491000000000000" no jsonb.
  v_piso_exib := CASE WHEN v_piso IS NOT NULL THEN round(ceil(v_piso * 10000) / 10000, 4) END;

  -- A COMPARAÇÃO acontece AQUI. É o ponto inteiro desta migration: no cliente, ela viraria busca
  -- binária pelo piso. Sem preço ou sem piso → false (não fabrica sinal).
  v_abaixo := (private.regua_num_finito(p_preco_atual) AND p_preco_atual > 0
               AND v_piso IS NOT NULL AND p_preco_atual < v_piso);

  SELECT array_agg(oi.unit_price ORDER BY so.order_date_kpi DESC) INTO v_precos_cli
    FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
   WHERE so.account = v_account AND so.deleted_at IS NULL
     AND oi.product_id = p_product AND oi.customer_user_id = p_customer
     AND oi.unit_price > 0 AND so.order_date_kpi >= current_date - interval '180 days';

  WITH base AS (
    SELECT oi.unit_price, dense_rank() OVER (ORDER BY oi.customer_user_id) AS c_ord
      FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
     WHERE so.account = v_account AND so.deleted_at IS NULL
       AND oi.product_id = p_product AND oi.customer_user_id <> p_customer
       AND oi.unit_price > 0 AND oi.quantity BETWEEN v_qty_lo AND v_qty_hi
       AND so.order_date_kpi >= current_date - interval '180 days'
  )
  SELECT jsonb_agg(jsonb_build_object('preco', unit_price, 'c', c_ord)) INTO v_comparaveis FROM base;

  RETURN jsonb_build_object(
    -- SINAL (todo mundo que passa no gate de staff)
    'abaixo_piso',     v_abaixo,
    'piso_disponivel', v_piso IS NOT NULL,
    'cmc_confiavel',   v_cmc IS NOT NULL,
    'prazo_aplicado',  COALESCE(v_prazo_ok, false),
    -- NÚMERO (só cap_custo_ler). piso_gap_pct é invertível para o piso → mesmo gate.
    -- o piso APLICÁVEL (ceil) é o que sai; a decisão acima usou o íntegro. O gap sai do mesmo
    -- valor exposto, senão gap×preço reconstruiria um número que o botão não aplica.
    'piso_mc',         CASE WHEN v_pode_num THEN to_jsonb(v_piso_exib) ELSE 'null'::jsonb END,
    'piso_gap_pct',    CASE WHEN v_pode_num AND v_piso_exib IS NOT NULL
                             AND private.regua_num_finito(p_preco_atual) AND p_preco_atual > 0
                            THEN to_jsonb(round(v_piso_exib / p_preco_atual - 1, 6)) ELSE 'null'::jsonb END,
    -- MERCADO (preço de venda, não custo — aberto de propósito)
    'precos_cliente',  COALESCE(to_jsonb(v_precos_cli), '[]'::jsonb),
    'comparaveis',     COALESCE(v_comparaveis, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_regua_preco(uuid, uuid, numeric, numeric, numeric[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_regua_preco(uuid, uuid, numeric, numeric, numeric[]) TO authenticated;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 4) get_regua_preco_customer360 — recriada para a assinatura nova
--
--    Aqui o preço JÁ era resolvido no servidor (v_preco_atual = última venda real do cliente), então
--    mover a decisão custa zero: ela só repassa o que já tinha. Prazo NULL (o 360 é readonly, sem
--    condição de pagamento selecionada) → piso à vista, exatamente como hoje.
--    Recriada NA MESMA TRANSAÇÃO do DROP acima porque plpgsql é late-bound: fora dela, a 360
--    continuaria "válida" e só quebraria em RUNTIME, na frente da vendedora.
-- ────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_regua_preco_customer360(
  p_customer     uuid,
  p_omie_codigos bigint[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account        text := 'oben';
  v_codigos        bigint[];
  v_codigo         bigint;
  v_product_id     uuid;
  v_preco_atual    numeric;
  v_preco_atual_at date;
  v_qty_preco      numeric;
  v_pacote         jsonb;
  v_out            jsonb := '[]'::jsonb;
BEGIN
  IF NOT (public.has_role((SELECT auth.uid()), 'employee') OR public.has_role((SELECT auth.uid()), 'master')) THEN
    RAISE EXCEPTION 'forbidden: regua_preco exige staff' USING ERRCODE = '42501';
  END IF;

  SELECT array_agg(DISTINCT x) INTO v_codigos
    FROM unnest(COALESCE(p_omie_codigos, ARRAY[]::bigint[])) x
   WHERE x IS NOT NULL;

  IF v_codigos IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  FOREACH v_codigo IN ARRAY v_codigos LOOP
    v_product_id := NULL; v_preco_atual := NULL; v_preco_atual_at := NULL;
    v_qty_preco := NULL; v_pacote := NULL;

    SELECT oi.product_id INTO v_product_id
      FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
     WHERE so.account = v_account AND so.deleted_at IS NULL
       AND oi.customer_user_id = p_customer AND oi.omie_codigo_produto = v_codigo
       AND oi.product_id IS NOT NULL
     ORDER BY so.order_date_kpi DESC NULLS LAST, so.created_at DESC NULLS LAST, oi.id DESC
     LIMIT 1;

    IF v_product_id IS NULL THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'omie_codigo', v_codigo, 'hide_reason', 'sem_produto'));
      CONTINUE;
    END IF;

    SELECT oi.unit_price, so.order_date_kpi, oi.quantity
      INTO v_preco_atual, v_preco_atual_at, v_qty_preco
      FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
     WHERE so.account = v_account AND so.deleted_at IS NULL
       AND oi.customer_user_id = p_customer AND oi.product_id = v_product_id
       AND oi.unit_price > 0
     ORDER BY so.order_date_kpi DESC NULLS LAST, so.created_at DESC NULLS LAST, oi.id DESC
     LIMIT 1;

    IF v_preco_atual IS NULL THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'omie_codigo', v_codigo, 'product_id', v_product_id, 'hide_reason', 'sem_preco'));
      CONTINUE;
    END IF;

    IF v_qty_preco IS NULL OR v_qty_preco <= 0 THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'omie_codigo',    v_codigo,
        'product_id',     v_product_id,
        'preco_atual',    v_preco_atual,
        'preco_atual_at', v_preco_atual_at,
        'hide_reason',    'sem_quantidade'));
      CONTINUE;
    END IF;

    -- passa o preço que ela já tinha: a decisão do piso vem pronta de dentro.
    v_pacote := public.get_regua_preco(p_customer, v_product_id, v_qty_preco, v_preco_atual, NULL);

    v_out := v_out || jsonb_build_array(
      jsonb_build_object(
        'omie_codigo',    v_codigo,
        'product_id',     v_product_id,
        'preco_atual',    v_preco_atual,
        'preco_atual_at', v_preco_atual_at,
        'qty_ref',        v_qty_preco,
        'qty_ref_source', 'ultima_venda',
        'hide_reason',    NULL
      ) || COALESCE(v_pacote, '{}'::jsonb)
    );
  END LOOP;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.get_regua_preco_customer360(uuid, bigint[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_regua_preco_customer360(uuid, bigint[]) TO authenticated;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 5) Writers do log por RPC SECURITY DEFINER
--
--    ⚠️ POR QUE RPC E NÃO SÓ TROCAR A POLICY (o enunciado da fase acerta e vale registrar):
--    registrarExibicaoRegua faz `.insert().select('id').single()`, e o PostgREST exige policy de
--    SELECT para devolver a linha inserida. Fechando só a leitura, o INSERT passa e o RETURNING
--    é NEGADO — o Postgres ERRA, e o cliente engole (`console.warn`, "falha de log NUNCA derruba o
--    carrinho"). O outcome pararia de ser registrado EM SILÊNCIO, e o closed-loop morreria sem
--    nenhum sintoma visível.
--
--    A RPC também fecha o forjamento: salesperson_id é FIXADO em auth.uid() aqui dentro; não é
--    parâmetro. E as colunas de custo (piso_mc, cmc_usado, aliquota_usada) são calculadas AQUI —
--    o cliente não as tem mais para informar, e se as tivesse não seriam confiáveis.
-- ────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.registrar_exibicao_regua(
  p_account           text,
  p_customer_user_id  uuid,
  p_product_id        uuid,
  p_quantity          numeric,
  p_preco_atual       numeric,
  p_sinal_exibido     text,
  p_confianca         text,
  p_preco_referencia  numeric DEFAULT NULL,
  p_observed_gap_pct  numeric DEFAULT NULL,
  p_suggested_gap_pct numeric DEFAULT NULL,
  p_cap_limitou       boolean DEFAULT false,
  p_reason_codes      text[]  DEFAULT NULL,
  p_prazo_dias        numeric[] DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      uuid := (SELECT auth.uid());
  v_cmc      numeric;
  v_aliquota numeric;
  v_taxa     numeric;
  v_piso     numeric;
  v_id       uuid;
BEGIN
  -- capability de ESCRITA — NUNCA cap_custo_ler (§4.2; bloqueador P1 do Codex na fase 1)
  IF NOT private.cap_regua_log_escrever(v_uid) THEN
    RAISE EXCEPTION 'forbidden: registrar_exibicao_regua exige staff' USING ERRCODE = '42501';
  END IF;

  IF p_customer_user_id IS NULL OR p_product_id IS NULL OR p_preco_atual IS NULL
     OR p_sinal_exibido IS NULL OR p_confianca IS NULL OR p_account IS NULL THEN
    RAISE EXCEPTION 'registrar_exibicao_regua: campos obrigatorios ausentes' USING ERRCODE = '22004';
  END IF;

  -- fronteira de CONFIANÇA: estes numeric vêm do cliente e `numeric` aceita NaN/±Infinity. Uma
  -- linha com NaN contamina média, ordenação e o closed-loop inteiro depois. Obrigatório inválido
  -- REJEITA (a linha toda seria lixo); opcional inválido vira NULL — ausente ≠ número inventado.
  IF NOT private.regua_num_finito(p_preco_atual) OR p_preco_atual <= 0 THEN
    RAISE EXCEPTION 'registrar_exibicao_regua: preco_atual nao finito ou <= 0'
      USING ERRCODE = '22023';
  END IF;
  IF p_quantity IS NOT NULL AND NOT private.regua_num_finito(p_quantity) THEN
    RAISE EXCEPTION 'registrar_exibicao_regua: quantity nao finita' USING ERRCODE = '22023';
  END IF;

  -- custo apurado NO SERVIDOR (o cliente não o recebe mais, então não pode informá-lo)
  SELECT ip.cmc INTO v_cmc FROM public.inventory_position ip
   WHERE ip.product_id = p_product_id AND ip.account IN ('oben', 'vendas')
     AND private.regua_num_finito(ip.cmc) AND ip.cmc > 0
   ORDER BY (ip.account = 'oben') DESC LIMIT 1;

  SELECT COALESCE(
           (SELECT cc.value::numeric FROM public.company_config cc
             WHERE cc.key = 'regua_preco_aliquota_venda_oben'), 0.15) INTO v_aliquota;

  IF p_prazo_dias IS NOT NULL AND array_length(p_prazo_dias, 1) IS NOT NULL THEN
    v_taxa := public.fin_regua_custo_capital('oben');
  END IF;

  SELECT piso INTO v_piso FROM private.regua_piso_calc(v_cmc, v_aliquota, p_prazo_dias, v_taxa);

  INSERT INTO public.regua_preco_log (
    account, customer_user_id, product_id, salesperson_id, quantity, preco_atual,
    sinal_exibido, confianca, preco_referencia, observed_gap_pct, suggested_gap_pct,
    piso_mc, cap_limitou, cmc_usado, cmc_confianca, aliquota_usada, reason_codes,
    outcome_status, aplicou
  ) VALUES (
    p_account, p_customer_user_id, p_product_id, v_uid, p_quantity, p_preco_atual,
    p_sinal_exibido, p_confianca,
    -- opcionais: não-finito degrada para NULL em vez de persistir NaN
    CASE WHEN private.regua_num_finito(p_preco_referencia)  THEN p_preco_referencia  END,
    CASE WHEN private.regua_num_finito(p_observed_gap_pct)  THEN p_observed_gap_pct  END,
    CASE WHEN private.regua_num_finito(p_suggested_gap_pct) THEN p_suggested_gap_pct END,
    CASE WHEN v_piso IS NOT NULL THEN round(ceil(v_piso * 10000) / 10000, 4) END,
    COALESCE(p_cap_limitou, false), v_cmc,
    CASE WHEN v_cmc IS NOT NULL THEN 'real' ELSE 'proxy' END, v_aliquota,
    COALESCE(p_reason_codes, ARRAY[]::text[]),
    'pendente', false
  )
  RETURNING id INTO v_id;

  RETURN v_id;   -- só o id: nenhuma coluna de custo volta pro cliente
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_exibicao_regua(text, uuid, uuid, numeric, numeric, text, text, numeric, numeric, numeric, boolean, text[], numeric[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_exibicao_regua(text, uuid, uuid, numeric, numeric, text, text, numeric, numeric, numeric, boolean, text[], numeric[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.registrar_aplicacao_regua(
  p_log_id      uuid,
  p_preco_final numeric
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_n   int;
BEGIN
  IF NOT private.cap_regua_log_escrever(v_uid) THEN
    RAISE EXCEPTION 'forbidden: registrar_aplicacao_regua exige staff' USING ERRCODE = '42501';
  END IF;

  -- é o VALOR do desfecho: NaN aqui envenena qualquer análise de aceite depois.
  IF NOT private.regua_num_finito(p_preco_final) OR p_preco_final <= 0 THEN
    RAISE EXCEPTION 'registrar_aplicacao_regua: preco_final nao finito ou <= 0'
      USING ERRCODE = '22023';
  END IF;

  -- só o DONO do registro fecha o próprio loop. Sem isto, staff qualquer sobrescreveria o outcome
  -- de outra vendedora (a RPC é SECDEF, então a RLS não estaria lá para impedir).
  UPDATE public.regua_preco_log
     SET preco_final = p_preco_final, aplicou = true,
         outcome_status = 'aplicado', outcome_at = now()
   WHERE id = p_log_id AND salesperson_id = v_uid;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_aplicacao_regua(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_aplicacao_regua(uuid, numeric) TO authenticated;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 6) regua_preco_log — leitura fecha em cap_custo_ler; escrita só pelas RPCs acima
--
--    A policy de hoje é `FOR ALL` (employee OR master) e cobre USING e WITH CHECK de uma vez.
--    Ela é SUBSTITUÍDA, não complementada: policies permissivas combinam com OR, então acrescentar
--    uma restritiva ao lado não restringiria nada (§4.5 do spec).
--
--    Não há policy de INSERT/UPDATE: as RPCs são SECURITY DEFINER e escrevem com o privilégio do
--    owner. Isso é mais forte que uma policy de escrita — o cliente não tem NENHUM caminho direto
--    para a tabela, então não há o que forjar.
--
--    Colunas de custo fechadas por esta troca: piso_mc, cmc_usado e aliquota_usada. A terceira não
--    estava no enunciado da fase e é a pior das três: com piso_mc na mesma linha, ela dá o cmc
--    EXATO por divisão, sem precisar nem saber a alíquota global.
-- ────────────────────────────────────────────────────────────────────────────────────────────
-- ⚠️ RLS NÃO cobre TRUNCATE. O relacl medido em prod é `authenticated=arwdDxtm`, e o D é TRUNCATE
-- (x=REFERENCES, t=TRIGGER, m=MAINTAIN). Trocar policy não mexe em GRANT: sem este REVOKE, uma
-- sessão SQL como `authenticated` apagaria o log INTEIRO com a policy de leitura intacta, e a
-- afirmação "nenhum caminho direto para a tabela" seria falsa. O PostgREST não expõe TRUNCATE,
-- então não é explorável hoje pelas 2 vendedoras — é a primitiva que sobra para o dia em que for.
-- Devolve-se SÓ o SELECT: a ESCRITA é privilégio das RPCs SECURITY DEFINER, que rodam como owner.
-- `service_role` fica intacto de propósito (cron/edge).                    (achado P2 do Codex)
REVOKE ALL ON public.regua_preco_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.regua_preco_log TO authenticated;

DROP POLICY IF EXISTS regua_preco_log_staff_all ON public.regua_preco_log;
DROP POLICY IF EXISTS regua_preco_log_select_custo ON public.regua_preco_log;
CREATE POLICY regua_preco_log_select_custo ON public.regua_preco_log
  FOR SELECT TO authenticated
  USING ((SELECT private.cap_custo_ler((SELECT auth.uid()))));

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 7) ASSERTIONS — estruturais, não textuais (lição do #1465 §3)
-- ────────────────────────────────────────────────────────────────────────────────────────────
--    ⚠️ Todo assert sobre corpo de função roda sobre v_code = v_def SEM COMENTÁRIOS. Não é
--    preciosismo: a 1ª versão deste bloco procurava a substring `cap_custo_ler` no writer, e o
--    COMENTÁRIO do próprio writer ("NUNCA cap_custo_ler") satisfazia o assert — a migration
--    fiscalizando a si mesma pelo texto que ela escreve (a lição do #1472, apanhada aqui pelo
--    harness na 1ª execução). Mesmo stripComments que o scripts/lib/authz-contract.ts aplica.
DO $$
DECLARE v_n int; v_qual text; v_def text; v_code text;
BEGIN
  -- A1: a de 3 args MORREU. É o assert mais importante do bloco: viva, ela devolve `cmc` e nada
  -- mais nesta migration importa.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='get_regua_preco'
       AND pg_get_function_identity_arguments(p.oid) = 'uuid, uuid, numeric'
  ) THEN
    RAISE EXCEPTION 'FU4-F2 A1: get_regua_preco(uuid,uuid,numeric) ainda existe — continua devolvendo cmc'
      USING ERRCODE='raise_exception';
  END IF;

  -- A2: existe EXATAMENTE uma get_regua_preco (nenhum overload sobrando)
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_regua_preco';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FU4-F2 A2: esperava 1 get_regua_preco, ha %', v_n USING ERRCODE='raise_exception';
  END IF;

  -- A3: o corpo não devolve mais cmc nem aliquota_venda. Ancorado na CHAVE JSON com o valor ao
  -- lado (não na palavra solta): `v_cmc` continua existindo no corpo legitimamente, como insumo.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_regua_preco';
  v_code := regexp_replace(v_def, '--[^\n]*', '', 'g');
  IF v_code ~ '''cmc''\s*,\s*v_cmc' OR v_code ~ '''aliquota_venda''\s*,' THEN
    RAISE EXCEPTION 'FU4-F2 A3: get_regua_preco ainda emite cmc/aliquota_venda no payload'
      USING ERRCODE='raise_exception';
  END IF;

  -- A4: e o piso SAI GATEADO. Estrutural: a chamada com argumento, não o nome solto (lição #1472 —
  -- `.` casa newline no regex do Postgres, então nome solto casaria dentro de comentário).
  IF v_code !~ 'v_pode_num\s*:=\s*private\.cap_custo_ler\s*\(\s*\(\s*SELECT\s+auth\.uid\(\)\s*\)\s*\)\s*;' THEN
    RAISE EXCEPTION 'FU4-F2 A4: get_regua_preco sem o gate v_pode_num := private.cap_custo_ler(...)'
      USING ERRCODE='raise_exception';
  END IF;
  IF v_code !~ '''piso_mc''\s*,\s*CASE\s+WHEN\s+v_pode_num' THEN
    RAISE EXCEPTION 'FU4-F2 A4: piso_mc nao esta atras de v_pode_num' USING ERRCODE='raise_exception';
  END IF;
  IF v_code !~ '''piso_gap_pct''\s*,\s*CASE\s+WHEN\s+v_pode_num' THEN
    RAISE EXCEPTION 'FU4-F2 A4: piso_gap_pct nao esta atras de v_pode_num' USING ERRCODE='raise_exception';
  END IF;

  -- A5: a 360 foi recriada para a assinatura nova. Sem isto ela quebraria só em RUNTIME (late-bound).
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_regua_preco_customer360';
  v_code := regexp_replace(v_def, '--[^\n]*', '', 'g');
  IF v_code !~ 'get_regua_preco\s*\(\s*p_customer\s*,\s*v_product_id\s*,\s*v_qty_preco\s*,\s*v_preco_atual\s*,' THEN
    RAISE EXCEPTION 'FU4-F2 A5: _customer360 nao chama get_regua_preco com o preco (assinatura velha)'
      USING ERRCODE='raise_exception';
  END IF;

  -- A6: RLS ligada no log
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relname='regua_preco_log' AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'FU4-F2 A6: RLS desabilitada em regua_preco_log' USING ERRCODE='raise_exception';
  END IF;

  -- A7: inventário EXATO — 1 policy permissiva, de SELECT. Uma segunda permissiva (ou uma FOR ALL
  -- sobrevivente) reabriria a tabela por OR.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname='public' AND tablename='regua_preco_log' AND permissive='PERMISSIVE';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FU4-F2 A7: esperava 1 policy permissiva em regua_preco_log, ha %', v_n
      USING ERRCODE='raise_exception';
  END IF;

  SELECT qual INTO v_qual FROM pg_policies
   WHERE schemaname='public' AND tablename='regua_preco_log' AND policyname='regua_preco_log_select_custo'
     AND cmd='SELECT' AND permissive='PERMISSIVE' AND roles::text = '{authenticated}';
  IF v_qual IS NULL THEN
    RAISE EXCEPTION 'FU4-F2 A7: policy de leitura ausente ou com cmd/permissividade/roles fora do esperado'
      USING ERRCODE='raise_exception';
  END IF;
  IF v_qual !~ 'cap_custo_ler' THEN
    RAISE EXCEPTION 'FU4-F2 A7: policy nao gateia por cap_custo_ler (qual=%)', v_qual
      USING ERRCODE='raise_exception';
  END IF;
  IF v_qual ~* '\mor\M' THEN
    RAISE EXCEPTION 'FU4-F2 A7: expressao da policy contem disjuncao — gate ampliado (qual=%)', v_qual
      USING ERRCODE='raise_exception';
  END IF;

  -- A8: NENHUMA policy de escrita. A escrita é privilégio das RPCs; uma policy de INSERT reabriria
  -- o caminho direto e devolveria o forjamento de salesperson_id.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname='public' AND tablename='regua_preco_log' AND cmd IN ('INSERT','UPDATE','DELETE','ALL');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FU4-F2 A8: regua_preco_log tem % policy(s) de escrita — a escrita e so por RPC', v_n
      USING ERRCODE='raise_exception';
  END IF;

  -- A9: o helper do piso NÃO é executável por authenticated. `private` não é barreira (authenticated
  -- tem USAGE) e o schema não tem default ACL, então sem o REVOKE ele nasce aberto a PUBLIC.
  IF has_function_privilege('authenticated',
       'private.regua_piso_calc(numeric,numeric,numeric[],numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FU4-F2 A9: authenticated executa private.regua_piso_calc — REVOKE nao pegou'
      USING ERRCODE='raise_exception';
  END IF;

  -- A11: authenticated tem SÓ SELECT na tabela — nada de TRUNCATE/DELETE por fora da RLS.
  IF has_table_privilege('authenticated', 'public.regua_preco_log', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.regua_preco_log', 'INSERT')
     OR has_table_privilege('authenticated', 'public.regua_preco_log', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.regua_preco_log', 'DELETE') THEN
    RAISE EXCEPTION 'FU4-F2 A11: authenticated ainda tem privilegio de escrita/TRUNCATE no log'
      USING ERRCODE='raise_exception';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.regua_preco_log', 'SELECT') THEN
    RAISE EXCEPTION 'FU4-F2 A11: authenticated perdeu o SELECT — a policy de leitura ficaria inerte'
      USING ERRCODE='raise_exception';
  END IF;

  -- A12: o guard de finitude existe e MORDE. numeric aceita NaN/Infinity e `12 < NaN` é TRUE —
  -- sem isto, um cmc NaN marcaria todo preço como abaixo do piso.
  IF (SELECT piso FROM private.regua_piso_calc('NaN'::numeric, 0.078, NULL, NULL)) IS NOT NULL THEN
    RAISE EXCEPTION 'FU4-F2 A12: cmc NaN produziu piso — guard de finitude ausente'
      USING ERRCODE='raise_exception';
  END IF;
  IF (SELECT piso FROM private.regua_piso_calc('Infinity'::numeric, 0.078, NULL, NULL)) IS NOT NULL THEN
    RAISE EXCEPTION 'FU4-F2 A12: cmc Infinity produziu piso' USING ERRCODE='raise_exception';
  END IF;

  -- A10: a capability de escrita existe e é DISTINTA da de leitura (§4.2 em forma de assert)
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='private' AND p.proname='cap_regua_log_escrever') THEN
    RAISE EXCEPTION 'FU4-F2 A10: private.cap_regua_log_escrever ausente' USING ERRCODE='raise_exception';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='registrar_exibicao_regua';
  v_code := regexp_replace(v_def, '--[^\n]*', '', 'g');
  IF v_code ~ 'cap_custo_ler' THEN
    RAISE EXCEPTION 'FU4-F2 A10: writer do log gateado por cap_custo_ler — viola o 4.2 do spec'
      USING ERRCODE='raise_exception';
  END IF;
  IF v_code !~ 'NOT\s+private\.cap_regua_log_escrever\s*\(\s*v_uid\s*\)' THEN
    RAISE EXCEPTION 'FU4-F2 A10: writer sem o gate de escrita em forma de bloqueio'
      USING ERRCODE='raise_exception';
  END IF;
  -- salesperson_id é FIXADO, não recebido: nenhum parâmetro pode alimentá-lo.
  IF v_code ~* 'p_salesperson' THEN
    RAISE EXCEPTION 'FU4-F2 A10: writer aceita salesperson_id do cliente — forjavel'
      USING ERRCODE='raise_exception';
  END IF;
END $$;

COMMIT;
