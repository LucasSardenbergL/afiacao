-- authz/private — fecha o EXECUTE das 3 funcoes que nasceram com `proacl` NULL
--
-- ACHADO: colateral do #1768 (Parte E do `authz:check`), registrado no §9.1 de
-- docs/historico/sentinela-authz-controle-nao-mencao.md e deliberadamente NAO mexido la.
-- Desfecho e raciocinio completo no §9.1.1 do mesmo doc.
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
--   · Owner das 3 = `postgres`, a mesma role do SQL Editor: o REVOKE abaixo tem permissao, e o
--     owner NAO perde EXECUTE (e como a SECDEF de `get_skus_margem_positiva` segue chamando).
--   · `pg_trigger`: existem EXATAMENTE 2 vinculos para estas funcoes (trg_frec_sem_margem em
--     farmer_recommendations, trg_fbrec_sem_margem em farmer_bundle_recommendations), ambos
--     `tgenabled='O'`. Nenhum trigger inesperado depende delas.
--
-- ⚠️ NAO e verdade que isto seja "pior que `public`" no efeito: o default privilege de `public`
--    para FUNCTIONS e `{postgres=X,anon=X,authenticated=X,service_role=X}` — tambem concede a
--    anon. A diferenca e de FORMA, e favorece `private`: com `proacl` NULL um
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
--   · `frec_sem_margem` / `fbrec_sem_margem` sao `RETURNS trigger`. Elas nao LEEM nada: so
--     escrevem NULL em NEW. Sao o mecanismo de SCRUB de margem do FU4-F fase 3 — o oposto de um
--     vazamento.
--     ⚠️ CORRECAO (revisao adversaria do Codex, medida e confirmada): NAO e verdade que a
--     chamada direta morra em 0A000 "com ou sem EXECUTE". A ACL e verificada ANTES da
--     invocacao. Medido em PG17: COM EXECUTE -> 0A000 (trigger function so pode ser chamada
--     como trigger); SEM EXECUTE -> 42501. Ou seja, o REVOKE MOVE a barreira para o privilegio
--     em vez de depender do handler de trigger — que e exatamente o ponto de fechar.
--   · `custo_canonico` e SECURITY INVOKER e chama `private.regua_num_finito`, que nega anon.
--     Ou seja, hoje ela falha para anon por um ACIDENTE do encadeamento: no dia em que alguem
--     abrir `regua_num_finito`, esta abre junto, calada (F3 do harness faz exatamente isso e
--     mostra `anon` EXECUTANDO). E, medido: ela e funcao PURA de dois numerics — nao le tabela,
--     devolve um dos argumentos. Nao ha o que extrair dela; o dano de deixar aberta e zero
--     HOJE, mas o contrato fica dependendo de acidente.
--
-- Fechar por privilegio custa nada (provado: L8 mostra a RPC de ranking seguindo; L9/L10 mostram
-- os triggers de scrub seguindo — disparar trigger NAO revalida EXECUTE) e troca "inalcancavel
-- por acidente" por "inalcancavel por contrato", que e o que a Parte E sabe vigiar.
--
-- ─────────────────────────────────────────────────
-- POR QUE **NAO** mexer no default privilege do schema (a causa-raiz)
-- ─────────────────────────────────────────────────
-- ⚠️ MEDIDO, e o resultado derruba a formulacao obvia: em PG17,
--     ALTER DEFAULT PRIVILEGES IN SCHEMA private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--    e INOCUO. Um canario criado depois dele nasce com `proacl` NULL e
--    `has_function_privilege('anon', ...) = true` — identico a nao ter rodado nada. Default
--    privilege POR SCHEMA nao remove o EXECUTE do default GLOBAL embutido do Postgres; ele so
--    adiciona, ou desfaz um GRANT feito tambem por schema.
--    A forma que FUNCIONA e a global, sem `IN SCHEMA`: o canario passa a nascer
--    `{postgres=X/postgres}` com `anon` sem EXECUTE. Mas ela e por ROLE CRIADORA e vale para
--    TODOS os schemas — mudanca de postura do projeto inteiro, nao um ajuste de `private`.
--
-- Por isso a causa-raiz fica de fora desta migration:
--   1. so vale para objetos criados pelo ROLE que executa o ALTER, e o apply aqui e manual —
--      cobertura parcial com aparencia de total e pior que nao ter, porque a Parte E passaria a
--      confiar numa premissa falsa;
--   2. muda a PREMISSA MEDIDA da allowlist: a Parte E emite
--      [FUNCAO_DEFAULT_PRIVILEGE_ALTERADO] de proposito para qualquer mudanca de default
--      privilege sobre FUNCTIONS, e o cabecalho de scripts/authz-funcoes-fechadas.ts declara o
--      default medido. Mexer exige refazer aquela medicao e reescrever o cabecalho;
--   3. o beneficio e menor do que parece: as 10 funcoes `cap_*` de `private` PRECISAM de
--      `authenticated=X` (chamadas de dentro de policies RLS) e ja recebem GRANT explicito na
--      migration que as cria. O default fechado nao as afeta — ele so troca "nasce aberta em
--      silencio" por "quebra em runtime" para quem ESQUECER o GRANT. Fail-closed e desejavel,
--      mas e mudanca de comportamento de deploy e merece entrega propria, com prova propria.
-- ─────────────────────────────────────────────────

