-- ============================================================
-- Radar de Clientes — ledger de eventos decisórios, nota no contato, coortes de controle e placar de uso.
--
-- Frente 3 (score e placar, 2026-10-29). Medido em 2026-10-28 (docs/historico/radar-uso-e-recorte-cnae-2026-10-28.md):
-- o radar não tem uso, e a única fonte de abertura é o outbox, que purga em ~7 dias. O PostHog é cego para o
-- único autorizado (o Chrome do founder bloqueia). Esta migration cria a fonte durável:
--
-- 1. public.radar_eventos — append-only, um evento por FATO de outra tabela:
--      abriu             ← analytics_outbox 'navegacao.rota_servida' com rota '/radar' (1 por titular e dia;
--                          o cliente não grava sob a lente "Ver como": isLensActive() na fonte)
--      contato           ← INSERT em radar_contatos (qualquer escritor: RPC humana, cadastro no Omie, finalize do lote)
--      contato_desfeito  ← DELETE em radar_contatos (desfazer_contato_radar)
--      cadastrou         ← radar_empresas.omie_cadastrado_em NULL → preenchido; acao = origem da confirmação do
--                          servidor (omie_cliente_confirmacoes: 'incluir' = cliente novo, 'lookup' = já existia)
--    ORIGEM vem da identidade gravada NA FONTE, nunca do contexto da sessão (Codex de desenho, P1): contato do
--    UUID de sistema do finalize = 'automatica', qualquer outro criado_por = 'humano' (as RPCs humanas gravam
--    auth.uid()); abertura = titular do outbox; cadastro = auth.uid() da RPC (gate de staff ⇒ nunca NULL por ela).
--    A lente não chega aqui: o write-guard do cliente bloqueia RPC de escrita sob a lente, e o ledger de
--    navegação não grava sob ela. Isso é garantia do CLIENTE — o banco não distingue a lente.
-- 2. A NOTA NO REGISTRO DO CONTATO: o evento 'contato' humano grava score, score_versao e score_em da linha de
--    radar_empresas no instante do INSERT (a RPC já travou a linha com FOR UPDATE; o trigger roda antes do UPDATE de
--    status, que não mexe no score). É o score disponível no banco, o mesmo do cron das 03:30 que a fila mostra —
--    não uma declaração do cliente. Colunas dedicadas, UM escritor (o trigger de contato), nunca jsonb multi-writer.
--    Contato automático (64 mil descartes de uma vez no finalize) segue pelo caminho barato, SEM leitura de nota.
--    Por que trigger e não a RPC: (a) o gate de registrar_contato_radar é da frente 2, que o está trocando —
--    recriar a RPC aqui seria corrida de CREATE OR REPLACE; (b) o trigger pega TODO escritor de radar_contatos
--    (a RPC protege a porta; o trigger fecha a classe — money-path.md §"Guard DENTRO da RPC").
-- 3. public.radar_coorte_controle + radar_coorte_sortear(): no MESMO instante registra o TOPO (score >= 70, todos)
--    e uma AMOSTRA fora do topo (score 40–69, md5(sorteio:cnpj)), no mesmo território e com os mesmos filtros, para
--    comparar conversão com denominador fixo. NÃO sorteia nesta migration: a 1ª rodada do cron depois da
--    20261029150000 é que grava score_versao, e o sorteio recusa linha elegível sem versão (não congela ausência).
-- 4. public.radar_placar_uso(), public.radar_coorte_resultado() e public.radar_conversao_por_faixa(): o placar,
--    lido por psql-ro/SQL Editor.
--
-- Triggers FAIL-OPEN (WARNING) para ERRO do próprio trigger: telemetria não derruba o contato, o finalize do lote nem
-- o ledger de navegação. Cancelamento (statement_timeout) não é capturado — por isso o caminho automático é barato.
-- O fail-open não é silencioso: o placar traz a RECONCILIAÇÃO (contato sem evento; contato apagado sem evento de
-- desfazer; abertura ainda no outbox sem evento). Contato "válido" = a linha AINDA existe em radar_contatos.
--
-- Backfill: contatos e aberturas já existentes entram como retroativo=true, SEM nota (o score do instante não é
-- conhecido: ausente, nunca zero; e nunca reconstruído pelo score atual).
--
-- Locks: CREATE TRIGGER pega SHARE ROW EXCLUSIVE na tabela-fonte até o COMMIT. Por isso as tabelas e funções vêm
-- antes, e cada trigger é criado junto do backfill da sua tabela, com o do outbox (tabela quente) por ÚLTIMO.
--
-- Depende de 20261029150000 (radar_empresas.score_versao). DONO: aplicar como `postgres` (SQL Editor do Lovable
-- ou conector MCP), com envelope BEGIN/COMMIT, fora da janela do cron das 03:30 BRT.
-- Prova: db/test-radar-placar.sh (--falsificar). Diário: docs/historico/radar-score-backtest-e-placar.md
-- ============================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- PRE: a versão da fórmula existe e as tabelas-fonte têm o formato que os triggers leem.
DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'radar_empresas' AND column_name = 'score_versao') THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_empresas.score_versao ausente — aplique 20261029150000 antes desta';
  END IF;
  IF to_regclass('public.radar_contatos') IS NULL OR to_regclass('public.analytics_outbox') IS NULL
     OR to_regclass('public.omie_cliente_confirmacoes') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_contatos, analytics_outbox ou omie_cliente_confirmacoes ausente';
  END IF;
