-- ╔══════════════════════════════════════════════════════════════════════════════════════════╗
-- ║  E2/FU4 — matriz de capability por recurso × ação  [money-path / autorização]             ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════╝
-- Spec: docs/superpowers/specs/2026-07-18-authz-gerencial-capability-matrix-design.md §4
-- Prova: db/test-authz-capability-matrix.sh (PG17, SET ROLE authenticated, com falsificação)
-- Continuação da E1 (#1424, só código) e do FU7-b (#1427, wrapper do oráculo).
--
-- ── O FURO (medido em prod via psql-ro, 2026-07-18) ────────────────────────────────────────
-- `pode_ver_carteira_completa` NÃO é o gate da carteira: é a capability universal de gestão.
-- Gateia **64 policies em 34 tabelas** + 4 RPCs SECDEF do authz-manifest. Consequência medida:
-- atribuir `commercial_role='gerencial'` hoje concede, de uma vez:
--   · ESCRITA em `cliente_tier_preco`  (tier de preço do cliente)
--   · ESCRITA em `venda_excecao_credito` (aprovação de crédito)
--   · LEITURA de `cmc_ledger` (custo médio) e `markup_policy` (piso de margem)
--   · LEITURA de 9 tabelas `reposicao_*` (telemetria do motor de compras)
-- O papel é atribuído por um `upsert` num dropdown — nenhum CI roda quando alguém usa a tela.
--
-- ── POR QUE UMA TRANSAÇÃO ÚNICA (spec §4.1) ────────────────────────────────────────────────
-- O dono aplica migrations À MÃO, uma de cada vez, e uma esquecida falha em SILÊNCIO. Uma
-- sequência de migrations deixaria o estado "aplicou a 2ª, esqueceu a 3ª" — inseguro e invisível.
-- Aqui: ou tudo entra, ou nada entra. A versão do contrato é ativada POR ÚLTIMO (§6), então o
-- frontend só destrava o papel gerencial depois que a matriz inteira existe.
--
-- ── POR QUE ESCRITA ≠ LEITURA (spec §4.2) ──────────────────────────────────────────────────
-- O gate era reusado em policies MUTANTES: o gestor não é auditor read-only — ele podia alterar
-- e apagar score/recomendação de qualquer vendedor. `cap_*_ler` e `cap_*_escrever` são funções
-- SEPARADAS mesmo quando hoje concedem ao mesmo conjunto: é o que permite apertar um lado depois
-- sem reabrir o outro, mexendo em 1 função em vez de 28 policies.
--
-- ── ROBUSTA À ORDEM DE APLICAÇÃO (repo × prod divergem hoje) ────────────────────────────────
-- O #1427 (migration 20260718180000) move a implementação de `pode_ver_carteira_completa` para
-- `private` + wrapper em `public` service_role-only. Medido 2026-07-18: essa migration MERGEOU
-- mas AINDA NÃO FOI APLICADA em prod (lá a função segue em `public`, SECDEF, com EXECUTE p/
-- `authenticated`). Esta migration NÃO referencia `pode_ver_carteira_completa` em lugar nenhum —
-- as capabilities novas leem `commercial_roles`/`user_roles` direto. Logo aplica-se ANTES ou
-- DEPOIS do #1427, em qualquer ordem, sem caller órfão (a falha do #1423).
--
-- ── O QUE NÃO ESTÁ AQUI, DE PROPÓSITO ──────────────────────────────────────────────────────
-- · `ineligibility_reason` (enum+coluna+backfill) e a RPC de quarentena → FU4-D. A matriz não
--   depende deles: filtrar coorte usa `eligible`, que já existe. Mantê-los aqui só engordaria
--   o bloco que o dono cola à mão, misturando autorização com qualidade de dado da máscara.
-- · Agregação server-side dos KPIs estratégicos (spec §4.3) → FU4-B. Os números daquela tela já
--   são inválidos com ou sem máscara (`.limit()` sem `.order`); filtrar `eligible` não conserta.
-- · Divergência do enum `CommercialRole` TS(4) × Postgres(8) → FU4-C. Inerte hoje.
-- · `has_role` segue exposto como oráculo (389 policies) — resíduo reconhecido pelo #1427.
--
-- ── RESÍDUO MEDIDO E DEIXADO CONSCIENTEMENTE (não é esquecimento) ───────────────────────────
-- Medido em prod 2026-07-18: 21 funções (fora as 2 de custo tratadas acima) ainda chamam
-- `pode_ver_carteira_completa`, além da view `v_cliente_interacoes` (security_invoker).
--   · A MAIORIA é carteira/tarefa/radar/geo — capability que esta matriz decidiu MANTER para o
--     papel gerencial. Continuar no gate antigo é o comportamento correto, não resíduo.
--     Idem `v_cliente_interacoes`: expõe `revenue` (faturamento), não custo/markup.
--   · ⚠️ **FU4-E** — 3 RPCs de ESCRITA em compras seguem no gate gerencial:
--     `despinar_parametro`, `reverter_parametro_auto`, `reverter_run_auto` (mutam
--     `reposicao_param_pin` e os logs de parâmetro/run). Fica a incoerência "o gerencial não LÊ
--     mais a telemetria de compras (§4), mas ainda ESCREVE nela". Não foi corrigido aqui porque
--     o desacoplamento aprovado foi o de LEITURA, e reescrever 3 funções money-path exigiria o
--     mesmo rigor (corpo verbatim + prova + falsificação) numa transação que já é grande.
--     Não é vazamento de custo/preço/crédito — é coerência interna de compras. Ao tratar:
--     criar `private.cap_compras_escrever` (não reusar a de leitura — spec §4.2).
--   · `melhoria_clientes_por_produto` fica no gate de staff (`has_role employee|master`) que já
--     tinha; a menção ao gate antigo ali não decide exposição de custo.
--   · `get_preco_cockpit` e `get_defasagem_cliente` ESTAVAM nesta lista na 1ª versão, como
--     "refinamento sobre gate de staff". Estava ERRADO — a revisão adversária mostrou que a
--     variável gateada é o que libera os NÚMEROS de custo. Foram tratadas na §3.
--
-- ── ⚠️ ESCOPO HONESTO: o que esta migration NÃO garante ────────────────────────────────────
-- Esta migration remove o acoplamento do **PAPEL COMERCIAL**: `commercial_role='gerencial'`
-- deixa de conceder, POR SI, preço/crédito/custo/compras. Ela **NÃO** fecha a leitura de custo
-- para a pessoa que tem esse papel — e a diferença importa.
--
-- Todo gestor também é `app_role='employee'`, e o role `employee` concede custo por superfícies
-- que NÃO passam por `commercial_role` (medido em prod, psql-ro 2026-07-18):
--   · `inventory_position` (cmc, preco_medio) · `cmc_snapshot` (cmc)
--   · `product_costs` (cost_price, cmc, cost_final, custo_producao) · `regua_preco_log` (cmc_usado)
--     → todas com policy `employee OR master`
--   · `get_regua_preco` / `get_regua_preco_customer360` → gate `has_role(employee|master)`, devolvem cmc
--   · `get_tint_price` / `get_tint_prices` → `v_is_staff := employee OR master`, devolvem custoBase/custoCorantes
-- Os 2 vendedores que existem hoje já leem custo por esses caminhos, antes e depois desta
-- migration. Fechá-los é **FU4-F** — decisão de produto ("vendedor deve ver custo?") que muda o
-- acesso de gente VIVA, ao contrário desta entrega, onde ninguém perde nada.
--
-- Limite adicional (achado da rodada 2 da revisão adversária): mesmo com os números mascarados,
-- `get_preco_cockpit` continua sendo um ORÁCULO por busca binária — o caller escolhe o preço e
-- lê a faixa (`abaixo_do_custo`/`abaixo_do_piso`/`abaixo_da_meta`), reconstruindo cmc/piso/meta
-- por bisseção; e `get_defasagem_cliente` devolve `alta_custo_perc` fora do gate. Mascarar os
-- campos brutos é redução de superfície, não vedação — e vale porque o oráculo exige esforço
-- deliberado, enquanto o campo bruto vinha de bandeja. Ambos os canais são acessíveis a QUALQUER
-- employee, não só ao gestor: pertencem ao FU4-F, não a esta entrega.
--
-- ⚠️ Provada em PG17 local com falsificação: db/test-authz-capability-matrix.sh
-- ⚠️ Migration MANUAL (Lovable não aplica nome custom) — colar no SQL Editor.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 0) PRECONDIÇÕES — aborta se o banco vivo divergir do que foi medido (spec §4.1 passo 2)
-- ════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_gerenciais int;
BEGIN
  IF to_regclass('public.commercial_roles') IS NULL THEN
    RAISE EXCEPTION 'E2/FU4: tabela commercial_roles ausente — banco divergente, abortando'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'private') THEN
    RAISE EXCEPTION 'E2/FU4: schema private ausente — aplique o #1421 (20260718150000) antes'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- A troca de gate é segura HOJE porque ninguém vive sob papel gerencial (medido: 2 farmer +
  -- 1 master, zero gerencial/estrategico/super_admin). Se alguém foi promovido entre a escrita e
  -- a aplicação desta migration, a troca TIRARIA acesso de uma pessoa viva sem aviso — melhor
  -- abortar e revisar a matriz do que descobrir pelo suporte.
  SELECT count(*) INTO v_gerenciais FROM public.commercial_roles
   WHERE commercial_role IN ('gerencial','estrategico','super_admin');
  IF v_gerenciais > 0 THEN
    RAISE EXCEPTION 'E2/FU4: % papel(is) gerencial(is) vivo(s) — a matriz muda o acesso deles. Revise antes de aplicar.', v_gerenciais
      USING ERRCODE = 'raise_exception';
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 1) AS CAPABILITIES — em `private` (helpers de RLS não são superfície PostgREST; lição FU7)
--    Todas fail-closed: uid NULL ⇒ false; ausência de linha ⇒ false; COALESCE em toda saída.
--    Leem `commercial_roles` DIRETO em vez de chamar `get_commercial_role`: essa função já mudou
--    de grants (#1421) e é candidata a mudar de schema. Depender dela reintroduziria o acoplamento
--    que quebrou 4 callers em prod no #1423. Uma tabela não muda de schema por refactor de authz.
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- ── gestão operacional de carteira: LEITURA ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.cap_carteira_ler(_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    _uid IS NOT NULL
    AND (
      public.has_role(_uid, 'master'::public.app_role)
      OR (
        public.has_role(_uid, 'employee'::public.app_role)
        AND EXISTS (
          SELECT 1 FROM public.commercial_roles cr
           WHERE cr.user_id = _uid
             AND cr.commercial_role IN ('gerencial','estrategico','super_admin')
        )
      )
    ), false);
$function$;

COMMENT ON FUNCTION private.cap_carteira_ler(uuid) IS
  'E2/FU4 — LER carteira/farmer/tarefas/radar de qualquer vendedor. Mantém a concessão que '
  '`pode_ver_carteira_completa` dava (master + gerencial/estrategico/super_admin): é o trabalho '
  'legítimo do gestor. Separada de cap_carteira_escrever de propósito (spec §4.2).';

-- ── gestão operacional de carteira: ESCRITA ────────────────────────────────────────────────
-- Mesma concessão que a leitura HOJE. Existe separada porque INSERT/UPDATE/DELETE sobre score e
-- recomendação de outro vendedor é ato mutante — apertar isso depois deve custar 1 função, não 28
-- policies. NÃO é redundância: é a junta onde a matriz dobra.
CREATE OR REPLACE FUNCTION private.cap_carteira_escrever(_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    _uid IS NOT NULL
    AND (
      public.has_role(_uid, 'master'::public.app_role)
      OR (
        public.has_role(_uid, 'employee'::public.app_role)
        AND EXISTS (
          SELECT 1 FROM public.commercial_roles cr
           WHERE cr.user_id = _uid
             AND cr.commercial_role IN ('gerencial','estrategico','super_admin')
        )
      )
    ), false);
$function$;

COMMENT ON FUNCTION private.cap_carteira_escrever(uuid) IS
  'E2/FU4 — ESCREVER (INSERT/UPDATE/DELETE) em carteira/farmer/tarefas de outro vendedor. '
  'Hoje concede ao mesmo conjunto que cap_carteira_ler; separada para permitir apertar a escrita '
  'sem reabrir a leitura (spec §4.2).';

-- ── custo e margem: LEITURA ────────────────────────────────────────────────────────────────
-- O PAPEL `gerencial` deixa de conceder isto. Custo médio (cmc) e piso de markup são insumo de
-- decisão estratégica, não de operação de carteira. `estrategico` mantém — é o papel cuja tela
-- vive disso. ⚠️ Isto NÃO impede o gestor de ler custo por `employee` (ver ESCOPO HONESTO no
-- cabeçalho): fecha o que o PAPEL concede, não o que o role já dava.
CREATE OR REPLACE FUNCTION private.cap_custo_ler(_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    _uid IS NOT NULL
    AND (
      public.has_role(_uid, 'master'::public.app_role)
      OR (
        public.has_role(_uid, 'employee'::public.app_role)
        AND EXISTS (
          SELECT 1 FROM public.commercial_roles cr
           WHERE cr.user_id = _uid
             AND cr.commercial_role IN ('estrategico','super_admin')
        )
      )
    ), false);
$function$;

COMMENT ON FUNCTION private.cap_custo_ler(uuid) IS
  'E2/FU4 — LER custo médio (cmc_ledger) e piso de margem (markup_policy). master + estrategico + '
  'super_admin. O PAPEL `gerencial` deixou de conceder isto (era herança do gate único). ATENÇÃO: '
  'nao significa que o gestor nao le custo — o role `employee` concede por inventory_position, '
  'cmc_snapshot, product_costs, regua_preco_log e get_regua_preco/get_tint_price (FU4-F).';

-- ── preço: ESCRITA ─────────────────────────────────────────────────────────────────────────
-- master-only. Mudar o tier de preço de um cliente altera o que ele paga — é o ato mais caro da
-- matriz. Fica no papel mais restrito até existir demanda explícita e um papel próprio pra isso.
CREATE OR REPLACE FUNCTION private.cap_preco_escrever(_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid, 'master'::public.app_role), false);
$function$;

