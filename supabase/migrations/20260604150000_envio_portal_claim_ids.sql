-- Conserta o CLAIM ATÔMICO do portal Sayerlack, que estava QUEBRADO via PostgREST.
-- ============================================================================
-- SINTOMA: a edge enviar-pedido-portal-sayerlack respondia 500 "Falha ao reservar pedidos:
--   column pedido_compra_sugerido.status_envio_portal does not exist" em TODO disparo →
--   NENHUM pedido Sayerlack ia ao portal desde ~02/06; o motor sayerlack_retry_orfaos (*/15)
--   re-disparava em loop (o pedido nunca progredia, mas reaparecia no check
--   reposicao_portal_pipeline → broken). 324/325 foram os visíveis no alerta.
--
-- CAUSA-RAIZ (provada por eliminação — preço/qtd OK, fornecedor OK, trigger/policy OK,
--   schema-cache reload NÃO resolveu, e o UPDATE idêntico escrito À MÃO funciona no banco):
--   o claim atômico async/sync da edge (#470) fazia, via supabase-js:
--     .from("pedido_compra_sugerido")
--       .update({ status_envio_portal: "enviando_portal", portal_erro: null })
--       .in("id", ids)
--       .or("status_envio_portal.is.null,status_envio_portal.neq.enviando_portal")
--       .select("id")
--   O PostgREST traduz esse UPDATE + filtro OR + RETURNING para um SQL que o Postgres rejeita
--   com 42703 — embora a coluna EXISTA. É a camada REST, não o banco (UPDATE puro idêntico
--   = "UPDATE 1" no SQL Editor). Provável regressão de versão do PostgREST no .or() de UPDATE,
--   exposta quando o claim atômico do #470 foi deployado (~02/06).
--
-- FIX: mover o claim para SQL PURO via esta RPC — o mesmo "UPDATE ... WHERE ... RETURNING id"
--   que provamos funcionar — eliminando a dependência da tradução do .or() do PostgREST.
--   A edge passa a chamar .rpc("envio_portal_claim_ids", { p_ids: ids }) nos dois caminhos
--   (async e síncrono legado), substituindo o .update().or().select() quebrado.
--
-- ATOMICIDADE PRESERVADA (anti-duplo-envio do #470): "UPDATE ... WHERE ... RETURNING" é atômico
--   sob READ COMMITTED — pega row-lock e RE-AVALIA o predicado após o commit concorrente. Se 2
--   requests competem pelo MESMO id (ex.: "aprovar e disparar" + cron no mesmo instante), o 2º
--   espera o lock, re-lê status_envio_portal='enviando_portal' (já reivindicado), o WHERE
--   "<> 'enviando_portal'" falha → a linha NÃO é atualizada nem retornada. Só um reivindica →
--   só uma sessão no Browserless → sem PO duplicado na Renner. O ramo "IS NULL" cobre o pedido
--   fresco (status_envio_portal NULL) que o "<>" sozinho perderia.
--
-- GATE: espelha public.envio_portal_lock_candidatos — libera service_role (caller do cron/edge,
--   auth.uid() NULL) e exige staff (employee/master) só para usuário autenticado. A edge usa
--   SERVICE_ROLE_KEY, então o gate passa; a função inteira já é gateada por authorizeCronOrStaff.
--   SECURITY DEFINER + search_path fixo; REVOKE de anon/authenticated/PUBLIC; GRANT só service_role.

CREATE OR REPLACE FUNCTION public.envio_portal_claim_ids(p_ids bigint[])
RETURNS TABLE(id bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Libera service_role (uid NULL); exige staff só p/ usuário autenticado (espelha
  -- public.envio_portal_lock_candidatos — antes era `uid IS NULL OR NOT staff`, que barrava o cron)
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
     -- claim atômico: trava SÓ os que não estão já em voo (NULL = fresco; <> = não-reivindicado)
     AND (p.status_envio_portal IS NULL OR p.status_envio_portal <> 'enviando_portal')
  RETURNING p.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.envio_portal_claim_ids(bigint[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.envio_portal_claim_ids(bigint[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.envio_portal_claim_ids(bigint[]) TO service_role;
