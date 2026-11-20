-- ============================================================
-- Lote mínimo Sayerlack — Fase 2a: e-mail ao CRS + cobrança [money-path]
-- Spec: docs/superpowers/specs/2026-11-18-sayerlack-lote-minimo-portal-design.md §Fase 2
--
-- Efeito IRREVERSÍVEL: um e-mail ao fornecedor (crs@sayerlack.com.br) pedindo a redução da qtde que o portal
-- forçou ao lote mínimo. Precisão > recall: 0 e-mail + alerta ao founder é melhor que 2 e-mails.
--
-- Desenho (Codex P0, 2026-11-20):
--  · O estado do e-mail é POR PEDIDO (1 e-mail por pedido, listando os itens): `pedido_portal_ajuste_email`.
--    O ledger por item (`pedido_portal_ajuste_qtde`, Fase 1) só ganha a transição pendente_email → email_enviado.
--  · Só o PRODUTOR NOVO autoriza o envio automático: a edge do portal chama `ajuste_lote_email_autorizar`
--    depois de gravar sucesso_portal com o ledger provado. Sem autorização (pedido em conciliação, sem protocolo,
--    edge antiga) o envio segue MANUAL e o varredor lembra o founder.
--  · Ordem: reservar (commit) → POST no Gmail (edge) → confirmar. Reserva só é liberada com prova de NÃO envio
--    (Gmail respondeu 4xx). Timeout/5xx/queda = indeterminado: alerta, nunca reenvio sozinho.
--  · Cobrança (1 dia útil, feriados do `calendario_feriados`, data local de São Paulo, a partir das 08:00):
--    1ª = resposta no MESMO thread + alerta; sem thread conhecido ou caixa sem cobertura = só alerta.
--    2ª = só alerta. Resposta da Sayerlack vista no `gmail_webhook_log` (assunto com [AFI-<id>] ou o protocolo)
--    suspende a cobrança e alerta o founder (a leitura do conteúdo é a Fase 2b).
--  · Linha manual: o e-mail do pedido 4557 (portal 2152582) foi enviado À MÃO em 2026-11-20 17:24 UTC — backfill
--    explícito com origem 'manual', nunca elegível ao envio automático.
--
-- Escrita só service_role (edge e cron); leitura staff. Idempotente: rodar 2× não falha nem duplica.
-- Sem envelope BEGIN/COMMIT: aplicada por `bun run db:aplicar` (o executor dá a transação).
-- ============================================================

-- ── 1. tabelas ────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pedido_portal_ajuste_email (
  pedido_id bigint PRIMARY KEY REFERENCES public.pedido_compra_sugerido(id) ON DELETE RESTRICT,
  empresa text NOT NULL,
  portal_protocolo text NOT NULL CHECK (portal_protocolo ~ '^[0-9]+$'),
  -- Conjunto CONGELADO na autorização (ids do ledger, ordenados). Item tardio ou sumido = bloqueia.
  ajuste_ids bigint[] NOT NULL CHECK (cardinality(ajuste_ids) >= 1),
  origem text NOT NULL CHECK (origem IN ('automatico', 'manual')),
  autorizado_em timestamptz NOT NULL DEFAULT now(),
  assunto text,
  -- envio inicial
  reserva_token uuid,
  reservado_em timestamptz,
  rfc_message_id_proposto text,
  tentativas integer NOT NULL DEFAULT 0,
  proxima_tentativa_em timestamptz,
  ultimo_erro text,
  indeterminado_em timestamptz,
  bloqueado_em timestamptz,
  bloqueio_motivo text,
  enviado_em timestamptz,
  gmail_message_id text,
  gmail_thread_id text,
  rfc_message_id_observado text,
  -- resposta vista no gmail_webhook_log (só a presença; o conteúdo é a Fase 2b)
  resposta_observada_em timestamptz,
  resposta_log_id bigint,
  -- 1ª cobrança
  cobranca1_token uuid,
  cobranca1_reservado_em timestamptz,
  cobranca1_rfc_message_id_proposto text,
  cobranca1_tentativas integer NOT NULL DEFAULT 0,
  cobranca1_proxima_tentativa_em timestamptz,
  cobranca1_ultimo_erro text,
  cobranca1_indeterminado_em timestamptz,
  cobranca1_enviada_em timestamptz,
  cobranca1_gmail_message_id text,
  cobranca1_alerta_em timestamptz,
  cobranca1_modo text CHECK (cobranca1_modo IN ('email', 'alerta')),
  -- 2ª cobrança = só alerta
  cobranca2_alerta_em timestamptz,
  CONSTRAINT ajuste_email_manual_ja_enviado CHECK (origem <> 'manual' OR enviado_em IS NOT NULL),
  CONSTRAINT ajuste_email_enviado_tem_ids CHECK (
    origem <> 'automatico' OR enviado_em IS NULL OR (gmail_message_id IS NOT NULL AND gmail_thread_id IS NOT NULL)),
  CONSTRAINT ajuste_email_cobranca_exige_envio CHECK (
    enviado_em IS NOT NULL OR (cobranca1_token IS NULL AND cobranca1_enviada_em IS NULL AND cobranca1_alerta_em IS NULL)),
  CONSTRAINT ajuste_email_cobranca_email_exige_thread CHECK (cobranca1_token IS NULL OR gmail_thread_id IS NOT NULL),
  CONSTRAINT ajuste_email_cobranca2_exige_1 CHECK (
    cobranca2_alerta_em IS NULL OR cobranca1_enviada_em IS NOT NULL OR cobranca1_alerta_em IS NOT NULL)
);

-- Dedupe de alerta: cada (pedido, etapa) alerta UMA vez, gravado na mesma transação do marcador.
CREATE TABLE IF NOT EXISTS public.pedido_portal_ajuste_email_alerta (
  pedido_id bigint NOT NULL,
  etapa text NOT NULL,
  alerta_id bigint,
  criado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pedido_id, etapa)
);

ALTER TABLE public.pedido_portal_ajuste_email ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedido_portal_ajuste_email_alerta ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pedido_portal_ajuste_email_select_staff" ON public.pedido_portal_ajuste_email;
CREATE POLICY "pedido_portal_ajuste_email_select_staff"
  ON public.pedido_portal_ajuste_email FOR SELECT TO authenticated
  USING (
    (SELECT public.has_role(auth.uid(), 'employee'::public.app_role))
    OR (SELECT public.has_role(auth.uid(), 'master'::public.app_role))
  );

REVOKE ALL ON public.pedido_portal_ajuste_email FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.pedido_portal_ajuste_email FROM authenticated;
GRANT SELECT ON public.pedido_portal_ajuste_email TO authenticated;
GRANT ALL ON public.pedido_portal_ajuste_email TO service_role;
REVOKE ALL ON public.pedido_portal_ajuste_email_alerta FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.pedido_portal_ajuste_email_alerta TO service_role;