COMMENT ON FUNCTION private.cap_preco_escrever(uuid) IS
  'E2/FU4 — ESCREVER tier de preço do cliente (cliente_tier_preco). MASTER-ONLY. '
  'gerencial e estrategico PERDERAM: era herança do gate único.';

-- ── crédito: ESCRITA ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.cap_credito_escrever(_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid, 'master'::public.app_role), false);
$function$;

COMMENT ON FUNCTION private.cap_credito_escrever(uuid) IS
  'E2/FU4 — APROVAR exceção de crédito (venda_excecao_credito). MASTER-ONLY. '
  'gerencial e estrategico PERDERAM: era herança do gate único.';

-- ── compras/reposição: LEITURA ─────────────────────────────────────────────────────────────
-- Telemetria do motor de compras é outro domínio — não é carteira comercial. master-only por ora:
-- o enum `commercial_role` não tem papel de compras, e inventar um aqui seria fabricar contrato.
-- Ninguém perde acesso hoje: só o master passava no gate antigo (não há papel gerencial vivo).
CREATE OR REPLACE FUNCTION private.cap_compras_ler(_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid, 'master'::public.app_role), false);
$function$;

COMMENT ON FUNCTION private.cap_compras_ler(uuid) IS
  'E2/FU4 — LER telemetria do motor de compras (9 tabelas reposicao_*). MASTER-ONLY. '
  'Desacoplado do papel comercial: compras não é carteira. Quando existir papel de compras no '
  'enum, é esta função que muda — não as 9 policies.';