-- Precondicao: as 3 tem de existir, com ESTA assinatura, ANTES do primeiro REVOKE. Sem isto um
-- rename/drop upstream faria a migration aplicar PELA METADE (o SQL Editor nao envolve o script
-- numa transacao por conta propria), deixando parte fechada e parte aberta em silencio.
DO $$
BEGIN
  IF to_regprocedure('private.custo_canonico(numeric,numeric)') IS NULL
     OR to_regprocedure('private.frec_sem_margem()') IS NULL
     OR to_regprocedure('private.fbrec_sem_margem()') IS NULL THEN
    RAISE EXCEPTION 'precondicao FALHOU: alguma das 3 funcoes de private nao existe com a assinatura esperada (custo_canonico(numeric,numeric), frec_sem_margem(), fbrec_sem_margem())';
  END IF;
END $$;

-- 1) helper puro do custo canonico (SECURITY INVOKER, sem acesso a tabela).
--    SEM GRANT nenhum, de proposito: o unico consumidor MEDIDO e `public.get_skus_margem_positiva()`
--    — SECURITY DEFINER de owner `postgres` —, e o owner mantem EXECUTE pos-REVOKE (L8 prova).
--    Um `GRANT TO service_role` chegou a estar aqui e foi RETIRADO na revisao do Codex: sem
--    consumidor direto comprovado, ele so ampliaria superficie.
REVOKE ALL ON FUNCTION private.custo_canonico(numeric, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.custo_canonico(numeric, numeric) FROM anon;
REVOKE ALL ON FUNCTION private.custo_canonico(numeric, numeric) FROM authenticated;

-- 2) as duas trigger functions do scrub de margem do Farmer.
--    SEM GRANT nenhum: disparar um trigger NAO revalida EXECUTE na funcao (L9/L10). Quem checa
--    EXECUTE e o `CREATE TRIGGER` — e criar trigger exige TAMBEM o privilegio TRIGGER na tabela
--    (L11 isola os dois). Sobra o owner, que e o padrao ja usado por
--    `private.atp_reconciliar_job()` e `private.expirar_reservas_vencidas_job()`.
REVOKE ALL ON FUNCTION private.frec_sem_margem() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.frec_sem_margem() FROM anon;
REVOKE ALL ON FUNCTION private.frec_sem_margem() FROM authenticated;

REVOKE ALL ON FUNCTION private.fbrec_sem_margem() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.fbrec_sem_margem() FROM anon;
REVOKE ALL ON FUNCTION private.fbrec_sem_margem() FROM authenticated;
