-- ============================================================
-- Radar sucessor, passo 3: "mesmo sócio" pelo CPF MASCARADO da Receita (nome + `***dddddd**`), sem exigir município
-- e cobrindo clientes FORA do recorte do Radar. Decisão do founder: "Construir agora" (2026-11-06).
--
-- Medição (QSA RFB 2026-10 × prod, docs/historico/radar-socios-cpf-mascarado-medicao-2026-11-06.md): a regra atual
-- dá 30 pares; nome + máscara crua dá +118, mas contaminados por diretor/conselheiro de S.A.; com a chave em ≤3
-- empresas NO PAÍS e qualificação de dono nos dois lados: +50 leads (identidade ≥90% à mão), +2 pares de crédito.
--
-- O QUE MUDA:
--   1. public.radar_socios_lote (manifesto IMUTÁVEL por lote: digest, contagens declaradas, status) e
--      public.radar_socios (só PF com máscara válida: raiz, nome normalizado, máscara, qualificação, data de entrada,
--      nº de empresas no país). Só do servidor: RLS ligada sem policy, nada para PUBLIC/anon/authenticated.
--   2. RPCs da carga (só service_role, serializadas por advisory lock): radar_socios_iniciar → radar_socios_receber
--      (chunks, só em lote 'carregando') → radar_socios_publicar (reconcilia contagens e troca o ponteiro 'vigente'
--      em 2 UPDATEs ordenados) → radar_socios_limpar (apaga em fatias o que saiu de vigente+anterior).
--   3. private.radar_vinculos_base (a ÚNICA cópia das regras): sinal novo 'socio_cpf' (forte); guarda na regra antiga
--      'pessoa' (máscaras dos 2 lados e nenhuma bate ⇒ não casa por nome); o nome do cliente sai SEM o CPF também
--      quando vem do perfil (achado Codex P1: o perfil de MEI devolvia o CPF completo). Sem lote vigente, a saída é
--      a de antes (prova E* no PG17), salvo esse saneamento.
--   4. private.credito_vinculo_avaliar: regra_versao 1 → 2 (o sensor grava a versão da regra que gerou o aviso).
--   As herdeiras radar_vinculos_nucleo, radar_possiveis_vinculos, radar_vinculos_por_cnpjs, credito_vinculo_aviso e
--   credito_vinculo_aviso_registrar NÃO são recriadas (a PÓS confere que seguem com o corpo de prod).
--
-- LGPD: nome + CPF parcial de sócio é dado pessoal. Finalidade = vínculo societário com cliente (prospecção e
-- proteção do crédito); nunca parentesco. Minimização: só PF com máscara; sem representante, faixa etária, país.
-- Acesso: só o servidor; as RPCs devolvem o SINAL, nunca nome de sócio ou máscara. Retenção: vigente + 1 anterior.
-- Mapa: docs/historico/radar-socios-cpf-mascarado-2026-11-07.md §LGPD.
--
-- ⚠️ ORDEM DE DEPLOY: Publish ANTES desta migration — os parsers do front rejeitam sinal desconhecido.
-- Corpos de prod lidos em 2026-11-06 (psql-ro), iguais aos do repo: base 91dc715b…, avaliar afbc83bf….
-- Molde TRAVA → PRE → CREATE → PÓS. Prova PG17: db/test-radar-socios-cpf.sh (e --falsificar).
-- Aplicação: `bun run db:aplicar supabase/migrations/20261107040000_radar_socios_cpf_mascarado.sql`
-- (sem BEGIN/COMMIT: o executor fornece a transação).
-- ============================================================

DO $trava$
BEGIN
  ALTER FUNCTION private.radar_vinculos_base(text[], boolean, boolean) STABLE;
  ALTER FUNCTION private.radar_vinculos_nucleo(text[], boolean) STABLE;
  ALTER FUNCTION private.credito_vinculo_avaliar(text, boolean) STABLE;
  ALTER FUNCTION public.credito_vinculo_aviso(text) STABLE;
  ALTER FUNCTION public.radar_possiveis_vinculos(text) STABLE;
  ALTER FUNCTION public.radar_vinculos_por_cnpjs(text[]) STABLE;
