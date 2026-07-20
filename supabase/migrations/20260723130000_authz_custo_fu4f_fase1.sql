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
-- é contrato e offboarding, não RLS. Foi escolhido conscientemente MANTER o oráculo em troca da
-- ferramenta de venda.
--
-- ESCOPO DESTA FASE — só superfícies SEM writer e SEM UI envolvidos:
--   1) cmc_snapshot      — policy SELECT → cap_custo_ler (ZERO consumidores no frontend)
--   2) get_tint_price(s) — gate dos campos de custo → cap_custo_ler (precoFinal INTACTO)
--
-- FORA, com motivo:
--   · regua_preco_log + get_regua_preco/_customer360 — MESMO SUBSISTEMA (o log é escrito pelas telas
--     que consomem as RPCs), tratados juntos na fase 2. Fechar a leitura do log exige trocar o writer
--     por RPC SECURITY DEFINER: hoje registrarExibicaoRegua faz `.insert().select('id')`, e o
--     PostgREST exige SELECT policy para devolver a linha (o Postgres ERRA; o `null` vem do cliente
--     engolindo o erro). Recortar o log para cá foi erro de agrupamento, corrigido na revisão.
--   · inventory_position — policy DUPLA e permissiva (combinam com OR → fechar uma não fecha nada) e
--     a tabela MISTURA operacional (saldo) com custo (cmc/preco_medio). RLS filtra linha, não coluna,
--     então fechar tira o saldo da vendedora junto. Precisa de view operacional (fase 3).
--   · product_costs — useCrossSellEngine/useFarmerScoring/useBundleEngine baixam a tabela INTEIRA
--     para o browser e calculam margem no cliente. Fechar QUEBRA os 3 engines (fase 3).
--
-- REVISÃO ADVERSÁRIA: Codex gpt-5.6-sol xhigh, 2026-07-20. Derrubou a versão anterior desta
-- migration com 4 bloqueadores P1. Corrigidos aqui: regexp ancorado no contexto sintático (§2),
-- precondição cobrindo AS DUAS funções, idempotência REAL (provada com 2 aplicações no PG17),
-- assertions estruturais em vez de textuais (§3). O 4º bloqueador — capability de LEITURA usada como
-- autorização de ESCRITA no log, que violava o §4.2 do spec do #1434 — foi resolvido REMOVENDO o log
-- desta fase, não remendando o predicado.
--
-- Aplicada À MÃO pelo dono no SQL Editor do Lovable.
-- Prova: db/test-authz-custo-fu4f-fase1.sh (PG17, baseline pré-migration + falsificação ancorada).
-- ════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 0) PRECONDIÇÕES — aborta em vez de aplicar num banco divergente do medido
-- ────────────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE v_faltando text;
BEGIN
  -- Dependência dura: esta migration MIGRA PARA cap_custo_ler. Sem o #1434 aplicado, trocar o gate
  -- criaria referência a função inexistente — RLS que falha em runtime = tabela ilegível.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'private' AND p.proname = 'cap_custo_ler'
  ) THEN
    RAISE EXCEPTION 'FU4-F: private.cap_custo_ler ausente — aplique o #1434 (20260718190000) ANTES'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- AS DUAS funções de tinta têm de existir. Exigir só uma deixaria a outra sumir e a migration
  -- "terminar com sucesso" sem migrar nada nela (achado do Codex: precondição incompleta).
  SELECT string_agg(f, ', ') INTO v_faltando
    FROM unnest(ARRAY['get_tint_price','get_tint_prices']) AS f
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                      WHERE n.nspname='public' AND p.proname = f);
  IF v_faltando IS NOT NULL THEN
    RAISE EXCEPTION 'FU4-F: funcao(oes) ausente(s): % — banco divergente do medido', v_faltando
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='cmc_snapshot') THEN
    RAISE EXCEPTION 'FU4-F: public.cmc_snapshot ausente — banco divergente do medido'
      USING ERRCODE = 'raise_exception';
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 1) cmc_snapshot — SELECT sai de `employee OR master` para a capability de custo
--    Medido: 26.167 linhas, policy `cmc_snapshot_select_staff`, ZERO consumidores em src/.
--    Wrap em subquery: SECDEF no USING reavalia POR LINHA sem InitPlan (database.md §4).
--    Idempotente: DROP IF EXISTS + CREATE do MESMO nome (reaplicar é no-op).
-- ────────────────────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS cmc_snapshot_select_staff ON public.cmc_snapshot;
CREATE POLICY cmc_snapshot_select_staff ON public.cmc_snapshot
  FOR SELECT TO authenticated
  USING ((SELECT private.cap_custo_ler((SELECT auth.uid()))));

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 2) get_tint_price / get_tint_prices — o gate dos CAMPOS DE CUSTO passa a ser cap_custo_ler
--
--    Troca CIRÚRGICA por regexp sobre pg_get_functiondef, não reescrita do corpo: o repo diverge de
--    prod (apply manual) e um CREATE OR REPLACE por cima reverteria silenciosamente quem chegou
--    depois. Mesma técnica do #1434.
--
--    ⚠️ ANCORAGEM SINTÁTICA (correção do Codex sobre a 1ª versão): o padrão NÃO pode ser o predicado
--    solto. Solto, ele casaria comentário, string, SQL dinâmico, ou uma SUBSEQUÊNCIA de expressão
--    maior — o contra-exemplo dele: em `NOT auth.uid() IS NOT NULL AND (...)` a troca consumiria o
--    `AND (...)` e deixaria `NOT cap_custo_ler(...)`, semântica DIFERENTE e possivelmente ABERTA.
--    Por isso há DOIS padrões, cada um ancorado no seu contexto de atribuição:
--        plpgsql: `v_is_staff := <pred>;`
--        sql:     `SELECT (<pred>) AS is_staff`
--    e o pós-check exige o gate novo NO MESMO contexto, não em qualquer lugar do corpo.
--
--    ⚠️ PROVADO ANTES DE ESCREVER (psql-ro, prod 2026-07-20): `precoFinal` é calculado ANTES do
--    bloco de mascaramento e sai SEM gate. Só custoBase/custoCorantes/itensCorantes passam pelo
--    predicado. O harness prova isso com BASELINE capturado ANTES da migration (assert A5/A6) —
--    a versão anterior comparava só farmer×master DEPOIS, e teria ficado verde se o preço mudasse
--    igualmente para os dois.
-- ────────────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_p     record;
  v_def   text;
  v_novo  text;
  v_hits  int;
  c_pred constant text :=
    'auth\.uid\(\)\s+IS\s+NOT\s+NULL\s*AND\s*\(\s*(?:public\.)?has_role\s*\(\s*auth\.uid\(\)\s*,\s*''employee''::app_role\s*\)\s*OR\s*(?:public\.)?has_role\s*\(\s*auth\.uid\(\)\s*,\s*''master''::app_role\s*\)\s*\)';
  c_re_plpgsql text;
  c_re_sql     text;
  c_novo_plpgsql constant text := 'v_is_staff\s*:=\s*private\.cap_custo_ler\s*\(\s*auth\.uid\(\)\s*\)';
  c_novo_sql     constant text := 'SELECT\s*\(?\s*private\.cap_custo_ler\s*\(\s*auth\.uid\(\)\s*\)\s*\)?\s+AS\s+is_staff';
