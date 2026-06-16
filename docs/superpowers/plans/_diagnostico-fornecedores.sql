-- =============================================================================
-- Fornecedores fora da carteira — DIAGNÓSTICO + CURADORIA + CLEANUP (operacional)
-- =============================================================================
-- RÉGUA A (founder, 2026-06-15): sai da carteira quem tem tag {Fornecedor,Transportadora}
--   E NÃO tem venda real (pedido válido) E NÃO é exceção curada. "Tem pedido = cliente, fica."
--
-- Cole bloco a bloco no SQL Editor do Lovable, NA ORDEM. PASSOS 1-2 são read-only (seguros).
-- PASSO 4 (classificar + cleanup, money-path) só DEPOIS de, nesta ordem:
--   (a) migrations A+B aplicadas; (b) edges com filtro deployados; (c) sync rodado (tags populadas).
-- Reversível: carteira-rebuild re-deriva eligible e reverter_exclusao_fornecedor() traz de volta.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- PASSO 1 — Volume (READ-ONLY). Confere a escala antes de qualquer escrita.
-- Referência 15/06 (account vendas/Oben): 627 total · 98 ficam (venda) · 529 saem.
-- -----------------------------------------------------------------------------
WITH base AS (
  SELECT cc.user_id,
    EXISTS (SELECT 1 FROM unnest(cc.tags_omie) t WHERE lower(trim(t)) IN ('fornecedor','transportadora')) AS is_forn,
    EXISTS (SELECT 1 FROM public.sales_orders so
              WHERE so.customer_user_id = cc.user_id
                AND so.status NOT IN ('cancelado','rascunho','pendente')) AS tem_venda
  FROM public.cliente_classificacao cc
)
SELECT
  count(*) FILTER (WHERE is_forn)                  AS forn_total,
  count(*) FILTER (WHERE is_forn AND tem_venda)    AS ficam_tem_venda,
  count(*) FILTER (WHERE is_forn AND NOT tem_venda) AS saem_sem_venda
FROM base;


-- -----------------------------------------------------------------------------
-- PASSO 2 — Curadoria (READ-ONLY): fornecedores que VÃO SAIR mas têm tag 'Cliente'
--   (o Omie marcou como cliente, porém nunca compraram). Revise — se algum for cliente
--   real que vai comprar, marque exceção no PASSO 3. Os SEM tag 'Cliente' são fornecedor
--   óbvio (3M, Correios, Abrasivos) e não precisam de revisão.
-- -----------------------------------------------------------------------------
SELECT cc.user_id,
       coalesce(p.name, p.razao_social, '—') AS nome,
       cc.tags_omie,
       a.city, a.state
FROM public.cliente_classificacao cc
LEFT JOIN public.profiles  p ON p.user_id = cc.user_id
LEFT JOIN public.addresses a ON a.user_id = cc.user_id AND a.is_default = true
WHERE EXISTS (SELECT 1 FROM unnest(cc.tags_omie) t WHERE lower(trim(t)) IN ('fornecedor','transportadora'))
  AND EXISTS (SELECT 1 FROM unnest(cc.tags_omie) t WHERE lower(trim(t)) = 'cliente')
  AND NOT EXISTS (SELECT 1 FROM public.sales_orders so
                    WHERE so.customer_user_id = cc.user_id
                      AND so.status NOT IN ('cancelado','rascunho','pendente'))
ORDER BY nome
LIMIT 300;


-- -----------------------------------------------------------------------------
-- PASSO 3 — Curadoria (ESCRITA, OPCIONAL): marca exceção p/ cliente real que a régua
--   removeria. Cole os user_id do PASSO 2. Pode pular se a lista estiver limpa.
-- -----------------------------------------------------------------------------
-- INSERT INTO public.fornecedor_excecao (user_id, motivo) VALUES
--   ('<user_id>', 'cliente real — vai comprar'),
--   ('<user_id>', '...')
-- ON CONFLICT (user_id) DO NOTHING;


-- -----------------------------------------------------------------------------
-- PASSO 4 — Classificar + cleanup (ESCRITA, money-path). Só após (a)(b)(c) do cabeçalho.
--   classificar() seta excluir_da_carteira pela régua A. cleanup: eligible=false + apaga os
--   scores dos excluídos (os filtros já deployados impedem que voltem).
-- -----------------------------------------------------------------------------
SELECT public.classificar_clientes_fornecedores();   -- → {classificados, excluidos}

UPDATE public.carteira_assignments SET eligible = false, updated_at = now()
 WHERE customer_user_id IN (SELECT user_id FROM public.cliente_classificacao WHERE excluir_da_carteira);

DELETE FROM public.customer_visit_scores
 WHERE customer_user_id IN (SELECT user_id FROM public.cliente_classificacao WHERE excluir_da_carteira);

DELETE FROM public.farmer_client_scores
 WHERE customer_user_id IN (SELECT user_id FROM public.cliente_classificacao WHERE excluir_da_carteira);


-- -----------------------------------------------------------------------------
-- PASSO 5 — Cron (ESCRITA): re-classifica nightly às 7:15 (antes do carteira-rebuild 7:30),
--   mantendo excluir_da_carteira fresco conforme novos fornecedores entram pelo sync.
--   SQL puro (sem net.http_post → sem o risco de timeout). Idempotente.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM cron.unschedule('classificar-fornecedores-nightly')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'classificar-fornecedores-nightly');
  PERFORM cron.schedule('classificar-fornecedores-nightly', '15 7 * * *',
    $cron$ SELECT public.classificar_clientes_fornecedores(); $cron$);
END $$;


-- -----------------------------------------------------------------------------
-- PASSO 6 — Verificação antes/depois + reversão de teste.
-- -----------------------------------------------------------------------------
-- (a) fornecedores excluídos que ainda aparecem elegíveis (esperado 0):
SELECT count(*) AS forn_excluido_ainda_eligivel
FROM public.cliente_classificacao cc
JOIN public.carteira_assignments ca ON ca.customer_user_id = cc.user_id AND ca.eligible
WHERE cc.excluir_da_carteira;

-- (b) Caxias do Sul (cidade que o founder citou) — sugestões restantes:
SELECT count(*) AS visit_scores_caxias
FROM public.customer_visit_scores cvs
JOIN public.addresses a ON a.user_id = cvs.customer_user_id AND a.is_default
WHERE a.city ILIKE 'caxias%';

-- (c) reversão de teste (rode como MASTER): pega 1 excluído, reverte, confirma que volta.
-- SELECT public.reverter_exclusao_fornecedor('<user_id excluído>', 'teste de reversão');
-- Depois: SELECT excluir_da_carteira FROM public.cliente_classificacao WHERE user_id = '<...>';  -- false
