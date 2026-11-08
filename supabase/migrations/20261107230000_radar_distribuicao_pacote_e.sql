-- =============================================================================
-- Radar, pacote E: corrigir a distribuição do e-mail semanal e do card "Prospectar hoje"
-- =============================================================================
-- Revisão Codex + Fable (2026-11-07) da 20261106181000_radar_leads_ao_vendedor achou que a distribuição recomendava
-- leads que não servem. Medido em PROD (psql-ro, 2026-11-07) antes de mudar: 2 vendedoras ligáveis, ambas donas de
-- município (39 e 44); no top-3 de cada uma, 9 e 4 leads sem nenhum contato (1%); 0 atendimentos no Radar; 1 envio
-- (teste, notificado). Hoje o estrago é pequeno, mas os itens 3, 4 e 6 mordem no 1º vendedor novo ou na 1ª atribuição.
--
-- O que muda (as duas pontas, e-mail e card, continuam chamando a MESMA função de escolha):
--   E1 · Só lead da FOTO VIGENTE da Receita (ultimo_lote = maior mes_referencia `complete` de radar_ingest_state; sem
--        lote completo não recorta, como a fila em src/lib/radar/lote-vigente.ts) e com ao menos um contato
--        (telefone1, telefone2 ou email). O e-mail promete "a ficha com o contato".
--   E2 · "Não repetir por 90 dias" passa a contar e-mail ENTREGUE (fornecedor_alerta.status = 'notificado'), não o
--        registro do envio: e-mail que o dispatch encerrou em falha_notificacao não queima os 5 leads. Escolhi
--        ENTREGUE e não ABERTO porque o único "aberto" que existe é o clique por lead (radar_lead_aberturas): contar
--        aberto faria o lead ignorado voltar toda semana, o oposto de rodar a lista. O card segue a mesma regra (antes
--        passava NULL e mostrava o mesmo top-3 para sempre): some o lead entregue numa semana ANTERIOR; os 5 desta
--        semana continuam no card. Envio que falhou também não consome a semana: rodar de novo gera a tentativa 2
--        (coluna `tentativa`, UNIQUE (vendedor, semana, eh_teste, tentativa) no lugar da antiga).
--   E3 · Lead que o PRÓPRIO vendedor assumiu (atendimento ativo, atribuido_por NULL) sai: já está em "Meus
--        atendimentos". Combinado com a sessão F (dona do card).
--   E4 · Lead que o gestor ATRIBUIU (radar_atribuir_atendimento, atribuido_por NOT NULL, posse ativa) entra primeiro,
--        mesmo fora do território, com `atribuido = true` (e-mail e card).
--   E5 · radar_avisar_vendedores isola cada vendedor (BEGIN/EXCEPTION por iteração): o erro de um vai para `erros` no
--        ledger e os outros seguem; o ledger sai com status 'erro' quando houve erro. Duas execuções simultâneas
--        (cron + manual) se serializam por advisory lock: a 2ª espera a 1ª e enxerga os envios dela (parecer Codex).
--   E6 · Território: quem não é dono de nenhum município (2º em todas as suas cidades) recebe os municípios onde tem
--        clientes, no máximo 3, marcados `compartilhado`. O DONO tem prioridade: no município compartilhado, o lead já
--        mandado por e-mail a OUTRO vendedor (na fila ou entregue, 90 dias) fica fora para o fallback; o dono nunca
--        perde lead para o fallback (nem depois de uma falha dele). Os donos são processados antes no laço.
--        Território vazio ganha motivo: private.radar_territorio_motivo → 'nao_e_vendedor' | 'sem_carteira' |
--        'carteira_sem_municipio' (no ledger, no card e no painel do master).
--   E7 · A URL do app no link do e-mail sai do código: company_config.app_url_publica (semeada com o valor de hoje,
--        https://steu.lovable.app). Valor fora do formato não manda e-mail com link quebrado: ledger 'erro'.
-- A edge dispatch-notifications NÃO muda: ela já grava 'notificado'/'falha_notificacao', que é o que E2 passa a ler.
--
-- Molde TRAVA → PRE → CREATE → PÓS (references/sql-house-style.md). Envelope BEGIN/COMMIT (SQL Editor/MCP).
-- Prova PG17: db/test-radar-distribuicao-e.sh (--falsificar).
-- =============================================================================

BEGIN;

-- ── TRAVA: pré-requisitos e trava dos objetos que a PRE guarda ──────────────────────────────────────────
DO $trava$
BEGIN
  IF to_regclass('public.radar_email_vendedor_envios') IS NULL OR to_regclass('public.radar_email_vendedor_leads') IS NULL
     OR to_regclass('public.radar_ingest_state') IS NULL OR to_regclass('public.company_config') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: radar_email_vendedor_envios/leads, radar_ingest_state ou company_config ausente — aplique 20261106181000 antes';
  END IF;
  IF to_regprocedure('public.radar_email_semanal_painel()') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: radar_email_semanal_painel ausente — aplique 20261107140001_radar_email_semanal_toggle antes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.radar_atendimentos'::regclass
                   AND attname = 'atribuido_por' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'TRAVA FALHOU: radar_atendimentos.atribuido_por ausente — aplique 20261106221000_radar_atribuir_atendimento antes';
  END IF;
  -- ALTER sem efeito (a volatilidade VIVA): prende cada função até o COMMIT, antes de a PRE ler o corpo.
  IF to_regprocedure('private.radar_territorio_do_vendedor(uuid,integer)') IS NOT NULL THEN
    ALTER FUNCTION private.radar_territorio_do_vendedor(uuid, integer) STABLE;
  END IF;
  IF to_regprocedure('private.radar_leads_do_vendedor(uuid,integer,timestamptz,timestamptz)') IS NOT NULL THEN
    ALTER FUNCTION private.radar_leads_do_vendedor(uuid, integer, timestamptz, timestamptz) STABLE;
  END IF;
  IF to_regprocedure('private.radar_leads_do_vendedor(uuid,integer,timestamptz)') IS NOT NULL THEN
    ALTER FUNCTION private.radar_leads_do_vendedor(uuid, integer, timestamptz) STABLE;
  END IF;
  IF to_regprocedure('private.radar_territorio_motivo(uuid)') IS NOT NULL THEN
    ALTER FUNCTION private.radar_territorio_motivo(uuid) STABLE;
  END IF;
  ALTER FUNCTION public.radar_avisar_vendedores(timestamptz) VOLATILE;
  ALTER FUNCTION public.radar_prospectar_hoje(uuid, integer) STABLE;
  ALTER FUNCTION public.radar_email_semanal_painel() STABLE;
END
$trava$;

-- ── PRE: corpo vivo ∈ {predecessor revisado (PROD 2026-11-07), este arquivo} ────────────────────────────
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT v.alvo, v.predecessor, v.este, v.pode_faltar,
           (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v.alvo)) AS vivo
      FROM (VALUES
        ('private.radar_territorio_do_vendedor(uuid,integer)',
         '0c898437355fd9e9c32aeb4e0326f334', '979c8cca33ef18bd9271cce274821259', false),
        ('private.radar_leads_do_vendedor(uuid,integer,timestamptz,timestamptz)',
         '4d42f984581ffb7071e1a897ea6d40be', NULL, true),   -- some nesta migration (troca de assinatura)
        ('private.radar_leads_do_vendedor(uuid,integer,timestamptz)',
         NULL, '09a18fe233086578bea5ce92a82999c3', true),                      -- nasce nesta migration
        ('private.radar_territorio_motivo(uuid)',
         NULL, 'bd930b886fff2a9c6f2a4d4da8f0e8ce', true),                                        -- nasce nesta migration
        ('public.radar_avisar_vendedores(timestamptz)',
         'e382065349b1a3ada1837429b1bbe79a', 'b94e689aa55d06036848841204bebea3', false),
        ('public.radar_prospectar_hoje(uuid,integer)',
         '55834328a62408d4565c1847b3fb9bde', 'ab8799c17ac7a8b1078e1a999d3c6ab6', false),
        ('public.radar_email_semanal_painel()',
         '3e92dbe5290136607955afdc6be57e76', 'a42da362804629f8bbc0d5b416ae9c68', false)
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
  -- A assinatura velha e a nova não convivem: re-colar depois de aplicado tem a nova e não a velha.
  IF to_regprocedure('private.radar_leads_do_vendedor(uuid,integer,timestamptz,timestamptz)') IS NULL
     AND to_regprocedure('private.radar_leads_do_vendedor(uuid,integer,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: nenhuma versão de private.radar_leads_do_vendedor existe';
  END IF;
END
$pre$;

-- ── Esquema: tentativa por semana, lead atribuído, URL do app ──────────────────────────────────────────
ALTER TABLE public.radar_email_vendedor_envios
  ADD COLUMN IF NOT EXISTS tentativa smallint NOT NULL DEFAULT 1;
DO $esq$
DECLARE
  v_con name;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.radar_email_vendedor_envios'::regclass
                   AND conname = 'radar_email_vendedor_envios_tentativa_chk') THEN
    ALTER TABLE public.radar_email_vendedor_envios
      ADD CONSTRAINT radar_email_vendedor_envios_tentativa_chk CHECK (tentativa BETWEEN 1 AND 20);
  END IF;
  -- A UNIQUE antiga (1 envio por vendedor e semana) fazia o e-mail que falhou consumir a semana. Procurada pelas
  -- COLUNAS, não pelo nome (parecer Codex): renomeada, ela escaparia de um DROP por nome e seguiria barrando a tentativa 2.
  FOR v_con IN
    SELECT c.conname FROM pg_constraint c
     WHERE c.conrelid = 'public.radar_email_vendedor_envios'::regclass AND c.contype = 'u'
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text) FROM pg_attribute a
             WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)) = ARRAY['eh_teste', 'semana', 'vendedor_user_id']
  LOOP
    EXECUTE format('ALTER TABLE public.radar_email_vendedor_envios DROP CONSTRAINT %I', v_con);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conrelid = 'public.radar_email_vendedor_envios'::regclass AND c.contype = 'u'
                    AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text) FROM pg_attribute a
                          WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey))
                        = ARRAY['eh_teste', 'semana', 'tentativa', 'vendedor_user_id']) THEN
    ALTER TABLE public.radar_email_vendedor_envios
      ADD CONSTRAINT radar_email_vendedor_envios_semana_tentativa_key UNIQUE (vendedor_user_id, semana, eh_teste, tentativa);
  END IF;
