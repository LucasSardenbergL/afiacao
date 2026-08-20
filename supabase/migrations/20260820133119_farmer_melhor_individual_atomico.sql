-- Motor de bundles — a leitura do melhor individual passa a ser ATOMICA de verdade
--
-- POR QUE ESTA MIGRATION EXISTE (ela corrige a 20260820124611, que NUNCA foi aplicada).
-- A versao anterior trocou o N+1 por uma RPC `RETURNS TABLE` paginada com `fetchAllPages`.
-- O challenge Codex (gpt-5.6-sol, xhigh) mostrou que isso resolve o cap de 1.000 e NAO
-- resolve o problema que motivou a mudanca:
--
--   "customer_user_id da ordem total dentro de cada request, mas fetchAllPages executa K
--    requests e portanto K snapshots. Geracao A tem 1.500 clientes; a pagina 0 le os
--    primeiros 1.000. A substituicao grava a geracao B com 500 clientes. A pagina 1 faz
--    OFFSET 1000, recebe [], e os clientes 1.001-1.500 viram `nenhum`. Como so linhas de A
--    foram observadas, o sensor ve um unico run_id e NAO avisa."
--
-- Isso e pior do que soa: `nenhum` e um VEREDICTO na tela ("nao ha rota individual para
-- este cliente"), e o proposito da entrega era justamente parar de fabricar esse rotulo.
-- Entregar a correcao da UI deixando uma porta nova para o mesmo defeito seria trocar o
-- endereco do bug. E o `run_id`, que eu tinha declarado como o sensor que tornava a mistura
-- DETECTAVEL, e cego a este caso — a afirmacao estava errada.
--
-- A CORRECAO: uma linha so. `jsonb_agg` faz a resposta inteira caber numa unica tupla, e
-- entao a leitura e UM request = UM snapshot MVCC — a coerencia deixa de ser probabilistica.
-- De quebra o cap de 1.000 some por construcao (ele conta LINHAS, e agora ha uma), o que
-- tira este caminho da classe #1782/#1801 em vez de o defender dela.
--
-- Custo medido: 3.858 clientes (a maior carteira) a ~200 bytes por objeto = ~770 KB numa
-- resposta. Hoje sao 671 linhas => ~130 KB. Aceitavel para um recalculo disparado a mao, e
-- barato perto da alternativa (4 requests que podem discordar entre si).
--
-- ⚠️ `coalesce(..., '[]'::jsonb)` NAO e cosmetico. Sem ele a carteira vazia devolve NULL, e
-- NULL e indistinguivel de "a leitura falhou" — exatamente o §6 do money-path (o contrato
-- tem de EXPOR a falha, senao o caller nao pode detectar). Com o coalesce: `[]` = li e nao
-- ha; `null` = so acontece se algo quebrou, e o caller LANCA. Um dos dois lados desta regra
-- vive aqui e o outro no caller; mexer em um sem o outro reabre o buraco.
--
-- ⚠️ DROP + CREATE, nao CREATE OR REPLACE: o tipo de retorno mudou (SETOF record -> jsonb) e
-- o Postgres recusa o REPLACE. E DROP **RESETA o ACL** (REPLACE preservaria), por isso os
-- REVOKE/GRANT abaixo sao reemitidos NOMEANDO as roles — omiti-los deixaria a funcao com o
-- default do Supabase (database.md §4).
--
-- O resto do desenho continua o da migration anterior, e o racional dela vale integralmente:
--
--   DESEMPATE LITERAL ao que o PostgREST emitia, peca por peca —
--     `affinity_score DESC NULLS LAST`  (o caller passava nullsFirst:false; DESC implica
--        NULLS FIRST, entao sem o explicito uma linha de score NULL venceria toda linha
--        medida; o WHERE abaixo ja torna isso inalcancavel — os dois sao defesa em
--        profundidade e remover um reabre o caso pelo outro lado);
--     `updated_at DESC NULLS FIRST`     (o caller NAO passava nullsFirst, e o postgrest-js
--        so serializa .nullsfirst/.nullslast quando o campo e passado — dist/index.cjs:279 —
--        logo valia o default do Postgres. Explicito porque a leitura ingenua mudaria o
--        vencedor. Em prod ha ZERO `updated_at` nulo, medido 20/08/2026);
--     `id DESC`                         (chave TOTAL, e a razao de `created_at` ter saido:
--        desde a 20260814223445 a geracao inteira entra num INSERT so e `now()` e o instante
--        da TRANSACAO, entao `created_at` nao desempata nada. `id` e a PK).
--
--   SECURITY INVOKER de proposito (o resto do repo usa DEFINER): esta RPC nao esconde dado
--   nenhum — o caller ja lia estas MESMAS linhas por PostgREST direto, sob a policy
--   `frec_select_carteira` (`cap_carteira_ler(uid) OR farmer_id = uid OR
--   carteira_visivel_para(customer_user_id, uid)`). DEFINER exigiria reimplementar os tres
--   ramos aqui — inclusive o gate POR CLIENTE — e toda divergencia entre a copia e a policy
--   viraria vazamento ou falso negativo. `p_farmer_id` e FILTRO, nao autorizacao: passar o id
--   de outro farmer nao concede nada. O harness prova o custo da alternativa (sabotagem F7:
--   sob DEFINER a carteira alheia vaza).
--
--   `run_id` continua no payload, com a afirmacao CORRIGIDA: ele nao prova que existe uma
--   geracao unica na TABELA (conta so os vencedores do DISTINCT ON). O que ele mede, e a
--   unica coisa que se pode dizer dele, e "quantas geracoes distintas aparecem entre os
--   vencedores lidos" — util como canario, insuficiente como invariante. A invariante da
--   tabela pertence ao writer do cross-sell, nao a este leitor.
-- ============================================================================================

DROP FUNCTION IF EXISTS public.farmer_melhor_individual_por_cliente(uuid);

CREATE FUNCTION public.farmer_melhor_individual_por_cliente(p_farmer_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', pg_temp
AS $fn$
  SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.customer_user_id), '[]'::jsonb)
  FROM (
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
  ) m
