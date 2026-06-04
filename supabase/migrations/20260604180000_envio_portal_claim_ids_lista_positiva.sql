-- Aperta o predicado do claim atômico do portal Sayerlack: lista POSITIVA (não "qualquer != enviando_portal").
-- ============================================================================
-- Segue o #592 (que moveu o claim p/ a RPC envio_portal_claim_ids em SQL puro, consertando o
-- .or()-em-UPDATE que o PostgREST rejeitava com 42703). Uma revisão paralela (#598) + um consult
-- adversário ao Codex apontaram um P1 que o #592 HERDOU do `.or()` original ao reativá-lo:
--
--   P1 (PO DUPLICADO na Renner): o predicado largo "status_envio_portal IS NULL OR <> 'enviando_portal'"
--   reivindica QUALQUER estado != enviando_portal — inclusive TERMINAIS/ambíguos:
--   indeterminado_requer_conciliacao, aceito_portal_sem_protocolo, sucesso_portal, erro_nao_retentavel.
--   O modo INDIVIDUAL (DispararAgoraButton → enviar-pedido-portal-sayerlack {pedido_id}) busca o
--   candidato por id SEM filtro de status (index.ts:2075) e PULA o pré-check de
--   iniciarEnvioPortalSayerlack (disparar-pedidos-aprovados:409-426, que barraria os ambíguos).
--   processCandidatos NÃO tem guard pós-claim (index.ts:1952) → um pedido indeterminado/
--   aceito_sem_protocolo reivindicado é RE-ENVIADO ao Browserless = 2º PO no fornecedor. (sucesso_portal
--   não re-POSTa por idempotência em index.ts:1433, mas o claim já corrompe o estado p/ enviando_portal.)
--   O `.or()` quebrado nunca exerceu isso; o #592, ao consertá-lo, reativou o risco latente.
--
-- FIX: lista POSITIVA — só pendente_envio_portal/erro_retentavel (os 2 estados que DEVEM ir ao portal),
--   espelhando exatamente envio_portal_lock_candidatos (lote, 20260530230000) e sayerlack_retry_orfaos
--   (motor, 20260528040000). + guard empresa='OBEN'/fornecedor ILIKE '%SAYERLACK%' (defense-in-depth:
--   o modo individual passa ids sem filtrar fornecedor; alinha com lote/motor/watchdog, todos Sayerlack-OBEN).
--
-- DECISÕES (Codex + análise de fluxo):
--   • SEM "OR IS NULL": a coluna tem default 'nao_aplicavel' e o trigger set_status_envio_portal_on_disparo
--     força 'pendente_envio_portal' no disparo Sayerlack; o fluxo (disparar-pedidos-aprovados:428) também
--     seta 'pendente' antes da edge. NULL no claim seria higiene/backfill, NÃO candidato de money-path.
--   • NÃO guardo por `status` (aprovado_aguardando_disparo/disparado/falha_envio): os caminhos DIVERGEM —
--     o motor dispara 'falha_envio' (foi o status dos pedidos 324/325/340/341 travados); um guard de status
--     a la envio_portal_lock_candidatos ('aprovado_aguardando_disparo','disparado') OMITIRIA 'falha_envio'
--     e re-quebraria o disparo. O discriminador correto é status_envio_portal.
--
-- ATOMICIDADE preservada (idêntica ao #592): UPDATE...WHERE...RETURNING sob READ COMMITTED — row-lock +
--   re-avaliação do predicado após commit concorrente → 2 requests pelo mesmo id, só um reivindica.
--
-- ⚠️ Follow-up SEPARADO (NÃO neste PR — Codex): o modo LOTE faz double-claim. envio_portal_lock_candidatos
--   já marca os candidatos como enviando_portal; este claim (lista positiva) os EXCLUIRIA → lote vira no-op.
--   Hoje inócuo (cron sayerlack-portal-lote-retry removido em 20260530170000; o money-path é o individual);
--   quando o lote voltar, tratar os retornados pela lock_candidatos como JÁ reivindicados e pular este claim.
--
-- CREATE OR REPLACE move por OID (preserva grants); reafirmo os grants no fim por idempotência.

CREATE OR REPLACE FUNCTION public.envio_portal_claim_ids(p_ids bigint[])
RETURNS TABLE(id bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Libera service_role (uid NULL); exige staff só p/ usuário autenticado (espelha
  -- public.envio_portal_lock_candidatos). A edge usa SERVICE_ROLE_KEY → passa.
  IF auth.uid() IS NOT NULL
     AND NOT (public.has_role(auth.uid(), 'employee'::app_role)
              OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  UPDATE public.pedido_compra_sugerido p
     SET status_envio_portal = 'enviando_portal',
         portal_erro = NULL
   WHERE p.id = ANY(p_ids)
     AND p.empresa = 'OBEN'
     AND p.fornecedor_nome ILIKE '%SAYERLACK%'
     -- lista POSITIVA (espelha lote + motor): SÓ os 2 estados que devem ir ao portal.
     -- Exclui TERMINAIS/ambíguos (indeterminado/aceito_sem_protocolo/sucesso_portal/
     -- erro_nao_retentavel) → anti-PO-duplicado. Sem IS NULL (não é money-path).
     AND p.status_envio_portal IN ('pendente_envio_portal', 'erro_retentavel')
  RETURNING p.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.envio_portal_claim_ids(bigint[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.envio_portal_claim_ids(bigint[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.envio_portal_claim_ids(bigint[]) TO service_role;

SELECT 'envio_portal_claim_ids (lista positiva) OK' AS status,
       count(*) AS existe
FROM pg_proc WHERE proname = 'envio_portal_claim_ids';