END
$trava$;

DO $pre$
DECLARE
  v_bs  text := (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('private.radar_vinculos_base(text[],boolean,boolean)'));
  v_pa  text := (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('private.credito_vinculo_avaliar(text,boolean)'));
BEGIN
  IF v_bs IS NULL OR v_bs NOT IN ('91dc715bb76efc00b85c4b86964d50db', '1ac303c64102deb4bb6e10b4e7619b6f') THEN
    RAISE EXCEPTION 'PRE FALHOU: private.radar_vinculos_base vivo (md5 %) não é o da 20261106205557 nem este — outra sessão mexeu nas regras; reconcilie antes', v_bs;
  END IF;
  IF v_pa IS NULL OR v_pa NOT IN ('afbc83bfdbe959be21486d19c818d051', '19301287d9f89478c79692d39cc114f1') THEN
    RAISE EXCEPTION 'PRE FALHOU: private.credito_vinculo_avaliar vivo (md5 %) não é o da 20261106205557 nem este', v_pa;
  END IF;
END
$pre$;

-- ------------------------------------------------------------
-- 1. Tabelas (só do servidor)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.radar_socios_lote (
  lote              text PRIMARY KEY CHECK (lote ~ '^[0-9]{4}-[0-9]{2}-[0-9a-f]{8}$'),
  mes               text NOT NULL CHECK (mes ~ '^[0-9]{4}-[0-9]{2}$'),
  digest            text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  versao_carga      text NOT NULL CHECK (length(versao_carga) BETWEEN 1 AND 40),
  linhas_declaradas integer NOT NULL CHECK (linhas_declaradas > 0),
  raizes_declaradas integer NOT NULL CHECK (raizes_declaradas > 0),
  universo_raizes   integer NOT NULL CHECK (universo_raizes > 0),
  status            text NOT NULL DEFAULT 'carregando'
                      CHECK (status IN ('carregando', 'vigente', 'anterior', 'descartado')),
  criado_em         timestamptz NOT NULL DEFAULT now(),
  publicado_em      timestamptz,
  CHECK (left(lote, 7) = mes AND right(lote, 8) = left(digest, 8))
);
CREATE UNIQUE INDEX IF NOT EXISTS radar_socios_lote_um_vigente ON public.radar_socios_lote ((true)) WHERE status = 'vigente';

CREATE TABLE IF NOT EXISTS public.radar_socios (
  lote             text NOT NULL REFERENCES public.radar_socios_lote (lote),
  raiz             text NOT NULL CHECK (raiz ~ '^[0-9A-Z]{8}$'),
  nome_normalizado text NOT NULL CHECK (nome_normalizado ~ '^[^ ]+( [^ ]+)+$' AND length(nome_normalizado) <= 200),
  cpf_mascarado    text NOT NULL CHECK (cpf_mascarado ~ '^\*\*\*[0-9]{6}\*\*$'),
  qualificacao     text NOT NULL CHECK (qualificacao ~ '^[0-9]{2}$'),
  data_entrada     date,
  n_raizes_pais    integer NOT NULL CHECK (n_raizes_pais >= 1),
  PRIMARY KEY (lote, raiz, nome_normalizado, cpf_mascarado, qualificacao)
);
CREATE INDEX IF NOT EXISTS radar_socios_chave ON public.radar_socios (lote, nome_normalizado, cpf_mascarado);

ALTER TABLE public.radar_socios_lote ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.radar_socios ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.radar_socios_lote FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.radar_socios FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.radar_socios IS
  'QSA RFB (só PF com CPF mascarado) das raízes do Radar ∪ clientes. Dado pessoal: só servidor; finalidade = vínculo societário com cliente (nunca parentesco). Ver docs/historico/radar-socios-cpf-mascarado-2026-11-07.md.';

