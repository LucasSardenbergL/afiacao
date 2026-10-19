-- ============================================================================================
-- Identidade Omie por DOCUMENTO aceita CNPJ ALFANUMÉRICO válido (RFB jul/2026) — follow-up 1 do #3180
-- ============================================================================================
-- O #3180 fez os ESCRITORES das fontes de cliente preservarem as letras de um CNPJ alfanumérico
-- válido (`normalizarDocumento`, supabase/functions/_shared/cnpj-alfanumerico.ts). Mas a identidade
-- continuava mutilando do lado SQL:
--   · `omie_sync_identity_snapshot` chaveava o profile por `regexp_replace(document, '\D', '', 'g')`
--     (+ length >= 11): o profile AEG12345678909 virava a chave 12345678909 e casava com o cliente
--     Omie NUMÉRICO 12345678909 de OUTRA pessoa (Codex ALTO do #3180). A edge só fecha o caso em que
--     os DOIS docs aparecem no mesmo run do Omie; "profile alfanumérico sem gêmeo no Omie" só fecha aqui.
--   · o CHECK de `omie_customer_account_map.evidence_document_normalized` (^[0-9]{11,}$) recusava a
--     evidência alfanumérica que o escritor passou a gravar → vínculo automático impossível.
-- Medido em prod em 2026-10-19 (psql-ro): 0 documentos com letra em profiles (5.668) e 0 em
-- evidence_document_normalized (16.122 linhas, nenhuma viola o CHECK novo) — preventivo, sem acervo.
--
-- O que faz (idempotente; envelope BEGIN/COMMIT porque o caminho é SQL Editor/MCP — a função é do
-- `postgres`, fora do alcance do `db:aplicar`):
--   1) `cnpj_alfanumerico_valido(text)` — DV mod-11 do CNPJ alfanumérico (espelho SQL de `dvCnpj`/
--      `cnpjValido` do helper TS; para numérico coincide com a regra clássica). IMMUTABLE.
--   2) `normalizar_documento(text)` — a chave: alnum = upper + btrim, só documento CRU ou com a MÁSCARA
--      exata (regra do #3192), sem separadores, quando tem letra E é CNPJ alfanumérico válido (DV);
--      senão só-dígitos (byte-idêntico ao de hoje).
--   3) CHECK `ocam_evidence_document_normalizado_chk` → ^([0-9]{11,}|[0-9A-Z]{12}[0-9]{2})$
--      (recriado só se a definição divergir).
--   4) `omie_sync_identity_snapshot(text)`: doc_valid deriva a chave por `normalizar_documento`;
--      o resto do corpo (doc_agg, client_prova, client_revogado) é o do #PR-2/A2, intocado.
--   Molde TRAVA → PRE → CREATE → PÓS (sql-house-style "Recriar objeto VIVO"). A função é
--   `BEGIN ATOMIC` (prosqlbody, sem prosrc): a régua é md5(pg_get_functiondef) com search_path
--   PINADO em `public` dentro do DO — a deparse qualifica nomes pelo search_path da sessão.
--   REVOKE/GRANT reemitidos NOMEANDO as roles.
-- Prova PG17: db/test-omie-identidade-cnpj-alfanumerico.sh (com --falsificar).
-- Diário: docs/historico/omie-identidade-cnpj-alfanumerico.md
-- ============================================================================================
BEGIN;

-- TRAVA: ALTER sem efeito na função que a PRE guarda e este arquivo recria (volatilidade VIVA = s).
DO $trava$
BEGIN
  IF to_regprocedure('public.omie_sync_identity_snapshot(text)') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: omie_sync_identity_snapshot(text) não existe — aplique 20260821192817_omie_identidade_a2_client_to_user antes';
  END IF;
  ALTER FUNCTION public.omie_sync_identity_snapshot(text) STABLE;
END
$trava$;

-- PRE anti-deriva: o corpo VIVO é o predecessor revisado (PROD, psql-ro 2026-10-19) ou este arquivo.
-- Qualquer outra coisa (edição manual, outra sessão) ABORTA — nunca se sobrescreve o que não se leu.
DO $pre$
DECLARE
  v_md5 text;
BEGIN
  PERFORM set_config('search_path', 'public', true);
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_md5 FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.omie_sync_identity_snapshot(text)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('16200d4e779b573dbc88ad5a49f5e4e4', '4e8f9ec26f62cf841b5025e438a0bc7f') THEN
    RAISE EXCEPTION 'PRE FALHOU: omie_sync_identity_snapshot(text) vivo (md5 %) não é o predecessor revisado nem este arquivo', v_md5;
  END IF;