END
$pre$;

-- ------------------------------------------------------------
-- 1. Tabelas
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.radar_eventos (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  evento         text NOT NULL CHECK (evento IN ('abriu', 'contato', 'contato_desfeito', 'cadastrou')),
  origem         text NOT NULL CHECK (origem IN ('humano', 'automatica')),
  ocorrido_em    timestamptz NOT NULL,                     -- instante do FATO (desfazer: o da exclusão)
  gravado_em     timestamptz NOT NULL DEFAULT clock_timestamp(),
  user_id        uuid,                                     -- titular do fato
  cnpj           text,
  contato_id     uuid,                                     -- radar_contatos.id (contato e contato_desfeito)
  acao           text,                                     -- contato: radar_contatos.acao · cadastrou: incluir | lookup
  nota_capturada boolean NOT NULL DEFAULT false,           -- o trigger LEU a linha da empresa no instante do contato
  score          smallint,                                 -- nota no registro do contato (NULL com captura = lead sem nota)
  score_versao   text,                                     -- versão da fórmula dessa nota
  score_em       timestamptz,                              -- quando o cron gravou essa nota
  retroativo     boolean NOT NULL DEFAULT false,           -- backfill: fato anterior ao ledger, sem nota
  fonte_id       text NOT NULL UNIQUE,                     -- idempotência: 1 evento por fato de origem
  CONSTRAINT radar_eventos_nota_so_capturada CHECK (
    nota_capturada OR (score IS NULL AND score_versao IS NULL AND score_em IS NULL)),
  CONSTRAINT radar_eventos_captura_so_no_contato_vivo CHECK (
    NOT nota_capturada OR (evento = 'contato' AND NOT retroativo)),
  CONSTRAINT radar_eventos_humano_tem_titular CHECK (origem = 'automatica' OR user_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_radar_eventos_evento_em ON public.radar_eventos (evento, ocorrido_em);
CREATE INDEX IF NOT EXISTS idx_radar_eventos_contato ON public.radar_eventos (contato_id) WHERE contato_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_radar_eventos_cnpj ON public.radar_eventos (cnpj) WHERE cnpj IS NOT NULL;
COMMENT ON TABLE public.radar_eventos IS
  'Ledger append-only dos fatos decisórios do Radar (abriu/contato/contato_desfeito/cadastrou). Escritores: só os triggers private.radar_evento_*. Lido por radar_placar_uso(), radar_coorte_resultado() e radar_conversao_por_faixa().';

CREATE TABLE IF NOT EXISTS public.radar_coorte_controle (
  sorteio          text NOT NULL,                          -- 'coorte-<lote>': 1 registro por lote
  grupo            text NOT NULL CHECK (grupo IN ('topo', 'amostra')),
  cnpj             text NOT NULL,
  lote             text NOT NULL,
  posicao          integer NOT NULL CHECK (posicao >= 1),  -- topo: por score; amostra: por md5
  score_no_sorteio smallint NOT NULL,
  score_versao     text NOT NULL,
  sorteada_em      timestamptz NOT NULL,
  PRIMARY KEY (sorteio, cnpj),
  UNIQUE (sorteio, grupo, posicao)
);
CREATE INDEX IF NOT EXISTS idx_radar_coorte_cnpj ON public.radar_coorte_controle (cnpj);
COMMENT ON TABLE public.radar_coorte_controle IS
  'Coortes de controle do Radar, registradas no mesmo instante: topo (score >= 70, todos) e amostra fora do topo (40–69, md5(sorteio:cnpj)). Denominador FIXO: quem fica inelegível depois continua aqui. Único escritor: radar_coorte_sortear().';

-- Sem policy: ninguém lê nem escreve por PostgREST. Os escritores são SECURITY DEFINER (dono postgres).
-- REVOKE ALL tira também TRUNCATE (que a RLS não protege) dos defaults de public.
ALTER TABLE public.radar_eventos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.radar_coorte_controle ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.radar_eventos FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.radar_coorte_controle FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.radar_eventos TO service_role;
GRANT SELECT ON TABLE public.radar_coorte_controle TO service_role;

-- ------------------------------------------------------------
-- 2. Escritores do ledger (funções de trigger, FAIL-OPEN)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.radar_evento_contato()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_sistema constant uuid := '00000000-0000-0000-0000-00000000ad0f';  -- Radar · RFB (finalize do lote)
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      IF NEW.criado_por = c_sistema THEN
        -- Caminho barato: descarte automático não lê nota (64 mil linhas por lote).
        INSERT INTO public.radar_eventos (evento, origem, ocorrido_em, user_id, cnpj, contato_id, acao, fonte_id)
        VALUES ('contato', 'automatica', NEW.created_at, NEW.criado_por, NEW.cnpj, NEW.id, NEW.acao, 'contato:' || NEW.id)
        ON CONFLICT (fonte_id) DO NOTHING;
      ELSE
        -- A nota é a da linha NESTE instante (o cron das 03:30 é o único escritor dela; o contato não a muda).
        INSERT INTO public.radar_eventos
          (evento, origem, ocorrido_em, user_id, cnpj, contato_id, acao, nota_capturada, score, score_versao, score_em, fonte_id)
        SELECT 'contato', 'humano', NEW.created_at, NEW.criado_por, NEW.cnpj, NEW.id, NEW.acao, true,
               e.score, e.score_versao, e.score_em, 'contato:' || NEW.id
          FROM (SELECT 1) AS um
          LEFT JOIN public.radar_empresas e ON e.cnpj = NEW.cnpj
        ON CONFLICT (fonte_id) DO NOTHING;
      END IF;
      RETURN NEW;
    END IF;
    -- DELETE: desfazer_contato_radar só apaga o contato do próprio criado_por; a origem segue a do contato.
    INSERT INTO public.radar_eventos (evento, origem, ocorrido_em, user_id, cnpj, contato_id, acao, fonte_id)
    VALUES ('contato_desfeito', CASE WHEN OLD.criado_por = c_sistema THEN 'automatica' ELSE 'humano' END,
            clock_timestamp(), OLD.criado_por, OLD.cnpj, OLD.id, OLD.acao, 'desfeito:' || OLD.id)
    ON CONFLICT (fonte_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    -- Fail-open: o contato vale mais que a telemetria. A perda aparece na reconciliação de radar_placar_uso().
    RAISE WARNING 'radar_eventos: contato % não registrado (%: %)',
      CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE OLD.id END, SQLSTATE, left(SQLERRM, 120);
  END;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  RETURN OLD;
END
$function$;

CREATE OR REPLACE FUNCTION private.radar_evento_cadastro()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  BEGIN
    -- Cliente NOVO ('incluir') ou já existente ('lookup'): só a confirmação do servidor diz; sem ela, NULL.
    INSERT INTO public.radar_eventos (evento, origem, ocorrido_em, user_id, cnpj, acao, fonte_id)
    SELECT 'cadastrou', CASE WHEN v_uid IS NULL THEN 'automatica' ELSE 'humano' END,
           NEW.omie_cadastrado_em, v_uid, NEW.cnpj,
           (SELECT c.origem FROM public.omie_cliente_confirmacoes c
             WHERE c.documento = NEW.cnpj AND c.codigo_cliente = NEW.omie_codigo_cliente
             ORDER BY c.confirmado_em DESC, c.id DESC LIMIT 1),
           'cadastro:' || NEW.cnpj
    ON CONFLICT (fonte_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'radar_eventos: cadastro % não registrado (%: %)', NEW.cnpj, SQLSTATE, left(SQLERRM, 120);
  END;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION private.radar_evento_abertura()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  BEGIN
    -- Captura mínima: titular, instante e id do outbox. Sem titular não há "humano" a contar.
    IF NEW.user_id IS NOT NULL THEN
      INSERT INTO public.radar_eventos (evento, origem, ocorrido_em, user_id, fonte_id)
      VALUES ('abriu', 'humano', NEW.ocorrido_em, NEW.user_id, 'outbox:' || NEW.event_id)
      ON CONFLICT (fonte_id) DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'radar_eventos: abertura % não registrada (%: %)', NEW.event_id, SQLSTATE, left(SQLERRM, 120);
  END;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION private.radar_evento_contato() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.radar_evento_cadastro() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.radar_evento_abertura() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. Coortes de controle (topo × amostra fora do topo)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.radar_coorte_sortear(p_tamanho integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_lote    text;
  v_sorteio text;
  v_agora   timestamptz := clock_timestamp();
  v_sem_ver integer;
  v_topo    integer;
  v_amostra integer;
BEGIN
  IF p_tamanho IS NULL OR p_tamanho < 1 OR p_tamanho > 500 THEN
    RAISE EXCEPTION 'tamanho da amostra fora de 1..500: %', p_tamanho USING ERRCODE = '22023';
  END IF;
  SELECT s.mes_referencia INTO v_lote
    FROM public.radar_ingest_state s
   WHERE s.status = 'complete'
   ORDER BY s.mes_referencia DESC
   LIMIT 1;
  IF v_lote IS NULL THEN
    RAISE EXCEPTION 'sem lote vigente: não há foto para sortear' USING ERRCODE = '55000';
  END IF;
  v_sorteio := 'coorte-' || v_lote;
  -- Serializa ANTES de olhar se existe: duas primeiras chamadas simultâneas não materializam conjuntos diferentes.
  PERFORM pg_advisory_xact_lock(hashtextextended('radar_coorte:' || v_sorteio, 0));

  IF EXISTS (SELECT 1 FROM public.radar_coorte_controle WHERE sorteio = v_sorteio) THEN
    -- Registrado é registrado: re-chamar não re-sorteia (a fila muda; a coorte não pode mudar junto).
    RETURN (SELECT jsonb_build_object('sorteio', v_sorteio, 'novo', false,
                                      'topo', count(*) FILTER (WHERE grupo = 'topo'),
                                      'amostra', count(*) FILTER (WHERE grupo = 'amostra'))
              FROM public.radar_coorte_controle WHERE sorteio = v_sorteio);
  END IF;

  -- Universo comum aos dois grupos: lead da foto vigente, a contatar, com telefone, em município onde já há
  -- cliente (a área que o time trabalha). O corte 70 é LIMIAR_SUGERIDO de src/lib/radar/sugeridos.ts.
  CREATE TEMP TABLE _radar_universo ON COMMIT DROP AS
    SELECT e.cnpj, e.score, e.score_versao
      FROM public.radar_empresas e
     WHERE e.ultimo_lote = v_lote
       AND NOT e.ja_cliente
       AND e.prospeccao_status = 'a_contatar'
       AND e.score >= 40
       AND (e.telefone1 IS NOT NULL OR e.telefone2 IS NOT NULL)
       AND e.municipio_codigo IN (SELECT c.municipio_codigo FROM public.radar_empresas c
                                   WHERE c.ja_cliente AND c.municipio_codigo IS NOT NULL);

  -- A nota sem versão não pode ser congelada (a 1ª rodada do cron depois da 20261029150000 é que a grava).
  SELECT count(*)::integer INTO v_sem_ver FROM _radar_universo WHERE score_versao IS NULL;
  IF v_sem_ver > 0 THEN
    RAISE EXCEPTION 'score sem versão em % leads elegíveis — espere a rodada do cron que grava score_versao', v_sem_ver
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.radar_coorte_controle (sorteio, grupo, cnpj, lote, posicao, score_no_sorteio, score_versao, sorteada_em)
  SELECT v_sorteio, 'topo', u.cnpj, v_lote, row_number() OVER (ORDER BY u.score DESC, u.cnpj), u.score, u.score_versao, v_agora
    FROM _radar_universo u
   WHERE u.score >= 70;
  GET DIAGNOSTICS v_topo = ROW_COUNT;

  INSERT INTO public.radar_coorte_controle (sorteio, grupo, cnpj, lote, posicao, score_no_sorteio, score_versao, sorteada_em)
  SELECT v_sorteio, 'amostra', s.cnpj, v_lote, row_number() OVER (ORDER BY s.chave, s.cnpj), s.score, s.score_versao, v_agora
    FROM (SELECT u.cnpj, u.score, u.score_versao, md5(v_sorteio || ':' || u.cnpj) AS chave
            FROM _radar_universo u
           WHERE u.score BETWEEN 40 AND 69
           ORDER BY md5(v_sorteio || ':' || u.cnpj), u.cnpj
           LIMIT p_tamanho) s;
  GET DIAGNOSTICS v_amostra = ROW_COUNT;

  IF v_topo = 0 OR v_amostra = 0 THEN
    -- Coorte vazia não compara nada: aborta tudo em vez de registrar meio sorteio.
    RAISE EXCEPTION 'coorte vazia (topo %, amostra %): nada registrado', v_topo, v_amostra USING ERRCODE = '55000';
  END IF;

  BEGIN
    INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
    VALUES ('radar.coorte_sortear', CASE WHEN auth.uid() IS NULL THEN 'automatica' ELSE 'manual' END,
            v_agora, clock_timestamp(), 'sucesso',
            jsonb_build_object('sorteio', v_sorteio, 'topo', v_topo, 'amostra', v_amostra, 'pedido', p_tamanho,
                               'regra', 'a_contatar · telefone · município com cliente · topo >= 70 (todos) · amostra 40-69 por md5(sorteio:cnpj)'));
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- observabilidade nunca derruba o sorteio; o registro de verdade é radar_coorte_controle
  END;

  RETURN jsonb_build_object('sorteio', v_sorteio, 'novo', true, 'topo', v_topo, 'amostra', v_amostra);
END
$function$;

REVOKE ALL ON FUNCTION public.radar_coorte_sortear(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_coorte_sortear(integer) TO service_role;

-- ------------------------------------------------------------
-- 4. Leituras (placar, coortes, conversão por faixa)
-- ------------------------------------------------------------
-- Vocabulário (radar_contatos.acao): TOQUE = contatado_sem_resposta | em_conversa (uma tentativa comercial).
-- 'virou_cliente' é DESFECHO (o cadastro no Omie também o grava), 'descartado' é decisão, 'a_contatar' é devolver
-- à fila. Contato VÁLIDO = a linha ainda existe em radar_contatos (desfeito ou com DELETE não capturado não conta).
CREATE OR REPLACE FUNCTION public.radar_placar_uso()
 RETURNS TABLE (
   janela text, desde timestamptz,
   autorizados_agora integer, autorizados_motivo text,
   abriram integer, aberturas integer,
   tocaram integer, toques integer, em_conversa integer, descartes integer, devolvidos integer, desfeitos integer,
   cadastraram integer, cadastros_novos integer, vinculos_existentes integer,
   eventos_automaticos integer,
   contatos_sem_evento integer, apagados_sem_desfeito integer, aberturas_outbox_sem_evento integer,
   aberturas_cobertas_desde timestamptz)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_aut      integer;
  v_motivo   text;
  v_sem_ct   integer;
  v_apagados integer;
  v_sem_ab   integer;
  v_ab_desde timestamptz;
BEGIN
  -- Autorizados AGORA = capability da frente 2, resolvida TARDE: ausente ⇒ NULL com motivo, nunca 0.
  -- Não reconstrói autorização histórica: é o mesmo número em todas as janelas.
  IF to_regprocedure('private.cap_radar_prospectar(uuid)') IS NULL THEN
    v_motivo := 'private.cap_radar_prospectar(uuid) ausente';
  ELSE
    EXECUTE 'SELECT count(DISTINCT ur.user_id)::integer FROM public.user_roles ur WHERE private.cap_radar_prospectar(ur.user_id)'
      INTO v_aut;
  END IF;

  -- Reconciliação do fail-open.
  SELECT count(*)::integer INTO v_sem_ct
    FROM public.radar_contatos c
   WHERE NOT EXISTS (SELECT 1 FROM public.radar_eventos e WHERE e.fonte_id = 'contato:' || c.id);
  SELECT count(*)::integer INTO v_apagados
    FROM public.radar_eventos e
   WHERE e.evento = 'contato'
     AND NOT EXISTS (SELECT 1 FROM public.radar_contatos c WHERE c.id = e.contato_id)
     AND NOT EXISTS (SELECT 1 FROM public.radar_eventos d WHERE d.fonte_id = 'desfeito:' || e.contato_id);
  SELECT count(*)::integer INTO v_sem_ab
    FROM public.analytics_outbox o
   WHERE o.evento = 'navegacao.rota_servida' AND o.props ->> 'rota' = '/radar' AND o.user_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.radar_eventos e WHERE e.fonte_id = 'outbox:' || o.event_id);
  -- Abertura só existe desde o que o outbox ainda retinha no backfill: antes disso, "0" é ausência de dado.
  SELECT min(e.ocorrido_em) INTO v_ab_desde FROM public.radar_eventos e WHERE e.evento = 'abriu';

  RETURN QUERY
  WITH j(janela, desde, ordem) AS (VALUES
         ('7d',    now() - interval '7 days',  1),
         ('30d',   now() - interval '30 days', 2),
         ('60d',   now() - interval '60 days', 3),
         ('total', '-infinity'::timestamptz,   4)),
       ev AS (
         SELECT e.*,
                (e.evento = 'contato' AND EXISTS (SELECT 1 FROM public.radar_contatos c WHERE c.id = e.contato_id)) AS valido
           FROM public.radar_eventos e)
  SELECT j.janela, j.desde, v_aut, v_motivo,
         (count(DISTINCT ev.user_id) FILTER (WHERE ev.evento = 'abriu' AND ev.origem = 'humano'))::integer,
         (count(*) FILTER (WHERE ev.evento = 'abriu' AND ev.origem = 'humano'))::integer,
         (count(DISTINCT ev.user_id) FILTER (WHERE ev.valido AND ev.origem = 'humano'
                                              AND ev.acao IN ('contatado_sem_resposta', 'em_conversa')))::integer,
         (count(*) FILTER (WHERE ev.valido AND ev.origem = 'humano' AND ev.acao IN ('contatado_sem_resposta', 'em_conversa')))::integer,
         (count(*) FILTER (WHERE ev.valido AND ev.origem = 'humano' AND ev.acao = 'em_conversa'))::integer,
         (count(*) FILTER (WHERE ev.valido AND ev.origem = 'humano' AND ev.acao = 'descartado'))::integer,
         (count(*) FILTER (WHERE ev.valido AND ev.origem = 'humano' AND ev.acao = 'a_contatar'))::integer,
         (count(*) FILTER (WHERE ev.evento = 'contato_desfeito' AND ev.origem = 'humano'))::integer,
         (count(DISTINCT ev.user_id) FILTER (WHERE ev.evento = 'cadastrou' AND ev.origem = 'humano'))::integer,
         (count(*) FILTER (WHERE ev.evento = 'cadastrou' AND ev.origem = 'humano' AND ev.acao = 'incluir'))::integer,
         (count(*) FILTER (WHERE ev.evento = 'cadastrou' AND ev.origem = 'humano' AND ev.acao = 'lookup'))::integer,
         (count(*) FILTER (WHERE ev.origem = 'automatica'))::integer,
         v_sem_ct, v_apagados, v_sem_ab, v_ab_desde
    FROM j
    LEFT JOIN ev ON ev.ocorrido_em >= j.desde
   GROUP BY j.janela, j.desde, j.ordem
   ORDER BY j.ordem;
END
$function$;

-- Resultado das coortes: começa pelo REGISTRO (denominador fixo, inclusive quem teve zero contato), e conta só o
-- que aconteceu DEPOIS do sorteio. Os dois grupos nascem no mesmo instante: o tempo de acompanhamento é igual.
CREATE OR REPLACE FUNCTION public.radar_coorte_resultado()
 RETURNS TABLE (sorteio text, grupo text, sorteados integer, tocados integer, em_conversa integer,
                virou_cliente integer, cadastros_novos integer, sorteada_em timestamptz, dias_de_acompanhamento integer)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH validos AS (
    SELECT e.cnpj, e.acao, e.ocorrido_em
      FROM public.radar_eventos e
     WHERE e.evento = 'contato' AND e.origem = 'humano'
       AND EXISTS (SELECT 1 FROM public.radar_contatos c WHERE c.id = e.contato_id)
  ),
  por_lead AS (
    SELECT k.sorteio, k.grupo, k.cnpj, k.sorteada_em,
           EXISTS (SELECT 1 FROM validos v WHERE v.cnpj = k.cnpj AND v.ocorrido_em >= k.sorteada_em
                     AND v.acao IN ('contatado_sem_resposta', 'em_conversa')) AS tocado,
           EXISTS (SELECT 1 FROM validos v WHERE v.cnpj = k.cnpj AND v.ocorrido_em >= k.sorteada_em
                     AND v.acao = 'em_conversa') AS conversou,
           (EXISTS (SELECT 1 FROM validos v WHERE v.cnpj = k.cnpj AND v.ocorrido_em >= k.sorteada_em
                      AND v.acao = 'virou_cliente')
            OR EXISTS (SELECT 1 FROM public.radar_eventos c WHERE c.evento = 'cadastrou' AND c.cnpj = k.cnpj
                         AND c.ocorrido_em >= k.sorteada_em)) AS virou,
           EXISTS (SELECT 1 FROM public.radar_eventos c WHERE c.evento = 'cadastrou' AND c.cnpj = k.cnpj
                     AND c.ocorrido_em >= k.sorteada_em AND c.acao = 'incluir') AS novo
      FROM public.radar_coorte_controle k
  )
  SELECT p.sorteio, p.grupo, count(*)::integer,
         (count(*) FILTER (WHERE p.tocado))::integer,
         (count(*) FILTER (WHERE p.conversou))::integer,
         (count(*) FILTER (WHERE p.virou))::integer,
         (count(*) FILTER (WHERE p.novo))::integer,
         min(p.sorteada_em),
         floor(extract(epoch FROM now() - min(p.sorteada_em)) / 86400)::integer
    FROM por_lead p
   GROUP BY p.sorteio, p.grupo
   ORDER BY p.sorteio, p.grupo DESC;
$function$;

-- Conversão pela NOTA NO REGISTRO DO 1º TOQUE humano válido de cada CNPJ (unidade = lead, não contato: vários
-- contatos do mesmo CNPJ não viram vários clientes). Desfecho = o lead chegou a em_conversa / virou cliente DEPOIS
-- desse toque. Toque com nota capturada só existe desde esta migration (os retroativos ficam de fora).
CREATE OR REPLACE FUNCTION public.radar_conversao_por_faixa()
 RETURNS TABLE (faixa text, leads_tocados integer, em_conversa integer, virou_cliente integer, cadastros_novos integer)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH validos AS (
    SELECT e.*
      FROM public.radar_eventos e
     WHERE e.evento = 'contato' AND e.origem = 'humano'
       AND EXISTS (SELECT 1 FROM public.radar_contatos c WHERE c.id = e.contato_id)
  ),
  primeiro AS (
    SELECT DISTINCT ON (v.cnpj) v.cnpj, v.score, v.ocorrido_em
      FROM validos v
     WHERE v.nota_capturada AND v.acao IN ('contatado_sem_resposta', 'em_conversa')
     ORDER BY v.cnpj, v.ocorrido_em, v.id
  ),
  lead AS (
    SELECT p.cnpj,
           CASE WHEN p.score IS NULL THEN 'sem nota'
                WHEN p.score >= 70 THEN 'topo (>= 70)'
                WHEN p.score >= 40 THEN '40-69'
                ELSE '< 40' END AS faixa,
           EXISTS (SELECT 1 FROM validos v WHERE v.cnpj = p.cnpj AND v.ocorrido_em >= p.ocorrido_em
                     AND v.acao = 'em_conversa') AS conversou,
           (EXISTS (SELECT 1 FROM validos v WHERE v.cnpj = p.cnpj AND v.ocorrido_em >= p.ocorrido_em
                      AND v.acao = 'virou_cliente')
            OR EXISTS (SELECT 1 FROM public.radar_eventos c WHERE c.evento = 'cadastrou' AND c.cnpj = p.cnpj
                         AND c.ocorrido_em >= p.ocorrido_em)) AS virou,
           EXISTS (SELECT 1 FROM public.radar_eventos c WHERE c.evento = 'cadastrou' AND c.cnpj = p.cnpj
                     AND c.ocorrido_em >= p.ocorrido_em AND c.acao = 'incluir') AS novo
      FROM primeiro p
  ),
  faixas(faixa, ordem) AS (VALUES ('topo (>= 70)', 1), ('40-69', 2), ('< 40', 3), ('sem nota', 4))
  SELECT f.faixa,
         count(l.cnpj)::integer,
         (count(*) FILTER (WHERE l.conversou))::integer,
         (count(*) FILTER (WHERE l.virou))::integer,
         (count(*) FILTER (WHERE l.novo))::integer
    FROM faixas f
    LEFT JOIN lead l ON l.faixa = f.faixa
   GROUP BY f.faixa, f.ordem
   ORDER BY f.ordem;
$function$;

REVOKE ALL ON FUNCTION public.radar_placar_uso() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.radar_coorte_resultado() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.radar_conversao_por_faixa() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_placar_uso(), public.radar_coorte_resultado(), public.radar_conversao_por_faixa()
  TO service_role;
DO $ro$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'claude_ro') THEN
    GRANT EXECUTE ON FUNCTION public.radar_placar_uso(), public.radar_coorte_resultado(), public.radar_conversao_por_faixa()
      TO claude_ro;
    GRANT SELECT ON TABLE public.radar_eventos, public.radar_coorte_controle TO claude_ro;
  END IF;
END
$ro$;

-- ------------------------------------------------------------
-- 5. Triggers + backfill, tabela por tabela (o outbox, quente, por último: cauda curta até o COMMIT)
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_radar_evento_contato_ins ON public.radar_contatos;
CREATE TRIGGER trg_radar_evento_contato_ins AFTER INSERT ON public.radar_contatos
  FOR EACH ROW EXECUTE FUNCTION private.radar_evento_contato();
DROP TRIGGER IF EXISTS trg_radar_evento_contato_del ON public.radar_contatos;
CREATE TRIGGER trg_radar_evento_contato_del AFTER DELETE ON public.radar_contatos
  FOR EACH ROW EXECUTE FUNCTION private.radar_evento_contato();
-- Retroativo: origem pela linha histórica (criado_por), nunca pelo auth.uid() da migration. Sem nota.
INSERT INTO public.radar_eventos (evento, origem, ocorrido_em, user_id, cnpj, contato_id, acao, retroativo, fonte_id)
SELECT 'contato',
       CASE WHEN c.criado_por = '00000000-0000-0000-0000-00000000ad0f'::uuid THEN 'automatica' ELSE 'humano' END,
       c.created_at, c.criado_por, c.cnpj, c.id, c.acao, true, 'contato:' || c.id
  FROM public.radar_contatos c
ON CONFLICT (fonte_id) DO NOTHING;

-- UPDATE OF: só dispara quando o SET cita a coluna (o recálculo do score e a ingestão não a citam).
DROP TRIGGER IF EXISTS trg_radar_evento_cadastro ON public.radar_empresas;
CREATE TRIGGER trg_radar_evento_cadastro AFTER UPDATE OF omie_cadastrado_em ON public.radar_empresas
  FOR EACH ROW WHEN (OLD.omie_cadastrado_em IS NULL AND NEW.omie_cadastrado_em IS NOT NULL)
  EXECUTE FUNCTION private.radar_evento_cadastro();
-- Retroativo: o autor é quem gravou o 'virou_cliente' do cadastro (mesmo instante); sem ele, automática.
INSERT INTO public.radar_eventos (evento, origem, ocorrido_em, user_id, cnpj, acao, retroativo, fonte_id)
SELECT 'cadastrou',
       CASE WHEN a.criado_por IS NULL OR a.criado_por = '00000000-0000-0000-0000-00000000ad0f'::uuid
            THEN 'automatica' ELSE 'humano' END,
       e.omie_cadastrado_em, a.criado_por, e.cnpj,
       (SELECT c.origem FROM public.omie_cliente_confirmacoes c
         WHERE c.documento = e.cnpj AND c.codigo_cliente = e.omie_codigo_cliente
         ORDER BY c.confirmado_em DESC, c.id DESC LIMIT 1),
       true, 'cadastro:' || e.cnpj
  FROM public.radar_empresas e
  LEFT JOIN LATERAL (SELECT rc.criado_por FROM public.radar_contatos rc
                      WHERE rc.cnpj = e.cnpj AND rc.acao = 'virou_cliente' AND rc.created_at = e.omie_cadastrado_em
                      ORDER BY rc.created_at DESC LIMIT 1) a ON true
 WHERE e.omie_cadastrado_em IS NOT NULL
ON CONFLICT (fonte_id) DO NOTHING;

DROP TRIGGER IF EXISTS trg_radar_evento_abertura ON public.analytics_outbox;
CREATE TRIGGER trg_radar_evento_abertura AFTER INSERT ON public.analytics_outbox
  FOR EACH ROW WHEN (NEW.evento = 'navegacao.rota_servida' AND NEW.props ->> 'rota' = '/radar')
  EXECUTE FUNCTION private.radar_evento_abertura();
INSERT INTO public.radar_eventos (evento, origem, ocorrido_em, user_id, retroativo, fonte_id)
SELECT 'abriu', 'humano', o.ocorrido_em, o.user_id, true, 'outbox:' || o.event_id
  FROM public.analytics_outbox o
 WHERE o.evento = 'navegacao.rota_servida' AND o.props ->> 'rota' = '/radar' AND o.user_id IS NOT NULL
ON CONFLICT (fonte_id) DO NOTHING;

-- ------------------------------------------------------------
-- PÓS
-- ------------------------------------------------------------
DO $post$
DECLARE
  v_fn text;
BEGIN
  IF (SELECT count(*) FROM pg_trigger t
       WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
         AND (t.tgname, t.tgrelid) IN (('trg_radar_evento_contato_ins', 'public.radar_contatos'::regclass),
                                       ('trg_radar_evento_contato_del', 'public.radar_contatos'::regclass),
                                       ('trg_radar_evento_cadastro',    'public.radar_empresas'::regclass),
                                       ('trg_radar_evento_abertura',    'public.analytics_outbox'::regclass))) <> 4 THEN
    RAISE EXCEPTION 'A1 FALHOU: os 4 triggers do ledger do radar não estão todos ativos';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.radar_eventos'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.radar_coorte_controle'::regclass) THEN
    RAISE EXCEPTION 'A2 FALHOU: RLS desligada numa tabela nova do radar';
  END IF;
  IF has_table_privilege('anon', 'public.radar_eventos', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('authenticated', 'public.radar_eventos', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('service_role', 'public.radar_eventos', 'INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('anon', 'public.radar_coorte_controle', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('authenticated', 'public.radar_coorte_controle', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('service_role', 'public.radar_coorte_controle', 'INSERT,UPDATE,DELETE,TRUNCATE') THEN
    RAISE EXCEPTION 'A3 FALHOU: um papel de API alcança escrita (ou anon/authenticated a leitura) numa tabela nova do radar';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.radar_coorte_sortear(integer)', 'public.radar_placar_uso()',
                              'public.radar_coorte_resultado()', 'public.radar_conversao_por_faixa()',
                              'private.radar_evento_contato()', 'private.radar_evento_cadastro()',
                              'private.radar_evento_abertura()'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR has_function_privilege('public', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'A4 FALHOU: anon/authenticated/PUBLIC executam %', v_fn;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.radar_contatos c
              WHERE NOT EXISTS (SELECT 1 FROM public.radar_eventos e WHERE e.fonte_id = 'contato:' || c.id)) THEN
    RAISE EXCEPTION 'A5 FALHOU: há contato sem evento depois do backfill';
  END IF;
  RAISE NOTICE 'radar: ledger de eventos, coortes e placar provados';
END
$post$;

COMMIT;