-- ── 2. write-once: o que prova o efeito externo nunca é reescrito nem apagado ──────────────────────────────────
CREATE OR REPLACE FUNCTION private._ajuste_email_write_once()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $f$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pedido_portal_ajuste_email e trilha de e-mail ao fornecedor: DELETE proibido (pedido %)', OLD.pedido_id
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.pedido_id IS DISTINCT FROM OLD.pedido_id OR NEW.portal_protocolo IS DISTINCT FROM OLD.portal_protocolo
     OR NEW.ajuste_ids IS DISTINCT FROM OLD.ajuste_ids OR NEW.origem IS DISTINCT FROM OLD.origem
     OR (OLD.assunto IS NOT NULL AND NEW.assunto IS DISTINCT FROM OLD.assunto)
     OR (OLD.enviado_em IS NOT NULL AND NEW.enviado_em IS DISTINCT FROM OLD.enviado_em)
     OR (OLD.gmail_message_id IS NOT NULL AND NEW.gmail_message_id IS DISTINCT FROM OLD.gmail_message_id)
     OR (OLD.gmail_thread_id IS NOT NULL AND NEW.gmail_thread_id IS DISTINCT FROM OLD.gmail_thread_id)
     OR (OLD.rfc_message_id_observado IS NOT NULL AND NEW.rfc_message_id_observado IS DISTINCT FROM OLD.rfc_message_id_observado)
     OR (OLD.resposta_observada_em IS NOT NULL AND NEW.resposta_observada_em IS DISTINCT FROM OLD.resposta_observada_em)
     OR (OLD.cobranca1_enviada_em IS NOT NULL AND NEW.cobranca1_enviada_em IS DISTINCT FROM OLD.cobranca1_enviada_em)
     OR (OLD.cobranca1_gmail_message_id IS NOT NULL AND NEW.cobranca1_gmail_message_id IS DISTINCT FROM OLD.cobranca1_gmail_message_id)
     OR (OLD.cobranca1_alerta_em IS NOT NULL AND NEW.cobranca1_alerta_em IS DISTINCT FROM OLD.cobranca1_alerta_em)
     OR (OLD.cobranca2_alerta_em IS NOT NULL AND NEW.cobranca2_alerta_em IS DISTINCT FROM OLD.cobranca2_alerta_em) THEN
    RAISE EXCEPTION 'WRITE_ONCE pedido_portal_ajuste_email: campo write-once alterado (pedido %)', OLD.pedido_id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION private._ajuste_email_write_once() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_ajuste_email_write_once ON public.pedido_portal_ajuste_email;
CREATE TRIGGER trg_ajuste_email_write_once
  BEFORE UPDATE OR DELETE ON public.pedido_portal_ajuste_email
  FOR EACH ROW EXECUTE FUNCTION private._ajuste_email_write_once();

-- ── 3. helpers (private) ──────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private._ajuste_lote_dia_util(p_dia date)
RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp' AS $f$
  SELECT EXTRACT(ISODOW FROM p_dia) < 6
     AND NOT EXISTS (SELECT 1 FROM public.calendario_feriados f WHERE f.data = p_dia)
$f$;

-- Vencida = hoje (SP) é dia útil, já passou das 08:00 (SP) e hoje é DEPOIS do 1º dia útil ≥ a data local do
-- evento. Evento em feriado/fim de semana conta a partir do próximo dia útil. Independe do TimeZone da sessão.
CREATE OR REPLACE FUNCTION private._ajuste_lote_cobranca_vencida(p_inicio timestamptz, p_agora timestamptz)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path TO 'public', 'pg_temp' AS $f$
DECLARE
  v_ef date;
  v_local timestamp;
  i int := 0;
BEGIN
  IF p_inicio IS NULL OR p_agora IS NULL THEN RETURN false; END IF;
  v_ef := (p_inicio AT TIME ZONE 'America/Sao_Paulo')::date;
  WHILE NOT private._ajuste_lote_dia_util(v_ef) LOOP
    i := i + 1;
    IF i > 30 THEN RETURN false; END IF;  -- calendário corrompido: não cobra (o varredor de atraso alerta)
    v_ef := v_ef + 1;
  END LOOP;
  v_local := p_agora AT TIME ZONE 'America/Sao_Paulo';
  RETURN private._ajuste_lote_dia_util(v_local::date) AND v_local::date > v_ef AND v_local::time >= time '08:00';
END $f$;

-- Caixa coberta = o Apps Script entregou algo nas últimas 6h (às 08:05 SP chegam os avisos diários do sistema).
-- Sem cobertura não sabemos se o CRS respondeu → a cobrança vira só alerta (Codex P1-5: 24h deixava passar
-- "script parou às 09h, CRS respondeu às 17h, cobramos às 08h").
CREATE OR REPLACE FUNCTION private._ajuste_lote_caixa_coberta(p_agora timestamptz)
RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp' AS $f$
  SELECT EXISTS (SELECT 1 FROM public.gmail_webhook_log g
                 WHERE g.recebido_em > p_agora - interval '6 hours' AND g.recebido_em <= p_agora)
$f$;

-- 1ª mensagem da Sayerlack ESCRITA depois do envio (received_at = hora do e-mail; recebido_em = hora da ingestão,
-- só como reserva) cujo assunto cita o pedido ([AFI-<id>]) ou o protocolo como número inteiro (2152582 ≠ 21525820).
CREATE OR REPLACE FUNCTION private._ajuste_lote_resposta_log(p_pedido_id bigint, p_protocolo text, p_desde timestamptz,
                                                            p_agora timestamptz)
RETURNS bigint LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp' AS $f$
  SELECT g.id FROM public.gmail_webhook_log g
  WHERE coalesce(g.received_at, g.recebido_em) >= p_desde AND g.recebido_em <= p_agora
    AND lower(coalesce(g.remetente, '')) LIKE '%@sayerlack.com.br%'
    AND (strpos(coalesce(g.subject, ''), '[AFI-' || p_pedido_id || ']') > 0
         OR (p_protocolo ~ '^[0-9]+$' AND coalesce(g.subject, '') ~ ('(^|[^0-9])' || p_protocolo || '([^0-9]|$)')))
  ORDER BY g.recebido_em, g.id
  LIMIT 1
$f$;

-- Alerta ao founder deduplicado por (pedido, etapa): devolve o id do alerta, ou NULL se a etapa já alertou.
CREATE OR REPLACE FUNCTION private._ajuste_lote_alertar(p_pedido_id bigint, p_etapa text, p_severidade text,
                                                       p_titulo text, p_mensagem text)
RETURNS bigint LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $f$
DECLARE v_id bigint;
BEGIN
  INSERT INTO public.pedido_portal_ajuste_email_alerta (pedido_id, etapa) VALUES (p_pedido_id, p_etapa)
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO public.fornecedor_alerta (empresa, fornecedor_nome, tipo, severidade, titulo, mensagem, status, metadata)
  VALUES ('OBEN', 'RENNER SAYERLACK S/A', 'outro', p_severidade, p_titulo, p_mensagem, 'pendente_notificacao',
          jsonb_build_object('pedido_id', p_pedido_id, 'erro_tipo', 'LOTE_MINIMO_EMAIL_CRS', 'etapa', p_etapa))
  RETURNING id INTO v_id;
  UPDATE public.pedido_portal_ajuste_email_alerta SET alerta_id = v_id WHERE pedido_id = p_pedido_id AND etapa = p_etapa;
  RETURN v_id;
END $f$;

