-- ============================================================
-- cancelar_pedido_sugerido — tira `anon` (e PUBLIC) do EXECUTE
-- ============================================================
-- POR QUÊ
--   Medido em prod (psql-ro, 2026-09-06), o ACL da função era:
--     {=X/postgres, postgres=X/postgres, anon=X/postgres, authenticated=X/postgres,
--      service_role=X/postgres, sandbox_exec_fzvklzpomgnyikkfkzai=X/postgres}
--   Ou seja, EXECUTE por DUAS vias: o grant explícito de `anon` E o `=X` de PUBLIC.
--   Isso é o default do Supabase, não uma decisão — a função nasceu assim e o
--   `CREATE OR REPLACE` de 20260905224959 preservou o ACL (que é justamente por que
--   se usa REPLACE e nunca DROP+CREATE). A RPC irmã 20260906105549
--   (`remover_itens_pedido_sugerido`) já sai revogada; esta migration iguala a postura
--   entre as duas RPCs de escrita da MESMA tabela.
--
-- O QUE ISTO **NÃO** É: não é o fechamento de um buraco explorável hoje.
--   `cancelar_pedido_sugerido` é SECURITY INVOKER e as 4 policies de
--   `pedido_compra_sugerido` são todas `TO authenticated` (medido no mesmo dia), então
--   sob a role `anon` o UPDATE não casa policy nenhuma, atualiza 0 linhas e a RPC devolve
--   'pedido não encontrado'. A RLS já nega. Isto é defesa em PROFUNDIDADE: remove a
--   dependência de que a RLS permaneça como está para que o anônimo continue barrado.
--
-- E NÃO É O VETOR PRINCIPAL, dito aqui para não ser lido como se fosse.
--   O caminho que realmente fura a RPC não é o `anon`: é o STAFF autenticado indo direto
--   na tabela (`authenticated=arwdDxtm`, e a RLS de UPDATE é de PAPEL, não de status) —
--   um `UPDATE … SET status='cancelado_humano' WHERE id=…` via PostgREST nunca passa por
--   guard nenhum. Fechar ISSO é mover o guard para um TRIGGER, que é o objetivo da
--   migration 20260906152235 (cancelamento pós-disparo), de outra sessão. Esta aqui é
--   ortogonal e menor; não a substitui.
--
-- `sandbox_exec_fzvklzpomgnyikkfkzai` é PRESERVADO de propósito: é grant explícito de
--   role da plataforma (Lovable), fora do escopo desta decisão — revogar às cegas o que
--   não se entende é como se quebra ferramenta de terceiro em silêncio.
--
-- REVOKE de PUBLIC **e** de anon pelo NOME: revogar só de PUBLIC não tira o grant
--   explícito de `anon`, e revogar só de `anon` deixa o `=X` de PUBLIC servindo o mesmo
--   EXECUTE por trás. Precisa dos dois (CLAUDE.md · database.md).
-- Idempotente: REVOKE/GRANT re-rodados não mudam nada.

BEGIN;

REVOKE ALL ON FUNCTION public.cancelar_pedido_sugerido(bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancelar_pedido_sugerido(bigint, text, text) FROM anon;

-- Reafirmados explicitamente: é quem a tela e as edges usam. Sem isto, o botão Cancelar
-- e a rejeição em lote morreriam com "permission denied".
GRANT EXECUTE ON FUNCTION public.cancelar_pedido_sugerido(bigint, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancelar_pedido_sugerido(bigint, text, text) TO service_role;

-- ── Postcondição: a migration ABORTA se não pegou, na cara de quem colou ──────────────
DO $post$
DECLARE
  v_oid oid;
BEGIN
  SELECT p.oid INTO v_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'cancelar_pedido_sugerido'
     AND pg_get_function_identity_arguments(p.oid) = 'p_pedido_id bigint, p_usuario text, p_justificativa text';
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POST FALHOU [AUSENTE]: cancelar_pedido_sugerido(bigint,text,text) nao existe -- aplique 20260905224959 antes desta';
  END IF;

  -- O alvo desta migration. `has_function_privilege` enxerga TAMBEM o privilegio herdado
  -- de PUBLIC, entao este assert cobre as duas vias de uma vez: se qualquer uma tivesse
  -- sobrado, ele seria verdadeiro e a migration abortaria.
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU [ACL-ANON]: anon ainda executa a RPC -- o REVOKE nao pegou (sobrou o grant explicito ou o =X de PUBLIC)';
  END IF;

  -- O contrapeso: revogar demais quebra a tela. Estes dois asserts sao o que impede
  -- esta migration de trocar um risco teorico por uma quebra real.
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU [ACL-EXECUTE]: authenticated perdeu o EXECUTE -- o botao Cancelar e a rejeicao em lote morreriam com permission denied';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU [ACL-SERVICE]: service_role perdeu o EXECUTE -- edge/cron que cancela quebraria';
  END IF;

  -- Nao e alvo desta migration, mas e o que ela nao pode ter estragado de passagem:
  -- o ACL vive na MESMA funcao cujo guard atomico e INVOKER sao o invariante do #2218.
  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'POST FALHOU [SECDEF]: a funcao virou SECURITY DEFINER -- bypassaria a RLS de pedido_compra_sugerido';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = v_oid) !~ 'WHERE id = p_pedido_id[[:space:]]+AND status NOT IN' THEN
    RAISE EXCEPTION 'POST FALHOU [GUARD-NO-UPDATE]: o guard atomico do #2218 sumiu do WHERE do UPDATE -- alguem recriou a funcao por cima';
  END IF;

  RAISE NOTICE 'cancelar_pedido_sugerido: anon SEM execute (PUBLIC e grant explicito revogados), authenticated e service_role executam, INVOKER e guard atomico intactos';
END
$post$;

COMMIT;