BEGIN
  c_re_plpgsql := 'v_is_staff\s*:=\s*' || c_pred || '\s*;';
  c_re_sql     := 'SELECT\s*\(\s*' || c_pred || '\s*\)\s+AS\s+is_staff';

  FOR v_p IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('get_tint_price','get_tint_prices')
     ORDER BY p.proname
  LOOP
    v_def := pg_get_functiondef(v_p.sig);

    -- IDEMPOTENTE: já migrada ⇒ segue. Exige o gate NOVO no CONTEXTO certo — não basta a string
    -- aparecer em qualquer lugar (um comentário com o nome não conta como migrada).
    IF (v_def ~ c_novo_plpgsql OR v_def ~ c_novo_sql)
       AND v_def !~ c_re_plpgsql AND v_def !~ c_re_sql THEN
      CONTINUE;
    END IF;

    SELECT (SELECT count(*) FROM regexp_matches(v_def, c_re_plpgsql, 'g'))
         + (SELECT count(*) FROM regexp_matches(v_def, c_re_sql, 'g'))
      INTO v_hits;
    IF v_hits <> 1 THEN
      RAISE EXCEPTION 'FU4-F: esperava 1 gate ancorado em %, encontrei % — inspecione pg_get_functiondef antes de prosseguir', v_p.sig, v_hits
        USING ERRCODE = 'raise_exception';
    END IF;

    v_novo := regexp_replace(v_def, c_re_plpgsql, 'v_is_staff := private.cap_custo_ler(auth.uid());', 'g');
    v_novo := regexp_replace(v_novo, c_re_sql,     'SELECT (private.cap_custo_ler(auth.uid())) AS is_staff', 'g');

    IF v_novo = v_def THEN
      RAISE EXCEPTION 'FU4-F: padrao ancorado nao casou em % — nao aplicar no-op silencioso', v_p.sig
        USING ERRCODE = 'raise_exception';
    END IF;
    IF v_novo ~ c_re_plpgsql OR v_novo ~ c_re_sql THEN
      RAISE EXCEPTION 'FU4-F: sobrou gate antigo em % apos a troca', v_p.sig
        USING ERRCODE = 'raise_exception';
    END IF;

    EXECUTE v_novo;

    -- pós-check POSITIVO no objeto final, NO CONTEXTO (não "a string existe em algum lugar")
    v_def := pg_get_functiondef(v_p.sig);
    IF NOT (v_def ~ c_novo_plpgsql OR v_def ~ c_novo_sql) THEN
      RAISE EXCEPTION 'FU4-F: pos-check falhou — % nao ficou com o gate novo NO CONTEXTO', v_p.sig
        USING ERRCODE = 'raise_exception';
    END IF;
    IF v_def ~ c_pred THEN
      RAISE EXCEPTION 'FU4-F: pos-check falhou — sobrou o predicado antigo em %', v_p.sig
        USING ERRCODE = 'raise_exception';
    END IF;
  END LOOP;
