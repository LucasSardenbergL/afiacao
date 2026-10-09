-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Fecha `public.tarefas_materializar_recorrentes()` para `authenticated`.
--
-- POR QUÊ (medido via psql-ro em 2026-10-08): a função é SECURITY DEFINER (owner postgres), NÃO tem
-- checagem de papel no corpo, e `authenticated` tinha EXECUTE — qualquer usuário logado, cliente
-- inclusive, podia chamar `/rpc/tarefas_materializar_recorrentes` e disparar a materialização com os
-- privilégios do dono. O único chamador legítimo é o cron `tarefas-materializar-recorrentes`
-- (`0 9 * * *`), que roda como `postgres` — dono e superuser, não depende de GRANT nenhum; as 3 últimas
-- execuções: succeeded. Nenhuma chamada em `src/` nem em `supabase/functions/` (só o `types.ts`
-- gerado). É o desenho de `docs/agent/money-path.md`: entrypoint de JOB não é RPC humana.
--
-- Achado na triagem das derivas da auditoria de migrations (2026-10-08): o corpo é igual ao da
-- migration — a abertura é de DESENHO, não de deriva.
--
-- Mantém: `service_role` (edge/cron via API) e o dono. `anon` já estava fechado (sem PUBLIC no ACL).
-- Não toca o role de sandbox do Lovable que aparece no ACL — não é nosso.
--
-- Sem BEGIN/COMMIT: a transação é do envelope (`bun run db:aplicar`). Idempotente: REVOKE de quem já
-- não tem é no-op.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

DO $prevoo$
BEGIN
  IF to_regprocedure('public.tarefas_materializar_recorrentes()') IS NULL THEN
    RAISE EXCEPTION 'pre-voo: public.tarefas_materializar_recorrentes() nao existe nesta base';
  END IF;
END
$prevoo$;

REVOKE EXECUTE ON FUNCTION public.tarefas_materializar_recorrentes() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.tarefas_materializar_recorrentes() FROM anon;
REVOKE EXECUTE ON FUNCTION public.tarefas_materializar_recorrentes() FROM PUBLIC;

-- Postcondição: as QUATRO pontas, pelo que o banco responde — não pelo que o REVOKE "deveria" ter
-- feito. Fechar e manter quem precisa medem coisas diferentes, e as duas têm de valer.
DO $post$
DECLARE
  f oid := 'public.tarefas_materializar_recorrentes()'::regprocedure;
BEGIN
  IF has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondicao: authenticated AINDA executa a funcao — o REVOKE nao pegou';
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondicao: anon executa a funcao (via PUBLIC?) — a outra ponta ficou aberta';
  END IF;
  IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondicao: service_role PERDEU o EXECUTE — fechei demais';
  END IF;
  -- IS DISTINCT FROM, não `<>`: se o SELECT voltasse vazio, `NULL <> 'postgres'` é NULL, o IF não dispara
  -- e a postcondição aprova sem medir (o gate assert-verde-por-ausencia pegou; v1 aplicada com `<>`).
  IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = f) IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION 'postcondicao: o dono nao e postgres — o cron (que roda como postgres) pode depender de GRANT';
  END IF;
  RAISE NOTICE 'FECHADA: authenticated=false anon=false service_role=true owner=postgres';
END
$post$;

SELECT 'FIM_APLICACAO_OK' AS marcador;
