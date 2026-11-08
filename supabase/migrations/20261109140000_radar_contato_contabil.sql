-- =============================================================================
-- Radar: contato provável da CONTABILIDADE do cliente (telefone1, telefone2 e e-mail, um por um)
-- =============================================================================
-- Pedido do founder: "o radar já me falar se o número de contato é de uma contabilidade do cliente; assim eu não ligo
-- e vou direto à visita". Medido em PROD (export com hash, 573.021 CNPJs, PG17 local, 2026-11-07) — ver
-- docs/historico/radar-contato-contabilidade.md.
--
-- REGRA v1 (o motivo de cada marca fica gravado, por contato):
--   telefone_compartilhado · o mesmo telefone (DDD + últimos 8 dígitos: junta o 9º dígito) aparece em 4+ grupos SEM
--       VÍNCULO DETECTADO, ou em 3 grupos com corroboração (algum membro tem e-mail forte de contabilidade). Grupo =
--       mesma raiz de CNPJ (filiais) unida às raízes com sócio em comum por NOME NORMALIZADO + CPF MASCARADO
--       (radar_socios, lote vigente). Nome sozinho NÃO une (homônimo juntaria empresas sem relação — parecer Codex).
--       O "3 com corroboração" é o V2 do parecer: tira 6% (MG) dos CNPJs que o "3 puro" marcaria.
--   email_compartilhado · o MESMO ENDEREÇO de e-mail em 3+ grupos sem vínculo (qualquer domínio). Substitui o
--       "domínio compartilhado" do pedido: o que o domínio acrescentava além disto e da palavra eram 814 CNPJs em MG,
--       quase todos erro de digitação de webmail (gamil.com, gmai.com) e provedor regional (netsite, uai).
--   email_palavra       · o e-mail contém contab ou contador (sem acento, minúsculo).
--   email_palavra_fraca · contém escritorio ou assessoria, sem contab/contador (465 de 9.151 em MG; motivo separado
--       para medir à parte).
--   dominio_servico     · domínio de serviço de MEI/contabilidade: lista fechada (maismei.com.br, contabilizei.com.br,
--       crcXX.org.br dos 27 conselhos) e o .cnt.br (categoria do registro.br para contabilidade).
--   Lead cujo CNAE principal é 6920-6 (é ele o escritório) não recebe marca automática.
--
-- CÁLCULO EM LOTE, 1 ESCRITOR: public.radar_contato_contabil_recalcular() (service_role/cron), sob advisory lock, com
-- gate de impressão digital (versão da regra, lote Receita vigente, lote de sócios vigente, max(updated_at) e
-- count(*) de radar_empresas) e rede de 7 dias. Lê radar_empresas UMA vez numa tabela temporária (fotografia única)
-- e faz MERGE em public.radar_contato_contabil. A leitura (ficha, fila, card, e-mail) nunca agrupa: só consulta por
-- chave primária.
--
-- CORREÇÃO DO VENDEDOR: ledger append-only public.radar_contato_contabil_correcoes por (cnpj, tipo, valor ESTRITO):
-- sobrevive à troca telefone1↔telefone2 e não passa para um número novo. O último veredito vence; NULL = voltar ao
-- automático; a RPC exige a versão que o vendedor viu (sobrescrita concorrente desatualizada é recusada). Grava o que
-- o automático dizia na hora (sensor de acerto). Não propaga para outros CNPJs com o mesmo contato.
--
-- REGRA ÚNICA DO EFETIVO: private.radar_contato_contabil_avaliar parte dos contatos ATUAIS da empresa; ficha, fila
-- ("para visitar"), card e e-mail leem dela. "Visitar" = >= 1 contato utilizável, TODOS marcados no efetivo, e
-- endereço presente. O lead continua elegível no e-mail/card; vai marcado "visitar" com o endereço.
--
-- Funções VIVAS recriadas (molde TRAVA → PRE → CREATE → PÓS; predecessoras = corpos de PROD de 2026-11-07, md5 do
-- prosrc conferido por psql-ro): radar_lista (DROP+CREATE: ganha p_so_visitar, 23º argumento), radar_avisar_vendedores
-- e radar_prospectar_hoje (CREATE OR REPLACE, mesma assinatura). private.radar_leads_do_vendedor (elegibilidade do
-- pacote E) NÃO muda.
-- Arquivo para `bun run db:aplicar` (sem BEGIN/COMMIT; para colar no SQL Editor, envolva em BEGIN; … COMMIT;).
-- Prova PG17: db/test-radar-contato-contabil.sh (--falsificar).
-- =============================================================================

-- ── TRAVA: pré-requisitos e trava das funções que a PRE guarda ──────────────────────────────────────────────
DO $trava$
BEGIN
  IF to_regclass('public.radar_empresas') IS NULL OR to_regclass('public.radar_ingest_state') IS NULL
     OR to_regclass('public.radar_socios') IS NULL OR to_regclass('public.radar_socios_lote') IS NULL
     OR to_regclass('public.radar_email_vendedor_leads') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: radar_empresas/radar_ingest_state/radar_socios/radar_socios_lote/radar_email_vendedor_leads ausente';
  END IF;
  IF to_regprocedure('private.cap_radar_prospectar(uuid)') IS NULL
     OR to_regprocedure('private.radar_leads_do_vendedor(uuid,integer,timestamptz)') IS NULL
     OR to_regprocedure('public.radar_atendimentos_ativos()') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: cap_radar_prospectar, radar_leads_do_vendedor (pacote E) ou radar_atendimentos_ativos ausente';
  END IF;
  -- ALTER sem efeito (a volatilidade VIVA): prende cada função até o COMMIT, antes de a PRE ler o corpo.
  IF to_regprocedure('public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text,boolean)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text,boolean) STABLE;
  END IF;
  IF to_regprocedure('public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text,boolean,boolean)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text,boolean,boolean) STABLE;
  END IF;
  ALTER FUNCTION public.radar_avisar_vendedores(timestamptz) VOLATILE;
  ALTER FUNCTION public.radar_prospectar_hoje(uuid, integer) STABLE;
END
$trava$;

-- ── PRE: corpo vivo ∈ {predecessor revisado (PROD 2026-11-07), este arquivo} ─────────────────────────────────
DO $pre$
DECLARE
  r record;
  v_lista_22 text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text,boolean)'));
  v_lista_23 text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text,boolean,boolean)'));
  v_sobrecargas bigint := (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'radar_lista');