-- As policies guardam a expressão por OID, mas o EXECUTE é verificado em runtime pelo caller.
REVOKE ALL ON FUNCTION private.cap_carteira_ler(uuid)     FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.cap_carteira_escrever(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.cap_custo_ler(uuid)        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.cap_preco_escrever(uuid)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.cap_credito_escrever(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.cap_compras_ler(uuid)      FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION private.cap_carteira_ler(uuid)     TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.cap_carteira_escrever(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.cap_custo_ler(uuid)        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.cap_preco_escrever(uuid)   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.cap_credito_escrever(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.cap_compras_ler(uuid)      TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 2) MONEY-PATH — ESCRITA: preço e crédito saem do papel gerencial (→ master-only)
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- ── cliente_tier_preco (tier de preço do cliente) ──────────────────────────────────────────
DROP POLICY IF EXISTS cliente_tier_preco_insert_gestor ON public.cliente_tier_preco;
CREATE POLICY cliente_tier_preco_insert_gestor
  ON public.cliente_tier_preco FOR INSERT
  WITH CHECK ((SELECT private.cap_preco_escrever((SELECT auth.uid()))));

DROP POLICY IF EXISTS cliente_tier_preco_update_gestor ON public.cliente_tier_preco;
CREATE POLICY cliente_tier_preco_update_gestor
  ON public.cliente_tier_preco FOR UPDATE
  USING      ((SELECT private.cap_preco_escrever((SELECT auth.uid()))))
  WITH CHECK ((SELECT private.cap_preco_escrever((SELECT auth.uid()))));

-- ── venda_excecao_credito (aprovação de exceção de crédito) ────────────────────────────────
-- Preserva o `aprovado_por = auth.uid()`: quem aprova assina. Só o gate mudou.
DROP POLICY IF EXISTS venda_excecao_insert_gestor ON public.venda_excecao_credito;
CREATE POLICY venda_excecao_insert_gestor
  ON public.venda_excecao_credito FOR INSERT
  WITH CHECK (
    (SELECT private.cap_credito_escrever((SELECT auth.uid())))
    AND aprovado_por = (SELECT auth.uid())
  );

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 3) MONEY-PATH — LEITURA: custo e margem (→ master + estrategico)
-- ════════════════════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS cmc_ledger_select_gestor ON public.cmc_ledger;
CREATE POLICY cmc_ledger_select_gestor
  ON public.cmc_ledger FOR SELECT TO authenticated
  USING ((SELECT private.cap_custo_ler((SELECT auth.uid()))));

DROP POLICY IF EXISTS markup_policy_select_carteira ON public.markup_policy;
CREATE POLICY markup_policy_select_carteira
  ON public.markup_policy FOR SELECT
  USING ((SELECT private.cap_custo_ler((SELECT auth.uid()))));

-- ── as 2 RPCs SECDEF de custo (authz-manifest.ts) ──────────────────────────────────────────
-- Sem isto, o gerencial continuaria lendo custo POR FORA das policies: estas funções são SECDEF e
-- fazem o próprio gate no corpo. Corpo copiado VERBATIM de prod (pg_get_functiondef, 2026-07-18) —
-- só a linha do gate muda. O repo diverge de prod nestas duas; a fonte aqui é prod.
CREATE OR REPLACE FUNCTION public.fin_estimar_estoque_omie(p_company text)
 RETURNS TABLE(valor_estimado numeric, cobertura_pct numeric, skus_total integer, skus_com_custo integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_account text;
BEGIN
  IF NOT (
    COALESCE(auth.role() = 'service_role', false)
    OR COALESCE(private.cap_custo_ler(auth.uid()), false)   -- E2/FU4: era pode_ver_carteira_completa
  ) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil financeiro' USING ERRCODE = '42501';
  END IF;

  v_account := CASE lower(trim(p_company))
                 WHEN 'oben' THEN 'vendas' WHEN 'colacor' THEN 'colacor_vendas' WHEN 'colacor_sc' THEN 'servicos'
               END;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'fin_estimar_estoque_omie: empresa invalida %', p_company USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
    WITH canon AS (
      SELECT ip.saldo, ip.cmc FROM public.inventory_position ip
       WHERE ip.account = v_account AND ip.saldo > 0
    )
    SELECT
      COALESCE(SUM(CASE WHEN cmc > 0 THEN saldo * cmc ELSE 0 END), 0)::numeric,
      CASE WHEN COUNT(*) = 0 THEN 0::numeric
           ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE cmc > 0) / COUNT(*), 2) END,
      COUNT(*)::int, COUNT(*) FILTER (WHERE cmc > 0)::int
    FROM canon;
END;
$function$;

CREATE OR REPLACE FUNCTION public.medir_abaixo_piso_tier(p_dias integer DEFAULT 90)
 RETURNS TABLE(company text, tier text, itens_abaixo bigint, total_itens bigint, folga_negativa_reais numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- E2/FU4: era `pode_ver_carteira_completa`. Os parênteses ao redor do COALESCE não são
  -- estilo: `scripts/authz-gate-check.ts` só reconhece como BLOQUEIO as formas
  -- `IF NOT <gate>(…)` e `IF NOT ( … <gate>(…) … )`. Escrito como
  -- `IF NOT COALESCE(<gate>(…), false)` o CI classifica como gate DECORATIVO e falha.
  IF NOT (COALESCE(private.cap_custo_ler(auth.uid()), false)) THEN
    RAISE EXCEPTION 'forbidden: medir_abaixo_piso_tier exige capability de custo' USING errcode = '42501';
  END IF;
  RETURN QUERY
  WITH itens AS (
    SELECT so.account AS company, ctp.tier, oi.unit_price, oi.quantity, oi.omie_codigo_produto, op.familia,
      (SELECT ip.cmc FROM inventory_position ip
        WHERE ip.omie_codigo_produto = oi.omie_codigo_produto AND ip.cmc > 0 AND ip.cmc <> 'NaN'::numeric
          AND ip.account = ANY(CASE so.account WHEN 'oben' THEN ARRAY['vendas','oben']
                WHEN 'colacor' THEN ARRAY['colacor_vendas','colacor'] ELSE ARRAY[so.account] END)
        ORDER BY ip.synced_at DESC NULLS LAST LIMIT 1) AS cmc
    FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
    LEFT JOIN public.cliente_tier_preco ctp ON ctp.company = so.account AND ctp.customer_user_id = so.customer_user_id
    LEFT JOIN public.omie_products op ON op.omie_codigo_produto = oi.omie_codigo_produto AND op.account = so.account
    WHERE so.deleted_at IS NULL AND COALESCE(so.status, '') NOT IN ('cancelado', 'orcamento')
      AND so.omie_numero_pedido IS NOT NULL AND so.omie_numero_pedido::text <> ''
      AND so.account IN ('oben', 'colacor')
      AND COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= current_date - p_dias
      AND oi.unit_price > 0
  ),
  avaliado AS (
    SELECT i.company, i.tier, i.unit_price, i.quantity, i.cmc, rp.piso_markup FROM itens i
    LEFT JOIN LATERAL public.resolve_markup_policy(i.company, i.omie_codigo_produto, i.familia, i.tier) rp ON true
    WHERE i.cmc IS NOT NULL AND i.cmc > 0
  )
  SELECT a.company, a.tier,
    count(*) FILTER (WHERE a.piso_markup IS NOT NULL AND a.unit_price < a.cmc * (1 + a.piso_markup/100)) AS itens_abaixo,
    count(*) AS total_itens,
    COALESCE(SUM((a.cmc * (1 + a.piso_markup/100) - a.unit_price) * a.quantity)
             FILTER (WHERE a.piso_markup IS NOT NULL AND a.unit_price < a.cmc * (1 + a.piso_markup/100)), 0) AS folga_negativa_reais
  FROM avaliado a GROUP BY a.company, a.tier ORDER BY a.company, a.tier NULLS FIRST;
END; $function$;

-- ── get_preco_cockpit + get_defasagem_cliente ──────────────────────────────────────────────
-- ACHADO DA REVISÃO ADVERSÁRIA (Codex gpt-5.6-sol xhigh): estas duas pareciam apenas "afinar o
-- detalhe" sobre um gate de staff — é o que diz o comentário no authz-manifest. O CÓDIGO diz
-- outra coisa: `v_pode_num := pode_ver_carteira_completa(auth.uid())` é exatamente a variável
-- que decide se `cmc`, `markup_perc`, `folga_reais`, `piso_markup`, `meta_markup`,
-- `proveniencia` e `frescor` saem preenchidos ou NULL. Sem tratá-las, o `gerencial` continuaria
-- lendo custo POR FORA das policies — o objetivo declarado desta entrega falharia em silêncio.
-- (Staff segue vendo a FAIXA verde/amarelo/vermelho: isso não depende desta variável.)
--
-- POR QUE PROGRAMÁTICO E NÃO VERBATIM: juntas têm ~305 linhas de plpgsql financeiro, e a mudança
-- real é UMA linha em cada. Colá-las aqui adicionaria mais risco (erro de cópia, drift repo×prod)
-- do que conserta. Então reescrevemos a partir do corpo VIVO (`pg_get_functiondef`), trocando só
-- a atribuição do gate. O guard é o que torna isto seguro: se o padrão não casar — função já
-- migrada, ou corpo diferente do medido — a migration ABORTA em vez de aplicar no-op silencioso.
DO $$
DECLARE
  v_alvos text[] := ARRAY['public.get_preco_cockpit(jsonb)','public.get_defasagem_cliente(jsonb,uuid)'];
  v_a     text;
  v_oid   regprocedure;
  v_def   text;
  v_novo  text;
  v_ocorr int;
  -- chamada do gate antigo, tolerante a qualificação e espaçamento (`public.` opcional,
  -- espaço antes do parêntese). Casar só a string literal deixaria passar uma variante
  -- trivialmente diferente — o guard mentiria (achado da rodada 2 da revisão adversária).
  c_re_antigo constant text := '(public\.)?pode_ver_carteira_completa\s*\(';
  c_re_novo   constant text := 'private\.cap_custo_ler\s*\(';
BEGIN
  FOREACH v_a IN ARRAY v_alvos LOOP
    -- por ASSINATURA, não por proname: um overload futuro seria escolhido arbitrariamente.
    v_oid := to_regprocedure(v_a);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'E2/FU4: funcao % nao encontrada — banco divergente do medido', v_a
        USING ERRCODE = 'raise_exception';
    END IF;
    v_def := pg_get_functiondef(v_oid);

    -- IDEMPOTENTE: já migrada ⇒ segue. Migration custom deste repo tem de poder ser
    -- re-aplicada (o dono cola à mão; um erro de rede no meio não pode travar a 2ª tentativa).
    IF v_def ~ c_re_novo AND v_def !~ c_re_antigo THEN
      CONTINUE;
    END IF;

    -- exatamente 1 chamada do gate antigo — medido em prod 2026-07-18. Mais de uma significa
    -- corpo diferente do que esta migration foi escrita para tratar.
    SELECT count(*) INTO v_ocorr FROM regexp_matches(v_def, c_re_antigo, 'g');
    IF v_ocorr <> 1 THEN
      RAISE EXCEPTION 'E2/FU4: esperava 1 chamada do gate antigo em %, encontrei % — inspecione pg_get_functiondef antes de prosseguir', v_a, v_ocorr
        USING ERRCODE = 'raise_exception';
    END IF;

    v_novo := regexp_replace(
      v_def,
      'v_pode_num\s*:=\s*(public\.)?pode_ver_carteira_completa\s*\(\s*auth\.uid\(\)\s*\)',
      'v_pode_num := private.cap_custo_ler(auth.uid())',
      'g'
    );

    IF v_novo = v_def THEN
      RAISE EXCEPTION 'E2/FU4: padrao do gate nao casou em % — nao aplicar no-op silencioso', v_a
        USING ERRCODE = 'raise_exception';
    END IF;
    IF v_novo ~ c_re_antigo THEN
      RAISE EXCEPTION 'E2/FU4: sobrou chamada ao gate antigo em % apos a troca', v_a
        USING ERRCODE = 'raise_exception';
    END IF;
    IF v_novo !~ c_re_novo THEN
      RAISE EXCEPTION 'E2/FU4: o gate NOVO nao aparece em % apos a troca', v_a
        USING ERRCODE = 'raise_exception';
    END IF;

    EXECUTE v_novo;

    -- pós-check POSITIVO no objeto final: o guard textual acima valida a string que vamos
    -- executar; isto valida o que o catálogo realmente guardou.
    IF pg_get_functiondef(to_regprocedure(v_a)) !~ c_re_novo THEN
      RAISE EXCEPTION 'E2/FU4: pos-check falhou — % nao ficou com o gate novo', v_a
        USING ERRCODE = 'raise_exception';
    END IF;
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 4) COMPRAS — 9 tabelas `reposicao_*` desacopladas do papel comercial (→ master-only)
-- ════════════════════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS cold_start_log_sel ON public.reposicao_cold_start_log;
CREATE POLICY cold_start_log_sel ON public.reposicao_cold_start_log FOR SELECT TO authenticated
  USING ((SELECT private.cap_compras_ler((SELECT auth.uid()))));

DROP POLICY IF EXISTS depara_auto_log_sel ON public.reposicao_depara_auto_log;
CREATE POLICY depara_auto_log_sel ON public.reposicao_depara_auto_log FOR SELECT TO authenticated
  USING ((SELECT private.cap_compras_ler((SELECT auth.uid()))));

DROP POLICY IF EXISTS estoque_nao_confirmado_log_sel ON public.reposicao_estoque_nao_confirmado_log;
CREATE POLICY estoque_nao_confirmado_log_sel ON public.reposicao_estoque_nao_confirmado_log FOR SELECT TO authenticated
  USING ((SELECT private.cap_compras_ler((SELECT auth.uid()))));

DROP POLICY IF EXISTS reposicao_motor_run_sel ON public.reposicao_motor_run;
CREATE POLICY reposicao_motor_run_sel ON public.reposicao_motor_run FOR SELECT TO authenticated
  USING ((SELECT private.cap_compras_ler((SELECT auth.uid()))));

DROP POLICY IF EXISTS param_auto_log_sel ON public.reposicao_param_auto_log;
CREATE POLICY param_auto_log_sel ON public.reposicao_param_auto_log FOR SELECT TO authenticated
  USING ((SELECT private.cap_compras_ler((SELECT auth.uid()))));

DROP POLICY IF EXISTS param_auto_run_sel ON public.reposicao_param_auto_run;
CREATE POLICY param_auto_run_sel ON public.reposicao_param_auto_run FOR SELECT TO authenticated
  USING ((SELECT private.cap_compras_ler((SELECT auth.uid()))));

DROP POLICY IF EXISTS param_auto_pin_sel ON public.reposicao_param_pin;
CREATE POLICY param_auto_pin_sel ON public.reposicao_param_pin FOR SELECT TO authenticated
  USING ((SELECT private.cap_compras_ler((SELECT auth.uid()))));

DROP POLICY IF EXISTS reposicao_pedidos_compra_run_sel ON public.reposicao_pedidos_compra_run;
CREATE POLICY reposicao_pedidos_compra_run_sel ON public.reposicao_pedidos_compra_run FOR SELECT TO authenticated
  USING ((SELECT private.cap_compras_ler((SELECT auth.uid()))));

DROP POLICY IF EXISTS reposicao_po_last_seen_sel ON public.reposicao_po_last_seen;
CREATE POLICY reposicao_po_last_seen_sel ON public.reposicao_po_last_seen FOR SELECT TO authenticated
  USING ((SELECT private.cap_compras_ler((SELECT auth.uid()))));

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 5) CARTEIRA / FARMER / TAREFAS / RADAR — decisão consciente: MANTÉM a concessão
--    Trocam `pode_ver_carteira_completa` por `cap_carteira_ler`/`cap_carteira_escrever`.
--    Toda condição própria (`farmer_id = uid`, `carteira_visivel_para`, cobertura) é PRESERVADA
--    verbatim — só o termo do gate muda.
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- ── farmer_client_scores ───────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS fcs_select_carteira ON public.farmer_client_scores;
CREATE POLICY fcs_select_carteira ON public.farmer_client_scores FOR SELECT
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid())))
         OR private.carteira_visivel_para(customer_user_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS fcs_insert_own_or_gestor ON public.farmer_client_scores;
CREATE POLICY fcs_insert_own_or_gestor ON public.farmer_client_scores FOR INSERT
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS fcs_update_own_or_gestor ON public.farmer_client_scores;
CREATE POLICY fcs_update_own_or_gestor ON public.farmer_client_scores FOR UPDATE
  USING      ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()))
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS fcs_delete_own_or_gestor ON public.farmer_client_scores;
CREATE POLICY fcs_delete_own_or_gestor ON public.farmer_client_scores FOR DELETE
  USING ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()));

