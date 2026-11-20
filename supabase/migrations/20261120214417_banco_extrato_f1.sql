-- ============================================================================================
-- F1 — Extrato bancario independente (Itau): esquema, RLS, bucket, ancora manual e seed da conta
-- ============================================================================================
-- Plano: docs/superpowers/plans/2026-11-20-f1-extrato-bancario-itau.md
-- Spec:  docs/superpowers/specs/2026-11-20-integracao-bancaria-itau-design.md (v2)
-- Prova: db/test-banco-extrato-f1.sh (PG17, os dois locales, --falsificar).
--
-- Arquivo UNICO da F1, montado por tasks (nao aplicado em prod enquanto a F1 nao fecha):
--   SECAO 0  TRAVA + PRE ........................................ Task 1
--   SECAO 1  tabelas (conta, vinculo Omie, ancora, arquivo, linha)  Task 1
--   SECAO 2  RLS + privilegios ................................... Task 1
--   SECAO 3  Storage: bucket banco-extratos + policies ........... Task 1
--   SECAO 4  RPC banco_conta_registrar_ancora .................... Task 1
--   SECAO 5  seed da conta Itau por empresa (derivada do Omie) ... Task 1
--   SECAO 6  RPCs do extrato (registrar / conferido / resumo) .... Task 2 (a vir)
--   SECAO 7  sensores no ledger .................................. Task 7 (a vir)
--   SECAO 8  foto diaria do saldo Omie ........................... Task 9b (a vir)
--   SECAO 9  POS (postcondicao, sempre por ultimo) ............... Task 1 (+ as tasks seguintes)
--
-- Valores em CENTAVOS inteiros (bigint). Ausente != zero: o que falta e NULL, nunca 0.
-- Nenhum numero de agencia/conta neste arquivo: o seed le fin_contas_correntes por SELECT.
-- Leitura so por public.fin_user_can_access(company); escrita so por RPC SECURITY DEFINER.
--
-- Medido em prod (psql-ro, 2026-11-20): fin_contas_correntes(id uuid, company text, omie_ncodcc bigint,
-- descricao/banco/agencia/numero_conta/tipo text, saldo_data date, saldo_atual numeric, ativo boolean),
-- UNIQUE(company, omie_ncodcc). Contas banco='341' ativas: colacor e colacor_sc = principal (agencia
-- 4 digitos, conta 5+DV com hifen) + "Pix Itau" sem agencia/conta; oben = so a principal; colacor tem
-- ainda uma Pix inativa (fica de fora). 3 principais, 3 identidades distintas. Nenhum objeto banco_*.
-- fin_user_can_access(text) md5 prosrc 85258e752cb514dd1ddba826ce25a7fb (= repo 20260512021259),
-- EXECUTE para authenticated. pg_default_acl de public concede ALL a anon/authenticated em tabela nova
-- e EXECUTE em funcao nova -> por isso os REVOKE explicitos abaixo.
--
-- `bun run db:aplicar` fornece a transacao (por isso NAO ha BEGIN/COMMIT aqui); quem colar no SQL
-- Editor envolve em BEGIN; ... COMMIT; — colar sem envelope anula a trava.
-- ============================================================================================

-- ── SECAO 0 — TRAVA + PRE ────────────────────────────────────────────────────────────────────
DO $pre$
DECLARE
  v_t      text;
  v_marca  text;
  v_lista  text;
