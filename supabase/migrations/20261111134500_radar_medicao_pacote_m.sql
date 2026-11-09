-- =============================================================================
-- Radar, pacote M: medir a adoção COM denominador (o universo de vendedores, a reposição do card, a intenção de
-- contato, o placar sem tela e a retenção dos eventos de medição)
-- =============================================================================
-- Por que (medido em PROD por psql-ro em 2026-11-08): 64.299 eventos 'automatica' em radar_eventos (o descarte da
-- Receita, 1 por contato automático) só para alimentar radar_placar_uso(), que não tem nenhuma chamada no app; 5
-- contatos humanos e 37 aberturas em 4 meses; 0 linha em radar_lead_aberturas, radar_prospectar_hoje_servido e
-- radar_atendimentos. A fase seguinte do Radar exige sinal de uso COM DENOMINADOR desta fase
-- (docs/historico/fase-sem-sinal.md), e o painel do pacote H (20261107233000) tinha três buracos nesse denominador.
--
-- O que muda:
--   M1 O UNIVERSO: radar_funil passa a listar TODO vendedor elegível agora (private.cap_radar_prospectar), com zeros
--      explícitos nas linhas. Antes a população nascia de eventos, envios e config ativa: o elegível sem atividade
--      sumia do painel, e "ninguém usa" ficava igual a "ninguém tem acesso". Chave nova `adocao`: por vendedor,
--      elegível, quando foi exposto, a 1ª ação humana, quantos dias teve ação (uso em OUTRO dia = 2 ou mais).
--   M2 A REPOSIÇÃO DO CARD: public.radar_card_exibicoes guarda CADA CNPJ exibido no card "Prospectar hoje" (1 por
--      vendedor, dia e CNPJ), inclusive os que entram depois de um Assumir. Antes ficava só a 1ª quantidade do dia
--      (radar_prospectar_hoje_servido.n_leads): 3 servidos e 6 cliques davam 200 %, e o painel culpava o sensor.
--      Escritor único: public.radar_registrar_card_exibido(cnpjs[]). O painel ganha card_leads_exibidos e
--      card_leads_clicados_exibidos (clique em CNPJ exibido no mesmo dia: numerador ⊂ denominador por construção).
--   M3 A INTENÇÃO DE CONTATO: ligar pelo celular, abrir o WhatsApp e copiar o telefone viram evento 'intencao' em
--      radar_eventos (acao = ligar | whatsapp | copiar; 1 por vendedor, CNPJ, canal e dia). Antes só o track() do
--      PostHog, que é cego no navegador do founder; o WhatsApp nem isso. Escritor: public.radar_registrar_intencao().
--      O painel conta `intencoes` por semana e vendedor, e a intenção conta como ação humana na adoção.
--   M4 O PLACAR SEM TELA — DECISÃO (docs/historico/radar-medicao-pacote-m-2026-11-09.md):
--      • radar_placar_uso() SAI (DROP): a adoção com universo (M1) responde o que ele respondia, na tela; o resto
--        dele era a contagem de eventos automáticos e uma reconciliação que contaria cada descarte automático como
--        "contato sem evento" depois do M4b.
--      • radar_coorte_resultado() e radar_conversao_por_faixa() FICAM (o experimento da coorte segue aberto: sem
--        dado, nada se conclui) e ganham tela: a aba "Uso" do /radar/funil, pela RPC nova
--        public.radar_funil_experimento() (gate de master/gestor; à parte porque custa ~0,8 s em prod).
--      • M4b private.radar_evento_contato PARA de gravar o contato AUTOMÁTICO (e o desfazer dele): nenhum leitor
--        sobra para eles. O contato humano segue idêntico (com a nota no registro).
--   M5 RETENÇÃO: private.radar_expurgar_medicao(), diária por cron (radar-expurgo-medicao-diario, 07:20 UTC), em
--      lotes. Apaga: radar_eventos automáticos (todos, em lotes de 20 mil por rodada); 'abriu' e 'intencao' humanos
--      com mais de 400 dias; radar_lead_aberturas, radar_card_exibicoes e radar_prospectar_hoje_servido com mais de
--      400 dias; radar_sensor_falhas com mais de 180 dias. Contato, desfazer e cadastro HUMANOS ficam (são o ledger
--      de decisão, e a coorte os lê desde o sorteio). O painel lê no máximo 26 semanas.
--
-- Molde TRAVA → PRE → CREATE → PÓS. Sem BEGIN/COMMIT no arquivo: a transação é do executor (`bun run db:aplicar`).
-- No SQL Editor, cole entre BEGIN; e COMMIT;. DDL destrutivo (DROP FUNCTION, DELETE pelo cron): aplica o founder.
-- Prova PG17: db/test-radar-medicao.sh (--falsificar).
-- =============================================================================

