-- PCP Fase 1B — M1: núcleo de execução event-sourced (OP + apontamento offline-safe).
-- Plano: docs/superpowers/plans/2026-07-05-pcp-fase1b-m1-execucao.md (v2 — painel tri-modelo, correções C1–C7).
-- Aplicar no SQL Editor do Lovable (founder). NUNCA em supabase/migrations/. Re-colar é esperado (idempotável).
BEGIN;

-- ── 1) Catálogo de etapas do roteiro (por família). Tempos NASCEM NULL (ausente ≠ zero; §Camada 0.4). ──
CREATE TABLE IF NOT EXISTS public.pcp_etapas_catalogo (
  familia    text NOT NULL,                                   -- 'cinta' (1B: cintas-first)
  etapa      text NOT NULL,                                   -- corte_rolo|guilhotina|esmeril|prensa|corte_multiplo
  ordem      int  NOT NULL,
  centro     text NOT NULL CHECK (centro IN ('slitter','pool_final')),
  bloqueante boolean NOT NULL DEFAULT false,                  -- recurso crítico (prensa) — endurecimento #3
  tempo_padrao_seg numeric,                                   -- NULL = desconhecido; nasce do apontamento
  PRIMARY KEY (familia, etapa)
);
INSERT INTO public.pcp_etapas_catalogo (familia, etapa, ordem, centro, bloqueante) VALUES
  ('cinta','corte_rolo',     1, 'slitter',    false),
  ('cinta','guilhotina',     2, 'pool_final', false),
  ('cinta','esmeril',        3, 'pool_final', false),
  ('cinta','prensa',         4, 'pool_final', true),          -- prensa quebrada bloqueia promessa (Fase 3)
  ('cinta','corte_multiplo', 5, 'pool_final', false)
ON CONFLICT (familia, etapa) DO NOTHING;

-- ── 2) Log append-only de execução. id = client_event_id do device (idempotência D2/C5). ──
-- C4: device_seq = contador monotônico por device; desempata client_ts (adulterável no chão de fábrica).
CREATE TABLE IF NOT EXISTS public.pcp_eventos_producao (
  id         uuid PRIMARY KEY,                                -- crypto.randomUUID() no toque
  op_id      uuid NOT NULL REFERENCES public.production_orders(id),
  tipo       text NOT NULL CHECK (tipo IN ('iniciar_op','pausar','retomar','finalizar_op','refugo','consumo_mp')),
  motivo     text CHECK (motivo IN ('producao','erro_formula','teste','ajuste')),
  etapa      text,                                            -- opcional (futuro: apontamento por etapa)
  componente_codigo bigint,                                   -- consumo_mp/refugo: qual insumo
  quantidade numeric,                                         -- refugo/consumo: qtd ABSOLUTA
  unidade    text,
  nota       text,
  device_id  text NOT NULL,                                   -- escopo do client_event_id (C4)
  device_seq bigint NOT NULL,                                 -- monotônico por device (C4)
  account    text NOT NULL DEFAULT 'colacor',
  criado_por uuid,                                            -- auth.uid() server-side (anti-spoof)
  client_ts  timestamptz NOT NULL,                            -- quando ocorreu no device (ordena a FSM)
  server_ts  timestamptz NOT NULL DEFAULT now()               -- quando chegou (detecta late-arrival — C4)
);
CREATE INDEX IF NOT EXISTS idx_pcp_eventos_op ON public.pcp_eventos_producao (op_id, client_ts, device_seq, server_ts);

-- ── 3) production_orders EVOLUI (D3): colunas nullable EXCLUSIVAS da projeção. ──
-- C2 (1-writer): a projeção escreve SÓ estado_projetado + iniciada_em. NUNCA completed_at/status
-- (donos: a edge omie-vendas-sync — index.ts finalizar_ordem_producao). Evita 2-writers no money-path.
ALTER TABLE public.production_orders
  ADD COLUMN IF NOT EXISTS origem           text,
  ADD COLUMN IF NOT EXISTS prioridade       int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS roteiro_familia  text,
  ADD COLUMN IF NOT EXISTS iniciada_em      timestamptz,
  ADD COLUMN IF NOT EXISTS estado_projetado text;
