-- M-15 (plano 2026-09-05, Lote D). Porta o FU7 de 2026-07-18, escrito numa worktree e NUNCA commitado
-- nem aplicado (psql-ro 2026-10-11: corpo de prod ainda é o original, md5(prosrc) d8e2d472…). O plano
-- pedia REVOKE de authenticated; não serve — v_whatsapp_sla (security_invoker=on) e o IncomingCallModal
-- chamam a função como o staff logado. O timingSafeEq em _shared/auth.ts (2ª metade do M-15) fica com o
-- Lote C, dono de _shared/. Pós-condição DO $post$ acrescentada no fim.
-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  FU7 (continuação do #1421) — fecha o oráculo `public.wa_owner_efetivo`       ║
-- ║                                                                              ║
-- ║  ALVO: RPC SECDEF exposta via PostgREST a `authenticated` SEM gate nenhum.    ║
-- ║  Ela não responde "sim/não" sobre um par que o atacante já conhece: DEVOLVE   ║
-- ║  o UUID do vendedor dono do cliente. Medido em prod 2026-07-18:               ║
-- ║    · 5.272 customers têm EXECUTE; os 3 owners retornáveis são TODOS staff     ║
-- ║      (1 master + 2 employees) → a RPC PRODUZ munição que o atacante não tinha ║
-- ║    · vetor mais barato: o customer sonda o PRÓPRIO user_id (que ele conhece)  ║
-- ║      e recebe o UUID de um funcionário. Zero enumeração necessária.           ║
-- ║                                                                              ║
-- ║  POR QUE NÃO `REVOKE` NEM MOVER P/ `private` (as 2 técnicas do #1421):        ║
-- ║  há caller vivo no frontend — src/components/call/IncomingCallModal.tsx:90.   ║
-- ║  REVOKE quebraria a tela; mover de schema despublicaria a RPC do PostgREST.   ║
-- ║  → 3ª técnica: gate INTERNO no corpo.                                        ║
-- ║                                                                              ║
-- ║  ⚠️ POR QUE O GATE **NÃO** É `carteira_visivel_para` (medido, não presumido): ║
-- ║  a telefonia é RING-ALL (todas as vendas tocam juntas no Nvoip). O ramo       ║
-- ║  `realce='outro'` do modal existe EXATAMENTE p/ mostrar "Cliente da Regina"   ║
-- ║  a quem NÃO atende aquele cliente. Um gate de carteira devolveria NULL nesse  ║
-- ║  caso → `classificarRealceDono` retorna 'sem_dono', p/ o qual o JSX não tem   ║
-- ║  ramo → o realce SOME e o peer perde o direcionamento do ring-all. É          ║
-- ║  supressão de informação verdadeira num sinal operacional.                    ║
-- ║  Provado no harness: F1 sabota o gate p/ carteira e o assert do ring-all      ║
-- ║  fica VERMELHO.                                                              ║
-- ║                                                                              ║
-- ║  GATE = 2 IDENTIDADES POSITIVAS (padrão #1387 — nunca autorizar pela AUSÊNCIA ║
-- ║  de identidade, que é fail-open):                                            ║
-- ║    (a) `auth.role() = 'service_role'` → automação. Os 3 dependentes medidos:  ║
-- ║        · trigger `push_whatsapp_inbound` (AFTER INSERT em whatsapp_messages,  ║
-- ║          disparado pelo edge `whatsapp-inbound` com SERVICE_ROLE_KEY).        ║
-- ║          ⚠️ ele tem `EXCEPTION WHEN OTHERS → RAISE WARNING` E                 ║
-- ║          `IF v_dona IS NULL THEN RETURN NEW` → um gate que o negasse mataria  ║
-- ║          o push da vendedora em SILÊNCIO TOTAL, nos dois caminhos.            ║
-- ║        · view `v_whatsapp_sla` (security_invoker=on) — dependente que o       ║
-- ║          inventário inicial não listou; achado por varredura do BANCO.        ║
-- ║    (b) staff (`employee`/`master`) → o frontend do IncomingCallModal e a      ║
-- ║        supervisão de SLA. Bases do WhatsApp já são staff-only por RLS.        ║
-- ║                                                                              ║
-- ║  MODO DE FALHA = `NULL`, não RAISE. Escolha deliberada: NULL já é um retorno  ║
-- ║  LEGÍTIMO da função ("cliente sem dono") e os 3 callers já o tratam. RAISE    ║
-- ║  quebraria a view `v_whatsapp_sla` inteira p/ o negado (erro no lugar de      ║
-- ║  linhas). Como TODO caller legítimo passa no gate, nenhum caller real recebe  ║
-- ║  o NULL-de-negação → a ambiguidade nunca se materializa.                      ║
-- ║                                                                              ║
-- ║  Prova: db/test-wa-owner-efetivo-gate-staff.sh (PG17 + falsificações)        ║
-- ║  Migration MANUAL — Lovable não auto-aplica. Cole no SQL Editor.              ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

BEGIN;

-- Corpo de negócio preservado VERBATIM do `pg_get_functiondef` de prod (2026-07-18),
-- inclusive o `ca.eligible` que o #1398 introduziu. A ÚNICA mudança é o gate externo.
CREATE OR REPLACE FUNCTION public.wa_owner_efetivo(p_customer uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN (
      -- (a) automação: identidade POSITIVA (≠ "auth.uid() IS NULL", que é fail-open)
      COALESCE((SELECT auth.role()) = 'service_role', false)
      -- (b) staff humano. COALESCE p/ totalidade: has_role é SELECT EXISTS (nunca NULL),
      --     mas o COALESCE torna a totalidade explícita na fonte em vez de herdada.
      OR COALESCE(public.has_role((SELECT auth.uid()), 'master'::public.app_role), false)
      OR COALESCE(public.has_role((SELECT auth.uid()), 'employee'::public.app_role), false)
    )
    THEN (
      select coalesce(
        (select cc.covering_user_id from public.carteira_coverage cc
          where cc.covered_user_id = ca.owner_user_id and cc.active
            and now() >= cc.valid_from and (cc.valid_until is null or now() <= cc.valid_until)
          order by cc.valid_from desc limit 1),
        ca.owner_user_id)
      from public.carteira_assignments ca
      where ca.customer_user_id = p_customer and ca.eligible
      order by ca.valid_from desc limit 1
    )
    ELSE NULL::uuid
  END;
$function$;

-- Reafirma a fronteira de GRANT (CREATE OR REPLACE preserva o ACL, mas o default
-- privilege do Supabase reabre função NOVA — reafirmar é barato e idempotente).
REVOKE EXECUTE ON FUNCTION public.wa_owner_efetivo(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.wa_owner_efetivo(uuid) TO authenticated, service_role;

-- Pós-condição (M-15): corpo com o gate de identidade positiva, anon/PUBLIC sem EXECUTE e authenticated
-- COM EXECUTE (perdê-lo quebraria a view invoker v_whatsapp_sla para o staff).
DO $post$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.wa_owner_efetivo(uuid)'::regprocedure;
  IF v_src NOT LIKE '%(SELECT auth.role()) = ''service_role''%'
     OR v_src NOT LIKE '%''employee''::public.app_role%' THEN
    RAISE EXCEPTION 'M15_POS_FALHOU: gate ausente no corpo';
  END IF;
  IF has_function_privilege('anon', 'public.wa_owner_efetivo(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M15_POS_FALHOU: anon executa';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.wa_owner_efetivo(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M15_POS_FALHOU: authenticated sem EXECUTE (quebra v_whatsapp_sla)';
  END IF;
END
$post$;

COMMIT;
