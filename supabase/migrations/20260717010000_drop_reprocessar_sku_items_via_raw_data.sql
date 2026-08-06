-- DROP da public.reprocessar_sku_items_via_raw_data(text) — utilitário manual de 2026-04 que
-- hoje é uma ARMA CARREGADA apontada exatamente para o que o #1365 acabou de proteger.
--
-- ⚠️ TODOS os números abaixo foram medidos em PROD (OBEN) em 2026-07-17 02:36 UTC, ou seja
-- DEPOIS do #1365 ter sido aplicado. Isto importa: durante a investigação deste PR o #1365
-- entrou em produção e os números mudaram sob os pés (a assinatura do Bug 2 caiu de 328 para
-- 112; lt_bruto NULL caiu de 1295 para 514). Re-meça antes de citar.
--
-- ─── O QUE RODAR ESTA FUNÇÃO HOJE FARIA (medido) ───────────────────────────────────────
--   histórico OBEN            3923 linhas
--   o DELETE apaga             514
--     ├─ 415 DELIBERADAMENTE anuladas pelo #1365 (o gate leadtime_t1_e_data_de_pedido diz
--     │       que o t1 delas NÃO é data de pedido — órfã ou fallback provado)
--     └─  57 de OUTROS fornecedores (o INSERT nunca as recria — perda permanente)
--   o INSERT recria            222
--   PERDA LÍQUIDA              292 linhas = 7,4% do histórico
-- E o que ele recria, recria com o Bug 2 abaixo: reintroduz o lt_bruto mentiroso que
-- SUBESTIMA e faz pedir tarde — a mentira que o #1365 existe para matar.
--
-- ─── OS DOIS BUGS (achado Codex gpt-5.6-sol/xhigh na revisão do #1365; ambos confirmados
--     no corpo real de prod via pg_get_functiondef) ─────────────────────────────────────
--   BUG 1 — DELETE amplo × INSERT estreito. Abre com
--     DELETE FROM sku_leadtime_history WHERE empresa::text = p_empresa AND lt_bruto_dias_uteis IS NULL;
--   SEM filtro de fornecedor, enquanto o INSERT que repovoa é filtrado em
--   fornecedor_codigo_omie = 8689681266 (Sayerlack). Pontas ASSIMÉTRICAS: linha de outro
--   fornecedor é apagada e NUNCA recriada. Pior depois do #1365, que deu a `lt_bruto IS NULL`
--   um segundo significado — "deliberadamente desconhecido" — que o DELETE não distingue de
--   "ainda não calculado".
--
--   BUG 2 — o CASE testa o t1 errado. Grava t1 = COALESCE(t1_real, t1_data_pedido) mas calcula
--   os lt_* só `CASE WHEN t1_real IS NOT NULL AND t4 IS NOT NULL`. Quando o LEFT JOIN LATERAL
--   não casa o pedido, o t1 GRAVADO é válido e os lt_* ficam NULL assim mesmo (lt_logistica,
--   que não depende de t1_real, fica preenchido). Foi assim que nasceram as 328 linhas de
--   created_at = 2026-04-19 — a única execução conhecida da função.
--
-- ─── POR QUE DROP E NÃO CORRIGIR OS DOIS BUGS ──────────────────────────────────────────
-- Porque os dois bugs não são a doença. A função é um FÓSSIL: o INSERT depende de
-- raw_data->'cabec'->>'cModeloNFe' = '55', mas purchase_orders_tracking.raw_data é
-- POLIMÓRFICO (guarda payloads de endpoints diferentes do Omie) e derivou desde abril. Das
-- 612 NFes Sayerlack/OBEN: 532 não têm sequer a chave 'cabec' (forma 'cabecalho_consulta'/
-- 'produtos_consulta'), 66 têm 'cabec' sem 'itensRecebimento', e 14 é o que o INSERT enxerga.
-- (14/612 NFes — não confundir com 2,3% do valor/itens/sinal: a evidência destrutiva forte é
-- a perda líquida de 292 linhas, não a proporção.)
-- Consertar o CASE e escopar o DELETE deixaria de pé o bug CENTRAL — um parser incompatível
-- com o raw_data de hoje. Uma função de verdade corrigida teria de normalizar as versões do
-- raw_data, materializar em staging, medir cobertura, e nunca apagar chave fora do conjunto
-- comprovadamente reconstruível. Isso é escrever outra função, não consertar esta.
--
-- E ela não tem usuário: ZERO chamadores (nenhum cron.job, nenhuma edge, nenhum código em
-- src/ — as únicas menções no repo são o types.ts auto-gerado e um `ALTER FUNCTION ... SET
-- search_path` em 20260510223800, que não é chamador), ZERO dependências em pg_depend, e
-- capacidade única VAZIA: NFes Sayerlack com itens no raw_data e sem linha na history = 0.
-- (Rigor: "zero ausentes HOJE" prova ausência de trabalho atual, não inutilidade futura. O que
-- fecha o caso é a combinação — writer diário saudável + zero chamador + parser incompatível.)
-- O sintoma que ela existia para tratar (lt_* NULL) é coberto honestamente e DIARIAMENTE pelo
-- recompute derivado do #1365, que faz UPDATE gateado por proveniência em vez de DELETE cego.
--
-- ─── ESCOPO / REVERSÃO ─────────────────────────────────────────────────────────────────
-- O passivo das 328 linhas de 2026-04-19 NÃO é tratado aqui de propósito: quem as corrige/anula
-- é o recompute do #1365. Esta migration só remove a arma — e por isso é INDEPENDENTE do #1365:
-- aplica em qualquer ordem, sem risco de late-bound.
-- A definição EXATA da função (corpo verbatim de pg_get_functiondef, 2026-07-16) fica preservada
-- em db/test-drop-reprocessar-sku-items.sh, que a recria para provar o dano — cadeia de
-- evidência mantida no Git sem manter a arma chamável no catálogo. Se um backfill de itens via
-- raw_data voltar a ser necessário, ele deve ser ESCRITO DE NOVO contra a forma atual do
-- raw_data, com gate de proveniência (public.leadtime_t1_e_data_de_pedido) — não ressuscitado
-- deste corpo.
--
-- Prova: db/test-drop-reprocessar-sku-items.sh (PG17; caracteriza o dano rodando a função REAL
-- de prod, incluindo o apagamento de linha protegida pelo gate do #1365, + 4 falsificações).

-- Guard de drift + idempotência. NÃO usar `DROP ... IF EXISTS` cru: se a assinatura em prod
-- divergisse (overload novo, parâmetro a mais), o IF EXISTS não dropava nada e ainda assim
-- reportava sucesso — falha SILENCIOSA, o padrão que este repo mais paga caro. Aqui: ausente
-- → NOTICE (re-aplicar é seguro); divergente → EXCEPTION ruidosa; exatamente a esperada → DROP.
-- RESTRICT é o default do DROP FUNCTION e é o que queremos: nunca CASCADE.
DO $$
DECLARE
  v_assinaturas text[];
BEGIN
  SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text)
    INTO v_assinaturas
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'reprocessar_sku_items_via_raw_data';

  IF v_assinaturas IS NULL THEN
    RAISE NOTICE 'reprocessar_sku_items_via_raw_data já não existe — nada a fazer.';
    RETURN;
  END IF;

  IF v_assinaturas <> ARRAY['reprocessar_sku_items_via_raw_data(text)'] THEN
    RAISE EXCEPTION 'DRIFT DE ASSINATURA: esperava exatamente {reprocessar_sku_items_via_raw_data(text)}, encontrei %. Abortado — confira a prod antes de dropar.', v_assinaturas;
  END IF;

  DROP FUNCTION public.reprocessar_sku_items_via_raw_data(text);
  RAISE NOTICE 'reprocessar_sku_items_via_raw_data(text) removida.';
END $$;
