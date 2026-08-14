-- ============================================================
-- FU4-F fase 3c — `motivo` entra no gate de custo: as ÂNCORAS ABSOLUTAS somem
--
-- O QUE ESTE PR FECHA
-- O #1723 fechou a ESCRITA dos limiares `margem_faixa_*` (o oráculo de custo por busca binária,
-- que exigia escritas repetidas). A revisão adversarial daquele PR (Codex gpt-5.6-sol, 2026-08-13)
-- mostrou um vazamento ESTRUTURALMENTE PIOR, de LEITURA, numa única resposta e sem escrever nada:
--
--   `g` é uma transformação AFIM da margem:  margem_pct = A + B*g,
--   com A = 100*p10 e B = 100*max(p90-p10, 0.01) — ambos desconhecidos do atacante.
--
-- Só que `motivo` fornecia as ÂNCORAS ABSOLUTAS que faltavam para resolver o sistema:
--   'abaixo_do_piso' => margem < 30   e   'abaixo_da_meta' => 30 <= margem < 50.
-- Ordenando os pares (g, motivo) e tomando o MAIOR g de cada motivo, o atacante calibra
--   B = (50-30)/(g_50 - g_30)   e   A = 30 - B*g_30
-- e daí reconstrói a margem de TODA a carteira visível. Com a receita à vista, deriva o custo.
--
-- MEDIDO EM PROD (read-only, 2026-08-13), o ataque não é teórico:
--   A_est = 29,4560 contra A_real = 29,4260  → erro 0,03 pp
--   B_est = 45,7780 contra B_real = 45,7780  → erro 0,0000
--   859 dos 1.075 clientes com margem reconstruídos com erro MÁXIMO de 0,03 pp.
--   Os 216 restantes estão saturados (g=0 ou g=1) e não invertem — mas entregam o limite
--   (margem <= 29,46% ou >= 75,23%), que já é informação de custo.
--
-- A CORREÇÃO, e por que é ESTA
-- `motivo` passa a ser projetado sob `private.cap_custo_ler`, exatamente como `margem_pct` já era.
-- Sem as âncoras, sobra a fronteira do piso vinda de `faixa` — UMA equação para DUAS incógnitas,
-- e a inversão absoluta não fecha.
--
-- ⚠️ O que este PR deliberadamente NÃO faz: gatear `g`. Gatear `g` fecharia o eixo por inteiro,
-- mas `calcularHealthScore` RENORMALIZA os pesos quando `g` é null, então o health score de quem
-- não tem cap MUDARIA — decisão de PRODUTO embutida numa entrega de AUTORIZAÇÃO, que é
-- precisamente o que o #1543 evitou de propósito ("o número fecha, o sinal fica").
-- O custo foi MEDIDO antes de descartar, não presumido (logs/impacto-gate-g, harness
-- `scripts/impacto-gate-g.ts`): 640 visões de cliente mudariam de score nos 2 farmers sem cap
-- (Δ médio 5,88 e 6,02 pontos; máx 14,5), 91 mudariam de classe, e a AGENDA ficaria idêntica.
-- O founder optou por fechar a âncora e preservar o score (decisão de 2026-08-13).
--
-- ⚠️ Limite honesto desta defesa: ela depende de `p10 > 0` (hoje 29,43%). A fronteira 'vermelho'
-- (margem < 0) só não serve de 2ª âncora porque está SATURADA — todo cliente com margem abaixo de
-- p10 tem g=0, e 108 deles são indistinguíveis entre si. Se a população passar a ter margem
-- negativa relevante, p10 cai abaixo de zero, aquela fronteira sai da saturação e devolve a 2ª
-- âncora sozinha. É defesa boa hoje, NÃO é invariante — quem mexer na régua revisita isto.
-- A ORDENAÇÃO por margem também segue exposta por construção (g é monótono na margem): quem tem
-- a margem real de UM cliente por fora fecha o sistema. Fechar isso exige gatear `g`.
--
-- Migration anterior desta função: 20260726170000_fu4f_fase3_carteira_margem_faixa.sql
-- Corpo abaixo conferido contra `pg_get_functiondef` da PROD em 2026-08-13 (pré-flight do
-- lovable-db-operator §2.7): idêntico ao vivo, exceto o CASE do `motivo`.
-- Prova: db/test-carteira-margem-faixa-motivo-gate.sh (PG17, com falsificação).
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_carteira_margem_faixa()
RETURNS TABLE(customer_user_id uuid, faixa text, motivo text, g numeric, margem_pct numeric)
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
    -- Gate de PROJEÇÃO do MOTIVO (fase 3c). `motivo` carregava as âncoras ABSOLUTAS do piso e da
    -- meta; com elas, `g` — que é afim na margem — inverte para o número exato. Sem cap, o
    -- vocabulário de motivo não sai. A FAIXA continua saindo: ela é o sinal que o produto quer
    -- ("o número fecha, o sinal fica") e ancora só a fronteira do piso, que sozinha não fecha o
    -- sistema de duas incógnitas.
    -- ⚠️ NULL, não uma string genérica ('indisponivel'/'—'): rótulo constante é fato fabricado, e
    -- o §5 do money-path já pagou por isso (`empresa_omie` com DEFAULT respondendo por 100%).
    CASE WHEN v_pode_num THEN
      CASE WHEN b.pct IS NULL   THEN 'sem_custo'
           WHEN b.pct < 0       THEN 'abaixo_do_custo'
           WHEN b.pct < v_piso  THEN 'abaixo_do_piso'
           WHEN b.pct < v_meta  THEN 'abaixo_da_meta'
           ELSE                      'saudavel' END
    END,
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

