-- =============================================================================
-- Radar, pacote H: medir o funil do lead empurrado (e-mail semanal e card "Prospectar hoje")
-- =============================================================================
-- Por que: o pacote D (20261106181000) grava os sensores do lead empurrado (radar_email_vendedor_envios,
-- radar_lead_aberturas, radar_prospectar_hoje_servido) e o ledger de eventos (20261029150100) grava contato e
-- cadastro, mas nenhuma tela lê nada disso: o founder só sabe se o "0 contato humano em 60 dias" mudou rodando
-- psql. A fase seguinte do Radar exige sinal COM DENOMINADOR desta fase (docs/historico/fase-sem-sinal.md); este
-- painel é esse sinal.
--
-- O que entra (idempotente; envelope BEGIN/COMMIT; postcondição DO $post$):
--   1. radar_lead_aberturas ganha o 2º momento: `ficha_entregue_em` (a ficha do lead chegou ao navegador do
--      vendedor) e `clique_registrado` (false = a linha nasceu pela ficha porque o registro do clique se perdeu).
--      Antes o painel contaria clique sem ficha: o link grava a abertura ANTES de a ficha carregar.
--   2. public.radar_sensor_falhas: falha de sensor que o CLIENTE vê e o banco não (lead não encontrado, leitura da
--      ficha falhou, RPC recusou, rede esgotou as tentativas). 1 linha por (sensor, motivo, usuário, dia) com
--      contador: cresce limitado. Escritor único: radar_registrar_falha_sensor().
--   3. public.radar_funil_sensores: o registro dos sensores com a data em que cada um passou a existir. Semana
--      anterior à instalação é AUSENTE ("—"), nunca 0. instalado_em NULL = instalação não declarada: a cobertura
--      começa no 1º registro. Re-aplicar não sobrescreve uma declaração feita depois (ON CONFLICT DO NOTHING).
--   4. public.radar_registrar_ficha_entregue(origem, cnpj, envio): grava o 2º momento (mesmos gates da abertura).
--   5. public.radar_registrar_falha_sensor(sensor, motivo): o ledger do item 2 (só staff; customer não escreve).
--   6. public.radar_funil(p_semanas): o painel, leitura PURA (STABLE), só master ou gestor comercial
--      (private.pode_ver_carteira_completa). Devolve jsonb (1 linha: sem teto de 1.000 do PostgREST):
--        semanas[]    semana (segunda, BRT), corrente, cobertura por sensor (completa | parcial | ausente)
--        vendedores[] user_id, nome
--        linhas[]     (semana × vendedor): contagens; NULL quando o sensor da coluna não cobre a semana
--        sensores[]   estado (ok | falhou | parcial | sem_dado_no_periodo | sem_registro), cobertura, último
--                     registro, registros e falhas no período, com o motivo
--      E-mail: coorte pela semana do envio (cliques e fichas de um e-mail contam na semana em que ele saiu).
--      Card, contato e cadastro: semana do fato. Contato = toque humano válido (contatado_sem_resposta ou
--      em_conversa, contato ainda vivo) — a mesma regra de radar_placar_uso(). "Empurrado" = lead que chegou ao
--      vendedor por e-mail ENTREGUE ou que ele abriu pelo card, antes do contato/cadastro.
-- Prova PG17: db/test-radar-funil.sh (--falsificar).
-- =============================================================================

BEGIN;

-- ── TRAVA: pré-requisitos vivos ─────────────────────────────────────────────────────────────────────────
DO $trava$
BEGIN
  IF to_regclass('public.radar_lead_aberturas') IS NULL OR to_regclass('public.radar_email_vendedor_envios') IS NULL
     OR to_regclass('public.radar_email_vendedor_leads') IS NULL OR to_regclass('public.radar_prospectar_hoje_servido') IS NULL
     OR to_regclass('public.radar_email_vendedor_config') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: tabelas do pacote D ausentes — aplique 20261106181000_radar_leads_ao_vendedor antes';
  END IF;
  IF to_regclass('public.radar_eventos') IS NULL OR to_regclass('public.radar_contatos') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: radar_eventos/radar_contatos ausente — aplique 20261029150100_radar_eventos_placar antes';
  END IF;
  IF to_regclass('public.fornecedor_alerta') IS NULL OR to_regclass('public.radar_empresas') IS NULL
     OR to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: fornecedor_alerta, radar_empresas ou profiles ausente';
  END IF;
  IF to_regprocedure('private.cap_radar_prospectar(uuid)') IS NULL
     OR to_regprocedure('private.pode_ver_carteira_completa(uuid)') IS NULL
     OR to_regprocedure('public.has_role(uuid,public.app_role)') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: private.cap_radar_prospectar, private.pode_ver_carteira_completa ou public.has_role ausente';
  END IF;