-- ── TRAVA ────────────────────────────────────────────────────────────────────────────────────────────────
DO $trava$
BEGIN
  IF to_regclass('public.radar_funil_sensores') IS NULL OR to_regclass('public.radar_sensor_falhas') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: aplique o pacote H (20261107233000_radar_funil_painel) antes';
  END IF;
  IF to_regclass('public.radar_lead_aberturas') IS NULL OR to_regclass('public.radar_prospectar_hoje_servido') IS NULL
     OR to_regclass('public.radar_email_vendedor_envios') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: tabelas do pacote D ausentes (20261106181000)';
  END IF;
  IF to_regclass('public.radar_eventos') IS NULL OR to_regclass('public.radar_coorte_controle') IS NULL
     OR to_regclass('public.radar_contatos') IS NULL OR to_regclass('public.radar_empresas') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: radar_eventos/radar_coorte_controle ausente (20261029150100)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                    AND table_name = 'radar_atendimentos' AND column_name = 'atribuido_por') THEN
    RAISE EXCEPTION 'TRAVA FALHOU: radar_atendimentos.atribuido_por ausente (pacote B5)';
  END IF;
  IF to_regprocedure('private.cap_radar_prospectar(uuid)') IS NULL
     OR to_regprocedure('private.pode_ver_carteira_completa(uuid)') IS NULL
     OR to_regprocedure('public.radar_coorte_resultado()') IS NULL
     OR to_regprocedure('public.radar_conversao_por_faixa()') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: cap_radar_prospectar, pode_ver_carteira_completa, radar_coorte_resultado ou radar_conversao_por_faixa ausente';
  END IF;
  -- ALTER sem efeito (COST, que a PRE não confere e o CREATE OR REPLACE reaplica): prende cada função recriada ou
  -- dropada até o COMMIT, antes de a PRE ler o corpo.
  ALTER FUNCTION public.radar_funil(integer) COST 100;
  ALTER FUNCTION private.radar_evento_contato() COST 100;
  IF to_regprocedure('public.radar_placar_uso()') IS NOT NULL THEN
    ALTER FUNCTION public.radar_placar_uso() COST 100;
  END IF;
  IF to_regprocedure('public.radar_registrar_card_exibido(text[])') IS NOT NULL THEN
    ALTER FUNCTION public.radar_registrar_card_exibido(text[]) COST 100;
  END IF;
  IF to_regprocedure('public.radar_registrar_intencao(text,text)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_registrar_intencao(text, text) COST 100;
  END IF;
  IF to_regprocedure('public.radar_funil_experimento()') IS NOT NULL THEN
    ALTER FUNCTION public.radar_funil_experimento() COST 100;
  END IF;
  IF to_regprocedure('private.radar_expurgar_medicao(integer)') IS NOT NULL THEN
    ALTER FUNCTION private.radar_expurgar_medicao(integer) COST 100;
  END IF;
END
$trava$;

-- ── PRE: corpo vivo ∈ {predecessor revisado (PROD 2026-11-08, psql-ro), este arquivo} ─────────────────────
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT v.alvo, v.predecessor, v.este, v.pode_faltar,
           (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v.alvo)) AS vivo
      FROM (VALUES
        ('public.radar_funil(integer)',
         '05a8d54a7f86de4a43c3f1f7414ae0d9', 'fb09ceea1ad40a78dc471b3a5e4ec95d', false),
        ('private.radar_evento_contato()',
         'a2a62eada5b026bc5bf2c3a8cb83df3d', '3c500687d276fbb1cfea19ebcaa9a316', false),
        ('public.radar_placar_uso()',
         'f648bcff995f7b4db87b2bd829831cbc', NULL, true),                                         -- sai aqui
        ('public.radar_registrar_card_exibido(text[])', NULL, 'd98067fa9baededff8af98de6cb4001d', true),   -- nasce aqui
        ('public.radar_registrar_intencao(text,text)', NULL, '108d88bad7b3dac38074748f76cede99', true),        -- nasce aqui
        ('public.radar_funil_experimento()', NULL, 'f4d8024105bdf73b777e9200bb7ff26e', true),               -- nasce aqui
        ('private.radar_expurgar_medicao(integer)', NULL, '398268b3a365066ea7c99964dc9530ea', true)             -- nasce aqui
      ) AS v(alvo, predecessor, este, pode_faltar)
  LOOP
    IF r.vivo IS NULL THEN
      IF NOT r.pode_faltar THEN
        RAISE EXCEPTION 'PRE FALHOU: % ausente', r.alvo;
      END IF;
    ELSIF r.vivo IS DISTINCT FROM r.predecessor AND r.vivo IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) não é o predecessor revisado nem este — outra sessão mudou; refaça o pré-voo', r.alvo, r.vivo;
    END IF;
  END LOOP;
END
$pre$;

-- ── M3a. radar_eventos aceita a intenção de contato ─────────────────────────────────────────────────────────
-- NOT VALID + VALIDATE: o ADD não varre a tabela segurando o ACCESS EXCLUSIVE; o VALIDATE varre com SHARE UPDATE
-- EXCLUSIVE (os triggers do ledger continuam gravando).
ALTER TABLE public.radar_eventos DROP CONSTRAINT IF EXISTS radar_eventos_evento_check;
ALTER TABLE public.radar_eventos ADD CONSTRAINT radar_eventos_evento_check
  CHECK (evento IN ('abriu', 'contato', 'contato_desfeito', 'cadastrou', 'intencao')) NOT VALID;
ALTER TABLE public.radar_eventos VALIDATE CONSTRAINT radar_eventos_evento_check;
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'radar_eventos_intencao_forma'
                    AND conrelid = 'public.radar_eventos'::regclass) THEN
    ALTER TABLE public.radar_eventos ADD CONSTRAINT radar_eventos_intencao_forma
      CHECK (evento <> 'intencao' OR (origem = 'humano' AND cnpj IS NOT NULL AND acao IN ('ligar', 'whatsapp', 'copiar')))
      NOT VALID;
    ALTER TABLE public.radar_eventos VALIDATE CONSTRAINT radar_eventos_intencao_forma;
  END IF;
END
$chk$;
COMMENT ON TABLE public.radar_eventos IS
  'Ledger dos fatos decisórios do Radar (abriu/contato/contato_desfeito/cadastrou/intencao). Escritores: os triggers private.radar_evento_* (contato humano, cadastro, abertura) e public.radar_registrar_intencao() (ligar/whatsapp/copiar). O contato AUTOMÁTICO (descarte da Receita) não grava desde 20261111134500. Retenção: private.radar_expurgar_medicao() (cron diário). Lido por radar_funil(), radar_coorte_resultado() e radar_conversao_por_faixa().';

-- ── M4b. O contato automático deixa de virar evento ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.radar_evento_contato()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_sistema constant uuid := '00000000-0000-0000-0000-00000000ad0f';  -- Radar · RFB (finalize do lote)
BEGIN
  -- Contato automático (descarte da Receita, ~64 mil por lote) e o desfazer dele: nenhum leitor do ledger os usa
  -- desde o pacote M (20261111134500). Só o humano vira evento.
  IF TG_OP = 'INSERT' AND NEW.criado_por = c_sistema THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' AND OLD.criado_por = c_sistema THEN RETURN OLD; END IF;
  BEGIN
    IF TG_OP = 'INSERT' THEN
      -- A nota é a da linha NESTE instante (o cron das 03:30 é o único escritor dela; o contato não a muda).
      INSERT INTO public.radar_eventos
        (evento, origem, ocorrido_em, user_id, cnpj, contato_id, acao, nota_capturada, score, score_versao, score_em, fonte_id)
      SELECT 'contato', 'humano', NEW.created_at, NEW.criado_por, NEW.cnpj, NEW.id, NEW.acao, true,
             e.score, e.score_versao, e.score_em, 'contato:' || NEW.id
        FROM (SELECT 1) AS um
        LEFT JOIN public.radar_empresas e ON e.cnpj = NEW.cnpj
      ON CONFLICT (fonte_id) DO NOTHING;
      RETURN NEW;
    END IF;
    -- DELETE: desfazer_contato_radar só apaga o contato do próprio criado_por.
    INSERT INTO public.radar_eventos (evento, origem, ocorrido_em, user_id, cnpj, contato_id, acao, fonte_id)
    VALUES ('contato_desfeito', 'humano', clock_timestamp(), OLD.criado_por, OLD.cnpj, OLD.id, OLD.acao, 'desfeito:' || OLD.id)
    ON CONFLICT (fonte_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    -- Fail-open: o contato vale mais que a telemetria. A perda aparece na reconciliação de radar_funil().
    RAISE WARNING 'radar_eventos: contato % não registrado (%: %)',
      CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE OLD.id END, SQLSTATE, left(SQLERRM, 120);
  END;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  RETURN OLD;
END
$function$;

-- ── M2a. Os CNPJs exibidos no card ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.radar_card_exibicoes (
  user_id    uuid NOT NULL,
  dia        date NOT NULL,
  cnpj       text NOT NULL,
  posicao    smallint NOT NULL CHECK (posicao BETWEEN 1 AND 50),
  exibido_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, dia, cnpj)
);
CREATE INDEX IF NOT EXISTS idx_radar_card_exibicoes_dia ON public.radar_card_exibicoes (dia);
COMMENT ON TABLE public.radar_card_exibicoes IS
  'Radar M: cada CNPJ que o card "Prospectar hoje" exibiu ao próprio vendedor, 1 por (vendedor, dia, CNPJ) — inclusive os que entram depois de um Assumir. Denominador do clique no card. Escritor único: radar_registrar_card_exibido(). Retenção 400 dias. Migration 20261111134500.';
