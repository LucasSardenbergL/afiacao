-- ============================================================
-- Trava de crédito — piso (vencido > 60 d) sobre o GRUPO inteiro.
-- Spec: docs/superpowers/specs/2026-11-20-credito-ia-design.md §9.3 (P1 Codex 2026-11-20).
-- Plano: docs/superpowers/plans/2026-11-20-credito-ia.md — PR 1, Task 1.
--
-- Furo fechado: venda_gate_credito olhava só o PAR do pedido (company, código).
-- Medido em prod (psql-ro, 2026-11-20): em 90 d, 93 pedidos (26 clientes,
-- R$ 143.507) saíram numa conta do grupo para cliente com vencido > 60 d em OUTRA.
--
-- Grupo = canônico + aliases fiscais com vínculo 'active' (customer_canonical_alias),
-- expandidos para os pares de omie_customer_account_map. 'inactive'/'conflict' NÃO
-- expandem (não fabrica vínculo — precisão > recall), mas o par do próprio pedido
-- sempre entra no escopo.
--
-- venda_gate_credito(text,bigint,uuid) fica INTACTA: rollback = a edge volta a chamá-la.
-- Prova PG17: db/test-trava-credito-piso-grupo.sh (asserts + falsificação).
-- ============================================================

CREATE OR REPLACE FUNCTION public.credito_grupo_pares(p_user_id uuid)
RETURNS TABLE(company text, omie_codigo_cliente bigint, user_id uuid, origem text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH canon AS (
    -- Se p_user_id é alias ATIVO, o grupo é o do canônico; senão ele próprio é a raiz.
    SELECT COALESCE(
      (SELECT a.canonical_user_id
         FROM public.customer_canonical_alias a
        WHERE a.alias_user_id = p_user_id
          AND a.status = 'active'),
      p_user_id
    ) AS cid
  ),
  membros AS (
    SELECT c.cid AS uid, 'canonico'::text AS origem
      FROM canon c
     WHERE c.cid IS NOT NULL
    UNION
    SELECT a.alias_user_id, 'alias'::text
      FROM public.customer_canonical_alias a
      JOIN canon c ON a.canonical_user_id = c.cid
     WHERE a.status = 'active'
  )
  SELECT m.account, m.omie_codigo_cliente, mb.uid, mb.origem
    FROM membros mb
    JOIN public.omie_customer_account_map m ON m.user_id = mb.uid
   WHERE m.omie_codigo_cliente IS NOT NULL
     AND m.omie_codigo_cliente > 0;
$$;

REVOKE EXECUTE ON FUNCTION public.credito_grupo_pares(uuid) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.credito_grupo_pares(uuid) TO service_role;


CREATE OR REPLACE FUNCTION public.venda_gate_credito_grupo(
  p_sales_order_id uuid,
  p_company text,
  p_codigo bigint,
  p_customer_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_corte date;
  v_n_escopo integer;
  v_grupo_resolvido boolean;
  v_vencido numeric;
  v_titulos integer;
  v_mais_antigo date;
  v_pares jsonb;
  v_excecao_id uuid;
BEGIN
  -- Corte em data civil de São Paulo (não UTC da sessão).
  v_corte := ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 60);

  SELECT EXISTS (SELECT 1 FROM public.credito_grupo_pares(p_customer_user_id))
    INTO v_grupo_resolvido;

  -- Escopo = par do pedido ∪ pares do grupo (UNION deduplica → título conta 1 vez).
  -- Vocabulário de status espelha OPEN_TITLE_STATUSES (src/lib/financeiro/titulo-status.ts).
  WITH escopo AS (
    SELECT p_company AS company, p_codigo AS codigo
     WHERE p_company IS NOT NULL AND p_codigo IS NOT NULL AND p_codigo > 0
    UNION
    SELECT g.company, g.omie_codigo_cliente
      FROM public.credito_grupo_pares(p_customer_user_id) g
  ),
  por_par AS (
    SELECT e.company, e.codigo,
           sum(f.saldo) AS vencido, count(*) AS titulos, min(f.data_vencimento) AS mais_antigo
      FROM escopo e
      JOIN public.fin_contas_receber f
        ON f.company = e.company AND f.omie_codigo_cliente = e.codigo
     WHERE f.status_titulo IN ('A VENCER', 'ATRASADO', 'VENCE HOJE', 'ABERTO', 'VENCIDO', 'PARCIAL')
       AND f.saldo > 0
       AND f.data_vencimento < v_corte
     GROUP BY e.company, e.codigo
  )
  SELECT (SELECT count(*) FROM escopo),
         COALESCE(sum(pp.vencido), 0),
         COALESCE(sum(pp.titulos), 0)::integer,
         min(pp.mais_antigo),
         COALESCE(
           jsonb_agg(jsonb_build_object('company', pp.company, 'codigo', pp.codigo,
                                        'vencido', pp.vencido, 'titulos', pp.titulos,
                                        'vencimento_mais_antigo', pp.mais_antigo)
                     ORDER BY pp.company, pp.codigo),
           '[]'::jsonb)
    INTO v_n_escopo, v_vencido, v_titulos, v_mais_antigo, v_pares
    FROM por_par pp;

  -- Sem nenhum par avaliável não há evidência possível → não bloqueia (precisão > recall).
  -- A edge decide o que fazer com 'sem_codigo' (na edição com aumento provado, segura).
  IF v_n_escopo = 0 THEN
    RETURN jsonb_build_object('bloqueado', false, 'vencido', null, 'titulos', 0,
                              'vencimento_mais_antigo', null, 'excecao_id', null,
                              'pares', '[]'::jsonb, 'grupo_resolvido', v_grupo_resolvido,
                              'motivo', 'sem_codigo');
  END IF;

  IF v_vencido <= 0 THEN
    RETURN jsonb_build_object('bloqueado', false, 'vencido', 0, 'titulos', 0,
                              'vencimento_mais_antigo', null, 'excecao_id', null,
                              'pares', '[]'::jsonb, 'grupo_resolvido', v_grupo_resolvido,
                              'motivo', 'sem_vencido_60d');
  END IF;

  -- Exceção aprovada PARA ESTE PEDIDO **E O PAR DO PEDIDO**, dentro da validade
  -- (mesma regra de venda_gate_credito; o gestor aprova vendo a dívida do grupo — ver UI).
  IF p_company IS NOT NULL AND p_codigo IS NOT NULL THEN
    SELECT x.id INTO v_excecao_id
      FROM public.venda_excecao_credito x
     WHERE x.sales_order_id = p_sales_order_id
       AND x.company = p_company
       AND x.omie_codigo_cliente = p_codigo
       AND x.valido_ate > now()
     ORDER BY x.created_at DESC
     LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'bloqueado', v_excecao_id IS NULL,
    'vencido', v_vencido,
    'titulos', v_titulos,
    'vencimento_mais_antigo', v_mais_antigo,
    'excecao_id', v_excecao_id,
    'pares', v_pares,
    'grupo_resolvido', v_grupo_resolvido,
    'motivo', CASE WHEN v_excecao_id IS NULL THEN 'vencido_60d_sem_excecao' ELSE 'excecao_valida' END
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.venda_gate_credito_grupo(uuid, text, bigint, uuid) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.venda_gate_credito_grupo(uuid, text, bigint, uuid) TO service_role;