END
$trava$;

-- ── 1. O 2º momento da abertura ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.radar_lead_aberturas
  ADD COLUMN IF NOT EXISTS ficha_entregue_em timestamptz,
  ADD COLUMN IF NOT EXISTS clique_registrado boolean NOT NULL DEFAULT true;
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'radar_lead_aberturas_ficha_depois_do_clique'
                    AND conrelid = 'public.radar_lead_aberturas'::regclass) THEN
    ALTER TABLE public.radar_lead_aberturas ADD CONSTRAINT radar_lead_aberturas_ficha_depois_do_clique
      CHECK (ficha_entregue_em IS NULL OR ficha_entregue_em >= aberto_em);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'radar_lead_aberturas_sem_clique_so_pela_ficha'
                    AND conrelid = 'public.radar_lead_aberturas'::regclass) THEN
    ALTER TABLE public.radar_lead_aberturas ADD CONSTRAINT radar_lead_aberturas_sem_clique_so_pela_ficha
      CHECK (clique_registrado OR ficha_entregue_em IS NOT NULL);
  END IF;
END
$chk$;
COMMENT ON TABLE public.radar_lead_aberturas IS
  'Radar D1/D2: abertura de lead empurrado (e-mail semanal ou card Prospectar hoje). Numerador do sensor. Linha: radar_registrar_abertura_empurrada() (o clique). ficha_entregue_em: radar_registrar_ficha_entregue() (a ficha chegou ao navegador; se o clique se perdeu, ela cria a linha com clique_registrado = false). Migrations 20261106181000 e 20261107230000.';
COMMENT ON COLUMN public.radar_lead_aberturas.ficha_entregue_em IS
  'Quando a ficha do lead chegou ao navegador do vendedor (2º momento). NULL = clique sem ficha, ou sensor não instalado para a origem (ver radar_funil_sensores). Escritor único: radar_registrar_ficha_entregue().';
COMMENT ON COLUMN public.radar_lead_aberturas.clique_registrado IS
  'false = a linha nasceu pela ficha: o registro do clique se perdeu (falha do sensor de clique, contada no painel).';

-- ── 2. Falhas de sensor vistas pelo cliente ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.radar_sensor_falhas (
  sensor      text NOT NULL CHECK (sensor IN ('card_servido', 'abertura_card', 'abertura_email', 'ficha_card', 'ficha_email')),
  motivo      text NOT NULL CHECK (motivo ~ '^[a-z0-9_]{1,40}$'),
  user_id     uuid NOT NULL,
  dia         date NOT NULL,
  n           integer NOT NULL DEFAULT 1 CHECK (n >= 1),
  primeiro_em timestamptz NOT NULL DEFAULT now(),
  ultimo_em   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sensor, motivo, user_id, dia)
);
CREATE INDEX IF NOT EXISTS idx_radar_sensor_falhas_dia ON public.radar_sensor_falhas (dia);
COMMENT ON TABLE public.radar_sensor_falhas IS
  'Radar H: falha de sensor do lead empurrado que o CLIENTE vê (lead não encontrado, ficha não lida, RPC recusou, rede esgotou as tentativas). 1 linha por (sensor, motivo, usuário, dia) com contador. Escritor único: radar_registrar_falha_sensor(). Lido por radar_funil(). Migration 20261107230000.';

-- ── 3. Registro dos sensores (data de instalação) ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.radar_funil_sensores (
  sensor       text PRIMARY KEY,
  ordem        smallint NOT NULL UNIQUE,
  rotulo       text NOT NULL,
  instalado_em timestamptz,
  fonte        text NOT NULL
);
COMMENT ON TABLE public.radar_funil_sensores IS
  'Radar H: sensores do funil e quando cada um passou a existir. Semana antes da instalação = ausente ("—"), nunca 0. instalado_em NULL = não declarada: cobertura a partir do 1º registro. Declarar depois do Publish: UPDATE pelo founder/envelope. Migration 20261107230000.';