ALTER TABLE public.radar_card_exibicoes ENABLE ROW LEVEL SECURITY;
-- Sem policy de propósito (como as tabelas dos pacotes D e H): o front só passa pelas RPCs.
REVOKE ALL ON public.radar_card_exibicoes FROM PUBLIC, anon, authenticated;

-- Sensores novos. instalado_em NULL: a cobertura começa no 1º registro (o front que escreve chega no Publish).
INSERT INTO public.radar_funil_sensores (sensor, ordem, rotulo, instalado_em, fonte) VALUES
  ('card_exibido', 10::smallint, 'Leads exibidos no card', NULL::timestamptz,
   'front ProspectarHojeCard → radar_registrar_card_exibido (cada CNPJ, inclusive a reposição)'),
  ('intencao',     11::smallint, 'Intenção de contato (ligar, WhatsApp, copiar)', NULL::timestamptz,
   'front ficha do Radar → radar_registrar_intencao → radar_eventos (intencao)')
ON CONFLICT (sensor) DO NOTHING;

-- ── M2b. Escritor das exibições ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.radar_registrar_card_exibido(p_cnpjs text[])
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid   uuid := (SELECT auth.uid());
  v_dia   date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_n     integer;
  v_novos integer;
BEGIN
  IF NOT COALESCE(private.cap_radar_prospectar(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  v_n := COALESCE(cardinality(p_cnpjs), 0);
  IF v_n NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'cnpjs fora de 1..20: %', v_n USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_cnpjs) c WHERE c IS NULL OR btrim(c) = '') THEN
    RAISE EXCEPTION 'cnpj vazio' USING ERRCODE = '22023';
  END IF;

  -- Só CNPJ que existe no Radar (o card só mostra lead dele): lixo não infla o denominador. A posição é a 1ª de
  -- cada CNPJ no pedido; a do 1º registro do dia fica (ON CONFLICT DO NOTHING).
  INSERT INTO public.radar_card_exibicoes (user_id, dia, cnpj, posicao)
  SELECT v_uid, v_dia, x.cnpj, LEAST(x.pos, 50)::smallint
    FROM (SELECT btrim(u.c) AS cnpj, min(u.ord) AS pos
            FROM unnest(p_cnpjs) WITH ORDINALITY AS u(c, ord)
           GROUP BY btrim(u.c)) x
   WHERE EXISTS (SELECT 1 FROM public.radar_empresas e WHERE e.cnpj = x.cnpj)
  ON CONFLICT (user_id, dia, cnpj) DO NOTHING;
  GET DIAGNOSTICS v_novos = ROW_COUNT;

  -- O "dia com card" do pacote D segue vivo (card_dias): 1 linha por dia, a quantidade da 1ª exibição.
  INSERT INTO public.radar_prospectar_hoje_servido (user_id, dia, n_leads)
  VALUES (v_uid, v_dia, LEAST(v_n, 5)::smallint)
  ON CONFLICT (user_id, dia) DO NOTHING;

  RETURN jsonb_build_object('ok', true, 'registrado', v_novos > 0, 'novos', v_novos);
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_registrar_card_exibido(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_registrar_card_exibido(text[]) TO authenticated;

-- ── M3b. Escritor da intenção de contato ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.radar_registrar_intencao(p_cnpj text, p_canal text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid  uuid := (SELECT auth.uid());
  v_dia  date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_cnpj text := btrim(p_cnpj);
  v_n    integer;
BEGIN
  IF NOT COALESCE(private.cap_radar_prospectar(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  IF p_canal IS NULL OR p_canal NOT IN ('ligar', 'whatsapp', 'copiar') THEN
    RAISE EXCEPTION 'canal invalido: %', p_canal USING ERRCODE = '22023';
  END IF;
  IF v_cnpj IS NULL OR v_cnpj = '' THEN
    RAISE EXCEPTION 'cnpj obrigatorio' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.radar_empresas e WHERE e.cnpj = v_cnpj) THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'cnpj_desconhecido');
  END IF;

  -- 1 por vendedor, CNPJ, canal e dia: o painel conta leads com intenção, não toques repetidos no botão.
  INSERT INTO public.radar_eventos (evento, origem, ocorrido_em, user_id, cnpj, acao, fonte_id)
  VALUES ('intencao', 'humano', now(), v_uid, v_cnpj, p_canal,
          'intencao:' || v_uid || ':' || v_cnpj || ':' || p_canal || ':' || v_dia)
  ON CONFLICT (fonte_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'registrado', v_n = 1);
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_registrar_intencao(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_registrar_intencao(text, text) TO authenticated;

-- ── M1/M2c/M3c. O painel ─────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.radar_funil(p_semanas integer DEFAULT 8)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  c_tz      constant text := 'America/Sao_Paulo';
  c_sistema constant uuid := '00000000-0000-0000-0000-00000000ad0f';  -- Radar · RFB (finalize do lote)
  v_uid     uuid := (SELECT auth.uid());
  v_n       integer := GREATEST(1, LEAST(COALESCE(p_semanas, 8), 26));
  v_atual   date := date_trunc('week', (now() AT TIME ZONE 'America/Sao_Paulo'))::date;
  v_ini     date;
  v_ini_ts  timestamptz;
  v_out     jsonb;
BEGIN
  IF v_uid IS NULL OR NOT COALESCE(private.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: funil do radar exige master ou gestor comercial' USING ERRCODE = '42501';
  END IF;
  v_ini    := v_atual - (v_n - 1) * 7;
  v_ini_ts := v_ini::timestamp AT TIME ZONE c_tz;

  WITH
  sem AS (
    SELECT s::date AS semana, s AT TIME ZONE c_tz AS ini, (s + interval '7 days') AT TIME ZONE c_tz AS fim
      FROM generate_series(v_ini::timestamp, v_atual::timestamp, interval '7 days') AS s
  ),
  env AS (  -- e-mails REAIS (teste não conta) com o estado de entrega da edge
    SELECT e.id, e.vendedor_user_id AS uid, e.semana, e.n_leads, e.criado_em, a.status, a.notificado_em
      FROM public.radar_email_vendedor_envios e
      JOIN public.fornecedor_alerta a ON a.id = e.alerta_id
     WHERE NOT e.eh_teste
  ),
  ev AS (   -- contato e cadastro humanos no período (o ledger tem o titular gravado na fonte)
    SELECT e.evento, e.acao, e.cnpj, e.user_id AS uid, e.ocorrido_em, e.contato_id,
           date_trunc('week', (e.ocorrido_em AT TIME ZONE c_tz))::date AS semana
      FROM public.radar_eventos e
     WHERE e.origem = 'humano' AND e.evento IN ('contato', 'cadastrou')
       AND e.ocorrido_em >= v_ini_ts AND e.user_id IS NOT NULL
  ),
  -- M1: o universo. Elegível AGORA (a autorização histórica não é reconstruída): todo staff com a capability.
  -- Customer nunca prospecta: o pré-filtro evita chamar a capability ~16 mil vezes (as linhas de customer de
  -- user_roles, medido em 2026-11-09) a cada abertura do painel. A decisão continua sendo a da capability.
  elig AS (
    SELECT DISTINCT ur.user_id AS uid FROM public.user_roles ur
     WHERE ur.role <> 'customer'::public.app_role AND private.cap_radar_prospectar(ur.user_id)
  ),
  -- M2: cada CNPJ exibido no card, inclusive a reposição depois de um Assumir.
  exib AS (
    SELECT x.user_id AS uid, x.dia, x.cnpj, x.exibido_em, date_trunc('week', x.dia::timestamp)::date AS semana
      FROM public.radar_card_exibicoes x WHERE x.dia >= v_ini
  ),
  -- M3: intenção de contato (ligar, WhatsApp, copiar), 1 por vendedor, CNPJ, canal e dia.
  intc AS (
    SELECT e.user_id AS uid, e.cnpj, e.acao, e.ocorrido_em,
           date_trunc('week', (e.ocorrido_em AT TIME ZONE c_tz))::date AS semana
      FROM public.radar_eventos e
     WHERE e.evento = 'intencao' AND e.origem = 'humano' AND e.ocorrido_em >= v_ini_ts AND e.user_id IS NOT NULL
  ),
  primeiro AS (
              SELECT 'email_envio'::text AS sensor, min(env.criado_em) AS primeiro, max(env.criado_em) AS ultimo FROM env
    UNION ALL SELECT 'email_entrega', min(env.notificado_em), max(env.notificado_em) FROM env WHERE env.status = 'notificado'
    UNION ALL SELECT 'abertura_email', min(a.aberto_em), max(a.aberto_em)
                FROM public.radar_lead_aberturas a WHERE a.origem = 'email' AND a.clique_registrado
    UNION ALL SELECT 'ficha_email', min(a.ficha_entregue_em), max(a.ficha_entregue_em)
                FROM public.radar_lead_aberturas a WHERE a.origem = 'email'
    UNION ALL SELECT 'card_servido', min(s.servido_em), max(s.servido_em) FROM public.radar_prospectar_hoje_servido s
    UNION ALL SELECT 'abertura_card', min(a.aberto_em), max(a.aberto_em)
                FROM public.radar_lead_aberturas a WHERE a.origem = 'card' AND a.clique_registrado
    UNION ALL SELECT 'ficha_card', min(a.ficha_entregue_em), max(a.ficha_entregue_em)
                FROM public.radar_lead_aberturas a WHERE a.origem = 'card'
    -- Contato/cadastro: a cobertura é a declarada (backfill completo); aqui só o último registro, pelo índice
    -- (evento, ocorrido_em) de trás para frente — min() sobre o ledger inteiro custava 1 s em prod.
    UNION ALL SELECT 'contato', NULL::timestamptz,
                (SELECT e.ocorrido_em FROM public.radar_eventos e WHERE e.evento = 'contato' AND e.origem = 'humano'
                  ORDER BY e.ocorrido_em DESC LIMIT 1)
    UNION ALL SELECT 'cadastro', NULL::timestamptz,
                (SELECT e.ocorrido_em FROM public.radar_eventos e WHERE e.evento = 'cadastrou' AND e.origem = 'humano'
                  ORDER BY e.ocorrido_em DESC LIMIT 1)
    UNION ALL SELECT 'card_exibido', min(x.exibido_em), max(x.exibido_em) FROM public.radar_card_exibicoes x
    UNION ALL SELECT 'intencao',
                (SELECT e.ocorrido_em FROM public.radar_eventos e WHERE e.evento = 'intencao' ORDER BY e.ocorrido_em LIMIT 1),
                (SELECT e.ocorrido_em FROM public.radar_eventos e WHERE e.evento = 'intencao' ORDER BY e.ocorrido_em DESC LIMIT 1)
  ),
  cob AS (  -- cobertura = a instalação declarada ou o 1º registro, o que vier antes (LEAST ignora NULL)
    SELECT s.sensor, s.ordem, s.rotulo, s.fonte, s.instalado_em, p.ultimo,
           LEAST(s.instalado_em, p.primeiro) AS desde
      FROM public.radar_funil_sensores s
      LEFT JOIN primeiro p ON p.sensor = s.sensor
  ),
  sem_cob AS (
    SELECT sem.semana, c.sensor,
           CASE WHEN c.desde IS NULL OR c.desde >= sem.fim THEN 'ausente'
                WHEN c.desde > sem.ini THEN 'parcial'
                ELSE 'completa' END AS estado
      FROM sem CROSS JOIN cob c
  ),
  cw AS (
    SELECT sc.semana,
           max(sc.estado) FILTER (WHERE sc.sensor = 'email_envio')    AS email_envio,
           max(sc.estado) FILTER (WHERE sc.sensor = 'abertura_email') AS abertura_email,
           max(sc.estado) FILTER (WHERE sc.sensor = 'ficha_email')    AS ficha_email,
           max(sc.estado) FILTER (WHERE sc.sensor = 'card_servido')   AS card_servido,
           max(sc.estado) FILTER (WHERE sc.sensor = 'abertura_card')  AS abertura_card,
           max(sc.estado) FILTER (WHERE sc.sensor = 'ficha_card')     AS ficha_card,
           max(sc.estado) FILTER (WHERE sc.sensor = 'contato')        AS contato,
           max(sc.estado) FILTER (WHERE sc.sensor = 'cadastro')       AS cadastro,
           max(sc.estado) FILTER (WHERE sc.sensor = 'card_exibido')   AS card_exibido,
           max(sc.estado) FILTER (WHERE sc.sensor = 'intencao')       AS intencao
      FROM sem_cob sc
     GROUP BY sc.semana
  ),
  vend AS (  -- M1: o universo (elegíveis agora) + quem teve qualquer atividade no período (mesmo sem acesso hoje)
    SELECT elig.uid FROM elig
    UNION SELECT env.uid FROM env WHERE env.semana >= v_ini
    UNION SELECT s.user_id FROM public.radar_prospectar_hoje_servido s WHERE s.dia >= v_ini
    UNION SELECT a.user_id FROM public.radar_lead_aberturas a
           WHERE a.dia >= v_ini AND (a.origem = 'card' OR a.do_destinatario)
    UNION SELECT ev.uid FROM ev
    UNION SELECT exib.uid FROM exib
    UNION SELECT intc.uid FROM intc
    UNION SELECT c.vendedor_user_id FROM public.radar_email_vendedor_config c WHERE c.ativo AND c.email_teste IS NULL
  ),
  env_ag AS (
    SELECT env.semana, env.uid,
           count(*)::integer AS enviados,
           count(*) FILTER (WHERE env.status = 'notificado')::integer AS entregues,
           count(*) FILTER (WHERE env.status = 'falha_notificacao')::integer AS falhos,
           count(*) FILTER (WHERE env.status NOT IN ('notificado', 'falha_notificacao'))::integer AS pendentes,
           COALESCE(sum(env.n_leads) FILTER (WHERE env.status = 'notificado'), 0)::integer AS leads_entregues
      FROM env WHERE env.semana >= v_ini
     GROUP BY env.semana, env.uid
  ),
  cli_email AS (  -- só o destinatário e só e-mail entregue: numerador ⊂ denominador
    SELECT env.semana, env.uid,
           count(DISTINCT (a.envio_id, a.cnpj))::integer AS clicados,
           (count(DISTINCT (a.envio_id, a.cnpj)) FILTER (WHERE a.ficha_entregue_em IS NOT NULL))::integer AS fichas
      FROM env
      JOIN public.radar_lead_aberturas a ON a.envio_id = env.id AND a.origem = 'email' AND a.do_destinatario
     WHERE env.semana >= v_ini AND env.status = 'notificado'
     GROUP BY env.semana, env.uid
  ),
  card_srv AS (
    SELECT date_trunc('week', s.dia::timestamp)::date AS semana, s.user_id AS uid,
           count(*)::integer AS dias, sum(s.n_leads)::integer AS leads
      FROM public.radar_prospectar_hoje_servido s WHERE s.dia >= v_ini
     GROUP BY 1, 2
  ),
  card_cli AS (
    SELECT date_trunc('week', a.dia::timestamp)::date AS semana, a.user_id AS uid,
           count(*)::integer AS clicados,
           (count(*) FILTER (WHERE a.ficha_entregue_em IS NOT NULL))::integer AS fichas
      FROM public.radar_lead_aberturas a WHERE a.origem = 'card' AND a.dia >= v_ini
     GROUP BY 1, 2
  ),
  card_exib AS (  -- M2: exibidos e, deles, clicados no MESMO dia (numerador ⊂ denominador por construção)
    SELECT exib.semana, exib.uid,
           count(*)::integer AS exibidos,
           (count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.radar_lead_aberturas a
                                            WHERE a.origem = 'card' AND a.user_id = exib.uid
                                              AND a.cnpj = exib.cnpj AND a.dia = exib.dia)))::integer AS clicados
      FROM exib
     GROUP BY exib.semana, exib.uid
  ),
  int_ag AS (
    SELECT intc.semana, intc.uid, count(*)::integer AS intencoes FROM intc GROUP BY intc.semana, intc.uid
  ),
  ev_ok AS (
    SELECT ev.*,
           (EXISTS (SELECT 1
                      FROM public.radar_email_vendedor_leads l
                      JOIN env ON env.id = l.envio_id AND env.status = 'notificado'
                     WHERE l.cnpj = ev.cnpj AND env.uid = ev.uid AND env.criado_em <= ev.ocorrido_em)
            OR EXISTS (SELECT 1 FROM public.radar_lead_aberturas a
                        WHERE a.cnpj = ev.cnpj AND a.user_id = ev.uid AND a.origem = 'card' AND a.aberto_em <= ev.ocorrido_em))
             AS empurrado
      FROM ev
     WHERE ev.evento = 'cadastrou'
        OR (ev.acao IN ('contatado_sem_resposta', 'em_conversa')
            AND EXISTS (SELECT 1 FROM public.radar_contatos c WHERE c.id = ev.contato_id))
  ),
  ev_ag AS (
    SELECT ev_ok.semana, ev_ok.uid,
           (count(*) FILTER (WHERE ev_ok.evento = 'contato'))::integer AS contatos,
           (count(*) FILTER (WHERE ev_ok.evento = 'contato' AND ev_ok.empurrado))::integer AS contatos_empurrados,
           (count(*) FILTER (WHERE ev_ok.evento = 'cadastrou' AND ev_ok.acao = 'incluir'))::integer AS cadastros_novos,
           (count(*) FILTER (WHERE ev_ok.evento = 'cadastrou' AND ev_ok.acao = 'incluir' AND ev_ok.empurrado))::integer
             AS cadastros_novos_empurrados,
           (count(*) FILTER (WHERE ev_ok.evento = 'cadastrou' AND ev_ok.acao IS DISTINCT FROM 'incluir'))::integer
             AS cadastros_vinculo
      FROM ev_ok
     GROUP BY ev_ok.semana, ev_ok.uid
  ),
  linhas AS (  -- contagem dentro da cobertura (0 é fato); fora dela NULL (ausente ≠ zero)
    SELECT sem.semana, v.uid AS vendedor_user_id,
           CASE WHEN cw.email_envio    <> 'ausente' THEN COALESCE(ea.enviados, 0)        END AS email_enviados,
           CASE WHEN cw.email_envio    <> 'ausente' THEN COALESCE(ea.entregues, 0)       END AS email_entregues,
           CASE WHEN cw.email_envio    <> 'ausente' THEN COALESCE(ea.falhos, 0)          END AS email_falhos,
           CASE WHEN cw.email_envio    <> 'ausente' THEN COALESCE(ea.pendentes, 0)       END AS email_pendentes,
           CASE WHEN cw.email_envio    <> 'ausente' THEN COALESCE(ea.leads_entregues, 0) END AS email_leads_entregues,
           CASE WHEN cw.abertura_email <> 'ausente' THEN COALESCE(ce.clicados, 0)        END AS email_leads_clicados,
           CASE WHEN cw.ficha_email    <> 'ausente' THEN COALESCE(ce.fichas, 0)          END AS email_fichas,
           CASE WHEN cw.card_servido   <> 'ausente' THEN COALESCE(cs.dias, 0)            END AS card_dias,
           CASE WHEN cw.card_servido   <> 'ausente' THEN COALESCE(cs.leads, 0)           END AS card_leads_servidos,
           CASE WHEN cw.abertura_card  <> 'ausente' THEN COALESCE(cc.clicados, 0)        END AS card_leads_clicados,
           CASE WHEN cw.ficha_card     <> 'ausente' THEN COALESCE(cc.fichas, 0)          END AS card_fichas,
           CASE WHEN cw.contato        <> 'ausente' THEN COALESCE(g.contatos, 0)         END AS contatos,
           CASE WHEN cw.contato        <> 'ausente' THEN COALESCE(g.contatos_empurrados, 0) END AS contatos_empurrados,
           CASE WHEN cw.cadastro       <> 'ausente' THEN COALESCE(g.cadastros_novos, 0)  END AS cadastros_novos,
           CASE WHEN cw.cadastro       <> 'ausente' THEN COALESCE(g.cadastros_novos_empurrados, 0) END AS cadastros_novos_empurrados,
           CASE WHEN cw.cadastro       <> 'ausente' THEN COALESCE(g.cadastros_vinculo, 0) END AS cadastros_vinculo,
           CASE WHEN cw.card_exibido   <> 'ausente' THEN COALESCE(cx.exibidos, 0)        END AS card_leads_exibidos,
           CASE WHEN cw.card_exibido   <> 'ausente' THEN COALESCE(cx.clicados, 0)        END AS card_leads_clicados_exibidos,
           CASE WHEN cw.intencao       <> 'ausente' THEN COALESCE(ia.intencoes, 0)       END AS intencoes
      FROM sem
      JOIN cw ON cw.semana = sem.semana
     CROSS JOIN vend v
      LEFT JOIN env_ag ea    ON ea.semana = sem.semana AND ea.uid = v.uid
      LEFT JOIN cli_email ce ON ce.semana = sem.semana AND ce.uid = v.uid
      LEFT JOIN card_srv cs  ON cs.semana = sem.semana AND cs.uid = v.uid
      LEFT JOIN card_cli cc  ON cc.semana = sem.semana AND cc.uid = v.uid
      LEFT JOIN ev_ag g      ON g.semana = sem.semana AND g.uid = v.uid
      LEFT JOIN card_exib cx ON cx.semana = sem.semana AND cx.uid = v.uid
      LEFT JOIN int_ag ia    ON ia.semana = sem.semana AND ia.uid = v.uid
  ),
  -- M1: a adoção por vendedor no período. Exposto = o Radar chegou a ele (card exibido ou servido, e-mail entregue,
  -- tela ou ficha aberta) ou ele agiu. Ação humana = clique em lead empurrado, ficha aberta, intenção de contato,
  -- contato registrado (qualquer desfecho), cadastro, ou assumir um lead (atribuição do gestor não é ação dele).
  expo AS (
              SELECT exib.uid, exib.exibido_em AS ts FROM exib
    UNION ALL SELECT s.user_id, s.servido_em FROM public.radar_prospectar_hoje_servido s WHERE s.dia >= v_ini
    UNION ALL SELECT env.uid, env.notificado_em FROM env WHERE env.status = 'notificado' AND env.notificado_em >= v_ini_ts
    UNION ALL SELECT e.user_id, e.ocorrido_em FROM public.radar_eventos e
               WHERE e.evento = 'abriu' AND e.origem = 'humano' AND e.ocorrido_em >= v_ini_ts AND e.user_id IS NOT NULL
  ),
  acao AS (
              SELECT a.user_id AS uid, a.aberto_em AS ts FROM public.radar_lead_aberturas a WHERE a.dia >= v_ini
    UNION ALL SELECT e.user_id, e.ocorrido_em FROM public.radar_eventos e
               WHERE e.origem = 'humano' AND e.user_id IS NOT NULL AND e.ocorrido_em >= v_ini_ts
                 AND (e.evento IN ('contato', 'cadastrou', 'intencao') OR (e.evento = 'abriu' AND e.cnpj IS NOT NULL))
    UNION ALL SELECT t.dono_user_id, t.assumido_em FROM public.radar_atendimentos t
               WHERE t.assumido_em >= v_ini_ts AND t.atribuido_por IS NULL
  ),
  ado AS (
    SELECT v.uid,
           EXISTS (SELECT 1 FROM elig WHERE elig.uid = v.uid) AS elegivel,
           LEAST((SELECT min(expo.ts) FROM expo WHERE expo.uid = v.uid),
                 (SELECT min(acao.ts) FROM acao WHERE acao.uid = v.uid)) AS exposto_em,
           (SELECT min(acao.ts) FROM acao WHERE acao.uid = v.uid) AS primeira_acao_em,
           (SELECT max(acao.ts) FROM acao WHERE acao.uid = v.uid) AS ultima_acao_em,
           (SELECT count(DISTINCT (acao.ts AT TIME ZONE c_tz)::date) FROM acao WHERE acao.uid = v.uid)::integer AS dias_com_acao,
           (SELECT count(*) FROM acao WHERE acao.uid = v.uid)::integer AS acoes
      FROM vend v
  ),
  regs AS (
              SELECT 'email_envio'::text AS sensor, count(*)::integer AS n FROM env WHERE env.semana >= v_ini
    UNION ALL SELECT 'email_entrega', count(*)::integer FROM env WHERE env.semana >= v_ini AND env.status = 'notificado'
    UNION ALL SELECT 'abertura_email', count(*)::integer FROM public.radar_lead_aberturas a
               WHERE a.origem = 'email' AND a.clique_registrado AND a.dia >= v_ini
    UNION ALL SELECT 'ficha_email', count(*)::integer FROM public.radar_lead_aberturas a
               WHERE a.origem = 'email' AND a.ficha_entregue_em >= v_ini_ts
    UNION ALL SELECT 'card_servido', count(*)::integer FROM public.radar_prospectar_hoje_servido s WHERE s.dia >= v_ini
    UNION ALL SELECT 'abertura_card', count(*)::integer FROM public.radar_lead_aberturas a
               WHERE a.origem = 'card' AND a.clique_registrado AND a.dia >= v_ini
    UNION ALL SELECT 'ficha_card', count(*)::integer FROM public.radar_lead_aberturas a
               WHERE a.origem = 'card' AND a.ficha_entregue_em >= v_ini_ts
    UNION ALL SELECT 'contato', count(*)::integer FROM ev WHERE ev.evento = 'contato'
    UNION ALL SELECT 'cadastro', count(*)::integer FROM ev WHERE ev.evento = 'cadastrou'
    UNION ALL SELECT 'card_exibido', count(*)::integer FROM exib
    UNION ALL SELECT 'intencao', count(*)::integer FROM intc
  ),
  falhas AS (
    SELECT f.sensor, f.motivo, sum(f.n)::integer AS n
      FROM public.radar_sensor_falhas f WHERE f.dia >= v_ini
     GROUP BY f.sensor, f.motivo
    UNION ALL
    SELECT x.sensor, x.motivo, x.n FROM (
                SELECT 'email_entrega'::text AS sensor, 'falha_notificacao'::text AS motivo, count(*)::integer AS n
                  FROM env WHERE env.semana >= v_ini AND env.status = 'falha_notificacao'
      UNION ALL SELECT 'email_entrega', 'pendente_ha_mais_de_2h', count(*)::integer
                  FROM env WHERE env.semana >= v_ini AND env.status = 'pendente_notificacao'
                   AND env.criado_em < now() - interval '2 hours'
      UNION ALL SELECT 'email_entrega', 'ignorado', count(*)::integer
                  FROM env WHERE env.semana >= v_ini AND env.status = 'ignorado'
      UNION ALL SELECT 'abertura_email', 'clique_perdido', count(*)::integer
                  FROM public.radar_lead_aberturas a WHERE a.origem = 'email' AND NOT a.clique_registrado AND a.dia >= v_ini
      UNION ALL SELECT 'abertura_card', 'clique_perdido', count(*)::integer
                  FROM public.radar_lead_aberturas a WHERE a.origem = 'card' AND NOT a.clique_registrado AND a.dia >= v_ini
      -- Reconciliação do fail-open dos triggers do ledger, recortada ao período (o contato automático não vira
      -- evento desde o pacote M: fica fora daqui também).
      UNION ALL SELECT 'contato', 'contato_sem_evento', count(*)::integer
                  FROM public.radar_contatos c
                 WHERE c.created_at >= v_ini_ts AND c.criado_por IS DISTINCT FROM c_sistema
                   AND NOT EXISTS (SELECT 1 FROM public.radar_eventos e WHERE e.fonte_id = 'contato:' || c.id)
      UNION ALL SELECT 'cadastro', 'cadastro_sem_evento', count(*)::integer
                  FROM public.radar_empresas re
                 WHERE re.omie_cadastrado_em >= v_ini_ts
                   AND NOT EXISTS (SELECT 1 FROM public.radar_eventos e WHERE e.fonte_id = 'cadastro:' || re.cnpj)
    ) x WHERE x.n > 0
  ),
  sens AS (
    SELECT c.ordem, jsonb_build_object(
             'sensor', c.sensor, 'rotulo', c.rotulo, 'fonte', c.fonte,
             'instalado_em', c.instalado_em, 'cobertura_desde', c.desde, 'ultimo_registro_em', c.ultimo,
             'registros_periodo', COALESCE(r.n, 0),
             'falhas_periodo', COALESCE((SELECT sum(f.n) FROM falhas f WHERE f.sensor = c.sensor), 0),
             'falhas', COALESCE((SELECT jsonb_agg(jsonb_build_object('motivo', f.motivo, 'n', f.n) ORDER BY f.n DESC, f.motivo)
                                   FROM falhas f WHERE f.sensor = c.sensor), '[]'::jsonb),
             'estado', CASE WHEN c.desde IS NULL THEN 'sem_registro'
                            WHEN EXISTS (SELECT 1 FROM falhas f WHERE f.sensor = c.sensor) THEN 'falhou'
                            WHEN c.desde > v_ini_ts THEN 'parcial'
                            WHEN COALESCE(r.n, 0) = 0 THEN 'sem_dado_no_periodo'
                            ELSE 'ok' END) AS j
      FROM cob c
      LEFT JOIN regs r ON r.sensor = c.sensor
  )
  SELECT jsonb_build_object(
           'gerado_em', now(),
           'semanas_pedidas', v_n,
           'inicio', v_ini,
           'fim', v_atual + 6,
           'semanas', (SELECT jsonb_agg(jsonb_build_object(
                                 'semana', sem.semana, 'corrente', sem.semana = v_atual,
                                 'cobertura', (SELECT jsonb_object_agg(sc.sensor, sc.estado)
                                                 FROM sem_cob sc WHERE sc.semana = sem.semana))
                               ORDER BY sem.semana DESC) FROM sem),
           'sensores', (SELECT COALESCE(jsonb_agg(sens.j ORDER BY sens.ordem), '[]'::jsonb) FROM sens),
           'vendedores', (SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id', v.uid, 'nome', p.nome)
                                                    ORDER BY p.nome NULLS LAST, v.uid), '[]'::jsonb)
                            FROM vend v
                            LEFT JOIN LATERAL (SELECT pr.name AS nome FROM public.profiles pr
                                                WHERE pr.user_id = v.uid ORDER BY pr.created_at LIMIT 1) p ON true),
           'linhas', (SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.semana DESC, l.vendedor_user_id), '[]'::jsonb)
                        FROM linhas l),
           'adocao', jsonb_build_object(
             'elegiveis_agora', (SELECT count(*)::integer FROM elig),
             'vendedores', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                                     'user_id', a.uid, 'elegivel', a.elegivel, 'exposto_em', a.exposto_em,
                                     'primeira_acao_em', a.primeira_acao_em, 'ultima_acao_em', a.ultima_acao_em,
                                     'dias_com_acao', a.dias_com_acao, 'acoes', a.acoes)
                                   ORDER BY a.uid), '[]'::jsonb)
                              FROM ado a)))
    INTO v_out;

  RETURN v_out;
