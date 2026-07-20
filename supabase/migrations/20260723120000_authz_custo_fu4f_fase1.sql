-- ════════════════════════════════════════════════════════════════════════════════════════════
-- FU4-F fase 1 — leitura de CUSTO sai do role `employee` e passa para private.cap_custo_ler
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- CONTEXTO. O #1434 (E2/FU4) fechou o que o PAPEL comercial concede, mas o `COMMENT` da própria
-- private.cap_custo_ler declara o buraco que sobrou: o ROLE `employee` continua concedendo custo
-- por superfícies que não passam por commercial_role. Medido em prod 2026-07-18 (revisão adversária
-- Codex, rodada 2) e reconfirmado 2026-07-20 antes desta migration.
--
-- DECISÃO DE PRODUTO (dono, 2026-07-20): **o NÚMERO fecha, o SINAL fica.** A vendedora deixa de ver
-- "CMC R$ 12,40" mas continua vendo "abaixo do custo / abaixo do piso / saudável". Afeta 2 pessoas
-- reais (os 2 employees em prod, ambos commercial_role='farmer'). Não é hipotético — uma delas criou
-- 28.065 pedidos, o último 3 dias antes desta migration.
--
-- ⚠️ LIMITE HONESTO, declarado como o #1434 declarou o do E1: manter o sinal e tirar o número NÃO é
-- barreira de segurança. get_preco_cockpit continua sendo um ORÁCULO por bisseção — o caller escolhe
-- o preço e lê a faixa; variando o preço em busca binária reconstrói cmc/piso/meta com os campos
-- numéricos em NULL (e aceita 200 itens por chamada, então ~20 chamadas resolvem 200 SKUs). Isto é
-- barreira de CONVENIÊNCIA. Contra alguém tecnicamente competente e mal-intencionado a barreira real
-- é contrato e offboarding, não RLS. Fechar o oráculo custaria o sinal, que é a decisão de produto
-- acima — foi escolhido conscientemente MANTER o oráculo em troca da ferramenta de venda.
--
-- ESCOPO DESTA FASE. Só o que se resolve cirurgicamente, sem tocar UI nem writer:
--   1) cmc_snapshot           — policy SELECT → cap_custo_ler (ZERO consumidores no frontend)
--   2) regua_preco_log        — FOR ALL amplo → split SELECT/IUD com own-scope (preserva o writer)
--   3) get_tint_price(s)      — gate dos campos de custo → cap_custo_ler (precoFinal INTACTO)
--
-- FORA DESTA FASE (exigem mudança de corpo/UI, vão em PR próprio):
--   · inventory_position  — a policy é dupla E PERMISSIVA (`Staff can manage inventory` FOR ALL +
--     `staff_inventory_position_select`); permissivas combinam com OR, então fechar UMA não fecha
--     NADA. Além disso AdminEstoquePicking.tsx renderiza as colunas CMC/Preço Médio — fechar sem
--     tirar as colunas deixa a tela quebrada (fase 2).
--   · product_costs — useCrossSellEngine/useFarmerScoring/useBundleEngine baixam a tabela INTEIRA
--     para o browser e calculam margem no cliente. Fechar aqui QUEBRA os 3 engines; a correção é
--     mover a margem para o servidor primeiro (fase 3).
--   · get_regua_preco / get_regua_preco_customer360 — devolvem cmc/piso_mc sem gate de número (só
--     gate de entrada). Fechar a ENTRADA tiraria o SINAL da vendedora, contrariando a decisão de
--     produto; o certo é replicar o `v_pode_num` do cockpit, que é reescrita de corpo (fase 2).
--
-- Aplicada À MÃO pelo dono no SQL Editor do Lovable. Idempotente: pode reaplicar.
-- Prova: db/test-authz-custo-fu4f-fase1.sh (PG17 + falsificação).
-- ════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 0) PRECONDIÇÕES — aborta em vez de aplicar num banco divergente do medido
-- ────────────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Dependência dura: esta migration MIGRA PARA cap_custo_ler. Sem o #1434 aplicado, trocar o gate
  -- criaria policies que chamam função inexistente — RLS que falha em runtime = tabela ilegível.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'private' AND p.proname = 'cap_custo_ler'
  ) THEN
    RAISE EXCEPTION 'FU4-F: private.cap_custo_ler ausente — aplique o #1434 (20260718190000) ANTES'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF to_regprocedure('public.get_tint_price(uuid,text,numeric)') IS NULL
     AND to_regprocedure('public.get_tint_price(uuid,text)') IS NULL
     AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                      WHERE n.nspname='public' AND p.proname='get_tint_price') THEN
    RAISE EXCEPTION 'FU4-F: public.get_tint_price ausente — banco divergente do medido'
      USING ERRCODE = 'raise_exception';
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 1) cmc_snapshot — SELECT sai de `employee OR master` para a capability de custo
--    Medido: 26.167 linhas, policy `cmc_snapshot_select_staff`, ZERO consumidores em src/.
--    Wrap em subquery: SECDEF no USING reavalia POR LINHA sem InitPlan (database.md §4).
-- ────────────────────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS cmc_snapshot_select_staff ON public.cmc_snapshot;
CREATE POLICY cmc_snapshot_select_staff ON public.cmc_snapshot
  FOR SELECT TO authenticated
  USING ((SELECT private.cap_custo_ler((SELECT auth.uid()))));

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 2) regua_preco_log — `FOR ALL` amplo (BFLA) vira split assimétrico
--
--    O FOR ALL `employee OR master` deixava qualquer staff LER e MUTAR o log inteiro, inclusive as
--    linhas de outro vendedor — e as colunas piso_mc/cmc_usado são custo.
--
--    ⚠️ O SELECT NÃO pode ser fechado de todo: registrarExibicaoRegua faz `.insert().select('id')`
--    e o PostgREST exige SELECT policy para devolver a linha inserida. Sem own-scope o insert
--    devolveria null — e o erro é engolido de propósito ("falha de log NUNCA derruba o carrinho"),
--    então o outcome pararia de ser registrado EM SILÊNCIO. Own-scope preserva o writer e ainda
--    assim tira o log dos OUTROS vendedores. Padrão da casa (database.md §4: split do FOR ALL).
--
--    Vazamento residual assumido: a vendedora lê piso_mc/cmc_usado das PRÓPRIAS exibições — que é o
--    mesmo custo que a tela já lhe mostrou naquele instante. Não é exposição nova.
--    Estado hoje: 0 linhas e feature-flag `false` por default, então nada quebra na aplicação.
-- ────────────────────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS regua_preco_log_staff_all ON public.regua_preco_log;

