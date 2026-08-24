-- ══════════════════════════════════════════════════════════════════════════════════════════
-- FIXTURE DE TESTE — NÃO É MIGRATION. Não colar no SQL Editor; não vive em supabase/migrations/.
-- ══════════════════════════════════════════════════════════════════════════════════════════
-- O supabase/schema-snapshot.sql está DEFASADO em relação à máquina de episódio que a
-- 20260814222000_data_health_watchdog_reemissao.sql instalou: faltam nele
--   · TABELA  public.data_health_watchdog_estado  (marcador do dead-man)
--   · FUNÇÃO  public._data_health_episodio        (máquina de episódio do vigia)
-- Sem os dois, QUALQUER harness PG17 que EXECUTE public.data_health_watchdog() morre com
-- 42P01 — foi o que aconteceu ao escrever db/test-data-health-carteira-identidade.sh. É o
-- apodrecimento que docs/agent/sync.md já denuncia ("5 dos 8 harnesses apodreceram em
-- silêncio"): o harness que só CRIA a função passa, o que a EXECUTA quebra.
--
-- Forma MEDIDA na PROD em 2026-08-24 via ~/.config/afiacao/psql-ro (não inventada):
--   information_schema.columns + pg_constraint para a tabela; pg_get_functiondef para a função.
-- Tudo idempotente: quando o snapshot for regenerado, este arquivo vira no-op.
-- ══════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.data_health_watchdog_estado (
  id               boolean     NOT NULL DEFAULT true,
  last_run_at      timestamptz,
  last_success_at  timestamptz,
  checks_avaliados integer,
  checks_falhos    integer,
  ultimo_erro      text,
  atualizado_em    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT data_health_watchdog_estado_pkey    PRIMARY KEY (id),
  CONSTRAINT data_health_watchdog_estado_id_check CHECK (id)
);

-- singleton: a prod tem exatamente 1 linha e o watchdog lê `WHERE id` sem criar
INSERT INTO public.data_health_watchdog_estado (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public._data_health_episodio(p_company text, p_tipo text, p_status text, p_sev_fin text, p_titulo text, p_msg text, p_msg_email text, p_ctx jsonb, p_fingerprint text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- data_health reemissao v1 (mig 20260814222000) — MARCADOR do guard anti-rollback.
-- Uma versão SUCESSORA que recrie esta máquina DEVE trocar o marcador (v2, v3…), para que
-- re-aplicar a migration ANTIGA sobre ela ABORTE em vez de revertê-la em silêncio.
DECLARE
  v_sev_forn   text;
  v_grav       int;
  v_intervalo  interval;
  v_row        public.fin_alertas%ROWTYPE;
  v_fp_ant     text;
  v_fp_email   text;
  v_grav_email int;
  v_ult_email  timestamptz;
  v_ult_grav   int;
  v_flap       boolean;
  -- 2h = 4 ticks do cron */30. Abaixo disso é oscilação; acima, recorrência.
  v_janela_flap interval := interval '2 hours';
  -- Teto de e-mails por MATERIALIDADE (ver v_material). 4h ⇒ ≤6/dia no pior caso.
  v_min_material interval := interval '4 hours';
  v_prox       timestamptz;
  v_ack        boolean;
  v_snooze     boolean;
  v_escalou    boolean;
  v_nunca      boolean;
  v_material   boolean;
  v_lembrete   boolean;
  v_deve       boolean;
  v_motivo     text;
  v_upd        int;
BEGIN
  -- Contrato fail-closed do vocabulário. NULL/typo ABORTA — nunca degrada para 'aviso'
  -- (o CASE … ELSE do corpo antigo transformava severidade desconhecida em 'aviso' calado).
  IF p_sev_fin IS NULL OR p_sev_fin NOT IN ('info','aviso','critico') THEN
    RAISE EXCEPTION 'severidade de fin_alertas inválida: %', COALESCE(p_sev_fin,'<NULL>')
      USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('stale','broken','unknown') THEN
    RAISE EXCEPTION 'status de episódio inválido: %', COALESCE(p_status,'<NULL>')
      USING ERRCODE = '22023';
  END IF;

  -- fornecedor_alerta tem CHECK próprio e vocabulário DIFERENTE de fin_alertas
  -- (info/atencao/urgente vs info/aviso/critico) — derivar aqui elimina o modo de falha
  -- "severidade inválida derruba o cron".
  v_sev_forn := CASE p_sev_fin WHEN 'critico' THEN 'urgente'
                               WHEN 'aviso'   THEN 'atencao'
                               ELSE 'info' END;

  -- GRAVIDADE = severidade × status. É o que pega stale→broken num check cuja severity é
  -- literal 'warning' (reposicao_disparo): sem o eixo de status, a piora seria muda.
  v_grav := (CASE p_sev_fin WHEN 'critico' THEN 3 WHEN 'aviso' THEN 2 ELSE 1 END) * 10
          + (CASE p_status  WHEN 'broken'  THEN 3 WHEN 'stale' THEN 2 ELSE 1 END);

  v_intervalo := CASE WHEN p_sev_fin = 'critico' THEN interval '24 hours'
                                                 ELSE interval '72 hours' END;

  -- ── 1) episódio NOVO ──────────────────────────────────────────────────────────────────────
  -- ⚠️ ANTI-FLAP — a cadência de e-mail é por (company,tipo), NÃO por episódio. Sem isto o
  -- desenho tem o furo ESPELHO do que corrige: um check que oscila ok↔degradado a cada tick
  -- resolve e reabre o episódio 48×/dia, e "episódio novo ⇒ e-mail" vira tempestade. O mesmo
  -- vale para o "dispensar" da UI, que tira a linha do índice parcial e faz o próximo tick
  -- abrir episódio novo. Consultamos o último ENQUEUE deste tipo ATRAVESSANDO episódios
  -- encerrados: a garantia passa a ser "no máximo 1 e-mail por cadência por tipo", com duas
  -- saídas legítimas — nunca notificado, ou pior do que o que já foi notificado.
  SELECT a.email_enfileirado_em, (a.contexto->>'_grav_email')::int
    INTO v_ult_email, v_ult_grav
    FROM public.fin_alertas a
   WHERE a.company = p_company AND a.tipo = p_tipo AND a.email_enfileirado_em IS NOT NULL
   ORDER BY a.email_enfileirado_em DESC
   LIMIT 1;

  -- ⚠️ O anti-flap NÃO pode calar RECORRÊNCIA LEGÍTIMA. O que distingue os dois casos é o
  -- INTERVALO SAUDÁVEL: flapping fecha e reabre dentro de poucos ticks; um incidente que volta
  -- depois de horas de saúde é notícia nova e merece e-mail na hora. Sem este recorte, um
  -- pedido novo travando 2h depois de outro ser resolvido ficaria mudo até o lembrete de 72h —
  -- exatamente o tipo de silêncio que esta migration existe para acabar.
  SELECT (max(a.dismissed_at) > clock_timestamp() - v_janela_flap)
    INTO v_flap
    FROM public.fin_alertas a
   WHERE a.company = p_company AND a.tipo = p_tipo AND a.dismissed_at IS NOT NULL;

  v_deve := v_ult_email IS NULL                                    -- nunca avisou este tipo
            OR (v_ult_grav IS NOT NULL AND v_grav > v_ult_grav)    -- voltou PIOR do que o avisado
            OR NOT COALESCE(v_flap, false)                         -- reabertura NÃO é oscilação
            OR clock_timestamp() >= v_ult_email + v_intervalo;     -- venceu a cadência

  -- clock_timestamp() (não now()): now() é o instante do BEGIN e a transação pode ter esperado
  -- lock/fila; um prazo relativo medido do BEGIN nasce vencido (money-path.md §2).
  INSERT INTO public.fin_alertas (company, tipo, severidade, mensagem, contexto, email_enfileirado_em)
  VALUES (p_company, p_tipo, p_sev_fin, p_msg,
          COALESCE(p_ctx, '{}'::jsonb) || jsonb_build_object(
            '_fp',            p_fingerprint,
            '_fp_email',      CASE WHEN v_deve THEN p_fingerprint ELSE NULL END,
            '_grav_email',    CASE WHEN v_deve THEN v_grav        ELSE v_ult_grav END,
            '_sev_email',     CASE WHEN v_deve THEN p_sev_fin     ELSE NULL END,
            -- Silenciado pelo anti-flap: o lembrete herda o prazo do último e-mail REAL, para
            -- que o teto de silêncio siga sendo a cadência (24h/72h) e não o infinito.
            '_prox_email_em', to_jsonb(CASE WHEN v_deve THEN clock_timestamp() + v_intervalo
                                            ELSE v_ult_email + v_intervalo END),
            '_n_emails',      CASE WHEN v_deve THEN 1 ELSE 0 END,
            '_motivo_email',  CASE WHEN v_deve THEN 'episodio_novo' ELSE NULL END,
            'avaliado_em',    to_jsonb(clock_timestamp())),
          CASE WHEN v_deve THEN clock_timestamp() END)
  ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;

  IF FOUND THEN
    IF v_deve THEN
      INSERT INTO public.fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
      VALUES (p_company, 'outro', v_sev_forn, p_titulo, COALESCE(p_msg_email, p_msg), 'pendente_notificacao');
      -- ⚠️ INSERT que "tem sucesso" com ZERO linhas (um BEFORE INSERT devolvendo NULL) deixaria
      -- o claim carimbado SEM e-mail — a "escrita que falha calada" do money-path.md §11.
      GET DIAGNOSTICS v_upd = ROW_COUNT;
      IF v_upd <> 1 THEN
        RAISE EXCEPTION 'outbox nao materializou a linha (% gravadas) para %', v_upd, p_tipo
          USING ERRCODE = '25000';
      END IF;
    END IF;
    RETURN v_deve;
  END IF;

  -- ── 2) episódio ABERTO ────────────────────────────────────────────────────────────────────
  -- FOR UPDATE trava a linha ANTES de decidir: uma 2ª sessão bloqueia aqui e, ao destravar,
  -- relê a linha JÁ carimbada (READ COMMITTED) ⇒ deve_notificar = false ⇒ 1 e-mail, não 2.
  SELECT * INTO v_row
    FROM public.fin_alertas
   WHERE company = p_company AND tipo = p_tipo AND dismissed_at IS NULL
   FOR UPDATE;

  -- Dispensa CONCORRENTE entre o INSERT e o SELECT: sem alerta aberto por trás, não se
  -- enfileira e-mail fantasma. ⚠️ LANÇA em vez de devolver `false` (achado Codex E2): o caller
  -- usa PERFORM e não lê o retorno, então um `false` aqui deixaria a fonte DEGRADADA terminar a
  -- rodada SEM episódio ativo e ainda assim carimbar `last_success_at`. Lançando, o isolamento
  -- por check conta a falha e o marcador de sucesso não avança — fail-closed.
  IF NOT FOUND THEN
    -- P0002 (no_data_found) de propósito: é falha LOCAL do check, e a classe 40 seria relançada
    -- como sistêmica pelo isolamento do watchdog, derrubando os outros 16 por uma corrida benigna.
    RAISE EXCEPTION 'episodio de % sumiu entre o INSERT e o lock (dispensa concorrente)', p_tipo
      USING ERRCODE = 'P0002';
  END IF;

  -- ⚠️ RE-LEITURA DEPOIS DO LOCK. A consulta lá em cima rodou ANTES de travar a linha, então
  -- numa corrida ela traz o valor PRÉ-concorrente: a sessão B veria v_ult_email NULL, concluiria
  -- "nunca avisou" e enfileiraria um 2º e-mail. Sob READ COMMITTED, reler após o FOR UPDATE
  -- devolve o que a sessão A commitou — é isto que faz o claim ser de fato atômico.
  SELECT a.email_enfileirado_em, (a.contexto->>'_grav_email')::int
    INTO v_ult_email, v_ult_grav
    FROM public.fin_alertas a
   WHERE a.company = p_company AND a.tipo = p_tipo AND a.email_enfileirado_em IS NOT NULL
   ORDER BY a.email_enfileirado_em DESC
   LIMIT 1;

  v_fp_ant     := v_row.contexto->>'_fp';
  v_fp_email   := v_row.contexto->>'_fp_email';
  -- ⚠️ SEM COALESCE(...,0) de propósito: gravidade AUSENTE é desconhecida, não zero — o
  -- `ausente ≠ zero` do money-path. Com o zero, toda linha HISTÓRICA (contexto sem as âncoras
  -- novas, como os 3 alertas presos de prod) entraria como "escalada" e passaria por cima de
  -- reconhecimento e soneca. Quem nunca notificou não escalou nada: quem trata esse caso é o
  -- ramo `nunca_enfileirou`, que respeita ack/soneca.
  v_grav_email := (v_row.contexto->>'_grav_email')::int;
  v_prox       := CASE WHEN jsonb_typeof(v_row.contexto->'_prox_email_em') = 'string'
                       THEN (v_row.contexto->>'_prox_email_em')::timestamptz END;

  v_ack    := v_row.acknowledged_at IS NOT NULL;
  v_snooze := v_row.dismissed_until IS NOT NULL AND v_row.dismissed_until > clock_timestamp();

  -- ⚠️ REARME NA RECUPERAÇÃO (padrão do tint; a 1ª versão desta migration ESQUECEU de portá-lo e
  -- o Codex pegou). A âncora é o PICO notificado, então sem rearme: broken(23) avisa → melhora
  -- para stale(22) → humano reconhece → volta a broken(23) e `23 > 23` é FALSO ⇒ o ack bloqueia
  -- materialidade e lembrete, e o retorno ao mesmo patamar fica MUDO PARA SEMPRE. Fazendo a
  -- âncora DESCER junto com a melhora, o retorno volta a ser escalada — e escalada supera ack.
  IF v_grav_email IS NOT NULL AND v_grav < v_grav_email THEN
    v_grav_email := v_grav;
  END IF;

  v_escalou := v_grav_email IS NOT NULL AND v_grav > v_grav_email;

  -- ⚠️ "nunca enfileirou" é por TIPO, não por EPISÓDIO (v_ult_email vem da consulta acima, que
  -- atravessa episódios encerrados). Ancorar no episódio faria o anti-flap durar UMA rodada: o
  -- episódio reaberto e silenciado teria email_enfileirado_em NULL e emitiria no tick seguinte,
  -- devolvendo a tempestade pela porta dos fundos.
  v_nunca   := v_ult_email IS NULL;

  -- MATERIALIDADE com confirmação em DUAS avaliações: só conta violação nova cujo fingerprint
  -- se REPETIU (p_fingerprint = _fp da avaliação anterior) e que difere do último NOTIFICADO.
  -- É o que torna a máquina imune a um `message` volátil sem precisar auditar os 17 checks:
  -- fingerprint que muda toda rodada nunca se confirma ⇒ nunca vira e-mail.
  -- `v_fp_email IS NOT NULL` é o par do bullet acima: sem ele, o episódio silenciado pelo
  -- anti-flap (que grava _fp_email NULL) veria "IS DISTINCT FROM NULL" = true e emitiria.
  -- ⚠️ COOLDOWN (achado Codex): a confirmação em 2 avaliações mata `A,B,A,B`, mas NÃO mata
  -- `A,A,B,B,A,A…` — cada par confirma e emite, ~24 e-mails/dia. A confirmação prova repetição
  -- textual, não estabilidade temporal, então o teto tem de ser um RELÓGIO. 4h limita a ~6/dia
  -- no pior caso patológico e ainda reporta violação nova MUITO antes do lembrete (24h/72h).
  v_material := p_fingerprint IS NOT NULL
                AND v_fp_ant IS NOT NULL
                AND v_fp_email IS NOT NULL
                AND p_fingerprint = v_fp_ant
                AND p_fingerprint IS DISTINCT FROM v_fp_email
                AND (v_ult_email IS NULL OR clock_timestamp() >= v_ult_email + v_min_material);

  -- `v_prox IS NULL` = linha SEM as âncoras novas (histórica, ou escrita por versão anterior)
  -- que JÁ tem carimbo de e-mail: sem este bootstrap ela cai em nunca=false, escalou=false,
  -- material=false e lembrete=false — muda para sempre (achado Codex A1). Tratar como lembrete
  -- DEVIDO dá exatamente um e-mail; depois dele as âncoras existem e a cadência assume.
  v_lembrete := v_prox IS NULL OR clock_timestamp() >= v_prox;

  -- Escalada SUPERA reconhecimento e soneca: quem reconheceu um 'aviso' não reconheceu o
  -- 'critico' que veio depois.
  v_deve := v_escalou
            OR ((NOT v_ack) AND (NOT v_snooze) AND (v_nunca OR v_material OR v_lembrete));

  v_motivo := CASE WHEN NOT v_deve   THEN NULL
                   WHEN v_escalou    THEN 'escalada'
                   WHEN v_nunca      THEN 'nunca_enfileirou'
                   WHEN v_material   THEN 'nova_violacao'
                   ELSE                   'lembrete' END;

  -- UPDATE INCONDICIONAL do estado (padrão do tint): o banco reflete SEMPRE o ciclo atual —
  -- uma MELHORA parcial que não atualizasse nada deixaria o alerta mostrando o pico para sempre.
  -- O que a histerese governa é só o E-MAIL.
  UPDATE public.fin_alertas SET
      severidade           = p_sev_fin,
      mensagem             = p_msg,
      acknowledged_at      = CASE WHEN v_escalou THEN NULL ELSE acknowledged_at END,
      acknowledged_by      = CASE WHEN v_escalou THEN NULL ELSE acknowledged_by END,
      email_enfileirado_em = CASE WHEN v_deve THEN clock_timestamp() ELSE email_enfileirado_em END,
      contexto = COALESCE(p_ctx, '{}'::jsonb) || jsonb_build_object(
          '_fp',            p_fingerprint,
          '_fp_ant',        v_fp_ant,
          '_fp_email',      CASE WHEN v_deve THEN p_fingerprint ELSE v_fp_email END,
          '_grav_email',    CASE WHEN v_deve THEN v_grav        ELSE v_grav_email END,
          '_sev_email',     CASE WHEN v_deve THEN p_sev_fin     ELSE v_row.contexto->>'_sev_email' END,
          -- COALESCE no ELSE: sem ele uma linha sem âncora que NÃO emitiu (ack/soneca) ficaria
          -- com _prox_email_em NULL para sempre, e o bootstrap do lembrete nunca se resolveria.
          '_prox_email_em', CASE WHEN v_deve THEN to_jsonb(clock_timestamp() + v_intervalo)
                                 ELSE COALESCE(v_row.contexto->'_prox_email_em',
                                               to_jsonb(clock_timestamp() + v_intervalo)) END,
          '_n_emails',      COALESCE((v_row.contexto->>'_n_emails')::int, 0)
                            + CASE WHEN v_deve THEN 1 ELSE 0 END,
          '_motivo_email',  v_motivo,
          'avaliado_em',    to_jsonb(clock_timestamp()))
   WHERE company = p_company AND tipo = p_tipo AND dismissed_at IS NULL;

  GET DIAGNOSTICS v_upd = ROW_COUNT;
  IF v_upd = 0 THEN
    RETURN false;
  END IF;

  IF v_deve THEN
    -- MESMA transação do carimbo: se o outbox falhar, o claim cai junto — nunca
    -- "email_enfileirado_em preenchido sem e-mail correspondente".
    INSERT INTO public.fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
    VALUES (p_company, 'outro', v_sev_forn,
            CASE WHEN v_escalou THEN 'AGRAVOU: ' || p_titulo ELSE p_titulo END,
            COALESCE(p_msg_email, p_msg), 'pendente_notificacao');
    GET DIAGNOSTICS v_upd = ROW_COUNT;
    IF v_upd <> 1 THEN
      RAISE EXCEPTION 'outbox nao materializou a linha (% gravadas) para %', v_upd, p_tipo
        USING ERRCODE = '25000';
    END IF;
    RETURN true;
  END IF;

  RETURN false;
END;
$function$

;
