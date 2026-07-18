-- ============================================================
-- 20260717130000_seg_customer_metrics_acl_least_privilege.sql
-- Segurança — normaliza o ACL de public.customer_metrics_mv. [money-path: autz]
-- Complementa a 20260717120000 (view-gate no WHERE); aplicar NA ORDEM.
--
-- ACHADO (Codex challenge xhigh no #1380, ponto 2): o relacl medido na prod é
--   authenticated=arwdDxtm/postgres
-- ou seja, `authenticated` não tem só SELECT — carrega também INSERT/UPDATE/
-- DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN. Um `GRANT SELECT` NÃO remove
-- privilégio anterior: só acrescenta.
--
-- CAUSA-RAIZ (medida em pg_default_acl, não deduzida): NÃO foi a 20260305000443
-- — ela concede só `GRANT SELECT`. É o DEFAULT PRIVILEGE do Supabase no schema
-- `public`, que dá `arwdDxtm` a anon/authenticated/service_role em TODA relação
-- nova (e `EXECUTE` a toda função nova). Ninguém concedeu o INSERT: ele nasce
-- junto com o objeto. Por isso a 20260629120000 precisou de um REVOKE explícito
-- p/ `anon` — e por isso `authenticated`, que ninguém revogou, ficou com tudo.
--
-- Não é explorável hoje — uma view sobre MV não é auto-updatable (o Postgres
-- rejeita a escrita por falta de regra/trigger INSTEAD OF, antes de qualquer
-- questão de ACL) e a leitura já está filtrada pelo view-gate da 20260717120000.
-- É dívida: se alguém der um INSTEAD OF trigger ou trocar o corpo por algo
-- atualizável, o privilégio já está concedido ao role COMPARTILHADO com customer
-- e a escrita passa a valer sem ninguém ter concedido nada de novo.
--
-- Por que uma migration separada: a 20260717120000 já está commitada, e neste
-- repo migration commitada é IMUTÁVEL (apply é manual no SQL Editor — editar o
-- .sql divergiria repo×banco e não re-aplicaria). Correção = migration nova.
--
-- Idempotente (REVOKE/GRANT são declarativos). Transacional.
-- ============================================================
BEGIN;

-- Least privilege explícito: zera e reconcede só o que é usado.
-- (`FROM PUBLIC` também: REVOKE de anon/authenticated NÃO remove um grant a
--  PUBLIC — são entradas de ACL distintas; regra do CLAUDE.md.)
REVOKE ALL ON public.customer_metrics_mv FROM PUBLIC, anon, authenticated, service_role;

-- Reconcede só SELECT. `authenticated` é necessário (staff lê as telas; o gate
-- do WHERE é quem separa staff de customer) e `service_role` idem (a edge
-- ai-ops-agent lê com o service client — o disjunct `service_role` do gate é
-- inútil sem este GRANT). `anon` fica de fora de propósito.
GRANT SELECT ON public.customer_metrics_mv TO authenticated, service_role;

-- Defesa em profundidade na RPC dead-code: hoje `authenticated` NÃO tem EXECUTE
-- em get_customer_metrics (medido: proacl sem authenticated) e ela herda o gate
-- da view de qualquer forma. O REVOKE é no-op agora e serve de trava: impede que
-- um `GRANT ... TO authenticated` acidental reative uma capacidade SECURITY
-- DEFINER dormente — lembrando que o default privilege do Supabase concede
-- EXECUTE a anon/authenticated em toda função NOVA de `public`, então recriar a
-- RPC sem REVOKE a reabre sozinha. O DROP fica p/ follow-up (o Codex ponderou
-- que pode haver consumidor externo fora do repo; conferir logs de /rpc/ antes).
--
-- Condicional de propósito: um REVOKE em função inexistente ABORTA a transação
-- inteira (a migration é atômica) — e o follow-up pode dropá-la. Idempotente.
DO $$
BEGIN
  IF to_regprocedure('public.get_customer_metrics()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.get_customer_metrics() FROM PUBLIC, anon, authenticated;
  END IF;
END $$;

COMMIT;