END
$fn$;
-- CREATE OR REPLACE preserva o ACL da 20261107233000 (REVOKE PUBLIC/anon, GRANT authenticated e claude_ro).

-- ── M4. O experimento da coorte ganha tela ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.radar_funil_experimento()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
BEGIN
  IF v_uid IS NULL OR NOT COALESCE(private.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: experimento do radar exige master ou gestor comercial' USING ERRCODE = '42501';
  END IF;
  -- As duas leituras do experimento (20261029150100), sem mudança: aqui só o gate e a forma de uma linha jsonb.
  RETURN jsonb_build_object(
    'gerado_em', now(),
    'coortes', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.sorteio, r.grupo DESC), '[]'::jsonb)
                  FROM public.radar_coorte_resultado() r),
    'faixas',  (SELECT COALESCE(jsonb_agg(to_jsonb(f)), '[]'::jsonb) FROM public.radar_conversao_por_faixa() f));
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_funil_experimento() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_funil_experimento() TO authenticated;
DO $ro$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'claude_ro') THEN
    GRANT EXECUTE ON FUNCTION public.radar_funil_experimento() TO claude_ro;
  END IF;
END
$ro$;

DROP FUNCTION IF EXISTS public.radar_placar_uso();

-- ── M5. Retenção ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.radar_expurgar_medicao(p_lote integer DEFAULT 20000)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_lote   integer := GREATEST(1, LEAST(COALESCE(p_lote, 20000), 100000));
  v_hoje   date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_auto   integer;
  v_humano integer;
  v_aber   integer;
  v_exib   integer;
  v_serv   integer;
  v_falha  integer;