BEGIN
  -- TRAVA: o seed le fin_contas_correntes; segura o sync do Omie ate o COMMIT (snapshot estavel).
  PERFORM set_config('lock_timeout', '10s', true);
  LOCK TABLE public.fin_contas_correntes IN SHARE MODE;

  -- dependencias que esta migration le e nao cria
  IF to_regprocedure('public.fin_user_can_access(text)') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU dependencia: public.fin_user_can_access(text) ausente.';
  END IF;
  IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL
     OR to_regprocedure('storage.foldername(text)') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU dependencia: storage.buckets/objects/foldername ausente.';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'fin_contas_correntes'
         AND column_name IN ('company','omie_ncodcc','descricao','banco','agencia','numero_conta','tipo','ativo')) <> 8 THEN
    RAISE EXCEPTION 'PRE FALHOU dependencia: fin_contas_correntes sem as colunas que o seed le.';
  END IF;

  -- re-apply: tabela banco_* que ja existe tem de ser DESTA migration (marca no COMMENT); senao e de
  -- outra sessao e o CREATE IF NOT EXISTS a aceitaria calado com outro formato.
  FOREACH v_t IN ARRAY ARRAY['banco_conta','banco_conta_omie','banco_conta_ancora','banco_extrato_arquivo','banco_extrato_linha'] LOOP
    IF to_regclass('public.' || v_t) IS NOT NULL THEN
      v_marca := obj_description(to_regclass('public.' || v_t), 'pg_class');
      IF v_marca IS NULL OR v_marca NOT LIKE 'banco_extrato_f1:%' THEN
        RAISE EXCEPTION 'PRE FALHOU objeto_alheio: public.% ja existe sem a marca banco_extrato_f1. Nada foi criado.', v_t;
      END IF;
    END IF;
  END LOOP;

  -- seed fail-closed: uma empresa com DUAS contas Itau principais distintas nao tem "a" conta para
  -- ligar a Pix Itau. Nao chuto: aborta e a decisao volta ao founder.
  SELECT string_agg(company, ',' ORDER BY company) INTO v_lista FROM (
    SELECT fc.company
      FROM public.fin_contas_correntes fc
     WHERE fc.banco = '341' AND fc.tipo = 'CC' AND fc.ativo IS TRUE
       AND regexp_replace(coalesce(fc.agencia, ''), '[^0-9]', '', 'g') <> ''
       AND regexp_replace(coalesce(fc.numero_conta, ''), '[^0-9]', '', 'g') <> ''
     GROUP BY fc.company
    HAVING count(DISTINCT regexp_replace(fc.agencia, '[^0-9]', '', 'g') || '/' || regexp_replace(fc.numero_conta, '[^0-9]', '', 'g')) > 1
  ) d;
  IF v_lista IS NOT NULL THEN
    RAISE EXCEPTION 'PRE FALHOU duas_principais_itau: empresa(s) % com mais de uma conta Itau principal ativa. Nada foi criado.', v_lista;
  END IF;
END
$pre$;

-- ── SECAO 1 — tabelas ────────────────────────────────────────────────────────────────────────
-- A conta bancaria real. Unica no PAIS (banco, agencia, conta), nao so na empresa. Digitos puros, com DV.
-- formato / estrategia_chave: NULL ate o 1o arquivo aceito fixa-los (Task 2, decisoes 1 e 2 do plano).
CREATE TABLE IF NOT EXISTS public.banco_conta (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company           text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  banco_codigo      text NOT NULL CHECK (banco_codigo ~ '^[0-9]{3}$'),
  agencia_digitos   text NOT NULL CHECK (agencia_digitos ~ '^[0-9]+$'),
  conta_digitos     text NOT NULL CHECK (conta_digitos ~ '^[0-9]+$'),
  descricao         text,
  formato           text CHECK (formato IN ('ofx','cnab240')),
  estrategia_chave  text CHECK (estrategia_chave IN ('id_bancario','tupla')),
  ativo             boolean NOT NULL DEFAULT true,
  CONSTRAINT banco_conta_identidade_key UNIQUE (banco_codigo, agencia_digitos, conta_digitos),
  CONSTRAINT banco_conta_id_company_key UNIQUE (id, company)   -- alvo das FKs (id, company) dos filhos
);
COMMENT ON TABLE public.banco_conta IS 'banco_extrato_f1: conta bancaria real (banco/agencia/conta so digitos), 1..N contas Omie via banco_conta_omie.';

-- Uma conta Omie pertence a no maximo UMA conta bancaria (UNIQUE company+ncodcc). A company do filho
-- e a da conta (FK composta) — nunca diverge, e a RLS do filho filtra o mesmo que a do pai.
CREATE TABLE IF NOT EXISTS public.banco_conta_omie (
  banco_conta_id  uuid NOT NULL,
  company         text NOT NULL,
  omie_ncodcc     bigint NOT NULL,
  CONSTRAINT banco_conta_omie_pkey PRIMARY KEY (banco_conta_id, omie_ncodcc),
  CONSTRAINT banco_conta_omie_company_ncodcc_key UNIQUE (company, omie_ncodcc),
  CONSTRAINT banco_conta_omie_conta_fk FOREIGN KEY (banco_conta_id, company) REFERENCES public.banco_conta (id, company)
);
COMMENT ON TABLE public.banco_conta_omie IS 'banco_extrato_f1: vinculo conta bancaria -> omie_ncodcc (a principal + a Pix Itau).';

