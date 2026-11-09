-- ============================================================
-- Radar de Clientes — "possível vínculo / possível sucessor de cliente X" na FICHA do lead.
--
-- Pedido do founder (2026-11-04): saber se um CNPJ novo é cliente novo mesmo, ou se é a mesma pessoa que fechou
-- uma empresa e abriu outra (mesmo endereço, mesmo sócio, cônjuge/filho). Viabilidade medida em prod
-- (docs/historico/radar-sucessor-viabilidade-2026-11-04.md): com chave EXCLUSIVA (≤ 2 raízes de CNPJ) e filtro de
-- contador, 73 leads FORTES + 93 MÉDIOS em ~507 mil; precisão ~80-90 % na amostra à mão. Telefone OU e-mail
-- sozinho é falso positivo de contador (o escritório cadastra o próprio contato na RFB) → não aparece.
--
-- É PISTA, nunca veredito: calculado na leitura, nada persistido (LGPD — parentesco não é fato, a Receita não
-- informa). Não devolve CPF. A ficha mostra a EVIDÊNCIA (quais sinais casaram).
--
-- Entrega:
--   • 4 índices em radar_empresas (sem eles, cada abertura de ficha varre 731 MB: 5,6 s medidos):
--       e-mail normalizado · CEP · nomes do QSA (GIN no array) · titular de MEI/EI extraído da razão social.
--     Só funções NATIVAS nas expressões: índice com função própria exigiria EXECUTE de quem grava (a carga).
--   • private.radar_tel_chave(text)  — telefone → '(DD) últimos 8', o formato que a RFB grava (corta o 9).
--   • private.radar_chave_endereco(logradouro, número, complemento) — chave do endereço COMPLETO.
--   • public.radar_possiveis_vinculos(p_cnpj) — até 10 clientes com vínculo, cada um com força e sinais:
--       sinais   telefone · email · endereco · pessoa (mesmo nome de sócio/titular, ≥ 3 palavras, MESMO município)
--       chave    só conta se aparece em ≤ 2 raízes (o lead e o cliente) — 3+ é contador, condomínio, galeria
--       contador e-mail de qualquer lado com domínio de contabilidade → telefone e e-mail não contam
--       forca    'forte' = pessoa, ou ≥ 2 sinais no MESMO cliente · 'media' = endereço completo sozinho
--     Gate `cap_radar_prospectar` (o da fila). Clientes que só existem em `profiles` (fora do Radar) só voltam
--     para quem tem `cap_carteira_ler` — mesmo recorte de `radar_irmaos_por_raiz`. A EXCLUSIVIDADE conta todas
--     as fontes para qualquer papel (contar não revela quem é).
--
-- Aplicar: `bun run db:aplicar supabase/migrations/20261104201756_radar_possiveis_vinculos.sql` (o executor
-- fornece a transação — o arquivo não leva BEGIN/COMMIT). Prova: db/test-radar-possiveis-vinculos.sh.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_radar_empresas_email_norm
  ON public.radar_empresas (lower(btrim(email))) WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_radar_empresas_cep
  ON public.radar_empresas (cep) WHERE cep IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_radar_empresas_socios_arr
  ON public.radar_empresas USING gin (string_to_array(socios_nomes, '; ')) WHERE socios_nomes IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_radar_empresas_titular_mei
  ON public.radar_empresas (btrim(regexp_replace(regexp_replace(razao_social, '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} ', ''), ' [0-9]{11}$', '')))
  WHERE razao_social ~ ' [0-9]{11}$' OR razao_social ~ '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} ';

CREATE OR REPLACE FUNCTION private.radar_tel_chave(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT CASE WHEN length(d) IN (10, 11) THEN '(' || left(d, 2) || ') ' || right(d, 8) END
    FROM (SELECT CASE WHEN length(x) IN (12, 13) AND left(x, 2) = '55' THEN substr(x, 3) ELSE x END AS d
            FROM (SELECT ltrim(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), '0') AS x) a) b
$function$;

