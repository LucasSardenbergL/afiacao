-- ============================================================
-- Radar, pacote J (privacidade/LGPD): o CPF do titular de MEI deixa de sair para o app; a exclusão de titular
-- resiste à recarga; as notas livres de leads descartados há mais de 12 meses são expurgadas.
--
-- O PROBLEMA (medido em prod, 2026-11-08): a razão social de MEI termina no CPF do titular
-- ('FULANO DE TAL 12345678901'): 122.077 linhas de radar_empresas. A razão crua saía inteira na ficha, na lista
-- (radar_lista devolve SETOF radar_empresas), no "prospectar hoje", na rota, no e-mail ao vendedor/gestor, na
-- descrição da tarefa, no CSV e no PostgREST direto (select('*') de 3 hooks). Só 2 funções precisam do CPF, e só
-- da MÁSCARA dele (dígitos 4 a 9, o formato que a RFB publica no QSA): private.radar_vinculos_base e
-- private.radar_mascaras_conflitam (+ 2 índices de expressão). O CPF completo nunca é comparado.
--
-- O QUE MUDA:
--   1. A razão de MEI passa a ser GRAVADA mascarada: 'FULANO DE TAL ***456789**'. Um trigger BEFORE em
--      radar_empresas (private.radar_empresas_privacidade) reescreve na entrada — a carga, a publicação e qualquer
--      escritor futuro — e guarda o valor da Receita em private.radar_razao_receita, que só o cadastro no Omie lê
--      (RPC radar_razao_social_para_cadastro: a razão fiscal do MEI tem o CPF). Assim TODA saída (RPC de hoje e de
--      amanhã, PostgREST, e-mail, tarefa, CSV) já nasce sem o CPF, sem recriar nenhuma RPC de leitura. Contagem da
--      publicação (ROW_COUNT, RCARGA_*) não muda: o trigger altera o VALOR, nunca descarta linha.
--   2. As 2 funções de vínculo e os 2 índices aceitam AS DUAS formas (crua e mascarada) por substituição textual
--      mínima do corpo de prod (md5 conferido): regex ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$' e a máscara por
--      private.radar_titular_mascara. Mesma máscara ⇒ mesmas decisões de vínculo e de aviso de crédito, antes,
--      durante e depois do backfill (prova db/test-radar-privacidade-j.sh, E*).
--   3. Exclusão persistente de titular: public.radar_exclusoes_titular (raiz, escopo, finalidade). Aplicada na
--      INGESTÃO (o mesmo trigger zera sócios/contato da raiz a cada carga), nas LEITURAS (o vínculo ignora o QSA da
--      raiz) e por expurgo (as linhas de radar_socios da raiz são apagadas). Escopos: 'qsa' (sócio/titular fora do
--      vínculo e da ficha) e 'contato' (além disso, oposição à prospecção: contato zerado e lead descartado).
--   4. Expurgo de retenção (cron radar-privacidade-expurgo, de hora em hora): nota livre de lead descartado há
--      > 12 meses vira NULL (o evento fica, o texto sai); a nota automática da RFB fica. O mesmo job termina o
--      backfill da máscara em fatias de 10 mil (FOR UPDATE SKIP LOCKED) e reaplica as exclusões.
--
-- LGPD: base legal e prazos em docs/historico/radar-privacidade-pacote-j-2026-11-09.md.
-- ⚠️ ORDEM DE DEPLOY: Publish do front ANTES (o cadastro no Omie passa a buscar a razão fiscal pela RPC nova; aba
--    velha cadastraria MEI com a razão mascarada). Depois esta migration; o backfill corre sozinho pelo cron.
-- Corpos de prod lidos em 2026-11-08 (psql-ro), iguais aos da 20261107040000: base 568af84d…, conflitam b2c9922a….
-- Molde TRAVA → PRE → CREATE → PÓS. Prova PG17: db/test-radar-privacidade-j.sh (e --falsificar).
-- Aplicação: `bun run db:aplicar supabase/migrations/20261111130000_radar_privacidade_titular_mei.sql`
-- (sem BEGIN/COMMIT: o executor fornece a transação).
-- ============================================================

SET LOCAL lock_timeout = '15s';

DO $trava$
BEGIN
  ALTER FUNCTION private.radar_vinculos_base(text[], boolean, boolean) STABLE;
  ALTER FUNCTION private.radar_mascaras_conflitam(text, text, text) STABLE;
END
$trava$;

DO $pre$
DECLARE
  v_bs text := (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('private.radar_vinculos_base(text[],boolean,boolean)'));
  v_mc text := (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('private.radar_mascaras_conflitam(text,text,text)'));
BEGIN
  IF v_bs IS NULL OR v_bs NOT IN ('568af84dec25450e8970bd3d6918e4bb', 'b57e91ea6d82e81ce4c517edac0697c6') THEN
    RAISE EXCEPTION 'PRE FALHOU: private.radar_vinculos_base vivo (md5 %) não é o da 20261107040000 nem este — outra sessão mexeu nas regras; reconcilie antes', v_bs;
  END IF;
  IF v_mc IS NULL OR v_mc NOT IN ('b2c9922a1d5d0fb767e9050c872822cf', '9989b503992ae3afc8ef7a4c1af3cb4b') THEN
    RAISE EXCEPTION 'PRE FALHOU: private.radar_mascaras_conflitam vivo (md5 %) não é o da 20261107040000 nem este', v_mc;
  END IF;
  IF to_regclass('public.radar_empresas') IS NULL OR to_regclass('public.radar_contatos') IS NULL
     OR to_regclass('public.radar_socios') IS NULL OR to_regclass('public.acoes_execucoes') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: tabela do Radar ausente (radar_empresas/radar_contatos/radar_socios/acoes_execucoes)';
  END IF;
