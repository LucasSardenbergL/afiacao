-- ════════════════════════════════════════════════════════════════════════════════════════════
-- FU4-F fase 2 — inventory_position: custo sai do role `employee`, saldo continua operacional
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- CONTEXTO. O #1465 (fase 1) fechou cmc_snapshot, regua_preco_log e get_tint_price(s), e declarou
-- inventory_position FORA daquela fase por dois motivos corretos: (a) a policy é DUPLA e permissiva
-- — permissivas combinam com OR, então fechar UMA não fecha NADA; (b) AdminEstoquePicking.tsx
-- renderiza as colunas CMC/Preço Médio, e fechar sem tirar as colunas deixa a tela quebrada.
-- Esta migration resolve os dois: fecha AS DUAS policies e cria a porta operacional sem custo.
--
-- DECISÃO DE PRODUTO (dono, 2026-07-20). Confirmado nesta sessão: **reposição/compras é trabalho do
-- dono (master)**, não dos 2 employees (ambos commercial_role='farmer'). Logo o fechamento aqui é
-- TOTAL — não há persona de comprador que precise de custo em inventory_position.
--
-- O PONTO DE DESIGN, decidido explicitamente. RLS filtra LINHA, não COLUNA, e o separador precisa
-- do `saldo` que mora na MESMA tabela do `cmc`. Três saídas eram plausíveis; escolhida a (a):
--   (a) VIEW operacional sem colunas de custo + fecha a tabela  ← ESTA
--   (b) RPC de saldo que não projeta custo
--   (c) só o frontend parar de selecionar as colunas
-- (c) foi RECUSADA: é "não mostrar", não "não poder" — o dado seguiria trafegando e visível no
-- DevTools, contrariando a decisão de fechar no BANCO. Entre (a) e (b), (a) venceu por três razões:
--   1. PRECEDENTE VIVO: selfservice_disponibilidade é exatamente esta construção (view sobre
--      inventory_position, security_invoker=off, gate próprio, projeção mínima). (b) inventaria um
--      segundo padrão para o mesmo problema na mesma tabela.
--   2. FALHA FECHADA: se um replace futuro errar o security_invoker, a view herda a RLS fechada e o
--      separador perde acesso — alguém reclama na hora. Em (b), um RETURNS TABLE editado para
--      incluir cmc vaza em silêncio.
--   3. DROP-IN no PostgREST: view é relação, então `count:'exact', head:true` (usado pelo card de
--      SKUs críticos) sobrevive sem RPC extra.
--
-- ⛔ O QUE ESTA MIGRATION **NÃO** FAZ — leia antes de dizer que "o vendedor não vê custo".
-- Ela NÃO fecha o custo. Reduz superfície. Duas portas paralelas seguem abertas ao employee, e a
-- primeira torna o contorno TRIVIAL (achado do Codex xhigh, confirmado em prod 2026-07-20):
--   1. **product_costs.cmc é uma CÓPIA de inventory_position.cmc** — escrita pela edge
--      omie-analytics-sync (index.ts:1227); 2.987 linhas casam exatamente em prod hoje. Suas 2
--      policies são `master OR employee`, sem cap_custo_ler. E como a view operacional projeta
--      `product_id`, o contorno é um JOIN de uma linha:
--          SELECT o.omie_codigo_produto, c.cmc
--            FROM inventory_position_operacional o
--            JOIN product_costs c ON c.product_id = o.product_id;
--      Fechar product_costs exige antes mover o cálculo de margem dos 3 engines para o servidor
--      (useCrossSellEngine/useFarmerScoring/useBundleEngine leem a tabela inteira no browser) —
--      é a fase 3, e sem ela o fechamento APAGA feature.
--   2. **get_regua_preco devolve `cmc` cru** ao employee (gate só de entrada). Ver "FORA DESTA
--      FASE" abaixo: mascarar lá mata o SINAL junto com o número, então exige redesenho.
-- ⇒ O ganho REAL desta fase: a tela de chão de fábrica para de exibir custo, a tabela deixa de ser
--   uma porta aberta, e o limite fica TRAVADO EM TESTE (assert L1 do harness falha de propósito
--   quando product_costs mudar). É hardening honesto, não fechamento.
--
-- ⚠️ ESTA MIGRATION TIRA ACESSO DE GENTE VIVA. Os 2 employees deixam de ler cmc/preco_medio
-- diretamente de inventory_position (PostgREST, DevTools, view). Efeito colateral
-- DELIBERADO e medido: v_sku_parametros_sugeridos é `security_invoker=on` e projeta CMC, logo herda
-- a RLS desta tabela e fecha junto para eles — 6 telas de reposição (SkuDetailSheet, useEmbalagem*,
-- useNegociacaoParalela, useRevisaoParametros, useBaixoGiro). É aceitável porque reposição é do
-- dono (decisão acima), e o master passa em cap_custo_ler.
--
-- IMUNES (verificado): as 6 funções SECURITY DEFINER que leem a tabela (get_preco_cockpit,
-- get_defasagem_cliente, get_regua_preco, fin_estimar_estoque_omie, medir_abaixo_piso_tier,
-- _data_health_compute) bypassam RLS e mantêm gate próprio; as edges usam service_role.
--
-- FORA DESTA FASE, de propósito:
--   · get_regua_preco / get_regua_preco_customer360 — replicar o v_pode_num do cockpit NÃO
--     preserva o sinal aqui. get_preco_cockpit RECEBE o preço e calcula a faixa no SERVIDOR; a
--     régua NÃO recebe o preço e o cliente deriva o piso de `cmc` cru (calcPisoMC em
--     regua-preco-helpers.ts:105). Mascarar cmc ⇒ pisoMC null ⇒ abaixoPiso=false ⇒ o sinal 'piso'
--     NUNCA dispara: mataria o SINAL junto com o NÚMERO, contrariando "o número fecha, o sinal
--     fica". Preservar o sinal exige mudar a ASSINATURA da RPC (receber o preço) e o contrato com
--     o motor do cliente — PR próprio, não um apêndice deste.
--   · product_costs — os 3 engines (useCrossSellEngine/useFarmerScoring/useBundleEngine) calculam
--     margem no CLIENTE lendo a tabela inteira. Fechar antes de mover o cálculo pro servidor APAGA
--     feature. Fase 3.
--
-- Aplicada À MÃO pelo dono no SQL Editor do Lovable. Idempotente: pode reaplicar.
-- Prova: db/test-authz-custo-fu4f-fase2.sh (PG17 + falsificação).
-- ════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 0) PRECONDIÇÕES — aborta em vez de aplicar num banco divergente do medido
-- ────────────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Dependência dura: esta migration MIGRA PARA cap_custo_ler. Sem o #1434 (20260718190000)
  -- aplicado, o CREATE POLICY falharia com 42883 e a transação inteira aborta — melhor abortar
  -- aqui, com mensagem que diz o que fazer.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'private' AND p.proname = 'cap_custo_ler'
  ) THEN
    RAISE EXCEPTION 'FU4-F fase 2: private.cap_custo_ler ausente — aplique o #1434 (20260718190000) ANTES';
  END IF;

  -- A tabela precisa existir e ter RLS ligada. Sem RLS, fechar policy é teatro: o GRANT amplo de
  -- fábrica do Supabase (anon/authenticated = arwdDxtm) passa a valer sem filtro nenhum.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid = 'public.inventory_position'::regclass AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'FU4-F fase 2: inventory_position sem RLS ligada — abortando (fechar policy sem RLS é no-op)';
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 1) inventory_position — AS DUAS policies passam a exigir cap_custo_ler
-- ────────────────────────────────────────────────────────────────────────────────────────────
-- ⚠️ O PONTO QUE FAZ ESTA MIGRATION EXISTIR: policies permissivas combinam com **OR**, e
-- `Staff can manage inventory` é FOR ALL (cobre SELECT). Trocar apenas a policy _select deixaria o
-- vendedor lendo custo pela outra — fechamento FANTASMA, que passa em qualquer teste que só
-- exercite a policy trocada. As duas mudam no mesmo commit ou nenhuma muda.
--
-- Wrap InitPlan preservado: `(SELECT private.cap_custo_ler((SELECT auth.uid())))`. Sem ele, uma
-- SECURITY DEFINER no USING reavalia POR LINHA (o planner não inlina SECDEF) e estoura o
-- statement_timeout do PostgREST — database.md §4. As duas policies em prod JÁ estavam wrapped;
-- perder o wrap aqui seria uma regressão de performance invisível ao teste de autorização.
--
-- A escrita fecha junto (FOR ALL): a tabela é alimentada por sync via service_role, que tem
-- rolbypassrls — nenhum writer legítimo passa por estas policies.