-- Ancora de saldo ao fim do dia (decisao 4 do plano). Escrita: RPC banco_conta_registrar_ancora
-- (manual) e a RPC de registro do extrato (cnab, Task 2).
CREATE TABLE IF NOT EXISTS public.banco_conta_ancora (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company                   text NOT NULL,
  banco_conta_id            uuid NOT NULL,
  data                      date NOT NULL,
  saldo_final_dia_centavos  bigint NOT NULL,
  origem                    text NOT NULL CHECK (origem IN ('cnab','manual')),
  registrado_por            uuid NOT NULL,
  registrado_em             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT banco_conta_ancora_conta_data_origem_key UNIQUE (banco_conta_id, data, origem),
  CONSTRAINT banco_conta_ancora_conta_fk FOREIGN KEY (banco_conta_id, company) REFERENCES public.banco_conta (id, company)
);
COMMENT ON TABLE public.banco_conta_ancora IS 'banco_extrato_f1: saldo ao fim do dia por conta (origem cnab|manual), ancora de arquivo sem saldo inicial.';

-- Um arquivo enviado (aceito, pendente de revisao ou recusado). Idempotencia por (conta, sha256).
-- O caminho no Storage e {banco_conta_id}/{uuid}.{ext}: o CHECK amarra o arquivo a pasta da conta.
CREATE TABLE IF NOT EXISTS public.banco_extrato_arquivo (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company                 text NOT NULL,
  banco_conta_id          uuid NOT NULL,
  formato                 text NOT NULL CHECK (formato IN ('ofx','cnab240')),
  storage_path            text NOT NULL,
  sha256                  text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  periodo_inicio          date NOT NULL,
  periodo_fim             date NOT NULL,
  saldo_inicial_centavos  bigint,
  saldo_final_centavos    bigint NOT NULL,
  qtd_linhas              integer NOT NULL CHECK (qtd_linhas >= 0),
  qtd_linhas_novas        integer NOT NULL,
  status                  text NOT NULL CHECK (status IN ('aceito','pendente_revisao','recusado')),
  motivo                  text,
  detalhe                 text,
  enviado_por             uuid NOT NULL,
  enviado_em              timestamptz NOT NULL DEFAULT now(),
  conferido_por           uuid,
  conferido_em            timestamptz,
  CONSTRAINT banco_extrato_arquivo_periodo_ck CHECK (periodo_fim >= periodo_inicio),
  CONSTRAINT banco_extrato_arquivo_novas_ck CHECK (qtd_linhas_novas BETWEEN 0 AND qtd_linhas),
  CONSTRAINT banco_extrato_arquivo_conferido_ck CHECK ((conferido_por IS NULL) = (conferido_em IS NULL)),
  CONSTRAINT banco_extrato_arquivo_path_ck CHECK (starts_with(storage_path, banco_conta_id::text || '/')),
  CONSTRAINT banco_extrato_arquivo_conta_sha_key UNIQUE (banco_conta_id, sha256),
  CONSTRAINT banco_extrato_arquivo_id_conta_company_key UNIQUE (id, banco_conta_id, company),
  CONSTRAINT banco_extrato_arquivo_conta_fk FOREIGN KEY (banco_conta_id, company) REFERENCES public.banco_conta (id, company)
);
COMMENT ON TABLE public.banco_extrato_arquivo IS 'banco_extrato_f1: arquivo de extrato enviado (status aceito|pendente_revisao|recusado).';

-- Lancamento do extrato. valor sempre > 0; o sinal mora em sentido (C/D). Idempotencia por (conta, chave).
CREATE TABLE IF NOT EXISTS public.banco_extrato_linha (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company         text NOT NULL,
  banco_conta_id  uuid NOT NULL,
  arquivo_id      uuid NOT NULL,
  data            date NOT NULL,
  sentido         char(1) NOT NULL CHECK (sentido IN ('C','D')),
  valor_centavos  bigint NOT NULL CHECK (valor_centavos > 0),
  descricao       text NOT NULL,
  documento       text,
  id_bancario     text,
  chave           text NOT NULL,
  CONSTRAINT banco_extrato_linha_conta_chave_key UNIQUE (banco_conta_id, chave),
  CONSTRAINT banco_extrato_linha_arquivo_fk FOREIGN KEY (arquivo_id, banco_conta_id, company)
    REFERENCES public.banco_extrato_arquivo (id, banco_conta_id, company)
);
COMMENT ON TABLE public.banco_extrato_linha IS 'banco_extrato_f1: lancamento do extrato (centavos > 0, sentido C|D), unico por (conta, chave).';
CREATE INDEX IF NOT EXISTS banco_extrato_linha_conta_data_idx ON public.banco_extrato_linha (banco_conta_id, data);