-- Datas: pacote D publicado e 1º e-mail (teste) em 2026-11-07 (docs/historico/radar-leads-ao-vendedor-2026-11-06.md);
-- ledger de contato/cadastro nasceu em 2026-10-29 COM backfill de TODO contato/cadastro já existente: cobre desde o 1º
-- contato do Radar (calculado no apply — ler min() a cada abertura do painel custava 1 s em prod).
-- ficha_email: declarada depois do Publish deste pacote. ficha_card: sem escritor no front ainda (card → /radar?cnpj).
INSERT INTO public.radar_funil_sensores (sensor, ordem, rotulo, instalado_em, fonte)
SELECT x.sensor, x.ordem, x.rotulo,
       CASE WHEN x.sensor IN ('contato', 'cadastro')
            THEN LEAST('2026-10-29 00:00:00-03'::timestamptz, (SELECT min(c.created_at) FROM public.radar_contatos c))
            ELSE x.instalado_em END,
       x.fonte
  FROM (VALUES
  ('email_envio',    1::smallint, 'E-mail gerado',            '2026-11-07 00:00:00-03'::timestamptz, 'cron radar_avisar_vendedores → radar_email_vendedor_envios'),
  ('email_entrega',  2::smallint, 'E-mail entregue',          '2026-11-07 00:00:00-03'::timestamptz, 'edge dispatch-notifications → fornecedor_alerta.status'),
  ('abertura_email', 3::smallint, 'Clique no link do e-mail', '2026-11-07 00:00:00-03'::timestamptz, 'front /radar/abrir → radar_registrar_abertura_empurrada'),
  ('ficha_email',    4::smallint, 'Ficha entregue (e-mail)',  NULL::timestamptz,                     'front /radar/abrir → radar_registrar_ficha_entregue'),
  ('card_servido',   5::smallint, 'Card servido',             '2026-11-07 00:00:00-03'::timestamptz, 'front ProspectarHojeCard → radar_registrar_card_servido'),
  ('abertura_card',  6::smallint, 'Clique no card',           '2026-11-07 00:00:00-03'::timestamptz, 'front ProspectarHojeCard → radar_registrar_abertura_empurrada'),
  ('ficha_card',     7::smallint, 'Ficha entregue (card)',    NULL::timestamptz,                     'sem escritor no front ainda (card → /radar?cnpj)'),
  ('contato',        8::smallint, 'Contato humano',           NULL::timestamptz,                     'trigger de radar_contatos → radar_eventos (contato, humano), com backfill'),
  ('cadastro',       9::smallint, 'Cadastro no Omie',         NULL::timestamptz,                     'trigger de radar_empresas.omie_cadastrado_em → radar_eventos (cadastrou), com backfill')
  ) AS x(sensor, ordem, rotulo, instalado_em, fonte)
ON CONFLICT (sensor) DO NOTHING;

-- Reconciliação de cadastro sem evento no painel: sem índice, varria as 573 mil linhas de radar_empresas (4,7 s em
-- prod). Parcial: só quem foi cadastrado no Omie (0 linhas hoje) — minúsculo, e serve também a radar_placar_uso().
CREATE INDEX IF NOT EXISTS idx_radar_empresas_omie_cadastrado_em
  ON public.radar_empresas (omie_cadastrado_em) WHERE omie_cadastrado_em IS NOT NULL;

ALTER TABLE public.radar_sensor_falhas  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.radar_funil_sensores ENABLE ROW LEVEL SECURITY;
-- Sem policy de propósito (como as tabelas do pacote D): o front só passa pelas RPCs.
REVOKE ALL ON public.radar_sensor_falhas, public.radar_funil_sensores FROM PUBLIC, anon, authenticated;

