-- FU4-F fase 3 / PR-B — o custo sai do browser SEM virar oraculo
--
-- HISTORIA DESTE ARQUIVO (importa para nao repetir o erro). A 1a versao criava
-- `get_ranking_margem(jsonb)`: o caller mandava candidatos com `peso`/`fator` e recebia a ORDEM
-- do ranking. A revisao adversaria (Codex gpt-5.6-sol xhigh) vetou:
--
--   "usando uma margem-ancora conhecida `a`, envie o alvo com fator=1 e copias da ancora em
--    ITENS SEPARADOS com fator=limiar/a. A posicao do alvo revela entre quais limiares sua
--    margem esta. (...) Uma chamada localiza centavos ate R$50; duas cobrem ate R$250 mil."
--
-- Ou seja: `ordem` + multiplicador escolhido pelo caller = REGUA GRADUADA. A guarda de
-- repeticao que eu tinha posto so valia DENTRO de um item; o ataque usa 4.999 itens unitarios.
-- Nao ha conserto incremental: enquanto o caller escolher multiplicadores e receber ordem
-- derivada de margem, o custo se recupera em 2 chamadas.
--
-- DESENHO ATUAL — o custo decide EXCLUSAO, nunca ORDEM.
--   · o ranqueamento volta a ser 100% do cliente, por AFINIDADE (probabilidade, associacao,
--     aderencia de cluster) — nenhum desses toca custo;
--   · o custo entra so para RESPONDER "este SKU e vendavel?" (margem canonica > 0);
--   · a funcao NAO TEM PARAMETRO. Sem input do caller nao ha multiplicador, nao ha limiar
--     escolhido, nao ha regua — e de quebra nao ha cast de jsonb para guardar, nao ha cap de
--     tamanho para furar, nao ha DoS por payload. A superficie de ataque e o conjunto vazio.
--
-- RESIDUO DECLARADO (precisao>recall exige nomear): o caller aprende 1 bit por SKU —
-- "margem > 0" — com limiar FIXO em zero. E 1 desigualdade por SKU, nao busca binaria: sem
-- limiar ajustavel nao ha como estreitar. E o mesmo residuo que o §3.4.2 do spec irmao ja
-- aceitou conscientemente para o `explanation_key` do PR-A, e o preco de manter a feature
-- "nao recomende o que da prejuizo" funcionando.
--
-- POR QUE NAO DESLIGAR AS TELAS (a alternativa que o Codex recomendou): a premissa dele era
-- "features sem demanda observada". Medido: os 3 consertos dos engines (#1466 custo ausente
-- virava margem cheia, #1468 score zerado, #1471 catalogo truncado em 1.000 de 3.642) foram
-- mergeados em 2026-07-20; as tabelas pararam de receber escrita em 2026-05-12 e 2026-03-02,
-- MESES ANTES. A feature nunca rodou consertada — a dormencia e consequencia dos bugs, nao
-- prova de falta de valor. Desligar seria mata-la no dia seguinte ao conserto.

BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('private.cap_custo_ler(uuid)') IS NULL THEN
    RAISE EXCEPTION 'precondicao FALHOU: private.cap_custo_ler(uuid) ausente (a matriz do #1434 nao esta aplicada)';
  END IF;
  IF to_regprocedure('private.regua_num_finito(numeric)') IS NULL THEN
    RAISE EXCEPTION 'precondicao FALHOU: private.regua_num_finito(numeric) ausente (#1488 P1)';
  END IF;
END
$pre$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Custo canonico — espelha src/lib/custo/custoCanonico.ts VERBATIM.
--   canonico = cost_final, fallback cost_price; finito E > 0; senao NULL.
-- ausente != zero: NULL faz o SKU sair da lista, nunca virar margem cheia (#1466).
-- 'NaN'::numeric e valor LEGITIMO em Postgres e mente nas comparacoes ('NaN' > 0 e TRUE, e
-- NaN = NaN tambem e TRUE, ao contrario de IEEE — o truque v <> v NAO detecta). Por isso a
-- finitude vem de private.regua_num_finito, criado no #1488 exatamente para este buraco.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.custo_canonico(p_cost_final numeric, p_cost_price numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN private.regua_num_finito(p_cost_final) AND p_cost_final > 0 THEN p_cost_final
    WHEN private.regua_num_finito(p_cost_price) AND p_cost_price  > 0 THEN p_cost_price
    ELSE NULL
  END;
$fn$;

COMMENT ON FUNCTION private.custo_canonico(numeric, numeric) IS
  'Custo canonico p/ money-path. Espelho SQL de src/lib/custo/custoCanonico.ts (cost_final -> cost_price, finito e > 0, senao NULL). Paridade provada em db/test-authz-custo-fu4f-fase3-ranking.sh.';

-- ─────────────────────────────────────────────────────────────────────────────
-- public.get_skus_margem_positiva() — SEM PARAMETRO, de proposito.
--
-- Devolve os product_id de SKUs ativos cuja margem canonica e > 0. O caller filtra a lista de
-- candidatos por este conjunto e ordena pelo que ja calcula sem custo.
--
-- SKU sem custo conhecido NAO entra (ausente != zero): o hook exclui, como ja fazia — e essa
-- e a razao de fechar product_costs "e deixar degradar" apagar a feature, que esta RPC evita.
--
-- FAIL-CLOSED: auth.uid() NULL -> zero linhas. Com service_role auth.uid() e NULL, entao ligar
-- um chamador no client errado falha FECHADO.
--
-- Sem gate de carteira: o conjunto nao depende de cliente nenhum (custo e preco sao globais),
-- entao nao ha o que escopar por carteira — e um gate aqui seria teatro. O gate que importa e
-- o de identidade (staff), abaixo.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_skus_margem_positiva()
RETURNS TABLE (product_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', pg_temp
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
BEGIN
  IF v_uid IS NULL THEN
    RETURN;
  END IF;

  -- staff-only: quem nao e employee nem master nao tem por que saber o que e vendavel.
  -- (customers sao 5.664 dos 5.669 usuarios — deixa-los fora e o grosso da superficie.)
  IF NOT (public.has_role(v_uid, 'employee'::public.app_role)
          OR public.has_role(v_uid, 'master'::public.app_role)) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.id
  FROM public.omie_products p
  JOIN public.product_costs pc ON pc.product_id = p.id
  WHERE p.ativo IS TRUE
    AND private.regua_num_finito(p.valor_unitario)
    AND p.valor_unitario > 0
    AND private.custo_canonico(pc.cost_final, pc.cost_price) IS NOT NULL
    AND p.valor_unitario > private.custo_canonico(pc.cost_final, pc.cost_price);
END
$fn$;

COMMENT ON FUNCTION public.get_skus_margem_positiva() IS
  'FU4-F fase 3: devolve os SKUs vendaveis (margem canonica > 0) para os engines de recomendacao filtrarem candidatos SEM ler custo. SEM PARAMETRO de proposito — a versao anterior aceitava multiplicadores do caller e devolvia ordem, o que o Codex mostrou ser regua graduada (2 chamadas recuperavam o catalogo). Residuo declarado: 1 bit por SKU com limiar FIXO em zero, sem estreitamento possivel.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Privilegios. REVOKE de PUBLIC nao tira anon/authenticated: o Supabase concede por NOME.
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.get_skus_margem_positiva() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_skus_margem_positiva() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_skus_margem_positiva() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_skus_margem_positiva() TO service_role;

COMMIT;
