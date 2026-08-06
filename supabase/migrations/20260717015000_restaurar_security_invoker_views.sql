-- Fix de SEGURANÇA — restaura security_invoker=on em 5 views que o perderam em produção.
--
-- ─── O DEFEITO (auditado na prod via psql-ro, 2026-07-16) ─────────────────────────────
-- Cinco views de public estão hoje SEM `security_invoker`. Todas têm owner=postgres
-- (superuser) e NENHUMA tem gate próprio no corpo (nem auth.uid(), nem has_role()) — elas
-- sempre dependeram do RLS das tabelas-base para autorizar. Com o invoker desligado, a
-- view lê as tabelas com a identidade do OWNER, e o RLS dessas tabelas — que é staff-only
-- (`has_role(uid,'master') OR has_role(uid,'employee')`) — deixa de ser aplicado.
-- Resultado: a view devolve tudo para quem tem SELECT nela.
--
--   view                              | grant       | consequência
--   v_sku_sla_compliance              | anon + auth | leitura SEM LOGIN (PostgREST expõe public)
--   v_sku_candidatos_primeira_compra  | auth        | qualquer customer logado
--   v_sku_demanda_estatisticas        | auth        | qualquer customer logado
--   v_sku_demanda_rajada              | auth        | qualquer customer logado
--   v_sku_sigma_demanda               | auth        | qualquer customer logado
--
-- Conteúdo exposto: fornecedor, lead time, SLA, demanda, sigma e candidatos de compra com
-- preço — dado interno de reposição, para uma base cujo papel dominante é `customer`.
--
-- ─── A CAUSA: CREATE OR REPLACE VIEW **sem** o WITH RESETA a opção ────────────────────
-- Não é "não muda"; é reset silencioso. Provado no PG17 (db/test-security-invoker-views.sh):
--     CREATE OR REPLACE VIEW vw WITH (security_invoker = on) AS ...  -> {security_invoker=on}
--     CREATE OR REPLACE VIEW vw AS ...                              -> NULL  (= definer)
-- O CREATE OR REPLACE não preserva reloptions omitidas. Toda recriação precisa REPETIR o
-- WITH — e nada no CI pega isso, porque o SQL é válido e a view segue funcionando: só a
-- autorização muda, e muda para MAIS permissiva (falha aberta, não fechada).
--
-- ─── ORIGEM DE CADA UMA (rastreado; o snapshot de 2026-06-27 é a testemunha) ──────────
-- O snapshot traz as 5 com WITH (security_invoker='on') ⇒ todas JÁ estiveram corretas.
--   • v_sku_sla_compliance → regressão do #1354 (20260716230000), que recriou a view com
--     `CREATE OR REPLACE VIEW public.v_sku_sla_compliance AS` (sem o WITH). Rastro no repo.
--   • as outras 4 → nenhuma migration do repo as recria sem o WITH (as 4 de
--     v_sku_candidatos_primeira_compra têm o WITH; as 3 de demanda não têm migration
--     nenhuma — nasceram fora do repo). Logo: apply manual no SQL Editor / chat do Lovable
--     entre 2026-06-27 e 2026-07-16. Sem rastro versionado — é o gotcha "apply manual
--     diverge do repo" (docs/agent/database.md) na sua forma cara.
--
-- ─── ESCOPO: por que só estas 5 ───────────────────────────────────────────────────────
-- Há outras views em public sem invoker, e elas foram verificadas uma a uma — NÃO entram:
-- são definer INTENCIONAL, com gate explícito no corpo. Ex.: selfservice_meus_pedidos
-- filtra `so.customer_user_id = auth.uid()` — ela precisa ler sales_orders sem dar RLS ao
-- customer, e se autoriza sozinha ("gate na fronteira"). Ligar o invoker nelas QUEBRARIA o
-- self-service. O critério aqui é estreito e verificável: (a) o snapshot prova que a view
-- já teve invoker=on, e (b) o corpo não tem gate próprio ⇒ ela depende de RLS ⇒ restaurar.
--
-- ─── ALTER VIEW, não CREATE OR REPLACE ────────────────────────────────────────────────
-- Muda só a reloption; não toca o corpo. Assim este fix não colide com o #1366 nem com a
-- repontagem da CTE precos_compra (que mexem em corpo), e não corre o risco de reordenar
-- coluna. Idempotente: ALTER VIEW ... SET é seguro de re-rodar.
--
-- Prova: db/test-security-invoker-views.sh (PG17, RLS sob SET ROLE + GUC, com falsificação).

ALTER VIEW public.v_sku_sla_compliance             SET (security_invoker = on);
ALTER VIEW public.v_sku_candidatos_primeira_compra SET (security_invoker = on);
ALTER VIEW public.v_sku_demanda_estatisticas       SET (security_invoker = on);
ALTER VIEW public.v_sku_demanda_rajada             SET (security_invoker = on);
ALTER VIEW public.v_sku_sigma_demanda              SET (security_invoker = on);
