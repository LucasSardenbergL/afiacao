-- FU4-F fase 3 — o COMMENT de `public.get_carteira_margem_faixa()` para de prometer score idêntico.
--
-- POR QUE ESTA MIGRATION EXISTE: o `COMMENT ON FUNCTION` aplicado pela
-- `20260726170000_fu4f_fase3_carteira_margem_faixa.sql` afirma que a RPC preserva o health score
-- "byte a byte". A frase está VIVA no catálogo de produção (conferida por `obj_description`) e é
-- FALSA — medida como falsa em prod (2026-08-13, `psql-ro`) na própria sessão que entregou o PR.
-- Como o arquivo daquela migration é imutável depois de commitado e aplicado (o snapshot de
-- `supabase/migrations/` é a fonte de DR), a correção vem por migration NOVA, que é o caminho do
-- repo para corrigir objeto já aplicado.
--
-- ── O QUE FOI MEDIDO ─────────────────────────────────────────────────────────────────────────
-- A RÉGUA é a mesma (percentis p10/p90 da população, como o hook fazia). O UNIVERSO não:
--   · o hook filtrava status por ALLOWLIST (`confirmado`/`faturado`/`entregue`);
--   · `private.margem_cliente_agregada` — autoridade única desde o #1519, de onde esta RPC
--     deriva — filtra por DENYLIST (tudo que não é `cancelado`/`rascunho`/`pendente`/`orcamento`).
-- Contagem real de `sales_orders` com `deleted_at IS NULL`:
--     faturado 20.597 (nos dois) · importado 5.419 · separacao 2.809 · enviado 2.008 (só helper)
--     `confirmado` e `entregue`: ZERO linhas — a allowlist do hook citava status inexistentes
--   ⇒ 30.833 pedidos contra 20.597: ~50% a mais alimentando a margem.
-- Segundo delta: `sales_orders` é company-wide para staff, mas a RPC devolve só a carteira do
-- caller ⇒ para um VENDEDOR, cliente fora da carteira perde o componente `g` e o
-- `calcularHealthScore` renormaliza os pesos (não penaliza, mas muda o número).
--
-- Nada disso é defeito: é a reconciliação PRETENDIDA pelo #1519, depois que o #1495 achou duas
-- autoridades money-path divergindo em 28,5% dos clientes. O defeito era só a promessa.
--
-- ⚠️ NÃO altera comportamento nem autorização: `COMMENT ON FUNCTION` não toca `prosrc`, então a
-- impressão digital em `db/valida-fu4f-fase3-carteira-margem-faixa.sql` (assert L1 do harness)
-- segue válida — o harness continua verde e a validação pós-apply do #1543 continua dando `t`.
--
-- ⚠️ MIGRATION MANUAL: nome custom não auto-aplica no Lovable. Colar no SQL Editor → Run.

BEGIN;

-- Guardado por `IF EXISTS`: `COMMENT ON FUNCTION` de objeto ausente é ERRO, e isto precisa ser
-- re-rodável em qualquer ambiente — inclusive um banco de DR restaurado num ponto anterior à
-- 20260726170000, onde a função ainda não existe. Sem o guard, a restauração pararia aqui.
DO $mig$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'get_carteira_margem_faixa'
       AND p.pronargs = 0
  ) THEN
    COMMENT ON FUNCTION public.get_carteira_margem_faixa() IS
      'FU4-F fase 3: faixa de margem + componente g por cliente da carteira. O custo e lido no '
      'SERVIDOR (via private.margem_cliente_agregada) e nunca sai; margem_pct so e projetada sob '
      'private.cap_custo_ler. `g` usa a regua de percentis da POPULACAO. '
      'ATENCAO: a REGUA e a mesma que o hook usava, mas o UNIVERSO nao. O hook filtrava status por '
      'allowlist (confirmado/faturado/entregue, das quais duas tem ZERO linhas) e o helper filtra '
      'por denylist: 30.833 pedidos contra 20.597, medido em 2026-08-13. E o escopo por carteira '
      'tira o `g` de cliente fora dela, com renormalizacao dos pesos. Logo o health score MUDA - '
      'medido no PR #1721 sobre as 3 personas reais de prod: ate 59,5% dos clientes mudam de faixa, '
      'delta medio de 1,4 a 4,1 pontos e maximo 14,5 (o teto do peso de G). Mas a AGENDA NAO muda: '
      'nenhuma quota le o health score (risco ordena por churnRisk, expansao por expansionScore, '
      'follow-up por priorityScore) - so o rotulo healthClass exibido. '
      'Ate 2026-08-13 este comentario prometia equivalencia EXATA de score, o que era falso. '
      -- A frase antiga NAO e citada aqui de proposito: repeti-la literalmente faria toda auditoria
      -- por substring (a minha inclusive - foi o assert B2 do harness que pegou) continuar achando
      -- a promessa no catalogo, agora dentro da propria negacao.
      'Escopo espelha a RLS de farmer_client_scores.';
  ELSE
    RAISE NOTICE 'get_carteira_margem_faixa() ausente - COMMENT ignorado (aplique a 20260726170000 antes)';
  END IF;
END
$mig$;

COMMIT;
