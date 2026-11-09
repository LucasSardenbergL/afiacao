-- =============================================================================
-- Radar: a agenda "Hoje" do pacote L entra na adoção do funil (pacote M) e na retenção
-- =============================================================================
-- Por que: o pacote L (20261111134000, #3762) grava o uso da agenda "Hoje" do /radar em public.radar_agenda_uso
-- ('vista' = a agenda apareceu com retorno ou posse a cuidar; 'aberta' = o vendedor abriu um lead por ela), mas a
-- adoção do radar_funil (pacote M, 20261111134500) não a lia: quem trabalha pela agenda aparecia "sem ação", e a
-- tabela não tinha retenção. Medido em PROD (psql-ro, 2026-11-09): tabela no ar, 0 linha.
--
-- O que muda (só CREATE OR REPLACE; ACL preservado; sem DROP nem DELETE na migration):
--   1. public.radar_funil: 'vista' conta como EXPOSIÇÃO, 'aberta' como AÇÃO HUMANA; quem só usou a agenda entra no
--      universo do período. O resto do painel é idêntico ao do pacote M.
--   2. private.radar_expurgar_medicao: apaga radar_agenda_uso com mais de 400 dias (devolve a contagem em 'agenda').
--      O cron radar-expurgo-medicao-diario não muda.
--
-- Molde TRAVA → PRE → CREATE → PÓS. Sem BEGIN/COMMIT no arquivo: a transação é do executor (`bun run db:aplicar`).
-- No SQL Editor, cole entre BEGIN; e COMMIT;. Dentro do envelope (idempotente, transacional, postcondição).
-- Prova PG17: db/test-radar-funil-agenda.sh (--falsificar).
-- =============================================================================

-- ── TRAVA ────────────────────────────────────────────────────────────────────────────────────────────────
DO $trava$
BEGIN
  IF to_regclass('public.radar_agenda_uso') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: radar_agenda_uso ausente — aplique o pacote L (20261111134000) antes';
  END IF;
  IF to_regclass('public.radar_card_exibicoes') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: aplique o pacote M (20261111134500) antes';
  END IF;
  -- ALTER sem efeito (COST, que a PRE não confere e o CREATE OR REPLACE reaplica): prende as duas até o COMMIT.
  ALTER FUNCTION public.radar_funil(integer) COST 100;
  ALTER FUNCTION private.radar_expurgar_medicao(integer) COST 100;
END
$trava$;

-- ── PRE: corpo vivo ∈ {o do pacote M (PROD 2026-11-09, psql-ro), este arquivo} ────────────────────────────
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT v.alvo, v.predecessor, v.este,
           (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v.alvo)) AS vivo
      FROM (VALUES
        ('public.radar_funil(integer)', 'fb09ceea1ad40a78dc471b3a5e4ec95d', '5783aa6cad21997ea4100dbefee4a99c'),
        ('private.radar_expurgar_medicao(integer)', '398268b3a365066ea7c99964dc9530ea', '10eb3f1121cafa7c99c7ea767453b73f')
      ) AS v(alvo, predecessor, este)
  LOOP
    IF r.vivo IS NULL THEN
      RAISE EXCEPTION 'PRE FALHOU: % ausente', r.alvo;
    ELSIF r.vivo IS DISTINCT FROM r.predecessor AND r.vivo IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) não é o predecessor revisado nem este — outra sessão mudou; refaça o pré-voo', r.alvo, r.vivo;
    END IF;
  END LOOP;
END
$pre$;