-- ── SECAO 2 — RLS + privilegios ──────────────────────────────────────────────────────────────
-- Leitura: fin_user_can_access(company). Sem policy de INSERT/UPDATE/DELETE: a escrita e das RPCs.
-- REVOKE ALL tira tambem TRUNCATE (que FURA a RLS) e o ALL que o default ACL de prod concede.
ALTER TABLE public.banco_conta ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.banco_conta_omie ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.banco_conta_ancora ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.banco_extrato_arquivo ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.banco_extrato_linha ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS banco_conta_select ON public.banco_conta;
CREATE POLICY banco_conta_select ON public.banco_conta FOR SELECT TO authenticated USING (public.fin_user_can_access(company));
DROP POLICY IF EXISTS banco_conta_omie_select ON public.banco_conta_omie;
CREATE POLICY banco_conta_omie_select ON public.banco_conta_omie FOR SELECT TO authenticated USING (public.fin_user_can_access(company));
DROP POLICY IF EXISTS banco_conta_ancora_select ON public.banco_conta_ancora;
CREATE POLICY banco_conta_ancora_select ON public.banco_conta_ancora FOR SELECT TO authenticated USING (public.fin_user_can_access(company));
DROP POLICY IF EXISTS banco_extrato_arquivo_select ON public.banco_extrato_arquivo;
CREATE POLICY banco_extrato_arquivo_select ON public.banco_extrato_arquivo FOR SELECT TO authenticated USING (public.fin_user_can_access(company));
DROP POLICY IF EXISTS banco_extrato_linha_select ON public.banco_extrato_linha;
CREATE POLICY banco_extrato_linha_select ON public.banco_extrato_linha FOR SELECT TO authenticated USING (public.fin_user_can_access(company));

REVOKE ALL ON TABLE public.banco_conta FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.banco_conta_omie FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.banco_conta_ancora FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.banco_extrato_arquivo FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.banco_extrato_linha FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.banco_conta, public.banco_conta_omie, public.banco_conta_ancora,
                      public.banco_extrato_arquivo, public.banco_extrato_linha TO authenticated;

-- ── SECAO 3 — Storage: bucket privado banco-extratos ─────────────────────────────────────────
-- Caminho {banco_conta_id}/{uuid}.{ext}. A company NAO vem no caminho: e sempre a da conta.
-- So INSERT e SELECT; sem UPDATE nem DELETE (o arquivo e evidencia).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('banco-extratos', 'banco-extratos', false, 10485760,
        ARRAY['text/plain', 'application/x-ofx', 'application/octet-stream'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS banco_extratos_storage_insert ON storage.objects;
CREATE POLICY banco_extratos_storage_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'banco-extratos'
    AND EXISTS (SELECT 1 FROM public.banco_conta ci
                 WHERE ci.id::text = (storage.foldername(objects.name))[1]
                   AND public.fin_user_can_access(ci.company)));
DROP POLICY IF EXISTS banco_extratos_storage_select ON storage.objects;
CREATE POLICY banco_extratos_storage_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'banco-extratos'
    AND EXISTS (SELECT 1 FROM public.banco_conta cs
                 WHERE cs.id::text = (storage.foldername(objects.name))[1]
                   AND public.fin_user_can_access(cs.company)));

