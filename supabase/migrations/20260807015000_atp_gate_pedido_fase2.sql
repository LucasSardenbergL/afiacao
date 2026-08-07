-- ============================================================
-- ATP/reserva de estoque — FASE 2: gate na fronteira do PV [money-path]
-- Programa Cabreúva Pista B (docs/historico/programa-cabreuva-colacor.md)
-- Depende da fase 1 (20260806101417_atp_reserva_estoque_fase1.sql) APLICADA.
--
-- Desenho (parecer Codex 2026-08-06, challenge xhigh — E2):
--  • A GARANTIA mora no edge omie-vendas-sync (fronteira comum das criações
--    do app), que chama esta RPC como service_role ANTES da mutação Omie.
--    O gate DERIVA os itens da linha sales_orders (nunca confia no payload
--    do browser) e o override de backorder é validado e auditado AQUI.
--  • atp_decisoes é APPEND-ONLY (service_role só ganha SELECT+INSERT — a
--    trilha de bloqueio/override não é editável nem apagável por caller).
--  • Backorder: só com ator humano (p_actor NOT NULL — cron não autoriza),
--    motivo textual obrigatório, e SÓ se existe bloqueio prévio do MESMO
--    pedido com o MESMO fingerprint de itens (edição invalida a autorização).
--    A autorização re-tenta a reserva primeiro: se o saldo voltou, o pedido
--    sai RESERVADO (backorder nunca substitui reserva possível).
--  • Linha com omie_pedido_id → 'ja_enviado' SEM re-reservar (retry de PV
--    criado não renova TTL nem re-desconta — achado Codex).
--  • p_enforcement=false (caller sem capability atp_capaz, ex. bundle antigo)
--    → modo ADVISORY: reserva/registra normalmente, mas recusa NÃO bloqueia
--    (evita que caller antigo leia blocked desconhecido como sucesso).
--  • Recusa de negócio via jsonb; contrato/deriva → 22023; autorização → 42501
--    (nenhum dos dois é elegível a override — classes distintas de escape).
--  • Vínculo estoque_reservas.sales_order_id nasce AQUI, na MESMA transação
--    da reserva (adiar criaria backfill/ambiguidade — achado Codex).
--  • Linha sem checkout_id (conversão de orçamento, cron): a chave de reserva
--    é o PRÓPRIO sales_order_id (uuid sintético, idempotência por pedido).
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1) Trilha append-only de decisões ATP (bloqueios, overrides, advisory)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.atp_decisoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SET NULL: o hard-delete de sales_orders (excluir_pedido) não apaga a trilha
  sales_order_id uuid REFERENCES public.sales_orders(id) ON DELETE SET NULL,
  -- chave usada na reserva (checkout real ou sales_order_id sintético)
  checkout_id uuid NOT NULL,
  pool text NOT NULL CONSTRAINT atp_decisoes_pool_check CHECK (pool = 'oben'),
  account text NOT NULL,
  decisao text NOT NULL CONSTRAINT atp_decisoes_decisao_check
    CHECK (decisao IN ('reservado', 'bloqueado', 'backorder_autorizado', 'verificacao_indisponivel')),
  contexto text NOT NULL DEFAULT 'criacao' CONSTRAINT atp_decisoes_contexto_check
    CHECK (contexto IN ('criacao', 'edicao')),
  -- true = o caller declarou capability (bloqueio real); false = advisory (só registra)
  enforcement boolean NOT NULL,
  -- snapshot das recusas da RPC no momento da decisão (NULL quando 'reservado')
  recusas jsonb,
  -- disponibilidade/frescor por SKU no instante da decisão (reconstrução pós-fato)
  atp_snapshot jsonb,
  -- hash canônico dos itens Oben (sku:qtd ordenado) — amarra override ao carrinho.
  -- NULL só em 'verificacao_indisponivel' (evento best-effort gravado pelo EDGE
  -- quando a RPC falhou — não houve derivação de itens); a RPC sempre preenche.
  itens_fingerprint text,
  motivo_backorder text,
  -- staff que decidiu (JWT do edge); NULL = cron/sistema (que NUNCA autoriza backorder)
  actor_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_atp_decisoes_pedido
  ON public.atp_decisoes (sales_order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_atp_decisoes_created
  ON public.atp_decisoes (created_at DESC);

ALTER TABLE public.atp_decisoes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "atp_decisoes_select_staff" ON public.atp_decisoes;
CREATE POLICY "atp_decisoes_select_staff"
  ON public.atp_decisoes
  FOR SELECT
  USING ((SELECT private.cap_estoque_reservar((SELECT auth.uid()))));

-- APPEND-ONLY por privilégio: nem service_role fica com UPDATE/DELETE/TRUNCATE.
-- ⚠️ O REVOKE de service_role é OBRIGATÓRIO: o Supabase tem DEFAULT PRIVILEGES
-- que dão ALL (arwdDxtm) a anon/authenticated/service_role em TODA tabela nova
-- do schema public (conferido em pg_default_acl na PROD, 2026-08-06) — sem o
-- REVOKE explícito o GRANT mínimo abaixo não remove nada e a trilha vira editável.
REVOKE ALL ON TABLE public.atp_decisoes FROM PUBLIC;
REVOKE ALL ON TABLE public.atp_decisoes FROM anon;
REVOKE ALL ON TABLE public.atp_decisoes FROM authenticated;
REVOKE ALL ON TABLE public.atp_decisoes FROM service_role;
GRANT SELECT ON TABLE public.atp_decisoes TO authenticated;
GRANT SELECT, INSERT ON TABLE public.atp_decisoes TO service_role;

-- ────────────────────────────────────────────────────────────
-- 2) Gate do pedido (chamado SÓ pelo edge, service_role)
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.atp_gate_pedido(
  p_sales_order_id uuid,
  p_enforcement boolean,
  p_actor uuid DEFAULT NULL,
  p_autorizar_backorder boolean DEFAULT false,
  p_motivo_backorder text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row record;
  v_itens jsonb;
  v_invalidos integer;
  v_fp text;
  v_checkout uuid;
  v_res jsonb;
  v_bloqueio record;
  v_snapshot jsonb;
  v_sku bigint;
BEGIN
  -- Defesa em profundidade: o EXECUTE já é service_role-only; o gate interno
  -- da reserva (cap_estoque_reservar) revalida na chamada aninhada.
  IF p_sales_order_id IS NULL THEN
    RAISE EXCEPTION 'p_sales_order_id é obrigatório' USING ERRCODE = '22023';
  END IF;
  IF p_enforcement IS NULL THEN
    RAISE EXCEPTION 'p_enforcement é obrigatório (true=bloqueia, false=advisory)' USING ERRCODE = '22023';
  END IF;

  SELECT so.id, so.account, so.checkout_id, so.items, so.omie_pedido_id
    INTO v_row
  FROM public.sales_orders so
  WHERE so.id = p_sales_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'sales_order % não existe', p_sales_order_id USING ERRCODE = '22023';
  END IF;

  -- Pool fase 2 = 'oben'. Linha de outra conta não passa por reserva (defesa
  -- em profundidade — o edge só chama para oben).
  IF v_row.account IS DISTINCT FROM 'oben' THEN
    RETURN jsonb_build_object('ok', true, 'resultado', 'fora_do_pool', 'account', v_row.account);
  END IF;

  -- PV já criado no Omie: NUNCA re-reservar (retry idempotente não renova TTL).
  IF v_row.omie_pedido_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'resultado', 'ja_enviado');
  END IF;

  -- Deriva itens DO BANCO (nunca do payload): agrega por SKU (a reserva recusa
  -- duplicata) e valida fail-closed — item ilegível é bug de dado, sem override.
  IF v_row.items IS NULL OR jsonb_typeof(v_row.items) <> 'array' OR jsonb_array_length(v_row.items) = 0 THEN
    RAISE EXCEPTION 'sales_order % (oben) sem items legíveis para o gate ATP', p_sales_order_id
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*) FILTER (WHERE x.omie_codigo_produto IS NULL OR x.omie_codigo_produto <= 0
                             OR x.quantidade IS NULL OR x.quantidade <= 0)
    INTO v_invalidos
  FROM jsonb_to_recordset(v_row.items) AS x(omie_codigo_produto bigint, quantidade numeric);

  IF v_invalidos > 0 THEN
    RAISE EXCEPTION 'sales_order % contém item sem omie_codigo_produto/quantidade válidos', p_sales_order_id
      USING ERRCODE = '22023';
  END IF;

  SELECT jsonb_agg(jsonb_build_object('omie_codigo_produto', t.sku, 'quantidade', t.qtd)),
         md5(string_agg(t.sku::text || ':' || trim_scale(t.qtd)::text, '|' ORDER BY t.sku))
    INTO v_itens, v_fp
  FROM (
    SELECT x.omie_codigo_produto AS sku, sum(x.quantidade) AS qtd
    FROM jsonb_to_recordset(v_row.items) AS x(omie_codigo_produto bigint, quantidade numeric)
    GROUP BY x.omie_codigo_produto
  ) t;

  v_checkout := COALESCE(v_row.checkout_id, p_sales_order_id);

  -- Pré-condições do override ANTES de reservar (falha de autorização não é backorder)
  IF p_autorizar_backorder THEN
    IF p_actor IS NULL THEN
      RAISE EXCEPTION 'backorder exige um ator humano (cron/sistema não autoriza)' USING ERRCODE = '42501';
    END IF;
    IF p_motivo_backorder IS NULL OR btrim(p_motivo_backorder) = '' THEN
      RAISE EXCEPTION 'backorder exige motivo textual' USING ERRCODE = '22023';
    END IF;
    SELECT d.itens_fingerprint INTO v_bloqueio
    FROM public.atp_decisoes d
    WHERE d.sales_order_id = p_sales_order_id AND d.decisao = 'bloqueado'
    ORDER BY d.created_at DESC
    LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'backorder sem bloqueio ATP prévio deste pedido' USING ERRCODE = '42501';
    END IF;
    IF v_bloqueio.itens_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'os itens mudaram desde o bloqueio ATP — reenvie para reavaliar' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Reserva SEMPRE tentada primeiro (mesmo com backorder autorizado: se o saldo
  -- voltou, reservar vence). TTL fica no default da RPC (política mora no banco).
  v_res := public.reservar_estoque('oben', v_checkout, v_itens);

  IF (v_res->>'ok')::boolean THEN
    -- Vínculo reserva↔pedido na MESMA transação (fase 3 reconcilia por ele)
    UPDATE public.estoque_reservas
       SET sales_order_id = p_sales_order_id,
           atualizado_em = now()
     WHERE checkout_id = v_checkout
       AND pool = 'oben'
       AND status = 'ativa';

    INSERT INTO public.atp_decisoes
      (sales_order_id, checkout_id, pool, account, decisao, contexto, enforcement,
       recusas, atp_snapshot, itens_fingerprint, motivo_backorder, actor_user_id)
    VALUES
      (p_sales_order_id, v_checkout, 'oben', v_row.account, 'reservado', 'criacao', p_enforcement,
       NULL, NULL, v_fp, NULL, p_actor);

    RETURN jsonb_build_object('ok', true, 'resultado', 'reservado', 'reservas', v_res->'reservas');
  END IF;

  -- Recusa: snapshot de disponibilidade/frescor por SKU (reconstrução pós-fato)
  SELECT jsonb_object_agg(t.sku::text, jsonb_build_object(
           'disponivel', d.disponivel, 'confiavel', d.saldo_confiavel, 'saldo_synced_at', d.saldo_synced_at))
    INTO v_snapshot
  FROM (
    SELECT DISTINCT (e.item->>'omie_codigo_produto')::bigint AS sku
    FROM jsonb_array_elements(v_itens) AS e(item)
  ) t
  CROSS JOIN LATERAL private.atp_disponivel('oben', t.sku, v_checkout) AS d;

  IF p_autorizar_backorder THEN
    INSERT INTO public.atp_decisoes
      (sales_order_id, checkout_id, pool, account, decisao, contexto, enforcement,
       recusas, atp_snapshot, itens_fingerprint, motivo_backorder, actor_user_id)
    VALUES
      (p_sales_order_id, v_checkout, 'oben', v_row.account, 'backorder_autorizado', 'criacao', p_enforcement,
       v_res->'recusas', v_snapshot, v_fp, btrim(p_motivo_backorder), p_actor);

    RETURN jsonb_build_object('ok', true, 'resultado', 'backorder_autorizado', 'recusas', v_res->'recusas');
  END IF;

  INSERT INTO public.atp_decisoes
    (sales_order_id, checkout_id, pool, account, decisao, contexto, enforcement,
     recusas, atp_snapshot, itens_fingerprint, motivo_backorder, actor_user_id)
  VALUES
    (p_sales_order_id, v_checkout, 'oben', v_row.account, 'bloqueado', 'criacao', p_enforcement,
     v_res->'recusas', v_snapshot, v_fp, NULL, p_actor);

  IF p_enforcement THEN
    RETURN jsonb_build_object('ok', false, 'blocked', 'atp', 'resultado', 'bloqueado',
                              'recusas', v_res->'recusas');
  END IF;

  -- Advisory (caller sem capability): registra o que TERIA bloqueado, não bloqueia.
  RETURN jsonb_build_object('ok', true, 'resultado', 'advisory_bloqueado', 'bloquearia', true,
                            'recusas', v_res->'recusas');
END;
$function$;

REVOKE ALL ON FUNCTION public.atp_gate_pedido(uuid, boolean, uuid, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atp_gate_pedido(uuid, boolean, uuid, boolean, text) FROM anon;
REVOKE ALL ON FUNCTION public.atp_gate_pedido(uuid, boolean, uuid, boolean, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atp_gate_pedido(uuid, boolean, uuid, boolean, text) TO service_role;