-- ------------------------------------------------------------
-- 2. Helpers de chave (a carga em TS replica os MESMOS mapas — scripts/radar/socios.ts, teste que lê este arquivo)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.radar_nome_norm(p text)
 RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $f$
  SELECT NULLIF(btrim(regexp_replace(upper(translate(p,
    'áàâãäåéèêëíìîïóòôõöúùûüçñýÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑÝ',
    'aaaaaaeeeeiiiiooooouuuucnyAAAAAAEEEEIIIIOOOOOUUUUCNY')), '\s+', ' ', 'g')), '')
$f$;
CREATE OR REPLACE FUNCTION private.radar_mascara_cpf(p text)
 RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $f$
  SELECT CASE WHEN p ~ '^[0-9]{11}$' THEN '***' || substr(p, 4, 6) || '**' END
$f$;
-- Guarda da regra antiga por NOME: os 2 lados têm máscara para esse nome e nenhuma bate ⇒ homônimo provável.
-- Sem lote vigente, inerte (a regra antiga fica exatamente como era).
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
    SELECT left(e.cnpj, 8), private.radar_mascara_cpf(substring(e.razao_social FROM ' ([0-9]{11})$'))
      FROM public.radar_empresas e
     WHERE left(e.cnpj, 8) IN (p_raiz_a, p_raiz_b) AND e.razao_social ~ ' [0-9]{11}$'
       AND private.radar_nome_norm(regexp_replace(e.razao_social, ' [0-9]{11}$', '')) = private.radar_nome_norm(p_nome)
  )
  SELECT EXISTS (SELECT 1 FROM vig)
     AND EXISTS (SELECT 1 FROM m WHERE m.raiz = p_raiz_a)
     AND EXISTS (SELECT 1 FROM m WHERE m.raiz = p_raiz_b)
     AND NOT EXISTS (SELECT 1 FROM m a JOIN m b ON b.mask = a.mask WHERE a.raiz = p_raiz_a AND b.raiz = p_raiz_b)