BEGIN
  FOR r IN
    SELECT v.alvo, v.predecessor, v.este,
           (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v.alvo)) AS vivo
      FROM (VALUES
        ('public.radar_avisar_vendedores(timestamptz)', 'b94e689aa55d06036848841204bebea3', '6c5c9fd0423301f9e835008cb621019f'),
        ('public.radar_prospectar_hoje(uuid,integer)',  'ab8799c17ac7a8b1078e1a999d3c6ab6', 'd35f8f19e9b3612de3454c306f77a52d')
      ) AS v(alvo, predecessor, este)
  LOOP
    IF r.vivo IS NULL THEN
      RAISE EXCEPTION 'PRE FALHOU: % ausente', r.alvo;
    ELSIF r.vivo IS DISTINCT FROM r.predecessor AND r.vivo IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) não é o predecessor revisado nem este — outra sessão mudou; refaça o pré-voo', r.alvo, r.vivo;
    END IF;
  END LOOP;
  -- radar_lista: OU a de 22 com o corpo do pacote B2 e a de 23 ausente (1º apply), OU a de 22 ausente e a de 23 com
  -- ESTE corpo (re-apply). Uma sobrecarga só (senão o PostgREST acusa ambiguidade).
  IF v_sobrecargas <> 1
     OR NOT ((v_lista_22 IS NOT DISTINCT FROM 'c824ce104b6513307b6b027622c8fd50' AND v_lista_23 IS NULL)
             OR (v_lista_22 IS NULL AND v_lista_23 IS NOT DISTINCT FROM 'a750e9ad598fb6977e2a870b0ce1ba2c')) THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_lista viva (22 args md5 %, 23 args md5 %, % sobrecargas) não é o predecessor revisado nem este',
      v_lista_22, v_lista_23, v_sobrecargas;
  END IF;
END
$pre$;

-- ── Tabelas: sinal (1 escritor), estado do lote, ledger de correção ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.radar_contato_contabil (
  cnpj          text NOT NULL,
  tipo          text NOT NULL CHECK (tipo IN ('telefone', 'email')),
  -- Identidade ESTRITA do contato: telefone só dígitos (sem 55 e sem zero à esquerda); e-mail minúsculo, sem espaço.
  valor         text NOT NULL,
  motivos       text[] NOT NULL CHECK (cardinality(motivos) > 0 AND motivos <@ ARRAY['telefone_compartilhado',
                  'email_compartilhado', 'email_palavra', 'email_palavra_fraca', 'dominio_servico']::text[]),
  -- Em quantos grupos SEM VÍNCULO DETECTADO o contato aparece (só nos motivos de compartilhamento).
  grupos        integer CHECK (grupos IS NULL OR grupos >= 3),
  -- Telefone: algum membro do grupo tem e-mail forte de contabilidade. NULL no e-mail.
  corroborado   boolean,
  versao_regra  smallint NOT NULL,
  calculado_em  timestamptz NOT NULL,
  PRIMARY KEY (cnpj, tipo, valor)
);
COMMENT ON TABLE public.radar_contato_contabil IS
  'Contatos (telefone/e-mail) de radar_empresas que provavelmente são da contabilidade do cliente, com o motivo. 1 escritor: radar_contato_contabil_recalcular (cron diário). Ver 20261109140000_radar_contato_contabil.';