DROP POLICY IF EXISTS "Staff can manage inventory" ON public.inventory_position;
CREATE POLICY "Staff can manage inventory"
  ON public.inventory_position
  FOR ALL
  TO public
  USING       ((SELECT private.cap_custo_ler((SELECT auth.uid()))))
  WITH CHECK  ((SELECT private.cap_custo_ler((SELECT auth.uid()))));

DROP POLICY IF EXISTS staff_inventory_position_select ON public.inventory_position;
CREATE POLICY staff_inventory_position_select
  ON public.inventory_position
  FOR SELECT
  TO authenticated
  USING ((SELECT private.cap_custo_ler((SELECT auth.uid()))));

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 2) inventory_position_operacional — a porta do separador: saldo SIM, custo NÃO
-- ────────────────────────────────────────────────────────────────────────────────────────────
-- `security_invoker = off` é DELIBERADO, não esquecimento: a view precisa ler a tabela como OWNER
-- justamente porque a RLS da base agora exige cap_custo_ler, que o separador não tem. O gate da
-- autorização mora no WHERE desta view — mesmo padrão de selfservice_disponibilidade e do
-- v_oportunidade_economica_hoje_badge_cached.
--
-- ⚠️ Num `off`, o WHERE é a ÚNICA autorização que existe. Ele replica o gate ORIGINAL da tabela
-- (employee OR master) — e NÃO cap_custo_ler, senão a view não serviria a ninguém além do master e
-- o separador ficaria sem saldo, que é o ponto todo desta fase.
--
-- security_barrier=true impede que um predicado do caller vaze para dentro antes do gate.
-- Null-hardened: has_role fora de COALESCE devolveria NULL (não false) e NULL no WHERE já filtra,
-- mas o COALESCE torna a intenção explícita e sobrevive a refactor.
--
-- A projeção OMITE cmc e preco_medio. Não é "esconder": as colunas não existem nesta relação, então
-- não há `.select('cmc')` possível — o PostgREST responde 42703. É a diferença entre "não mostrar"
-- e "não poder", que é a decisão do dono.