END
$pre$;

-- 1) DV do CNPJ alfanumérico — espelho de `dvCnpj`/`cnpjValido` (supabase/functions/_shared/cnpj-alfanumerico.ts):
--    valor de cada posição = código ASCII − 48 (dígito vale o próprio valor; 'A'..'Z' valem 17..42),
--    pesos 5,4,3,2,9,8,7,6,5,4,3,2 (DV1) e 6,5,4,3,2,9,8,7,6,5,4,3,2 (DV2); resto < 2 → 0, senão 11 − resto.
--    Minúscula NÃO é normalizada aqui — é inválida (fail-closed; quem normaliza é `normalizar_documento`).
CREATE OR REPLACE FUNCTION public.cnpj_alfanumerico_valido(p_doc text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE STRICT PARALLEL SAFE
SET search_path = ''
AS $$
DECLARE
  v_pesos1 constant int[] := ARRAY[5,4,3,2,9,8,7,6,5,4,3,2];
  v_pesos2 constant int[] := ARRAY[6,5,4,3,2,9,8,7,6,5,4,3,2];
  v_soma int := 0;
  v_resto int;
  v_d1 int;
  v_d2 int;
  i int;
BEGIN
  IF p_doc !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN
    RETURN false;
  END IF;
  FOR i IN 1..12 LOOP
    v_soma := v_soma + (ascii(substr(p_doc, i, 1)) - 48) * v_pesos1[i];
  END LOOP;
  v_resto := v_soma % 11;
  v_d1 := CASE WHEN v_resto < 2 THEN 0 ELSE 11 - v_resto END;
  v_soma := v_d1 * v_pesos2[13];
  FOR i IN 1..12 LOOP
    v_soma := v_soma + (ascii(substr(p_doc, i, 1)) - 48) * v_pesos2[i];
  END LOOP;
  v_resto := v_soma % 11;
  v_d2 := CASE WHEN v_resto < 2 THEN 0 ELSE 11 - v_resto END;
  RETURN substr(p_doc, 13, 2) = v_d1::text || v_d2::text;
END;
$$;

-- 2) A chave de identidade por documento — a regra de `normalizarDocumento` (mesmo arquivo TS), com o
--    aperto do Codex retroativo do #3175 (PR #3192, radar_recruzar_ja_cliente): o caminho alnum só aceita
--    o documento CRU (14 posições) ou com a MÁSCARA nas posições exatas 00.000.000/0000-00 — depois de
--    btrim + upper — e só então remove os separadores. "aeg-123.456.789-09" (CPF com anotação) NÃO vira
--    AEG12345678909 (DV válido por coincidência): cai no só-dígitos, que é o CPF de verdade. Espaço
--    interno também não é separador ("aeg 123.456.789-09"; contraexemplo do Codex no #3175).
--    · entra como chave só se TEM letra e é CNPJ alfanumérico VÁLIDO (formato + DV);
--    · senão só-dígitos — byte-idêntico ao `regexp_replace(x, '\D', '', 'g')` de sempre: o acervo
--      numérico (com máscara, com prefixo "CNPJ:", cru) produz exatamente a chave de antes.
--    Não corta por tamanho: quem decide `>= 11` é o chamador (a RPC), como hoje.
CREATE OR REPLACE FUNCTION public.normalizar_documento(p_bruto text)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN (btrim(upper(p_bruto)) ~ '^[0-9A-Z]{12}[0-9]{2}$'
          OR btrim(upper(p_bruto)) ~ '^[0-9A-Z]{2}[.][0-9A-Z]{3}[.][0-9A-Z]{3}/[0-9A-Z]{4}-[0-9]{2}$')
     AND btrim(upper(p_bruto)) ~ '[A-Z]'
     AND public.cnpj_alfanumerico_valido(regexp_replace(btrim(upper(p_bruto)), '[-./]', '', 'g'))
    THEN regexp_replace(btrim(upper(p_bruto)), '[-./]', '', 'g')
    ELSE regexp_replace(p_bruto, '\D', '', 'g')
  END
$$;

-- As duas são puras (sem dado), mas a postura é a da RPC que as chama: fechadas a anon/authenticated/
-- PUBLIC, abertas ao executor legítimo (service_role — a RPC é SECURITY INVOKER). REPLACE preserva o
-- ACL; reemitir nomeando as roles é a regra da casa (REVOKE FROM PUBLIC não tira grant explícito).
REVOKE ALL ON FUNCTION public.cnpj_alfanumerico_valido(text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.cnpj_alfanumerico_valido(text) TO service_role;
REVOKE ALL ON FUNCTION public.normalizar_documento(text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.normalizar_documento(text) TO service_role;

-- 3) CHECK da evidência: numérico ≥ 11 dígitos (como hoje) OU CNPJ alfanumérico (12 [0-9A-Z] + 2 DVs).
--    Medido em prod 2026-10-19: 16.122 linhas, 0 violariam. Recriado só se a definição divergir.
DO $chk$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_catalog.pg_constraint c
   WHERE c.conrelid = 'public.omie_customer_account_map'::regclass
     AND c.conname  = 'ocam_evidence_document_normalizado_chk';
  IF v_def IS DISTINCT FROM 'CHECK (((evidence_document_normalized IS NULL) OR (evidence_document_normalized ~ ''^([0-9]{11,}|[0-9A-Z]{12}[0-9]{2})$''::text)))' THEN
    ALTER TABLE public.omie_customer_account_map DROP CONSTRAINT IF EXISTS ocam_evidence_document_normalizado_chk;
    ALTER TABLE public.omie_customer_account_map ADD CONSTRAINT ocam_evidence_document_normalizado_chk
      CHECK (evidence_document_normalized IS NULL OR evidence_document_normalized ~ '^([0-9]{11,}|[0-9A-Z]{12}[0-9]{2})$');
  END IF;
END
$chk$;

COMMENT ON COLUMN public.omie_customer_account_map.evidence_document_normalized IS
  'PR-2/A2 + cnpj-alfanumerico: documento normalizado (só dígitos, ou CNPJ alfanumérico RFB jul/2026 com letras preservadas — mesma regra de normalizar_documento()) que PROVOU este vínculo no casamento document-first do omie-analytics-sync/syncCustomers. NULL = sem prova (linhas anteriores ao PR-2, ou fontes rpc/manual) → NÃO entra em client_to_user do omie_sync_identity_snapshot. Fail-closed por construção.';

-- 4) A RPC: só doc_valid muda. O restante do corpo é o do PR-2/A2 (20260821192817), verbatim.
CREATE OR REPLACE FUNCTION public.omie_sync_identity_snapshot(p_account text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
BEGIN ATOMIC
  WITH doc_valid AS (
    -- Chave do profile = a MESMA regra do escritor (`normalizarDocumento`, _shared/cnpj-alfanumerico.ts):
    -- numérico → só-dígitos byte-idêntico ao de antes; CNPJ alfanumérico VÁLIDO (RFB jul/2026 + DV) →
    -- letras preservadas. Antes, `regexp_replace(document, '\D', '', 'g')` mutilava AEG12345678909 em
    -- 12345678909 e o profile alfanumérico casava com o cliente Omie NUMÉRICO de outra pessoa
    -- (Codex ALTO do #3180). O corte `>= 11` segue o de sempre.
    SELECT public.normalizar_documento(p.document) AS doc, p.user_id
    FROM public.profiles p
    WHERE p.document IS NOT NULL
      AND length(public.normalizar_documento(p.document)) >= 11
  ),
  doc_agg AS (
    SELECT doc,
           count(DISTINCT user_id) AS n_users,
           min(user_id::text)      AS user_id   -- único quando n_users = 1
    FROM doc_valid
    GROUP BY doc
  ),
  -- Prova positiva por conta. As 5 exigências do design §4.2/§6, nesta ordem:
  --   (a) account = p_account          → o código Omie é numerado POR CONTA; sem isto o mesmo número de
  --                                      outra conta traria o user errado (bug #4 do design).
  --   (b) source = 'document'          → v1 só documento. 'rpc'/'manual' não provam identidade por doc.
  --   (c) evidence IS NOT NULL         → sem evidência não há prova (o JOIN abaixo já o garante; o
  --                                      predicado fica explícito porque é a regra, não um efeito).
  --   (d) evidência ÚNICA              → JOIN com doc_agg WHERE n_users = 1 (doc ambíguo NÃO prova nada:
  --                                      o design §6 manda MATAR o vínculo histórico, não preservá-lo).
  --   (e) evidência CONSISTENTE        → o dono atual daquele doc é o MESMO user do vínculo. É esta linha
  --                                      que expira o vínculo quando o doc migra de dono. Como doc_agg
  --                                      nasce de profiles, (d)+(e) já implicam "o profile ainda carrega
  --                                      esse doc" — a 6ª exigência do design é redundante, não omitida.
  -- E o TTL de 7d espelha a view omie_customer_account_map_fresco, que é o que este mapa sobrepõe no
  -- leitor: fora da janela da view a prova não teria nada a corrigir.
  client_prova AS (
    SELECT m.omie_codigo_cliente::text AS codigo, d.user_id
    FROM public.omie_customer_account_map m
    JOIN doc_agg d
      ON d.doc     = m.evidence_document_normalized
     AND d.n_users = 1
     AND d.user_id = m.user_id::text
    WHERE m.account = p_account
      AND m.source  = 'document'
      AND m.evidence_document_normalized IS NOT NULL
      AND m.updated_at >= now() - interval '7 days'
  ),
  -- REVOGAÇÃO — o par indispensável de client_prova (achado do challenge Codex xhigh, 2026-08-21).
  -- Sem ela a prova apenas OMITE o vínculo, e omitir NÃO corrige nada: o leitor continua servindo o
  -- vínculo obsoleto que já está no cache da view. Pior, o argumento "o TTL de 7d expira sozinho" é
  -- FALSO — `register_carteira_member` (conferida em prod) faz `ON CONFLICT ... updated_at = now()`
  -- SEM tocar a evidência e trocando `source` para 'rpc': a linha errada renova o frescor para sempre.
  -- Por isso a revogação NÃO se restringe a `source='document'` (isso deixaria escapar exatamente a
  -- linha que aquele writer converteu) — basta TER evidência que não sustenta mais o vínculo.
  -- Mas `manual` FICA DE FORA: é override HUMANO, e o repo já lhe dá imunidade explícita ao fail-closed
  -- automático (o delete de ambíguos do syncCustomers filtra `source IN ('document','rpc')` pelo mesmo
  -- motivo). Revogar um `manual` faria a evidência histórica derrubar uma decisão de gente — e o
  -- fallback poderia atribuir o pedido a outro user, contra o que a pessoa decidiu. 2ª rodada do
  -- challenge Codex xhigh.
  -- `evidence IS NULL` continua FORA daqui: é o "sem prova, nunca houve" das linhas antigas, que
  -- degrada para o status quo em vez de jogar 10.822 códigos no fallback da API do Omie.
  -- Disjunto de client_prova por construção: UNIQUE(omie_codigo_cliente, account) garante 1 linha por
  -- código/conta, e os predicados são a negação um do outro. O parser do edge assere essa disjunção.
  client_revogado AS (
    SELECT m.omie_codigo_cliente::text AS codigo
    FROM public.omie_customer_account_map m
    WHERE m.account = p_account
      AND m.source IN ('document', 'rpc')
      AND m.evidence_document_normalized IS NOT NULL
      AND m.updated_at >= now() - interval '7 days'
      AND NOT EXISTS (
        SELECT 1 FROM doc_agg d
        WHERE d.doc     = m.evidence_document_normalized
          AND d.n_users = 1
          AND d.user_id = m.user_id::text
      )
  )
  SELECT jsonb_build_object(
    'doc_to_user',
      coalesce((SELECT jsonb_object_agg(doc, user_id) FROM doc_agg WHERE n_users = 1), '{}'::jsonb),
    'ambiguous_docs',
      coalesce((SELECT jsonb_agg(doc ORDER BY doc)   FROM doc_agg WHERE n_users > 1), '[]'::jsonb),
    'client_to_user',
      coalesce((SELECT jsonb_object_agg(codigo, user_id) FROM client_prova), '{}'::jsonb),
    'revoked_client_codes',
      coalesce((SELECT jsonb_agg(codigo ORDER BY codigo) FROM client_revogado), '[]'::jsonb)
  );
END;

-- CREATE OR REPLACE preserva o ACL; reemitido nomeando as roles (o custo de um ACL resetado aqui é
-- PII — documento + user_id — exposta a anon/authenticated).
REVOKE EXECUTE ON FUNCTION public.omie_sync_identity_snapshot(text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.omie_sync_identity_snapshot(text) TO service_role;

COMMENT ON FUNCTION public.omie_sync_identity_snapshot(text) IS
  'PR-1/A1 + PR-2/A2 + cnpj-alfanumerico: identidade num snapshot atômico (sql STABLE). {doc_to_user, ambiguous_docs, client_to_user, revoked_client_codes}. A chave do profile é normalizar_documento(document) (numérico só-dígitos; CNPJ alfanumérico válido com letras), length >= 11. doc ambíguo (2+ users) fica FORA de doc_to_user. client_to_user só com evidência presente, única e consistente; revoked_client_codes = vínculos cuja evidência já não sustenta o user.';

-- PÓS: o estado vivo é ESTE — helpers executando certo, CHECK novo validado, corpo deste arquivo, ACL fechado.
DO $post$
DECLARE
  v_md5 text;
  v_def text;
  v_ok  boolean;
  v_fn  text;
BEGIN
  -- helpers EXECUTADOS (PL/pgSQL é late-bound: criar não prova nada): exemplo oficial da RFB,
  -- DV errado, numérico clássico, minúscula fail-closed; a chave nos 3 ramos.
  IF NOT public.cnpj_alfanumerico_valido('12ABC34501DE35')
     OR public.cnpj_alfanumerico_valido('12ABC34501DE36')
     OR NOT public.cnpj_alfanumerico_valido('11222333000181')
     OR public.cnpj_alfanumerico_valido('12abc34501de35') THEN
    RAISE EXCEPTION 'POS FALHOU: cnpj_alfanumerico_valido() não reproduz o DV do helper TS';
  END IF;
  IF public.normalizar_documento('12.abc.345/01de-35') IS DISTINCT FROM '12ABC34501DE35'
     OR public.normalizar_documento('CNPJ: 22.333.444/0001-81') IS DISTINCT FROM '22333444000181'
     OR public.normalizar_documento('aeg 123.456.789-09') IS DISTINCT FROM '12345678909'
     OR public.normalizar_documento('aeg-123.456.789-09') IS DISTINCT FROM '12345678909' THEN
    RAISE EXCEPTION 'POS FALHOU: normalizar_documento() não reproduz normalizarDocumento() do helper TS';
  END IF;

  SELECT pg_get_constraintdef(c.oid), c.convalidated INTO v_def, v_ok
    FROM pg_catalog.pg_constraint c
   WHERE c.conrelid = 'public.omie_customer_account_map'::regclass
     AND c.conname  = 'ocam_evidence_document_normalizado_chk';
  IF v_def IS DISTINCT FROM 'CHECK (((evidence_document_normalized IS NULL) OR (evidence_document_normalized ~ ''^([0-9]{11,}|[0-9A-Z]{12}[0-9]{2})$''::text)))' THEN
    RAISE EXCEPTION 'POS FALHOU: ocam_evidence_document_normalizado_chk não é o CHECK alfanumérico (def=%)', v_def;
  END IF;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'POS FALHOU: ocam_evidence_document_normalizado_chk existe mas NÃO está validada (NOT VALID)';
  END IF;

  PERFORM set_config('search_path', 'public', true);
  SELECT md5(pg_get_functiondef(p.oid)), pg_get_functiondef(p.oid) INTO v_md5, v_fn FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.omie_sync_identity_snapshot(text)');
  IF v_md5 IS DISTINCT FROM '4e8f9ec26f62cf841b5025e438a0bc7f' THEN
    RAISE EXCEPTION 'POS FALHOU: omie_sync_identity_snapshot(text) vivo (md5 %) não é o corpo deste arquivo', v_md5;
  END IF;
  IF strpos(v_fn, 'normalizar_documento(p.document)') = 0 OR strpos(v_fn, '\D') > 0 THEN
    RAISE EXCEPTION 'POS FALHOU: omie_sync_identity_snapshot(text) ainda mutila o documento em doc_valid';
  END IF;

  FOR v_fn IN SELECT unnest(ARRAY['public.omie_sync_identity_snapshot(text)', 'public.normalizar_documento(text)', 'public.cnpj_alfanumerico_valido(text)']) LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR has_function_privilege('public', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS FALHOU: % executável por anon/authenticated/PUBLIC', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS FALHOU: service_role perdeu EXECUTE em %', v_fn;
    END IF;
  END LOOP;
  RAISE NOTICE 'OMIE IDENTIDADE CNPJ ALFANUMERICO OK';
END
$post$;

-- PostgREST cacheia o schema: sem isto a 1ª chamada pós-apply pode devolver PGRST202.
NOTIFY pgrst, 'reload schema';

COMMIT;
