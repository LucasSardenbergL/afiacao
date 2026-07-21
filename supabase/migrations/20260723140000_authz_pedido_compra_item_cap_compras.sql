-- ════════════════════════════════════════════════════════════════════════════════════════════
-- FU4-F fase 2b — pedido_compra_item: a 10ª tabela de compras, esquecida pelo #1434
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- CONTEXTO. Achado da revisão adversária do Codex (xhigh) sobre o #1473: ele listou
-- `pedido_compra_item.preco_unitario` como campo de custo persistido cujas "policies reais ainda
-- precisam ser verificadas". Verifiquei em prod (psql-ro, 2026-07-20) e a porta estava aberta.
--
-- O #1434 (E2/FU4) fechou **9 tabelas** do domínio de compras em `private.cap_compras_ler`
-- (master-only). Todas as 9 são tabelas de LOG (`reposicao_*_log`) — telemetria, só SELECT.
-- `pedido_compra_item` é do MESMO domínio, guarda `preco_unitario` e `preco_sem_desconto` (o que o
-- grupo paga ao fornecedor) e ficou com as 4 policies em `has_role(master) OR has_role(employee)`.
-- Não é uma decisão registrada em lugar nenhum: é a 10ª irmã que passou batido porque não casa com
-- o padrão de nome `reposicao_*_log` pelo qual as outras foram varridas.
--
-- POR QUE `cap_compras_ler` E NÃO `cap_custo_ler`. Preço de fornecedor é telemetria de COMPRAS, não
-- custo de carteira comercial — o #1434 já separou as duas capabilities de propósito
-- ("compras não é carteira"). Usar a irmã errada aqui fragmentaria o contrato: quando existir papel
-- de compras no enum, é `cap_compras_ler` que muda, e esta tabela tem de acompanhar as outras 9.
--
-- ⚠️ DIFERENÇA ESTRUTURAL EM RELAÇÃO ÀS 9 IRMÃS — e por que as 4 policies fecham, não só a leitura.
-- As irmãs são log (SELECT apenas). Esta é OPERACIONAL: o frontend escreve nela
-- (`useDetalhesModal.ts` faz DELETE de item e de lote; `useSkuMapeamento.ts` lê). Deixar
-- INSERT/UPDATE/DELETE em `has_role` enquanto o SELECT fecha produziria o pior dos dois mundos —
-- um employee que não pode LER o preço mas ainda pode APAGAR o item de pedido. Least privilege
-- exige as quatro.
--
-- QUEM PERDE, DE VERDADE. Os 2 employees em prod (ambos `commercial_role='farmer'`).
-- `cap_compras_ler` é master-only, então eles perdem leitura E escrita de itens de pedido de compra.
-- É consistente com a decisão do dono de 2026-07-20 — reposição/compras é trabalho do master — e
-- com o fechamento de `inventory_position` no #1473, que já tirou dessas mesmas telas.
-- O master não perde nada: passa em `cap_compras_ler` por ser master.
--
-- IMUNES: edges e cron usam `service_role` (BYPASSRLS); funções SECURITY DEFINER com owner
-- `postgres` seguem escrevendo. O wrap InitPlan `(SELECT ...)` é acrescentado — as policies atuais
-- chamam `has_role(auth.uid(), ...)` CRU, que reavalia por linha (database.md §4).
--
-- Aplicada À MÃO pelo dono no SQL Editor do Lovable. Idempotente: pode reaplicar.
-- Prova: db/test-authz-pedido-compra-item.sh (PG17 + falsificação).
-- ════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'private' AND p.proname = 'cap_compras_ler'
  ) THEN
    RAISE EXCEPTION 'FU4-F 2b: private.cap_compras_ler ausente — aplique o #1434 (20260718190000) ANTES';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid = 'public.pedido_compra_item'::regclass AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'FU4-F 2b: pedido_compra_item sem RLS ligada — abortando (fechar policy sem RLS é no-op)';
  END IF;
END $$;

-- As QUATRO policies. Nomes preservados (o repo já os referencia); só a expressão muda.
-- Permissivas combinam com OR: fechar um subconjunto não fecha nada — foi o achado central do #1473.

DROP POLICY IF EXISTS staff_pedido_compra_item_select ON public.pedido_compra_item;
CREATE POLICY staff_pedido_compra_item_select
  ON public.pedido_compra_item
  FOR SELECT
  TO authenticated
  USING ((SELECT private.cap_compras_ler((SELECT auth.uid()))));

DROP POLICY IF EXISTS staff_pedido_compra_item_insert ON public.pedido_compra_item;
CREATE POLICY staff_pedido_compra_item_insert
  ON public.pedido_compra_item
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT private.cap_compras_ler((SELECT auth.uid()))));

DROP POLICY IF EXISTS staff_pedido_compra_item_update ON public.pedido_compra_item;
CREATE POLICY staff_pedido_compra_item_update
  ON public.pedido_compra_item
  FOR UPDATE
  TO authenticated
  USING      ((SELECT private.cap_compras_ler((SELECT auth.uid()))))
  WITH CHECK ((SELECT private.cap_compras_ler((SELECT auth.uid()))));

DROP POLICY IF EXISTS staff_pedido_compra_item_delete ON public.pedido_compra_item;
CREATE POLICY staff_pedido_compra_item_delete
  ON public.pedido_compra_item
  FOR DELETE
  TO authenticated
  USING ((SELECT private.cap_compras_ler((SELECT auth.uid()))));

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- VALIDAÇÃO PÓS-APPLY (read-only)
-- ════════════════════════════════════════════════════════════════════════════════════════════
-- SELECT
--   count(*) FILTER (WHERE coalesce(qual,with_check) ILIKE '%cap_compras_ler%') AS fechadas,   -- 4
--   count(*) FILTER (WHERE coalesce(qual,with_check) ILIKE '%has_role%')        AS antigas,    -- 0
--   count(*)                                                                    AS total,      -- 4
--   count(*) FILTER (WHERE coalesce(qual,with_check) ILIKE '%( select%')         AS wrapped     -- 4
-- FROM pg_policies WHERE schemaname='public' AND tablename='pedido_compra_item';
--
-- Conjunto de compras completo (as 9 irmãs + esta):
-- SELECT count(DISTINCT tablename) FROM pg_policies
--  WHERE schemaname='public' AND coalesce(qual,with_check) ILIKE '%cap_compras_ler%';  -- 10