-- Pedido cancelado (no sistema ou no portal: situação 6) nunca recebe e-mail nem cobrança (Codex P1-3).
CREATE OR REPLACE FUNCTION private._ajuste_lote_pedido_cancelado(p_pedido_id bigint)
RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp' AS $f$
  SELECT EXISTS (SELECT 1 FROM public.pedido_compra_sugerido p
                 WHERE p.id = p_pedido_id
                   AND (p.status IN ('cancelado', 'cancelado_humano', 'expirado_sem_aprovacao')
                        OR p.portal_situacao_codigo = '6'
                        OR coalesce(p.portal_situacao_texto, '') ILIKE '%cancel%'))
$f$;

-- Cobrança ativa = pedido não cancelado e nenhum item DO E-MAIL (o conjunto congelado) saiu de email_enviado
-- (a Fase 2b marca aceito/recusado e isso para a cobrança). Item fora do conjunto não trava a cobrança (Codex P1-4).
CREATE OR REPLACE FUNCTION private._ajuste_lote_itens_aguardando(p_pedido_id bigint)
RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp' AS $f$
  SELECT NOT private._ajuste_lote_pedido_cancelado(p_pedido_id)
     AND NOT EXISTS (SELECT 1 FROM public.pedido_portal_ajuste_email e
                     JOIN public.pedido_portal_ajuste_qtde a ON a.id = ANY (e.ajuste_ids)
                     WHERE e.pedido_id = p_pedido_id AND a.status <> 'email_enviado')
$f$;

CREATE OR REPLACE FUNCTION private.ajuste_lote_email_ha_pendente(p_etapa text, p_agora timestamptz)
RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp' AS $f$
  SELECT CASE p_etapa
    WHEN 'inicial' THEN EXISTS (
      SELECT 1 FROM public.pedido_portal_ajuste_email e
      WHERE e.origem = 'automatico' AND e.enviado_em IS NULL AND e.reserva_token IS NULL
        AND e.indeterminado_em IS NULL AND e.bloqueado_em IS NULL
        AND (e.proxima_tentativa_em IS NULL OR e.proxima_tentativa_em <= p_agora))
    WHEN 'cobranca1' THEN EXISTS (
      SELECT 1 FROM public.pedido_portal_ajuste_email e
      WHERE e.origem = 'automatico' AND e.enviado_em IS NOT NULL AND e.gmail_thread_id IS NOT NULL
        AND e.resposta_observada_em IS NULL AND e.cobranca1_token IS NULL AND e.cobranca1_enviada_em IS NULL
        AND e.cobranca1_alerta_em IS NULL AND e.cobranca1_indeterminado_em IS NULL
        AND (e.cobranca1_proxima_tentativa_em IS NULL OR e.cobranca1_proxima_tentativa_em <= p_agora)
        AND private._ajuste_lote_cobranca_vencida(e.enviado_em, p_agora)
        AND private._ajuste_lote_itens_aguardando(e.pedido_id))
    ELSE false END
$f$;

-- ── 4. RPCs da edge (só service_role) ─────────────────────────────────────────────────────────────────────────

