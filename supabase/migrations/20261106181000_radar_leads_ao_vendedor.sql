-- =============================================================================
-- Radar, pacote D: levar o lead até o vendedor
--   D1 · e-mail semanal com 5 leads do território de cada vendedor (cron DESLIGADO até o founder ligar)
--   D2 · card "Prospectar hoje" no painel do farmer (3 leads, mesma regra de escolha)
-- =============================================================================
-- Medição que decidiu a ordem (psql-ro + HogQL, 2026-11-06): a rota de visita nunca gravou nada
-- (route_visits, visitas_agendadas, route_contact_log e route_queue_snapshot com n_tup_ins = 0) e
-- /admin/route-planner e /farmer tiveram 0 page views em 60 dias. As 2 farmers (carteiras de 1.570 e 1.272
-- clientes, 100% com endereço casado a município do Radar) não deixam rastro no app: nem telemetria, nem
-- ledger, nem PostHog. O e-mail é o único canal que chega nelas fora do app; por isso D1 vem antes de D2.
-- Detalhe e consultas: docs/historico/radar-leads-ao-vendedor-2026-11-06.md.
--
-- O que entra (idempotente; envelope BEGIN/COMMIT para SQL Editor/MCP; postcondição DO $post$):
--   1. Tabelas, todas com RLS e SEM policy (fechadas ao JWT; o front só passa pelas RPCs):
--      • radar_email_vendedor_config: liga/desliga por vendedor (`ativo`, default false) e `email_teste`
--        (desvia o e-mail para um destinatário de teste; o envio não entra no denominador). Escrita: founder.
--      • radar_email_vendedor_envios: 1 linha por e-mail gerado (vendedor, semana, destinatário resolvido,
--        alerta). É o DENOMINADOR do sensor e a fonte do destinatário para a edge dispatch-notifications.
--      • radar_email_vendedor_leads: os leads de cada envio (posição, score, município).
--      • radar_lead_aberturas: cada abertura de lead vinda do e-mail (link /radar/abrir/<envio>/<cnpj>) ou do
--        card. Numerador do sensor. 1 por (origem, cnpj, usuário, dia).
--      • radar_prospectar_hoje_servido: 1 por (vendedor, dia) em que o card mostrou ≥ 1 lead. Denominador do D2.
--   2. private.radar_territorio_do_vendedor(p_vendedor, p_top): os municípios onde o vendedor tem mais clientes
--      da carteira (carteira_assignments elegível × addresses × radar_municipios por norm_cidade + UF). Cada
--      município pertence a UM vendedor, o que tem mais clientes nele (empate: menor uuid), para dois vendedores
--      não receberem os mesmos leads (Divinópolis é o 1º município das duas farmers: 358 × 223 clientes).
--   3. private.radar_leads_do_vendedor(p_vendedor, p_n, p_nao_repetir_desde, p_agora): top-N por score nesse
--      território. Fora: ja_cliente, status ≠ a_contatar (descartado, em conversa, virou cliente), sem score
--      (ausente ≠ zero: não entra como 0, fica fora), situação RFB 03/04/08 e lead com dono temporário ATIVO de
--      outro vendedor (mesma regra de radar_atendimentos_ativos). `elegiveis` = tamanho do universo (denominador
--      do e-mail).
--   4. public.radar_avisar_vendedores(p_agora): entrypoint do cron. Para cada config ativa sem envio na semana,
--      gera 1 fornecedor_alerta (status pendente_notificacao: o job 102 drena a fila a cada 30 min por
--      net.http_post com timeout de 60 s e a edge manda o e-mail) + o envio + os leads. Nenhum lead se repete
--      para o mesmo vendedor em 90 dias (envios de teste não contam). Vendedor pulado sai com o motivo no ledger
--      acoes_execucoes (radar.avisar_vendedores). Erro propaga, tudo numa transação.
--   5. public.radar_prospectar_hoje(p_vendedor, p_n): leitura PURA do card (D2). Gate cap_radar_prospectar; ver outro
--      vendedor exige gestor (lente "Ver como"). O "servido" é gravado por public.radar_registrar_card_servido(n),
--      separada para a leitura caber na allowlist de leitura da lente e a escrita ficar bloqueada nela.
--   6. public.radar_registrar_abertura_empurrada(p_origem, p_cnpj, p_envio): grava a abertura vinda do e-mail ou
--      do card.
--   7. cron radar-avisar-vendedores-semanal, segunda 11:00 UTC (08:00 BRT), CRIADO DESLIGADO (active = false).
--      Ligar é decisão do founder: 1) config ativa para o vendedor, 2) cron.alter_job(..., active := true).
--      Re-colar a migration não religa nem desliga um job que já existe.
-- Prova PG17: db/test-radar-leads-vendedor.sh (--falsificar).
-- =============================================================================