-- ── customer_visit_scores ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS cvs_select_carteira ON public.customer_visit_scores;
CREATE POLICY cvs_select_carteira ON public.customer_visit_scores FOR SELECT
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid())))
         OR private.carteira_visivel_para(customer_user_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS cvs_insert_own_or_gestor ON public.customer_visit_scores;
CREATE POLICY cvs_insert_own_or_gestor ON public.customer_visit_scores FOR INSERT
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS cvs_update_own_or_gestor ON public.customer_visit_scores;
CREATE POLICY cvs_update_own_or_gestor ON public.customer_visit_scores FOR UPDATE
  USING      ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()))
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS cvs_delete_own_or_gestor ON public.customer_visit_scores;
CREATE POLICY cvs_delete_own_or_gestor ON public.customer_visit_scores FOR DELETE
  USING ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()));

-- ── farmer_recommendations ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS frec_select_carteira ON public.farmer_recommendations;
CREATE POLICY frec_select_carteira ON public.farmer_recommendations FOR SELECT TO authenticated
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid())))
         OR farmer_id = (SELECT auth.uid())
         OR private.carteira_visivel_para(customer_user_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS frec_insert_own_or_gestor ON public.farmer_recommendations;
CREATE POLICY frec_insert_own_or_gestor ON public.farmer_recommendations FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS frec_update_own_or_gestor ON public.farmer_recommendations;
CREATE POLICY frec_update_own_or_gestor ON public.farmer_recommendations FOR UPDATE TO authenticated
  USING      ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()))
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS frec_delete_own_or_gestor ON public.farmer_recommendations;
CREATE POLICY frec_delete_own_or_gestor ON public.farmer_recommendations FOR DELETE TO authenticated
  USING ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()));

