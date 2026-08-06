-- FU4-F fase 3, PR 3-zero — motor de margem SERVER-SIDE (pré-requisito do fechamento de custo)
--
-- PROBLEMA (medido em prod 2026-07-20): `farmer_client_scores.gross_margin_pct` está 0 para
-- 1.214 de 1.214 clientes COM histórico de compra — nenhum com valor não-zero. A margem nunca
-- foi calculada no servidor: a edge `calculate-scores` LÊ a coluna da própria tabela que escreve
-- (index.ts:237 lê de farmer_client_scores; 464/484 usa client.gross_margin_pct; reescreve no
-- upsert). Loop fechado sobre um valor que nasce 0 no seed (index.ts:355) e nunca é recomputado.
-- Consequência: o componente de MARGEM do health score vale 0 para todo cliente, e as ~12 telas
-- que leem farmer_client_scores (Intelligence, Customer360, copilot, plano tático) exibem zero.
--
-- POR QUE ISTO É PRÉ-REQUISITO DO FECHAMENTO DE CUSTO: o FU4-F fase 3 fecha `product_costs` para
-- quem não tem `private.cap_custo_ler`, o que obriga os 3 engines do browser (cross-sell, farmer
-- scoring, bundle) a parar de baixar a tabela de custos. Mover o cálculo "para o servidor"
-- pressupõe um cálculo server-side que NÃO EXISTE — este é ele. Fechar a policy antes disto
-- apagaria a feature em vez de protegê-la.
--
-- DESENHO — função NOVA, não extensão de get_customer_sales_summary:
--   (a) aquela é LANGUAGE sql INVOKER (prosecdef=f, medido em prod); uma função INVOKER que lê
--       product_costs QUEBRA no dia em que a RLS de custo fechar — exatamente a armadilha dos
--       leitores invoker mapeados no spec (atualizar_parametros_numericos_skus, gerar_pedidos_
--       sugeridos_ciclo). SECURITY DEFINER é imune;
--   (b) acrescentar coluna a um RETURNS TABLE exige DROP+CREATE (o CREATE OR REPLACE recusa
--       mudança de tipo de retorno), o que derrubaria a RPC de recência num intervalo em que o
--       cron pode disparar. Função separada não toca a existente.
--
-- SUPERFÍCIE DE LEITURA: SECURITY DEFINER bypassa RLS, então esta função é uma porta para o custo
-- agregado por cliente. Ela é fechada por PRIVILÉGIO (não por lógica): EXECUTE revogado de
-- authenticated/anon POR NOME — `REVOKE FROM PUBLIC` não tira grant explícito de role nomeada
-- (armadilha registrada em docs/agent/database.md) — e concedido só a service_role, que é quem a
-- edge do cron usa. Nenhum caminho do browser alcança esta função.
--
-- MONEY-PATH (ausente ≠ zero): cliente sem NENHUM item de custo conhecido devolve
-- gross_margin_pct = NULL, jamais 0 — margem 0 é um valor de decisão legítimo ("cliente ruim") e
-- confundi-lo com "não sei" é fabricar número. Espelha a semântica de src/lib/custo/custoCanonico.ts
-- (custo <= 0 / NaN / ausente → null, o SKU é EXCLUÍDO do cálculo) e de src/lib/scoring/margin.ts
-- (accumulateMarginFromItems conta receita E custo somente dos itens com custo conhecido). Margem
-- NEGATIVA é dado real e é preservada — em prod o mínimo é -143,22%.
--
-- FONTE: order_items (tabela normalizada, com product_id real), NÃO o jsonb sales_orders.items.
-- O bug de resolução pt-BR do #1468 (itens só têm omie_codigo_produto, nunca product_id) é do
-- caminho jsonb do frontend; aqui o join é direto por product_id.
--
-- BASELINE medido em prod ANTES do apply (mesma lógica rodada como SELECT read-only):
--   1.214 clientes com pedido · 1.052 com margem calculável · 162 → NULL (sem custo conhecido)
--   média 53,47% · p50 56,39% · faixa -143,22% a 88,33%
--   39.986 itens com custo · 28.447 sem custo (41,6% do total — produto sem linha em product_costs)
-- Pós-apply, `SELECT count(*) FILTER (WHERE gross_margin_pct IS NOT NULL)` sobre a função tem de
-- devolver 1.052, e a coluna da tabela sai de 0-para-todos após o primeiro run do cron.