CREATE POLICY regua_preco_log_select ON public.regua_preco_log
  FOR SELECT TO authenticated
  USING (
    (SELECT private.cap_custo_ler((SELECT auth.uid())))
    OR salesperson_id = (SELECT auth.uid())
  );

CREATE POLICY regua_preco_log_insert ON public.regua_preco_log
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT private.cap_custo_ler((SELECT auth.uid())))
    OR salesperson_id = (SELECT auth.uid())
  );

CREATE POLICY regua_preco_log_update ON public.regua_preco_log
  FOR UPDATE TO authenticated
  USING (
    (SELECT private.cap_custo_ler((SELECT auth.uid())))
    OR salesperson_id = (SELECT auth.uid())
  )
  WITH CHECK (
    (SELECT private.cap_custo_ler((SELECT auth.uid())))
    OR salesperson_id = (SELECT auth.uid())
  );

-- DELETE fica master-only: log de decisão de preço é evidência, ninguém apaga de rotina.
CREATE POLICY regua_preco_log_delete ON public.regua_preco_log
  FOR DELETE TO authenticated
  USING (public.has_role((SELECT auth.uid()), 'master'::public.app_role));

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 3) get_tint_price / get_tint_prices — o gate dos CAMPOS DE CUSTO passa a ser cap_custo_ler
--
--    Troca CIRÚRGICA por regexp sobre pg_get_functiondef, não reescrita do corpo: o repo diverge de
--    prod (apply manual) e um CREATE OR REPLACE por cima reverteria silenciosamente quem chegou
--    depois. Mesma técnica do #1434, com os mesmos guards (achado da rodada 2 do Codex: casar string
--    literal deixaria passar variante trivial e o guard MENTIRIA).
--
--    ⚠️ PROVADO ANTES DE ESCREVER (psql-ro, prod 2026-07-20): `precoFinal` é calculado ANTES do
--    bloco de mascaramento e sai SEM gate. Só custoBase/custoCorantes/itensCorantes passam pelo
--    predicado. Logo esta troca NÃO altera preço de balcão — invariante money-path coberto pelo
--    assert A3 do harness.
-- ────────────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_p     record;
  v_def   text;
  v_novo  text;
  v_ocorr int;
  -- o predicado de staff, tolerante a espaçamento/quebra de linha e ao `public.` opcional.
  -- Casa a expressão SEM os parênteses externos, para servir às DUAS formas medidas em prod:
  --   singular: `v_is_staff := auth.uid() IS NOT NULL AND ( ... );`
  --   plural:   `SELECT (auth.uid() IS NOT NULL AND ( ... )) AS is_staff`
  c_re_antigo constant text :=
    'auth\.uid\(\)\s+IS\s+NOT\s+NULL\s*AND\s*\(\s*(public\.)?has_role\s*\(\s*auth\.uid\(\)\s*,\s*''employee''::app_role\s*\)\s*OR\s*(public\.)?has_role\s*\(\s*auth\.uid\(\)\s*,\s*''master''::app_role\s*\)\s*\)';
  c_re_novo   constant text := 'private\.cap_custo_ler\s*\(';