BEGIN
  -- Automáticos: nenhum leitor desde o pacote M; saem todos, em lotes (o backlog de 64 mil sai em ~4 dias).
  DELETE FROM public.radar_eventos e
   WHERE e.id IN (SELECT x.id FROM public.radar_eventos x WHERE x.origem = 'automatica' ORDER BY x.id LIMIT v_lote);
  GET DIAGNOSTICS v_auto = ROW_COUNT;
  -- Humanos de exposição/intenção (1 por dia cada): 400 dias. Contato, desfazer e cadastro humanos ficam.
  DELETE FROM public.radar_eventos e
   WHERE e.origem = 'humano' AND e.evento IN ('abriu', 'intencao') AND e.ocorrido_em < now() - interval '400 days';
  GET DIAGNOSTICS v_humano = ROW_COUNT;
  DELETE FROM public.radar_lead_aberturas a WHERE a.dia < v_hoje - 400;
  GET DIAGNOSTICS v_aber = ROW_COUNT;
  DELETE FROM public.radar_card_exibicoes x WHERE x.dia < v_hoje - 400;
  GET DIAGNOSTICS v_exib = ROW_COUNT;
  DELETE FROM public.radar_prospectar_hoje_servido s WHERE s.dia < v_hoje - 400;
  GET DIAGNOSTICS v_serv = ROW_COUNT;
  DELETE FROM public.radar_sensor_falhas f WHERE f.dia < v_hoje - 180;
  GET DIAGNOSTICS v_falha = ROW_COUNT;
  RETURN jsonb_build_object('eventos_automaticos', v_auto, 'eventos_humanos_400d', v_humano, 'aberturas', v_aber,
                            'exibicoes', v_exib, 'card_servido', v_serv, 'falhas_sensor', v_falha);