CREATE OR REPLACE FUNCTION public.get_customer_margin_summary()
RETURNS TABLE(
  customer_user_id  uuid,
  itens_com_custo   bigint,
  itens_sem_custo   bigint,
  receita_com_custo numeric,
  custo_conhecido   numeric,
  gross_margin_pct  numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH itens AS (
    SELECT
      oi.customer_user_id,
      COALESCE(NULLIF(oi.quantity, 0), 1) AS qtd,
      COALESCE(oi.unit_price, 0)          AS preco_unit,
      -- Custo canônico: cost_final (saída do motor, proxy-aware) → fallback cost_price (custo real
      -- legado, nullable pós-#977). Só vale > 0 e finito; 0/negativo/NaN/ausente → NULL = "não sei".
      CASE
        WHEN pc.cost_final IS NOT NULL AND pc.cost_final > 0 AND pc.cost_final <> 'NaN'::numeric
          THEN pc.cost_final
        WHEN pc.cost_price IS NOT NULL AND pc.cost_price > 0 AND pc.cost_price <> 'NaN'::numeric
          THEN pc.cost_price
        ELSE NULL
      END AS custo_unit
    FROM public.order_items oi
    JOIN public.sales_orders so ON so.id = oi.sales_order_id
    LEFT JOIN public.product_costs pc ON pc.product_id = oi.product_id
    WHERE so.status NOT IN ('cancelado', 'rascunho', 'pendente', 'orcamento')
      AND so.deleted_at IS NULL
      AND oi.customer_user_id IS NOT NULL
  )
  SELECT
    i.customer_user_id,
    count(*) FILTER (WHERE i.custo_unit IS NOT NULL) AS itens_com_custo,
    count(*) FILTER (WHERE i.custo_unit IS NULL)     AS itens_sem_custo,
    COALESCE(sum(i.preco_unit * i.qtd) FILTER (WHERE i.custo_unit IS NOT NULL), 0) AS receita_com_custo,
    COALESCE(sum(i.custo_unit  * i.qtd) FILTER (WHERE i.custo_unit IS NOT NULL), 0) AS custo_conhecido,
    -- Denominador > 0 é a única condição que produz número. Sem item de custo conhecido (ou
    -- receita 0 sobre eles) → NULL. NUNCA 0: quem consome tem de distinguir "margem zero" de
    -- "não sei" e excluir o cliente do ranking no segundo caso.
    CASE
      WHEN COALESCE(sum(i.preco_unit * i.qtd) FILTER (WHERE i.custo_unit IS NOT NULL), 0) > 0
        THEN round(
          (
            (
              sum(i.preco_unit * i.qtd) FILTER (WHERE i.custo_unit IS NOT NULL)
              - sum(i.custo_unit * i.qtd) FILTER (WHERE i.custo_unit IS NOT NULL)
            )
            / sum(i.preco_unit * i.qtd) FILTER (WHERE i.custo_unit IS NOT NULL)
          ) * 100
        , 2)
      ELSE NULL
    END AS gross_margin_pct
  FROM itens i
  GROUP BY i.customer_user_id;
$function$;

COMMENT ON FUNCTION public.get_customer_margin_summary() IS
  'Margem bruta por cliente calculada no SERVIDOR a partir de order_items x product_costs. '
  'Contraparte de get_customer_sales_summary para o componente de margem do health score. '
  'ausente<>zero: cliente sem item de custo conhecido devolve NULL, nunca 0. '
  'SECURITY DEFINER + EXECUTE so para service_role: nenhum caminho do browser alcanca esta funcao.';

-- Fechamento por PRIVILÉGIO. A ordem importa: revogar de PUBLIC não remove grant explícito das
-- roles nomeadas do Supabase, por isso anon e authenticated são revogados um a um.
REVOKE ALL ON FUNCTION public.get_customer_margin_summary() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_customer_margin_summary() FROM anon;
REVOKE ALL ON FUNCTION public.get_customer_margin_summary() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_margin_summary() TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- apply_score_updates — persistir gross_margin_pct e aceitar m_score DESCONHECIDO
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Sem esta parte a correção acima não chega ao banco: a edge persiste via apply_score_updates, cujo
-- jsonb_to_recordset tem lista FIXA de colunas — gross_margin_pct não estava nela, então o overlay
-- da margem morreria em memória e a coluna seguiria como está.
--
-- DUAS mudanças, ambas necessárias:
--
-- 1) `gross_margin_pct numeric` entra nos DOIS recordsets e no UPDATE. Atribuição DIRETA, sem
--    COALESCE: a margem precisa poder ser gravada como NULL de propósito (cliente cujos itens não
--    têm custo conhecido). Com COALESCE o NULL honesto seria engolido e a linha ficaria presa no
--    valor velho — que hoje é o 0 fabricado, exatamente o que este PR remove.
--    ⚠️ Consequência de ordem de deploy (migration e edge são deploys INDEPENDENTES no Lovable):
--    se esta migration entrar ANTES do deploy da edge, a edge antiga não envia a chave, o
--    recordset devolve NULL e a coluna vira NULL para todos. Isso é ACEITÁVEL e até desejável —
--    NULL ("não medido") é mais honesto que o 0 atual, e o primeiro run da edge nova preenche.
--    A ordem inversa (edge antes da migration) também é segura: a chave extra no jsonb é ignorada
--    pelo recordset antigo. Não há ordem que quebre.
--
-- 2) `m_score` SAI do guard de obrigatórias (13 → 12 chaves CORE). Motivo: m_score é o componente
--    de margem normalizado e agora é legitimamente NULL quando a margem é desconhecida — manter o
--    NOT NULL forçaria a edge a mandar 0, que é veredito ("pior cliente neste eixo"), não ausência.
--    O guard continua protegendo o que o incidente 2026-05-27 endureceu: id + os 11 campos que
--    NUNCA são opcionais. Payload malformado (chave ausente por bug) segue barrado neles.
--    O UPDATE de m_score continua DIRETO (não COALESCE) — "não medi neste run" tem de sobrescrever
--    o valor velho, senão o score guarda uma margem que já não se sustenta.
CREATE OR REPLACE FUNCTION public.apply_score_updates(p_updates jsonb)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_count int;
  v_total int;
  v_valid int;