DO $$ BEGIN
  ALTER TABLE public.production_orders
    ADD CONSTRAINT pcp_po_origem_chk CHECK (origem IS NULL OR origem IN ('pedido_venda','sugestao_mts_rolo','sugestao_mts','manual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 4) Projeção + FSM. A verdade do estado é DERIVADA dos eventos (append-only). ──
-- C1: advisory lock por OP (serializa projeções concorrentes → sem estado defasado).
-- C7: transição inválida NÃO avança o estado, só marca sufixo _anomalo (auditável).
-- C4: evento stock-impacting cujo server_ts é POSTERIOR a um finalizar já concluído = late_arrival (anomalia),
--     mesmo que o client_ts (adulterável) o reordene antes do fecho.
CREATE OR REPLACE FUNCTION public.fn_pcp_projetar_op(p_op_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  ev record;
  estado text := 'aguardando';
  anomalia boolean := false;
  t_inicio timestamptz;
  concluida_server_ts timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_op_id::text, 0));   -- C1
  FOR ev IN
    SELECT tipo, client_ts, server_ts FROM pcp_eventos_producao
    WHERE op_id = p_op_id
    ORDER BY client_ts, device_seq, server_ts,
      array_position(ARRAY['iniciar_op','retomar','pausar','refugo','consumo_mp','finalizar_op'], tipo)
  LOOP
    CASE ev.tipo
      WHEN 'iniciar_op' THEN
        IF estado = 'aguardando' THEN estado := 'em_producao'; t_inicio := ev.client_ts;
        ELSE anomalia := true; END IF;                                 -- iniciar duplo
      WHEN 'pausar' THEN
        IF estado = 'em_producao' THEN estado := 'pausada'; ELSE anomalia := true; END IF;
      WHEN 'retomar' THEN
        IF estado = 'pausada' THEN estado := 'em_producao'; ELSE anomalia := true; END IF;
      WHEN 'finalizar_op' THEN
        IF estado IN ('em_producao','pausada') THEN estado := 'concluida'; concluida_server_ts := ev.server_ts;
        ELSE anomalia := true; END IF;                                 -- finalizar sem iniciar / duplo (não avança)
      WHEN 'refugo' THEN
        IF estado NOT IN ('em_producao','pausada') THEN anomalia := true; END IF;
      WHEN 'consumo_mp' THEN                                           -- C6: só faz sentido em produção
        IF estado NOT IN ('em_producao','pausada') THEN anomalia := true; END IF;
    END CASE;
  END LOOP;

  -- C4: late-arrival — evento stock-impacting cujo server_ts (chegada REAL) é posterior ao fecho.
  -- Passagem separada da FSM: a ordenação por client_ts (adulterável) reordena o evento para antes do
  -- fecho, mas a ordem de chegada denuncia. Independe de onde o client_ts o colocou no loop.
  IF concluida_server_ts IS NOT NULL AND EXISTS (
    SELECT 1 FROM pcp_eventos_producao
    WHERE op_id = p_op_id AND tipo IN ('consumo_mp','refugo') AND server_ts > concluida_server_ts
  ) THEN anomalia := true; END IF;

  UPDATE public.production_orders                                      -- C2: só colunas próprias
     SET estado_projetado = CASE WHEN anomalia THEN estado || '_anomalo' ELSE estado END,
         iniciada_em = t_inicio
   WHERE id = p_op_id;
  RETURN CASE WHEN anomalia THEN estado || '_anomalo' ELSE estado END;
END $$;

-- ── 5) RPC base: registra evento (idempotente C5, gate fail-closed C3, invariantes C6). ──
CREATE OR REPLACE FUNCTION public.fn_pcp_registrar_evento(
  p_event_id uuid, p_op_id uuid, p_tipo text, p_device_id text, p_device_seq bigint, p_client_ts timestamptz,
  p_motivo text DEFAULT NULL, p_componente bigint DEFAULT NULL, p_quantidade numeric DEFAULT NULL,
  p_unidade text DEFAULT NULL, p_etapa text DEFAULT NULL, p_nota text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_exist record;
  v_rows int := 0;
BEGIN
  -- C3: fail-closed. Sem JWT (uid NULL) OU não-staff ⇒ barra. REVOKE de PUBLIC (abaixo) impede anon alcançar.
  IF v_uid IS NULL
     OR NOT (has_role(v_uid,'master'::app_role) OR has_role(v_uid,'employee'::app_role)) THEN
    RAISE EXCEPTION 'fn_pcp_registrar_evento: apenas staff';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM production_orders WHERE id = p_op_id) THEN
    RAISE EXCEPTION 'OP % inexistente', p_op_id;
  END IF;
  -- C6: invariantes de eventos stock-impacting (money-path — baixa de estoque/yield).
  IF p_tipo = 'consumo_mp' THEN
    IF p_motivo IS NULL THEN RAISE EXCEPTION 'consumo_mp exige motivo'; END IF;
    IF p_componente IS NULL OR p_quantidade IS NULL OR p_quantidade <= 0 OR p_unidade IS NULL THEN
      RAISE EXCEPTION 'consumo_mp exige componente_codigo, quantidade>0 e unidade';
    END IF;
  END IF;
  IF p_tipo = 'refugo' AND (p_quantidade IS NULL OR p_quantidade <= 0) THEN
    RAISE EXCEPTION 'refugo exige quantidade>0';
  END IF;
  -- C5: idempotência atômica + validação de payload. Replay idêntico = no-op; reuse divergente = erro.
  INSERT INTO pcp_eventos_producao (id, op_id, tipo, motivo, etapa, componente_codigo,
    quantidade, unidade, nota, device_id, device_seq, criado_por, client_ts)
  VALUES (p_event_id, p_op_id, p_tipo, p_motivo, p_etapa, p_componente,
    p_quantidade, p_unidade, p_nota, p_device_id, p_device_seq, v_uid, p_client_ts)
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN                                                   -- já existia: valida payload imutável
    SELECT op_id, tipo, componente_codigo, quantidade INTO v_exist
      FROM pcp_eventos_producao WHERE id = p_event_id;
    IF v_exist.op_id IS DISTINCT FROM p_op_id OR v_exist.tipo IS DISTINCT FROM p_tipo
       OR v_exist.componente_codigo IS DISTINCT FROM p_componente
       OR v_exist.quantidade IS DISTINCT FROM p_quantidade THEN
      RAISE EXCEPTION 'idempotency_key_reuse: event_id % reusado com payload diferente', p_event_id;
    END IF;
  END IF;
  RETURN fn_pcp_projetar_op(p_op_id);                                  -- D1: projeção deriva o estado