-- Chamada pela edge do portal DEPOIS de gravar sucesso_portal com o ledger provado. Confere tudo no banco.
CREATE OR REPLACE FUNCTION public.ajuste_lote_email_autorizar(p_pedido_id bigint, p_protocolo text, p_n_ajustes integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
DECLARE
  v_ped record;
  v_ids bigint[];
  v_ruins int;
BEGIN
  IF EXISTS (SELECT 1 FROM public.pedido_portal_ajuste_email WHERE pedido_id = p_pedido_id) THEN
    RETURN 'ja_autorizado';
  END IF;
  SELECT id, empresa, status, status_envio_portal, portal_protocolo INTO v_ped
    FROM public.pedido_compra_sugerido WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'recusado:pedido_inexistente'; END IF;
  IF p_protocolo IS NULL OR p_protocolo !~ '^[0-9]+$' THEN RETURN 'recusado:protocolo_invalido'; END IF;
  IF v_ped.status_envio_portal IS DISTINCT FROM 'sucesso_portal' THEN RETURN 'recusado:pedido_nao_sucesso_portal'; END IF;
  IF v_ped.portal_protocolo IS DISTINCT FROM p_protocolo THEN RETURN 'recusado:protocolo_divergente'; END IF;
  IF private._ajuste_lote_pedido_cancelado(p_pedido_id) THEN RETURN 'recusado:pedido_cancelado'; END IF;
  SELECT array_agg(a.id ORDER BY a.id),
         count(*) FILTER (WHERE a.status <> 'pendente_email' OR a.portal_protocolo IS DISTINCT FROM p_protocolo
                                OR a.status_envio <> 'sucesso_portal')
    INTO v_ids, v_ruins
    FROM public.pedido_portal_ajuste_qtde a WHERE a.pedido_id = p_pedido_id;
  IF v_ids IS NULL OR p_n_ajustes IS NULL OR cardinality(v_ids) <> p_n_ajustes THEN
    RETURN 'recusado:conjunto_divergente';
  END IF;
  IF v_ruins > 0 THEN RETURN 'recusado:item_fora_do_estado'; END IF;
  INSERT INTO public.pedido_portal_ajuste_email (pedido_id, empresa, portal_protocolo, ajuste_ids, origem)
  VALUES (p_pedido_id, v_ped.empresa, p_protocolo, v_ids, 'automatico')
  ON CONFLICT (pedido_id) DO NOTHING;
  IF NOT FOUND THEN RETURN 'ja_autorizado'; END IF;
  RETURN 'autorizado';
END $f$;

-- Reserva 1 pedido para a etapa ('inicial' | 'cobranca1'). Devolve jsonb com `acao`, ou NULL se não há nada.
CREATE OR REPLACE FUNCTION public.ajuste_lote_email_reservar(p_etapa text, p_agora timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
DECLARE
  e public.pedido_portal_ajuste_email%ROWTYPE;
  v_ped record;
  v_ids bigint[];
  v_ruins int;
  v_motivo text;
  v_token uuid := gen_random_uuid();
  v_assunto text;
  v_rfc text;
  v_log bigint;
  v_itens jsonb;
BEGIN
  IF p_etapa = 'inicial' THEN
    SELECT * INTO e FROM public.pedido_portal_ajuste_email x
     WHERE x.origem = 'automatico' AND x.enviado_em IS NULL AND x.reserva_token IS NULL
       AND x.indeterminado_em IS NULL AND x.bloqueado_em IS NULL
       AND (x.proxima_tentativa_em IS NULL OR x.proxima_tentativa_em <= p_agora)
     ORDER BY x.autorizado_em, x.pedido_id
     LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN RETURN NULL; END IF;

    -- revalida na ÚLTIMA transição antes do POST (Codex P0-1)
    SELECT p.status, p.status_envio_portal, p.portal_protocolo INTO v_ped
      FROM public.pedido_compra_sugerido p WHERE p.id = e.pedido_id;
    SELECT array_agg(a.id ORDER BY a.id),
           count(*) FILTER (WHERE a.status <> 'pendente_email' OR a.portal_protocolo IS DISTINCT FROM e.portal_protocolo)
      INTO v_ids, v_ruins
      FROM public.pedido_portal_ajuste_qtde a WHERE a.pedido_id = e.pedido_id;
    v_motivo := CASE
      WHEN private._ajuste_lote_pedido_cancelado(e.pedido_id) THEN 'pedido cancelado (sistema ou portal)'
      WHEN v_ped.status_envio_portal IS DISTINCT FROM 'sucesso_portal' THEN 'pedido saiu de sucesso_portal'
      WHEN v_ped.portal_protocolo IS DISTINCT FROM e.portal_protocolo THEN 'protocolo do pedido mudou'
      WHEN v_ids IS DISTINCT FROM e.ajuste_ids THEN 'itens do ledger diferem do conjunto autorizado'
      WHEN v_ruins > 0 THEN 'item do ledger fora de pendente_email'
    END;
    IF v_motivo IS NOT NULL THEN
      UPDATE public.pedido_portal_ajuste_email SET bloqueado_em = p_agora, bloqueio_motivo = v_motivo
       WHERE pedido_id = e.pedido_id;
      PERFORM private._ajuste_lote_alertar(e.pedido_id, 'bloqueado', 'urgente',
        'Sayerlack: e-mail ao CRS NÃO enviado (pedido ' || e.pedido_id || ')',
        'O e-mail automático ao CRS pedindo a redução do lote mínimo (pedido Sayerlack ' || e.portal_protocolo ||
        ') foi bloqueado: ' || v_motivo || '. Confira o pedido e, se ainda fizer sentido, envie à mão.');
      RETURN jsonb_build_object('acao', 'bloqueado', 'pedido_id', e.pedido_id, 'motivo', v_motivo);
    END IF;

    v_assunto := 'Alteração de quantidade — Pedido Sayerlack ' || e.portal_protocolo || ' [AFI-' || e.pedido_id || ']';
    v_rfc := '<afi-' || e.pedido_id || '-' || v_token || '@afiacao.sardenberg>';
    UPDATE public.pedido_portal_ajuste_email
       SET reserva_token = v_token, reservado_em = p_agora, assunto = v_assunto, rfc_message_id_proposto = v_rfc
     WHERE pedido_id = e.pedido_id;
    -- descrição é complementar: LEFT JOIN (pedido_item_id não tem FK de propósito — Codex P0-2)
    SELECT jsonb_agg(jsonb_build_object(
             'ajuste_id', a.id, 'sku_portal', a.sku_portal, 'descricao', i.sku_descricao,
             'qtde_portal_lancada', a.qtde_portal_lancada, 'qtde_portal_necessaria', a.qtde_portal_necessaria)
           ORDER BY a.id)
      INTO v_itens
      FROM public.pedido_portal_ajuste_qtde a
      LEFT JOIN public.pedido_compra_item i ON i.id = a.pedido_item_id
     WHERE a.id = ANY (e.ajuste_ids);
    RETURN jsonb_build_object('acao', 'enviar', 'etapa', 'inicial', 'pedido_id', e.pedido_id, 'token', v_token,
      'protocolo', e.portal_protocolo, 'assunto', v_assunto, 'rfc_message_id', v_rfc, 'itens', v_itens);

  ELSIF p_etapa = 'cobranca1' THEN
    SELECT * INTO e FROM public.pedido_portal_ajuste_email x
     WHERE x.origem = 'automatico' AND x.enviado_em IS NOT NULL AND x.gmail_thread_id IS NOT NULL
       AND x.resposta_observada_em IS NULL AND x.cobranca1_token IS NULL AND x.cobranca1_enviada_em IS NULL
       AND x.cobranca1_alerta_em IS NULL AND x.cobranca1_indeterminado_em IS NULL
       AND (x.cobranca1_proxima_tentativa_em IS NULL OR x.cobranca1_proxima_tentativa_em <= p_agora)
       AND private._ajuste_lote_cobranca_vencida(x.enviado_em, p_agora)
       AND private._ajuste_lote_itens_aguardando(x.pedido_id)
     ORDER BY x.enviado_em, x.pedido_id
     LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN RETURN NULL; END IF;

    v_log := private._ajuste_lote_resposta_log(e.pedido_id, e.portal_protocolo, e.enviado_em, p_agora);
    IF v_log IS NOT NULL THEN
      UPDATE public.pedido_portal_ajuste_email SET resposta_observada_em = p_agora, resposta_log_id = v_log
       WHERE pedido_id = e.pedido_id;
      PERFORM private._ajuste_lote_alertar(e.pedido_id, 'resposta', 'atencao',
        'Sayerlack respondeu sobre a redução do lote (pedido ' || e.pedido_id || ')',
        'Chegou e-mail da Sayerlack no assunto do pedido ' || e.portal_protocolo ||
        '. Leia a resposta e decida (aceito → nada a fazer; não é possível → pedir cancelamento do item no thread). ' ||
        'A cobrança automática foi suspensa.');
      RETURN jsonb_build_object('acao', 'resposta_observada', 'pedido_id', e.pedido_id);
    END IF;
    IF NOT private._ajuste_lote_caixa_coberta(p_agora) THEN
      UPDATE public.pedido_portal_ajuste_email SET cobranca1_alerta_em = p_agora, cobranca1_modo = 'alerta'
       WHERE pedido_id = e.pedido_id;
      PERFORM private._ajuste_lote_alertar(e.pedido_id, 'cobranca1', 'atencao',
        'Sayerlack: CRS sem resposta há 1 dia útil (pedido ' || e.pedido_id || ')',
        'O pedido de redução do lote (pedido Sayerlack ' || e.portal_protocolo || ') está sem resposta registrada, ' ||
        'mas a leitura da caixa está parada há 24h — não cobramos sozinhos. Confira o thread e cobre à mão se for o caso.');
      RETURN jsonb_build_object('acao', 'so_alerta', 'pedido_id', e.pedido_id, 'motivo', 'caixa_sem_cobertura');
    END IF;
    v_rfc := '<afi-' || e.pedido_id || '-c1-' || v_token || '@afiacao.sardenberg>';
    UPDATE public.pedido_portal_ajuste_email
       SET cobranca1_token = v_token, cobranca1_reservado_em = p_agora, cobranca1_rfc_message_id_proposto = v_rfc
     WHERE pedido_id = e.pedido_id;
    RETURN jsonb_build_object('acao', 'enviar', 'etapa', 'cobranca1', 'pedido_id', e.pedido_id, 'token', v_token,
      'protocolo', e.portal_protocolo, 'assunto', e.assunto, 'thread_id', e.gmail_thread_id,
      'in_reply_to', coalesce(e.rfc_message_id_observado, e.rfc_message_id_proposto), 'rfc_message_id', v_rfc);
  END IF;
  RAISE EXCEPTION 'ajuste_lote_email_reservar: etapa invalida %', p_etapa USING ERRCODE = '22023';
END $f$;

-- Confirma o POST aceito pelo Gmail (id + threadId). Idempotente: a mesma confirmação repetida = 'ja_confirmado'.
CREATE OR REPLACE FUNCTION public.ajuste_lote_email_confirmar(p_etapa text, p_pedido_id bigint, p_token uuid,
                                                             p_gmail_message_id text, p_thread_id text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
DECLARE
  e public.pedido_portal_ajuste_email%ROWTYPE;
  n int;
BEGIN
  IF p_token IS NULL OR coalesce(p_gmail_message_id, '') = '' OR coalesce(p_thread_id, '') = '' THEN
    RAISE EXCEPTION 'ajuste_lote_email_confirmar: token/id/thread obrigatorios' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO e FROM public.pedido_portal_ajuste_email WHERE pedido_id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'token_invalido'; END IF;
  IF p_etapa = 'inicial' THEN
    IF e.reserva_token IS DISTINCT FROM p_token THEN RETURN 'token_invalido'; END IF;
    IF e.enviado_em IS NOT NULL THEN
      RETURN CASE WHEN e.gmail_message_id = p_gmail_message_id THEN 'ja_confirmado' ELSE 'token_invalido' END;
    END IF;
    UPDATE public.pedido_portal_ajuste_email
       SET enviado_em = now(), gmail_message_id = p_gmail_message_id, gmail_thread_id = p_thread_id
     WHERE pedido_id = p_pedido_id;
    UPDATE public.pedido_portal_ajuste_qtde SET status = 'email_enviado'
     WHERE id = ANY (e.ajuste_ids) AND status = 'pendente_email';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> cardinality(e.ajuste_ids) THEN
      PERFORM private._ajuste_lote_alertar(p_pedido_id, 'ledger_divergente', 'urgente',
        'Sayerlack: e-mail ao CRS enviado, mas o ledger divergiu (pedido ' || p_pedido_id || ')',
        'O e-mail saiu (Gmail ' || p_gmail_message_id || '), mas só ' || n || ' de ' || cardinality(e.ajuste_ids) ||
        ' item(ns) estavam em pendente_email. Confira o ledger pedido_portal_ajuste_qtde.');
    END IF;
    -- Item que entrou no ledger depois da reserva NÃO está neste e-mail: o varredor (e) o pega em 30 min e manda o
    -- founder pedir à mão — um aviso só (Codex P1-4).
    PERFORM private._ajuste_lote_alertar(p_pedido_id, 'enviado', 'info',
      'Sayerlack: e-mail ao CRS enviado (pedido ' || p_pedido_id || ')',
      'Pedimos ao CRS a redução do lote mínimo no pedido Sayerlack ' || e.portal_protocolo ||
      '. Assunto: ' || coalesce(e.assunto, '?') || '. Sem resposta em 1 dia útil, cobramos no mesmo thread.');
    RETURN 'confirmado';
  ELSIF p_etapa = 'cobranca1' THEN
    IF e.cobranca1_token IS DISTINCT FROM p_token THEN RETURN 'token_invalido'; END IF;
    IF e.cobranca1_enviada_em IS NOT NULL THEN
      RETURN CASE WHEN e.cobranca1_gmail_message_id = p_gmail_message_id THEN 'ja_confirmado' ELSE 'token_invalido' END;
    END IF;
    UPDATE public.pedido_portal_ajuste_email
       SET cobranca1_enviada_em = now(), cobranca1_gmail_message_id = p_gmail_message_id, cobranca1_modo = 'email'
     WHERE pedido_id = p_pedido_id;
    IF p_thread_id IS DISTINCT FROM e.gmail_thread_id THEN
      PERFORM private._ajuste_lote_alertar(p_pedido_id, 'cobranca1_thread_divergente', 'atencao',
        'Sayerlack: cobrança saiu FORA do thread original (pedido ' || p_pedido_id || ')',
        'A cobrança ao CRS foi aceita pelo Gmail em outro thread (' || p_thread_id || ' ≠ ' || e.gmail_thread_id ||
        '). Confira no Gmail se ela ficou junto do pedido original.');
    END IF;
    PERFORM private._ajuste_lote_alertar(p_pedido_id, 'cobranca1', 'atencao',
      'Sayerlack: CRS cobrado — sem resposta há 1 dia útil (pedido ' || p_pedido_id || ')',
      'Respondemos no thread do pedido Sayerlack ' || e.portal_protocolo ||
      ' cobrando a confirmação da redução. Se seguir sem resposta, o próximo aviso é só para você.');
    RETURN 'confirmado';
  END IF;
  RAISE EXCEPTION 'ajuste_lote_email_confirmar: etapa invalida %', p_etapa USING ERRCODE = '22023';
END $f$;

-- Message-ID RFC que o Gmail realmente gravou (lido por messages.get quando o escopo permite). Best-effort.
CREATE OR REPLACE FUNCTION public.ajuste_lote_email_registrar_rfc(p_pedido_id bigint, p_token uuid, p_rfc text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
BEGIN
  IF coalesce(p_rfc, '') !~ '^<[^<>[:space:]]+@[^<>[:space:]]+>$' THEN RETURN 'rfc_invalido'; END IF;
  UPDATE public.pedido_portal_ajuste_email SET rfc_message_id_observado = p_rfc
   WHERE pedido_id = p_pedido_id AND reserva_token = p_token AND enviado_em IS NOT NULL
     AND rfc_message_id_observado IS NULL;
  RETURN CASE WHEN FOUND THEN 'registrado' ELSE 'ignorado' END;
END $f$;

-- Falha do POST. 'nao_enviado' (Gmail RESPONDEU 4xx) libera com backoff, 3ª = bloqueia + alerta.
-- 'indeterminado' (timeout, rede, 5xx, 2xx ilegível) NUNCA libera: alerta para conferir os Enviados.
CREATE OR REPLACE FUNCTION public.ajuste_lote_email_falhou(p_etapa text, p_pedido_id bigint, p_token uuid, p_tipo text,
                                                          p_erro text, p_espera_s integer DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
DECLARE
  e public.pedido_portal_ajuste_email%ROWTYPE;
  v_espera interval;
  v_erro text := left(coalesce(p_erro, '?'), 500);
BEGIN
  IF p_tipo IS NULL OR p_tipo NOT IN ('nao_enviado', 'indeterminado') THEN
    RAISE EXCEPTION 'ajuste_lote_email_falhou: tipo invalido %', p_tipo USING ERRCODE = '22023';
  END IF;
  IF p_token IS NULL THEN RETURN 'token_invalido'; END IF;
  SELECT * INTO e FROM public.pedido_portal_ajuste_email WHERE pedido_id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'token_invalido'; END IF;
  IF p_etapa = 'inicial' THEN
    IF e.reserva_token IS DISTINCT FROM p_token OR e.enviado_em IS NOT NULL OR e.indeterminado_em IS NOT NULL THEN
      RETURN 'token_invalido';
    END IF;
    IF p_tipo = 'indeterminado' THEN
      UPDATE public.pedido_portal_ajuste_email SET indeterminado_em = now(), ultimo_erro = v_erro
       WHERE pedido_id = p_pedido_id;
      PERFORM private._ajuste_lote_alertar(p_pedido_id, 'indeterminado', 'urgente',
        'Sayerlack: e-mail ao CRS em estado INDETERMINADO (pedido ' || p_pedido_id || ')',
        'O envio do e-mail ao CRS (pedido Sayerlack ' || e.portal_protocolo || ') não teve confirmação: ' || v_erro ||
        '. Confira os Enviados do Gmail pelo assunto "' || coalesce(e.assunto, '?') ||
        '". Se não saiu, envie à mão. O sistema NÃO reenvia sozinho.');
      RETURN 'indeterminado';
    END IF;
    v_espera := make_interval(secs => greatest(coalesce(p_espera_s, 0), 300 * power(2, e.tentativas)::int));
    IF e.tentativas + 1 >= 3 THEN
      UPDATE public.pedido_portal_ajuste_email
         SET reserva_token = NULL, reservado_em = NULL, tentativas = e.tentativas + 1, ultimo_erro = v_erro,
             bloqueado_em = now(), bloqueio_motivo = 'Gmail recusou o envio 3 vezes'
       WHERE pedido_id = p_pedido_id;
      PERFORM private._ajuste_lote_alertar(p_pedido_id, 'bloqueado', 'urgente',
        'Sayerlack: e-mail ao CRS NÃO enviado (pedido ' || p_pedido_id || ')',
        'O Gmail recusou 3 vezes o e-mail ao CRS (pedido Sayerlack ' || e.portal_protocolo || '): ' || v_erro ||
        '. Envie à mão.');
      RETURN 'bloqueado';
    END IF;
    UPDATE public.pedido_portal_ajuste_email
       SET reserva_token = NULL, reservado_em = NULL, tentativas = e.tentativas + 1, ultimo_erro = v_erro,
           proxima_tentativa_em = now() + v_espera
     WHERE pedido_id = p_pedido_id;
    RETURN 'liberado';
  ELSIF p_etapa = 'cobranca1' THEN
    IF e.cobranca1_token IS DISTINCT FROM p_token OR e.cobranca1_enviada_em IS NOT NULL
       OR e.cobranca1_indeterminado_em IS NOT NULL THEN
      RETURN 'token_invalido';
    END IF;
    IF p_tipo = 'indeterminado' THEN
      UPDATE public.pedido_portal_ajuste_email SET cobranca1_indeterminado_em = now(), cobranca1_ultimo_erro = v_erro
       WHERE pedido_id = p_pedido_id;
      PERFORM private._ajuste_lote_alertar(p_pedido_id, 'cobranca1_indeterminado', 'urgente',
        'Sayerlack: cobrança ao CRS em estado INDETERMINADO (pedido ' || p_pedido_id || ')',
        'A cobrança no thread (pedido Sayerlack ' || e.portal_protocolo || ') não teve confirmação: ' || v_erro ||
        '. Confira os Enviados do Gmail; o sistema NÃO reenvia sozinho.');
      RETURN 'indeterminado';
    END IF;
    IF e.cobranca1_tentativas + 1 >= 3 THEN
      UPDATE public.pedido_portal_ajuste_email
         SET cobranca1_token = NULL, cobranca1_reservado_em = NULL, cobranca1_tentativas = e.cobranca1_tentativas + 1,
             cobranca1_ultimo_erro = v_erro, cobranca1_alerta_em = now(), cobranca1_modo = 'alerta'
       WHERE pedido_id = p_pedido_id;
      PERFORM private._ajuste_lote_alertar(p_pedido_id, 'cobranca1', 'atencao',
        'Sayerlack: CRS sem resposta há 1 dia útil (pedido ' || p_pedido_id || ')',
        'O Gmail recusou 3 vezes a cobrança no thread (pedido Sayerlack ' || e.portal_protocolo || '): ' || v_erro ||
        '. Cobre à mão no thread.');
      RETURN 'so_alerta';
    END IF;
    v_espera := make_interval(secs => greatest(coalesce(p_espera_s, 0), 300 * power(2, e.cobranca1_tentativas)::int));
    UPDATE public.pedido_portal_ajuste_email
       SET cobranca1_token = NULL, cobranca1_reservado_em = NULL, cobranca1_tentativas = e.cobranca1_tentativas + 1,
           cobranca1_ultimo_erro = v_erro, cobranca1_proxima_tentativa_em = now() + v_espera
     WHERE pedido_id = p_pedido_id;
    RETURN 'liberado';
  END IF;
  RAISE EXCEPTION 'ajuste_lote_email_falhou: etapa invalida %', p_etapa USING ERRCODE = '22023';
END $f$;

-- ── 5. ciclo SQL (cron */15): reservas presas, resposta observada, cobranças só-alerta, varredor de atraso ──────
CREATE OR REPLACE FUNCTION private.ajuste_lote_email_ciclo(p_agora timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $f$
DECLARE
  r record;
  v_log bigint;
  n_presas int := 0; n_resp int := 0; n_c1 int := 0; n_c2 int := 0; n_atraso int := 0;
BEGIN
  -- (a) reserva sem confirmação há 30 min = o processo caiu entre o POST e a confirmação → indeterminado.
  FOR r IN SELECT * FROM public.pedido_portal_ajuste_email
            WHERE reserva_token IS NOT NULL AND enviado_em IS NULL AND indeterminado_em IS NULL
              AND reservado_em < p_agora - interval '30 minutes' FOR UPDATE LOOP
    UPDATE public.pedido_portal_ajuste_email SET indeterminado_em = p_agora, ultimo_erro = 'reserva sem confirmação há 30 min'
     WHERE pedido_id = r.pedido_id;
    PERFORM private._ajuste_lote_alertar(r.pedido_id, 'indeterminado', 'urgente',
      'Sayerlack: e-mail ao CRS em estado INDETERMINADO (pedido ' || r.pedido_id || ')',
      'O envio do e-mail ao CRS (pedido Sayerlack ' || r.portal_protocolo || ') começou e não foi confirmado. ' ||
      'Confira os Enviados do Gmail pelo assunto "' || coalesce(r.assunto, '?') || '". Se não saiu, envie à mão.');
    n_presas := n_presas + 1;
  END LOOP;
  FOR r IN SELECT * FROM public.pedido_portal_ajuste_email
            WHERE cobranca1_token IS NOT NULL AND cobranca1_enviada_em IS NULL AND cobranca1_indeterminado_em IS NULL
              AND cobranca1_reservado_em < p_agora - interval '30 minutes' FOR UPDATE LOOP
    UPDATE public.pedido_portal_ajuste_email SET cobranca1_indeterminado_em = p_agora,
           cobranca1_ultimo_erro = 'reserva sem confirmação há 30 min'
     WHERE pedido_id = r.pedido_id;
    PERFORM private._ajuste_lote_alertar(r.pedido_id, 'cobranca1_indeterminado', 'urgente',
      'Sayerlack: cobrança ao CRS em estado INDETERMINADO (pedido ' || r.pedido_id || ')',
      'A cobrança no thread (pedido Sayerlack ' || r.portal_protocolo || ') começou e não foi confirmada. ' ||
      'Confira os Enviados do Gmail; o sistema NÃO reenvia sozinho.');
    n_presas := n_presas + 1;
  END LOOP;

  -- (b) resposta da Sayerlack vista na caixa → suspende cobrança e avisa.
  FOR r IN SELECT * FROM public.pedido_portal_ajuste_email
            WHERE enviado_em IS NOT NULL AND resposta_observada_em IS NULL FOR UPDATE LOOP
    v_log := private._ajuste_lote_resposta_log(r.pedido_id, r.portal_protocolo, r.enviado_em, p_agora);
    CONTINUE WHEN v_log IS NULL;
    UPDATE public.pedido_portal_ajuste_email SET resposta_observada_em = p_agora, resposta_log_id = v_log
     WHERE pedido_id = r.pedido_id;
    PERFORM private._ajuste_lote_alertar(r.pedido_id, 'resposta', 'atencao',
      'Sayerlack respondeu sobre a redução do lote (pedido ' || r.pedido_id || ')',
      'Chegou e-mail da Sayerlack no assunto do pedido ' || r.portal_protocolo ||
      '. Leia a resposta e decida (aceito → nada a fazer; não é possível → pedir cancelamento do item no thread). ' ||
      'A cobrança automática foi suspensa.');
    n_resp := n_resp + 1;
  END LOOP;

  -- (c) 1ª cobrança SÓ ALERTA: sem thread conhecido (envio manual) ou caixa sem cobertura. Com thread e caixa
  --     coberta, quem cobra é a edge (cron 08:05 SP); se 3h depois nada saiu, alerta de atraso.
  FOR r IN SELECT * FROM public.pedido_portal_ajuste_email
            WHERE enviado_em IS NOT NULL AND resposta_observada_em IS NULL
              AND cobranca1_token IS NULL AND cobranca1_enviada_em IS NULL AND cobranca1_alerta_em IS NULL
              AND cobranca1_indeterminado_em IS NULL
              AND private._ajuste_lote_cobranca_vencida(enviado_em, p_agora)
              AND private._ajuste_lote_itens_aguardando(pedido_id) FOR UPDATE LOOP
    IF r.gmail_thread_id IS NULL OR r.origem = 'manual' OR NOT private._ajuste_lote_caixa_coberta(p_agora) THEN
      UPDATE public.pedido_portal_ajuste_email SET cobranca1_alerta_em = p_agora, cobranca1_modo = 'alerta'
       WHERE pedido_id = r.pedido_id;
      PERFORM private._ajuste_lote_alertar(r.pedido_id, 'cobranca1', 'atencao',
        'Sayerlack: CRS sem resposta há 1 dia útil (pedido ' || r.pedido_id || ')',
        'O pedido de redução do lote (pedido Sayerlack ' || r.portal_protocolo || ') segue sem resposta vista na caixa. ' ||
        CASE WHEN r.gmail_thread_id IS NULL OR r.origem = 'manual'
             THEN 'O e-mail foi enviado à mão (thread desconhecido): cobre à mão no thread.'
             ELSE 'A leitura da caixa está parada há 24h: confira o thread e cobre à mão se for o caso.' END);
      n_c1 := n_c1 + 1;
    ELSIF private._ajuste_lote_cobranca_vencida(r.enviado_em, p_agora - interval '3 hours') THEN
      -- Codex P0-1: ao entregar ao founder, DESARMA a automação na mesma transação (senão saem 2 cobranças).
      UPDATE public.pedido_portal_ajuste_email SET cobranca1_alerta_em = p_agora, cobranca1_modo = 'alerta'
       WHERE pedido_id = r.pedido_id;
      PERFORM private._ajuste_lote_alertar(r.pedido_id, 'cobranca1_atrasada', 'urgente',
        'Sayerlack: cobrança automática ao CRS não saiu (pedido ' || r.pedido_id || ')',
        'A cobrança no thread do pedido Sayerlack ' || r.portal_protocolo || ' venceu há mais de 3h e não saiu' ||
        coalesce(' (último erro: ' || r.cobranca1_ultimo_erro || ')', '') ||
        '. A cobrança automática deste pedido foi CANCELADA: cobre à mão no thread.');
      n_atraso := n_atraso + 1;
    END IF;
  END LOOP;

  -- (d) 2ª cobrança = só alerta (não insistimos com o fornecedor).
  FOR r IN SELECT * FROM public.pedido_portal_ajuste_email
            WHERE resposta_observada_em IS NULL AND cobranca2_alerta_em IS NULL
              AND (cobranca1_enviada_em IS NOT NULL OR cobranca1_alerta_em IS NOT NULL)
              AND private._ajuste_lote_cobranca_vencida(coalesce(cobranca1_enviada_em, cobranca1_alerta_em), p_agora)
              AND private._ajuste_lote_itens_aguardando(pedido_id) FOR UPDATE LOOP
    UPDATE public.pedido_portal_ajuste_email SET cobranca2_alerta_em = p_agora WHERE pedido_id = r.pedido_id;
    PERFORM private._ajuste_lote_alertar(r.pedido_id, 'cobranca2', 'urgente',
      'Sayerlack: CRS segue sem resposta após a cobrança (pedido ' || r.pedido_id || ')',
      'Pedido Sayerlack ' || r.portal_protocolo || ': 2 dias úteis sem resposta vista na caixa' ||
      CASE WHEN r.cobranca1_modo = 'alerta' THEN ' (a cobrança anterior foi só um aviso para você — sem confirmação de que saiu)' ELSE '' END ||
      '. Não cobramos de novo sozinhos: decida (ligar, insistir, aceitar o lote ou pedir cancelamento).');
    n_c2 := n_c2 + 1;
  END LOOP;

  -- (e) varredor independente de reserva (Codex P1-8): autorizado e não enviado há 30 min…
  -- Codex P0-1: alertar "envie à mão" e DESARMAR o envio na MESMA transação — só um responsável por pedido.
  -- Reserva em voo (token presente) fica para a seção (a): ela vira indeterminado, nunca bloqueio cego.
  FOR r IN SELECT * FROM public.pedido_portal_ajuste_email
            WHERE origem = 'automatico' AND enviado_em IS NULL AND indeterminado_em IS NULL AND bloqueado_em IS NULL
              AND reserva_token IS NULL AND autorizado_em < p_agora - interval '30 minutes' FOR UPDATE LOOP
    UPDATE public.pedido_portal_ajuste_email
       SET bloqueado_em = p_agora, bloqueio_motivo = 'não saiu em 30 min: entregue ao founder'
     WHERE pedido_id = r.pedido_id;
    PERFORM private._ajuste_lote_alertar(r.pedido_id, 'envio_atrasado', 'urgente',
      'Sayerlack: e-mail ao CRS NÃO saiu — envie à mão (pedido ' || r.pedido_id || ')',
      'O e-mail automático ao CRS (pedido Sayerlack ' || r.portal_protocolo || ') foi autorizado há mais de 30 min e ' ||
      'não saiu' || coalesce(' (último erro: ' || r.ultimo_erro || ')', '') ||
      '. O envio automático deste pedido foi CANCELADO: envie à mão a crs@sayerlack.com.br.');
    n_atraso := n_atraso + 1;
  END LOOP;
  -- …e item do ledger pendente há 30 min que NENHUMA autorização cobre. Só alerta o caso em que o aviso da Fase 1
  -- prometeu envio automático (status_envio sucesso_portal + protocolo): pedido em conciliação/sem protocolo já
  -- recebeu "ACAO: enviar" do portal, e um 2º aviso seria uma 2ª ordem de envio (Codex P1-2).
  FOR r IN SELECT a.pedido_id, min(a.portal_protocolo) AS protocolo FROM public.pedido_portal_ajuste_qtde a
            WHERE a.status = 'pendente_email' AND a.criado_em < p_agora - interval '30 minutes'
              AND a.status_envio = 'sucesso_portal' AND a.portal_protocolo IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM public.pedido_portal_ajuste_email e WHERE a.id = ANY (e.ajuste_ids))
            GROUP BY a.pedido_id LOOP
    IF private._ajuste_lote_alertar(r.pedido_id, 'sem_autorizacao', 'urgente',
         'Sayerlack: pedir redução ao CRS À MÃO (pedido ' || r.pedido_id || ')',
         'O pedido ' || r.pedido_id || ' (Sayerlack ' || r.protocolo || ') entrou no portal acima da necessidade pelo ' ||
         'lote mínimo e o e-mail automático ao CRS NÃO foi autorizado para este item. Ignore o aviso anterior de ' ||
         'envio automático: envie à mão a crs@sayerlack.com.br.') IS NOT NULL THEN
      n_atraso := n_atraso + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('presas', n_presas, 'respostas', n_resp, 'cobranca1_alerta', n_c1,
                            'cobranca2', n_c2, 'atrasos', n_atraso);
END $f$;

-- ── 6. privilégios: SECURITY DEFINER só para service_role (Codex P1-9: revogar das TRÊS) ────────────────────────
REVOKE ALL ON FUNCTION public.ajuste_lote_email_autorizar(bigint, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ajuste_lote_email_reservar(text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ajuste_lote_email_confirmar(text, bigint, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ajuste_lote_email_registrar_rfc(bigint, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ajuste_lote_email_falhou(text, bigint, uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ajuste_lote_email_autorizar(bigint, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ajuste_lote_email_reservar(text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.ajuste_lote_email_confirmar(text, bigint, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.ajuste_lote_email_registrar_rfc(bigint, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.ajuste_lote_email_falhou(text, bigint, uuid, text, text, integer) TO service_role;
REVOKE ALL ON FUNCTION private._ajuste_lote_dia_util(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private._ajuste_lote_cobranca_vencida(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private._ajuste_lote_caixa_coberta(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private._ajuste_lote_resposta_log(bigint, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private._ajuste_lote_alertar(bigint, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private._ajuste_lote_itens_aguardando(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private._ajuste_lote_pedido_cancelado(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.ajuste_lote_email_ha_pendente(text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.ajuste_lote_email_ciclo(timestamptz) FROM PUBLIC, anon, authenticated;

-- ── 7. backfill: o e-mail do pedido 4557 (portal 2152582) saiu À MÃO em 2026-11-20 14:24 BRT ───────────────────
-- Conferido pedido_id + protocolo + item + status (Codex P0-3). Thread desconhecido: a cobrança dele é só alerta.
INSERT INTO public.pedido_portal_ajuste_email (pedido_id, empresa, portal_protocolo, ajuste_ids, origem, autorizado_em,
                                               assunto, enviado_em)
SELECT a.pedido_id, a.empresa, a.portal_protocolo, ARRAY[a.id], 'manual', timestamptz '2026-11-20 17:24:00+00',
       'Pedido 2152582 — redução de quantidade do item YO20.1464.00BB', timestamptz '2026-11-20 17:24:00+00'
  FROM public.pedido_portal_ajuste_qtde a
 WHERE a.id = 1 AND a.pedido_id = 4557 AND a.portal_protocolo = '2152582' AND a.sku_portal = 'YO20.1464.00BB'
   AND NOT EXISTS (SELECT 1 FROM public.pedido_portal_ajuste_qtde b WHERE b.pedido_id = 4557 AND b.id <> 1)
ON CONFLICT (pedido_id) DO NOTHING;
UPDATE public.pedido_portal_ajuste_qtde a SET status = 'email_enviado'
 WHERE a.id = 1 AND a.pedido_id = 4557 AND a.status = 'pendente_email'
   AND EXISTS (SELECT 1 FROM public.pedido_portal_ajuste_email e WHERE e.pedido_id = 4557 AND e.origem = 'manual');

-- ── 8. crons (net.http_post com timeout explícito; o WHERE não acorda a edge à toa) ────────────────────────────
SELECT cron.schedule('ajuste-lote-email-enviar', '*/5 * * * *', $cron$
  SELECT net.http_post(url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/email-crs-ajuste-lote',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET')),
    body:=jsonb_build_object('modo','enviar'), timeout_milliseconds:=120000)
  WHERE private.ajuste_lote_email_ha_pendente('inicial', now());
$cron$);
-- 08:05/11:05/14:05 SP, seg–sex (a vencida exige dia útil ≥ 08:00 SP; os horários extras pegam o backoff de 429).
SELECT cron.schedule('ajuste-lote-email-cobrar', '5 11,14,17 * * 1-5', $cron$
  SELECT net.http_post(url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/email-crs-ajuste-lote',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET')),
    body:=jsonb_build_object('modo','cobrar'), timeout_milliseconds:=120000)
  WHERE private.ajuste_lote_email_ha_pendente('cobranca1', now());
$cron$);
SELECT cron.schedule('ajuste-lote-email-ciclo', '*/15 * * * *', $cron$SELECT private.ajuste_lote_email_ciclo(now());$cron$);

-- ── 9. pós-condição ───────────────────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  f text;
  r text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relname = 'pedido_portal_ajuste_email' AND c.relrowsecurity)
     OR NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = 'pedido_portal_ajuste_email_alerta' AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'B1 FALHOU: tabela do e-mail ao CRS ausente ou sem RLS';
  END IF;
  IF has_table_privilege('authenticated', 'public.pedido_portal_ajuste_email', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.pedido_portal_ajuste_email_alerta', 'SELECT')
     OR has_table_privilege('anon', 'public.pedido_portal_ajuste_email', 'SELECT') THEN
    RAISE EXCEPTION 'B2 FALHOU: authenticated escreve ou anon le a trilha do e-mail';
  END IF;
  FOREACH f IN ARRAY ARRAY['public.ajuste_lote_email_autorizar(bigint,text,integer)',
                           'public.ajuste_lote_email_reservar(text,timestamptz)',
                           'public.ajuste_lote_email_confirmar(text,bigint,uuid,text,text)',
                           'public.ajuste_lote_email_registrar_rfc(bigint,uuid,text)',
                           'public.ajuste_lote_email_falhou(text,bigint,uuid,text,text,integer)'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(r, f, 'EXECUTE') THEN
        RAISE EXCEPTION 'B3 FALHOU: % executa % (SECURITY DEFINER aberto)', r, f;
      END IF;
    END LOOP;
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'B3 FALHOU: service_role sem EXECUTE em %', f;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ajuste_email_write_once' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'B4 FALHOU: trigger write-once ausente';
  END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname IN ('ajuste-lote-email-enviar', 'ajuste-lote-email-cobrar')
        AND command LIKE '%timeout_milliseconds:=120000%' AND username = 'postgres') <> 2
     OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ajuste-lote-email-ciclo' AND username = 'postgres') THEN
    RAISE EXCEPTION 'B5 FALHOU: crons do e-mail ao CRS ausentes, sem timeout explicito ou com dono errado';
  END IF;
  -- a linha enviada à mão nunca fica elegível ao envio automático
  IF EXISTS (SELECT 1 FROM public.pedido_portal_ajuste_qtde WHERE id = 1 AND pedido_id = 4557)
     AND NOT EXISTS (SELECT 1 FROM public.pedido_portal_ajuste_email
                     WHERE pedido_id = 4557 AND origem = 'manual' AND enviado_em IS NOT NULL) THEN
    RAISE EXCEPTION 'B6 FALHOU: o pedido 4557 (e-mail ja enviado a mao) ficou sem o registro manual';
  END IF;
  RAISE NOTICE 'lote_minimo_email_crs OK: RLS, privilegios, write-once, crons e backfill manual provados';
END
$post$;