END
$fn$;
REVOKE ALL ON FUNCTION private.radar_expurgar_medicao(integer) FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('radar-expurgo-medicao-diario', '20 7 * * *', 'SELECT private.radar_expurgar_medicao()');

-- ── PÓS ──────────────────────────────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  r record;
  f text;
BEGIN
  -- P1: corpo vivo = este arquivo (a mesma régua da PRE).
  FOR r IN
    SELECT v.alvo, v.este, (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v.alvo)) AS vivo
      FROM (VALUES
        ('public.radar_funil(integer)', 'fb09ceea1ad40a78dc471b3a5e4ec95d'),
        ('private.radar_evento_contato()', '3c500687d276fbb1cfea19ebcaa9a316'),
        ('public.radar_registrar_card_exibido(text[])', 'd98067fa9baededff8af98de6cb4001d'),
        ('public.radar_registrar_intencao(text,text)', '108d88bad7b3dac38074748f76cede99'),
        ('public.radar_funil_experimento()', 'f4d8024105bdf73b777e9200bb7ff26e'),
        ('private.radar_expurgar_medicao(integer)', '398268b3a365066ea7c99964dc9530ea')
      ) AS v(alvo, este)
  LOOP
    IF r.vivo IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'M1 FALHOU: % vivo (md5 %) não é este', r.alvo, r.vivo;
    END IF;
  END LOOP;
  IF to_regprocedure('public.radar_placar_uso()') IS NOT NULL THEN
    RAISE EXCEPTION 'M1 FALHOU: radar_placar_uso ainda existe';
  END IF;

  -- P2: SECURITY DEFINER, search_path fixo e ACL nas DUAS pontas (PUBLIC e anon fora).
  FOREACH f IN ARRAY ARRAY['public.radar_funil(integer)', 'public.radar_registrar_card_exibido(text[])',
                           'public.radar_registrar_intencao(text,text)', 'public.radar_funil_experimento()',
                           'private.radar_expurgar_medicao(integer)'] LOOP
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(f)) THEN
      RAISE EXCEPTION 'M2 FALHOU: % não é SECURITY DEFINER', f;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(f) AND p.proconfig @> ARRAY['search_path=""']) THEN
      RAISE EXCEPTION 'M2 FALHOU: % sem search_path vazio', f;
    END IF;
    IF has_function_privilege('anon', to_regprocedure(f), 'EXECUTE') THEN
      RAISE EXCEPTION 'M2 FALHOU: anon executa %', f;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, unnest(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                WHERE p.oid = to_regprocedure(f) AND a::text LIKE '=%') THEN
      RAISE EXCEPTION 'M2 FALHOU: PUBLIC executa %', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public.radar_funil(integer)', 'public.radar_registrar_card_exibido(text[])',
                           'public.radar_registrar_intencao(text,text)', 'public.radar_funil_experimento()'] LOOP
    IF NOT has_function_privilege('authenticated', to_regprocedure(f), 'EXECUTE') THEN
      RAISE EXCEPTION 'M2 FALHOU: authenticated não executa %', f;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'private.radar_expurgar_medicao(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M2 FALHOU: authenticated executa o expurgo';
  END IF;
  FOREACH f IN ARRAY ARRAY['public.radar_funil(integer)', 'public.radar_funil_experimento()'] LOOP
    IF (SELECT p.provolatile FROM pg_proc p WHERE p.oid = to_regprocedure(f)) <> 's' THEN
      RAISE EXCEPTION 'M2 FALHOU: % não é STABLE (a lente só libera leitura pura)', f;
    END IF;
  END LOOP;

  -- P3: a tabela nova fechada ao JWT, com RLS; os sensores registrados.
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.radar_card_exibicoes'::regclass) THEN
    RAISE EXCEPTION 'M3 FALHOU: radar_card_exibicoes sem RLS';
  END IF;
  IF has_table_privilege('anon', 'public.radar_card_exibicoes', 'SELECT')
     OR has_table_privilege('authenticated', 'public.radar_card_exibicoes', 'SELECT')
     OR has_table_privilege('authenticated', 'public.radar_card_exibicoes', 'INSERT') THEN
    RAISE EXCEPTION 'M3 FALHOU: radar_card_exibicoes aberta ao JWT';
  END IF;
  IF (SELECT count(*) FROM public.radar_funil_sensores WHERE sensor IN ('card_exibido', 'intencao')) <> 2 THEN
    RAISE EXCEPTION 'M3 FALHOU: sensores card_exibido/intencao ausentes do registro';
  END IF;

  -- P4: o ledger aceita a intenção, com a forma validada.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.radar_eventos'::regclass
                    AND conname = 'radar_eventos_evento_check' AND convalidated
                    AND pg_get_constraintdef(oid) LIKE '%intencao%') THEN
    RAISE EXCEPTION 'M4 FALHOU: radar_eventos_evento_check não aceita intencao (ou não validado)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.radar_eventos'::regclass
                    AND conname = 'radar_eventos_intencao_forma' AND convalidated) THEN
    RAISE EXCEPTION 'M4 FALHOU: radar_eventos_intencao_forma ausente ou não validado';
  END IF;

  -- P5: o cron do expurgo existe, ativo, no horário, com o comando exato.
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'radar-expurgo-medicao-diario' AND active
                   AND schedule = '20 7 * * *' AND command = 'SELECT private.radar_expurgar_medicao()') THEN
    RAISE EXCEPTION 'M5 FALHOU: cron radar-expurgo-medicao-diario ausente, inativo ou divergente';
  END IF;
  RAISE NOTICE 'POSTCONDICAO RADAR MEDICAO M OK';
END
$post$;

NOTIFY pgrst, 'reload schema';
