-- MOTOR DE RETRY dos órfãos retentáveis do portal Sayerlack — fecha a REMEDIAÇÃO do incidente
-- (~R$82k de pedidos órfãos). O Sentinela (checks reposicao_disparo/reposicao_portal, PR #450) já
-- fechou a DETECÇÃO; faltava o conserto automático.
--
-- BUG SISTÊMICO (Track A): o loop de retry de envio ao portal NÃO TINHA motor agendado.
--   • O fluxo é portal-FIRST: o portal precisa suceder (obter protocolo) ANTES de criar o pedido no
--     Omie (status='disparado'). Uma falha transitória do Browserless deixa o pedido em
--     status='aprovado_aguardando_disparo' + status_envio_portal IN (pendente_envio_portal/erro_retentavel),
--     agendando portal_proximo_retry_em=+15min.
--   • Esse retry de +15min NUNCA era disparado: o único cron (sayerlack-portal-watchdog */5) chama a edge
--     com {watchdog:true} → roda só runWatchdog (des-trava enviando_portal preso) e RETORNA. O modo LOTE
--     (body {}) exige status='disparado' — que no fluxo portal-first só existe APÓS sucesso → NO-OP pra
--     falha de portal. E o disparo diário é ciclo-scoped (data_ciclo=hoje) → aprovação de ciclo antigo
--     que falhou transitório fica órfã pra sempre.
--
-- FIX: motor SQL-only (sem redeploy de edge) que re-dirige o caminho PROVADO
-- disparar-pedidos-aprovados {empresa:OBEN, pedido_id} (re-roda o fluxo inteiro: portal async → Omie;
-- o guard de idempotência pula o portal se já há sucesso_portal+protocolo, não duplica no fornecedor).
-- Validado empíricamente: pedido #149 estava travado em enviando_portal (tent=2); re-disparo {pedido_id:149}
-- → sucesso_portal + protocolo 2098269 + disparado em ~45s (Browserless respondeu; falhas eram TRANSITÓRIAS).
--
-- DESENHO (revisado com codex — 1 correção crítica de money-path):
--   • SELETOR POSITIVO: status_envio_portal IN ('pendente_envio_portal','erro_retentavel') — NUNCA NOT IN.
--     Um NOT IN incluiria 'indeterminado_requer_conciliacao' (estado que o watchdog crava quando o
--     Browserless trava: "não sei se o portal recebeu") → auto-redrive poderia DUPLICAR o PO na Renner.
--     Também exclui 'erro_nao_retentavel' (SKU sem mapeamento — precisa humano, não retry).
--   • AGE-BOUND 3 dias: só re-dispara FRESCOS. Órfão velho pode estar obsoleto (estoque/demanda mudaram,
--     compra manual já feita) → re-disparar criaria PO obsoleto no fornecedor. Velhos = revisão humana
--     (Sentinela alerta + re-disparo manual por {pedido_id} após o founder confirmar validade).
--   • LIMIT 1 por run: Browserless é frágil; 1 disparo por ciclo não sobrecarrega (cada disparo é async).
--   • portal_tentativas < 3: respeita o MAX_TENTATIVAS=3 da edge (3 falhas → erro_nao_retentavel, fora).
--     NÃO subimos o teto agora — o bug era falta de motor, não teto baixo; medir antes (codex).
--   • pg_try_advisory_xact_lock: anti-overlap (auto-release no fim da transação do cron).
--   • Log de auditoria do que o motor auto-disparou (pedido_id + request_id + tentativa).
--
-- ⚠️ NÃO cobre (por design — triagem humana): erro_nao_retentavel (SKU sem mapeamento), órfão >3d
-- (revisão de obsolescência), nem o backlog ATUAL de ~R$82k (aprovado 22/04 e 14/05, fora da janela 3d) →
-- esses são re-dispatch manual operacional. O cron sayerlack-portal-lote-retry (*/15, no-op no fluxo
-- portal-first) é deixado como está (inofensivo, candidatos=0); remoção fica pra cleanup futuro.

-- 1) Log de auditoria do motor (interno; RLS on sem policy → só service_role/postgres, leitura via SQL Editor)
CREATE TABLE IF NOT EXISTS public.sayerlack_retry_motor_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pedido_id bigint NOT NULL,
  tentativa_no_disparo int,
  status_envio_portal_no_disparo text,
  aprovado_em timestamptz,
  request_id bigint,
  criado_em timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.sayerlack_retry_motor_log ENABLE ROW LEVEL SECURITY;

-- 2) Função do motor
CREATE OR REPLACE FUNCTION public.sayerlack_retry_orfaos()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_pedido record;
  v_cron_secret text;
  v_request_id bigint;
  v_url constant text := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/disparar-pedidos-aprovados';
BEGIN
  -- anti-overlap (codex): xact-level, auto-release no fim da transação do cron
  IF NOT pg_try_advisory_xact_lock(hashtext('sayerlack_retry_orfaos')) THEN
    RETURN jsonb_build_object('skipped', 'lock_indisponivel');
  END IF;

  SELECT id,
         COALESCE(portal_tentativas, 0) AS tent,
         status_envio_portal,
         aprovado_em
    INTO v_pedido
  FROM public.pedido_compra_sugerido
  WHERE empresa = 'OBEN'
    AND fornecedor_nome ILIKE '%SAYERLACK%'
    AND status IN ('aprovado_aguardando_disparo', 'falha_envio')
    -- SELETOR POSITIVO (codex): só retentável de verdade; nunca indeterminado/nao_retentavel
    AND status_envio_portal IN ('pendente_envio_portal', 'erro_retentavel')
    AND COALESCE(portal_tentativas, 0) < 3
    AND (portal_proximo_retry_em IS NULL OR portal_proximo_retry_em <= now())
    AND aprovado_em >= now() - INTERVAL '3 days'  -- só FRESCOS; velhos = revisão humana
  ORDER BY aprovado_em ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('candidatos', 0);
  END IF;

  SELECT decrypted_secret INTO v_cron_secret
  FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1;

  SELECT net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', v_cron_secret
    ),
    body := jsonb_build_object('empresa', 'OBEN', 'pedido_id', v_pedido.id),
    timeout_milliseconds := 60000
  ) INTO v_request_id;

  INSERT INTO public.sayerlack_retry_motor_log
    (pedido_id, tentativa_no_disparo, status_envio_portal_no_disparo, aprovado_em, request_id)
  VALUES (v_pedido.id, v_pedido.tent, v_pedido.status_envio_portal, v_pedido.aprovado_em, v_request_id);

  RETURN jsonb_build_object(
    'disparado', v_pedido.id,
    'tentativa', v_pedido.tent,
    'request_id', v_request_id
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.sayerlack_retry_orfaos() FROM anon, authenticated, PUBLIC;

-- 3) Cron */15 (alinha com o backoff de retry de 15min; idle é barato — candidatos=0 retorna rápido)
SELECT cron.schedule('sayerlack-retry-orfaos', '*/15 * * * *',
  $cron$ SELECT public.sayerlack_retry_orfaos(); $cron$);