BEGIN
  FOR v_p IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('get_tint_price','get_tint_prices')
  LOOP
    v_def := pg_get_functiondef(v_p.sig);

    -- IDEMPOTENTE: já migrada ⇒ segue (o dono cola à mão; erro de rede não pode travar a 2ª tentativa)
    IF v_def ~ c_re_novo AND v_def !~ c_re_antigo THEN
      CONTINUE;
    END IF;

    SELECT count(*) INTO v_ocorr FROM regexp_matches(v_def, c_re_antigo, 'g');
    IF v_ocorr <> 1 THEN
      RAISE EXCEPTION 'FU4-F: esperava 1 predicado de staff em %, encontrei % — inspecione pg_get_functiondef antes de prosseguir', v_p.sig, v_ocorr
        USING ERRCODE = 'raise_exception';
    END IF;

    v_novo := regexp_replace(v_def, c_re_antigo, 'private.cap_custo_ler(auth.uid())', 'g');

    IF v_novo = v_def THEN
      RAISE EXCEPTION 'FU4-F: padrao nao casou em % — nao aplicar no-op silencioso', v_p.sig
        USING ERRCODE = 'raise_exception';
    END IF;
    IF v_novo ~ c_re_antigo THEN
      RAISE EXCEPTION 'FU4-F: sobrou predicado antigo em % apos a troca', v_p.sig
        USING ERRCODE = 'raise_exception';
    END IF;
    IF v_novo !~ c_re_novo THEN
      RAISE EXCEPTION 'FU4-F: o gate NOVO nao aparece em % apos a troca', v_p.sig
        USING ERRCODE = 'raise_exception';
    END IF;

    EXECUTE v_novo;

    -- pós-check POSITIVO no objeto final: o guard acima valida a string que vamos executar;
    -- isto valida o que o catálogo REALMENTE guardou.
    IF pg_get_functiondef(v_p.sig) !~ c_re_novo THEN
      RAISE EXCEPTION 'FU4-F: pos-check falhou — % nao ficou com o gate novo', v_p.sig
        USING ERRCODE = 'raise_exception';
    END IF;
  END LOOP;
END $$;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 4) ASSERTIONS finais — fail-closed provado no próprio apply
-- ────────────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE v_orfas int;
BEGIN
  -- A1: nenhuma das tabelas tratadas pode ter sobrado com gate por role `employee`.
  SELECT count(*) INTO v_orfas
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('cmc_snapshot','regua_preco_log')
     AND COALESCE(qual,'') || COALESCE(with_check,'') LIKE '%''employee''::app_role%';
  IF v_orfas > 0 THEN
    RAISE EXCEPTION 'FU4-F A1: % policy(ies) ainda gateiam custo por role employee', v_orfas
      USING ERRCODE = 'raise_exception';
  END IF;

  -- A2: uid inexistente não recebe capability (fail-closed, não fail-open).
  IF private.cap_custo_ler('00000000-0000-0000-0000-000000000000'::uuid) THEN
    RAISE EXCEPTION 'FU4-F A2: uid inexistente recebeu capability — nao esta fail-closed'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- A3: o DELETE do log não pode ter ficado aberto a staff.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='regua_preco_log' AND cmd='DELETE'
       AND COALESCE(qual,'') LIKE '%employee%'
  ) THEN
    RAISE EXCEPTION 'FU4-F A3: DELETE do log ficou aberto a employee'
      USING ERRCODE = 'raise_exception';
  END IF;
END $$;

COMMIT;