-- ── farmer_calls ───────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS fcall_select_carteira ON public.farmer_calls;
CREATE POLICY fcall_select_carteira ON public.farmer_calls FOR SELECT TO authenticated
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid())))
         OR farmer_id = (SELECT auth.uid())
         OR private.carteira_visivel_para(customer_user_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS fcall_insert_own_or_gestor ON public.farmer_calls;
CREATE POLICY fcall_insert_own_or_gestor ON public.farmer_calls FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS fcall_update_own_or_gestor ON public.farmer_calls;
CREATE POLICY fcall_update_own_or_gestor ON public.farmer_calls FOR UPDATE TO authenticated
  USING      ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()))
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS fcall_delete_own_or_gestor ON public.farmer_calls;
CREATE POLICY fcall_delete_own_or_gestor ON public.farmer_calls FOR DELETE TO authenticated
  USING ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()));

-- ── farmer_bundle_recommendations ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS fbrec_select_carteira ON public.farmer_bundle_recommendations;
CREATE POLICY fbrec_select_carteira ON public.farmer_bundle_recommendations FOR SELECT TO authenticated
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid())))
         OR farmer_id = (SELECT auth.uid())
         OR private.carteira_visivel_para(customer_user_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS fbrec_insert_own_or_gestor ON public.farmer_bundle_recommendations;
CREATE POLICY fbrec_insert_own_or_gestor ON public.farmer_bundle_recommendations FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS fbrec_update_own_or_gestor ON public.farmer_bundle_recommendations;
CREATE POLICY fbrec_update_own_or_gestor ON public.farmer_bundle_recommendations FOR UPDATE TO authenticated
  USING      ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()))
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS fbrec_delete_own_or_gestor ON public.farmer_bundle_recommendations;
CREATE POLICY fbrec_delete_own_or_gestor ON public.farmer_bundle_recommendations FOR DELETE TO authenticated
  USING ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()));

