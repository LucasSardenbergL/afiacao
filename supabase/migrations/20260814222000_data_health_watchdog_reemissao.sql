-- ============================================================================================
-- Migration — Sentinela: data_health_watchdog para de envelhecer MUDO (máquina de episódio)
-- (2026-08-14 · money-path · spec docs/superpowers/specs/2026-08-14-data-health-watchdog-envelhece-mudo-design.md)
-- ============================================================================================
-- PROBLEMA (medido em prod 2026-08-14): o watchdog (cron */30) enfileirava e-mail só no
--   `IF FOUND` de um `INSERT … ON CONFLICT (company,tipo) WHERE dismissed_at IS NULL DO NOTHING`.
--   Havendo alerta aberto, NADA era atualizado e NENHUM e-mail saía. O primeiro aviso era o único.
--   3 alertas presos há 30/22/20 dias, todos com contexto->>'status' congelado em 'stale', todos
--   sem e-mail desde a criação — e, como a chave é (company,tipo), o preso ENTUPIA o canal:
--   qualquer incidente NOVO do mesmo source ficava mudo (um pedido de R$ 50k travado não avisaria).
--
-- DESENHO (o simples foi REPROVADO pelo Codex xhigh; estes são os 4 pontos exigidos):
--   1. IDENTIDADE/MATERIALIDADE — fingerprint md5(source|status|severity|message). Exclui
--      DE PROPÓSITO age_seconds/expected_max_age/freshness_basis/timestamps: são o que muda a cada
--      cron e dariam 48 e-mails/dia. O `message` carrega a materialidade real (contagem de pedidos
--      + data do mais antigo) e é o ÚNICO carregador disponível sem mexer na assinatura de
--      _data_health_compute (3 dependentes SQL). Auditado no dump vivo de prod: os 4 checks de
--      CONTAGEM do push (age_seconds NULL) não têm now()/current_date em bloco nenhum.
--      ⚠️ SALVAGUARDA que dispensa auditar os 17: a materialidade só conta com o fingerprint
--      CONFIRMADO em DUAS avaliações seguidas (`_fp` = fingerprint da avaliação anterior). Um
--      `message` volátil nunca repete ⇒ NUNCA dispara e-mail por essa via — degrada sozinho para
--      escalada+lembrete, fail-closed por construção, sem allowlist para manter. Custo: até 1 ciclo
--      (30 min) de atraso no e-mail de violação nova. Contra 20 dias de silêncio, é troca barata.
--   2. RESOLUÇÃO ≠ RECONHECIMENTO — `resolvido_em` (só a máquina, e só com status='ok' EXPLÍCITO)
--      × `acknowledged_at/by` (humano: silencia lembrete e materialidade, NÃO silencia escalada)
--      × `dismissed_until` (soneca com vencimento, que agora GOVERNA o produtor)
--      × `dismissed_at` (encerra o episódio — o que o índice parcial enxerga).
--      ⚠️ Hoje "dispensar" tem semântica INVERTIDA: o índice é parcial (WHERE dismissed_at IS NULL),
--      então dispensar REARMA o alerta e não dispensar o silencia para sempre. Por isso a UI muda
--      junto (src/hooks/useCashflowAlertas.ts) — se seguisse gravando dismissed_at, criaria episódio
--      novo a cada cron e contornaria a máquina inteira.
--   3. CLAIM ATÔMICO — SELECT … FOR UPDATE trava a linha antes de decidir; o e-mail é enfileirado
--      na MESMA transação do UPDATE que carimba `email_enfileirado_em`. Duas sessões simultâneas:
--      a 2ª relê a linha já carimbada (READ COMMITTED) ⇒ 1 alerta e 1 outbox. Falha no outbox
--      derruba o claim junto (mesma subtransação) — nunca "carimbou mas não enfileirou".
--   4. CONTRATO FAIL-CLOSED dos 17 checks — status só {ok,stale,broken,unknown} e severity só
--      {critical,warning,info}; qualquer outro valor (inclusive NULL) ABORTA aquele check.
--      ⚠️ Hoje `IF r.status <> 'ok'` com status NULL é FALHA ABERTA: NULL não é <> 'ok', cai no
--      ELSE e DISPENSA o alerta ativo. Aqui um check inválido NÃO resolve nada e fica barulhento.
--      Fonte AUSENTE ⇒ last_success_at não avança. Fonte DUPLICADA ⇒ aborta antes do laço (nada é
--      resolvido). Isolamento por check (subtransação) para que 1 erro não cegue os outros 16 —
--      com DEAD-MAN (data_health_watchdog_estado.last_success_at) + alerta dedicado, porque
--      isolar sem dead-man troca "aborta tudo" por "falha em silêncio".
--
--   5. ANTI-FLAP (achado desta implementação, não da spec) — o desenho acima tem o furo
--      ESPELHO do bug que corrige: se "episódio novo ⇒ e-mail", um check que oscila
--      ok↔degradado a cada tick resolve e reabre 48×/dia e vira TEMPESTADE; e o "dispensar" da
--      UI, que tira a linha do índice parcial, faz o mesmo. Correção: a cadência de e-mail é por
--      (company,tipo) e ATRAVESSA episódios encerrados. Três saídas legítimas do gate — nunca
--      notificado, voltou PIOR do que o notificado, ou a reabertura não é oscilação (a resolução
--      anterior é mais velha que a janela de 2h = 4 ticks). Assim oscilação dá 1 e-mail por
--      cadência, e recorrência de verdade avisa na hora. Episódio silenciado herda o prazo do
--      último e-mail real, então o silêncio tem TETO (24h/72h) e nunca é infinito.
--
-- CRITÉRIO DE REEMISSÃO (âncora contra o último estado NOTIFICADO, nunca contra a rodada anterior):
--   deve_notificar = escalou_gravidade
--                 OR (NÃO reconhecido E NÃO em soneca
--                     E (nunca_enfileirou OR nova_violacao_confirmada OR venceu_lembrete))
--   `gravidade` = rank(severidade)*10 + rank(status): pega stale→broken MESMO com severity literal
--   'warning' (o caso do reposicao_disparo, que não vira critical nem em broken).
--   Lembrete: 24h (crítico) / 72h (aviso e info). Nada de exponencial sem teto — reduzir atenção
--   quando o custo de inação cresce é o contrário do que se quer.
--
-- PADRÃO REUSADO: _tint_watchdog_fase5_transicao (20260730120000) — duas âncoras, UPDATE
--   INCONDICIONAL do estado (o banco reflete SEMPRE o ciclo atual; a histerese governa só o E-MAIL)
--   e UPDATE anti-corrida. O furo que o reuso NÃO cobria: a âncora do tint é uma CONTAGEM, e nos
--   checks de contagem daqui o age_seconds vem NULL — COALESCE(age,0) daria e-mail a cada rodada.
--   Por isso a âncora aqui é fingerprint+gravidade, nunca idade.
--
-- ⚠️ GUARD ANTI-DRIFT + ANTI-ROLLBACK (md5 + marca VERSIONADA, na transação): gerada do
--   pg_get_functiondef VIVO de prod em 2026-08-14 (md5 3ca71a9df5faa9bbb6781fe2d8707fe9).
--   data_health_watchdog é QUENTE multi-sessão; só recria se o corpo vivo for a base esperada OU
--   já for esta versão (marca 'data_health reemissao v1'); senão ABORTA (rebasear sobre o vivo).
--   Regra: versão nova MUDA o marcador (database.md §2 "a última a recriar vence").
--
-- ASSINATURA de _data_health_compute() PRESERVADA (não é tocada aqui): 3 dependentes SQL
--   (fin_sync_heartbeat, get_data_health, este watchdog) quebrariam com DROP+recriar.
--   O 18º check (dead-man no _data_health_compute, para o dashboard e o heartbeat diário verem o
--   marcador envelhecer) fica de FOLLOW-UP: exige substituição programática do corpo de 576 linhas.
--
-- CHALLENGE CODEX (gpt-5.6-sol, xhigh, 2026-08-14) — REPROVOU a 1ª versão desta migration. Os
-- 6 furos que ele achou estão corrigidos aqui, cada um com cenário próprio no harness (K1-K6):
--   [A2] Faltava o REARME NA RECUPERAÇÃO do padrão do tint: a âncora é o PICO notificado, então
--        broken(23)→stale(22)→ack→broken(23) dava `23 > 23` falso e o retorno ficava MUDO PARA
--        SEMPRE sob reconhecimento. A âncora agora DESCE junto com a melhora.
--   [B1] A confirmação em 2 avaliações mata `A,B,A,B` mas NÃO `A,A,B,B,A,A…` (cada par confirma
--        ⇒ ~24 e-mails/dia). Confirmação prova repetição TEXTUAL, não estabilidade temporal —
--        o teto tem de ser relógio: cooldown de 4h na materialidade.
--   [A1] Linha COM carimbo de e-mail e SEM as âncoras novas caía em nunca=false, escalou=false,
--        material=false e lembrete=false ⇒ muda para sempre. Bootstrap: `_prox_email_em` ausente
--        conta como lembrete DEVIDO (1 e-mail, depois a cadência assume).
--   [A3] O `BEGIN/EXCEPTION` do dead-man é subtransação, NÃO transação autônoma: um erro global
--        DEPOIS dele desfazia o próprio alerta do dead-man, a cada 30 min, sem rastro. Agora o
--        compute é isolado e a duplicata não aborta — vira rodada incompleta ALTA. E o dead-man
--        engata também com `last_success_at` NULL (vigia quebrado desde o 1º dia).
--   [E1] O contrato validava só os enums: um check de FRESCOR podia devolver `ok` com idade
--        NULL, RESOLVER o alerta e ainda contar para o 17/17 que carimba o marcador. Idade nula
--        agora só é legítima nos 4 checks de CONTAGEM (lista explícita; fonte nova entra como
--        frescor = fail-closed), e `status=ok` com `severity=critical` é recusado.
--   [E2/D2] `PERFORM` descartava o retorno: a corrida de dispensa terminava a fonte DEGRADADA
--        sem episódio ativo e ainda carimbava sucesso ⇒ agora LANÇA (P0002, falha local). E o
--        INSERT no outbox passou a conferir ROW_COUNT — um BEFORE INSERT devolvendo NULL fazia o
--        comando "ter sucesso" com ZERO linhas, deixando claim carimbado SEM e-mail.
--   [F]  `WHEN OTHERS` engolia falha SISTÊMICA (permissão, tabela ausente, deadlock, recursos,
--        erro interno) 17× — trocava 1 erro alto por 17 silêncios. Classes 40/53/57/58/XX são
--        RELANÇADAS; isolamento vale só para falha local.
--
-- PROVA PG17 (falsificada em LC_ALL=C e pt_BR.UTF-8): db/test-data-health-watchdog-reemissao.sh
-- 85 asserts · 10 sabotagens, cada uma PROVANDO que aplicou antes de valer como vermelho.
--
-- FOLLOW-UP conhecido (não bloqueia): `alert_channel` está no compute mas fora do push, então
-- fila presa/dispatcher morto não impede o 17/17 — o watchdog prova que ENFILEIROU, não que o
-- e-mail saiu. Promovê-lo ao push é decisão de produto, com migration própria.
-- ============================================================================================