-- ── 4. Ficha entregue (2º momento) ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.radar_registrar_ficha_entregue(p_origem text, p_cnpj text, p_envio uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid  uuid := (SELECT auth.uid());
  v_dia  date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_dono uuid;
  v_id   bigint;
  v_ja   boolean;
  v_n    integer;
BEGIN
  -- Mesmos gates de radar_registrar_abertura_empurrada (20261106181000).
  IF NOT COALESCE(private.cap_radar_prospectar(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  IF p_origem IS NULL OR p_origem NOT IN ('email', 'card') THEN
    RAISE EXCEPTION 'origem invalida: %', p_origem USING ERRCODE = '22023';
  END IF;
  IF p_cnpj IS NULL OR btrim(p_cnpj) = '' THEN
    RAISE EXCEPTION 'cnpj obrigatorio' USING ERRCODE = '22023';
  END IF;
  IF (p_origem = 'email') <> (p_envio IS NOT NULL) THEN
    RAISE EXCEPTION 'envio obrigatorio so na origem email' USING ERRCODE = '22023';
  END IF;

  IF p_origem = 'email' THEN
    SELECT e.vendedor_user_id INTO v_dono
      FROM public.radar_email_vendedor_envios e
      JOIN public.radar_email_vendedor_leads l ON l.envio_id = e.id AND l.cnpj = p_cnpj
     WHERE e.id = p_envio;
    IF v_dono IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'motivo', 'link_desconhecido');
    END IF;
  ELSE
    v_dono := v_uid;
  END IF;

  -- O clique deste lead por este usuário: o de hoje (a chave única é por dia) ou, perto da meia-noite, o da
  -- última hora. A ficha chega depois do clique; marcar o mesmo clique de novo não muda nada.
  SELECT a.id, a.ficha_entregue_em IS NOT NULL INTO v_id, v_ja
    FROM public.radar_lead_aberturas a
   WHERE a.origem = p_origem AND a.cnpj = p_cnpj AND a.user_id = v_uid
     AND (a.dia = v_dia OR a.aberto_em > now() - interval '1 hour')
   ORDER BY a.aberto_em DESC
   LIMIT 1
     FOR UPDATE;

  IF v_id IS NOT NULL THEN
    IF v_ja THEN
      RETURN jsonb_build_object('ok', true, 'registrado', false, 'clique_registrado', true);
    END IF;
    UPDATE public.radar_lead_aberturas SET ficha_entregue_em = now() WHERE id = v_id;
    RETURN jsonb_build_object('ok', true, 'registrado', true, 'clique_registrado', true);
  END IF;

  -- Sem clique: o registro dele se perdeu. A ficha chegou, então o clique aconteceu — a linha nasce aqui, marcada.
  INSERT INTO public.radar_lead_aberturas
    (origem, envio_id, cnpj, user_id, do_destinatario, dia, ficha_entregue_em, clique_registrado)
  VALUES (p_origem, p_envio, p_cnpj, v_uid, v_dono = v_uid, v_dia, now(), false)
  ON CONFLICT (origem, cnpj, user_id, dia) DO UPDATE SET ficha_entregue_em = EXCLUDED.ficha_entregue_em
   WHERE public.radar_lead_aberturas.ficha_entregue_em IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'registrado', v_n = 1, 'clique_registrado', false);
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_registrar_ficha_entregue(text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_registrar_ficha_entregue(text, text, uuid) TO authenticated;

-- ── 5. Falha de sensor (visto pelo cliente) ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.radar_registrar_falha_sensor(p_sensor text, p_motivo text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid    uuid := (SELECT auth.uid());
  v_motivo text;
BEGIN
  -- Sem o gate do Radar de propósito: "sem acesso ao Radar" é justamente uma das falhas a registrar. Só staff.
  IF v_uid IS NULL OR NOT (COALESCE(public.has_role(v_uid, 'employee'::public.app_role), false)
                           OR COALESCE(public.has_role(v_uid, 'master'::public.app_role), false)) THEN
    RAISE EXCEPTION 'forbidden: falha de sensor exige staff' USING ERRCODE = '42501';
  END IF;
  IF p_sensor IS NULL OR p_sensor NOT IN ('card_servido', 'abertura_card', 'abertura_email', 'ficha_card', 'ficha_email') THEN
    RAISE EXCEPTION 'sensor invalido: %', p_sensor USING ERRCODE = '22023';
  END IF;
  v_motivo := left(btrim(regexp_replace(lower(COALESCE(p_motivo, '')), '[^a-z0-9_]+', '_', 'g'), '_'), 40);
  IF v_motivo = '' THEN v_motivo := 'desconhecido'; END IF;

  INSERT INTO public.radar_sensor_falhas (sensor, motivo, user_id, dia)
  VALUES (p_sensor, v_motivo, v_uid, (now() AT TIME ZONE 'America/Sao_Paulo')::date)
  ON CONFLICT (sensor, motivo, user_id, dia)
  DO UPDATE SET n = public.radar_sensor_falhas.n + 1, ultimo_em = now();
  RETURN jsonb_build_object('ok', true, 'sensor', p_sensor, 'motivo', v_motivo);
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_registrar_falha_sensor(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_registrar_falha_sensor(text, text) TO authenticated;

-- ── 6. O painel ─────────────────────────────────────────────────────────────────────────────────────────
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
           max(sc.estado) FILTER (WHERE sc.sensor = 'cadastro')       AS cadastro
      FROM sem_cob sc
     GROUP BY sc.semana
  ),
  vend AS (
    SELECT env.uid FROM env WHERE env.semana >= v_ini
    UNION SELECT s.user_id FROM public.radar_prospectar_hoje_servido s WHERE s.dia >= v_ini
    UNION SELECT a.user_id FROM public.radar_lead_aberturas a
           WHERE a.dia >= v_ini AND (a.origem = 'card' OR a.do_destinatario)
    UNION SELECT ev.uid FROM ev
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
           CASE WHEN cw.cadastro       <> 'ausente' THEN COALESCE(g.cadastros_vinculo, 0) END AS cadastros_vinculo
      FROM sem
      JOIN cw ON cw.semana = sem.semana
     CROSS JOIN vend v
      LEFT JOIN env_ag ea    ON ea.semana = sem.semana AND ea.uid = v.uid
      LEFT JOIN cli_email ce ON ce.semana = sem.semana AND ce.uid = v.uid
      LEFT JOIN card_srv cs  ON cs.semana = sem.semana AND cs.uid = v.uid
      LEFT JOIN card_cli cc  ON cc.semana = sem.semana AND cc.uid = v.uid
      LEFT JOIN ev_ag g      ON g.semana = sem.semana AND g.uid = v.uid
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
      -- Reconciliação do fail-open dos triggers do ledger (mesma de radar_placar_uso), recortada ao período.
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
                        FROM linhas l))
    INTO v_out;

  RETURN v_out;
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_funil(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_funil(integer) TO authenticated;
-- O diagnóstico read-only (psql-ro) lê o mesmo painel que a tela, como radar_placar_uso (20261029150100). O gate da
-- função continua valendo: sem JWT de master/gestor na sessão, 42501. Os registradores NÃO entram (gravam).
DO $ro$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'claude_ro') THEN
    GRANT EXECUTE ON FUNCTION public.radar_funil(integer) TO claude_ro;
  END IF;
END
$ro$;

-- ── Postcondição ────────────────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  f text;
  t text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.radar_registrar_ficha_entregue(text,text,uuid)',
                           'public.radar_registrar_falha_sensor(text,text)',
                           'public.radar_funil(integer)'] LOOP
    IF to_regprocedure(f) IS NULL THEN
      RAISE EXCEPTION 'H1 FALHOU: % ausente', f;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(f)) THEN
      RAISE EXCEPTION 'H1 FALHOU: % não é SECURITY DEFINER', f;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(f) AND p.proconfig @> ARRAY['search_path=""']) THEN
      RAISE EXCEPTION 'H1 FALHOU: % sem search_path vazio', f;
    END IF;
    -- ACL nas DUAS pontas: anon fora e PUBLIC fora (entrada "=X/" no proacl); authenticated dentro.
    IF has_function_privilege('anon', to_regprocedure(f), 'EXECUTE') THEN
      RAISE EXCEPTION 'H2 FALHOU: anon executa %', f;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, unnest(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                WHERE p.oid = to_regprocedure(f) AND a::text LIKE '=%') THEN
      RAISE EXCEPTION 'H2 FALHOU: PUBLIC executa %', f;
    END IF;
    IF NOT has_function_privilege('authenticated', to_regprocedure(f), 'EXECUTE') THEN
      RAISE EXCEPTION 'H2 FALHOU: authenticated não executa %', f;
    END IF;
  END LOOP;
  IF (SELECT p.provolatile FROM pg_proc p WHERE p.oid = 'public.radar_funil(integer)'::regprocedure) <> 's' THEN
    RAISE EXCEPTION 'H3 FALHOU: radar_funil não é STABLE (a lente só libera leitura pura)';
  END IF;
  FOREACH t IN ARRAY ARRAY['public.radar_sensor_falhas', 'public.radar_funil_sensores'] LOOP
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = t::regclass) THEN
      RAISE EXCEPTION 'H4 FALHOU: % sem RLS', t;
    END IF;
    IF has_table_privilege('anon', t, 'SELECT') OR has_table_privilege('authenticated', t, 'SELECT')
       OR has_table_privilege('authenticated', t, 'INSERT') THEN
      RAISE EXCEPTION 'H4 FALHOU: % aberta ao JWT', t;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.radar_funil_sensores) < 9 THEN
    RAISE EXCEPTION 'H5 FALHOU: registro de sensores incompleto';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                    AND table_name = 'radar_lead_aberturas' AND column_name = 'ficha_entregue_em') THEN
    RAISE EXCEPTION 'H5 FALHOU: radar_lead_aberturas.ficha_entregue_em ausente';
  END IF;
  RAISE NOTICE 'POSTCONDICAO RADAR FUNIL OK';
END
$post$;

COMMIT;