$fn$;

COMMENT ON FUNCTION public.farmer_melhor_individual_por_cliente(uuid) IS
  'Motor de bundles: o melhor produto individual pendente de CADA cliente do farmer, em UMA tupla jsonb. Substitui a versao RETURNS TABLE paginada (20260820124611, nunca aplicada): K requests sao K snapshots, e uma substituicao concorrente entre paginas fazia clientes da cauda virarem "nenhum" — um veredicto — sem o canario de run_id notar. Uma linha = um snapshot MVCC, e o cap de 1.000 do PostgREST some por construcao. Desempate LITERAL ao que o PostgREST emitia (affinity_score DESC NULLS LAST, updated_at DESC NULLS FIRST, id DESC). `[]` = li e nao ha; NULL nunca sai daqui, e o caller trata NULL como FALHA. SECURITY INVOKER: a policy frec_select_carteira segue sendo a unica fronteira, e p_farmer_id e filtro, nao autorizacao.';

-- Privilegios REEMITIDOS porque o DROP acima zerou o ACL (CREATE OR REPLACE teria preservado).
-- REVOKE de PUBLIC nao tira anon/authenticated: o Supabase concede por NOME.
-- Sob INVOKER o EXECUTE e so o direito de CHAMAR — quem decide quais linhas voltam e a RLS.
-- `anon` sai mesmo assim: chamada que nao pode devolver nada nao deve existir.
REVOKE ALL ON FUNCTION public.farmer_melhor_individual_por_cliente(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.farmer_melhor_individual_por_cliente(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.farmer_melhor_individual_por_cliente(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.farmer_melhor_individual_por_cliente(uuid) TO service_role;
