-- ============================================================
-- Trava de crédito — piso (vencido > 60 d) sobre o GRUPO inteiro.
-- Spec: docs/superpowers/specs/2026-11-20-credito-ia-design.md §9.3 (P1 Codex 2026-11-20).
-- Plano: docs/superpowers/plans/2026-11-20-credito-ia.md — PR 1, Task 1.
--
-- Furo fechado: venda_gate_credito olhava só o PAR do pedido (company, código).
-- Medido em prod (psql-ro, 2026-11-20): em 90 d, 93 pedidos (26 clientes,
-- R$ 143.507) saíram numa conta do grupo para cliente com vencido > 60 d em OUTRA.
--
-- Grupo = a RAIZ é o dono do PAR comprovado do pedido (omie_customer_account_map por
-- (account, código) — o código vem da derivação por DOCUMENTO na edge), NUNCA o UUID gravado
-- no pedido (sales_orders.customer_user_id pode ser o do VENDEDOR — P1 review Codex 2026-11-20).
-- Da raiz: canônico + aliases fiscais 'active' (customer_canonical_alias) → seus pares no mapa.
-- 'inactive'/'conflict' NÃO expandem (precisão > recall); o par do pedido sempre entra.
-- Titularidade medida (psql-ro 2026-11-20): 1.633/1.633 aliases active têm o MESMO documento
-- do profile do canônico; nenhum alias tem par próprio no mapa nem título fora dele.
-- Exceção ANTERIOR a esta virada (aprovada vendo só o par) NÃO cobre dívida de OUTRA empresa.
--
-- venda_gate_credito(text,bigint,uuid) fica INTACTA: rollback = a edge volta a chamá-la.
-- Prova PG17: db/test-trava-credito-piso-grupo.sh (asserts + falsificação).
-- ============================================================

-- Marco da virada: exceções criadas ANTES dele foram aprovadas vendo só a dívida do PAR.
-- 1 linha, gravada quando a migration é aplicada (idempotente: re-aplicar não move o marco).
CREATE TABLE IF NOT EXISTS public.credito_virada_grupo (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  aplicada_em timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.credito_virada_grupo ENABLE ROW LEVEL SECURITY;
-- sem policy: só as funções SECURITY DEFINER leem.
INSERT INTO public.credito_virada_grupo (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

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
  p_codigo bigint
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
  v_excecao_criada timestamptz;
  v_vencido_outros numeric;
  v_virada timestamptz;
BEGIN
  -- Corte em data civil de São Paulo (não UTC da sessão).
  v_corte := ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 60);

  -- Sem par comprovado não há raiz → nada a avaliar (a edge segura a EDIÇÃO nesse caso).
  IF p_company IS NULL OR p_codigo IS NULL OR p_codigo <= 0 THEN
    RETURN jsonb_build_object('bloqueado', false, 'vencido', null, 'titulos', 0,
                              'vencimento_mais_antigo', null, 'excecao_id', null,
                              'pares', '[]'::jsonb, 'grupo_resolvido', false,
                              'motivo', 'sem_codigo');
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.omie_customer_account_map m
                  WHERE m.account = p_company AND m.omie_codigo_cliente = p_codigo)
    INTO v_grupo_resolvido;

  -- Escopo = par do pedido ∪ pares do grupo de CADA dono do par (UNION deduplica → título conta 1 vez).
  -- Vocabulário de status espelha OPEN_TITLE_STATUSES (src/lib/financeiro/titulo-status.ts).
  WITH raizes AS (
    SELECT DISTINCT m.user_id
      FROM public.omie_customer_account_map m
     WHERE m.account = p_company AND m.omie_codigo_cliente = p_codigo
  ),
  escopo AS (
    SELECT p_company AS company, p_codigo AS codigo
    UNION
    SELECT g.company, g.omie_codigo_cliente
      FROM raizes r, LATERAL public.credito_grupo_pares(r.user_id) g
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

  IF v_vencido <= 0 THEN
    RETURN jsonb_build_object('bloqueado', false, 'vencido', 0, 'titulos', 0,
                              'vencimento_mais_antigo', null, 'excecao_id', null,
                              'pares', '[]'::jsonb, 'grupo_resolvido', v_grupo_resolvido,
                              'motivo', 'sem_vencido_60d');
  END IF;

  -- Exceção aprovada PARA ESTE PEDIDO **E O PAR DO PEDIDO**, dentro da validade
  -- (mesma regra de venda_gate_credito; o gestor aprova vendo a dívida do grupo — ver UI).
  SELECT x.id, x.created_at INTO v_excecao_id, v_excecao_criada
    FROM public.venda_excecao_credito x
   WHERE x.sales_order_id = p_sales_order_id
     AND x.company = p_company
     AND x.omie_codigo_cliente = p_codigo
     AND x.valido_ate > now()
   ORDER BY x.created_at DESC
   LIMIT 1;

  -- Exceção antiga + dívida em OUTRO par → não cobre (o gestor não viu essa dívida).
  SELECT COALESCE(sum((e->>'vencido')::numeric), 0) INTO v_vencido_outros
    FROM jsonb_array_elements(v_pares) e
   WHERE NOT (e->>'company' = p_company AND (e->>'codigo')::bigint = p_codigo);
  SELECT aplicada_em INTO v_virada FROM public.credito_virada_grupo;
  -- Sem marco (linha apagada) → trata TODA exceção como antiga (lado seguro: não cobre o grupo).
  IF v_excecao_id IS NOT NULL AND (v_virada IS NULL OR v_excecao_criada < v_virada) AND v_vencido_outros > 0 THEN
    RETURN jsonb_build_object(
      'bloqueado', true, 'vencido', v_vencido, 'titulos', v_titulos,
      'vencimento_mais_antigo', v_mais_antigo, 'excecao_id', null,
      'pares', v_pares, 'grupo_resolvido', v_grupo_resolvido,
      'motivo', 'excecao_anterior_nao_cobre_grupo');
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

REVOKE EXECUTE ON FUNCTION public.venda_gate_credito_grupo(uuid, text, bigint) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.venda_gate_credito_grupo(uuid, text, bigint) TO service_role;