-- ── farmer_copilot_sessions (sem cláusula de carteira no SELECT — preservado) ───────────────
DROP POLICY IF EXISTS fcop_select_carteira ON public.farmer_copilot_sessions;
CREATE POLICY fcop_select_carteira ON public.farmer_copilot_sessions FOR SELECT TO authenticated
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS fcop_insert_own_or_gestor ON public.farmer_copilot_sessions;
CREATE POLICY fcop_insert_own_or_gestor ON public.farmer_copilot_sessions FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS fcop_update_own_or_gestor ON public.farmer_copilot_sessions;
CREATE POLICY fcop_update_own_or_gestor ON public.farmer_copilot_sessions FOR UPDATE TO authenticated
  USING      ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()))
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS fcop_delete_own_or_gestor ON public.farmer_copilot_sessions;
CREATE POLICY fcop_delete_own_or_gestor ON public.farmer_copilot_sessions FOR DELETE TO authenticated
  USING ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()));

-- ── route_visits (coluna do dono é `visited_by`) ───────────────────────────────────────────
DROP POLICY IF EXISTS rvis_select_carteira ON public.route_visits;
CREATE POLICY rvis_select_carteira ON public.route_visits FOR SELECT TO authenticated
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid())))
         OR visited_by = (SELECT auth.uid())
         OR private.carteira_visivel_para(customer_user_id, (SELECT auth.uid())));

DROP POLICY IF EXISTS rvis_insert_own_or_gestor ON public.route_visits;
CREATE POLICY rvis_insert_own_or_gestor ON public.route_visits FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR visited_by = (SELECT auth.uid()));

DROP POLICY IF EXISTS rvis_update_own_or_gestor ON public.route_visits;
CREATE POLICY rvis_update_own_or_gestor ON public.route_visits FOR UPDATE TO authenticated
  USING      ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR visited_by = (SELECT auth.uid()))
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR visited_by = (SELECT auth.uid()));

DROP POLICY IF EXISTS rvis_delete_own_or_gestor ON public.route_visits;
CREATE POLICY rvis_delete_own_or_gestor ON public.route_visits FOR DELETE TO authenticated
  USING ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR visited_by = (SELECT auth.uid()));

-- ── visitas_agendadas ──────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS vag_select_own ON public.visitas_agendadas;
CREATE POLICY vag_select_own ON public.visitas_agendadas FOR SELECT TO authenticated
  USING (scheduled_by = (SELECT auth.uid()) OR (SELECT private.cap_carteira_ler((SELECT auth.uid()))));

DROP POLICY IF EXISTS vag_delete_gestor ON public.visitas_agendadas;
CREATE POLICY vag_delete_gestor ON public.visitas_agendadas FOR DELETE TO authenticated
  USING ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))));

-- ── tarefas ────────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS tarefas_select ON public.tarefas;
CREATE POLICY tarefas_select ON public.tarefas FOR SELECT TO authenticated
  USING (
    (SELECT private.cap_carteira_ler((SELECT auth.uid())))
    OR assigned_to = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.carteira_coverage cc
       WHERE cc.covered_user_id = tarefas.assigned_to
         AND cc.covering_user_id = (SELECT auth.uid())
         AND cc.active AND now() >= cc.valid_from
         AND (cc.valid_until IS NULL OR now() <= cc.valid_until)
    )
  );

DROP POLICY IF EXISTS tarefas_insert ON public.tarefas;
CREATE POLICY tarefas_insert ON public.tarefas FOR INSERT TO authenticated
  WITH CHECK (created_by = (SELECT auth.uid())
              AND (SELECT private.cap_carteira_escrever((SELECT auth.uid()))));

DROP POLICY IF EXISTS tarefas_update ON public.tarefas;
CREATE POLICY tarefas_update ON public.tarefas FOR UPDATE TO authenticated
  USING (
    (SELECT private.cap_carteira_escrever((SELECT auth.uid())))
    OR assigned_to = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.carteira_coverage cc
       WHERE cc.covered_user_id = tarefas.assigned_to
         AND cc.covering_user_id = (SELECT auth.uid())
         AND cc.active AND now() >= cc.valid_from
         AND (cc.valid_until IS NULL OR now() <= cc.valid_until)
    )
  );

-- ── tarefa_eventos ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS tevt_select ON public.tarefa_eventos;
CREATE POLICY tevt_select ON public.tarefa_eventos FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.tarefas t
     WHERE t.id = tarefa_eventos.tarefa_id
       AND ((SELECT private.cap_carteira_ler((SELECT auth.uid())))
            OR t.assigned_to = (SELECT auth.uid())
            OR EXISTS (
              SELECT 1 FROM public.carteira_coverage cc
               WHERE cc.covered_user_id = t.assigned_to
                 AND cc.covering_user_id = (SELECT auth.uid())
                 AND cc.active AND now() >= cc.valid_from
                 AND (cc.valid_until IS NULL OR now() <= cc.valid_until)
            ))
  ));

DROP POLICY IF EXISTS tevt_insert ON public.tarefa_eventos;
CREATE POLICY tevt_insert ON public.tarefa_eventos FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.tarefas t
     WHERE t.id = tarefa_eventos.tarefa_id
       AND ((SELECT private.cap_carteira_escrever((SELECT auth.uid())))
            OR t.assigned_to = (SELECT auth.uid())
            OR EXISTS (
              SELECT 1 FROM public.carteira_coverage cc
               WHERE cc.covered_user_id = t.assigned_to
                 AND cc.covering_user_id = (SELECT auth.uid())
                 AND cc.active AND now() >= cc.valid_from
                 AND (cc.valid_until IS NULL OR now() <= cc.valid_until)
            ))
  ));

-- ── tarefa_satisfacao_candidatos ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS tcand_select ON public.tarefa_satisfacao_candidatos;
CREATE POLICY tcand_select ON public.tarefa_satisfacao_candidatos FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.tarefas t
     WHERE t.id = tarefa_satisfacao_candidatos.tarefa_id
       AND ((SELECT private.cap_carteira_ler((SELECT auth.uid())))
            OR t.assigned_to = (SELECT auth.uid())
            OR EXISTS (
              SELECT 1 FROM public.carteira_coverage cc
               WHERE cc.covered_user_id = t.assigned_to
                 AND cc.covering_user_id = (SELECT auth.uid())
                 AND cc.active AND now() >= cc.valid_from
                 AND (cc.valid_until IS NULL OR now() <= cc.valid_until)
            ))
  ));

DROP POLICY IF EXISTS tcand_update ON public.tarefa_satisfacao_candidatos;
CREATE POLICY tcand_update ON public.tarefa_satisfacao_candidatos FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.tarefas t
     WHERE t.id = tarefa_satisfacao_candidatos.tarefa_id
       AND ((SELECT private.cap_carteira_escrever((SELECT auth.uid())))
            OR t.assigned_to = (SELECT auth.uid())
            OR EXISTS (
              SELECT 1 FROM public.carteira_coverage cc
               WHERE cc.covered_user_id = t.assigned_to
                 AND cc.covering_user_id = (SELECT auth.uid())
                 AND cc.active AND now() >= cc.valid_from
                 AND (cc.valid_until IS NULL OR now() <= cc.valid_until)
            ))
  ));

-- ── tarefa_templates ───────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS tt_select ON public.tarefa_templates;
CREATE POLICY tt_select ON public.tarefa_templates FOR SELECT TO authenticated
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid()))) OR assigned_to = (SELECT auth.uid()));

DROP POLICY IF EXISTS tt_insert ON public.tarefa_templates;
CREATE POLICY tt_insert ON public.tarefa_templates FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid())))
              AND created_by = (SELECT auth.uid()));

DROP POLICY IF EXISTS tt_update ON public.tarefa_templates;
CREATE POLICY tt_update ON public.tarefa_templates FOR UPDATE TO authenticated
  USING ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))));

