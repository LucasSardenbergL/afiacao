-- Conserta o BLIND SPOT do motor de retry do portal Sayerlack (causa-raiz dos órfãos que abriam os
-- cards reposicao_disparo / reposicao_portal no Sentinela). Diagnóstico (eu + 2 consults codex):
--
--   O cron sayerlack-portal-lote-retry (PR #453) chama a edge enviar-pedido-portal-sayerlack em modo
--   lote, que usa esta RPC pra travar candidatos. MAS:
--   (1) PREDICADO ERRADO: exigia status='disparado'. Um pedido Sayerlack em retry de portal fica em
--       status='aprovado_aguardando_disparo' — o status só vira 'disparado' DEPOIS que o Omie é criado
--       (disparar-pedidos-aprovados cria o Omie só na fase-2, que exige o protocolo do portal). Logo
--       erro_retentavel/pendente em 'aprovado_aguardando_disparo' NUNCA eram re-tentados pelo lote →
--       pedido órfão pra sempre (o motor "existia" mas mirava o estado que não acontece).
--   (2) AUTH AUTO-BLOQUEANTE: o gate `auth.uid() IS NULL OR NOT staff` lançava exceção pro service_role
--       (uid NULL = o caller real do cron), derrubando a RPC pro fallback da edge — que tinha o MESMO
--       filtro errado. A irmã public.pedido_compra_split já faz o correto: só exige role se uid IS NOT NULL.
--
-- FIX (camada RPC — NÃO toca _data_health_compute / cards do #460/#490):
--   (a) auth espelha pedido_compra_split: libera service_role, exige staff só p/ usuário autenticado.
--   (b) predicado: status IN ('aprovado_aguardando_disparo','disparado') [superset — preserva legado];
--       e usa o RELÓGIO ÚNICO E ESTÁVEL portal_proximo_retry_em pra ambos os estados (pendente/erro_retentavel).
--       NÃO usamos atualizado_em como relógio de stale: um trigger de timestamp o reiniciaria a cada UPDATE
--       (notificação, enriquecimento, edição) e o pendente legítimo nunca ficaria stale → recriaria o
--       blind-spot, mais sutil (achado do codex challenge). erro_retentavel já grava +15min ao falhar; o
--       pendente passa a gravar +15min ao ser criado (em iniciarEnvioPortalSayerlack) p/ NÃO correr com o
--       envio async inicial. portal_proximo_retry_em NULL = legado/preso → elegível já (retry correto).
--
-- SEGURO (não duplica pedido na Renner): a edge só processa pendente/erro_retentavel = "POST comprovadamente
-- não saiu"; estados ambíguos pós-submit (aceito_sem_protocolo/indeterminado) ficam de fora e vão p/
-- conciliação. portal_tentativas é incrementado a cada tentativa finalizada (< 3 garante teto, sem loop).
-- CREATE OR REPLACE move por OID (não recria) — preserva grants; reafirmo os grants no fim por idempotência.

CREATE OR REPLACE FUNCTION public.envio_portal_lock_candidatos(p_max integer DEFAULT 5)
 RETURNS TABLE(id bigint, empresa text, fornecedor_nome text, status_envio_portal text, portal_tentativas integer, portal_protocolo text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  -- Libera service_role (caller do cron, uid NULL); exige staff só p/ usuário autenticado.
  -- (espelha public.pedido_compra_split — antes era `uid IS NULL OR NOT staff`, que barrava o cron)
  IF auth.uid() IS NOT NULL
     AND NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH candidatos AS (
    SELECT p.id, p.status_envio_portal AS status_anterior
    FROM public.pedido_compra_sugerido p
    WHERE p.fornecedor_nome ILIKE '%SAYERLACK%' AND p.empresa = 'OBEN'
      AND p.status IN ('aprovado_aguardando_disparo','disparado')
      AND p.status_envio_portal IN ('pendente_envio_portal','erro_retentavel')
      AND COALESCE(p.portal_tentativas, 0) < 3
      -- relógio ÚNICO e estável (NÃO atualizado_em). NULL = legado/preso → elegível já.
      AND (p.portal_proximo_retry_em IS NULL OR p.portal_proximo_retry_em <= now())
    ORDER BY p.aprovado_em ASC NULLS LAST, p.id ASC
    LIMIT p_max FOR UPDATE SKIP LOCKED
  ),
  travados AS (
    UPDATE public.pedido_compra_sugerido p
    -- stamp atualizado_em ao reivindicar: o watchdog (runWatchdog) usa atualizado_em como IDADE do
    -- enviando_portal (enviando_portal AND atualizado_em < now()-5min → conciliação). Sem stampar, um
    -- pendente VELHO (atualizado_em de horas atrás) reivindicado pelo lote seria mandado p/ conciliação
    -- na hora — em vez de re-enviado. Reivindicar reinicia o relógio. (achado do codex challenge)
    SET status_envio_portal = 'enviando_portal', atualizado_em = now()
    FROM candidatos c WHERE p.id = c.id
    RETURNING p.id, p.empresa, p.fornecedor_nome, c.status_anterior AS status_envio_portal,
              COALESCE(p.portal_tentativas, 0) AS portal_tentativas, p.portal_protocolo
  )
  SELECT t.id, t.empresa, t.fornecedor_nome, t.status_envio_portal, t.portal_tentativas, t.portal_protocolo FROM travados t;
END; $function$;

REVOKE ALL ON FUNCTION public.envio_portal_lock_candidatos(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.envio_portal_lock_candidatos(integer) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.envio_portal_lock_candidatos(integer) TO service_role;