END $$;

-- ── 6) Wrappers de conveniência (o app chama estes para iniciar/finalizar). ──
CREATE OR REPLACE FUNCTION public.fn_pcp_iniciar_apontamento(
  p_event_id uuid, p_op_id uuid, p_device_id text, p_device_seq bigint, p_client_ts timestamptz)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.fn_pcp_registrar_evento(p_event_id, p_op_id, 'iniciar_op', p_device_id, p_device_seq, p_client_ts);
$$;
CREATE OR REPLACE FUNCTION public.fn_pcp_finalizar_apontamento(
  p_event_id uuid, p_op_id uuid, p_device_id text, p_device_seq bigint, p_client_ts timestamptz)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.fn_pcp_registrar_evento(p_event_id, p_op_id, 'finalizar_op', p_device_id, p_device_seq, p_client_ts);
$$;

-- ── 7) RLS + grants. Escrita só via RPC; append-only de fato; superfície das funções fechada (C3). ──
ALTER TABLE public.pcp_etapas_catalogo  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pcp_eventos_producao ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pcp_etapas_sel ON public.pcp_etapas_catalogo;
CREATE POLICY pcp_etapas_sel ON public.pcp_etapas_catalogo FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role));
DROP POLICY IF EXISTS pcp_eventos_sel ON public.pcp_eventos_producao;
CREATE POLICY pcp_eventos_sel ON public.pcp_eventos_producao FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role));
-- REVOKE por NOME (REVOKE FROM PUBLIC não tira anon/authenticated — armadilha CLAUDE.md).
REVOKE ALL ON public.pcp_etapas_catalogo, public.pcp_eventos_producao FROM anon, authenticated;
GRANT SELECT ON public.pcp_etapas_catalogo, public.pcp_eventos_producao TO authenticated;
-- Sem GRANT de INSERT/UPDATE/DELETE p/ authenticated ⇒ append-only real (escrita só pela RPC SECURITY DEFINER).

-- C3: fecha o EXECUTE default de PUBLIC nas funções e concede só o necessário.
REVOKE ALL ON FUNCTION public.fn_pcp_projetar_op(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_pcp_registrar_evento(uuid,uuid,text,text,bigint,timestamptz,text,bigint,numeric,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_pcp_iniciar_apontamento(uuid,uuid,text,bigint,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_pcp_finalizar_apontamento(uuid,uuid,text,bigint,timestamptz) FROM PUBLIC, anon, authenticated;
-- fn_pcp_projetar_op fica SEM grant: é interna (chamada pelas RPCs SECURITY DEFINER, que rodam como owner).
GRANT EXECUTE ON FUNCTION public.fn_pcp_registrar_evento(uuid,uuid,text,text,bigint,timestamptz,text,bigint,numeric,text,text,text),
  public.fn_pcp_iniciar_apontamento(uuid,uuid,text,bigint,timestamptz),
  public.fn_pcp_finalizar_apontamento(uuid,uuid,text,bigint,timestamptz) TO authenticated;

COMMIT;