-- ⚠️ UNIÃO, não substituição. O #1728 (20260813225057) acabou de trocar a promessa FALSA de
-- equivalência de score pelo delta MEDIDO, e tem um harness que assere sobre ESTE texto
-- (db/test-comment-honesto-margem-faixa.sh, B2-B4c: exige a AUSÊNCIA de "byte a byte" e a
-- presença de "30.833 pedidos contra 20.597", "health score MUDA", "59,5%"/"14,5" e
-- "AGENDA NAO muda"). Como esta migration roda DEPOIS dele e `COMMENT` faz a última a escrever
-- VENCER, reescrever do zero apagaria o trabalho dele em silêncio — a armadilha "a última a
-- recriar vence" do CLAUDE.md. O texto dele vai INTEIRO abaixo; a fase 3c só ACRESCENTA no fim.
-- ⚠️ Nunca mais reescreva este comentário sem os marcadores acima: rode
-- db/test-comment-honesto-margem-faixa.sh depois de mexer.
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
  -- por substring continuar achando a promessa no catalogo, agora dentro da propria negacao.
  'Escopo espelha a RLS de farmer_client_scores. '
  'FASE 3c (2026-08-13): `motivo` passou a ser projetado sob private.cap_custo_ler, junto de '
  'margem_pct. Ele carregava as ANCORAS ABSOLUTAS (piso 30 / meta 50) e, como `g` e AFIM na '
  'margem (margem_pct = A + B*g), o maior `g` de cada motivo calibrava A e B e reconstruia a '
  'carteira inteira numa unica resposta - medido em prod: erro de 0,03 pp em 859 dos 1.075 '
  'clientes com margem. `faixa` e `g` CONTINUAM saindo sem cap: gatear `g` mudaria o health '
  'score de quem nao tem cap (renormalizacao dos pesos), que e produto, nao autorizacao - o '
  'custo foi medido (640 clientes, 91 de classe, agenda identica) e o founder optou por '
  'preservar o score. A defesa depende de p10 > 0: a fronteira vermelho (margem < 0) so nao e '
  '2a ancora porque esta SATURADA; se p10 cair abaixo de zero ela volta sozinha.';

-- Fechamento por privilégio — reafirmado (idempotente). Função nova nasce com proacl NULL =
-- EXECUTE implícito a PUBLIC, e o default privilege do Supabase concede às roles nomeadas.
-- ⚠️ `authenticated` MANTÉM o EXECUTE: é o role do vendedor no browser, e o gate está no CORPO.
REVOKE ALL ON FUNCTION public.get_carteira_margem_faixa() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_carteira_margem_faixa() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_carteira_margem_faixa() TO authenticated, service_role;

COMMIT;