CREATE OR REPLACE FUNCTION private.radar_chave_endereco(p_log text, p_num text, p_comp text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT CASE WHEN n <> '' AND l <> '' THEN l || '|' || n || '|' || c END
    FROM (SELECT
      btrim(regexp_replace(regexp_replace(regexp_replace(
        ' ' || regexp_replace(upper(translate(coalesce(p_log, ''),
          'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC')),
          '[^A-Z0-9]+', ' ', 'g') || ' ',
        '^ (RUA|R|AVENIDA|AV|RODOVIA|ROD|TRAVESSA|TV|PRACA|PC|ALAMEDA|AL|ESTRADA|EST|LARGO|VIA|BECO) ', ' '),
        ' (DE|DA|DO|DAS|DOS|E)(?= )', '', 'g'),
        ' +', ' ', 'g')) AS l,
      ltrim(regexp_replace(coalesce(p_num, ''), '[^0-9]', '', 'g'), '0') AS n,
      regexp_replace(regexp_replace(upper(coalesce(p_comp, '')), '[^A-Z0-9]', '', 'g'),
        '(^|[A-Z])0+([0-9])', '\1\2', 'g') AS c) x
$function$;

REVOKE ALL ON FUNCTION private.radar_tel_chave(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.radar_chave_endereco(text, text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.radar_possiveis_vinculos(p_cnpj text)
 RETURNS TABLE(cliente_cnpj text, cliente_nome text, cliente_situacao text, forca text, sinais text[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_lead     public.radar_empresas%ROWTYPE;
  v_carteira boolean;
  v_cont     constant text := '@[^@]*(cont|assessor|escritorio|fiscal|mei|partner)';
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN
    RAISE EXCEPTION 'cnpj inválido' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_lead FROM public.radar_empresas e WHERE e.cnpj = p_cnpj;
  IF NOT FOUND OR v_lead.ja_cliente THEN
    RETURN;
  END IF;
  v_carteira := COALESCE(private.cap_carteira_ler((SELECT auth.uid())), false);

  RETURN QUERY
  WITH
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
    SELECT DISTINCT k FROM (VALUES (private.radar_tel_chave(v_lead.telefone1)),
                                   (private.radar_tel_chave(v_lead.telefone2))) v(k)
     WHERE k IS NOT NULL
  ),
  tel_hits AS (
    SELECT e.cnpj AS doc, e.ja_cliente AS cliente, t.k FROM lead_tel t JOIN public.radar_empresas e ON e.telefone1 = t.k
    UNION
    SELECT e.cnpj, e.ja_cliente, t.k FROM lead_tel t JOIN public.radar_empresas e ON e.telefone2 = t.k
    UNION
    SELECT pf.doc, true, t.k FROM lead_tel t JOIN perfil pf ON pf.tel_k = t.k
  ),
  email_hits AS (
    SELECT e.cnpj AS doc, e.ja_cliente AS cliente
      FROM public.radar_empresas e
     WHERE v_lead.email LIKE '%@%' AND e.email IS NOT NULL AND lower(btrim(e.email)) = lower(btrim(v_lead.email))
    UNION
    SELECT pf.doc, true FROM perfil pf
     WHERE v_lead.email LIKE '%@%' AND pf.email_k = lower(btrim(v_lead.email))
  ),
  lead_end AS (
    SELECT v_lead.cep AS cep, private.radar_chave_endereco(v_lead.logradouro, v_lead.numero, v_lead.complemento) AS k
  ),
  end_hits AS (
    SELECT e.cnpj AS doc, e.ja_cliente AS cliente
      FROM lead_end l JOIN public.radar_empresas e ON e.cep = l.cep
     WHERE l.k IS NOT NULL AND l.cep ~ '^[0-9]{8}$'
       AND private.radar_chave_endereco(e.logradouro, e.numero, e.complemento) = l.k
    UNION
    SELECT pf.doc, true
      FROM lead_end l
      JOIN public.addresses a ON regexp_replace(coalesce(a.zip_code, ''), '[^0-9]', '', 'g') = l.cep
      JOIN perfil pf ON pf.user_id = a.user_id
     WHERE l.k IS NOT NULL AND l.cep ~ '^[0-9]{8}$'
       AND private.radar_chave_endereco(a.street, a.number, a.complement) = l.k
  ),
  lead_pes AS (
    SELECT DISTINCT n FROM (
      SELECT unnest(string_to_array(v_lead.socios_nomes, '; ')) AS n
      UNION ALL
      SELECT btrim(regexp_replace(regexp_replace(v_lead.razao_social, '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} ', ''), ' [0-9]{11}$', ''))
       WHERE v_lead.razao_social ~ ' [0-9]{11}$' OR v_lead.razao_social ~ '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} '
    ) x
     WHERE n ~ '^[A-Z]+( [A-Z]+){2,}$'
  ),
  pes_hits AS (
    SELECT e.cnpj AS doc, e.ja_cliente AS cliente, e.municipio_codigo AS mun, l.n
      FROM lead_pes l JOIN public.radar_empresas e
        ON e.socios_nomes IS NOT NULL AND string_to_array(e.socios_nomes, '; ') @> ARRAY[l.n]
    UNION
    SELECT e.cnpj, e.ja_cliente, e.municipio_codigo, l.n
      FROM lead_pes l JOIN public.radar_empresas e
        ON (e.razao_social ~ ' [0-9]{11}$' OR e.razao_social ~ '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} ')
       AND btrim(regexp_replace(regexp_replace(e.razao_social, '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} ', ''), ' [0-9]{11}$', '')) = l.n
  ),
  sinal AS (
    SELECT h.doc, 'telefone'::text AS s FROM tel_hits h
     WHERE h.cliente AND h.k IN (SELECT k FROM tel_hits GROUP BY k HAVING count(DISTINCT left(doc, 8)) <= 2)
    UNION
    SELECT h.doc, 'email' FROM email_hits h
     WHERE h.cliente AND (SELECT count(DISTINCT left(doc, 8)) FROM email_hits) <= 2
    UNION
    SELECT h.doc, 'endereco' FROM end_hits h
     WHERE h.cliente AND (SELECT count(DISTINCT left(doc, 8)) FROM end_hits) <= 2
    UNION
    SELECT h.doc, 'pessoa' FROM pes_hits h
     WHERE h.cliente AND h.mun = v_lead.municipio_codigo
       AND h.n IN (SELECT n FROM pes_hits GROUP BY n HAVING count(DISTINCT left(doc, 8)) <= 2)
  ),
  cliente AS (
    SELECT s.doc,
           r.razao_social AS nome_radar,
           (SELECT pf.nome FROM perfil pf WHERE pf.doc = s.doc AND pf.nome IS NOT NULL ORDER BY pf.nome LIMIT 1) AS nome_perfil,
           COALESCE((SELECT sc.situacao FROM public.radar_situacao_cadastral sc
                      WHERE sc.cnpj = s.doc ORDER BY sc.lote DESC LIMIT 1), r.rfb_situacao) AS situacao,
           (v_lead.email ~* v_cont
            OR coalesce(r.email, '') ~* v_cont
            OR EXISTS (SELECT 1 FROM perfil pf WHERE pf.doc = s.doc AND coalesce(pf.email_k, '') ~* v_cont)) AS contador,
           array_agg(DISTINCT s.s ORDER BY s.s) AS todos
      FROM sinal s
      LEFT JOIN public.radar_empresas r ON r.cnpj = s.doc AND r.ja_cliente
     WHERE left(s.doc, 8) <> left(p_cnpj, 8)
     GROUP BY s.doc, r.razao_social, r.rfb_situacao, r.email
  ),
  validos AS (
    SELECT c.doc, c.nome_radar, c.nome_perfil, c.situacao,
           CASE WHEN c.contador THEN ARRAY(SELECT u FROM unnest(c.todos) u WHERE u NOT IN ('telefone', 'email') ORDER BY u)
                ELSE c.todos END AS s
      FROM cliente c
     WHERE c.nome_radar IS NOT NULL OR v_carteira
  )
  SELECT v.doc,
         COALESCE(regexp_replace(v.nome_radar, ' [0-9]{11}$', ''), v.nome_perfil),  -- sem o CPF do titular de MEI
         v.situacao,
         CASE WHEN 'pessoa' = ANY (v.s) OR cardinality(v.s) >= 2 THEN 'forte' ELSE 'media' END,
         v.s
    FROM validos v
   WHERE 'pessoa' = ANY (v.s) OR cardinality(v.s) >= 2 OR v.s = ARRAY['endereco']
   ORDER BY (CASE WHEN 'pessoa' = ANY (v.s) OR cardinality(v.s) >= 2 THEN 0 ELSE 1 END), cardinality(v.s) DESC, v.doc
   LIMIT 10;
END;
$function$;

REVOKE ALL ON FUNCTION public.radar_possiveis_vinculos(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_possiveis_vinculos(text) TO authenticated, service_role;

DO $post$
DECLARE
  v_md5 text;
  v_idx text;
BEGIN
  FOREACH v_idx IN ARRAY ARRAY['idx_radar_empresas_email_norm', 'idx_radar_empresas_cep',
                               'idx_radar_empresas_socios_arr', 'idx_radar_empresas_titular_mei'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                    WHERE c.relname = v_idx AND i.indisvalid AND i.indrelid = 'public.radar_empresas'::regclass) THEN
      RAISE EXCEPTION 'A1 FALHOU: índice % ausente ou inválido — cada ficha varreria radar_empresas inteira', v_idx;
    END IF;
  END LOOP;
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public.radar_possiveis_vinculos(text)');
  IF v_md5 IS DISTINCT FROM '797fdffd63fdc071837d2e8c906d3148' THEN
    RAISE EXCEPTION 'A2 FALHOU: radar_possiveis_vinculos vivo (md5 %) não é o corpo deste arquivo', v_md5;
  END IF;
  IF has_function_privilege('anon', 'public.radar_possiveis_vinculos(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.radar_possiveis_vinculos(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A3 FALHOU: ACL de radar_possiveis_vinculos errada (anon executa ou authenticated não executa)';
  END IF;
  IF has_function_privilege('authenticated', 'private.radar_tel_chave(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'private.radar_chave_endereco(text, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.radar_chave_endereco(text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A4 FALHOU: helper private executável pelo JWT';
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure('public.radar_possiveis_vinculos(text)')) THEN
    RAISE EXCEPTION 'A5 FALHOU: radar_possiveis_vinculos sem SECURITY DEFINER — profiles/addresses negariam a leitura';
  END IF;
  RAISE NOTICE 'radar: 4 índices, helpers fechados e radar_possiveis_vinculos (gate, ACL, corpo) provados';
END
$post$;