END
$esq$;
COMMENT ON COLUMN public.radar_email_vendedor_envios.tentativa IS
  'Radar pacote E: 1, 2, … na mesma (vendedor, semana, eh_teste). Só existe tentativa nova quando todas as anteriores da semana terminaram em falha_notificacao.';

ALTER TABLE public.radar_email_vendedor_leads
  ADD COLUMN IF NOT EXISTS atribuido boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.radar_email_vendedor_leads.atribuido IS
  'Radar pacote E: o lead entrou por ter sido atribuído pelo gestor (radar_atribuir_atendimento), não pelo território.';

INSERT INTO public.company_config (key, value)
VALUES ('app_url_publica', 'https://steu.lovable.app')
ON CONFLICT (key) DO NOTHING;

-- ── 1. Território (assinatura igual, ganha `compartilhado`: DROP + CREATE + REVOKE) ─────────────────────
DROP FUNCTION IF EXISTS private.radar_leads_do_vendedor(uuid, integer, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS private.radar_leads_do_vendedor(uuid, integer, timestamptz);
DROP FUNCTION IF EXISTS private.radar_territorio_do_vendedor(uuid, integer);

CREATE FUNCTION private.radar_territorio_do_vendedor(p_vendedor uuid, p_top integer DEFAULT 3)
RETURNS TABLE (municipio_codigo text, municipio_nome text, uf text, clientes integer, compartilhado boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  -- Forma medida em PROD (2026-11-06): comparar no enum e carregar o dono junto do endereço, com os dois lados
  -- normalizados e MATERIALIZED (~100 ms; com cast ::text o planejador estimava 1 linha e passava de 30 s).
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
  por_mun AS MATERIALIZED (
    SELECT e.dono, mu.codigo, mu.nome, mu.uf, count(DISTINCT e.cliente)::integer AS n
      FROM ende e
      JOIN mun mu ON mu.nc = e.nc AND mu.uf = e.uf
     GROUP BY e.dono, mu.codigo, mu.nome, mu.uf
  ),
  -- Cada município tem UM dono (quem tem mais clientes; empate: menor uuid): dois donos não recebem os mesmos leads.
  dono_do_mun AS (
    SELECT DISTINCT ON (pm.codigo) pm.codigo, pm.dono
      FROM por_mun pm
     ORDER BY pm.codigo, pm.n DESC, pm.dono
  ),
  proprio AS (
    SELECT pm.codigo, pm.nome, pm.uf, pm.n, false AS compartilhado
      FROM por_mun pm
      JOIN dono_do_mun d ON d.codigo = pm.codigo AND d.dono = pm.dono
     WHERE pm.dono = p_vendedor
  ),
  -- Pacote E (E6): quem é 2º em todas as suas cidades não fica sem território. Recebe os municípios onde tem
  -- clientes, marcados `compartilhado`; a colisão com o dono é resolvida na escolha dos leads (lead já mandado a
  -- outro vendedor fica fora). Só entra quando não há NENHUM município próprio: o dono não perde nada.
  escolhidos AS (
    SELECT * FROM proprio
    UNION ALL
    SELECT pm.codigo, pm.nome, pm.uf, pm.n, true
      FROM por_mun pm
     WHERE pm.dono = p_vendedor
       AND NOT EXISTS (SELECT 1 FROM proprio)
  )
  SELECT e.codigo, e.nome, e.uf, e.n, e.compartilhado
    FROM escolhidos e
   ORDER BY e.n DESC, e.codigo
   LIMIT GREATEST(1, LEAST(COALESCE(p_top, 3), 10));
$fn$;
REVOKE ALL ON FUNCTION private.radar_territorio_do_vendedor(uuid, integer) FROM PUBLIC, anon, authenticated;

-- ── 2. Motivo do território vazio (E6) ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.radar_territorio_motivo(p_vendedor uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  -- NULL = há território. Senão, o PRIMEIRO degrau que falta, na ordem em que radar_territorio_do_vendedor os exige.
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM private.radar_territorio_do_vendedor(p_vendedor, 1)) THEN NULL
    WHEN NOT EXISTS (SELECT 1 FROM public.commercial_roles cr
                      WHERE cr.user_id = p_vendedor AND cr.commercial_role IN ('farmer', 'hunter', 'closer')
                        AND EXISTS (SELECT 1 FROM public.user_roles ur
                                     WHERE ur.user_id = cr.user_id AND ur.role = 'employee')) THEN 'nao_e_vendedor'
    WHEN NOT EXISTS (SELECT 1 FROM public.carteira_assignments a
                      WHERE a.owner_user_id = p_vendedor AND a.eligible IS TRUE) THEN 'sem_carteira'
    ELSE 'carteira_sem_municipio'
  END;
$fn$;
REVOKE ALL ON FUNCTION private.radar_territorio_motivo(uuid) FROM PUBLIC, anon, authenticated;

-- ── 3. Leads do vendedor (nova assinatura: a janela de 90 dias vive AQUI, uma vez, para os dois canais) ──
CREATE FUNCTION private.radar_leads_do_vendedor(
  p_vendedor uuid,
  p_n        integer,
  p_agora    timestamptz DEFAULT now()
)
RETURNS TABLE (posicao integer, cnpj text, razao_social text, nome_fantasia text, municipio_codigo text,
               municipio_nome text, uf text, score smallint, score_motivos text[], elegiveis integer, atribuido boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  WITH par AS (
    SELECT date_trunc('week', p_agora AT TIME ZONE 'America/Sao_Paulo')::date AS semana,
           p_agora - interval '90 days' AS desde,
           -- E1: a foto vigente é o maior lote COMPLETO (running/error no meio não é foto). Sem lote completo não
           -- recorta, como a fila (src/lib/radar/lote-vigente.ts: null é "não sei", nunca "zero").
           (SELECT s.mes_referencia FROM public.radar_ingest_state s
             WHERE s.status = 'complete' ORDER BY s.mes_referencia DESC LIMIT 1) AS lote
  ),
  terr AS (
    SELECT t.municipio_codigo, t.clientes, t.compartilhado FROM private.radar_territorio_do_vendedor(p_vendedor, 3) t
  ),
  -- E4: lead que o gestor passou a este vendedor e cuja posse segue ativa no relógio de p_agora.
  atrib AS (
    SELECT a.cnpj FROM public.radar_atendimentos a
     WHERE a.dono_user_id = p_vendedor
       AND a.atribuido_por IS NOT NULL
       AND a.encerrado_em IS NULL
       AND private.radar_atendimento_expira_em(a.cnpj, a.dono_user_id, a.assumido_em, a.renovado_em) > p_agora
  ),
  -- Os filtros estáticos ficam DENTRO de cada ramo (o do território casa com o índice parcial idx_radar_muni).
  -- São os mesmos nos dois ramos: ja_cliente, status, score, RFB, foto vigente (E1) e contato (E1).
  alvo AS (
    SELECT re.cnpj, re.razao_social, re.nome_fantasia, re.municipio_codigo, re.municipio_nome, re.uf,
           re.score, re.score_motivos, t.clientes, t.compartilhado, false AS atribuido
      FROM terr t
      JOIN public.radar_empresas re ON re.municipio_codigo = t.municipio_codigo
      CROSS JOIN par
     WHERE re.ja_cliente = false
       AND re.prospeccao_status = 'a_contatar'
       AND re.score IS NOT NULL
       AND (re.rfb_situacao IS NULL OR re.rfb_situacao NOT IN ('03', '04', '08'))
       AND (par.lote IS NULL OR re.ultimo_lote = par.lote)
       AND (NULLIF(btrim(re.telefone1), '') IS NOT NULL OR NULLIF(btrim(re.telefone2), '') IS NOT NULL
            OR NULLIF(btrim(re.email), '') IS NOT NULL)
    UNION ALL
    SELECT re.cnpj, re.razao_social, re.nome_fantasia, re.municipio_codigo, re.municipio_nome, re.uf,
           re.score, re.score_motivos, 0, false, true
      FROM atrib ab
      JOIN public.radar_empresas re ON re.cnpj = ab.cnpj
      CROSS JOIN par
     WHERE re.ja_cliente = false
       AND re.prospeccao_status = 'a_contatar'
       AND re.score IS NOT NULL
       AND (re.rfb_situacao IS NULL OR re.rfb_situacao NOT IN ('03', '04', '08'))
       AND (par.lote IS NULL OR re.ultimo_lote = par.lote)
       AND (NULLIF(btrim(re.telefone1), '') IS NOT NULL OR NULLIF(btrim(re.telefone2), '') IS NOT NULL
            OR NULLIF(btrim(re.email), '') IS NOT NULL)
  ),
  -- Atribuído no território aparece uma vez só, como atribuído.
  um_por_cnpj AS (
    SELECT DISTINCT ON (a.cnpj) a.*, left(a.cnpj, 8) AS raiz
      FROM alvo a
     ORDER BY a.cnpj, a.atribuido DESC, a.compartilhado, a.clientes DESC
  ),
  universo AS (
    SELECT u.*
      FROM um_por_cnpj u
      CROSS JOIN par
     WHERE NOT EXISTS (
             -- posse ativa: de OUTRO vendedor com acesso (como antes) ou do PRÓPRIO quando ele mesmo assumiu (E3);
             -- a do próprio que veio do gestor é justamente o E4 e fica.
             SELECT 1 FROM public.radar_atendimentos a
              WHERE a.cnpj = u.cnpj
                AND a.encerrado_em IS NULL
                AND ((a.dono_user_id <> p_vendedor AND private.cap_radar_prospectar(a.dono_user_id))
                     OR (a.dono_user_id = p_vendedor AND a.atribuido_por IS NULL))
                AND private.radar_atendimento_expira_em(a.cnpj, a.dono_user_id, a.assumido_em, a.renovado_em) > p_agora)
       AND NOT EXISTS (
             -- E2: só e-mail ENTREGUE queima, e só os de semana ANTERIOR (os desta semana seguem no card).
             -- E6: no município COMPARTILHADO, o de OUTRO vendedor (na fila ou entregue) também tira o lead: o
             -- fallback não repete o dono. No território próprio, não: o dono nunca perde lead para o fallback.
             -- O atribuído pelo gestor vem com compartilhado = false. Envio de teste nunca conta.
             SELECT 1 FROM public.radar_email_vendedor_leads l
               JOIN public.radar_email_vendedor_envios e ON e.id = l.envio_id
               JOIN public.fornecedor_alerta fa ON fa.id = e.alerta_id
              WHERE left(l.cnpj, 8) = u.raiz
                AND e.eh_teste = false
                AND e.criado_em >= par.desde
                AND ((e.vendedor_user_id = p_vendedor AND fa.status = 'notificado' AND e.semana < par.semana)
                     OR (e.vendedor_user_id <> p_vendedor AND u.compartilhado
                         AND fa.status IN ('notificado', 'pendente_notificacao'))))
  ),
  -- Uma empresa por raiz de CNPJ (a filial de maior score): em prod o top-5 da Regina trazia a mesma metalúrgica 4 vezes.
  por_raiz AS (
    SELECT DISTINCT ON (u.raiz) u.*
      FROM universo u
     ORDER BY u.raiz, u.atribuido DESC, u.score DESC, u.clientes DESC, u.cnpj
  )
  SELECT (row_number() OVER (ORDER BY u.atribuido DESC, u.score DESC, u.clientes DESC, u.cnpj))::integer,
         u.cnpj, u.razao_social, u.nome_fantasia, u.municipio_codigo, u.municipio_nome, u.uf,
         u.score, u.score_motivos, (count(*) OVER ())::integer, u.atribuido
    FROM por_raiz u
   ORDER BY u.atribuido DESC, u.score DESC, u.clientes DESC, u.cnpj
   LIMIT GREATEST(1, LEAST(COALESCE(p_n, 5), 5));
$fn$;
REVOKE ALL ON FUNCTION private.radar_leads_do_vendedor(uuid, integer, timestamptz) FROM PUBLIC, anon, authenticated;

-- ── 4. E-mail semanal (entrypoint do cron) ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.radar_avisar_vendedores(p_agora timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  c_n           constant integer := 5;
  c_app_padrao  constant text    := 'https://steu.lovable.app';
  c_url_ok      constant text    := '^https://[A-Za-z0-9.-]+(:[0-9]+)?$';
  c_email_ok    constant text    := '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';
  v_ini         timestamptz := clock_timestamp();
  v_semana      date := date_trunc('week', p_agora AT TIME ZONE 'America/Sao_Paulo')::date;
  v_app         text;
  r             record;
  l             record;
  v_teste       boolean;
  v_tentativa   integer;
  v_email       text;
  v_nome        text;
  v_terr        jsonb;
  v_terr_txt    text;
  v_terr_nomes  text;
  v_leads       jsonb;
  v_qtd         integer;
  v_elegiveis   integer;
  v_atrib       integer;
  v_lista       text;
  v_envio       uuid;
  v_alerta      bigint;
  v_titulo      text;
  v_corpo       text;
  v_estado      text;
  v_msg         text;
  v_avisados    jsonb := '[]'::jsonb;
  v_pulados     jsonb := '[]'::jsonb;
  v_erros       jsonb := '[]'::jsonb;
BEGIN
  -- Uma distribuição por vez (parecer Codex): o SKIP LOCKED sozinho deixava duas execuções simultâneas pegarem
  -- vendedores diferentes sem enxergar os envios uma da outra (dono numa, fallback na outra → mesmo lead aos dois).
  -- A 2ª espera a 1ª terminar e então vê os envios dela (ja_enviado_na_semana).
  PERFORM pg_advisory_xact_lock(hashtext('radar.avisar_vendedores'));

  -- E7: a URL do link vem de company_config.app_url_publica (ausente = a de sempre). Valor fora do formato não
  -- manda link quebrado a ninguém: ledger 'erro' e nenhum e-mail.
  SELECT NULLIF(btrim(cc.value), '') INTO v_app FROM public.company_config cc WHERE cc.key = 'app_url_publica';
  v_app := rtrim(COALESCE(v_app, c_app_padrao), '/');
  IF v_app !~ c_url_ok THEN
    IF EXISTS (SELECT 1 FROM public.radar_email_vendedor_config c WHERE c.ativo) THEN
      INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
      VALUES ('radar.avisar_vendedores', 'automatica', v_ini, clock_timestamp(), 'erro',
              jsonb_build_object('semana', v_semana, 'erro', 'company_config.app_url_publica fora do formato https://host',
                                 'app_url_publica', left(v_app, 200)));
    END IF;
    RETURN jsonb_build_object('semana', v_semana, 'erro', 'app_url_publica_invalida', 'avisados', '[]'::jsonb,
                              'pulados', '[]'::jsonb, 'erros', '[]'::jsonb);
  END IF;

  FOR r IN
    SELECT c.vendedor_user_id AS vendedor, c.email_teste
      FROM public.radar_email_vendedor_config c
     WHERE c.ativo
     -- E6: quem é dono de município vai antes, para o território compartilhado não levar os leads do dono.
     ORDER BY NOT EXISTS (SELECT 1 FROM private.radar_territorio_do_vendedor(c.vendedor_user_id, 3) t
                           WHERE NOT t.compartilhado),
              c.vendedor_user_id
       FOR UPDATE OF c SKIP LOCKED
  LOOP
    -- E5: cada vendedor numa subtransação. O erro de um desfaz só o envio dele, vai para `erros` e os outros seguem.
    BEGIN
      v_teste := r.email_teste IS NOT NULL;

      -- E2: e-mail que falhou (falha_notificacao) não consome a semana; na fila ou entregue, sim. Alerta sumido
      -- também bloqueia (fail-closed: na dúvida, não manda duas vezes).
      IF EXISTS (SELECT 1 FROM public.radar_email_vendedor_envios e
                   LEFT JOIN public.fornecedor_alerta fa ON fa.id = e.alerta_id
                  WHERE e.vendedor_user_id = r.vendedor AND e.semana = v_semana AND e.eh_teste = v_teste
                    AND fa.status IS DISTINCT FROM 'falha_notificacao') THEN
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
                                                   'uf', t.uf, 'clientes', t.clientes, 'compartilhado', t.compartilhado)
                                ORDER BY t.clientes DESC, t.municipio_codigo), '[]'::jsonb),
             string_agg(t.municipio_nome || ' (' || t.clientes || ' clientes seus)', ' · ' ORDER BY t.clientes DESC, t.municipio_codigo),
             string_agg(t.municipio_nome, ', ' ORDER BY t.clientes DESC, t.municipio_codigo)
        INTO v_terr, v_terr_txt, v_terr_nomes
        FROM private.radar_territorio_do_vendedor(r.vendedor, 3) t;

      SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.posicao), '[]'::jsonb), count(*), max(x.elegiveis),
             count(*) FILTER (WHERE x.atribuido)
        INTO v_leads, v_qtd, v_elegiveis, v_atrib
        FROM private.radar_leads_do_vendedor(r.vendedor, c_n, p_agora) x;

      -- Sem território o e-mail ainda sai se o gestor passou leads (E4); sem os dois, o motivo diz por quê (E6).
      IF v_qtd = 0 AND jsonb_array_length(v_terr) = 0 THEN
        v_pulados := v_pulados || jsonb_build_object('vendedor', r.vendedor, 'motivo', 'sem_territorio',
                                                     'causa', private.radar_territorio_motivo(r.vendedor));
        CONTINUE;
      END IF;
      IF v_qtd = 0 THEN
        v_pulados := v_pulados || jsonb_build_object('vendedor', r.vendedor, 'motivo', 'sem_leads', 'territorio', v_terr);
        CONTINUE;
      END IF;

      SELECT COALESCE(max(e.tentativa), 0) + 1 INTO v_tentativa
        FROM public.radar_email_vendedor_envios e
       WHERE e.vendedor_user_id = r.vendedor AND e.semana = v_semana AND e.eh_teste = v_teste;

      v_envio := gen_random_uuid();
      v_lista := '';
      FOR l IN
        SELECT * FROM jsonb_to_recordset(v_leads) AS x(posicao integer, cnpj text, razao_social text, nome_fantasia text,
                                                      municipio_codigo text, municipio_nome text, uf text, score smallint,
                                                      score_motivos text[], elegiveis integer, atribuido boolean)
         ORDER BY x.posicao
      LOOP
        v_lista := v_lista
          || l.posicao || '. ' || COALESCE(NULLIF(btrim(l.nome_fantasia), ''), l.razao_social, l.cnpj)
          || CASE WHEN NULLIF(btrim(l.nome_fantasia), '') IS NOT NULL AND l.razao_social IS NOT NULL
                  THEN ' (' || l.razao_social || ')' ELSE '' END || E'\n'
          || '   ' || COALESCE(l.municipio_nome, '?') || '/' || COALESCE(l.uf, '?') || ' · score ' || l.score
          || CASE WHEN l.atribuido THEN ' · passada a você pelo gestor' ELSE '' END
          || COALESCE(' · ' || NULLIF(array_to_string(l.score_motivos[1:2], '; '), ''), '') || E'\n'
          || '   Abrir no Radar: ' || v_app || '/radar/abrir/' || v_envio || '/' || l.cnpj || E'\n\n';
      END LOOP;

      v_titulo := 'Radar: ' || v_qtd || CASE WHEN v_qtd = 1 THEN ' empresa' ELSE ' empresas' END
               || ' para prospectar esta semana' || COALESCE(' (' || v_terr_nomes || ')', '');
      v_corpo := 'Olá' || COALESCE(', ' || NULLIF(split_part(btrim(v_nome), ' ', 1), ''), '') || '!' || E'\n\n'
        || 'Separei ' || v_qtd || CASE WHEN v_qtd = 1 THEN ' empresa' ELSE ' empresas' END
        || ' para você prospectar esta semana'
        || COALESCE(', perto de onde você já tem clientes: ' || v_terr_txt, '') || '.'
        || CASE WHEN v_atrib = 1 THEN ' 1 delas foi passada a você pelo gestor.'
                WHEN v_atrib > 1 THEN ' ' || v_atrib || ' delas foram passadas a você pelo gestor.'
                ELSE '' END
        || E'\n\n'
        || v_lista
        || 'O link abre a ficha no Radar, com o telefone ou e-mail da empresa, sócios e o botão para registrar o contato.' || E'\n\n'
        || 'Como escolhi: '
        || CASE WHEN v_atrib > 0 THEN 'primeiro as que o gestor passou a você; depois, ' ELSE '' END
        || 'maior score do Radar entre ' || v_elegiveis || ' empresas a contatar. Ficam de fora '
        || 'quem já é cliente, descartados, empresas baixadas ou inaptas na Receita, empresas que não vieram na foto '
        || 'mais recente da Receita, empresas sem telefone nem e-mail, empresas sem score, leads que você já assumiu e '
        || 'leads em atendimento por outro vendedor. Nenhuma empresa desta lista volta a aparecer para você nos próximos 90 dias.'
        || CASE WHEN v_teste THEN E'\n\n[TESTE] Este e-mail era para ' || COALESCE(v_nome, r.vendedor::text)
                                || ' e foi desviado para ' || v_email || '. Não entra na contagem de envios.'
                ELSE '' END;

      INSERT INTO public.fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status, metadata)
      VALUES ('oben', 'outro', 'info', v_titulo, v_corpo, 'pendente_notificacao',
              jsonb_build_object('origem', 'radar.avisar_vendedores', 'envio_id', v_envio, 'semana', v_semana,
                                 'n_leads', v_qtd, 'teste', v_teste, 'tentativa', v_tentativa))
      RETURNING id INTO v_alerta;

      INSERT INTO public.radar_email_vendedor_envios
        (id, vendedor_user_id, semana, tentativa, destinatario_email, eh_teste, alerta_id, territorio, n_leads, elegiveis, criado_em)
      VALUES (v_envio, r.vendedor, v_semana, v_tentativa, v_email, v_teste, v_alerta, v_terr, v_qtd, v_elegiveis, p_agora);

      INSERT INTO public.radar_email_vendedor_leads (envio_id, posicao, cnpj, score, municipio_codigo, atribuido)
        SELECT v_envio, x.posicao, x.cnpj, x.score, x.municipio_codigo, x.atribuido
          FROM jsonb_to_recordset(v_leads) AS x(posicao smallint, cnpj text, score smallint, municipio_codigo text,
                                                atribuido boolean);

      v_avisados := v_avisados || jsonb_build_object('vendedor', r.vendedor, 'envio_id', v_envio, 'alerta_id', v_alerta,
                                                     'n_leads', v_qtd, 'elegiveis', v_elegiveis, 'atribuidos', v_atrib,
                                                     'tentativa', v_tentativa, 'teste', v_teste);
    EXCEPTION WHEN OTHERS THEN
      -- Não é engolir: o erro vai inteiro (SQLSTATE + mensagem) para o ledger, que sai com status 'erro'.
      GET STACKED DIAGNOSTICS v_estado = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_erros := v_erros || jsonb_build_object('vendedor', r.vendedor, 'sqlstate', v_estado, 'erro', left(v_msg, 300));
    END;
  END LOOP;

  -- Ledger só quando havia vendedor ligado: semana sem config ativa não suja acoes_execucoes
  -- (cron.job_run_details é a fonte do "rodou"). Pulado e erro também entram.
  IF jsonb_array_length(v_avisados) + jsonb_array_length(v_pulados) + jsonb_array_length(v_erros) > 0 THEN
    INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
    VALUES ('radar.avisar_vendedores', 'automatica', v_ini, clock_timestamp(),
            CASE WHEN jsonb_array_length(v_erros) = 0 THEN 'sucesso' ELSE 'erro' END,
            jsonb_build_object('semana', v_semana, 'avisados', v_avisados, 'pulados', v_pulados, 'erros', v_erros));
  END IF;

  RETURN jsonb_build_object('semana', v_semana, 'avisados', v_avisados, 'pulados', v_pulados, 'erros', v_erros);
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_avisar_vendedores(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_avisar_vendedores(timestamptz) TO service_role;

-- ── 5. Card "Prospectar hoje" (mesma escolha e mesma janela do e-mail) ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.radar_prospectar_hoje(p_vendedor uuid DEFAULT NULL, p_n integer DEFAULT 3)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid    uuid := (SELECT auth.uid());
  v_alvo   uuid;
  v_n      integer := GREATEST(1, LEAST(COALESCE(p_n, 3), 5));
  v_terr   jsonb;
  v_motivo text;
  v_leads  jsonb;
BEGIN
  IF NOT COALESCE(private.cap_radar_prospectar(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  v_alvo := COALESCE(p_vendedor, v_uid);
  IF v_alvo <> v_uid AND NOT COALESCE(private.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: leads de outro vendedor exigem gestor' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('municipio_codigo', t.municipio_codigo, 'municipio_nome', t.municipio_nome,
                                               'uf', t.uf, 'clientes', t.clientes, 'compartilhado', t.compartilhado)
                            ORDER BY t.clientes DESC, t.municipio_codigo), '[]'::jsonb)
    INTO v_terr
    FROM private.radar_territorio_do_vendedor(v_alvo, 3) t;
  IF jsonb_array_length(v_terr) = 0 THEN
    v_motivo := private.radar_territorio_motivo(v_alvo);
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('posicao', x.posicao, 'cnpj', x.cnpj, 'razao_social', x.razao_social,
                                               'nome_fantasia', x.nome_fantasia, 'municipio_nome', x.municipio_nome,
                                               'uf', x.uf, 'score', x.score, 'score_motivos', to_jsonb(x.score_motivos),
                                               'elegiveis', x.elegiveis, 'atribuido', x.atribuido) ORDER BY x.posicao), '[]'::jsonb)
    INTO v_leads
    FROM private.radar_leads_do_vendedor(v_alvo, v_n, now()) x;

  RETURN jsonb_build_object('territorio', v_terr, 'territorio_motivo', v_motivo, 'leads', v_leads);
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_prospectar_hoje(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_prospectar_hoje(uuid, integer) TO authenticated;

-- ── 6. Painel do master: território com `compartilhado` e o motivo do território vazio ──────────────────
CREATE OR REPLACE FUNCTION public.radar_email_semanal_painel()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid      uuid := (SELECT auth.uid());
  v_cron     jsonb;
  v_usuarios jsonb;
BEGIN
  IF v_uid IS NULL OR NOT COALESCE(public.has_role(v_uid, 'master'::public.app_role), false) THEN
    RAISE EXCEPTION 'forbidden: so master liga o e-mail semanal do Radar' USING ERRCODE = '42501';
  END IF;

  -- Job ausente = NULL (≠ desligado): a tela diz "cron não encontrado", nunca "desligado".
  SELECT jsonb_build_object('ativo', j.active, 'agenda', j.schedule) INTO v_cron
    FROM cron.job j WHERE j.jobname = 'radar-avisar-vendedores-semanal';

  WITH alvo AS (
    SELECT ur.user_id FROM public.user_roles ur
     WHERE ur.role IN ('employee'::public.app_role, 'master'::public.app_role)
    UNION
    SELECT c.vendedor_user_id FROM public.radar_email_vendedor_config c
  ), linhas AS (
    SELECT a.user_id,
           p.name  AS nome,
           p.email AS email,
           (SELECT string_agg(ur.role::text, ',' ORDER BY ur.role::text) FROM public.user_roles ur
             WHERE ur.user_id = a.user_id) AS papel,
           (SELECT cr.commercial_role::text FROM public.commercial_roles cr WHERE cr.user_id = a.user_id) AS papel_comercial,
           COALESCE(private.cap_radar_prospectar(a.user_id), false) AS acesso_radar,
           CASE WHEN c.ativo IS NOT TRUE THEN 'desligado'
                WHEN c.email_teste IS NOT NULL THEN 'teste'
                ELSE 'ligado' END AS modo,
           c.email_teste,
           c.atualizado_em,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('municipio', t.municipio_nome, 'uf', t.uf, 'clientes', t.clientes,
                                                         'compartilhado', t.compartilhado)
                                      ORDER BY t.clientes DESC, t.municipio_codigo)
                       FROM private.radar_territorio_do_vendedor(a.user_id, 3) t), '[]'::jsonb) AS territorio,
           (SELECT jsonb_build_object('semana', e.semana, 'eh_teste', e.eh_teste, 'n_leads', e.n_leads,
                                      'elegiveis', e.elegiveis, 'destinatario', e.destinatario_email, 'status', fa.status,
                                      'tentativa', e.tentativa)
              FROM public.radar_email_vendedor_envios e
              LEFT JOIN public.fornecedor_alerta fa ON fa.id = e.alerta_id
             WHERE e.vendedor_user_id = a.user_id
             ORDER BY e.semana DESC, e.criado_em DESC, e.tentativa DESC LIMIT 1) AS ultimo_envio
      FROM alvo a
      LEFT JOIN public.radar_email_vendedor_config c ON c.vendedor_user_id = a.user_id
      LEFT JOIN LATERAL (SELECT pr.name, btrim(pr.email) AS email FROM public.profiles pr
                          WHERE pr.user_id = a.user_id ORDER BY pr.created_at LIMIT 1) p ON true
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', l.user_id, 'nome', l.nome, 'email', l.email, 'papel', l.papel,
           'papel_comercial', l.papel_comercial, 'acesso_radar', l.acesso_radar, 'modo', l.modo,
           'email_teste', l.email_teste, 'atualizado_em', l.atualizado_em, 'territorio', l.territorio,
           'territorio_motivo', CASE WHEN jsonb_array_length(l.territorio) = 0
                                     THEN private.radar_territorio_motivo(l.user_id) END,
           'ultimo_envio', l.ultimo_envio)
         ORDER BY (l.modo = 'desligado'), l.nome NULLS LAST, l.user_id), '[]'::jsonb)
    INTO v_usuarios
    FROM linhas l;

  RETURN jsonb_build_object('cron', v_cron, 'usuarios', v_usuarios);
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_email_semanal_painel() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_email_semanal_painel() TO authenticated;

