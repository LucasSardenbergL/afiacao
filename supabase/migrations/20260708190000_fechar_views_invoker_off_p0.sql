-- 20260708190000_fechar_views_invoker_off_p0.sql
-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  P0 SEGURANÇA — 5 views public com security_invoker=off (default) + owner=      ║
-- ║  postgres bypassavam a RLS das tabelas-base e projetavam DADOS COMERCIAIS       ║
-- ║  (preço de compra real, custo, margem, demanda, histórico de vendas) a QUALQUER ║
-- ║  caller com a anon-key pública (que está no bundle do front) via PostgREST      ║
-- ║  direto (GET /rest/v1/<view>), SEM autenticar — e a customer autenticado (que   ║
-- ║  compartilha o role PostgREST `authenticated` com o staff).                     ║
-- ║                                                                                ║
-- ║  Invariante (auth): anon e customer NÃO leem estas views (0 linhas / negado);   ║
-- ║  staff (employee/master) continua lendo (não-regressão da tela de reposição).   ║
-- ║  Prova + FALSIFICAÇÃO no PG17: db/test-views-invoker-off-p0.sh                   ║
-- ║                                                                                ║
-- ║  ⚠️ MIGRATION MANUAL — Lovable não auto-aplica nome custom. SQL Editor → Run.    ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝
--
-- MECANISMO (security_invoker): uma view ON lê as relações que ela referencia DIRETAMENTE
--   como o CALLER; OFF, como o owner (postgres, que bypassa RLS). Isso NÃO se propaga
--   transitivamente — cada view governa só as suas leituras diretas. Logo, o elo que
--   fecha cada tabela é a view que a lê direto:
--     • venda_items_history + sku_substituicao  → lidas dentro de v_venda_items_history_efetivo (a FOLHA)
--     • sku_parametros + omie_products           → lidas dentro de v_sku_candidatos_primeira_compra
--     • v_sku_parametros_sugeridos (já ON)        → protege a sub-cadeia que ela encapsula
--   Com a folha OFF, TODA leitura de venda_items_history (pelas 4 views que a consomem)
--   roda como postgres e vaza — por isso a folha ON é o elo decisivo. Ligamos a CADEIA
--   INTEIRA ON (não só os elos estritamente necessários): defense-in-depth e consistência
--   com o padrão do repo (53/59 views anon-readable já são invoker=on). Provado +
--   FALSIFICADO no PG17 (folha off → as views de demanda voltam a vazar p/ não-staff).
--
-- NÃO toca v_oportunidade_economica_hoje_badge_cached: o invoker=off dela é DELIBERADO
--   (view-gate sobre MV em schema private, gate has_role no WHERE — padrão documentado em
--   docs/agent/database.md §4). Ligar invoker=on nela quebraria (perde acesso à MV private).

-- Guard: aborta cedo se prod divergiu (as 5 views-alvo têm de existir). Idempotente.
DO $$
DECLARE v_faltando text[];
BEGIN
  SELECT array_agg(x) INTO v_faltando
  FROM unnest(ARRAY[
    'v_venda_items_history_efetivo','v_sku_demanda_estatisticas','v_sku_demanda_rajada',
    'v_sku_sigma_demanda','v_sku_candidatos_primeira_compra']) AS x
  WHERE to_regclass('public.'||x) IS NULL;
  IF v_faltando IS NOT NULL THEN
    RAISE EXCEPTION 'views-alvo ausentes (prod divergiu?): %', v_faltando;
  END IF;
END $$;

-- (1) security_invoker=on na cadeia inteira (idempotente — SET é no-op se já on).
ALTER VIEW public.v_venda_items_history_efetivo    SET (security_invoker = on);
ALTER VIEW public.v_sku_demanda_estatisticas       SET (security_invoker = on);
ALTER VIEW public.v_sku_demanda_rajada             SET (security_invoker = on);
ALTER VIEW public.v_sku_sigma_demanda              SET (security_invoker = on);
ALTER VIEW public.v_sku_candidatos_primeira_compra SET (security_invoker = on);

-- (2) Defense-in-depth: revogar SELECT de anon E PUBLIC (nenhuma tela anon consome — todas são
--     de reposição/staff). PUBLIC é no-op hoje (o relacl das 5 views não tem grant a PUBLIC), mas
--     blinda contra drift (database.md §75: barrar anon de fato exige anon E PUBLIC). authenticated
--     MANTÉM SELECT: staff precisa; customer é filtrado pela RLS via invoker=on (revogar
--     authenticated barraria staff). REVOKE é idempotente — no-op se já revogado.
REVOKE SELECT ON public.v_venda_items_history_efetivo    FROM anon, PUBLIC;
REVOKE SELECT ON public.v_sku_demanda_estatisticas       FROM anon, PUBLIC;
REVOKE SELECT ON public.v_sku_demanda_rajada             FROM anon, PUBLIC;
REVOKE SELECT ON public.v_sku_sigma_demanda              FROM anon, PUBLIC;
REVOKE SELECT ON public.v_sku_candidatos_primeira_compra FROM anon, PUBLIC;