BEGIN
  -- GUARD DE CONTRATO (full-update only): as 12 chaves CORE são obrigatórias em TODA linha.
  -- sales_history_status, gross_margin_pct e m_score NÃO entram aqui (opcionais/nuláveis por
  -- semântica) → edge antigo segue válido.
  v_total := jsonb_array_length(p_updates);

  SELECT count(*) INTO v_valid
  FROM jsonb_to_recordset(p_updates) AS u(
    id                       uuid,
    health_score             numeric,
    health_class             text,
    churn_risk               numeric,
    priority_score           numeric,
    rf_score                 numeric,
    g_score                  numeric,
    days_since_last_purchase integer,
    avg_monthly_spend_180d   numeric,
    category_count           integer,
    calculated_at            timestamptz,
    updated_at               timestamptz
  )
  WHERE id                       IS NOT NULL
    AND health_score             IS NOT NULL
    AND health_class             IS NOT NULL
    AND churn_risk               IS NOT NULL
    AND priority_score           IS NOT NULL
    AND rf_score                 IS NOT NULL
    AND g_score                  IS NOT NULL
    AND days_since_last_purchase IS NOT NULL
    AND avg_monthly_spend_180d   IS NOT NULL
    AND category_count           IS NOT NULL
    AND calculated_at            IS NOT NULL
    AND updated_at               IS NOT NULL;

  IF v_valid <> v_total THEN
    RAISE EXCEPTION
      'apply_score_updates: contrato full-update violado — % de % elemento(s) com campo obrigatorio nulo/ausente (as 12 chaves CORE sao obrigatorias; jsonb_to_recordset nao faz COALESCE)',
      (v_total - v_valid), v_total
      USING ERRCODE = 'check_violation';
  END IF;

  -- UPDATE-only por id (anti-ressurreição #971), base de vendas (#987) + sales_history_status (COALESCE).
  UPDATE public.farmer_client_scores f SET
    health_score             = u.health_score,
    health_class             = u.health_class,
    churn_risk               = u.churn_risk,
    priority_score           = u.priority_score,
    rf_score                 = u.rf_score,
    m_score                  = u.m_score,
    g_score                  = u.g_score,
    gross_margin_pct         = u.gross_margin_pct,
    days_since_last_purchase = u.days_since_last_purchase,
    avg_monthly_spend_180d   = u.avg_monthly_spend_180d,
    category_count           = u.category_count,
    sales_history_status     = COALESCE(u.sales_history_status, f.sales_history_status),
    calculated_at            = u.calculated_at,
    updated_at               = u.updated_at
  FROM jsonb_to_recordset(p_updates) AS u(
    id                       uuid,
    health_score             numeric,
    health_class             text,
    churn_risk               numeric,
    priority_score           numeric,
    rf_score                 numeric,
    m_score                  numeric,
    g_score                  numeric,
    gross_margin_pct         numeric,
    days_since_last_purchase integer,
    avg_monthly_spend_180d   numeric,
    category_count           integer,
    sales_history_status     text,
    calculated_at            timestamptz,
    updated_at               timestamptz
  )
  WHERE f.id = u.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $function$;