-- ── SECAO 4 — RPC banco_conta_registrar_ancora (ancora MANUAL, digitada do Bankline) ──────────
-- Exige usuario com acesso a empresa DA CONTA (a company nunca vem do chamador). O dia corrente (SP)
-- ainda esta aberto: recusado. Mesmo valor de novo = idempotente (devolve o id); valor DIFERENTE para
-- a mesma (conta, data) manual = recusado (23505) — nao sobrescreve em silencio uma ancora que pode ja
-- ter servido de base para aceitar um arquivo.
CREATE OR REPLACE FUNCTION public.banco_conta_registrar_ancora(p_banco_conta_id uuid, p_data date, p_saldo_centavos bigint)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid      uuid := auth.uid();
  v_company  text;
  v_hoje     date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_id       uuid;
  v_saldo    bigint;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'banco_conta_registrar_ancora: sem usuario autenticado' USING ERRCODE = '42501';
  END IF;
  IF p_banco_conta_id IS NULL OR p_data IS NULL OR p_saldo_centavos IS NULL THEN
    RAISE EXCEPTION 'banco_conta_registrar_ancora: conta, data e saldo sao obrigatorios' USING ERRCODE = '22004';
  END IF;

  SELECT c.company INTO v_company FROM public.banco_conta c WHERE c.id = p_banco_conta_id AND c.ativo;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'banco_conta_registrar_ancora: conta bancaria inexistente ou inativa' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.fin_user_can_access(v_company) THEN
    RAISE EXCEPTION 'banco_conta_registrar_ancora: sem acesso a empresa da conta' USING ERRCODE = '42501';
  END IF;
  IF p_data >= v_hoje THEN
    RAISE EXCEPTION 'banco_conta_registrar_ancora: o dia % ainda esta aberto (hoje em SP: %)', p_data, v_hoje USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.banco_conta_ancora (company, banco_conta_id, data, saldo_final_dia_centavos, origem, registrado_por)
  VALUES (v_company, p_banco_conta_id, p_data, p_saldo_centavos, 'manual', v_uid)
  ON CONFLICT (banco_conta_id, data, origem) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT a.id, a.saldo_final_dia_centavos INTO v_id, v_saldo
      FROM public.banco_conta_ancora a
     WHERE a.banco_conta_id = p_banco_conta_id AND a.data = p_data AND a.origem = 'manual';
    IF v_saldo IS DISTINCT FROM p_saldo_centavos THEN
      RAISE EXCEPTION 'banco_conta_registrar_ancora: ja existe ancora manual de % com outro saldo', p_data USING ERRCODE = '23505';
    END IF;
  END IF;
  RETURN v_id;
