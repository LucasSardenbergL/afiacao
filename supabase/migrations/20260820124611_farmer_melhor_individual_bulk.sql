-- Motor de bundles — a comparacao "bundle x melhor produto individual" deixa de ser N+1
--
-- O QUE ESTAVA ERRADO (challenge Codex gpt-5.6-sol/xhigh sobre o #1800). O
-- `useBundleEngine` lia `farmer_recommendations` UMA VEZ POR CLIENTE, dentro do laco
-- `for (const score of clientScores)`. Dois custos, e o segundo e o que importa:
--
--   (a) numa carteira de centenas (a maior em prod tem 3.858 clientes) sao centenas de
--       round-trips seriais;
--   (b) as N consultas sao instantes DIFERENTES. Uma substituicao concorrente de
--       `farmer_recommendations` (a RPC de cross-sell expira a geracao e insere a nova)
--       podia fazer metade dos clientes enxergar uma geracao e a outra metade enxergar
--       outra — todas com sucesso, nenhuma com erro, e o conjunto NAO formando um
--       snapshot coerente. Um SELECT unico e um snapshot MVCC unico: a incoerencia de
--       LEITURA some por construcao, nao por sorte.
--
-- ⚠️ E preciso ser exato sobre o alcance: uma PAGINA e um snapshot MVCC, a paginacao
-- inteira NAO e. Com 3.858 clientes sao ~4 requests, e uma substituicao concorrente entre
-- a pagina 0 e a 1 volta a misturar geracoes. O ganho e real mas e de GRAU — de N
-- instantes (um por cliente) para K (um por pagina), com K tres ordens de grandeza menor.
--
-- E por isso que `run_id` entra no RETURNS: ele faz a mistura RESIDUAL ser DETECTAVEL em
-- vez de apenas improvavel, e cobre com um sensor so as duas causas — a mistura entre
-- PAGINAS e a que nem depende da leitura (duas geracoes vivas na tabela ao mesmo tempo).
-- Antes nenhuma das duas era visivel do caller: o `.select()` nem pedia a coluna. Medido
-- em prod (psql-ro, 20/08/2026): 1.361 pendentes, 671 com `affinity_score`, e UM unico
-- `run_id` — o estado sao, contra o qual o aviso do caller e um canario, nao um alarme.
--
-- ⚠️ O DESEMPATE E LITERAL, NAO "equivalente". Ele foi conquistado num challenge anterior
-- e cada peca responde por um modo de falha:
--
--   `affinity_score DESC NULLS LAST` — o PostgREST emitia
--        `.order('affinity_score', { ascending: false, nullsFirst: false })`.
--        DESC no Postgres implica NULLS FIRST; sem o NULLS LAST explicito, uma linha de
--        score NULL venceria toda linha medida. O `WHERE affinity_score IS NOT NULL`
--        abaixo ja torna isso inalcancavel — os dois juntos sao defesa em profundidade,
--        e remover qualquer um deles reabre o caso pelo outro lado.
--   `updated_at DESC NULLS FIRST` — o caller emitia `.order('updated_at', {ascending:
--        false})` SEM `nullsFirst`, e o postgrest-js so serializa `.nullsfirst`/`.nullslast`
--        quando o campo e passado (dist/index.cjs:279). Sem o campo, vale o default do
--        Postgres: DESC => NULLS FIRST. Escrito EXPLICITO aqui porque a leitura ingenua
--        ("obviamente e NULLS LAST") mudaria o vencedor. Em prod ha ZERO linhas com
--        `updated_at` nulo (medido 20/08/2026), entao hoje o ramo e inalcancavel; ele
--        esta aqui para que a RPC seja identica a leitura que substitui, e nao "quase".
--   `id DESC` — a chave TOTAL, e a razao de `created_at` ter saido: desde a migration
--        20260814223445 a geracao inteira entra num unico INSERT, e `now()` e o instante
--        da TRANSACAO — todas as linhas do run compartilham o mesmo carimbo, entao
--        `created_at` nao desempata nada. `id` e a PK: nunca empata, nunca e nula.
--
-- SECURITY INVOKER de proposito (repare que o resto do repo usa DEFINER): esta RPC nao
-- esconde dado nenhum. O caller ja lia estas MESMAS linhas por PostgREST direto, sob a
-- policy `frec_select_carteira` (`cap_carteira_ler(uid) OR farmer_id = uid OR
-- carteira_visivel_para(customer_user_id, uid)`). DEFINER exigiria reimplementar esses
-- tres ramos aqui — inclusive o gate POR CLIENTE — e toda divergencia entre a copia e a
-- policy viraria vazamento ou falso negativo. INVOKER mantem a RLS como a unica fronteira
-- e a superficie de autorizacao rigorosamente inalterada. Por isso `p_farmer_id` e
-- FILTRO, nao autorizacao: passar o id de outro farmer nao concede nada, exatamente como
-- o `.eq('farmer_id', ...)` que ele substitui.
--
-- PAGINACAO: set-returning chamada do frontend => o caller PAGINA com `fetchAllPages`
-- (`.order('customer_user_id').range()`). A capa de 1.000 do PostgREST vale para `.rpc()`
-- igual a `.from()` e ja zerou este motor duas vezes (#1782, #1801). `customer_user_id` e
-- unico no resultado do DISTINCT ON, logo ordem TOTAL — paginar sobre ela nao pula linha.
-- ============================================================================================

CREATE OR REPLACE FUNCTION public.farmer_melhor_individual_por_cliente(p_farmer_id uuid)
RETURNS TABLE (
  customer_user_id uuid,
  product_id uuid,
  affinity_score numeric,
  recommendation_type text,
  run_id uuid
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', pg_temp
AS $fn$
  SELECT DISTINCT ON (r.customer_user_id)
    r.customer_user_id,
    r.product_id,
    r.affinity_score,
    r.recommendation_type,
    r.run_id
  FROM public.farmer_recommendations r
  WHERE r.farmer_id = p_farmer_id
    AND r.status = 'pendente'
    -- fail-closed do #1800: sem score nao ha "melhor", e ordenar por coluna toda-nula
    -- elegeria um vencedor ARBITRARIO que a tela apresentaria como veredicto.
    AND r.affinity_score IS NOT NULL
  ORDER BY
    r.customer_user_id,
    r.affinity_score DESC NULLS LAST,
    r.updated_at     DESC NULLS FIRST,
    r.id             DESC
$fn$;

COMMENT ON FUNCTION public.farmer_melhor_individual_por_cliente(uuid) IS
  'Motor de bundles: o melhor produto individual pendente de CADA cliente do farmer, em UMA leitura. Substitui a consulta por-cliente dentro do laco do useBundleEngine — N round-trips em N instantes distintos viravam um conjunto sem snapshot coerente sob substituicao concorrente. Desempate LITERAL ao que o PostgREST emitia (affinity_score DESC NULLS LAST, updated_at DESC NULLS FIRST, id DESC); created_at nao desempata desde 20260814223445 (a geracao inteira e um INSERT so). SECURITY INVOKER: a policy frec_select_carteira segue sendo a unica fronteira, e p_farmer_id e filtro, nao autorizacao.';

-- Privilegios. REVOKE de PUBLIC nao tira anon/authenticated: o Supabase concede por NOME.
-- Sob INVOKER o EXECUTE e so o direito de CHAMAR — quem decide quais linhas voltam segue
-- sendo a RLS. `anon` sai mesmo assim: chamada que nao pode devolver nada nao deve existir.
REVOKE ALL ON FUNCTION public.farmer_melhor_individual_por_cliente(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.farmer_melhor_individual_por_cliente(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.farmer_melhor_individual_por_cliente(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.farmer_melhor_individual_por_cliente(uuid) TO service_role;