BEGIN;

DO $guard$
DECLARE
  v_def text;
  v_md5 text;
BEGIN
  IF to_regprocedure('public.data_health_watchdog()') IS NULL THEN
    RAISE EXCEPTION USING message =
      'PRE-FLIGHT ABORTOU: public.data_health_watchdog() não existe neste banco. '
      || 'Esta migration RECRIA o watchdog — aplicar num banco sem ele criaria uma versão órfã '
      || 'sem os checks. Aplique antes a cadeia que o cria (20260611140000 / 20260611210000).';
  END IF;

  v_def := pg_get_functiondef('public.data_health_watchdog()'::regprocedure);
  v_md5 := md5(v_def);
  IF v_md5 <> '3ca71a9df5faa9bbb6781fe2d8707fe9' AND v_def NOT LIKE '%data_health reemissao v1%' THEN
    RAISE EXCEPTION USING message =
      'PRE-FLIGHT ABORTOU: data_health_watchdog vivo (md5 ' || v_md5 || ') não é a base esperada '
      || '(dump 2026-08-14, md5 3ca71a9df5faa9bbb6781fe2d8707fe9) nem contém o marcador '
      || '''data_health reemissao v1''. Outra migration recriou a função depois que esta foi gerada '
      || '(se for uma SUCESSORA legítima, é ela que deve rodar — NÃO re-aplique esta). '
      || 'Rebasear sobre o pg_get_functiondef atual e re-gerar.';
  END IF;
END
$guard$;

-- ── Estado do episódio em fin_alertas ───────────────────────────────────────────────────────
-- email_enfileirado_em e dismissed_until JÁ EXISTEM (a 20260530140000 as criou para o
-- fin_sync_watchdog_check, que as usa em tipos 'sync_%' — sem colisão com 'data_health_%').
ALTER TABLE public.fin_alertas
  ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS acknowledged_by uuid,
  ADD COLUMN IF NOT EXISTS resolvido_em    timestamptz;

COMMENT ON COLUMN public.fin_alertas.acknowledged_at IS
  'Reconhecimento HUMANO: silencia lembrete e nova-violação, NÃO silencia escalada de gravidade. Zerado quando a gravidade sobe (a severidade nova exige reconhecimento novo).';
COMMENT ON COLUMN public.fin_alertas.resolvido_em IS
  'Resolução AUTOMÁTICA pela máquina, só com status=''ok'' explícito. dismissed_at sem resolvido_em = encerramento humano/administrativo.';

-- ── Dead-man do watchdog ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.data_health_watchdog_estado (
  id               boolean PRIMARY KEY DEFAULT true CHECK (id),   -- singleton
  last_run_at      timestamptz,
  last_success_at  timestamptz,
  checks_avaliados int,
  checks_falhos    int,
  ultimo_erro      text,
  atualizado_em    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.data_health_watchdog_estado IS
  'Dead-man do data_health_watchdog. last_success_at só avança em rodada COMPLETA (17/17 fontes presentes, 0 checks falhos) — envelhecer é o sinal de que o vigia está cego.';

ALTER TABLE public.data_health_watchdog_estado ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "data_health_watchdog_estado_select_staff" ON public.data_health_watchdog_estado;
CREATE POLICY "data_health_watchdog_estado_select_staff"
  ON public.data_health_watchdog_estado
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = (SELECT auth.uid())
        AND role IN ('employee'::public.app_role, 'master'::public.app_role)
    )
  );

DROP POLICY IF EXISTS "data_health_watchdog_estado_service_all" ON public.data_health_watchdog_estado;
CREATE POLICY "data_health_watchdog_estado_service_all"
  ON public.data_health_watchdog_estado
  FOR ALL
  USING ((SELECT auth.role()) = 'service_role');

-- ── A máquina de episódio ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._data_health_episodio(
  p_company     text,
  p_tipo        text,
  p_status      text,
  p_sev_fin     text,
  p_titulo      text,
  p_msg         text,
  p_msg_email   text,
  p_ctx         jsonb,
  p_fingerprint text
)
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
$function$;

REVOKE ALL ON FUNCTION public._data_health_episodio(text,text,text,text,text,text,text,jsonb,text) FROM PUBLIC, anon, authenticated;

-- ── O watchdog ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.data_health_watchdog()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- data_health reemissao v1 (mig 20260814222000) — MARCADOR do guard anti-rollback.
DECLARE
  -- ⚠️ estoque_reposicao: 18º check, adicionado DIRETO EM PROD (migration fora do repo, drift §5),
  --    promovido ao push (watchdog+heartbeat) lá. PRESERVADO aqui pra não revertê-lo do e-mail.
  -- ⚠️ tint_vinculo_omie fica FORA de propósito (dashboard-only, [VIGIA tint 2026-06-15]).
  -- Esta ARRAY é a fonte única: filtra o compute E define o esperado do dead-man. Duas listas
  -- separadas driftariam, e o dead-man passaria a medir a própria omissão como sucesso.
  v_sources text[] := ARRAY[
    'vendas_pedidos','estoque_inventario','estoque_reposicao','reposicao_sugestoes','carteira_scores',
    'custos_produtos','vendas_cadastros',
    'reposicao_disparo','reposicao_portal_pipeline','reposicao_portal_humano',
    'reposicao_sayerlack_fabricado','omie_tipo_produto_oben','vendas_familia_ausente',
    'tint_cobertura_bases',
    'custos_proxy_conf_alta','custos_product_cost_revivido','pedidos_compra_sync'];
  -- Os 4 checks de CONTAGEM do push — os únicos onde `age_seconds` NULL é legítimo (medido no
  -- dump vivo de prod, 2026-08-14). Fonte NOVA entra como frescor: se ela devolver idade nula,
  -- o check falha alto em vez de resolver alerta em cima de conta quebrada.
  v_sources_contagem text[] := ARRAY[
    'reposicao_sayerlack_fabricado','vendas_familia_ausente',
    'custos_proxy_conf_alta','custos_product_cost_revivido'];
  v_deadman_h int := 3;   -- cron é */30 ⇒ 3h = 6 rodadas completas perdidas
  r           record;
  v_rows      jsonb;
  v_n         int;
  v_ndist     int;
  v_esperado  int := array_length(v_sources, 1);
  v_completa  boolean;
  v_sev_fin   text;
  v_fp        text;
  v_msg_email text;
  v_falhos    int := 0;
  v_erros     text[] := '{}';
  v_last_ok   timestamptz;
  v_last_run  timestamptz;
  v_cego      boolean;
  v_msg_dm    text;
BEGIN
  -- ── DEAD-MAN (avalia o estado da rodada ANTERIOR, antes de sobrescrevê-lo) ────────────────
  SELECT last_success_at, last_run_at INTO v_last_ok, v_last_run
    FROM public.data_health_watchdog_estado WHERE id;

  -- ⚠️ O ramo `last_success_at IS NULL` é obrigatório (achado Codex A3): um vigia que NUNCA
  -- completou uma rodada tem marcador nulo, e ancorar só no marcador o deixaria calado
  -- exatamente no cenário pior — quebrado desde o primeiro dia.
  v_cego := (v_last_ok IS NOT NULL AND v_last_ok < clock_timestamp() - make_interval(hours => v_deadman_h))
         OR (v_last_ok IS NULL AND v_last_run IS NOT NULL
             AND v_last_run < clock_timestamp() - make_interval(hours => v_deadman_h));

  IF v_cego THEN
    v_msg_dm := 'Vigia de saúde de dados sem rodada COMPLETA desde '
             || COALESCE(to_char(v_last_ok AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI'), 'NUNCA')
             || ' — os checks estão sendo avaliados parcialmente e um incidente pode passar mudo.';
    -- Isolado: se o OUTBOX estiver fora, o meta-alerta não pode derrubar a avaliação dos 17
    -- checks. O sinal que sobrevive a um outbox morto é o marcador envelhecendo, não o e-mail.
    BEGIN
      PERFORM public._data_health_episodio(
        'oben', 'data_health_watchdog_degradado', 'broken', 'critico',
        '[Saúde de dados] vigia degradado', v_msg_dm, NULL,
        jsonb_build_object('last_success_at', v_last_ok, 'limite_horas', v_deadman_h),
        -- fingerprint ancorado no MINUTO do último sucesso: estável enquanto o vigia seguir cego
        -- (senão o próprio dead-man viraria a tempestade que ele existe para denunciar).
        md5('deadman|' || COALESCE(to_char(v_last_ok, 'YYYY-MM-DD"T"HH24:MI'), 'nunca')));
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'data_health_watchdog: dead-man nao pode ser enfileirado: % %', SQLSTATE, SQLERRM;
    END;
  ELSIF v_last_ok IS NOT NULL THEN
    UPDATE public.fin_alertas SET dismissed_at = now(), resolvido_em = now()
     WHERE company = 'oben' AND tipo = 'data_health_watchdog_degradado' AND dismissed_at IS NULL;
  END IF;

  INSERT INTO public.data_health_watchdog_estado (id, last_run_at, atualizado_em)
  VALUES (true, clock_timestamp(), clock_timestamp())
  ON CONFLICT (id) DO UPDATE SET last_run_at = clock_timestamp(), atualizado_em = clock_timestamp();

  -- Materializa UMA execução do compute (é caro; e duas execuções poderiam divergir entre a
  -- checagem de duplicata e o laço).
  -- ⚠️ ISOLADO, e o laço fica CONDICIONADO ao sucesso (achado Codex A3): o `BEGIN/EXCEPTION` do
  -- dead-man é subtransação, NÃO transação autônoma — um erro global DEPOIS dele (compute
  -- quebrado, fonte duplicada) abortava a transação inteira e desfazia o próprio alerta do
  -- dead-man, repetindo isso a cada 30 min sem deixar rastro nenhum.
  v_rows := NULL;
  BEGIN
    SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_rows
      FROM public._data_health_compute() t
     WHERE t.source = ANY (v_sources);
  EXCEPTION WHEN OTHERS THEN
    IF left(SQLSTATE, 2) IN ('40','53','57','58','XX') THEN
      RAISE;
    END IF;
    v_falhos := v_falhos + 1;
    v_erros  := v_erros || ('_data_health_compute: ' || SQLSTATE || ' ' || SQLERRM);
  END;

  IF v_rows IS NULL THEN
    v_n := 0; v_ndist := 0;
  ELSE
    SELECT count(*), count(DISTINCT x.source) INTO v_n, v_ndist
      FROM jsonb_to_recordset(v_rows) AS x(source text);

    -- Fonte DUPLICADA: o compute está quebrado. NÃO se avalia nada (nenhum alerta ativo pode ser
    -- resolvido com base em dado que não se pode julgar) — mas também NÃO se aborta a transação,
    -- senão o registro de estado e o meta-alerta iriam junto. Vira rodada incompleta, alta.
    IF v_n <> v_ndist THEN
      v_falhos := v_falhos + 1;
      v_erros  := v_erros || ('_data_health_compute: fonte duplicada (' || v_n || ' linhas, '
                              || v_ndist || ' fontes distintas) — laço NAO executado');
      v_rows   := NULL;
    END IF;
  END IF;

  v_completa := (v_rows IS NOT NULL AND v_n = v_esperado);

  FOR r IN
    SELECT * FROM jsonb_to_recordset(COALESCE(v_rows, '[]'::jsonb)) AS x(
      source text, "domain" text, status text, age_seconds bigint,
      expected_max_age_seconds bigint, freshness_basis text, message text,
      last_error text, probable_cause text, how_to_fix text, severity text)
  LOOP
    -- Isolamento por check: um erro em 1 não pode cegar os outros 16. O preço do isolamento é
    -- o silêncio — pago pelo dead-man + alerta dedicado abaixo.
    BEGIN
      IF r.status IS NULL OR r.status NOT IN ('ok','stale','broken','unknown') THEN
        RAISE EXCEPTION 'status desconhecido em %: %', r.source, COALESCE(r.status,'<NULL>')
          USING ERRCODE = '22023';
      END IF;
      IF r.severity IS NULL OR r.severity NOT IN ('critical','warning','info') THEN
        RAISE EXCEPTION 'severity desconhecida em %: %', r.source, COALESCE(r.severity,'<NULL>')
          USING ERRCODE = '22023';
      END IF;
      -- ⚠️ `age_seconds` NULL só é LEGÍTIMO nos checks de CONTAGEM (achado Codex E1). Num check
      -- de FRESCOR, idade nula com veredito 'ok' é a conta de frescor quebrada se passando por
      -- saúde: RESOLVERIA o alerta ativo e ainda contaria para o 17/17 que carimba o marcador.
      -- ⚠️ O recorte é SÓ no ramo 'ok'. Um check de frescor legitimamente `broken` porque a
      -- fonte NUNCA sincronizou devolve idade NULL (`max(...)` nulo ⇒ `EXTRACT` nulo) — barrar
      -- ali trocaria um alerta ESPECÍFICO e acionável por um genérico "vigia com check
      -- falhando", que é pior do que o bug. Fonte nova entra como frescor (fail-closed).
      IF r.status = 'ok' AND r.age_seconds IS NULL AND NOT (r.source = ANY (v_sources_contagem)) THEN
        RAISE EXCEPTION 'check de frescor % devolveu ok com age_seconds NULL (conta de frescor quebrada)', r.source
          USING ERRCODE = '22023';
      END IF;
      IF r.status = 'ok' AND r.severity = 'critical' THEN
        RAISE EXCEPTION 'check % devolveu combinacao contraditoria: status=ok com severity=critical', r.source
          USING ERRCODE = '22023';
      END IF;

      IF r.status = 'ok' THEN
        -- Resolução AUTOMÁTICA: só com 'ok' EXPLÍCITO. NULL/desconhecido nunca chega aqui.
        UPDATE public.fin_alertas SET dismissed_at = now(), resolvido_em = now()
         WHERE company = 'oben' AND tipo = 'data_health_' || r.source AND dismissed_at IS NULL;
      ELSE
        v_sev_fin := CASE r.severity WHEN 'critical' THEN 'critico'
                                     WHEN 'warning'  THEN 'aviso'
                                     ELSE 'info' END;

        -- FINGERPRINT: source|status|severity|message. Sem idade, sem timestamp, sem basis.
        v_fp := md5(r.source || '|' || r.status || '|' || r.severity || '|' || COALESCE(r.message, ''));

        -- DELTA [2026-07-08]: família-ausente e tint_cobertura_bases anexam a lista dos produtos
        -- ao corpo do e-mail. COALESCE p/ não anexar se vier NULL. A lista fica FORA do
        -- fingerprint de propósito (é volátil e enorme; a materialidade já está na contagem).
        v_msg_email := CASE
          WHEN r.source = 'vendas_familia_ausente'
            THEN r.message || COALESCE(E'\n\n' || public._vendas_familia_ausente_lista_email(50), '')
          WHEN r.source = 'tint_cobertura_bases'
            THEN r.message || COALESCE(E'\n\n' || public._tint_cobertura_bases_lista_email(50), '')
          ELSE r.message END;

        PERFORM public._data_health_episodio(
          'oben', 'data_health_' || r.source, r.status, v_sev_fin,
          '[Saúde de dados] ' || r.source, r.message, v_msg_email,
          jsonb_build_object('source', r.source, 'domain', r.domain, 'status', r.status,
                             'age_seconds', r.age_seconds, 'freshness_basis', r.freshness_basis),
          v_fp);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- ⚠️ `WHEN OTHERS` ENGOLE falha SISTÊMICA (achado Codex F): permissão negada, tabela/coluna
      -- inexistente, deadlock, disco cheio, erro interno — nada disso é "problema daquele check",
      -- e engolir 17× troca um erro alto por 17 silêncios. Isolamento vale para falha LOCAL;
      -- classe 40 (rollback/serialização), 53 (recursos), 57 (intervenção), 58 (sistema) e XX
      -- (interno) são relançadas e derrubam a rodada inteira, alto e visível.
      IF left(SQLSTATE, 2) IN ('40','53','57','58','XX') THEN
        RAISE;
      END IF;
      v_falhos := v_falhos + 1;
      v_erros  := v_erros || (COALESCE(r.source,'<?>') || ': ' || SQLSTATE || ' ' || SQLERRM);
    END;
  END LOOP;

  -- ── Marcador de sucesso: só avança em rodada COMPLETA e SEM falha ─────────────────────────
  UPDATE public.data_health_watchdog_estado SET
      checks_avaliados = v_n,
      checks_falhos    = v_falhos,
      ultimo_erro      = CASE WHEN v_falhos = 0 AND v_completa THEN NULL
                              ELSE left(array_to_string(v_erros, ' || '), 4000) END,
      last_success_at  = CASE WHEN v_falhos = 0 AND v_completa THEN clock_timestamp()
                              ELSE last_success_at END,
      atualizado_em    = clock_timestamp()
   WHERE id;

  -- Falha BARULHENTA (não silenciosa): o isolamento por check só é aceitável com este alerta.
  IF v_falhos > 0 OR NOT v_completa THEN
    -- Isolado pelo mesmo motivo do dead-man: quando o próprio canal de e-mail é o que quebrou,
    -- este INSERT também quebra — e derrubar a transação aqui APAGARIA o UPDATE de estado
    -- acima, que é justamente a evidência durável de que a rodada foi ruim.
    BEGIN
      PERFORM public._data_health_episodio(
        'oben', 'data_health_watchdog_erro', 'broken', 'critico',
        '[Saúde de dados] vigia com check falhando',
        'Rodada incompleta do vigia: ' || v_n || ' de ' || v_esperado || ' fonte(s) presente(s), '
          || v_falhos || ' check(s) com erro. ' || COALESCE(left(array_to_string(v_erros, ' || '), 800), ''),
        NULL,
        jsonb_build_object('checks_avaliados', v_n, 'checks_esperados', v_esperado,
                           'checks_falhos', v_falhos, 'erros', to_jsonb(v_erros)),
        md5('vigia_erro|' || v_n::text || '|' || v_falhos::text || '|' || array_to_string(v_erros, '||')));
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'data_health_watchdog: alerta de erro nao pode ser enfileirado: % %', SQLSTATE, SQLERRM;
    END;
    RAISE WARNING 'data_health_watchdog: % check(s) falharam; % de % fontes presentes',
      v_falhos, v_n, v_esperado;
  ELSE
    UPDATE public.fin_alertas SET dismissed_at = now(), resolvido_em = now()
     WHERE company = 'oben' AND tipo = 'data_health_watchdog_erro' AND dismissed_at IS NULL;
  END IF;
END;
$function$;

COMMIT;
