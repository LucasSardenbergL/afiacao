-- ============================================================
-- aprovar_pedido_sugerido — tira `anon` (e PUBLIC) do EXECUTE
-- ============================================================
-- Irmã simétrica de 20260906154202 (`cancelar_pedido_sugerido`, PR #2241, já MERGEADA e
-- APLICADA na prod em 2026-09-06). Mesma classe, mesma forma, outra RPC.
--
-- POR QUÊ
--   Medido na PROD (psql-ro, 2026-09-06), o ACL desta função é:
--     {=X/postgres, postgres=X/postgres, anon=X/postgres, authenticated=X/postgres,
--      service_role=X/postgres, sandbox_exec_fzvklzpomgnyikkfkzai=X/postgres}
--   EXECUTE por DUAS vias: o grant explícito de `anon` E o `=X` de PUBLIC. É o default do
--   Supabase, não uma decisão — a função nasceu assim. Depois desta migration, as TRÊS RPCs
--   de escrita de `pedido_compra_sugerido` ficam com a mesma postura:
--     · cancelar_pedido_sugerido      → revogada em 20260906154202 (#2241)
--     · remover_itens_pedido_sugerido → já nasceu revogada (20260906105549)
--     · aprovar_pedido_sugerido       → esta
--
-- O QUE ISTO **NÃO** É: não é o fechamento de um buraco explorável hoje.
--   A função é SECURITY INVOKER (`prosecdef=false`, medido no mesmo dia) e
--   `pedido_compra_sugerido` tem RLS LIGADA, então sob a role `anon` o UPDATE não casa
--   policy nenhuma e atualiza 0 linhas. A RLS já nega. Isto é defesa em PROFUNDIDADE:
--   remove a dependência de que a RLS permaneça como está para que o anônimo siga barrado.
--   Não vender como correção de vulnerabilidade.
--
-- QUEM PRECISA EXECUTAR (conferido antes de revogar, `git grep aprovar_pedido_sugerido`):
--   · `authenticated` — `src/components/reposicao/pedidos/aprovar-disparar.ts` chama a RPC
--     sob o usuário logado. É o botão "Aprovar e disparar agora" e o lote. Sem este GRANT,
--     a tela morre com "permission denied".
--   · `service_role` — nenhuma edge chama a RPC hoje (`grep` em `supabase/functions/` = 0),
--     mas o grant JÁ EXISTE no ACL vivo e é reafirmado aqui de propósito: esta migration é
--     sobre tirar `anon`, não sobre reduzir o alcance de quem já podia.
--
-- `sandbox_exec_fzvklzpomgnyikkfkzai` é PRESERVADO de propósito: é grant explícito de role
--   da plataforma (Lovable), fora do escopo desta decisão. `REVOKE … FROM PUBLIC` e
--   `FROM anon` não o tocam — e revogar às cegas o que não se entende é como se quebra
--   ferramenta de terceiro em silêncio.
--
-- REVOKE de PUBLIC **e** de anon pelo NOME: revogar só de PUBLIC não tira o grant explícito
--   de `anon`, e revogar só de `anon` deixa o `=X` de PUBLIC servindo o mesmo EXECUTE por
--   trás. Precisa dos dois (CLAUDE.md · database.md §4).
-- Idempotente: REVOKE/GRANT re-rodados não mudam nada.

BEGIN;

REVOKE ALL ON FUNCTION public.aprovar_pedido_sugerido(bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aprovar_pedido_sugerido(bigint, text) FROM anon;

-- Reafirmados explicitamente: é quem a tela usa (e quem uma edge futura usaria).
GRANT EXECUTE ON FUNCTION public.aprovar_pedido_sugerido(bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.aprovar_pedido_sugerido(bigint, text) TO service_role;

-- ── Postcondição: a migration ABORTA se não pegou, na cara de quem colou ──────────────
DO $post$
DECLARE
  v_oid oid;
BEGIN
  SELECT p.oid INTO v_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'aprovar_pedido_sugerido'
     AND pg_get_function_identity_arguments(p.oid) = 'p_pedido_id bigint, p_usuario text';
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POST FALHOU [AUSENTE]: aprovar_pedido_sugerido(bigint,text) nao existe -- o botao Aprovar quebraria';
  END IF;

  -- O alvo. `has_function_privilege` enxerga TAMBEM o privilegio herdado de PUBLIC, entao
  -- este assert cobre as duas vias de uma vez: se qualquer uma tivesse sobrado, ele seria
  -- verdadeiro e a migration abortaria.
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU [ACL-ANON]: anon ainda executa a RPC -- o REVOKE nao pegou (sobrou o grant explicito ou o =X de PUBLIC)';
  END IF;

  -- O contrapeso: revogar DEMAIS quebra a tela. Estes dois asserts sao o que impede esta
  -- migration de trocar um risco teorico por uma quebra real.
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU [ACL-EXECUTE]: authenticated perdeu o EXECUTE -- o botao Aprovar e o lote morreriam com permission denied';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU [ACL-SERVICE]: service_role perdeu o EXECUTE -- edge/cron que aprove quebraria';
  END IF;

  -- Nao e alvo desta migration, mas e o pressuposto que a torna "profundidade" e nao
  -- "correcao": se a funcao virasse SECURITY DEFINER ela bypassaria a RLS, e aí a RLS
  -- deixaria de ser a barreira que hoje ja nega o anon.
  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'POST FALHOU [SECDEF]: a funcao virou SECURITY DEFINER -- bypassaria a RLS de pedido_compra_sugerido';
  END IF;

  -- POR QUE NAO HA ASSERT SOBRE O CORPO (`prosrc`), ao contrario do molde 20260906154202:
  --   o molde exige o guard atomico do #2218 no WHERE do UPDATE porque, na irma
  --   `cancelar_pedido_sugerido`, esse guard JA ESTAVA na prod. Aqui NAO esta: medido em
  --   2026-09-06, o corpo vivo de `aprovar_pedido_sugerido` ainda e o TOCTOU original
  --   (`SELECT … WHERE id = p_pedido_id` e depois `UPDATE … WHERE id = p_pedido_id`, sem
  --   `AND status NOT IN`), e a migration que o conserta -- 20260906151715 (#2239) -- esta
  --   MERGEADA mas NAO APLICADA (ausente de supabase_migrations.schema_migrations, com as
  --   tres irmas presentes). Copiar o assert do molde faria ESTA migration abortar por
  --   causa de OUTRA pendencia, na cara do founder. As duas sao ortogonais e a ordem de
  --   apply entre elas e LIVRE: a 20260906151715 usa CREATE OR REPLACE (preserva o ACL,
  --   nunca DROP+CREATE) e so concede `authenticated` -- jamais `anon` -- entao as duas
  --   ordens convergem para o mesmo estado final.

  RAISE NOTICE 'aprovar_pedido_sugerido: anon SEM execute (PUBLIC e grant explicito revogados), authenticated e service_role executam, INVOKER intacto';
END
$post$;

COMMIT;