END
$fn$;
REVOKE ALL ON FUNCTION public.banco_conta_registrar_ancora(uuid, date, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.banco_conta_registrar_ancora(uuid, date, bigint) TO authenticated, service_role;

-- ── SECAO 5 — seed: a conta Itau de cada empresa, derivada por SELECT de fin_contas_correntes ──
-- Principal = banco 341, tipo CC, ativa, com agencia e conta (so digitos). O PRE garantiu <= 1 por empresa.
INSERT INTO public.banco_conta (company, banco_codigo, agencia_digitos, conta_digitos, descricao)
SELECT DISTINCT ON (f.company)
       f.company, '341',
       regexp_replace(f.agencia, '[^0-9]', '', 'g'),
       regexp_replace(f.numero_conta, '[^0-9]', '', 'g'),
       f.descricao
  FROM public.fin_contas_correntes f
 WHERE f.banco = '341' AND f.tipo = 'CC' AND f.ativo IS TRUE
   AND regexp_replace(coalesce(f.agencia, ''), '[^0-9]', '', 'g') <> ''
   AND regexp_replace(coalesce(f.numero_conta, ''), '[^0-9]', '', 'g') <> ''
 ORDER BY f.company, f.omie_ncodcc
ON CONFLICT (banco_codigo, agencia_digitos, conta_digitos) DO NOTHING;

-- Liga TODAS as contas 341 ativas da empresa (a principal e a "Pix Itau") a conta Itau dela — so onde
-- a empresa tem exatamente 1 conta Itau (o PRE e a POS cobrem o resto).
INSERT INTO public.banco_conta_omie (banco_conta_id, company, omie_ncodcc)
SELECT bc.id, l.company, l.omie_ncodcc
  FROM public.fin_contas_correntes l
  JOIN public.banco_conta bc ON bc.company = l.company AND bc.banco_codigo = '341'
 WHERE l.banco = '341' AND l.ativo IS TRUE
   AND (SELECT count(*) FROM public.banco_conta b2 WHERE b2.company = l.company AND b2.banco_codigo = '341') = 1
ON CONFLICT DO NOTHING;

-- ── SECAO 6 — RPCs do extrato (Task 2) ───────────────────────────────────────────────────────
-- ── SECAO 7 — sensores no ledger (Task 7) ────────────────────────────────────────────────────
-- ── SECAO 8 — foto diaria do saldo Omie (Task 9b) ────────────────────────────────────────────

-- ── SECAO 9 — POS: o que esta migration promete, relido do catalogo e dos dados ───────────────
DO $post$
DECLARE
  v_t      text;
  v_n      int;
  v_lista  text;
BEGIN
  -- (1) as 5 tabelas existem, com RLS ligada, 1 policy (SELECT para authenticated) cada, e a marca.
  FOREACH v_t IN ARRAY ARRAY['banco_conta','banco_conta_omie','banco_conta_ancora','banco_extrato_arquivo','banco_extrato_linha'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.' || v_t) AND relrowsecurity) THEN
      RAISE EXCEPTION 'POSTCONDICAO FALHOU rls: public.% ausente ou sem RLS.', v_t;
    END IF;
    SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = v_t;
    IF v_n <> 1 OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = v_t
                                 AND cmd = 'SELECT' AND roles = '{authenticated}') THEN
      RAISE EXCEPTION 'POSTCONDICAO FALHOU policy: public.% com % policy(s) (esperado 1, SELECT, authenticated).', v_t, v_n;
    END IF;
    -- (2) privilegios: anon nada; authenticated so SELECT (sem TRUNCATE, que fura a RLS).
    IF has_table_privilege('anon', 'public.' || v_t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_table_privilege('authenticated', 'public.' || v_t, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR NOT has_table_privilege('authenticated', 'public.' || v_t, 'SELECT') THEN
      RAISE EXCEPTION 'POSTCONDICAO FALHOU privilegio: public.% com ACL fora do desenho (anon nada, authenticated so SELECT).', v_t;
    END IF;
  END LOOP;

  -- (3) bucket privado com o limite e os mimes; 2 policies (INSERT, SELECT) e nenhuma de UPDATE/DELETE.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'banco-extratos' AND public IS FALSE
                   AND file_size_limit = 10485760
                   AND allowed_mime_types = ARRAY['text/plain', 'application/x-ofx', 'application/octet-stream']) THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU bucket: banco-extratos ausente ou fora da config (privado, 10 MB, 3 mimes).';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname IN ('banco_extratos_storage_insert', 'banco_extratos_storage_select');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU storage: % de 2 policies do bucket banco-extratos.', v_n;
  END IF;

  -- (4) a RPC da ancora: SECURITY DEFINER, fechada para PUBLIC e anon, aberta para authenticated.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.banco_conta_registrar_ancora(uuid,date,bigint)') AND prosecdef)
     OR has_function_privilege('public', 'public.banco_conta_registrar_ancora(uuid,date,bigint)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.banco_conta_registrar_ancora(uuid,date,bigint)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.banco_conta_registrar_ancora(uuid,date,bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU rpc: banco_conta_registrar_ancora ausente, sem SECURITY DEFINER ou com EXECUTE fora do desenho.';
  END IF;

  -- (5) seed: cada empresa com conta Itau principal ativa tem EXATAMENTE 1 banco_conta 341, com a
  -- identidade (so digitos) da principal...
  SELECT string_agg(e.company, ',' ORDER BY e.company) INTO v_lista FROM (
    SELECT DISTINCT p.company,
           regexp_replace(p.agencia, '[^0-9]', '', 'g') AS ag,
           regexp_replace(p.numero_conta, '[^0-9]', '', 'g') AS cc
      FROM public.fin_contas_correntes p
     WHERE p.banco = '341' AND p.tipo = 'CC' AND p.ativo IS TRUE
       AND regexp_replace(coalesce(p.agencia, ''), '[^0-9]', '', 'g') <> ''
       AND regexp_replace(coalesce(p.numero_conta, ''), '[^0-9]', '', 'g') <> ''
  ) e
   WHERE (SELECT count(*) FROM public.banco_conta b WHERE b.company = e.company AND b.banco_codigo = '341') <> 1
      OR NOT EXISTS (SELECT 1 FROM public.banco_conta b WHERE b.company = e.company AND b.banco_codigo = '341'
                        AND b.agencia_digitos = e.ag AND b.conta_digitos = e.cc);
  IF v_lista IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU seed_conta: empresa(s) % sem exatamente 1 banco_conta Itau com a identidade da principal.', v_lista;
  END IF;

  -- ...e toda conta 341 ATIVA do Omie esta ligada a banco_conta Itau DA MESMA empresa.
  SELECT string_agg(a.company || ':' || a.omie_ncodcc, ',' ORDER BY a.company, a.omie_ncodcc) INTO v_lista
    FROM public.fin_contas_correntes a
   WHERE a.banco = '341' AND a.ativo IS TRUE
     AND NOT EXISTS (SELECT 1 FROM public.banco_conta_omie o JOIN public.banco_conta b ON b.id = o.banco_conta_id
                      WHERE o.company = a.company AND o.omie_ncodcc = a.omie_ncodcc AND b.banco_codigo = '341');
  IF v_lista IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU seed_vinculo: conta(s) Omie 341 ativa(s) sem vinculo: %.', v_lista;
  END IF;
END
$post$;