$f$;
REVOKE ALL ON FUNCTION private.radar_nome_norm(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.radar_mascara_cpf(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.radar_mascaras_conflitam(text, text, text) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. RPCs da carga. Todas serializadas pelo MESMO advisory lock de transação (receber × publicar × limpar ×
--    iniciar nunca se intercalam — achado Codex P1). Erros com CÓDIGO fixo, sem eco de linha (a máscara não vaza
--    em log/resposta): linha inválida é CONTADA e descartada antes do INSERT, nunca vira violação de CHECK.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.radar_socios_iniciar(p_mes text, p_digest text, p_versao text,
                                                      p_linhas integer, p_raizes integer, p_universo integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $f$
DECLARE
  v_lote text := p_mes || '-' || left(p_digest, 8);
  r public.radar_socios_lote;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('radar_socios'));
  IF p_mes !~ '^[0-9]{4}-[0-9]{2}$' OR p_digest !~ '^[0-9a-f]{64}$' OR coalesce(p_linhas, 0) <= 0
     OR coalesce(p_raizes, 0) <= 0 OR coalesce(p_universo, 0) <= 0 OR p_raizes > p_linhas
     OR coalesce(length(p_versao), 0) NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'RSOC_MANIFESTO_INVALIDO';
  END IF;
  SELECT * INTO r FROM public.radar_socios_lote WHERE lote = v_lote FOR UPDATE;
  IF FOUND THEN
    -- Manifesto IMUTÁVEL: mesmo lote só com o mesmo conteúdo e as mesmas contagens (não dá para "reduzir o
    -- declarado" para uma carga incompleta passar). Conteúdo diferente = outro digest = outro lote.
    IF r.digest <> p_digest OR r.linhas_declaradas <> p_linhas OR r.raizes_declaradas <> p_raizes
       OR r.universo_raizes <> p_universo OR r.versao_carga <> p_versao THEN
      RAISE EXCEPTION 'RSOC_MANIFESTO_DIVERGENTE';
    END IF;
  ELSE
    -- Carga abandonada (carregando há > 3 dias) expira: vira descartada e a limpeza a remove.
    UPDATE public.radar_socios_lote SET status = 'descartado'
     WHERE status = 'carregando' AND criado_em < now() - interval '3 days';
    INSERT INTO public.radar_socios_lote (lote, mes, digest, versao_carga, linhas_declaradas, raizes_declaradas, universo_raizes)
    VALUES (v_lote, p_mes, p_digest, p_versao, p_linhas, p_raizes, p_universo)
    RETURNING * INTO r;
  END IF;
  RETURN jsonb_build_object('lote', r.lote, 'status', r.status,
    'recebidas', (SELECT count(*) FROM public.radar_socios s WHERE s.lote = r.lote));
END
$f$;

CREATE OR REPLACE FUNCTION public.radar_socios_receber(p_lote text, p_linhas jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $f$
DECLARE
  v_status text;
  v_n integer;
  v_validas integer;
  v_ins integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('radar_socios'));
  SELECT status INTO v_status FROM public.radar_socios_lote WHERE lote = p_lote FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'RSOC_LOTE_INEXISTENTE'; END IF;
  IF v_status <> 'carregando' THEN RAISE EXCEPTION 'RSOC_LOTE_FECHADO'; END IF;
  IF jsonb_typeof(p_linhas) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'RSOC_CHUNK_INVALIDO'; END IF;
  v_n := jsonb_array_length(p_linhas);
  IF v_n = 0 OR v_n > 5000 THEN RAISE EXCEPTION 'RSOC_CHUNK_TAMANHO'; END IF;
  WITH x AS (
  SELECT x.raiz, x.nome_normalizado, x.cpf_mascarado, x.qualificacao, x.data_entrada, x.n_raizes_pais
    FROM jsonb_to_recordset(p_linhas) AS x(raiz text, nome_normalizado text, cpf_mascarado text, qualificacao text,
                                           data_entrada text, n_raizes_pais text)
   WHERE x.raiz ~ '^[0-9A-Z]{8}$'
     AND x.nome_normalizado ~ '^[^ ]+( [^ ]+)+$' AND length(x.nome_normalizado) <= 200
     AND x.nome_normalizado = private.radar_nome_norm(x.nome_normalizado)
     AND x.cpf_mascarado ~ '^\*\*\*[0-9]{6}\*\*$'
     AND x.qualificacao ~ '^[0-9]{2}$'
     AND (x.data_entrada IS NULL OR x.data_entrada ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
     AND x.n_raizes_pais ~ '^[1-9][0-9]{0,6}$'
  ), ins AS (
  INSERT INTO public.radar_socios (lote, raiz, nome_normalizado, cpf_mascarado, qualificacao, data_entrada, n_raizes_pais)
  SELECT DISTINCT ON (x.raiz, x.nome_normalizado, x.cpf_mascarado, x.qualificacao)
         p_lote, x.raiz, x.nome_normalizado, x.cpf_mascarado, x.qualificacao, x.data_entrada::date, x.n_raizes_pais::integer
    FROM x
   ORDER BY x.raiz, x.nome_normalizado, x.cpf_mascarado, x.qualificacao, x.data_entrada
  ON CONFLICT DO NOTHING   -- retentativa do MESMO chunk (o digest do manifesto garante que o conteúdo é o mesmo)
  RETURNING 1
  )
  SELECT (SELECT count(*) FROM x), (SELECT count(*) FROM ins) INTO v_validas, v_ins;
  RETURN jsonb_build_object('recebidas', v_n, 'invalidas', v_n - v_validas, 'inseridas', v_ins);
END
$f$;

CREATE OR REPLACE FUNCTION public.radar_socios_publicar(p_lote text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $f$
DECLARE
  r public.radar_socios_lote;
  v_linhas integer;
  v_raizes integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('radar_socios'));
  SELECT * INTO r FROM public.radar_socios_lote WHERE lote = p_lote FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RSOC_LOTE_INEXISTENTE'; END IF;
  -- Resposta perdida + retentativa: o lote já publicado responde sucesso, SEM ser promovido de novo.
  IF r.status IN ('vigente', 'anterior') THEN
    RETURN jsonb_build_object('lote', r.lote, 'status', r.status, 'ja_publicado', true);
  END IF;
  IF r.status <> 'carregando' THEN RAISE EXCEPTION 'RSOC_LOTE_DESCARTADO'; END IF;
  SELECT count(*), count(DISTINCT raiz) INTO v_linhas, v_raizes FROM public.radar_socios WHERE lote = p_lote;
  IF v_linhas <> r.linhas_declaradas OR v_raizes <> r.raizes_declaradas THEN
    RAISE EXCEPTION 'RSOC_RECONCILIACAO linhas=%/% raizes=%/%', v_linhas, r.linhas_declaradas, v_raizes, r.raizes_declaradas;
  END IF;
  -- Troca do ponteiro em UPDATEs ORDENADOS (o índice único de 'vigente' é imediato): anterior→descartado,
  -- vigente→anterior, este→vigente. Leitores veem o lote velho ou o novo, nunca nenhum nem os dois.
  UPDATE public.radar_socios_lote SET status = 'descartado' WHERE status = 'anterior';
  UPDATE public.radar_socios_lote SET status = 'anterior' WHERE status = 'vigente';
  UPDATE public.radar_socios_lote SET status = 'vigente', publicado_em = now() WHERE lote = p_lote;
  RETURN jsonb_build_object('lote', p_lote, 'status', 'vigente', 'ja_publicado', false, 'linhas', v_linhas, 'raizes', v_raizes);
END
$f$;

-- Apaga em fatias (o PostgREST corta em ~8 s) as linhas dos lotes descartados; o lote vazio sai junto.
CREATE OR REPLACE FUNCTION public.radar_socios_limpar(p_max integer DEFAULT 20000)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $f$
DECLARE
  v_del integer;
  v_lotes integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('radar_socios'));
  IF p_max IS NULL OR p_max < 1 OR p_max > 50000 THEN RAISE EXCEPTION 'RSOC_LIMITE_INVALIDO'; END IF;
  DELETE FROM public.radar_socios s
   WHERE s.ctid = ANY (ARRAY(SELECT x.ctid FROM public.radar_socios x
                              WHERE x.lote IN (SELECT l.lote FROM public.radar_socios_lote l WHERE l.status = 'descartado')
                              LIMIT p_max));
  GET DIAGNOSTICS v_del = ROW_COUNT;
  DELETE FROM public.radar_socios_lote l
   WHERE l.status = 'descartado' AND NOT EXISTS (SELECT 1 FROM public.radar_socios s WHERE s.lote = l.lote);
  GET DIAGNOSTICS v_lotes = ROW_COUNT;
  RETURN jsonb_build_object('linhas_apagadas', v_del, 'lotes_removidos', v_lotes,
    'restam', (SELECT count(*) FROM public.radar_socios_lote WHERE status = 'descartado'));
END
$f$;

REVOKE ALL ON FUNCTION public.radar_socios_iniciar(text, text, text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.radar_socios_receber(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.radar_socios_publicar(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.radar_socios_limpar(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_socios_iniciar(text, text, text, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.radar_socios_receber(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.radar_socios_publicar(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.radar_socios_limpar(integer) TO service_role;

-- ------------------------------------------------------------
-- 4. A base das regras (a ÚNICA cópia) — corpo de prod (91dc715b…) + sinal 'socio_cpf' + guarda + nome saneado.
-- ------------------------------------------------------------
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
      SELECT l.cnpj, btrim(regexp_replace(regexp_replace(l.razao_social, '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} ', ''), ' [0-9]{11}$', ''))
        FROM lead l
       WHERE l.razao_social ~ ' [0-9]{11}$' OR l.razao_social ~ '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} '
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
        ON (e.razao_social ~ ' [0-9]{11}$' OR e.razao_social ~ '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} ')
       AND btrim(regexp_replace(regexp_replace(e.razao_social, '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} ', ''), ' [0-9]{11}$', '')) = l.n
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
    SELECT l.cnpj, private.radar_nome_norm(regexp_replace(l.razao_social, ' [0-9]{11}$', '')),
           private.radar_mascara_cpf(substring(l.razao_social FROM ' ([0-9]{11})$'))
      FROM lead l
     WHERE l.razao_social ~ ' [0-9]{11}$' AND EXISTS (SELECT 1 FROM vig)
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
    UNION ALL
    SELECT c.nome, c.mask, left(e.cnpj, 8), NULL::text, NULL::integer
      FROM chave c JOIN public.radar_empresas e
        ON (e.razao_social ~ ' [0-9]{11}$' OR e.razao_social ~ '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} ')
       AND btrim(regexp_replace(regexp_replace(e.razao_social, '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} ', ''), ' [0-9]{11}$', '')) = c.nome
     WHERE private.radar_mascara_cpf(substring(e.razao_social FROM ' ([0-9]{11})$')) = c.mask
    UNION ALL
    SELECT c.nome, c.mask, left(pf.doc, 8), NULL::text, NULL::integer
      FROM chave c JOIN perfil pf
        ON pf.nome ~ ' [0-9]{11}$'
       AND private.radar_nome_norm(regexp_replace(pf.nome, ' [0-9]{11}$', '')) = c.nome
       AND private.radar_mascara_cpf(substring(pf.nome FROM ' ([0-9]{11})$')) = c.mask
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
           regexp_replace(COALESCE(v.nome_radar, v.nome_perfil), ' [0-9]{11}$', '') AS nome,  -- sem o CPF do titular de MEI, venha do Radar OU do perfil
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


REVOKE ALL ON FUNCTION private.radar_vinculos_base(text[], boolean, boolean) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 5. Avaliação do crédito: só a versão da regra (1 → 2); corpo de prod (afbc83bf…) no resto.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.credito_vinculo_avaliar(p_cnpj text, p_ver_carteira boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_out jsonb;
BEGIN
  -- Fora da base RFB do Radar não há como avaliar: dizer isso, nunca "sem vínculo".
  IF NOT EXISTS (SELECT 1 FROM public.radar_empresas e WHERE e.cnpj = p_cnpj) THEN
    RETURN jsonb_build_object('estado', 'fora_da_base', 'regra_versao', 2);
  END IF;

  -- Projeção = a da ficha (decisão do founder, 2026-11-06): o crédito AVALIA a carteira inteira, mas só mostra
  -- nome/CNPJ de cliente só-cadastro a quem lê a carteira (p_ver_carteira). Valores: todo staff.
  WITH
  -- TODOS os vínculos (já-cliente incluído, sem o corte de 10): o corte de apresentação não esconde devedor.
  v AS (
    SELECT b.ordem, b.cliente_cnpj, b.cliente_nome, b.cliente_situacao, b.forca, b.sinais,
           EXISTS (SELECT 1 FROM public.radar_empresas r WHERE r.cnpj = b.cliente_cnpj AND r.ja_cliente) AS no_radar
      FROM private.radar_vinculos_base(ARRAY[p_cnpj], true, true) b
  ),
  -- documento → titular. Documento de mais de um titular não prova de quem é a dívida (→ indeterminado).
  titular AS (
    SELECT v.cliente_cnpj, min(p.user_id::text)::uuid AS user_id, count(DISTINCT p.user_id) AS n_titulares
      FROM v
      JOIN public.profiles p
        ON p.document IS NOT NULL AND public.normalizar_documento(p.document) = v.cliente_cnpj
     GROUP BY v.cliente_cnpj
  ),
  -- Os códigos Omie do titular, cada um com a PROVA do contrato de identidade (20261019140000 §client_prova):
  -- evidência documental = o documento do vinculado, titular único, mapa fresco (7 d). Sem prova → não avaliado.
  par AS (
    SELECT t.cliente_cnpj, m.account AS company, m.omie_codigo_cliente AS codigo,
           -- COALESCE: evidência NULA é "sem prova", nunca NULL (NULL some de provado E de NOT provado)
           COALESCE(t.n_titulares = 1
                    AND m.evidence_document_normalized = t.cliente_cnpj
                    AND m.updated_at >= now() - interval '7 days', false) AS provado
      FROM titular t
      JOIN public.omie_customer_account_map m ON m.user_id = t.user_id
     WHERE m.omie_codigo_cliente > 0
  ),
  -- A regra do vencido é UMA: venda_prazo_aviso (a mesma do aviso de prazo e da fila de cobrança).
  aval AS (
    SELECT q.cliente_cnpj, q.company, public.venda_prazo_aviso(q.company, q.codigo) AS a
      FROM par q
     WHERE q.provado
  ),
  credora AS (
    SELECT a.cliente_cnpj, a.company,
           sum((a.a ->> 'vencido')::numeric) AS vencido,
           sum((a.a ->> 'n_titulos')::integer) AS n_titulos,
           max((a.a ->> 'dias_vencido_max')::integer) AS dias_vencido_max,
           min(a.a ->> 'vencimento_mais_antigo') AS vencimento_mais_antigo,
           min(a.a ->> 'sync_em') AS sync_em,
           sum((a.a ->> 'n_ambiguos')::integer) AS n_ambiguos,
           sum((a.a ->> 'n_invalidos')::integer) AS n_invalidos,
           -- a pior qualidade entre os códigos da mesma conta
           (array_agg(a.a ->> 'qualidade' ORDER BY CASE a.a ->> 'qualidade' WHEN 'sem_sync' THEN 0
                                                                            WHEN 'defasado' THEN 1 ELSE 2 END))[1] AS qualidade
      FROM aval a
     WHERE (a.a ->> 'disponivel')::boolean
     GROUP BY a.cliente_cnpj, a.company
  ),
  por_vinculo AS (
    SELECT v.*,
           (SELECT count(*) FROM par q WHERE q.cliente_cnpj = v.cliente_cnpj AND q.provado) AS n_provados,
           (SELECT count(*) FROM par q WHERE q.cliente_cnpj = v.cliente_cnpj AND NOT q.provado) AS n_sem_prova,
           -- avaliação INCOMPLETA de alguma credora: título de status incerto/inválido, ou sync velho/ausente
           EXISTS (SELECT 1 FROM credora c WHERE c.cliente_cnpj = v.cliente_cnpj
                    AND (c.n_ambiguos > 0 OR c.n_invalidos > 0 OR c.qualidade <> 'ok')) AS incompleto,
           (SELECT jsonb_agg(jsonb_build_object(
                     'company', c.company, 'vencido', c.vencido, 'n_titulos', c.n_titulos,
                     'dias_vencido_max', c.dias_vencido_max, 'vencimento_mais_antigo', c.vencimento_mais_antigo,
                     'sync_em', c.sync_em, 'qualidade', c.qualidade,
                     'n_ambiguos', c.n_ambiguos, 'n_invalidos', c.n_invalidos) ORDER BY c.company)
              FROM credora c WHERE c.cliente_cnpj = v.cliente_cnpj AND c.vencido > 0) AS credoras
      FROM v
  )
  SELECT jsonb_build_object(
           'estado', 'avaliado',
           'regra_versao', 2,
           'n_vinculos', count(*),
           -- sem evidência positiva E sem avaliação completa: não se sabe — nunca "em dia"
           'n_indeterminados', count(*) FILTER (WHERE pv.credoras IS NULL
                                                  AND (pv.n_provados = 0 OR pv.n_sem_prova > 0 OR pv.incompleto)),
           'vinculos', coalesce(jsonb_agg(jsonb_build_object(
                         -- referência OPACA e ESTÁVEL do par (sujeito, vinculado): não muda se outro vínculo
                         -- entrar na frente (a posição mudaria e o voto iria para o cliente errado).
                         'ref', left(md5(p_cnpj || '|' || pv.cliente_cnpj), 16),
                         'cliente_cnpj', CASE WHEN pv.no_radar OR p_ver_carteira THEN pv.cliente_cnpj END,
                         'cliente_nome', CASE WHEN pv.no_radar OR p_ver_carteira THEN pv.cliente_nome END,
                         'cliente_situacao', pv.cliente_situacao, 'forca', pv.forca, 'sinais', to_jsonb(pv.sinais),
                         -- parte das contas do vinculado não foi avaliada: o aviso vale, o total pode ser maior
                         'parcial', (pv.n_sem_prova > 0 OR pv.incompleto),
                         'credoras', pv.credoras,
                         '_cliente_cnpj_real', pv.cliente_cnpj) ORDER BY pv.ordem)
                         FILTER (WHERE pv.credoras IS NOT NULL), '[]'::jsonb))
    INTO v_out
    FROM por_vinculo pv;
  RETURN v_out;
END;
$function$;


REVOKE ALL ON FUNCTION private.credito_vinculo_avaliar(text, boolean) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- PÓS: corpos (os novos E os herdeiros intocados), ACL, RLS — a migration que não pegou aborta aqui.
-- ------------------------------------------------------------
DO $post$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, x.esperado,
           (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(x.alvo)) AS vivo
      FROM (VALUES ('private.radar_vinculos_base(text[], boolean, boolean)',               '1ac303c64102deb4bb6e10b4e7619b6f'),
                   ('private.credito_vinculo_avaliar(text, boolean)',                       '19301287d9f89478c79692d39cc114f1'),
                   ('private.radar_vinculos_nucleo(text[], boolean)',                       'f345a864df438f0b7fba25bf50f6ea43'),
                   ('public.credito_vinculo_aviso(text)',                                   'e7e4c97c787123c82c814f192db361a2'),
                   ('public.credito_vinculo_aviso_registrar(text, text, text, text, text)', '9e0cfc8bc35dd5bc0784d0821b15918a'),
                   ('public.radar_possiveis_vinculos(text)',                                '2452f463ae9d97860a4514b81f30a3ea'),
                   ('public.radar_vinculos_por_cnpjs(text[])',                              'a9278dd0c4e9fb025743caa438b9b130')) AS x(alvo, esperado)
  LOOP
    IF r.vivo IS DISTINCT FROM r.esperado THEN
      RAISE EXCEPTION 'A1 FALHOU: % vivo (md5 %) não é o corpo esperado por este arquivo', r.alvo, r.vivo;
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.radar_socios', 'SELECT') OR has_table_privilege('authenticated', 'public.radar_socios', 'SELECT')
     OR has_table_privilege('anon', 'public.radar_socios_lote', 'SELECT') OR has_table_privilege('authenticated', 'public.radar_socios_lote', 'SELECT')
     OR has_table_privilege('authenticated', 'public.radar_socios', 'INSERT') OR has_table_privilege('authenticated', 'public.radar_socios_lote', 'UPDATE')
     OR NOT (SELECT bool_and(c.relrowsecurity) FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.radar_socios'::regclass, 'public.radar_socios_lote'::regclass)) THEN
    RAISE EXCEPTION 'A2 FALHOU: radar_socios/radar_socios_lote legíveis pelo JWT ou sem RLS';
  END IF;
  FOR r IN SELECT x.f FROM (VALUES ('public.radar_socios_iniciar(text, text, text, integer, integer, integer)'),
                                   ('public.radar_socios_receber(text, jsonb)'), ('public.radar_socios_publicar(text)'),
                                   ('public.radar_socios_limpar(integer)')) AS x(f)
  LOOP
    IF has_function_privilege('anon', r.f, 'EXECUTE') OR has_function_privilege('authenticated', r.f, 'EXECUTE')
       OR NOT has_function_privilege('service_role', r.f, 'EXECUTE')
       OR NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.f)) THEN
      RAISE EXCEPTION 'A3 FALHOU: ACL/definer de % errado (só service_role, SECURITY DEFINER)', r.f;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'private.radar_vinculos_base(text[], boolean, boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.radar_mascaras_conflitam(text, text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'private.radar_vinculos_base(text[], boolean, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A4 FALHOU: base/guarda executável pelo JWT';
  END IF;
  -- A base RODA (late-bound): uma chamada real, com o lote vigente que houver (ou nenhum).
  PERFORM count(*) FROM private.radar_vinculos_base(ARRAY(SELECT e.cnpj FROM public.radar_empresas e ORDER BY e.cnpj LIMIT 3), true, true);
  RAISE NOTICE 'radar_socios: tabelas fechadas, RPCs só service_role, base com socio_cpf — corpos e ACL provados';
END
$post$;