-- `DROP`+`CREATE`, e NÃO `CREATE OR REPLACE` — decidido MEDINDO, contra a sugestão do Codex xhigh.
-- Ele apontou (corretamente) que o DROP falha na reaplicação assim que existir view dependente.
-- Mas trocar por REPLACE quebrou o harness com `cannot drop columns from view`: um REPLACE só
-- ACRESCENTA coluna no fim, nunca REMOVE. Consequência inaceitável aqui — se alguém adicionar
-- `cmc` a esta view, a migration perderia a capacidade de tirá-la ao reaplicar, e o vazamento
-- sobreviveria ao próprio conserto. A propriedade que mais importa nesta relação é a PROJEÇÃO
-- EXATA (allowlist sem custo), então ela vence: o DROP falha ALTO e visível se houver dependente
-- (hoje não há), enquanto o REPLACE falharia BAIXO, deixando a coluna de custo no lugar.
-- `CASCADE` está fora de questão — dropa o dependente em silêncio.
DROP VIEW IF EXISTS public.inventory_position_operacional;
CREATE VIEW public.inventory_position_operacional
  WITH (security_invoker = off, security_barrier = true) AS
SELECT
  ip.id,
  ip.omie_codigo_produto,
  ip.product_id,
  ip.saldo,
  ip.account,
  ip.synced_at