DROP POLICY IF EXISTS tt_delete ON public.tarefa_templates;
CREATE POLICY tt_delete ON public.tarefa_templates FOR DELETE TO authenticated
  USING ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))));

-- ── radar_* (prospecção) ───────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS radar_empresas_select_gestor ON public.radar_empresas;
CREATE POLICY radar_empresas_select_gestor ON public.radar_empresas FOR SELECT TO authenticated
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid()))));

DROP POLICY IF EXISTS radar_contatos_select_gestor ON public.radar_contatos;
CREATE POLICY radar_contatos_select_gestor ON public.radar_contatos FOR SELECT TO authenticated
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid()))));

DROP POLICY IF EXISTS radar_municipios_select_gestor ON public.radar_municipios;
CREATE POLICY radar_municipios_select_gestor ON public.radar_municipios FOR SELECT TO authenticated
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid()))));

DROP POLICY IF EXISTS radar_ingest_state_select_gestor ON public.radar_ingest_state;
CREATE POLICY radar_ingest_state_select_gestor ON public.radar_ingest_state FOR SELECT TO authenticated
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid()))));

-- ── identidade de cliente / não-vinculados ─────────────────────────────────────────────────
DROP POLICY IF EXISTS cca_select_gestor_master ON public.customer_canonical_alias;
CREATE POLICY cca_select_gestor_master ON public.customer_canonical_alias FOR SELECT TO authenticated
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid()))));

DROP POLICY IF EXISTS nv_select ON public.omie_clientes_nao_vinculados;
CREATE POLICY nv_select ON public.omie_clientes_nao_vinculados FOR SELECT TO authenticated
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid()))));

DROP POLICY IF EXISTS nv_state_select ON public.omie_nao_vinculados_state;
CREATE POLICY nv_state_select ON public.omie_nao_vinculados_state FOR SELECT TO authenticated
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid()))));

-- ── selfservice_cliente_allowlist (policy ALL → uma por comando) ───────────────────────────
-- Era um `FOR ALL` com o mesmo gate nos dois lados, escondendo que concede IUD junto com SELECT.
--
-- ⚠️ ARMADILHA APANHADA NA REVISÃO ADVERSÁRIA (Codex): a 1ª versão desta migration virou o ALL
-- em `USING (cap_carteira_ler) WITH CHECK (cap_carteira_escrever)`. Em PostgreSQL, **DELETE só
-- consulta o USING** — WITH CHECK não se aplica a DELETE. O resultado ficaria latentemente
-- inseguro: no dia em que a escrita fosse apertada, o gestor continuaria APAGANDO a allowlist
-- pela cláusula de LEITURA. Hoje não abre nada (as duas capabilities coincidem), mas é
-- exatamente o tipo de acoplamento que esta matriz existe para eliminar.
-- Por isso: uma policy por comando, com a capability certa em cada USING.
DROP POLICY IF EXISTS ss_allowlist_gestor_iud ON public.selfservice_cliente_allowlist;
DROP POLICY IF EXISTS ss_allowlist_select     ON public.selfservice_cliente_allowlist;
DROP POLICY IF EXISTS ss_allowlist_insert     ON public.selfservice_cliente_allowlist;
DROP POLICY IF EXISTS ss_allowlist_update     ON public.selfservice_cliente_allowlist;
DROP POLICY IF EXISTS ss_allowlist_delete     ON public.selfservice_cliente_allowlist;

CREATE POLICY ss_allowlist_select ON public.selfservice_cliente_allowlist FOR SELECT TO authenticated
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid()))));

CREATE POLICY ss_allowlist_insert ON public.selfservice_cliente_allowlist FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))));

CREATE POLICY ss_allowlist_update ON public.selfservice_cliente_allowlist FOR UPDATE TO authenticated
  USING      ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))))
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))));

CREATE POLICY ss_allowlist_delete ON public.selfservice_cliente_allowlist FOR DELETE TO authenticated
  USING ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))));

-- ── storage.objects — comprovantes de tarefa ───────────────────────────────────────────────
DROP POLICY IF EXISTS tarefa_comprov_select_own_ou_gestor ON storage.objects;
CREATE POLICY tarefa_comprov_select_own_ou_gestor ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'tarefa-comprovacoes'
    AND ((storage.foldername(name))[1] = ((SELECT auth.uid()))::text
         OR (SELECT private.cap_carteira_ler((SELECT auth.uid()))))
  );

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 6) VERSÃO DO CONTRATO — ativada POR ÚLTIMO (spec §4.1 passo 9)
--    O frontend consulta isto e só concede capability gerencial se >= 2. Se esta migration não
--    for aplicada, a função não existe, a RPC dá 404, o hook cai em fail-closed e o gestor segue
--    bloqueado. É o que fecha o furo "deu Publish no frontend e esqueceu a migration" — o modo de
--    falha nº 1 do Lovable (migration de nome custom não auto-aplica, e falha em silêncio).
-- ════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.authz_contract_version()
RETURNS integer
LANGUAGE sql
IMMUTABLE SECURITY INVOKER
SET search_path TO ''
AS $function$ SELECT 2 $function$;

COMMENT ON FUNCTION public.authz_contract_version() IS
  'E2/FU4 — versão do contrato de autorização vigente no BANCO. v2 = matriz de capability por '
  'recurso × ação (private.cap_*). O frontend (useCommercialRole) só concede capability gerencial '
  'se isto retornar >= 2; ausência/erro ⇒ fail-closed. Incrementar ao mudar a matriz.';

REVOKE ALL     ON FUNCTION public.authz_contract_version() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.authz_contract_version() TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 7) ASSERTIONS DE APPLY — o que elas provam, e o que NÃO provam
--
-- ⚠️ ESCOPO HONESTO (a 1ª versão deste comentário dizia "provam a transação" — exagero apontado
-- na revisão adversária). Isto é um guard de APPLY, não uma suíte de segurança. Prova:
-- completude textual do gate antigo, fail-closed das 6 capabilities, RLS ligada nas tabelas
-- money-path, grants de anon, e a versão do contrato.
--
-- NÃO prova, e passaria batido aqui: policy recriada com `USING (true)`, policy permissiva
-- paralela criada por outra migration, cmd/roles/permissive divergentes do desenhado.
-- Quem prova COMPORTAMENTO é `db/test-authz-capability-matrix.sh` — PG17, `SET ROLE
-- authenticated`, 43 asserts, com falsificação exigindo vermelho. Se você está lendo isto
-- durante um incidente: o harness é a fonte de verdade sobre o que a matriz concede.
-- ════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_orfas   int;
  v_cap     text;
  v_tabelas text[] := ARRAY[
    'cliente_tier_preco','venda_excecao_credito','cmc_ledger','markup_policy',
    'reposicao_cold_start_log','reposicao_depara_auto_log','reposicao_estoque_nao_confirmado_log',
    'reposicao_motor_run','reposicao_param_auto_log','reposicao_param_auto_run','reposicao_param_pin',
    'reposicao_pedidos_compra_run','reposicao_po_last_seen',
    'farmer_client_scores','customer_visit_scores','farmer_recommendations','farmer_calls',
    'farmer_bundle_recommendations','farmer_copilot_sessions','route_visits','visitas_agendadas',
    'tarefas','tarefa_eventos','tarefa_satisfacao_candidatos','tarefa_templates',
    'radar_empresas','radar_contatos','radar_municipios','radar_ingest_state',
    'customer_canonical_alias','omie_clientes_nao_vinculados','omie_nao_vinculados_state',
    'selfservice_cliente_allowlist','objects'
  ];