END
$pre$;

-- ------------------------------------------------------------
-- 1. Exclusão de titular (registro do Encarregado) e o insumo restrito da razão fiscal
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.radar_exclusoes_titular (
  raiz           text PRIMARY KEY CHECK (raiz ~ '^[0-9A-Z]{8}$'),
  escopo         text NOT NULL CHECK (escopo IN ('qsa', 'contato')),
  finalidade     text NOT NULL CHECK (length(btrim(finalidade)) BETWEEN 10 AND 500),
  protocolo      text CHECK (protocolo IS NULL OR length(protocolo) <= 120),
  registrado_por uuid,
  registrado_em  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.radar_exclusoes_titular ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.radar_exclusoes_titular FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.radar_exclusoes_titular IS
  'LGPD art. 18: raízes de CNPJ cujo titular/sócio pediu oposição ou eliminação. Só servidor (RLS sem policy). escopo qsa = QSA e titular fora do vínculo e da ficha; contato = além disso, fora da prospecção. Aplicada na ingestão (trigger em radar_empresas), nas leituras (vínculo) e pelo expurgo. Registrar por radar_exclusao_registrar. Ver docs/historico/radar-privacidade-pacote-j-2026-11-09.md.';

-- Razão social da Receita (com o CPF) de quem é MEI. Finalidade ÚNICA: o cadastro do cliente no Omie (a razão fiscal
-- do MEI tem o CPF). Schema private: nenhum JWT lê. FK diferida: o trigger BEFORE INSERT grava antes de a linha-mãe
-- existir; a checagem é no COMMIT.
CREATE TABLE IF NOT EXISTS private.radar_razao_receita (
  cnpj          text PRIMARY KEY REFERENCES public.radar_empresas (cnpj) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  razao_social  text NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE private.radar_razao_receita FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE private.radar_razao_receita IS
  'Razão social da RFB (com CPF) dos MEI do Radar. Só para o cadastro no Omie (radar_razao_social_para_cadastro). radar_empresas guarda a forma mascarada. Apaga junto com a empresa e na exclusão de titular.';

-- ------------------------------------------------------------
-- 2. Helpers (sem acesso de JWT, salvo o de exibição, que é puro)
-- ------------------------------------------------------------
-- 'FULANO 12345678901' → 'FULANO ***456789**' (dígitos 4 a 9, como a RFB publica o QSA). Outras formas: intactas.
CREATE OR REPLACE FUNCTION private.radar_razao_mascarada(p text)
 RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $f$
  SELECT regexp_replace(p, ' [0-9]{3}([0-9]{6})[0-9]{2}$', ' ***\1**')
$f$;
-- Máscara do titular a partir do sufixo capturado da razão, cru ou já mascarado. NULL quando não é nenhum dos dois.
CREATE OR REPLACE FUNCTION private.radar_titular_mascara(p text)
 RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $f$
  SELECT CASE WHEN p ~ '^[0-9]{11}$' THEN '***' || substr(p, 4, 6) || '**'
              WHEN p ~ '^\*\*\*[0-9]{6}\*\*$' THEN p END
$f$;
REVOKE ALL ON FUNCTION private.radar_razao_mascarada(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.radar_titular_mascara(text) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. O trigger de entrada: máscara + exclusão, para QUALQUER escritor de radar_empresas
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.radar_empresas_privacidade()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $f$
DECLARE
  v_escopo text;
BEGIN
  SELECT x.escopo INTO v_escopo FROM public.radar_exclusoes_titular x WHERE x.raiz = left(NEW.cnpj, 8);
  IF v_escopo IS NOT NULL THEN
    -- Titular excluído: nada dele fica — nem o cru, nem a máscara na razão (sem o sufixo, o vínculo não o usa).
    DELETE FROM private.radar_razao_receita WHERE cnpj = NEW.cnpj;
    NEW.razao_social := btrim(regexp_replace(NEW.razao_social, ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$', ''));
    NEW.socios_nomes := NULL;
    IF v_escopo = 'contato' THEN
      NEW.email := NULL; NEW.telefone1 := NULL; NEW.telefone2 := NULL;
      IF NEW.prospeccao_status IS DISTINCT FROM 'virou_cliente' THEN
        NEW.prospeccao_status := 'descartado';
        NEW.descarte_motivo := 'lgpd_oposicao';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.razao_social ~ ' [0-9]{11}$' THEN
    INSERT INTO private.radar_razao_receita AS r (cnpj, razao_social) VALUES (NEW.cnpj, NEW.razao_social)
    ON CONFLICT (cnpj) DO UPDATE SET razao_social = EXCLUDED.razao_social, atualizado_em = now()
      WHERE r.razao_social IS DISTINCT FROM EXCLUDED.razao_social;
    NEW.razao_social := private.radar_razao_mascarada(NEW.razao_social);
  END IF;
  RETURN NEW;
END
$f$;
REVOKE ALL ON FUNCTION private.radar_empresas_privacidade() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_radar_privacidade ON public.radar_empresas;
-- Nome < 'trg_radar_status_guard_*': roda ANTES da guarda de status (que vê o 'descartado' do escopo contato).
CREATE TRIGGER trg_radar_privacidade
  BEFORE INSERT OR UPDATE OF razao_social, socios_nomes, email, telefone1, telefone2 ON public.radar_empresas
  FOR EACH ROW EXECUTE FUNCTION private.radar_empresas_privacidade();

-- Fila do backfill: só as razões ainda cruas (depois do backfill, fica vazia — o trigger não deixa entrar nova).
CREATE INDEX IF NOT EXISTS idx_radar_empresas_razao_crua ON public.radar_empresas (cnpj)
  WHERE razao_social ~ ' [0-9]{11}$';

-- ------------------------------------------------------------
-- 4. As regras de vínculo aceitam as duas formas (substituição textual do corpo de prod) + ignoram o QSA excluído
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.radar_mascaras_conflitam(p_raiz_a text, p_raiz_b text, p_nome text)
 RETURNS boolean LANGUAGE sql STABLE
 SET search_path TO 'public', 'pg_temp'
AS $f$
  WITH vig AS (SELECT sl.lote FROM public.radar_socios_lote sl WHERE sl.status = 'vigente'),
  m AS (
    SELECT s.raiz, s.cpf_mascarado AS mask
      FROM public.radar_socios s
     WHERE s.lote = (SELECT v.lote FROM vig v) AND s.raiz IN (p_raiz_a, p_raiz_b)
       AND s.nome_normalizado = private.radar_nome_norm(p_nome)
    UNION
    SELECT left(e.cnpj, 8), private.radar_titular_mascara(substring(e.razao_social FROM ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$'))
      FROM public.radar_empresas e
     WHERE left(e.cnpj, 8) IN (p_raiz_a, p_raiz_b) AND e.razao_social ~ ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$'
       AND private.radar_nome_norm(regexp_replace(e.razao_social, ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$', '')) = private.radar_nome_norm(p_nome)
  )
  SELECT EXISTS (SELECT 1 FROM vig)
     AND EXISTS (SELECT 1 FROM m WHERE m.raiz = p_raiz_a)
     AND EXISTS (SELECT 1 FROM m WHERE m.raiz = p_raiz_b)
     AND NOT EXISTS (SELECT 1 FROM m a JOIN m b ON b.mask = a.mask WHERE a.raiz = p_raiz_a AND b.raiz = p_raiz_b)
$f$;
CREATE OR REPLACE FUNCTION private.radar_vinculos_base(p_cnpjs text[], p_carteira boolean, p_incluir_clientes boolean)
 RETURNS TABLE(lead_cnpj text, ordem integer, cliente_cnpj text, cliente_nome text, cliente_situacao text,
               forca text, sinais text[])
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH
  regra AS (
    SELECT '@[^@]*(cont|assessor|escritorio|fiscal|mei|partner)'::text AS cont
  ),
  lead AS (
    SELECT e.cnpj, e.telefone1, e.telefone2, e.email, e.cep, e.logradouro, e.numero, e.complemento,
           e.socios_nomes, e.razao_social, e.municipio_codigo
      FROM public.radar_empresas e
     WHERE e.cnpj = ANY (p_cnpjs) AND (p_incluir_clientes OR e.ja_cliente IS NOT TRUE)
  ),
  perfil AS (
    SELECT x.doc, x.nome, private.radar_tel_chave(x.phone) AS tel_k,
           CASE WHEN x.email LIKE '%@%' THEN lower(btrim(x.email)) END AS email_k, x.user_id
      FROM (SELECT regexp_replace(upper(btrim(p.document)), '[^0-9A-Z]', '', 'g') AS doc,
                   COALESCE(NULLIF(btrim(p.razao_social), ''), NULLIF(btrim(p.name), '')) AS nome,
                   p.phone, p.email, p.user_id
              FROM public.profiles p WHERE p.document IS NOT NULL) x
     WHERE x.doc ~ '^[0-9A-Z]{12}[0-9]{2}$'
  ),
  lead_tel AS (
    SELECT DISTINCT l.cnpj AS lead, v.k
      FROM lead l
     CROSS JOIN LATERAL (VALUES (private.radar_tel_chave(l.telefone1)), (private.radar_tel_chave(l.telefone2))) v(k)
     WHERE v.k IS NOT NULL
  ),
  tel_hits AS (
    SELECT t.lead, e.cnpj AS doc, e.ja_cliente AS cliente, t.k FROM lead_tel t JOIN public.radar_empresas e ON e.telefone1 = t.k
    UNION
    SELECT t.lead, e.cnpj, e.ja_cliente, t.k FROM lead_tel t JOIN public.radar_empresas e ON e.telefone2 = t.k
    UNION
    SELECT t.lead, pf.doc, true, t.k FROM lead_tel t JOIN perfil pf ON pf.tel_k = t.k
  ),
  email_hits AS (
    SELECT l.cnpj AS lead, e.cnpj AS doc, e.ja_cliente AS cliente
      FROM lead l JOIN public.radar_empresas e
        ON e.email IS NOT NULL AND lower(btrim(e.email)) = lower(btrim(l.email))
     WHERE l.email LIKE '%@%'
    UNION
    SELECT l.cnpj, pf.doc, true
      FROM lead l JOIN perfil pf ON pf.email_k = lower(btrim(l.email))
     WHERE l.email LIKE '%@%'
  ),
  lead_end AS (
    SELECT l.cnpj AS lead, l.cep, private.radar_chave_endereco(l.logradouro, l.numero, l.complemento) AS k
      FROM lead l
  ),
  end_hits AS (
    SELECT le.lead, e.cnpj AS doc, e.ja_cliente AS cliente
      FROM lead_end le JOIN public.radar_empresas e ON e.cep = le.cep
     WHERE le.k IS NOT NULL AND le.cep ~ '^[0-9]{8}$'
       AND private.radar_chave_endereco(e.logradouro, e.numero, e.complemento) = le.k
    UNION
    SELECT le.lead, pf.doc, true
      FROM lead_end le
      JOIN public.addresses a ON regexp_replace(coalesce(a.zip_code, ''), '[^0-9]', '', 'g') = le.cep
      JOIN perfil pf ON pf.user_id = a.user_id
     WHERE le.k IS NOT NULL AND le.cep ~ '^[0-9]{8}$'
       AND private.radar_chave_endereco(a.street, a.number, a.complement) = le.k
  ),
  lead_pes AS (
    SELECT DISTINCT x.lead, x.n FROM (
      SELECT l.cnpj AS lead, unnest(string_to_array(l.socios_nomes, '; ')) AS n FROM lead l
      UNION ALL
      SELECT l.cnpj, btrim(regexp_replace(regexp_replace(l.razao_social, '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} ', ''), ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$', ''))
        FROM lead l
       WHERE l.razao_social ~ ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$' OR l.razao_social ~ '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} '
    ) x
     WHERE x.n ~ '^[A-Z]+( [A-Z]+){2,}$'
  ),
  pes_hits AS (
    SELECT l.lead, e.cnpj AS doc, e.ja_cliente AS cliente, e.municipio_codigo AS mun, l.n
      FROM lead_pes l JOIN public.radar_empresas e
        ON e.socios_nomes IS NOT NULL AND string_to_array(e.socios_nomes, '; ') @> ARRAY[l.n]
    UNION
    SELECT l.lead, e.cnpj, e.ja_cliente, e.municipio_codigo, l.n
      FROM lead_pes l JOIN public.radar_empresas e
        ON (e.razao_social ~ ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$' OR e.razao_social ~ '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} ')
       AND btrim(regexp_replace(regexp_replace(e.razao_social, '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} ', ''), ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$', '')) = l.n
  ),
  -- ── Sinal 'socio_cpf' (20261107040000): MESMA PESSOA por nome normalizado + CPF MASCARADO da Receita, sem exigir
  --    município, cliente dentro OU fora do recorte. Sem lote vigente de radar_socios, nada daqui contribui.
  vig AS (
    SELECT sl.lote FROM public.radar_socios_lote sl WHERE sl.status = 'vigente'
  ),
  -- Chaves do SUJEITO: QSA (PF com máscara) da raiz + titular de MEI (CPF na razão → dígitos 4 a 9).
  lead_cpf AS (
    SELECT DISTINCT l.cnpj AS lead, s.nome_normalizado AS nome, s.cpf_mascarado AS mask
      FROM lead l JOIN public.radar_socios s ON s.lote = (SELECT v.lote FROM vig v) AND s.raiz = left(l.cnpj, 8)
    UNION
    SELECT l.cnpj, private.radar_nome_norm(regexp_replace(l.razao_social, ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$', '')),
           private.radar_titular_mascara(substring(l.razao_social FROM ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$'))
      FROM lead l
     WHERE l.razao_social ~ ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$' AND EXISTS (SELECT 1 FROM vig)
  ),
  chave AS (
    SELECT DISTINCT lc.nome, lc.mask FROM lead_cpf lc WHERE lc.nome LIKE '% %' AND lc.mask IS NOT NULL
  ),
  -- TODAS as raízes do universo (Radar ∪ clientes) com a chave, independente de p_cnpjs (ficha e lista concordam).
  -- qualif/n_pais NULL = titular de MEI (sem linha de QSA): é dono, e não traz contagem nacional.
  ocorr AS (
    SELECT c.nome, c.mask, s.raiz, s.qualificacao AS qualif, s.n_raizes_pais AS n_pais
      FROM chave c JOIN public.radar_socios s
        ON s.lote = (SELECT v.lote FROM vig v) AND s.nome_normalizado = c.nome AND s.cpf_mascarado = c.mask
       AND NOT EXISTS (SELECT 1 FROM public.radar_exclusoes_titular xt WHERE xt.raiz = s.raiz)
    UNION ALL
    SELECT c.nome, c.mask, left(e.cnpj, 8), NULL::text, NULL::integer
      -- Nome do titular NORMALIZADO como a chave (achado Codex P1: o nome cru deixava 'JOÃO' fora da contagem de
      -- exclusividade). A expressão é a de private.radar_nome_norm só com funções nativas: é a do índice parcial
      -- idx_radar_empresas_titular_mei_norm (função própria em índice exigiria EXECUTE de quem grava).
      FROM chave c JOIN public.radar_empresas e
        ON e.razao_social ~ ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$'
       AND btrim(regexp_replace(upper(translate(regexp_replace(e.razao_social, ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$', ''), 'áàâãäåéèêëíìîïóòôõöúùûüçñýÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑÝ', 'aaaaaaeeeeiiiiooooouuuucnyAAAAAAEEEEIIIIOOOOOUUUUCNY')), '\s+', ' ', 'g')) = c.nome
     WHERE private.radar_titular_mascara(substring(e.razao_social FROM ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$')) = c.mask
    UNION ALL
    SELECT c.nome, c.mask, left(pf.doc, 8), NULL::text, NULL::integer
      FROM chave c JOIN perfil pf
        ON pf.nome ~ ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$'
       AND private.radar_nome_norm(regexp_replace(pf.nome, ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$', '')) = c.nome
       AND private.radar_titular_mascara(substring(pf.nome FROM ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$')) = c.mask
  ),
  -- Exclusiva: ≤2 raízes no universo (o sujeito incluído) E ≤3 empresas no QSA do PAÍS (diretor/conselheiro de S.A.
  -- grande e síndico caem aqui — medido em 2026-11-06).
  chave_ok AS (
    SELECT o.nome, o.mask FROM ocorr o GROUP BY o.nome, o.mask
    HAVING count(DISTINCT o.raiz) <= 2 AND coalesce(max(o.n_pais), 0) <= 3
  ),
  -- Dono = TODAS as linhas da chave naquela raiz com qualificação de dono (05 administrador, 22 sócio,
  -- 49 sócio-administrador, 65 titular PF) — qualificação mista (ex.: também diretor) não conta.
  dono AS (
    SELECT o.nome, o.mask, o.raiz, bool_and(o.qualif IS NULL OR o.qualif IN ('05', '22', '49', '65')) AS dono
      FROM ocorr o GROUP BY o.nome, o.mask, o.raiz
  ),
  cpf_hits AS (
    SELECT DISTINCT lc.lead, d.doc
      FROM lead_cpf lc
      JOIN chave_ok k ON k.nome = lc.nome AND k.mask = lc.mask
      JOIN dono dl ON dl.nome = lc.nome AND dl.mask = lc.mask AND dl.raiz = left(lc.lead, 8) AND dl.dono
      JOIN dono dc ON dc.nome = lc.nome AND dc.mask = lc.mask AND dc.raiz <> left(lc.lead, 8) AND dc.dono
     CROSS JOIN LATERAL (
       SELECT e.cnpj AS doc FROM public.radar_empresas e WHERE left(e.cnpj, 8) = dc.raiz AND e.ja_cliente
       UNION
       SELECT pf.doc FROM perfil pf WHERE left(pf.doc, 8) = dc.raiz
     ) d
  ),
  sinal AS (
    SELECT h.lead, h.doc, 'telefone'::text AS s FROM tel_hits h
     WHERE h.cliente
       AND (h.lead, h.k) IN (SELECT lead, k FROM tel_hits GROUP BY lead, k HAVING count(DISTINCT left(doc, 8)) <= 2)
    UNION
    SELECT h.lead, h.doc, 'email' FROM email_hits h
     WHERE h.cliente
       AND h.lead IN (SELECT lead FROM email_hits GROUP BY lead HAVING count(DISTINCT left(doc, 8)) <= 2)
    UNION
    SELECT h.lead, h.doc, 'endereco' FROM end_hits h
     WHERE h.cliente
       AND h.lead IN (SELECT lead FROM end_hits GROUP BY lead HAVING count(DISTINCT left(doc, 8)) <= 2)
    UNION
    SELECT h.lead, h.doc, 'pessoa' FROM pes_hits h JOIN lead l ON l.cnpj = h.lead
     WHERE h.cliente AND h.mun = l.municipio_codigo
       AND (h.lead, h.n) IN (SELECT lead, n FROM pes_hits GROUP BY lead, n HAVING count(DISTINCT left(doc, 8)) <= 2)
       AND NOT private.radar_mascaras_conflitam(left(h.lead, 8), left(h.doc, 8), h.n)
    UNION
    SELECT h.lead, h.doc, 'socio_cpf' FROM cpf_hits h
  ),
  cliente AS (
    SELECT s.lead, s.doc,
           r.razao_social AS nome_radar,
           (SELECT pf.nome FROM perfil pf WHERE pf.doc = s.doc AND pf.nome IS NOT NULL ORDER BY pf.nome LIMIT 1) AS nome_perfil,
           COALESCE((SELECT sc.situacao FROM public.radar_situacao_cadastral sc
                      WHERE sc.cnpj = s.doc ORDER BY sc.lote DESC LIMIT 1), r.rfb_situacao) AS situacao,
           (l.email ~* g.cont
            OR coalesce(r.email, '') ~* g.cont
            OR EXISTS (SELECT 1 FROM perfil pf WHERE pf.doc = s.doc AND coalesce(pf.email_k, '') ~* g.cont)) AS contador,
           array_agg(DISTINCT s.s ORDER BY s.s) AS todos
      FROM sinal s
      JOIN lead l ON l.cnpj = s.lead
     CROSS JOIN regra g
      LEFT JOIN public.radar_empresas r ON r.cnpj = s.doc AND r.ja_cliente
     WHERE left(s.doc, 8) <> left(s.lead, 8)
     GROUP BY s.lead, s.doc, l.email, g.cont, r.razao_social, r.rfb_situacao, r.email
  ),
  validos AS (
    SELECT c.lead, c.doc, c.nome_radar, c.nome_perfil, c.situacao,
           CASE WHEN c.contador THEN ARRAY(SELECT u FROM unnest(c.todos) u WHERE u NOT IN ('telefone', 'email') ORDER BY u)
                ELSE c.todos END AS s
      FROM cliente c
     WHERE c.nome_radar IS NOT NULL OR p_carteira
  ),
  final AS (
    SELECT v.lead, v.doc,
           regexp_replace(COALESCE(v.nome_radar, v.nome_perfil), ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$', '') AS nome,  -- sem o CPF do titular de MEI, venha do Radar OU do perfil
           v.situacao,
           CASE WHEN 'pessoa' = ANY (v.s) OR 'socio_cpf' = ANY (v.s) OR cardinality(v.s) >= 2 THEN 'forte' ELSE 'media' END AS forca,
           v.s
      FROM validos v
     WHERE 'pessoa' = ANY (v.s) OR 'socio_cpf' = ANY (v.s) OR cardinality(v.s) >= 2 OR v.s = ARRAY['endereco']
  ),
  ordenado AS (
    SELECT f.*, row_number() OVER (PARTITION BY f.lead
                                   ORDER BY (CASE WHEN f.forca = 'forte' THEN 0 ELSE 1 END), cardinality(f.s) DESC, f.doc)::integer AS ordem
      FROM final f
  )
  SELECT o.lead, o.ordem, o.doc, o.nome, o.situacao, o.forca, o.s
    FROM ordenado o
$function$;

REVOKE ALL ON FUNCTION private.radar_mascaras_conflitam(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.radar_vinculos_base(text[], boolean, boolean) FROM PUBLIC, anon, authenticated;

-- Índices de expressão: os mesmos 2, com o regex das duas formas (a consulta e o índice têm de ter a MESMA
-- expressão). Constrói com nome novo (SHARE: leitura segue) e só no fim troca (ACCESS EXCLUSIVE curto).
DROP INDEX IF EXISTS public.idx_radar_empresas_titular_mei_norm_j;
DROP INDEX IF EXISTS public.idx_radar_empresas_titular_mei_j;
CREATE INDEX idx_radar_empresas_titular_mei_norm_j ON public.radar_empresas
  (btrim(regexp_replace(upper(translate(regexp_replace(razao_social, ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$', ''), 'áàâãäåéèêëíìîïóòôõöúùûüçñýÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑÝ', 'aaaaaaeeeeiiiiooooouuuucnyAAAAAAEEEEIIIIOOOOOUUUUCNY')), '\s+', ' ', 'g')))
  WHERE razao_social ~ ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$';
CREATE INDEX idx_radar_empresas_titular_mei_j ON public.radar_empresas
  (btrim(regexp_replace(regexp_replace(razao_social, '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} ', ''), ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$', '')))
  WHERE razao_social ~ ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$' OR razao_social ~ '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} ';

-- ------------------------------------------------------------
-- 5. RPCs
-- ------------------------------------------------------------
-- Razão FISCAL para o cadastro no Omie (única leitura do cru). Mesmo gate da lista. NULL = CNPJ fora do Radar.
CREATE OR REPLACE FUNCTION public.radar_razao_social_para_cadastro(p_cnpj text)
 RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $f$
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  RETURN (SELECT COALESCE(r.razao_social, e.razao_social)
            FROM public.radar_empresas e LEFT JOIN private.radar_razao_receita r ON r.cnpj = e.cnpj
           WHERE e.cnpj = p_cnpj);
END
$f$;
REVOKE ALL ON FUNCTION public.radar_razao_social_para_cadastro(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_razao_social_para_cadastro(text) TO authenticated, service_role;

-- Aplica as exclusões já registradas (uma raiz ou todas). Idempotente: re-rodar não muda nada.
CREATE OR REPLACE FUNCTION private.radar_exclusoes_aplicar(p_raiz text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $f$
DECLARE
  v_soc integer;
  v_emp integer;
  v_not integer;
BEGIN
  DELETE FROM public.radar_socios s
   USING public.radar_exclusoes_titular x
   WHERE x.raiz = s.raiz AND (p_raiz IS NULL OR x.raiz = p_raiz);
  GET DIAGNOSTICS v_soc = ROW_COUNT;
  -- Reescrever a coluna dispara o trigger de entrada, que é quem sabe o que zerar (uma só cópia da regra).
  UPDATE public.radar_empresas e SET socios_nomes = e.socios_nomes
    FROM public.radar_exclusoes_titular x
   WHERE x.raiz = left(e.cnpj, 8) AND (p_raiz IS NULL OR x.raiz = p_raiz)
     AND (e.socios_nomes IS NOT NULL OR e.razao_social ~ ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$'
          OR (x.escopo = 'contato' AND (e.email IS NOT NULL OR e.telefone1 IS NOT NULL OR e.telefone2 IS NOT NULL
                                         OR e.prospeccao_status NOT IN ('descartado', 'virou_cliente')))
          OR EXISTS (SELECT 1 FROM private.radar_razao_receita r WHERE r.cnpj = e.cnpj));
  GET DIAGNOSTICS v_emp = ROW_COUNT;
  -- Oposição ao contato: o texto livre que o vendedor escreveu sobre a pessoa sai já (o evento fica).
  UPDATE public.radar_contatos c SET nota = NULL
    FROM public.radar_exclusoes_titular x
   WHERE x.escopo = 'contato' AND x.raiz = left(c.cnpj, 8) AND (p_raiz IS NULL OR x.raiz = p_raiz)
     AND c.nota IS NOT NULL;
  GET DIAGNOSTICS v_not = ROW_COUNT;
  RETURN jsonb_build_object('socios_apagados', v_soc, 'empresas_reaplicadas', v_emp, 'notas_apagadas', v_not);
END
$f$;
REVOKE ALL ON FUNCTION private.radar_exclusoes_aplicar(text) FROM PUBLIC, anon, authenticated;

-- Registro pelo Encarregado (master ou servidor/SQL Editor). Aplica na hora; a ingestão e o expurgo mantêm.
CREATE OR REPLACE FUNCTION public.radar_exclusao_registrar(p_raiz text, p_escopo text, p_finalidade text,
                                                          p_protocolo text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $f$
DECLARE
  v_uid uuid := (SELECT auth.uid());
BEGIN
  IF v_uid IS NOT NULL AND NOT public.has_role(v_uid, 'master'::public.app_role) THEN
    RAISE EXCEPTION 'forbidden: só o master registra exclusão de titular' USING ERRCODE = '42501';
  END IF;
  IF p_raiz IS NULL OR p_raiz !~ '^[0-9A-Z]{8}$' THEN
    RAISE EXCEPTION 'raiz inválida (8 caracteres do CNPJ)' USING ERRCODE = '22023';
  END IF;
  IF p_escopo IS NULL OR p_escopo NOT IN ('qsa', 'contato') THEN
    RAISE EXCEPTION 'escopo inválido (qsa | contato)' USING ERRCODE = '22023';
  END IF;
  IF p_finalidade IS NULL OR length(btrim(p_finalidade)) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'finalidade obrigatória (10 a 500 caracteres)' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.radar_exclusoes_titular AS x (raiz, escopo, finalidade, protocolo, registrado_por)
  VALUES (p_raiz, p_escopo, btrim(p_finalidade), p_protocolo, v_uid)
  ON CONFLICT (raiz) DO UPDATE
    -- Escopo só AMPLIA (qsa → contato): um 2º pedido nunca devolve dado que o 1º tirou.
    SET escopo = CASE WHEN x.escopo = 'contato' THEN 'contato' ELSE EXCLUDED.escopo END,
        finalidade = EXCLUDED.finalidade, protocolo = COALESCE(EXCLUDED.protocolo, x.protocolo),
        registrado_por = EXCLUDED.registrado_por, registrado_em = now();
  RETURN jsonb_build_object('raiz', p_raiz,
                            'escopo', (SELECT escopo FROM public.radar_exclusoes_titular WHERE raiz = p_raiz))
         || private.radar_exclusoes_aplicar(p_raiz);
END
$f$;
REVOKE ALL ON FUNCTION public.radar_exclusao_registrar(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_exclusao_registrar(text, text, text, text) TO authenticated, service_role;

-- O job: retenção das notas + fim do backfill da máscara + reaplicação das exclusões. Entrypoint de cron.
CREATE OR REPLACE FUNCTION public.radar_privacidade_expurgo(p_lote integer DEFAULT 10000, p_meses integer DEFAULT 12)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $f$
DECLARE
  v_ini timestamptz := clock_timestamp();
  v_masc integer;
  v_notas integer;
  v_exc jsonb;
  v_res jsonb;
BEGIN
  IF p_lote IS NULL OR p_lote < 1 OR p_lote > 50000 OR p_meses IS NULL OR p_meses < 6 THEN
    RAISE EXCEPTION 'parâmetro inválido (lote 1..50000, meses ≥ 6)' USING ERRCODE = '22023';
  END IF;
  -- (a) backfill: razão ainda crua → o trigger mascara e guarda o cru. Linha em edição fica para a próxima.
  UPDATE public.radar_empresas e SET razao_social = e.razao_social
   WHERE e.cnpj IN (SELECT c.cnpj FROM public.radar_empresas c WHERE c.razao_social ~ ' [0-9]{11}$'
                     ORDER BY c.cnpj LIMIT p_lote FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS v_masc = ROW_COUNT;
  -- (b) retenção: texto livre de lead descartado há mais de p_meses. A nota automática da situação RFB fica.
  UPDATE public.radar_contatos c SET nota = NULL
    FROM public.radar_empresas e
   WHERE e.cnpj = c.cnpj AND e.prospeccao_status = 'descartado'
     AND e.prospeccao_atualizado_em < now() - make_interval(months => p_meses)
     AND c.nota IS NOT NULL
     AND c.nota !~ '^RFB: [A-Z]+ em [0-9]{2}/[0-9]{2}/[0-9]{4}';
  GET DIAGNOSTICS v_notas = ROW_COUNT;
  -- (c) exclusões: o que a carga do mês trouxe de volta sai de novo.
  v_exc := private.radar_exclusoes_aplicar(NULL);
  v_res := jsonb_build_object('razoes_mascaradas', v_masc,
                              'razoes_cruas_restantes', (SELECT count(*) FROM public.radar_empresas WHERE razao_social ~ ' [0-9]{11}$'),
                              'notas_expurgadas', v_notas) || v_exc;
  INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
  VALUES ('radar.privacidade_expurgo', 'automatica', v_ini, clock_timestamp(), 'sucesso', v_res);
  RETURN v_res;
END
$f$;
REVOKE ALL ON FUNCTION public.radar_privacidade_expurgo(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_privacidade_expurgo(integer, integer) TO service_role;

-- ------------------------------------------------------------
-- 6. Job (de hora em hora; o backfill de ~122 mil acaba em ~13 rodadas, depois é só retenção)
-- ------------------------------------------------------------
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'radar-privacidade-expurgo') THEN
    PERFORM cron.unschedule('radar-privacidade-expurgo');
  END IF;
  PERFORM cron.schedule('radar-privacidade-expurgo', '41 * * * *',
    $$SET statement_timeout = '10min'; SELECT public.radar_privacidade_expurgo();$$);
END
$cron$;

-- Troca dos índices (fim da transação: o ACCESS EXCLUSIVE dura até o COMMIT, logo a seguir).
DROP INDEX IF EXISTS public.idx_radar_empresas_titular_mei_norm;
DROP INDEX IF EXISTS public.idx_radar_empresas_titular_mei;
ALTER INDEX public.idx_radar_empresas_titular_mei_norm_j RENAME TO idx_radar_empresas_titular_mei_norm;
ALTER INDEX public.idx_radar_empresas_titular_mei_j RENAME TO idx_radar_empresas_titular_mei;

-- ------------------------------------------------------------
-- 7. Postcondição
-- ------------------------------------------------------------
DO $post$
DECLARE
  v_bs text := (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('private.radar_vinculos_base(text[],boolean,boolean)'));
  v_mc text := (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('private.radar_mascaras_conflitam(text,text,text)'));
BEGIN
  IF v_bs IS DISTINCT FROM 'b57e91ea6d82e81ce4c517edac0697c6' OR v_mc IS DISTINCT FROM '9989b503992ae3afc8ef7a4c1af3cb4b' THEN
    RAISE EXCEPTION 'P1 FALHOU: corpo das regras de vínculo não é o desta migration (base %, conflitam %)', v_bs, v_mc;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_radar_privacidade'
                    AND tgrelid = 'public.radar_empresas'::regclass AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'P2 FALHOU: trigger trg_radar_privacidade ausente/desligado — a razão de MEI seguiria crua';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relname = 'radar_exclusoes_titular' AND c.relrowsecurity)
     OR has_table_privilege('authenticated', 'public.radar_exclusoes_titular', 'SELECT')
     OR has_table_privilege('authenticated', 'private.radar_razao_receita', 'SELECT')
     OR has_table_privilege('anon', 'private.radar_razao_receita', 'SELECT') THEN
    RAISE EXCEPTION 'P3 FALHOU: exclusões/razão fiscal abertas ao JWT';
  END IF;
  IF has_function_privilege('anon', 'public.radar_razao_social_para_cadastro(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.radar_exclusao_registrar(text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.radar_privacidade_expurgo(integer,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.radar_exclusoes_aplicar(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P4 FALHOU: RPC de privacidade aberta além do previsto';
  END IF;
  IF (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname IN ('idx_radar_empresas_titular_mei_norm', 'idx_radar_empresas_titular_mei', 'idx_radar_empresas_razao_crua')
         AND i.indisvalid AND strpos(pg_get_indexdef(i.indexrelid), CASE WHEN c.relname = 'idx_radar_empresas_razao_crua'
                                                                         THEN ' [0-9]{11}$' ELSE '|\*\*\*[0-9]{6}\*\*)$' END) > 0) <> 3 THEN
    RAISE EXCEPTION 'P5 FALHOU: índices do titular de MEI ausentes, inválidos ou sem o regex das duas formas';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'radar-privacidade-expurgo' AND active) THEN
    RAISE EXCEPTION 'P6 FALHOU: job radar-privacidade-expurgo ausente';
  END IF;
  IF private.radar_razao_mascarada('FULANO DE TAL 12345678901') IS DISTINCT FROM 'FULANO DE TAL ***456789**'
     OR private.radar_titular_mascara('***456789**') IS DISTINCT FROM '***456789**'
     OR private.radar_titular_mascara('12345678901') IS DISTINCT FROM '***456789**' THEN
    RAISE EXCEPTION 'P7 FALHOU: máscara do titular fora do formato da RFB';
  END IF;
END
$post$;
