-- FU4-F fase 3 — o scoring do farmer para de baixar o catálogo de custo.
--
-- PROBLEMA: `src/hooks/useFarmerScoring.ts` baixa `product_costs` INTEIRA para o browser —
-- 3.637 linhas de `cost_final`/`cost_price`, paginadas de propósito para furar a capa de 1.000
-- do PostgREST — e calcula a margem por cliente em memória. É a maior via browser→custo aberta.
--
-- DECISÃO DE PRODUTO (dono, 2026-07-20): o NÚMERO de custo fecha, o SINAL fica.
--
-- ── POR QUE ESTA RPC DEVOLVE `g`, E NÃO SÓ A FAIXA (decisão medida, 2026-07-22) ──────────────
-- O desenho original era devolver só a faixa e o hook mapear verde/amarelo/vermelho → 1/0,5/0.
-- Medido sobre a prod, isso DESCARTARIA a régua de percentis (p10/p90 da população) que o hook
-- usa hoje e mudaria o health score de quase todo mundo:
--     1.069 clientes com margem · peso do G = 0,150
--     729 deles (68%) teriam `g` alterado em mais de 0,2 (escala 0–1)
--     delta médio no health score: 5,73 pontos · máximo: 14,42 pontos
-- Seria uma mudança de PRODUTO embutida numa entrega de AUTORIZAÇÃO. Por isso a RPC calcula `g`
-- no SERVIDOR com a mesma régua, e o hook passa a consumi-lo em vez de derivá-lo da faixa:
-- o score fica idêntico e `product_costs` para de ir ao browser.
--
-- ⚠️ `g` NÃO é exposição nova: ele já é renderizado hoje na barra "G" do FarmerDashboard
-- (`:406-429`). O que sai de cena é o CATÁLOGO DE CUSTO UNITÁRIO, que é o alvo da fase.
--
-- ── O QUE CADA CAMPO CARREGA ─────────────────────────────────────────────────────────────────
--   `faixa`/`motivo` — o SINAL, sempre. Vocabulário herdado de `get_preco_cockpit`.
--   `g`              — o componente de margem normalizado (0..1), sempre. `NULL` quando a margem
--                      não é apurável — o `calcularHealthScore` (#1533) RENORMALIZA os pesos
--                      nesse caso, então null não penaliza o cliente. Nunca devolver 0 aqui:
--                      `g = 0` é veredito ("pior margem da população"), ≠ "não sei".
--   `margem_pct`     — o NÚMERO, só sob `private.cap_custo_ler`. Gate de PROJEÇÃO: o cálculo
--                      interno usa o valor real, a SAÍDA esconde. A chave fica presente com
--                      NULL para o front tolerar.
--
-- ── ESCOPO ───────────────────────────────────────────────────────────────────────────────────
-- Espelha a RLS de `farmer_client_scores` (policy `fcs_select_carteira`):
--   `cap_carteira_ler(uid)` (gestor/master vê tudo) OR `carteira_visivel_para(cliente, uid)`.
-- ⚠️ A RÉGUA DE PERCENTIS É CALCULADA SOBRE A POPULAÇÃO INTEIRA, ANTES do filtro de escopo —
-- de propósito. É o que o hook faz hoje (ele carrega todos os clientes para achar p10/p90) e é o
-- que mantém `g` COMPARÁVEL entre vendedores: uma régua por carteira faria o mesmo cliente ter
-- `g` diferente conforme quem pergunta, e o health score deixaria de ser uma medida da BASE.
-- Isso não vaza: percentil é estatística agregada da população, não dado de cliente alheio.
--
-- ⚠️ MIGRATION MANUAL: nome custom não auto-aplica no Lovable. Colar no SQL Editor → Run.
-- Ordem: DEPOIS de `20260726160000` (consome `private.margem_cliente_agregada`).

BEGIN;

CREATE OR REPLACE FUNCTION public.get_carteira_margem_faixa()
RETURNS TABLE (
  customer_user_id uuid,
  faixa            text,
  motivo           text,
  g                numeric,
  margem_pct       numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $fn$
DECLARE
  v_uid      uuid;
  v_pode_num boolean;
  v_cap_todo boolean;
  v_piso     numeric;
  v_meta     numeric;
BEGIN
  -- Atribuição no CORPO, nunca no DECLARE: erro na inicialização de DECLARE não é capturável
  -- pelo EXCEPTION do próprio bloco e derrubaria a função inteira.
  v_uid := (SELECT auth.uid());

  -- Fail-closed: sem identidade, zero linhas.
  IF v_uid IS NULL THEN
    RETURN;
  END IF;

  v_pode_num := COALESCE(private.cap_custo_ler(v_uid), false);
  v_cap_todo := COALESCE(private.cap_carteira_ler(v_uid), false);

  -- Limiares em CONFIG, não em código: mudar a faixa é UPDATE, não deploy.
  SELECT COALESCE(max(c.value::numeric) FILTER (WHERE c.key = 'margem_faixa_piso_pct'), 30),
         COALESCE(max(c.value::numeric) FILTER (WHERE c.key = 'margem_faixa_meta_pct'), 50)
    INTO v_piso, v_meta
    FROM public.farmer_algorithm_config c
   WHERE c.key IN ('margem_faixa_piso_pct', 'margem_faixa_meta_pct');

  RETURN QUERY
  WITH base AS (
    SELECT m.customer_user_id AS cid, m.margem_pct AS pct
      FROM private.margem_cliente_agregada() m
  ),
  regua AS (
    -- p10/p90 sobre a POPULAÇÃO INTEIRA (ver nota de escopo acima). `margem_pct` vem em pontos
    -- percentuais (0–100); o hook trabalha em fração (0–1). Dividir por 100 mantém a régua
    -- idêntica à dele: a normalização é invariante a escala, mas manter a mesma unidade evita
    -- que uma futura mudança de limiar leia errado.
    SELECT percentile_cont(0.10) WITHIN GROUP (ORDER BY b.pct / 100.0)::numeric AS p10,
           percentile_cont(0.90) WITHIN GROUP (ORDER BY b.pct / 100.0)::numeric AS p90
      FROM base b
     WHERE b.pct IS NOT NULL
  )
  SELECT
    b.cid,
    CASE WHEN b.pct IS NULL   THEN 'neutro'
         WHEN b.pct < 0       THEN 'vermelho'
         WHEN b.pct < v_piso  THEN 'amarelo'
         ELSE                      'verde'   END,
    CASE WHEN b.pct IS NULL   THEN 'sem_custo'
         WHEN b.pct < 0       THEN 'abaixo_do_custo'
         WHEN b.pct < v_piso  THEN 'abaixo_do_piso'
         WHEN b.pct < v_meta  THEN 'abaixo_da_meta'
         ELSE                      'saudavel' END,
    -- `g` com a MESMA régua do hook: clamp((margem - p10) / max(p90 - p10, 0.01), 0, 1).
    -- NULL quando a margem não é apurável — o calcularHealthScore renormaliza os pesos.
    CASE WHEN b.pct IS NULL THEN NULL
         ELSE greatest(0::numeric,
                least(1::numeric,
                  (b.pct / 100.0 - r.p10) / greatest(r.p90 - r.p10, 0.01::numeric)))
    END,
    -- Gate de PROJEÇÃO: esconde na SAÍDA, não no cálculo.
    CASE WHEN v_pode_num THEN b.pct END
  FROM base b CROSS JOIN regua r
  -- Escopo espelhando fcs_select_carteira. O filtro vem DEPOIS da régua, de propósito.
  WHERE v_cap_todo
     OR COALESCE(private.carteira_visivel_para(b.cid, v_uid), false);
END;
$fn$;

COMMENT ON FUNCTION public.get_carteira_margem_faixa() IS
  'FU4-F fase 3: faixa de margem + componente g por cliente da carteira. O custo e lido no '
  'SERVIDOR (via private.margem_cliente_agregada) e nunca sai; margem_pct so e projetada sob '
  'private.cap_custo_ler. `g` usa a regua de percentis da POPULACAO, preservando o health score '
  'do hook byte a byte. Escopo espelha a RLS de farmer_client_scores.';

-- Fechamento por privilégio. Função nova nasce com proacl NULL = EXECUTE implícito a PUBLIC, e o
-- default privilege do Supabase concede às roles nomeadas — revogar dos DOIS jeitos.
-- ⚠️ `authenticated` MANTÉM o EXECUTE: é o role do vendedor no browser, e o gate está no CORPO
-- (escopo por carteira + projeção do número). Revogar aqui quebraria o consumidor legítimo.
REVOKE ALL ON FUNCTION public.get_carteira_margem_faixa() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_carteira_margem_faixa() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_carteira_margem_faixa() TO authenticated, service_role;

COMMIT;