FROM public.inventory_position ip
WHERE (SELECT auth.role()) = 'service_role'
   OR COALESCE((SELECT public.has_role((SELECT auth.uid()), 'employee'::public.app_role)), false)
   OR COALESCE((SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role)), false);

COMMENT ON VIEW public.inventory_position_operacional IS
  'FU4-F fase 2 — porta OPERACIONAL de inventory_position: saldo e identidade do SKU, SEM cmc/preco_medio. '
  'security_invoker=off é deliberado (lê a base como owner porque a RLS da base exige cap_custo_ler); '
  'a autorização é o WHERE, que replica o gate original staff (employee OR master). '
  'Consumidor: AdminEstoquePicking (aba Estoque + card de SKUs críticos) e useBaixoGiro. '
  'Quem precisa de CUSTO usa a tabela e passa por cap_custo_ler.';

-- ACL da view. O default privilege do Supabase concede arwdDxtm a anon/authenticated/service_role
-- em TODA relação nova (pg_default_acl) — a view nasce ABERTA, inclusive para `anon`. O REVOKE
-- explícito ANTES do GRANT é obrigatório; sem ele a view seria legível SEM LOGIN (foi assim que o
-- #1375 vazou 5 views, uma delas para anon).
-- ⚠️ Não confundir com a tabela: em inventory_position o grant amplo é SISTÊMICO e inócuo (a RLS
-- filtra), e revogá-lo em massa brigaria com o modelo da plataforma (database.md §4). Aqui é
-- diferente — a view é `invoker=off`, então NÃO há RLS por baixo para salvar: o ACL é a 2ª barreira.
REVOKE ALL ON public.inventory_position_operacional FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.inventory_position_operacional TO authenticated, service_role;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- VALIDAÇÃO PÓS-APPLY (read-only — pode colar separado)
-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Ancorada em EFEITO/VALOR, não na representação textual do catálogo: reloptions preserva o
-- LITERAL do WITH (=on/=true/=off) e pg_get_viewdef re-serializa a definição, então casar sintaxe
-- dá falso-negativo (database.md §4).
--
-- SELECT
--   (SELECT count(*) FROM pg_policies
--     WHERE schemaname='public' AND tablename='inventory_position'
--       AND qual ILIKE '%cap_custo_ler%')                                    AS policies_fechadas,  -- esperado 2
--   (SELECT count(*) FROM pg_policies
--     WHERE schemaname='public' AND tablename='inventory_position'
--       AND qual ILIKE '%has_role%')                                         AS policies_antigas,   -- esperado 0
--   (SELECT count(*) FROM information_schema.columns
--     WHERE table_schema='public' AND table_name='inventory_position_operacional'
--       AND column_name IN ('cmc','preco_medio'))                            AS colunas_de_custo,   -- esperado 0
--   (SELECT count(*) FROM information_schema.columns
--     WHERE table_schema='public' AND table_name='inventory_position_operacional'
--       AND column_name='saldo')                                             AS tem_saldo,          -- esperado 1
--   (SELECT lower(option_value) FROM pg_class c, pg_options_to_table(c.reloptions)
--     WHERE c.oid='public.inventory_position_operacional'::regclass
--       AND option_name='security_invoker')                                  AS invoker,            -- esperado off/false
--   has_table_privilege('anon','public.inventory_position_operacional','SELECT') AS anon_le;        -- esperado false