END $$;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 3) ASSERTIONS finais — ESTRUTURAIS, não textuais
--
--    O Codex derrubou a versão anterior destes asserts: `LIKE '%employee%'` é smoke test — uma
--    policy `USING(true)` ou um wrapper `is_staff()` passariam sem conter o literal procurado.
--    Aqui a prova é estrutural: RLS ligada, inventário EXATO das permissivas, e a expressão
--    contendo a capability certa.
-- ────────────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE v_n int; v_qual text;
BEGIN
  -- A1: RLS realmente habilitada (policy em tabela com RLS off não protege nada)
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relname='cmc_snapshot' AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'FU4-F A1: RLS desabilitada em cmc_snapshot' USING ERRCODE='raise_exception';
  END IF;

  -- A2: inventário EXATO — exatamente 1 policy permissiva que conceda leitura. Permissivas combinam
  -- com OR, então uma segunda (mesmo "inofensiva") reabriria a tabela.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname='public' AND tablename='cmc_snapshot'
     AND cmd IN ('SELECT','ALL') AND permissive='PERMISSIVE';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FU4-F A2: esperava 1 policy permissiva de leitura em cmc_snapshot, ha %', v_n
      USING ERRCODE='raise_exception';
  END IF;

  -- A3: e ela gateia pela capability de custo (não `true`, não outro gate)
  SELECT qual INTO v_qual FROM pg_policies
   WHERE schemaname='public' AND tablename='cmc_snapshot' AND policyname='cmc_snapshot_select_staff';
  IF v_qual IS NULL OR v_qual !~ 'cap_custo_ler' THEN
    RAISE EXCEPTION 'FU4-F A3: policy de cmc_snapshot nao gateia por cap_custo_ler (qual=%)', COALESCE(v_qual,'NULL')
      USING ERRCODE='raise_exception';
  END IF;

  -- A4: fail-closed — uid inexistente não recebe capability
  IF private.cap_custo_ler('00000000-0000-0000-0000-000000000000'::uuid) THEN
    RAISE EXCEPTION 'FU4-F A4: uid inexistente recebeu capability — nao esta fail-closed'
      USING ERRCODE='raise_exception';
  END IF;

  -- A5: as DUAS funções de tinta ficaram com o gate novo
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname IN ('get_tint_price','get_tint_prices')
     AND pg_get_functiondef(p.oid) ~ 'private\.cap_custo_ler';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'FU4-F A5: esperava 2 funcoes de tinta com o gate novo, ha %', v_n
      USING ERRCODE='raise_exception';
  END IF;
END $$;

COMMIT;