-- ── Postcondição ────────────────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  f text;
BEGIN
  -- P1: a escolha nova existe e a velha sumiu (dois "não repetir" convivendo fariam os canais divergirem).
  IF to_regprocedure('private.radar_leads_do_vendedor(uuid,integer,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'P1 FALHOU: private.radar_leads_do_vendedor(uuid,integer,timestamptz) ausente';
  END IF;
  IF to_regprocedure('private.radar_leads_do_vendedor(uuid,integer,timestamptz,timestamptz)') IS NOT NULL THEN
    RAISE EXCEPTION 'P1 FALHOU: a assinatura velha de radar_leads_do_vendedor continua viva';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'private.radar_territorio_do_vendedor(uuid,integer)'::regprocedure
                   AND 'compartilhado' = ANY (p.proargnames)) THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_territorio_do_vendedor sem a coluna compartilhado';
  END IF;

  -- P2: internas fechadas nas duas pontas (DROP + CREATE reseta o ACL; o REVOKE acima tem de ter pegado).
  FOREACH f IN ARRAY ARRAY['private.radar_territorio_do_vendedor(uuid,integer)',
                           'private.radar_territorio_motivo(uuid)',
                           'private.radar_leads_do_vendedor(uuid,integer,timestamptz)',
                           'public.radar_avisar_vendedores(timestamptz)'] LOOP
    IF has_function_privilege('public', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE')
       OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'P2 FALHOU: % executável por PUBLIC/anon/authenticated', f;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.radar_avisar_vendedores(timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P2 FALHOU: service_role (cron) perdeu o EXECUTE de radar_avisar_vendedores';
  END IF;

  -- P3: as RPCs do front seguem só para authenticated, e as leituras seguem PURAS (allowlist da lente).
  FOREACH f IN ARRAY ARRAY['public.radar_prospectar_hoje(uuid,integer)', 'public.radar_email_semanal_painel()'] LOOP
    IF has_function_privilege('public', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'P3 FALHOU: ACL de % errada (quer authenticated sim, PUBLIC/anon não)', f;
    END IF;
    IF (SELECT provolatile FROM pg_proc WHERE oid = f::regprocedure) <> 's' THEN
      RAISE EXCEPTION 'P3 FALHOU: % deixou de ser STABLE — sai da allowlist de leitura da lente', f;
    END IF;
  END LOOP;

  -- P4: a semana não é mais travada por 1 envio; a unicidade agora inclui a tentativa.
  -- Pelas COLUNAS de todo índice único (constraint ou não), não pelo nome.
  IF EXISTS (SELECT 1 FROM pg_index i
              WHERE i.indrelid = 'public.radar_email_vendedor_envios'::regclass AND i.indisunique
                AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text) FROM pg_attribute a
                      WHERE a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey))
                    = ARRAY['eh_teste', 'semana', 'vendedor_user_id']) THEN
    RAISE EXCEPTION 'P4 FALHOU: a UNIQUE antiga (vendedor, semana, eh_teste) continua: e-mail que falhou consome a semana';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i
                  WHERE i.indrelid = 'public.radar_email_vendedor_envios'::regclass AND i.indisunique AND i.indisvalid
                    AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text) FROM pg_attribute a
                          WHERE a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey))
                        = ARRAY['eh_teste', 'semana', 'tentativa', 'vendedor_user_id']) THEN
    RAISE EXCEPTION 'P4 FALHOU: UNIQUE (vendedor, semana, eh_teste, tentativa) ausente';
  END IF;

  -- P5: a URL do link tem fonte e está no formato.
  IF NOT EXISTS (SELECT 1 FROM public.company_config WHERE key = 'app_url_publica'
                   AND rtrim(btrim(value), '/') ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$') THEN
    RAISE EXCEPTION 'P5 FALHOU: company_config.app_url_publica ausente ou fora do formato https://host';
  END IF;
END
$post$;

COMMIT;
