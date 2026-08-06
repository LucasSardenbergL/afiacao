-- 20260718220100_seed_targets_faltantes_ledger.sql
-- P0-B-bis Fatia 5 (final) — `seed_targets_faltantes()` larga o espelho `omie_clientes` e passa a
-- tirar o universo do seed do acumulador `carteira_membership_ledger`.
--
-- O QUE MUDA: exatamente uma linha — o `FROM`. Os dois filtros anti-ressurreicao (NOT EXISTS em
-- farmer_client_scores e em cliente_classificacao.excluir_da_carteira), o DISTINCT, o ORDER BY, o
-- SECURITY INVOKER e o REVOKE/GRANT ficam VERBATIM da 20260621120000. Esta migration troca a FONTE
-- da lista, nao a politica de quem e seguro semear.
--
-- POR QUE O LEDGER: a pergunta que a RPC faz e "quem sao os membros da carteira que ainda nao tem
-- score?". Desde a Fatia 0/4 a resposta canonica a "quem e membro" e o ledger — o espelho virou uma
-- projecao congelada dele (writer morto desde 2026-07-18 05:02:40, medido por psql-ro).
--
-- /!\ CRITERIO DE ACEITE: `so-no-espelho = 0`, NAO contagem igual. A §4-bis do design pedia
--     "paridade perfeita 6909 = 6909, diferenca simetrica 0" e isso ficou DESATUALIZADO. Medido em
--     2026-07-18 (pos-Fatia 4):
--         omie_clientes ................. 6909 membros
--         carteira_membership_ledger .... 7301 membros   (392 com source='rpc')
--         so-no-espelho ................. 0     <= o que importa: NENHUM membro se perde
--         so-no-ledger .................. 392   <= o acumulador funcionando, nao divergencia
--     O ledger virou SUPERSET do espelho porque ganhou os membros que a RPC `register_carteira_member`
--     admitiu depois do deploy da Fatia 4. Migrar para ele legitimamente AUMENTA o universo do seed
--     (7301 > 6909) — sao clientes reais que hoje o seed NAO alcanca. Exigir contagem igual reprovaria
--     o comportamento correto e travaria o DROP por falso alarme.
--
-- /!\ POLITICA EXPLICITA de `identity_state` (corrigida pelo /codex xhigh — a 1a versao nao
--     filtrava NADA, e a justificativa cobria so `ambiguous`/`conflict`, deixando `inactive` passar
--     por omissao). O CHECK do ledger admite 4 estados; a decisao, por estado:
--       • `verified`  -> SEMEIA. Cliente normal.
--       • `ambiguous` -> SEMEIA. O quarantine da Fatia 2 governa VENDEDOR e COMISSAO (o rebuild zera
--                       o vendedor e poe eligible=false), NAO a existencia de um score. Identidade
--                       duvidosa nao deixa de ser cliente.
--       • `conflict`  -> SEMEIA, mesma razao.
--       • `inactive`  -> **NAO** semeia. E o unico estado que significa "deixou de ser membro"
--                       (alias rebaixado / cadastro desativado); criar score para ele infla o
--                       universo pontuado com identidade morta.
--     Hoje isto e NO-OP: 7301/7301 do ledger sao `verified` (medido por psql-ro em 18/07). O filtro
--     existe para quando a Fatia 2 comecar a popular os outros estados — sem ele, o primeiro
--     `inactive` entraria no seed em silencio.
--
--     ⚠️ Uma afirmacao da 1a versao deste cabecalho era FALSA e o Codex a derrubou: "filtra-lo aqui
--     removeria score de quem ja o tem". NAO remove — esta RPC so DEVOLVE faltantes (o `NOT EXISTS`
--     em `farmer_client_scores` ja exclui quem tem score) e nunca deleta nada. Filtrar aqui muda
--     apenas quem PASSA A ser semeado daqui pra frente. Argumento money-path inventado sem seguir a
--     cadeia ate o consumidor e tao perigoso quanto numero fabricado (database.md §5).
--
-- DEDUP: o motivo original do DISTINCT era o espelho ter 1 linha por (user_id, empresa_omie). No
-- ledger `user_id` e PRIMARY KEY => a duplicata e estruturalmente impossivel e o DISTINCT vira
-- inocuo. MANTIDO assim mesmo: custa nada, e o ORDER BY estavel continua obrigatorio porque o edge
-- pagina com `.range()` (§CLAUDE.md: .range() exige .order estavel, senao linha pula/repete).
--
-- FAIL-CLOSED preservado: `calculate-scores:301` LANCA se a RPC falhar (`throw`) — nao semeia as
-- cegas. Se esta migration quebrasse, o efeito seria PARAR o seed do cron `daily-calculate-scores`
-- (0 6), nao corromper dado.
--
-- ACESSO: SECURITY INVOKER (mantido — menor privilegio). O caller e o edge via `service_role`, que
-- tem `rolbypassrls=t` e SELECT no ledger (ambos conferidos por psql-ro em 18/07) => le a tabela
-- inteira apesar da RLS. `authenticated`/`anon` seguem sem EXECUTE.
--
-- Prova PG17 (com falsificacao): db/test-seed-targets-faltantes.sh (ESTENDIDO, nao recriado).