BEGIN
  -- A1 — completude: nenhuma policy nas 34 tabelas tratadas ainda depende do gate único.
  -- Se alguém (worktree paralela) adicionou policy nova numa dessas tabelas usando o gate antigo,
  -- isto acusa aqui em vez de deixar meia-matriz em produção.
  SELECT count(*) INTO v_orfas FROM pg_policies
   WHERE tablename = ANY(v_tabelas)
     AND (COALESCE(qual,'') || COALESCE(with_check,'')) ILIKE '%pode_ver_carteira_completa%';
  IF v_orfas > 0 THEN
    RAISE EXCEPTION 'E2/FU4 A1: % policy(ies) nas tabelas tratadas ainda usam pode_ver_carteira_completa — matriz incompleta', v_orfas
      USING ERRCODE = 'raise_exception';
  END IF;

  -- A2 — fail-closed: uid inexistente não recebe NADA. Pega COALESCE errado e lógica invertida.
  IF private.cap_carteira_ler('00000000-0000-0000-0000-000000000000')
     OR private.cap_carteira_escrever('00000000-0000-0000-0000-000000000000')
     OR private.cap_custo_ler('00000000-0000-0000-0000-000000000000')
     OR private.cap_preco_escrever('00000000-0000-0000-0000-000000000000')
     OR private.cap_credito_escrever('00000000-0000-0000-0000-000000000000')
     OR private.cap_compras_ler('00000000-0000-0000-0000-000000000000') THEN
    RAISE EXCEPTION 'E2/FU4 A2: uid inexistente recebeu capability — nao esta fail-closed'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- A3 — uid NULL idem (NULL-blindness é a armadilha clássica: NOT NULL = NULL, não true).
  -- As 6, não 5: a 1ª versão esquecia `cap_carteira_escrever` (apanhado na revisão adversária).
  IF COALESCE(private.cap_carteira_ler(NULL), false)
     OR COALESCE(private.cap_carteira_escrever(NULL), false)
     OR COALESCE(private.cap_custo_ler(NULL), false)
     OR COALESCE(private.cap_preco_escrever(NULL), false)
     OR COALESCE(private.cap_credito_escrever(NULL), false)
     OR COALESCE(private.cap_compras_ler(NULL), false) THEN
    RAISE EXCEPTION 'E2/FU4 A3: uid NULL recebeu capability' USING ERRCODE = 'raise_exception';
  END IF;

  -- A4 — o oráculo não voltou: NENHUMA das 6 pode ser executável por anon (a 1ª versão testava
  -- só 2 de 6 — uma capability aberta passaria batido).
  FOR v_cap IN SELECT unnest(ARRAY['cap_carteira_ler','cap_carteira_escrever','cap_custo_ler',
                                   'cap_preco_escrever','cap_credito_escrever','cap_compras_ler'])
  LOOP
    IF has_function_privilege('anon', format('private.%I(uuid)', v_cap), 'EXECUTE') THEN
      RAISE EXCEPTION 'E2/FU4 A4: anon com EXECUTE em private.% — oraculo aberto', v_cap
        USING ERRCODE = 'raise_exception';
    END IF;
    IF NOT has_function_privilege('authenticated', format('private.%I(uuid)', v_cap), 'EXECUTE') THEN
      RAISE EXCEPTION 'E2/FU4 A4b: authenticated SEM EXECUTE em private.% — as policies dariam 42501', v_cap
        USING ERRCODE = 'raise_exception';
    END IF;
  END LOOP;

  -- A5 — o contrato está na versão que o frontend espera.
  IF public.authz_contract_version() <> 2 THEN
    RAISE EXCEPTION 'E2/FU4 A5: authz_contract_version() = % (esperado 2)', public.authz_contract_version()
      USING ERRCODE = 'raise_exception';
  END IF;

  -- A6 — RLS LIGADA nas tabelas money-path. Sem isto, a policy mais bem escrita é decorativa:
  -- um `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` em qualquer migration paralela abriria a
  -- tabela inteira e nenhuma das assertions anteriores perceberia (apanhado na revisão).
  FOR v_cap IN SELECT unnest(ARRAY['cliente_tier_preco','venda_excecao_credito','cmc_ledger',
                                   'markup_policy','selfservice_cliente_allowlist'])
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = v_cap AND c.relrowsecurity) THEN
      RAISE EXCEPTION 'E2/FU4 A6: RLS DESLIGADA em public.% — as policies sao decorativas', v_cap
        USING ERRCODE = 'raise_exception';
    END IF;
  END LOOP;

  -- A7 — as 4 RPCs SECDEF de custo: gate antigo AUSENTE **e** gate novo PRESENTE.
  -- Só a ausência não basta (apagar o gate sem pôr o novo passaria). Regex tolerante a
  -- qualificação/espaçamento: casar a string literal deixaria passar `public.gate ( … )`.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fin_estimar_estoque_omie','medir_abaixo_piso_tier',
                         'get_preco_cockpit','get_defasagem_cliente')
       AND (pg_get_functiondef(p.oid) ~ '(public\.)?pode_ver_carteira_completa\s*\('
            OR pg_get_functiondef(p.oid) !~ 'private\.cap_custo_ler\s*\(')
  ) THEN
    RAISE EXCEPTION 'E2/FU4 A7: RPC de custo sem o gate novo (ou ainda com o antigo) — o papel gerencial seguiria concedendo custo'
      USING ERRCODE = 'raise_exception';
  END IF;
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- VALIDAÇÃO PÓS-APPLY (read-only — rodar no SQL Editor depois do COMMIT)
-- ════════════════════════════════════════════════════════════════════════════════════════════
-- -- 1) A matriz existe e o contrato está em v2:
-- SELECT public.authz_contract_version() AS versao,
--        count(*) FILTER (WHERE p.proname LIKE 'cap\_%') AS capabilities
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'private';
-- -- esperado: versao=2, capabilities=6
--
-- -- 2) Zero resíduo do gate único nas tabelas money-path:
-- SELECT tablename, cmd, policyname FROM pg_policies
--  WHERE (COALESCE(qual,'')||COALESCE(with_check,'')) ILIKE '%pode_ver_carteira_completa%'
--  ORDER BY tablename, cmd;
-- -- esperado: 0 linhas (o gate antigo sobrevive só como função, para as edges via wrapper)
--
-- -- 3) Preço/crédito/custo/compras estão nas capabilities certas:
-- SELECT tablename, cmd, policyname,
--        CASE WHEN (COALESCE(qual,'')||COALESCE(with_check,'')) ILIKE '%cap_preco_escrever%'   THEN 'preco'
--             WHEN (COALESCE(qual,'')||COALESCE(with_check,'')) ILIKE '%cap_credito_escrever%' THEN 'credito'
--             WHEN (COALESCE(qual,'')||COALESCE(with_check,'')) ILIKE '%cap_custo_ler%'        THEN 'custo'
--             WHEN (COALESCE(qual,'')||COALESCE(with_check,'')) ILIKE '%cap_compras_ler%'      THEN 'compras'
--             ELSE 'carteira' END AS capability
--   FROM pg_policies
--  WHERE tablename IN ('cliente_tier_preco','venda_excecao_credito','cmc_ledger','markup_policy')
--  ORDER BY tablename, cmd;