BEGIN;

-- ── TRAVA: pré-requisitos vivos ─────────────────────────────────────────────────────────────────────────
DO $trava$
BEGIN
  IF to_regprocedure('private.cap_radar_prospectar(uuid)') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: private.cap_radar_prospectar ausente — aplique 20261029201200_radar_acesso_vendedor antes';
  END IF;
  IF to_regprocedure('private.radar_atendimento_expira_em(text,uuid,timestamptz,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: private.radar_atendimento_expira_em ausente — aplique 20261029201200_radar_acesso_vendedor antes';
  END IF;
  IF to_regprocedure('private.pode_ver_carteira_completa(uuid)') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: private.pode_ver_carteira_completa ausente';
  END IF;
  IF to_regprocedure('public.norm_cidade(text)') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: public.norm_cidade ausente — aplique 20260614160000_roteirizador_campo_banco antes';
  END IF;
  IF to_regclass('public.carteira_assignments') IS NULL OR to_regclass('public.radar_atendimentos') IS NULL
     OR to_regclass('public.fornecedor_alerta') IS NULL OR to_regclass('public.acoes_execucoes') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: carteira_assignments, radar_atendimentos, fornecedor_alerta ou acoes_execucoes ausente';
  END IF;
END
$trava$;

-- ── 1. Tabelas ──────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.radar_email_vendedor_config (
  vendedor_user_id uuid PRIMARY KEY,
  ativo            boolean NOT NULL DEFAULT false,
  email_teste      text CHECK (email_teste IS NULL OR email_teste ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  atualizado_em    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.radar_email_vendedor_config IS
  'Radar D1: liga/desliga o e-mail semanal de leads por vendedor. Escrita: founder (SQL Editor). email_teste preenchido desvia o e-mail para um destinatário de teste; esse envio não conta no denominador nem queima leads. Migration 20261106181000.';

CREATE TABLE IF NOT EXISTS public.radar_email_vendedor_envios (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendedor_user_id   uuid NOT NULL,
  semana             date NOT NULL CHECK (extract(isodow FROM semana) = 1),
  destinatario_email text NOT NULL,
  eh_teste           boolean NOT NULL,
  alerta_id          bigint NOT NULL UNIQUE REFERENCES public.fornecedor_alerta(id),
  territorio         jsonb NOT NULL,
  n_leads            smallint NOT NULL CHECK (n_leads BETWEEN 1 AND 5),
  elegiveis          integer NOT NULL CHECK (elegiveis >= n_leads),
  criado_em          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendedor_user_id, semana, eh_teste)
);
COMMENT ON TABLE public.radar_email_vendedor_envios IS
  'Radar D1: 1 linha por e-mail semanal de leads gerado. Denominador do sensor (envios com alerta notificado e eh_teste = false) e fonte do destinatário para a edge dispatch-notifications. Escritor único: radar_avisar_vendedores().';

CREATE TABLE IF NOT EXISTS public.radar_email_vendedor_leads (
  envio_id         uuid NOT NULL REFERENCES public.radar_email_vendedor_envios(id) ON DELETE CASCADE,
  posicao          smallint NOT NULL CHECK (posicao BETWEEN 1 AND 5),
  cnpj             text NOT NULL,
  score            smallint NOT NULL,
  municipio_codigo text NOT NULL,
  PRIMARY KEY (envio_id, posicao),
  UNIQUE (envio_id, cnpj)
);
CREATE INDEX IF NOT EXISTS idx_radar_email_vendedor_leads_cnpj ON public.radar_email_vendedor_leads (cnpj);

CREATE TABLE IF NOT EXISTS public.radar_lead_aberturas (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  origem          text NOT NULL CHECK (origem IN ('email', 'card')),
  envio_id        uuid REFERENCES public.radar_email_vendedor_envios(id) ON DELETE CASCADE,
  cnpj            text NOT NULL,
  user_id         uuid NOT NULL,
  do_destinatario boolean NOT NULL,
  dia             date NOT NULL,
  aberto_em       timestamptz NOT NULL DEFAULT now(),
  CHECK ((origem = 'email') = (envio_id IS NOT NULL)),
  UNIQUE (origem, cnpj, user_id, dia)
);
CREATE INDEX IF NOT EXISTS idx_radar_lead_aberturas_envio ON public.radar_lead_aberturas (envio_id) WHERE envio_id IS NOT NULL;
COMMENT ON TABLE public.radar_lead_aberturas IS
  'Radar D1/D2: abertura de lead empurrado (e-mail semanal ou card Prospectar hoje). Numerador do sensor. Escritor único: radar_registrar_abertura_empurrada().';

CREATE TABLE IF NOT EXISTS public.radar_prospectar_hoje_servido (
  user_id    uuid NOT NULL,
  dia        date NOT NULL,
  n_leads    smallint NOT NULL CHECK (n_leads BETWEEN 1 AND 5),
  servido_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, dia)
);
COMMENT ON TABLE public.radar_prospectar_hoje_servido IS
  'Radar D2: dias em que o card Prospectar hoje mostrou ≥ 1 lead ao próprio vendedor. Denominador do D2. Escritor único: radar_prospectar_hoje().';

ALTER TABLE public.radar_email_vendedor_config   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.radar_email_vendedor_envios   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.radar_email_vendedor_leads    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.radar_lead_aberturas          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.radar_prospectar_hoje_servido ENABLE ROW LEVEL SECURITY;
-- Sem policy de propósito: o default privilege do Supabase dá ALL ao anon/authenticated em tabela nova; com RLS
-- ligada e sem policy, nada passa, e o REVOKE fecha também o privilégio (defesa em profundidade).
REVOKE ALL ON public.radar_email_vendedor_config, public.radar_email_vendedor_envios, public.radar_email_vendedor_leads,
              public.radar_lead_aberturas, public.radar_prospectar_hoje_servido FROM PUBLIC, anon, authenticated;

-- ── 2. Território do vendedor ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.radar_territorio_do_vendedor(p_vendedor uuid, p_top integer DEFAULT 3)
RETURNS TABLE (municipio_codigo text, municipio_nome text, uf text, clientes integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  -- Forma medida em PROD (2026-11-06): com cast ::text nas colunas enum o planejador estimava 1 linha de carteira
  -- (são 2.842) e casava endereço × município num laço aninhado: > 30 s. Comparando no enum e carregando o dono
  -- junto do endereço (sem reunir a carteira de novo), com os dois lados normalizados e MATERIALIZED: ~100 ms.
  WITH vendedores AS (
    SELECT cr.user_id
      FROM public.commercial_roles cr
     WHERE cr.commercial_role IN ('farmer', 'hunter', 'closer')
       AND EXISTS (SELECT 1 FROM public.user_roles ur
                    WHERE ur.user_id = cr.user_id AND ur.role = 'employee')
  ),
  ende AS MATERIALIZED (
    SELECT DISTINCT ON (a.owner_user_id, a.customer_user_id)
           a.owner_user_id AS dono, a.customer_user_id AS cliente,
           public.norm_cidade(regexp_replace(ad.city, '\s*\([^)]*\)\s*$', '')) AS nc,
           upper(btrim(ad.state)) AS uf
      FROM public.carteira_assignments a
      JOIN vendedores v ON v.user_id = a.owner_user_id
      JOIN public.addresses ad ON ad.user_id = a.customer_user_id
     WHERE a.eligible IS TRUE
     ORDER BY a.owner_user_id, a.customer_user_id, ad.is_default DESC NULLS LAST, ad.created_at DESC, ad.id
  ),
  mun AS MATERIALIZED (
    SELECT m.codigo, m.nome, upper(btrim(m.uf)) AS uf, public.norm_cidade(m.nome) AS nc
      FROM public.radar_municipios m
  ),
  por_mun AS (
    SELECT e.dono, mu.codigo, mu.nome, mu.uf, count(DISTINCT e.cliente)::integer AS n
      FROM ende e
      JOIN mun mu ON mu.nc = e.nc AND mu.uf = e.uf
     GROUP BY e.dono, mu.codigo, mu.nome, mu.uf
  ),
  dono_do_mun AS (
    SELECT DISTINCT ON (pm.codigo) pm.codigo, pm.dono
      FROM por_mun pm
     ORDER BY pm.codigo, pm.n DESC, pm.dono
  )
  SELECT pm.codigo, pm.nome, pm.uf, pm.n
    FROM por_mun pm
    JOIN dono_do_mun d ON d.codigo = pm.codigo AND d.dono = pm.dono
   WHERE pm.dono = p_vendedor
   ORDER BY pm.n DESC, pm.codigo
   LIMIT GREATEST(1, LEAST(COALESCE(p_top, 3), 10));
$fn$;
REVOKE ALL ON FUNCTION private.radar_territorio_do_vendedor(uuid, integer) FROM PUBLIC, anon, authenticated;

-- ── 3. Leads do vendedor ────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.radar_leads_do_vendedor(
  p_vendedor           uuid,
  p_n                  integer,
  p_nao_repetir_desde  timestamptz,
  p_agora              timestamptz DEFAULT now()
)
RETURNS TABLE (posicao integer, cnpj text, razao_social text, nome_fantasia text, municipio_codigo text,
               municipio_nome text, uf text, score smallint, score_motivos text[], elegiveis integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  WITH terr AS (
    SELECT t.municipio_codigo, t.clientes FROM private.radar_territorio_do_vendedor(p_vendedor, 3) t
  ),
  universo AS (
    SELECT re.cnpj, re.razao_social, re.nome_fantasia, re.municipio_codigo, re.municipio_nome, re.uf,
           re.score, re.score_motivos, t.clientes
      FROM terr t
      JOIN public.radar_empresas re ON re.municipio_codigo = t.municipio_codigo
     WHERE re.ja_cliente = false
       AND re.prospeccao_status = 'a_contatar'
       AND re.score IS NOT NULL
       AND (re.rfb_situacao IS NULL OR re.rfb_situacao NOT IN ('03', '04', '08'))
       AND NOT EXISTS (
             SELECT 1 FROM public.radar_atendimentos a
              WHERE a.cnpj = re.cnpj
                AND a.encerrado_em IS NULL
                AND a.dono_user_id <> p_vendedor
                AND private.radar_atendimento_expira_em(a.cnpj, a.dono_user_id, a.assumido_em, a.renovado_em) > p_agora
                AND private.cap_radar_prospectar(a.dono_user_id))
       AND (p_nao_repetir_desde IS NULL OR NOT EXISTS (
             SELECT 1 FROM public.radar_email_vendedor_leads l
               JOIN public.radar_email_vendedor_envios e ON e.id = l.envio_id
              WHERE l.cnpj = re.cnpj
                AND e.vendedor_user_id = p_vendedor
                AND e.eh_teste = false
                AND e.criado_em >= p_nao_repetir_desde))
  )
  SELECT (row_number() OVER (ORDER BY u.score DESC, u.clientes DESC, u.cnpj))::integer,
         u.cnpj, u.razao_social, u.nome_fantasia, u.municipio_codigo, u.municipio_nome, u.uf,
         u.score, u.score_motivos, (count(*) OVER ())::integer
    FROM universo u
   ORDER BY u.score DESC, u.clientes DESC, u.cnpj
   LIMIT GREATEST(1, LEAST(COALESCE(p_n, 5), 5));
$fn$;
REVOKE ALL ON FUNCTION private.radar_leads_do_vendedor(uuid, integer, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;

-- ── 4. E-mail semanal (entrypoint do cron) ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.radar_avisar_vendedores(p_agora timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  c_n           constant integer  := 5;
  c_nao_repetir constant interval := interval '90 days';
  c_app         constant text     := 'https://steu.lovable.app';
  c_email_ok    constant text     := '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';
  v_ini         timestamptz := clock_timestamp();
  v_semana      date := date_trunc('week', p_agora AT TIME ZONE 'America/Sao_Paulo')::date;
  r             record;
  l             record;
  v_teste       boolean;
  v_email       text;
  v_nome        text;
  v_terr        jsonb;
  v_terr_txt    text;
  v_terr_nomes  text;
  v_leads       jsonb;
  v_qtd         integer;
  v_elegiveis   integer;
  v_lista       text;
  v_envio       uuid;
  v_alerta      bigint;
  v_titulo      text;
  v_corpo       text;
  v_avisados    jsonb := '[]'::jsonb;
  v_pulados     jsonb := '[]'::jsonb;
BEGIN
  FOR r IN
    SELECT c.vendedor_user_id AS vendedor, c.email_teste
      FROM public.radar_email_vendedor_config c
     WHERE c.ativo
     ORDER BY c.vendedor_user_id
       FOR UPDATE SKIP LOCKED
  LOOP
    v_teste := r.email_teste IS NOT NULL;

    IF EXISTS (SELECT 1 FROM public.radar_email_vendedor_envios e
                WHERE e.vendedor_user_id = r.vendedor AND e.semana = v_semana AND e.eh_teste = v_teste) THEN
      v_pulados := v_pulados || jsonb_build_object('vendedor', r.vendedor, 'motivo', 'ja_enviado_na_semana');
      CONTINUE;
    END IF;

    IF NOT COALESCE(private.cap_radar_prospectar(r.vendedor), false) THEN
      v_pulados := v_pulados || jsonb_build_object('vendedor', r.vendedor, 'motivo', 'sem_acesso_ao_radar');
      CONTINUE;
    END IF;

    SELECT p.email, p.name INTO v_email, v_nome
      FROM public.profiles p WHERE p.user_id = r.vendedor
     ORDER BY p.created_at LIMIT 1;
    v_email := COALESCE(r.email_teste, btrim(v_email));
    IF v_email IS NULL OR v_email !~ c_email_ok THEN
      v_pulados := v_pulados || jsonb_build_object('vendedor', r.vendedor, 'motivo', 'sem_email');
      CONTINUE;
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('municipio_codigo', t.municipio_codigo, 'municipio_nome', t.municipio_nome,
                                                 'uf', t.uf, 'clientes', t.clientes) ORDER BY t.clientes DESC, t.municipio_codigo), '[]'::jsonb),
           string_agg(t.municipio_nome || ' (' || t.clientes || ' clientes seus)', ' · ' ORDER BY t.clientes DESC, t.municipio_codigo),
           string_agg(t.municipio_nome, ', ' ORDER BY t.clientes DESC, t.municipio_codigo)
      INTO v_terr, v_terr_txt, v_terr_nomes
      FROM private.radar_territorio_do_vendedor(r.vendedor, 3) t;
    IF jsonb_array_length(v_terr) = 0 THEN
      v_pulados := v_pulados || jsonb_build_object('vendedor', r.vendedor, 'motivo', 'sem_territorio');
      CONTINUE;
    END IF;

    SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.posicao), '[]'::jsonb), count(*), max(x.elegiveis)
      INTO v_leads, v_qtd, v_elegiveis
      FROM private.radar_leads_do_vendedor(r.vendedor, c_n, p_agora - c_nao_repetir, p_agora) x;
    IF v_qtd = 0 THEN
      v_pulados := v_pulados || jsonb_build_object('vendedor', r.vendedor, 'motivo', 'sem_leads', 'territorio', v_terr);
      CONTINUE;
    END IF;

    v_envio := gen_random_uuid();
    v_lista := '';
    FOR l IN
      SELECT * FROM jsonb_to_recordset(v_leads) AS x(posicao integer, cnpj text, razao_social text, nome_fantasia text,
                                                    municipio_codigo text, municipio_nome text, uf text, score smallint,
                                                    score_motivos text[], elegiveis integer)
       ORDER BY x.posicao
    LOOP
      v_lista := v_lista
        || l.posicao || '. ' || COALESCE(NULLIF(btrim(l.nome_fantasia), ''), l.razao_social, l.cnpj)
        || CASE WHEN NULLIF(btrim(l.nome_fantasia), '') IS NOT NULL AND l.razao_social IS NOT NULL
                THEN ' (' || l.razao_social || ')' ELSE '' END || E'\n'
        || '   ' || COALESCE(l.municipio_nome, '?') || '/' || COALESCE(l.uf, '?') || ' · score ' || l.score
        || COALESCE(' · ' || NULLIF(array_to_string(l.score_motivos[1:2], '; '), ''), '') || E'\n'
        || '   Abrir no Radar: ' || c_app || '/radar/abrir/' || v_envio || '/' || l.cnpj || E'\n\n';
    END LOOP;

    v_titulo := 'Radar: ' || v_qtd || CASE WHEN v_qtd = 1 THEN ' empresa' ELSE ' empresas' END
             || ' para prospectar esta semana (' || v_terr_nomes || ')';
    v_corpo := 'Olá' || COALESCE(', ' || NULLIF(split_part(btrim(v_nome), ' ', 1), ''), '') || '!' || E'\n\n'
      || 'Separei ' || v_qtd || CASE WHEN v_qtd = 1 THEN ' empresa' ELSE ' empresas' END
      || ' para você prospectar esta semana, perto de onde você já tem clientes: ' || v_terr_txt || '.' || E'\n\n'
      || v_lista
      || 'O link abre a ficha no Radar, com telefone, sócios e o botão para registrar o contato.' || E'\n\n'
      || 'Como escolhi: maior score do Radar entre ' || v_elegiveis || ' empresas a contatar nesses municípios. Ficam de fora '
      || 'quem já é cliente, descartados, empresas baixadas ou inaptas na Receita, empresas sem score e leads em '
      || 'atendimento por outro vendedor. Nenhuma empresa desta lista volta a aparecer para você nos próximos 90 dias.'
      || CASE WHEN v_teste THEN E'\n\n[TESTE] Este e-mail era para ' || COALESCE(v_nome, r.vendedor::text)
                              || ' e foi desviado para ' || v_email || '. Não entra na contagem de envios.'
              ELSE '' END;

    INSERT INTO public.fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status, metadata)
    VALUES ('oben', 'outro', 'info', v_titulo, v_corpo, 'pendente_notificacao',
            jsonb_build_object('origem', 'radar.avisar_vendedores', 'envio_id', v_envio, 'semana', v_semana,
                               'n_leads', v_qtd, 'teste', v_teste))
    RETURNING id INTO v_alerta;

    INSERT INTO public.radar_email_vendedor_envios
      (id, vendedor_user_id, semana, destinatario_email, eh_teste, alerta_id, territorio, n_leads, elegiveis, criado_em)
    VALUES (v_envio, r.vendedor, v_semana, v_email, v_teste, v_alerta, v_terr, v_qtd, v_elegiveis, p_agora);

    INSERT INTO public.radar_email_vendedor_leads (envio_id, posicao, cnpj, score, municipio_codigo)
      SELECT v_envio, x.posicao, x.cnpj, x.score, x.municipio_codigo
        FROM jsonb_to_recordset(v_leads) AS x(posicao smallint, cnpj text, score smallint, municipio_codigo text);

    v_avisados := v_avisados || jsonb_build_object('vendedor', r.vendedor, 'envio_id', v_envio, 'alerta_id', v_alerta,
                                                   'n_leads', v_qtd, 'elegiveis', v_elegiveis, 'teste', v_teste);
  END LOOP;

  -- Ledger só quando havia vendedor ligado: semana sem config ativa não suja acoes_execucoes
  -- (cron.job_run_details é a fonte do "rodou"). Pulado também entra: vendedor ligado sem e-mail tem de aparecer.
  IF jsonb_array_length(v_avisados) + jsonb_array_length(v_pulados) > 0 THEN
    INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
    VALUES ('radar.avisar_vendedores', 'automatica', v_ini, clock_timestamp(), 'sucesso',
            jsonb_build_object('semana', v_semana, 'avisados', v_avisados, 'pulados', v_pulados));
  END IF;

  RETURN jsonb_build_object('semana', v_semana, 'avisados', v_avisados, 'pulados', v_pulados);
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_avisar_vendedores(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_avisar_vendedores(timestamptz) TO service_role;

-- ── 5. Card "Prospectar hoje" (D2) ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.radar_prospectar_hoje(p_vendedor uuid DEFAULT NULL, p_n integer DEFAULT 3)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid   uuid := (SELECT auth.uid());
  v_alvo  uuid;
  v_n     integer := GREATEST(1, LEAST(COALESCE(p_n, 3), 5));
  v_terr  jsonb;
  v_leads jsonb;
BEGIN
  IF NOT COALESCE(private.cap_radar_prospectar(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  v_alvo := COALESCE(p_vendedor, v_uid);
  IF v_alvo <> v_uid AND NOT COALESCE(private.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: leads de outro vendedor exigem gestor' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('municipio_codigo', t.municipio_codigo, 'municipio_nome', t.municipio_nome,
                                               'uf', t.uf, 'clientes', t.clientes) ORDER BY t.clientes DESC, t.municipio_codigo), '[]'::jsonb)
    INTO v_terr
    FROM private.radar_territorio_do_vendedor(v_alvo, 3) t;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('posicao', x.posicao, 'cnpj', x.cnpj, 'razao_social', x.razao_social,
                                               'nome_fantasia', x.nome_fantasia, 'municipio_nome', x.municipio_nome,
                                               'uf', x.uf, 'score', x.score, 'score_motivos', to_jsonb(x.score_motivos),
                                               'elegiveis', x.elegiveis) ORDER BY x.posicao), '[]'::jsonb)
    INTO v_leads
    FROM private.radar_leads_do_vendedor(v_alvo, v_n, NULL, now()) x;

  RETURN jsonb_build_object('territorio', v_terr, 'leads', v_leads);
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_prospectar_hoje(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_prospectar_hoje(uuid, integer) TO authenticated;

-- Sensor do D2 em RPC própria: a leitura acima fica PURA (entra na allowlist de leitura da lente "Ver como"); esta
-- grava e por isso o write-guard a bloqueia na lente — gestor inspecionando não infla o denominador.
CREATE OR REPLACE FUNCTION public.radar_registrar_card_servido(p_n_leads integer)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_n   integer;
BEGIN
  IF NOT COALESCE(private.cap_radar_prospectar(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  IF p_n_leads IS NULL OR p_n_leads NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION 'n_leads fora de 1..5: %', p_n_leads USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.radar_prospectar_hoje_servido (user_id, dia, n_leads)
  VALUES (v_uid, (now() AT TIME ZONE 'America/Sao_Paulo')::date, p_n_leads)
  ON CONFLICT (user_id, dia) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'registrado', v_n = 1);
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_registrar_card_servido(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_registrar_card_servido(integer) TO authenticated;

-- ── 6. Abertura de lead empurrado ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.radar_registrar_abertura_empurrada(p_origem text, p_cnpj text, p_envio uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid  uuid := (SELECT auth.uid());
  v_dono uuid;
  v_n    integer;
BEGIN
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

  INSERT INTO public.radar_lead_aberturas (origem, envio_id, cnpj, user_id, do_destinatario, dia)
  VALUES (p_origem, p_envio, p_cnpj, v_uid, v_dono = v_uid, (now() AT TIME ZONE 'America/Sao_Paulo')::date)
  ON CONFLICT (origem, cnpj, user_id, dia) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'registrado', v_n = 1, 'do_destinatario', v_dono = v_uid);
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_registrar_abertura_empurrada(text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_registrar_abertura_empurrada(text, text, uuid) TO authenticated;

-- ── 7. Cron semanal, nascido DESLIGADO ──────────────────────────────────────────────────────────────────
DO $cron$
DECLARE v_job bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'radar-avisar-vendedores-semanal') THEN
    v_job := cron.schedule('radar-avisar-vendedores-semanal', '0 11 * * 1', 'SELECT public.radar_avisar_vendedores();');
    PERFORM cron.alter_job(job_id := v_job, active := false);
  END IF;
END
$cron$;

-- ── Postcondição ────────────────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  t text;
  f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['radar_email_vendedor_config', 'radar_email_vendedor_envios', 'radar_email_vendedor_leads',
                           'radar_lead_aberturas', 'radar_prospectar_hoje_servido'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = t AND c.relrowsecurity) THEN
      RAISE EXCEPTION 'A1 FALHOU: public.% ausente ou sem RLS', t;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'A1 FALHOU: public.% ganhou policy — a tabela é fechada ao JWT por desenho', t;
    END IF;
    IF has_table_privilege('anon', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('authenticated', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'A2 FALHOU: anon/authenticated com privilégio em public.%', t;
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['private.radar_territorio_do_vendedor(uuid,integer)',
                           'private.radar_leads_do_vendedor(uuid,integer,timestamptz,timestamptz)',
                           'public.radar_avisar_vendedores(timestamptz)'] LOOP
    IF to_regprocedure(f) IS NULL THEN
      RAISE EXCEPTION 'A3 FALHOU: % ausente', f;
    END IF;
    IF has_function_privilege('public', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE')
       OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'A3 FALHOU: % executável por PUBLIC/anon/authenticated', f;
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['public.radar_prospectar_hoje(uuid,integer)',
                           'public.radar_registrar_card_servido(integer)',
                           'public.radar_registrar_abertura_empurrada(text,text,uuid)'] LOOP
    IF to_regprocedure(f) IS NULL THEN
      RAISE EXCEPTION 'A4 FALHOU: % ausente', f;
    END IF;
    IF has_function_privilege('public', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'A4 FALHOU: ACL de % errada (quer authenticated sim, PUBLIC/anon não)', f;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'radar-avisar-vendedores-semanal'
                   AND command = 'SELECT public.radar_avisar_vendedores();') THEN
    RAISE EXCEPTION 'A5 FALHOU: cron radar-avisar-vendedores-semanal ausente ou com outro comando';
  END IF;
END
$post$;

COMMIT;