CREATE OR REPLACE FUNCTION public.seed_targets_faltantes()
RETURNS TABLE(user_id uuid)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT DISTINCT l.user_id
  FROM public.carteira_membership_ledger l
  WHERE l.user_id IS NOT NULL
    -- allowlist POSITIVA (nao `<> 'inactive'`): estado novo no CHECK entra fora do seed por default,
    -- e quem o adicionar precisa decidir conscientemente. NULL nao existe (coluna NOT NULL).
    AND l.identity_state IN ('verified', 'ambiguous', 'conflict')
    AND NOT EXISTS (
      SELECT 1 FROM public.farmer_client_scores f
      WHERE f.customer_user_id = l.user_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.cliente_classificacao cc
      WHERE cc.user_id = l.user_id AND cc.excluir_da_carteira
    )
  ORDER BY l.user_id
$$;

REVOKE ALL    ON FUNCTION public.seed_targets_faltantes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_targets_faltantes() TO service_role;

-- ============================================================================
-- Validacao pos-apply (cole no SQL Editor apos o Run).
-- Espere: le_ledger=t · le_espelho=f · exec_service=t · exec_auth=f · exec_anon=f
--         perdidos=0  <= NENHUM alvo que o espelho daria deixou de ser dado pelo ledger
-- ============================================================================
SELECT
  pg_get_functiondef('public.seed_targets_faltantes()'::regprocedure) ~ 'carteira_membership_ledger' AS le_ledger,
  pg_get_functiondef('public.seed_targets_faltantes()'::regprocedure) ~ '\momie_clientes\M'          AS le_espelho,
  has_function_privilege('service_role',  'public.seed_targets_faltantes()', 'EXECUTE')              AS exec_service,
  has_function_privilege('authenticated', 'public.seed_targets_faltantes()', 'EXECUTE')              AS exec_auth,
  has_function_privilege('anon',          'public.seed_targets_faltantes()', 'EXECUTE')              AS exec_anon;

-- Nao-regressao do universo: o que o espelho semearia e o ledger NAO semeia (tem de ser 0).
-- Rode ANTES do DROP TABLE (depois dele o espelho nao existe e esta query nao roda mais).
SELECT count(*) AS perdidos
FROM (
  SELECT DISTINCT oc.user_id
  FROM public.omie_clientes oc
  WHERE oc.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.farmer_client_scores f WHERE f.customer_user_id = oc.user_id)
    AND NOT EXISTS (SELECT 1 FROM public.cliente_classificacao cc WHERE cc.user_id = oc.user_id AND cc.excluir_da_carteira)
  EXCEPT
  SELECT user_id FROM public.seed_targets_faltantes()
) x;