ALTER TABLE public.radar_contato_contabil ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.radar_contato_contabil FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.radar_contato_contabil_estado (
  id            boolean PRIMARY KEY DEFAULT true CHECK (id),
  impressao     text NOT NULL,
  versao_regra  smallint NOT NULL,
  calculado_em  timestamptz NOT NULL,
  contatos      integer NOT NULL,
  duracao_ms    integer NOT NULL,
  detalhes      jsonb NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON TABLE public.radar_contato_contabil_estado IS
  'Última rodada LIMPA de radar_contato_contabil_recalcular (impressão digital do que foi lido). 1 linha, 1 escritor.';
ALTER TABLE public.radar_contato_contabil_estado ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.radar_contato_contabil_estado FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.radar_contato_contabil_correcoes (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cnpj           text NOT NULL,
  tipo           text NOT NULL CHECK (tipo IN ('telefone', 'email')),
  valor          text NOT NULL,
  campo          text NOT NULL CHECK (campo IN ('telefone1', 'telefone2', 'email')),
  -- true = é da contabilidade · false = não é · NULL = voltar ao automático.
  veredito       boolean,
  -- O que o sinal automático dizia na hora (NULL = ainda não calculado): mede acerto, não só uso.
  automatico     boolean,
  -- A correção que o vendedor tinha na tela (NULL = nenhuma). A RPC recusa se não for a última.
  substitui_id   bigint,
  autor_user_id  uuid NOT NULL,
  criado_em      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_radar_contato_contabil_correcoes_contato
  ON public.radar_contato_contabil_correcoes (cnpj, tipo, valor, id DESC);
COMMENT ON TABLE public.radar_contato_contabil_correcoes IS
  'Ledger append-only da correção do vendedor ("é / não é da contabilidade"). Prevalece sobre o automático; sensor de uso e de acerto. Escrita só por radar_contato_contabil_corrigir.';
ALTER TABLE public.radar_contato_contabil_correcoes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.radar_contato_contabil_correcoes FROM PUBLIC, anon, authenticated;

-- E-mail semanal: o lead foi como "visitar"? (NULL = enviado antes desta migration.)
ALTER TABLE public.radar_email_vendedor_leads ADD COLUMN IF NOT EXISTS visitar boolean;
COMMENT ON COLUMN public.radar_email_vendedor_leads.visitar IS
  'O lead saiu no e-mail como "visitar" (todo contato com indício de contabilidade). NULL = envio anterior a 20261109140000.';

-- ── Normalizadores e motivos próprios do e-mail (puros) ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.radar_tel_valor(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path TO 'pg_catalog'
AS $fn$
  -- Só dígitos, sem 55 e sem zero à esquerda; 10 ou 11 dígitos; número de um dígito só (00000000, 99999999) é lixo.
  SELECT CASE WHEN length(d) IN (10, 11) AND right(d, 8) !~ '^(.)\1{7}$' THEN d END
    FROM (SELECT CASE WHEN length(x) IN (12, 13) AND left(x, 2) = '55' THEN substr(x, 3) ELSE x END AS d
            FROM (SELECT ltrim(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), '0') AS x) a) b
$fn$;
REVOKE ALL ON FUNCTION private.radar_tel_valor(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.radar_email_valor(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path TO 'pg_catalog'
AS $fn$
  SELECT CASE WHEN v ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN v END
    FROM (SELECT lower(btrim(p)) AS v) a
$fn$;
REVOKE ALL ON FUNCTION private.radar_email_valor(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.radar_email_motivos_proprios(p_valor text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path TO 'pg_catalog'
AS $fn$
  -- O que o e-mail diz sozinho, sem comparar com outras empresas. Recebe o valor de radar_email_valor.
  SELECT CASE WHEN p_valor IS NULL THEN ARRAY[]::text[] ELSE array_remove(ARRAY[
           CASE WHEN n ~ '(contab|contador)' THEN 'email_palavra' END,
           CASE WHEN n !~ '(contab|contador)' AND n ~ '(escritorio|assessoria)' THEN 'email_palavra_fraca' END,
           CASE WHEN d IN ('maismei.com.br', 'contabilizei.com.br',
                           'crcac.org.br', 'crcal.org.br', 'crcam.org.br', 'crcap.org.br', 'crcba.org.br', 'crcce.org.br',
                           'crcdf.org.br', 'crces.org.br', 'crcgo.org.br', 'crcma.org.br', 'crcmg.org.br', 'crcms.org.br',
                           'crcmt.org.br', 'crcpa.org.br', 'crcpb.org.br', 'crcpe.org.br', 'crcpi.org.br', 'crcpr.org.br',
                           'crcrj.org.br', 'crcrn.org.br', 'crcro.org.br', 'crcrr.org.br', 'crcrs.org.br', 'crcsc.org.br',
                           'crcse.org.br', 'crcsp.org.br', 'crcto.org.br')
                     OR d ~ '\.cnt\.br$' THEN 'dominio_servico' END], NULL) END
    FROM (SELECT translate(coalesce(p_valor, ''), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc') AS n,
                 split_part(coalesce(p_valor, ''), '@', 2) AS d) x
$fn$;
REVOKE ALL ON FUNCTION private.radar_email_motivos_proprios(text) FROM PUBLIC, anon, authenticated;

-- ── O escritor: recálculo em lote ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.radar_contato_contabil_recalcular(p_forcar boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
  c_versao    constant smallint := 1;
  v_ini       timestamptz := clock_timestamp();
  v_lote      text;
  v_socios    text;
  v_imp       text;
  v_imp_ant   text;
  v_calc_ant  timestamptz;
  v_n         bigint;
  v_iter      integer := 0;
  v_del       bigint;
  v_ins       bigint;
  v_total     bigint;
  v_tel       bigint;
  v_email     bigint;
BEGIN
  -- Uma rodada por vez, ANTES do gate (parecer Codex): duas chamadas simultâneas não se atropelam no MERGE.
  PERFORM pg_advisory_xact_lock(hashtext('radar.contato_contabil_recalcular'));

  SELECT s.mes_referencia INTO v_lote FROM public.radar_ingest_state s
   WHERE s.status = 'complete' ORDER BY s.mes_referencia DESC LIMIT 1;
  SELECT l.lote INTO v_socios FROM public.radar_socios_lote l
   WHERE l.status = 'vigente' ORDER BY l.publicado_em DESC NULLS LAST, l.lote DESC LIMIT 1;
  v_imp := concat_ws('|', 'v' || c_versao, coalesce(v_lote, '-'), coalesce(v_socios, '-'),
                     coalesce((SELECT max(e.updated_at) FROM public.radar_empresas e)::text, '-'),
                     (SELECT count(*) FROM public.radar_empresas)::text);
  SELECT s.impressao, s.calculado_em INTO v_imp_ant, v_calc_ant FROM public.radar_contato_contabil_estado s WHERE s.id;
  IF NOT coalesce(p_forcar, false) AND v_imp_ant IS NOT DISTINCT FROM v_imp AND v_calc_ant > now() - interval '7 days' THEN
    RETURN jsonb_build_object('pulado', true, 'impressao', v_imp, 'calculado_em', v_calc_ant);
  END IF;

  -- 2ª chamada na MESMA transação (ON COMMIT DROP ainda não rodou): limpa. Sem o IF, o 1º uso da sessão avisa
  -- "schema pg_temp does not exist" no log do cron.
  IF to_regclass('pg_temp.rcc_emp') IS NOT NULL THEN
    DROP TABLE IF EXISTS pg_temp.rcc_emp, pg_temp.rcc_mem, pg_temp.rcc_aresta, pg_temp.rcc_lab, pg_temp.rcc_grupo,
                         pg_temp.rcc_forte, pg_temp.rcc_tel, pg_temp.rcc_novo;
  END IF;

  -- Fotografia ÚNICA de radar_empresas (uma leitura; o resto sai dela).
  CREATE TEMP TABLE rcc_emp ON COMMIT DROP AS
    SELECT e.cnpj, left(e.cnpj, 8) AS raiz,
           private.radar_tel_valor(e.telefone1) AS t1, private.radar_tel_valor(e.telefone2) AS t2,
           private.radar_email_valor(e.email) AS em,
           coalesce(starts_with(e.cnae_principal, '6920'), false) AS eh_contabil
      FROM public.radar_empresas e;

  -- Membros (chave, raiz) só das chaves com 3+ raízes. Telefone agrupa por DDD + últimos 8 dígitos.
  CREATE TEMP TABLE rcc_mem ON COMMIT DROP AS
    WITH m AS (
      SELECT DISTINCT 'telefone'::text AS tipo, left(x.v, 2) || right(x.v, 8) AS chave, e.raiz
        FROM pg_temp.rcc_emp e CROSS JOIN LATERAL (VALUES (e.t1), (e.t2)) AS x(v)
       WHERE x.v IS NOT NULL
      UNION
      SELECT 'email'::text, e.em, e.raiz FROM pg_temp.rcc_emp e WHERE e.em IS NOT NULL
    ), c AS (
      SELECT m.tipo, m.chave FROM m GROUP BY m.tipo, m.chave HAVING count(*) >= 3
    )
    SELECT m.tipo, m.chave, m.raiz FROM m JOIN c ON c.tipo = m.tipo AND c.chave = m.chave;
  CREATE INDEX ON pg_temp.rcc_mem (raiz);

  -- Vínculo entre raízes da MESMA chave: sócio em comum por nome normalizado + CPF mascarado, lote vigente.
  CREATE TEMP TABLE rcc_aresta ON COMMIT DROP AS
    WITH ms AS (
      SELECT DISTINCT m.tipo, m.chave, m.raiz, s.nome_normalizado, s.cpf_mascarado
        FROM pg_temp.rcc_mem m
        JOIN public.radar_socios s ON s.raiz = m.raiz AND s.lote = v_socios
       WHERE s.cpf_mascarado IS NOT NULL AND s.nome_normalizado IS NOT NULL
    )
    SELECT DISTINCT a.tipo, a.chave, a.raiz AS ra, b.raiz AS rb
      FROM ms a JOIN ms b ON b.tipo = a.tipo AND b.chave = a.chave AND b.nome_normalizado = a.nome_normalizado
                         AND b.cpf_mascarado = a.cpf_mascarado AND b.raiz <> a.raiz;

  -- Componentes conexos por propagação do menor rótulo (as arestas saem nos dois sentidos).
  CREATE TEMP TABLE rcc_lab ON COMMIT DROP AS
    SELECT m.tipo, m.chave, m.raiz, m.raiz AS rotulo FROM pg_temp.rcc_mem m;
  CREATE INDEX ON pg_temp.rcc_lab (tipo, chave, raiz);
  LOOP
    UPDATE pg_temp.rcc_lab l SET rotulo = n.menor
      FROM (SELECT a.tipo, a.chave, a.ra AS raiz, min(lb.rotulo) AS menor
              FROM pg_temp.rcc_aresta a
              JOIN pg_temp.rcc_lab lb ON lb.tipo = a.tipo AND lb.chave = a.chave AND lb.raiz = a.rb
             GROUP BY a.tipo, a.chave, a.ra) n
     WHERE l.tipo = n.tipo AND l.chave = n.chave AND l.raiz = n.raiz AND n.menor < l.rotulo;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_iter := v_iter + 1;
    EXIT WHEN v_n = 0;
    IF v_iter >= 100 THEN
      RAISE EXCEPTION 'radar_contato_contabil_recalcular: componentes não convergiram em 100 rodadas';
    END IF;
  END LOOP;

  CREATE TEMP TABLE rcc_grupo ON COMMIT DROP AS
    SELECT l.tipo, l.chave, count(DISTINCT l.rotulo)::integer AS grupos
      FROM pg_temp.rcc_lab l GROUP BY l.tipo, l.chave;
  CREATE INDEX ON pg_temp.rcc_grupo (tipo, chave);

  -- Raízes com e-mail FORTE de contabilidade (corroboram o telefone de 3 grupos). A palavra fraca não corrobora.
  CREATE TEMP TABLE rcc_forte ON COMMIT DROP AS
    SELECT DISTINCT e.raiz
      FROM pg_temp.rcc_emp e
      LEFT JOIN pg_temp.rcc_grupo g ON g.tipo = 'email' AND g.chave = e.em
     WHERE e.em IS NOT NULL AND NOT e.eh_contabil
       AND (private.radar_email_motivos_proprios(e.em) && ARRAY['email_palavra', 'dominio_servico']::text[]
            OR coalesce(g.grupos, 0) >= 3);

  CREATE TEMP TABLE rcc_tel ON COMMIT DROP AS
    SELECT g.chave, g.grupos,
           EXISTS (SELECT 1 FROM pg_temp.rcc_mem m JOIN pg_temp.rcc_forte f ON f.raiz = m.raiz
                    WHERE m.tipo = 'telefone' AND m.chave = g.chave) AS corroborado
      FROM pg_temp.rcc_grupo g
     WHERE g.tipo = 'telefone' AND g.grupos >= 3;

  CREATE TEMP TABLE rcc_novo ON COMMIT DROP AS
    SELECT DISTINCT e.cnpj, 'telefone'::text AS tipo, x.v AS valor, ARRAY['telefone_compartilhado']::text[] AS motivos,
           t.grupos, t.corroborado
      FROM pg_temp.rcc_emp e
      CROSS JOIN LATERAL (VALUES (e.t1), (e.t2)) AS x(v)
      JOIN pg_temp.rcc_tel t ON t.chave = left(x.v, 2) || right(x.v, 8)
     WHERE x.v IS NOT NULL AND NOT e.eh_contabil AND (t.grupos >= 4 OR t.corroborado)
    UNION ALL
    SELECT e.cnpj, 'email'::text, e.em, mo.motivos, g.grupos, NULL::boolean
      FROM pg_temp.rcc_emp e
      LEFT JOIN pg_temp.rcc_grupo g ON g.tipo = 'email' AND g.chave = e.em AND g.grupos >= 3
      CROSS JOIN LATERAL (SELECT private.radar_email_motivos_proprios(e.em)
                                 || CASE WHEN g.grupos IS NOT NULL THEN ARRAY['email_compartilhado']::text[]
                                         ELSE ARRAY[]::text[] END AS motivos) mo
     WHERE e.em IS NOT NULL AND NOT e.eh_contabil AND cardinality(mo.motivos) > 0;
  CREATE INDEX ON pg_temp.rcc_novo (cnpj, tipo, valor);

  -- MERGE: sai o que não vale mais; entra/atualiza só o que mudou (sem reescrever ~80 mil linhas por dia).
  DELETE FROM public.radar_contato_contabil c
   WHERE NOT EXISTS (SELECT 1 FROM pg_temp.rcc_novo n WHERE n.cnpj = c.cnpj AND n.tipo = c.tipo AND n.valor = c.valor);
  GET DIAGNOSTICS v_del = ROW_COUNT;
  INSERT INTO public.radar_contato_contabil AS c (cnpj, tipo, valor, motivos, grupos, corroborado, versao_regra, calculado_em)
    SELECT n.cnpj, n.tipo, n.valor, n.motivos, n.grupos, n.corroborado, c_versao, v_ini FROM pg_temp.rcc_novo n
  ON CONFLICT (cnpj, tipo, valor) DO UPDATE
     SET motivos = EXCLUDED.motivos, grupos = EXCLUDED.grupos, corroborado = EXCLUDED.corroborado,
         versao_regra = EXCLUDED.versao_regra, calculado_em = EXCLUDED.calculado_em
   WHERE (c.motivos, c.grupos, c.corroborado, c.versao_regra)
         IS DISTINCT FROM (EXCLUDED.motivos, EXCLUDED.grupos, EXCLUDED.corroborado, EXCLUDED.versao_regra);
  GET DIAGNOSTICS v_ins = ROW_COUNT;

  SELECT count(*), count(*) FILTER (WHERE n.tipo = 'telefone'), count(*) FILTER (WHERE n.tipo = 'email')
    INTO v_total, v_tel, v_email FROM pg_temp.rcc_novo n;

  INSERT INTO public.radar_contato_contabil_estado AS s (id, impressao, versao_regra, calculado_em, contatos, duracao_ms, detalhes)
  VALUES (true, v_imp, c_versao, v_ini, v_total,
          (extract(epoch FROM clock_timestamp() - v_ini) * 1000)::integer,
          jsonb_build_object('telefones', v_tel, 'emails', v_email, 'removidos', v_del, 'gravados', v_ins,
                             'iteracoes', v_iter, 'lote', v_lote, 'socios_lote', v_socios))
  ON CONFLICT (id) DO UPDATE
     SET impressao = EXCLUDED.impressao, versao_regra = EXCLUDED.versao_regra, calculado_em = EXCLUDED.calculado_em,
         contatos = EXCLUDED.contatos, duracao_ms = EXCLUDED.duracao_ms, detalhes = EXCLUDED.detalhes;

  RETURN jsonb_build_object('pulado', false, 'impressao', v_imp, 'contatos', v_total, 'telefones', v_tel,
                            'emails', v_email, 'removidos', v_del, 'gravados', v_ins, 'iteracoes', v_iter,
                            'duracao_ms', (extract(epoch FROM clock_timestamp() - v_ini) * 1000)::integer);
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_contato_contabil_recalcular(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_contato_contabil_recalcular(boolean) TO service_role;

-- ── A regra ÚNICA do efetivo (parte dos contatos ATUAIS da empresa) ────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.radar_contato_contabil_avaliar(p_cnpj text, p_tel1 text, p_tel2 text, p_email text)
RETURNS TABLE(campo text, tipo text, valor text, automatico boolean, motivos text[], grupos integer,
              corroborado boolean, correcao_id bigint, veredito boolean, efetivo boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $fn$
  WITH c AS (
    SELECT v.ordem, v.campo, v.tipo, v.valor
      FROM (VALUES (1, 'telefone1', 'telefone', private.radar_tel_valor(p_tel1)),
                   (2, 'telefone2', 'telefone', private.radar_tel_valor(p_tel2)),
                   (3, 'email', 'email', private.radar_email_valor(p_email))) AS v(ordem, campo, tipo, valor)
     WHERE v.valor IS NOT NULL
  ), est AS (
    -- Nunca calculado = "não sei" (NULL), nunca "não é" (false): ausente ≠ zero.
    SELECT EXISTS (SELECT 1 FROM public.radar_contato_contabil_estado s WHERE s.id) AS calculado
  )
  SELECT c.campo, c.tipo, c.valor,
         CASE WHEN a.cnpj IS NOT NULL THEN true WHEN est.calculado THEN false END,
         a.motivos, a.grupos, a.corroborado, r.id, r.veredito,
         CASE WHEN r.veredito IS NOT NULL THEN r.veredito
              WHEN a.cnpj IS NOT NULL THEN true
              WHEN est.calculado THEN false END
    FROM c
    CROSS JOIN est
    LEFT JOIN public.radar_contato_contabil a ON a.cnpj = p_cnpj AND a.tipo = c.tipo AND a.valor = c.valor
    LEFT JOIN LATERAL (SELECT k.id, k.veredito FROM public.radar_contato_contabil_correcoes k
                        WHERE k.cnpj = p_cnpj AND k.tipo = c.tipo AND k.valor = c.valor
                        ORDER BY k.id DESC LIMIT 1) r ON true
   ORDER BY c.ordem
$fn$;
REVOKE ALL ON FUNCTION private.radar_contato_contabil_avaliar(text, text, text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.radar_contato_visitar(p_cnpj text, p_tel1 text, p_tel2 text, p_email text,
                                                         p_logradouro text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $fn$
  -- >= 1 contato utilizável, TODOS da contabilidade no efetivo (NULL = não sei → não afirma), e endereço para ir.
  SELECT NULLIF(btrim(coalesce(p_logradouro, '')), '') IS NOT NULL AND count(*) > 0 AND bool_and(a.efetivo IS TRUE)
    FROM private.radar_contato_contabil_avaliar(p_cnpj, p_tel1, p_tel2, p_email) a
$fn$;
REVOKE ALL ON FUNCTION private.radar_contato_visitar(text, text, text, text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.radar_contato_do_lead(p_cnpj text)
RETURNS TABLE(visitar boolean, endereco text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $fn$
  -- O que o card e o e-mail mostram: "visitar" e, só nesse caso, o endereço.
  SELECT v.visitar,
         CASE WHEN v.visitar THEN NULLIF(concat_ws(', ',
           NULLIF(btrim(coalesce(e.logradouro, '')), '') || coalesce(' ' || NULLIF(btrim(e.numero), ''), ''),
           NULLIF(btrim(coalesce(e.bairro, '')), ''),
           NULLIF(btrim(coalesce(e.municipio_nome, '')), '') || coalesce('/' || NULLIF(btrim(e.uf), ''), '')), '') END
    FROM public.radar_empresas e
    CROSS JOIN LATERAL (SELECT private.radar_contato_visitar(e.cnpj, e.telefone1, e.telefone2, e.email, e.logradouro)
                          AS visitar) v
   WHERE e.cnpj = p_cnpj
$fn$;
REVOKE ALL ON FUNCTION private.radar_contato_do_lead(text) FROM PUBLIC, anon, authenticated;

-- ── RPCs do front: leitura da ficha e correção do vendedor ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.radar_contato_contabil_da_empresa(p_cnpj text)
RETURNS TABLE(campo text, tipo text, valor text, automatico boolean, motivos text[], grupos integer,
              corroborado boolean, correcao_id bigint, veredito boolean, efetivo boolean, visitar boolean,
              calculado_em timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $fn$
BEGIN
  IF NOT coalesce(private.cap_radar_prospectar((SELECT auth.uid())), false) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN
    RAISE EXCEPTION 'cnpj inválido' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT a.campo, a.tipo, a.valor, a.automatico, a.motivos, a.grupos, a.corroborado, a.correcao_id, a.veredito,
           a.efetivo,
           private.radar_contato_visitar(e.cnpj, e.telefone1, e.telefone2, e.email, e.logradouro),
           (SELECT s.calculado_em FROM public.radar_contato_contabil_estado s WHERE s.id)
      FROM public.radar_empresas e
      CROSS JOIN LATERAL private.radar_contato_contabil_avaliar(e.cnpj, e.telefone1, e.telefone2, e.email) a
     WHERE e.cnpj = p_cnpj;
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_contato_contabil_da_empresa(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_contato_contabil_da_empresa(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.radar_contato_contabil_corrigir(p_cnpj text, p_campo text, p_veredito boolean,
                                                                  p_correcao_vista bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
  v_uid      uuid := (SELECT auth.uid());
  v_tipo     text;
  v_valor    text;
  v_ult      bigint;
  v_ult_ver  boolean;
  v_auto     boolean;
  v_id       bigint;
BEGIN
  IF NOT coalesce(private.cap_radar_prospectar(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN
    RAISE EXCEPTION 'cnpj inválido' USING ERRCODE = '22023';
  END IF;
  IF p_campo IS NULL OR p_campo NOT IN ('telefone1', 'telefone2', 'email') THEN
    RAISE EXCEPTION 'campo inválido' USING ERRCODE = '22023';
  END IF;
  -- O valor vem do SERVIDOR (o que a empresa tem agora), nunca do cliente.
  SELECT CASE p_campo WHEN 'telefone1' THEN private.radar_tel_valor(e.telefone1)
                      WHEN 'telefone2' THEN private.radar_tel_valor(e.telefone2)
                      ELSE private.radar_email_valor(e.email) END
    INTO v_valor
    FROM public.radar_empresas e WHERE e.cnpj = p_cnpj;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'empresa não encontrada no Radar' USING ERRCODE = 'P0002';
  END IF;
  IF v_valor IS NULL THEN
    RAISE EXCEPTION 'o campo % não tem contato utilizável', p_campo USING ERRCODE = '22023';
  END IF;
  v_tipo := CASE WHEN p_campo = 'email' THEN 'email' ELSE 'telefone' END;

  -- Uma correção por contato por vez; a versão que o vendedor viu tem de ser a última (sem sobrescrita cega).
  PERFORM pg_advisory_xact_lock(hashtext('radar.contato_contabil:' || p_cnpj || ':' || v_tipo || ':' || v_valor));
  SELECT k.id, k.veredito INTO v_ult, v_ult_ver
    FROM public.radar_contato_contabil_correcoes k
   WHERE k.cnpj = p_cnpj AND k.tipo = v_tipo AND k.valor = v_valor
   ORDER BY k.id DESC LIMIT 1;
  IF v_ult IS DISTINCT FROM p_correcao_vista THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'desatualizado', 'correcao_id', v_ult, 'veredito', v_ult_ver);
  END IF;
  IF (v_ult IS NULL AND p_veredito IS NULL) OR (v_ult IS NOT NULL AND v_ult_ver IS NOT DISTINCT FROM p_veredito) THEN
    RETURN jsonb_build_object('ok', true, 'sem_mudanca', true, 'correcao_id', v_ult, 'veredito', v_ult_ver);
  END IF;

  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.radar_contato_contabil a
                            WHERE a.cnpj = p_cnpj AND a.tipo = v_tipo AND a.valor = v_valor) THEN true
              WHEN EXISTS (SELECT 1 FROM public.radar_contato_contabil_estado s WHERE s.id) THEN false END
    INTO v_auto;
  INSERT INTO public.radar_contato_contabil_correcoes
    (cnpj, tipo, valor, campo, veredito, automatico, substitui_id, autor_user_id)
  VALUES (p_cnpj, v_tipo, v_valor, p_campo, p_veredito, v_auto, v_ult, v_uid)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'sem_mudanca', false, 'correcao_id', v_id, 'veredito', p_veredito,
                            'automatico', v_auto, 'efetivo', coalesce(p_veredito, v_auto));
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_contato_contabil_corrigir(text, text, boolean, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_contato_contabil_corrigir(text, text, boolean, bigint) TO authenticated;

-- ── Fila: radar_lista ganha p_so_visitar (23º argumento, DEFAULT false: a chamada de antes devolve o mesmo) ──
DROP FUNCTION IF EXISTS public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text,boolean);
CREATE OR REPLACE FUNCTION public.radar_lista(
  p_busca text DEFAULT NULL,
  p_municipio text DEFAULT NULL,
  p_uf text DEFAULT NULL,
  p_ufs text[] DEFAULT NULL,
  p_cnae_exato text DEFAULT NULL,
  p_cnae_prefixo text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_incluir_ja_clientes boolean DEFAULT false,
  p_ultimo_lote text DEFAULT NULL,
  p_primeira_vista_min timestamptz DEFAULT NULL,
  p_sugeridos_lote text DEFAULT NULL,
  p_sugeridos_score_min numeric DEFAULT NULL,
  p_com_telefone boolean DEFAULT false,
  p_com_contato boolean DEFAULT false,
  p_data_abertura_min date DEFAULT NULL,
  p_data_abertura_max date DEFAULT NULL,
  p_ordem text DEFAULT 'score',
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 50,
  p_cnae_secundario text DEFAULT NULL,
  p_municipio_codigo text DEFAULT NULL,
  p_so_meus boolean DEFAULT false,
  p_so_visitar boolean DEFAULT false)
 RETURNS SETOF public.radar_empresas
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_w text[] := ARRAY[]::text[];
BEGIN
  -- O mesmo gate da policy radar_empresas_select_gestor: quem não lê a tabela não lê a RPC.
  IF NOT (COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  -- Entrada mal formada contaria ZERO em silêncio (ou abriria a ordenação a SQL): grita.
  IF p_ordem IS NULL OR p_ordem NOT IN ('score', 'capital_social', 'data_abertura') THEN
    RAISE EXCEPTION 'ordem inválida' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 OR p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'paginação inválida' USING ERRCODE = '22023';
  END IF;
  IF p_cnae_exato IS NOT NULL AND p_cnae_exato !~ '^[0-9]{7}$' THEN
    RAISE EXCEPTION 'cnae_exato inválido' USING ERRCODE = '22023';
  END IF;
  IF p_cnae_prefixo IS NOT NULL AND p_cnae_prefixo !~ '^[0-9]{1,6}$' THEN
    RAISE EXCEPTION 'cnae_prefixo inválido' USING ERRCODE = '22023';
  END IF;
  IF p_cnae_secundario IS NOT NULL AND p_cnae_secundario !~ '^[0-9]{7}$' THEN
    RAISE EXCEPTION 'cnae_secundario inválido' USING ERRCODE = '22023';
  END IF;
  IF (p_ultimo_lote IS NOT NULL AND p_ultimo_lote !~ '^[0-9]{4}-[0-9]{2}$')
     OR (p_sugeridos_lote IS NOT NULL AND p_sugeridos_lote !~ '^[0-9]{4}-[0-9]{2}$') THEN
    RAISE EXCEPTION 'lote inválido' USING ERRCODE = '22023';
  END IF;
  IF p_sugeridos_lote IS NOT NULL AND p_sugeridos_score_min IS NULL THEN
    RAISE EXCEPTION 'sugeridos sem limiar de score' USING ERRCODE = '22023';
  END IF;
  -- Código de município da RFB: 4 dígitos. Mal formado contaria ZERO em silêncio: grita.
  IF p_municipio_codigo IS NOT NULL AND p_municipio_codigo !~ '^[0-9]{4}$' THEN
    RAISE EXCEPTION 'municipio_codigo inválido' USING ERRCODE = '22023';
  END IF;
  IF p_ufs IS NOT NULL AND (cardinality(p_ufs) = 0 OR cardinality(p_ufs) > 27
     OR EXISTS (SELECT 1 FROM unnest(p_ufs) AS x(u) WHERE x.u IS NULL OR x.u !~ '^[A-Z]{2}$')) THEN
    RAISE EXCEPTION 'ufs inválido' USING ERRCODE = '22023';
  END IF;

  -- Busca (razão OU fantasia) e município: o termo já chega sanitizado pelo front
  -- (sanitizeForPostgrestOr). Termo sem conteúdo (só espaço) = sem filtro, como o front faz com o vazio.
  IF private.padrao_like_contem(p_busca) IS NOT NULL THEN
    v_w := array_append(v_w, $w$(e.razao_social ILIKE private.padrao_like_contem($1) ESCAPE '\' OR e.nome_fantasia ILIKE private.padrao_like_contem($1) ESCAPE '\')$w$);
  END IF;
  IF private.padrao_like_contem(p_municipio) IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.municipio_nome ILIKE private.padrao_like_contem($2) ESCAPE '\'$w$);
  END IF;
  -- Cidade escolhida no ranking/mapa: o CÓDIGO, exato (o nome tem homônimos em outras UFs). Usa idx_radar_muni.
  IF p_municipio_codigo IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.municipio_codigo = $20$w$);
  END IF;
  -- "Meus atendimentos": só os leads que o vendedor assumiu e que seguem ATIVOS (não expirados, dono ainda na
  -- capability). NO SERVIDOR, antes do LIMIT/OFFSET: recortar os 50 carregados no front daria falso vazio. A
  -- expiração e o dono vêm de radar_atendimentos_ativos() (a mesma leitura da ficha e dos selos): a regra do
  -- prazo vive só em private.radar_atendimento_expira_em. Sem parâmetro ($n): o predicado é constante.
  IF COALESCE(p_so_meus, false) THEN
    v_w := array_append(v_w, $w$e.cnpj IN (SELECT a.cnpj FROM public.radar_atendimentos_ativos() a WHERE a.eh_meu)$w$);
  END IF;
  -- "Para visitar": todo contato utilizável do lead tem indício de contabilidade (no EFETIVO, com a correção do
  -- vendedor) e há endereço. NO SERVIDOR, antes do LIMIT/OFFSET. O IN pré-recorta pelos ~80 mil CNPJs com sinal ou
  -- correção positiva; a regra em si é private.radar_contato_visitar (a mesma do card e do e-mail). Sem parâmetro.
  IF COALESCE(p_so_visitar, false) THEN
    v_w := array_append(v_w, $w$e.cnpj IN (SELECT c.cnpj FROM public.radar_contato_contabil c
                                           UNION SELECT k.cnpj FROM public.radar_contato_contabil_correcoes k WHERE k.veredito)
      AND private.radar_contato_visitar(e.cnpj, e.telefone1, e.telefone2, e.email, e.logradouro)$w$);
  END IF;
  -- UF escolhida vence a região.
  IF p_uf IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.uf = $3$w$);
  ELSIF p_ufs IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.uf = ANY ($4)$w$);
  END IF;
  IF p_cnae_exato IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.cnae_principal = $5$w$);
  ELSIF p_cnae_prefixo IS NOT NULL THEN
    v_w := array_append(v_w, $w$starts_with(e.cnae_principal, $6)$w$);
  END IF;
  -- CNAE secundário combina com o principal (E): "@>" usa o GIN idx_radar_empresas_cnaes_sec.
  IF p_cnae_secundario IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.cnaes_secundarios @> ARRAY[$19]$w$);
  END IF;
  -- "Só sugeridos" = o predicado do card (filtrarSugeridos): fixa lote/status/já-cliente, vence os de baixo.
  IF p_sugeridos_lote IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.ultimo_lote = $11 AND e.prospeccao_status = 'em_conversa' AND e.ja_cliente = false
      AND e.omie_codigo_cliente IS NULL AND (e.rfb_situacao IS NULL OR e.rfb_situacao = '02')
      AND e.cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$' AND e.score >= $12$w$);
  ELSE
    IF p_status IS NOT NULL THEN
      v_w := array_append(v_w, $w$e.prospeccao_status = $7$w$);
    ELSE
      v_w := array_append(v_w, $w$e.prospeccao_status <> 'descartado'$w$);
    END IF;
    IF NOT COALESCE(p_incluir_ja_clientes, false) THEN
      v_w := array_append(v_w, $w$e.ja_cliente = false$w$);
    END IF;
    IF p_ultimo_lote IS NOT NULL THEN
      v_w := array_append(v_w, $w$e.ultimo_lote = $9$w$);
    END IF;
  END IF;
  IF p_primeira_vista_min IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.primeira_vista_em >= $10$w$);
  END IF;
  IF COALESCE(p_com_telefone, false) THEN
    v_w := array_append(v_w, $w$(e.telefone1 IS NOT NULL OR e.telefone2 IS NOT NULL)$w$);
  END IF;
  IF COALESCE(p_com_contato, false) THEN
    v_w := array_append(v_w, $w$(e.telefone1 IS NOT NULL OR e.telefone2 IS NOT NULL OR e.email IS NOT NULL)$w$);
  END IF;
  IF p_data_abertura_min IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.data_abertura >= $15$w$);
  END IF;
  IF p_data_abertura_max IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.data_abertura <= $16$w$);
  END IF;

  RETURN QUERY EXECUTE format(
    $q$SELECT e.* FROM public.radar_empresas e WHERE %s ORDER BY e.%I DESC NULLS LAST, e.cnpj LIMIT $17 OFFSET $18$q$,
    array_to_string(v_w, ' AND '), p_ordem)
  USING p_busca, p_municipio, p_uf, p_ufs, p_cnae_exato, p_cnae_prefixo, p_status, p_incluir_ja_clientes,
        p_ultimo_lote, p_primeira_vista_min, p_sugeridos_lote, p_sugeridos_score_min, p_com_telefone,
        p_com_contato, p_data_abertura_min, p_data_abertura_max, p_limit, p_offset, p_cnae_secundario, p_municipio_codigo;
END
$function$;

REVOKE ALL ON FUNCTION public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text,boolean,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text,boolean,boolean) TO authenticated, service_role;


-- ── E-mail semanal: o lead só com contato de contabilidade vai como VISITAR, com o endereço ─────────────────
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
  v_visitar     integer;
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

      -- A elegibilidade é a do pacote E (sem mudança); o contato de contabilidade só MARCA o lead como "visitar".
      SELECT COALESCE(jsonb_agg(to_jsonb(x) || jsonb_build_object('visitar', COALESCE(ct.visitar, false), 'endereco', ct.endereco)
                                ORDER BY x.posicao), '[]'::jsonb), count(*), max(x.elegiveis),
             count(*) FILTER (WHERE x.atribuido), count(*) FILTER (WHERE ct.visitar)
        INTO v_leads, v_qtd, v_elegiveis, v_atrib, v_visitar
        FROM private.radar_leads_do_vendedor(r.vendedor, c_n, p_agora) x
        LEFT JOIN LATERAL private.radar_contato_do_lead(x.cnpj) ct ON true;

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
                                                      score_motivos text[], elegiveis integer, atribuido boolean,
                                                      visitar boolean, endereco text)
         ORDER BY x.posicao
      LOOP
        v_lista := v_lista
          || l.posicao || '. ' || COALESCE(NULLIF(btrim(l.nome_fantasia), ''), l.razao_social, l.cnpj)
          || CASE WHEN NULLIF(btrim(l.nome_fantasia), '') IS NOT NULL AND l.razao_social IS NOT NULL
                  THEN ' (' || l.razao_social || ')' ELSE '' END || E'\n'
          || '   ' || COALESCE(l.municipio_nome, '?') || '/' || COALESCE(l.uf, '?') || ' · score ' || l.score
          || CASE WHEN l.atribuido THEN ' · passada a você pelo gestor' ELSE '' END
          || COALESCE(' · ' || NULLIF(array_to_string(l.score_motivos[1:2], '; '), ''), '') || E'\n'
          -- Sem telefone a prometer: o contato que a Receita tem é, provavelmente, da contabilidade.
          || CASE WHEN l.visitar THEN '   VISITAR: o telefone e o e-mail da Receita parecem ser da contabilidade da empresa. Vá ao endereço: '
                                      || COALESCE(l.endereco, 'veja na ficha') || E'\n'
                  ELSE '' END
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
        || CASE WHEN v_visitar = v_qtd
                THEN 'O link abre a ficha no Radar, com o endereço, sócios e o botão para registrar o contato. Nestas empresas '
                     || 'o telefone e o e-mail que a Receita tem parecem ser da contabilidade: vá direto ao endereço em vez de ligar.'
                WHEN v_visitar > 0
                THEN 'O link abre a ficha no Radar, com o telefone ou e-mail da empresa, sócios e o botão para registrar o contato. '
                     || 'Nas marcadas VISITAR, o telefone e o e-mail que a Receita tem parecem ser da contabilidade: vá direto ao endereço.'
                ELSE 'O link abre a ficha no Radar, com o telefone ou e-mail da empresa, sócios e o botão para registrar o contato.' END
        || E'\n\n'
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

      INSERT INTO public.radar_email_vendedor_leads (envio_id, posicao, cnpj, score, municipio_codigo, atribuido, visitar)
        SELECT v_envio, x.posicao, x.cnpj, x.score, x.municipio_codigo, x.atribuido, x.visitar
          FROM jsonb_to_recordset(v_leads) AS x(posicao smallint, cnpj text, score smallint, municipio_codigo text,
                                                atribuido boolean, visitar boolean);

      v_avisados := v_avisados || jsonb_build_object('vendedor', r.vendedor, 'envio_id', v_envio, 'alerta_id', v_alerta,
                                                     'n_leads', v_qtd, 'elegiveis', v_elegiveis, 'atribuidos', v_atrib,
                                                     'visitar', v_visitar,
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


-- ── Card "Prospectar hoje": mesma marca ──────────────────────────────────────────────────────────────────
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
                                               'elegiveis', x.elegiveis, 'atribuido', x.atribuido,
                                               -- "visitar": todo contato com indício de contabilidade → o card não oferece ligar.
                                               'visitar', COALESCE(ct.visitar, false), 'endereco', ct.endereco)
                            ORDER BY x.posicao), '[]'::jsonb)
    INTO v_leads
    FROM private.radar_leads_do_vendedor(v_alvo, v_n, now()) x
    LEFT JOIN LATERAL private.radar_contato_do_lead(x.cnpj) ct ON true;

  RETURN jsonb_build_object('territorio', v_terr, 'territorio_motivo', v_motivo, 'leads', v_leads);
END
$fn$;
REVOKE ALL ON FUNCTION public.radar_prospectar_hoje(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_prospectar_hoje(uuid, integer) TO authenticated;


-- ── Cron diário (UTC): depois do score (06:30) e do agregado (06:35); o gate pula quando nada mudou ─────────
DO $cron$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'radar-contato-contabil-diario') THEN
    PERFORM cron.schedule('radar-contato-contabil-diario', '50 6 * * *',
      $$SET statement_timeout = '15min'; SELECT public.radar_contato_contabil_recalcular();$$);
  END IF;
END
$cron$;

-- ── Primeiro cálculo, já dentro deste apply: a ficha não passa um dia dizendo "não sei" ─────────────────────
SELECT public.radar_contato_contabil_recalcular(true);

-- ── Postcondição ─────────────────────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  f text;
  t text;
  v_lista oid := to_regprocedure('public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text,boolean,boolean)');
BEGIN
  -- P1: as funções vivas recriadas são ESTE arquivo (md5 exato do prosrc), e radar_lista tem uma sobrecarga só.
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_lista) IS DISTINCT FROM 'a750e9ad598fb6977e2a870b0ce1ba2c' THEN
    RAISE EXCEPTION 'P1 FALHOU: a radar_lista viva não é o corpo deste arquivo';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'radar_lista') <> 1 THEN
    RAISE EXCEPTION 'P1 FALHOU: sobrou sobrecarga de radar_lista';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = 'public.radar_avisar_vendedores(timestamptz)'::regprocedure)
     IS DISTINCT FROM '6c5c9fd0423301f9e835008cb621019f' THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_avisar_vendedores vivo não é o corpo deste arquivo';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = 'public.radar_prospectar_hoje(uuid,integer)'::regprocedure)
     IS DISTINCT FROM 'd35f8f19e9b3612de3454c306f77a52d' THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_prospectar_hoje vivo não é o corpo deste arquivo';
  END IF;

  -- P2: tabelas novas com RLS e sem privilégio para anon/authenticated (só o servidor lê e escreve).
  FOREACH t IN ARRAY ARRAY['public.radar_contato_contabil', 'public.radar_contato_contabil_estado',
                           'public.radar_contato_contabil_correcoes'] LOOP
    IF NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class c WHERE c.oid = t::regclass) THEN
      RAISE EXCEPTION 'P2 FALHOU: % sem RLS', t;
    END IF;
    IF has_table_privilege('anon', t, 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('authenticated', t, 'SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'P2 FALHOU: % acessível direto por anon/authenticated', t;
    END IF;
  END LOOP;

  -- P3: internas e o escritor fechados nas duas pontas (PUBLIC e anon) e para authenticated.
  FOREACH f IN ARRAY ARRAY['private.radar_tel_valor(text)', 'private.radar_email_valor(text)',
                           'private.radar_email_motivos_proprios(text)',
                           'private.radar_contato_contabil_avaliar(text,text,text,text)',
                           'private.radar_contato_visitar(text,text,text,text,text)',
                           'private.radar_contato_do_lead(text)',
                           'public.radar_contato_contabil_recalcular(boolean)',
                           'public.radar_avisar_vendedores(timestamptz)'] LOOP
    IF has_function_privilege('public', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE')
       OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'P3 FALHOU: % executável por PUBLIC/anon/authenticated', f;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.radar_contato_contabil_recalcular(boolean)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.radar_avisar_vendedores(timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P3 FALHOU: service_role (cron) sem EXECUTE no recálculo ou no e-mail semanal';
  END IF;

  -- P4: RPCs do front só para authenticated; as LEITURAS seguem STABLE (allowlist da lente), a correção é VOLATILE.
  FOREACH f IN ARRAY ARRAY['public.radar_contato_contabil_da_empresa(text)', 'public.radar_prospectar_hoje(uuid,integer)',
                           'public.radar_contato_contabil_corrigir(text,text,boolean,bigint)'] LOOP
    IF has_function_privilege('public', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'P4 FALHOU: ACL de % errada (quer authenticated sim, PUBLIC/anon não)', f;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', v_lista, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = v_lista AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_lista, 'EXECUTE') THEN
    RAISE EXCEPTION 'P4 FALHOU: ACL da radar_lista errada (anon/PUBLIC executam, ou authenticated não)';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.radar_contato_contabil_da_empresa(text)'::regprocedure) <> 's'
     OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.radar_prospectar_hoje(uuid,integer)'::regprocedure) <> 's'
     OR (SELECT provolatile FROM pg_proc WHERE oid = v_lista) <> 's' THEN
    RAISE EXCEPTION 'P4 FALHOU: leitura deixou de ser STABLE — sai da allowlist de leitura da lente';
  END IF;

  -- P5: o escritor rodou neste apply (estado gravado) e o cron existe.
  IF NOT EXISTS (SELECT 1 FROM public.radar_contato_contabil_estado WHERE id AND versao_regra = 1) THEN
    RAISE EXCEPTION 'P5 FALHOU: radar_contato_contabil_recalcular não gravou o estado — a ficha diria "não sei" para todos';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'radar-contato-contabil-diario') THEN
    RAISE EXCEPTION 'P5 FALHOU: cron radar-contato-contabil-diario ausente';
  END IF;
END
$post$;
