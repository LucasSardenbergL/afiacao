-- authz/private — fecha o EXECUTE das 3 funcoes que nasceram com `proacl` NULL
--
-- ACHADO: colateral do #1768 (Parte E do `authz:check`), registrado no §9.1 de
-- docs/historico/sentinela-authz-controle-nao-mencao.md e deliberadamente NAO mexido la.
--
-- ─────────────────────────────────────────────────
-- O QUE FOI MEDIDO (psql-ro em prod; 2026-08-15, reconfirmado 2026-08-18)
-- ─────────────────────────────────────────────────
--   · `pg_default_acl` nao tem NENHUMA linha para o schema `private` (count = 0, qualquer
--     objtype). Logo, funcao criada la nasce com `proacl` NULL = EXECUTE IMPLICITO a PUBLIC,
--     e PUBLIC inclui `anon` e `authenticated`.
--   · O schema NAO e barreira: `private` concede USAGE a `authenticated` E `anon` (nspacl
--     `{postgres=UC/postgres,authenticated=U/postgres,anon=U/postgres,service_role=U/postgres}`).
--     O que `private` de fato nega e ROTA: o PostgREST nao publica o schema, entao nao ha
--     chamada HTTP direta. EXECUTE de dentro do banco continua valendo.
--   · 3 das 23 funcoes de `private` estao nesse estado; as outras 20 tem ACL explicito. O
--     padrao do schema JA E fechar por privilegio — estas 3 escaparam, nao foram isentadas.
--
-- ⚠️ NAO e verdade que isto seja "pior que `public`" no efeito: o default privilege de `public`
--    para FUNCTIONS e `{postgres=X,anon=X,authenticated=X,service_role=X,...}` — tambem concede
--    a anon. A diferenca e de FORMA, e favorece `private`: com `proacl` NULL um
--    `REVOKE ... FROM PUBLIC` basta, enquanto em `public` e preciso revogar de `anon` e
--    `authenticated` POR NOME (a armadilha ja documentada no CLAUDE.md). Revogamos dos tres
--    aqui assim mesmo: idempotente, e imune a um grant explicito ter aparecido no meio-tempo.
--
-- ─────────────────────────────────────────────────
-- POR QUE FECHAR, se nenhuma das 3 e exploravel hoje
-- ─────────────────────────────────────────────────
-- A prova executada (db/test-authz-private-execute-fecho.sh, PG17) mostra que as 3 sao HOJE
-- inalcancaveis — mas por razoes que NAO sao privilegio, e e isso que as torna fragil:
--
--   · `frec_sem_margem` / `fbrec_sem_margem` sao `RETURNS trigger`. Chamada direta morre no
--     executor com 0A000 ("trigger functions can only be called as triggers"), tenha o caller
--     EXECUTE ou nao. A barreira e do EXECUTOR, nao do ACL. Alem disso elas nao LEEM nada:
--     so escrevem NULL em NEW. Sao o mecanismo de SCRUB de margem do FU4-F fase 3 — o oposto
--     de um vazamento.
--   · `custo_canonico` e SECURITY INVOKER e chama `private.regua_num_finito`, que nega anon.
--     Ou seja, hoje ela falha para anon por um ACIDENTE do encadeamento: no dia em que alguem
--     abrir `regua_num_finito`, esta abre junto, calada. (E, medido: ela e funcao PURA de dois
--     numerics — nao le tabela, devolve um dos argumentos. Nao ha o que extrair dela; o dano
--     de deixar aberta e zero HOJE, mas o contrato fica dependendo de acidente.)
--
-- Fechar por privilegio custa nada (provado: o Farmer e a RPC de ranking seguem funcionando) e
-- troca "inalcancavel por acidente" por "inalcancavel por contrato" — que e o que a Parte E do
-- `authz:check` sabe vigiar a partir de agora (AUTHZ_FUNCOES_FECHADAS).
--
-- ─────────────────────────────────────────────────
-- POR QUE **NAO** mexer no default privilege do schema (a causa-raiz)
-- ─────────────────────────────────────────────────
-- `ALTER DEFAULT PRIVILEGES IN SCHEMA private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` fecharia
-- a classe inteira para funcoes FUTURAS, e foi avaliado. Ficou de FORA desta migration:
--   1. `ALTER DEFAULT PRIVILEGES` so vale para objetos criados pelo ROLE que o executa. O apply
--      aqui e manual (SQL Editor do Lovable) e nem toda funcao de `private` nasce pela mesma
--      role — um default privilege que cobre so uma delas da cobertura PARCIAL com aparencia de
--      total, que e pior que nao ter (a Parte E passaria a confiar numa premissa falsa).
--   2. Ele muda a PREMISSA MEDIDA da allowlist: a Parte E emite
--      [FUNCAO_DEFAULT_PRIVILEGE_ALTERADO] de proposito para qualquer mudanca de default
--      privilege sobre FUNCTIONS, e o cabecalho de scripts/authz-funcoes-fechadas.ts declara o
--      default medido. Mexer exige refazer aquela medicao e reescrever o cabecalho — entrega
--      propria, com sua propria prova, nao carona nesta.
--   3. O beneficio real e menor do que parece: as 10 funcoes `cap_*` de `private` PRECISAM de
--      `authenticated=X` (sao chamadas de dentro de policies RLS) e ja recebem GRANT explicito
--      na migration que as cria. O default fechado nao as afeta — ele so muda o ponto de
--      partida de quem ESQUECER o GRANT, trocando "nasce aberta em silencio" por "quebra em
--      runtime". E fail-closed e desejavel, mas e mudanca de comportamento de deploy e merece
--      ser decidida sozinha.
-- ─────────────────────────────────────────────────

-- 1) helper puro de custo canonico (SECURITY INVOKER, sem acesso a tabela).
--    O owner (postgres) mantem EXECUTE pos-REVOKE, e e como `public.get_skus_margem_positiva()`
--    — SECURITY DEFINER de owner postgres — continua chamando. service_role recebe GRANT pelo
--    mesmo padrao das irmas de `private` (atp_disponivel, margem_cliente_agregada): e a role do
--    backend confiavel, nunca chega ao browser.
REVOKE ALL ON FUNCTION private.custo_canonico(numeric, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.custo_canonico(numeric, numeric) FROM anon;
REVOKE ALL ON FUNCTION private.custo_canonico(numeric, numeric) FROM authenticated;
GRANT EXECUTE ON FUNCTION private.custo_canonico(numeric, numeric) TO service_role;

-- 2) as duas trigger functions do scrub de margem do Farmer.
--    SEM GRANT nenhum, de proposito: disparar um trigger NAO checa EXECUTE na funcao (provado
--    em L4/L5 do harness; quem checa EXECUTE e o CREATE TRIGGER, e criar trigger exige ser dono
--    da tabela). Sobra o owner — que e o padrao ja usado por `private.atp_reconciliar_job()` e
--    `private.expirar_reservas_vencidas_job()`, ambas `{postgres=X/postgres}` puro.
REVOKE ALL ON FUNCTION private.frec_sem_margem() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.frec_sem_margem() FROM anon;
REVOKE ALL ON FUNCTION private.frec_sem_margem() FROM authenticated;

REVOKE ALL ON FUNCTION private.fbrec_sem_margem() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.fbrec_sem_margem() FROM anon;
REVOKE ALL ON FUNCTION private.fbrec_sem_margem() FROM authenticated;