-- ── 1. O painel ──────────────────────────────────────────────────────────────────────────────────────────────
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
    UNION SELECT g.user_id FROM public.radar_agenda_uso g WHERE g.dia >= v_ini
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
  -- tela ou ficha aberta, agenda "Hoje" vista) ou ele agiu. Ação humana = clique em lead empurrado, ficha aberta,
  -- intenção de contato, contato registrado (qualquer desfecho), cadastro, assumir um lead (atribuição do gestor não é
  -- ação dele) ou abrir um lead da agenda.
  expo AS (
              SELECT exib.uid, exib.exibido_em AS ts FROM exib
    UNION ALL SELECT s.user_id, s.servido_em FROM public.radar_prospectar_hoje_servido s WHERE s.dia >= v_ini
    UNION ALL SELECT env.uid, env.notificado_em FROM env WHERE env.status = 'notificado' AND env.notificado_em >= v_ini_ts
    UNION ALL SELECT e.user_id, e.ocorrido_em FROM public.radar_eventos e
               WHERE e.evento = 'abriu' AND e.origem = 'humano' AND e.ocorrido_em >= v_ini_ts AND e.user_id IS NOT NULL
    -- Agenda "Hoje" do pacote L (20261111134000): 'vista' = a agenda apareceu com retorno ou posse a cuidar.
    UNION ALL SELECT g.user_id, g.criado_em FROM public.radar_agenda_uso g WHERE g.evento = 'vista' AND g.dia >= v_ini
  ),
  acao AS (
              SELECT a.user_id AS uid, a.aberto_em AS ts FROM public.radar_lead_aberturas a WHERE a.dia >= v_ini
    UNION ALL SELECT e.user_id, e.ocorrido_em FROM public.radar_eventos e
               WHERE e.origem = 'humano' AND e.user_id IS NOT NULL AND e.ocorrido_em >= v_ini_ts
                 AND (e.evento IN ('contato', 'cadastrou', 'intencao') OR (e.evento = 'abriu' AND e.cnpj IS NOT NULL))
    UNION ALL SELECT t.dono_user_id, t.assumido_em FROM public.radar_atendimentos t
               WHERE t.assumido_em >= v_ini_ts AND t.atribuido_por IS NULL
    -- 'aberta' = o vendedor abriu um lead pela agenda: é ação dele.
    UNION ALL SELECT g.user_id, g.criado_em FROM public.radar_agenda_uso g WHERE g.evento = 'aberta' AND g.dia >= v_ini
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
-- CREATE OR REPLACE preserva o ACL (REVOKE PUBLIC/anon, GRANT authenticated e claude_ro).

-- ── 2. Retenção ──────────────────────────────────────────────────────────────────────────────────────────────
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
  v_agenda integer;
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
  -- Uso da agenda do pacote L (1 'vista' por dia, 1 'aberta' por lead e dia): 400 dias, como os outros sensores de uso.
  DELETE FROM public.radar_agenda_uso g WHERE g.dia < v_hoje - 400;
  GET DIAGNOSTICS v_agenda = ROW_COUNT;
  RETURN jsonb_build_object('eventos_automaticos', v_auto, 'eventos_humanos_400d', v_humano, 'aberturas', v_aber,
                            'exibicoes', v_exib, 'card_servido', v_serv, 'falhas_sensor', v_falha, 'agenda', v_agenda);
END
$fn$;
-- CREATE OR REPLACE preserva o ACL (REVOKE PUBLIC, anon, authenticated).

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
        ('public.radar_funil(integer)', '5783aa6cad21997ea4100dbefee4a99c'),
        ('private.radar_expurgar_medicao(integer)', '10eb3f1121cafa7c99c7ea767453b73f')
      ) AS v(alvo, este)
  LOOP
    IF r.vivo IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'G1 FALHOU: % vivo (md5 %) não é este', r.alvo, r.vivo;
    END IF;
  END LOOP;
  -- P2: atributos e ACL preservados pelo CREATE OR REPLACE.
  FOREACH f IN ARRAY ARRAY['public.radar_funil(integer)', 'private.radar_expurgar_medicao(integer)'] LOOP
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(f)) THEN
      RAISE EXCEPTION 'G2 FALHOU: % não é SECURITY DEFINER', f;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(f) AND p.proconfig @> ARRAY['search_path=""']) THEN
      RAISE EXCEPTION 'G2 FALHOU: % sem search_path vazio', f;
    END IF;
    IF has_function_privilege('anon', to_regprocedure(f), 'EXECUTE') THEN
      RAISE EXCEPTION 'G2 FALHOU: anon executa %', f;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, unnest(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                WHERE p.oid = to_regprocedure(f) AND a::text LIKE '=%') THEN
      RAISE EXCEPTION 'G2 FALHOU: PUBLIC executa %', f;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated', 'public.radar_funil(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G2 FALHOU: authenticated não executa radar_funil';
  END IF;
  IF has_function_privilege('authenticated', 'private.radar_expurgar_medicao(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G2 FALHOU: authenticated executa o expurgo';
  END IF;
  IF (SELECT p.provolatile FROM pg_proc p WHERE p.oid = 'public.radar_funil(integer)'::regprocedure) <> 's' THEN
    RAISE EXCEPTION 'G2 FALHOU: radar_funil não é STABLE (a lente só libera leitura pura)';
  END IF;
  RAISE NOTICE 'POSTCONDICAO RADAR FUNIL AGENDA OK';
END
$post$;

NOTIFY pgrst, 'reload schema';
