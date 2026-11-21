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
--   SECAO 6  RPCs do extrato (registrar / conferido / resumo) .... Task 2
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
-- (manual). A origem 'cnab' fica reservada: na F1 o saldo de um CNAB aceito ja entra em S(d) pelo
-- proprio arquivo (saldo_abertura_centavos), sem copia em ancora.
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
  -- saldo ao fim da vespera do periodo, EFETIVO: o saldo_inicial do arquivo ou, sem ele, o derivado
  -- (saldo_final - movimentos) que a continuidade conferiu. So existe em arquivo aceito; e a ancora
  -- de S(d) e do saldo do resumo por dia (Task 2).
  saldo_abertura_centavos bigint,
  qtd_linhas              integer NOT NULL CHECK (qtd_linhas >= 0),
  qtd_linhas_novas        integer NOT NULL,
  status                  text NOT NULL CHECK (status IN ('aceito','pendente_revisao','recusado')),
  motivo                  text,
  detalhe                 text,
  enviado_por             uuid NOT NULL,
  enviado_em              timestamptz NOT NULL DEFAULT now(),
  -- quando o BANCO gerou o arquivo (DTSERVER do OFX / data+hora do header CNAB), vindo da edge com fuso
  -- explicito. O dia so esta fechado se o arquivo foi gerado DEPOIS dele (Task 2, Ruling 6): um OFX
  -- baixado as 10h do dia X e enviado em X+1 traz o dia X parcial.
  gerado_em               timestamptz NOT NULL,
  conferido_por           uuid,
  conferido_em            timestamptz,
  CONSTRAINT banco_extrato_arquivo_periodo_ck CHECK (periodo_fim >= periodo_inicio),
  CONSTRAINT banco_extrato_arquivo_novas_ck CHECK (qtd_linhas_novas BETWEEN 0 AND qtd_linhas),
  CONSTRAINT banco_extrato_arquivo_conferido_ck CHECK ((conferido_por IS NULL) = (conferido_em IS NULL)),
  CONSTRAINT banco_extrato_arquivo_conferido_aceito_ck CHECK (conferido_por IS NULL OR status = 'aceito'),
  CONSTRAINT banco_extrato_arquivo_abertura_ck CHECK ((status = 'aceito') = (saldo_abertura_centavos IS NOT NULL)
    AND (saldo_inicial_centavos IS NULL OR saldo_abertura_centavos IS NULL OR saldo_abertura_centavos = saldo_inicial_centavos)),
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
-- O EXISTS roda como o CHAMADOR, entao a RLS de banco_conta ja esconde a conta alheia; o
-- fin_user_can_access abaixo e defesa em profundidade (vale se a RLS de banco_conta afrouxar).
-- A prova falsifica as duas camadas juntas e o vinculo pasta->conta sozinho.
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
-- ter servido de base para aceitar um arquivo. Valor que diverge do S(d) de um arquivo ACEITO do mesmo
-- dia = recusado (23514, marca ANCORA_DIVERGE_DO_ARQUIVO).
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
  -- mesma trava do banco_extrato_registrar: a ancora nao entra no meio de uma avaliacao de continuidade
  PERFORM pg_advisory_xact_lock(hashtext(p_banco_conta_id::text));

  -- a ancora tem de bater com o S(d) que um arquivo ACEITO ja da para o dia (Ruling 7): divergiu = 23514
  -- com a marca ANCORA_DIVERGE_DO_ARQUIVO, nada gravado. Sem isso, uma ancora digitada errada depois do
  -- arquivo encunharia a conta (todo upload futuro do trecho viraria descontinuidade_saldo). Depende de
  -- READ COMMITTED: a leitura abaixo, apos a trava, ve o que o registrar ja comitou. Substituicao/remocao
  -- de ancora nao existe na F1 (Ruling 4): correcao = operacao master via SQL documentada.
  SELECT s.saldo_centavos INTO v_saldo
    FROM public.banco_extrato_saldos_conhecidos(p_banco_conta_id, p_data, p_data) s
   WHERE s.fonte = 'arquivo' AND s.saldo_centavos <> p_saldo_centavos
   LIMIT 1;
  IF v_saldo IS NOT NULL THEN
    RAISE EXCEPTION 'banco_conta_registrar_ancora: ANCORA_DIVERGE_DO_ARQUIVO em % (ancora=% arquivo_aceito=%)',
      p_data, p_saldo_centavos, v_saldo USING ERRCODE = '23514';
  END IF;
  v_saldo := NULL;

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
-- Uma fonte da verdade por dia:
--   * cobertura de d  = existe arquivo ACEITO com d em [periodo_inicio, periodo_fim];
--   * movimento de d  = as linhas gravadas de d (so o 1o aceito que cobre d grava; os seguintes
--     provaram ter o MESMO multiconjunto e nao gravam nada nesse dia);
--   * S(d) (saldo conhecido ao fim de d) = saldo_abertura do arquivo aceito + movimentos de
--     periodo_inicio ate d, para d em [periodo_inicio - 1, periodo_fim], e as ancoras da conta.
-- banco_extrato_saldos_conhecidos e o UNICO lugar que calcula S(d): o registrar confere contra ele
-- e o resumo por dia le dele. SECURITY INVOKER: chamado pelo resumo (como o usuario) a RLS vale;
-- chamado pelo registrar (DEFINER) le tudo da conta. Por isso tem EXECUTE para authenticated — e
-- leitura pura, sob RLS, sem nada que o usuario ja nao leia nas tabelas.
CREATE OR REPLACE FUNCTION public.banco_extrato_saldos_conhecidos(p_banco_conta_id uuid, p_de date, p_ate date)
RETURNS TABLE (data date, saldo_centavos bigint, fonte text, fonte_id uuid)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
  WITH arq AS (
    SELECT a.id, a.periodo_inicio, a.periodo_fim, a.saldo_abertura_centavos
      FROM public.banco_extrato_arquivo a
     WHERE a.banco_conta_id = p_banco_conta_id
       AND a.status = 'aceito'
       AND a.periodo_fim >= p_de
       AND a.periodo_inicio - 1 <= p_ate
  ), mov AS (
    SELECT l.data AS d,
           sum(CASE l.sentido WHEN 'C' THEN l.valor_centavos ELSE -l.valor_centavos END)::bigint AS m
      FROM public.banco_extrato_linha l
     WHERE l.banco_conta_id = p_banco_conta_id
       AND l.data <= p_ate
       AND l.data >= (SELECT min(arq.periodo_inicio) FROM arq)
     GROUP BY l.data
  )
  -- dia coberto sem linha tem movimento ZERO de fato (o arquivo aceito diz que nada se moveu)
  SELECT dd.d, arq.saldo_abertura_centavos
               + coalesce((SELECT sum(mov.m) FROM mov WHERE mov.d BETWEEN arq.periodo_inicio AND dd.d), 0)::bigint,
         'arquivo'::text, arq.id
    FROM arq
   CROSS JOIN LATERAL (
     SELECT (arq.periodo_inicio - 1) + g AS d
       FROM generate_series(0, arq.periodo_fim - arq.periodo_inicio + 1) g
   ) dd
   WHERE dd.d BETWEEN p_de AND p_ate
  UNION ALL
  SELECT an.data, an.saldo_final_dia_centavos, ('ancora_' || an.origem)::text, an.id
    FROM public.banco_conta_ancora an
   WHERE an.banco_conta_id = p_banco_conta_id
     AND an.data BETWEEN p_de AND p_ate
$fn$;
REVOKE ALL ON FUNCTION public.banco_extrato_saldos_conhecidos(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.banco_extrato_saldos_conhecidos(uuid, date, date) TO authenticated, service_role;

-- Auxiliares de contrato do payload (puras, so o registrar usa): data ISO estrita e centavos inteiros.
-- NULL = invalido/ausente; nunca 0.
CREATE OR REPLACE FUNCTION public.banco_extrato_aux_data(p text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF p IS NULL OR p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RETURN NULL;
  END IF;
  RETURN p::date;  -- AAAA-MM-DD e inequivoco em qualquer DateStyle; 2026-02-30 -> 22008 -> NULL
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.banco_extrato_aux_data(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.banco_extrato_aux_centavos(p jsonb)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE WHEN jsonb_typeof(p) = 'number' AND p::text ~ '^-?[0-9]{1,18}$' THEN (p::text)::bigint END
$fn$;
REVOKE ALL ON FUNCTION public.banco_extrato_aux_centavos(jsonb) FROM PUBLIC, anon, authenticated;

-- banco_extrato_registrar: decide se um extrato e aceito. Chamada SO pela edge (service_role).
-- Ordem de decisao (a 1a que falha define o resultado), tudo sob a trava da conta:
--   0 conta (company DERIVADA dela)  1 idempotencia por (conta, sha256)  2 identidade  3 dia corrente
--   (3b dia nao fechado na geracao do arquivo)  4 linhas  5 fechamento  6 formato/estrategia  7 sobreposicao  8 continuidade  9 aceite.
-- pendente_revisao/recusado gravam o ARQUIVO (para a tela), nunca linhas.
-- Erro de CONTRATO do payload (campo obrigatorio ausente/malformado, bug da edge e nao do arquivo)
-- levanta 22023 e nao grava nada.
-- Concorrencia: depende de READ COMMITTED. Cada comando apos a pg_advisory_xact_lock tira snapshot NOVO
-- e ve o que a sessao anterior (que segurava a trava) comitou. Chamada dentro de uma transacao
-- REPEATABLE READ/SERIALIZABLE cujo snapshot foi tirado ANTES da trava leria dados velhos (idempotencia e
-- continuidade furadas). A edge chama por .rpc() em autocommit (READ COMMITTED): ok. Nao chame de outro jeito.
-- Contrato da edge (Task 6): `gerado_em` = timestamptz ISO COM fuso (Z ou +-hh:mm) da geracao pelo banco;
-- `descricao` de toda linha e string — arquivo sem memo manda '' (nunca null/ausente: linha_invalida).
CREATE OR REPLACE FUNCTION public.banco_extrato_registrar(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_conta_id     uuid;
  v_company      text;
  v_c_banco      text;
  v_c_agencia    text;
  v_c_conta      text;
  v_c_formato    text;
  v_c_estrategia text;
  v_ext          jsonb;
  v_linhas       jsonb;
  v_formato      text;
  v_estrategia   text;
  v_sha          text;
  v_path         text;
  v_enviado_por  uuid;
  v_hoje         date;
  v_gerado_em    timestamptz;
  v_gerado_sp    date;
  v_ini          date;
  v_fim          date;
  v_inicial      bigint;
  v_final        bigint;
  v_qtd          int;
  v_arquivo_id   uuid;
  v_status_ant   text;
  v_status       text;
  v_motivo       text;
  v_detalhe      text;
  v_abertura     bigint;
  v_soma         bigint;
  v_esperadas    int;
  v_novas        int := 0;
  v_banco        text;
  v_agencia      text;
  v_conta        text;
  v_e            jsonb;
  v_o            bigint;
  v_d            date;
  v_txt          text;
  v_s            bigint;
  v_n            bigint;
  v_fonte        text;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'banco_extrato_registrar: payload invalido (nao e objeto)' USING ERRCODE = '22023';
  END IF;

  -- 0. conta. A company vem DA CONTA, nunca do payload.
  BEGIN
    v_conta_id := (p->>'banco_conta_id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_conta_id := NULL;
  END;
  IF v_conta_id IS NULL THEN
    RETURN jsonb_build_object('status', 'recusado', 'arquivo_id', NULL, 'motivo', 'conta_desconhecida',
                              'detalhe', 'banco_conta_id ausente ou invalido', 'qtd_linhas_novas', 0);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_conta_id::text));

  SELECT c.company, c.banco_codigo, c.agencia_digitos, c.conta_digitos, c.formato, c.estrategia_chave
    INTO v_company, v_c_banco, v_c_agencia, v_c_conta, v_c_formato, v_c_estrategia
    FROM public.banco_conta c
   WHERE c.id = v_conta_id AND c.ativo;
  IF v_company IS NULL THEN
    RETURN jsonb_build_object('status', 'recusado', 'arquivo_id', NULL, 'motivo', 'conta_desconhecida',
                              'detalhe', 'conta bancaria inexistente ou inativa', 'qtd_linhas_novas', 0);
  END IF;

  -- contrato do payload
  v_formato    := p->>'formato';
  v_estrategia := p->>'estrategia_chave';
  v_sha        := p->>'sha256';
  v_path       := p->>'storage_path';
  v_hoje       := public.banco_extrato_aux_data(p->>'hoje');
  v_ext        := p->'extrato';
  BEGIN
    v_enviado_por := (p->>'enviado_por')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_enviado_por := NULL;
  END;
  IF v_formato IS NULL OR v_formato NOT IN ('ofx', 'cnab240') THEN
    RAISE EXCEPTION 'banco_extrato_registrar: payload invalido (formato)' USING ERRCODE = '22023';
  END IF;
  IF v_estrategia IS NULL OR v_estrategia NOT IN ('id_bancario', 'tupla') THEN
    RAISE EXCEPTION 'banco_extrato_registrar: payload invalido (estrategia_chave)' USING ERRCODE = '22023';
  END IF;
  IF v_sha IS NULL OR v_sha !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'banco_extrato_registrar: payload invalido (sha256)' USING ERRCODE = '22023';
  END IF;
  IF v_path IS NULL OR NOT starts_with(v_path, v_conta_id::text || '/') THEN
    RAISE EXCEPTION 'banco_extrato_registrar: payload invalido (storage_path fora da pasta da conta)' USING ERRCODE = '22023';
  END IF;
  IF v_enviado_por IS NULL OR v_hoje IS NULL THEN
    RAISE EXCEPTION 'banco_extrato_registrar: payload invalido (enviado_por/hoje)' USING ERRCODE = '22023';
  END IF;
  -- gerado_em: obrigatorio, ISO com fuso EXPLICITO (sem fuso dependeria do TimeZone da sessao = ambiguo)
  IF jsonb_typeof(p->'gerado_em') IS DISTINCT FROM 'string'
     OR (p->>'gerado_em') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' THEN
    RAISE EXCEPTION 'banco_extrato_registrar: payload invalido (gerado_em)' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_gerado_em := (p->>'gerado_em')::timestamptz;
  EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
    RAISE EXCEPTION 'banco_extrato_registrar: payload invalido (gerado_em)' USING ERRCODE = '22023';
  END;
  v_gerado_sp := (v_gerado_em AT TIME ZONE 'America/Sao_Paulo')::date;
  IF v_ext IS NULL OR jsonb_typeof(v_ext) <> 'object' THEN
    RAISE EXCEPTION 'banco_extrato_registrar: payload invalido (extrato)' USING ERRCODE = '22023';
  END IF;
  v_ini     := public.banco_extrato_aux_data(v_ext->>'periodo_inicio');
  v_fim     := public.banco_extrato_aux_data(v_ext->>'periodo_fim');
  v_final   := public.banco_extrato_aux_centavos(v_ext->'saldo_final_centavos');
  v_inicial := public.banco_extrato_aux_centavos(v_ext->'saldo_inicial_centavos');
  v_linhas  := v_ext->'linhas';
  IF v_ini IS NULL OR v_fim IS NULL OR v_fim < v_ini THEN
    RAISE EXCEPTION 'banco_extrato_registrar: payload invalido (periodo)' USING ERRCODE = '22023';
  END IF;
  IF v_final IS NULL THEN
    RAISE EXCEPTION 'banco_extrato_registrar: payload invalido (saldo_final_centavos)' USING ERRCODE = '22023';
  END IF;
  -- saldo_inicial: ausente/null = SEM saldo inicial (nunca 0); presente e nao inteiro = contrato quebrado
  IF v_inicial IS NULL AND coalesce(jsonb_typeof(v_ext->'saldo_inicial_centavos'), 'null') <> 'null' THEN
    RAISE EXCEPTION 'banco_extrato_registrar: payload invalido (saldo_inicial_centavos)' USING ERRCODE = '22023';
  END IF;
  IF v_linhas IS NULL OR jsonb_typeof(v_linhas) <> 'array' THEN
    RAISE EXCEPTION 'banco_extrato_registrar: payload invalido (linhas)' USING ERRCODE = '22023';
  END IF;
  v_qtd := jsonb_array_length(v_linhas);

  -- 1. idempotencia: aceito = ja_importado; outro status = reavalia e atualiza ESSA linha.
  SELECT a.id, a.status INTO v_arquivo_id, v_status_ant
    FROM public.banco_extrato_arquivo a
   WHERE a.banco_conta_id = v_conta_id AND a.sha256 = v_sha;
  IF v_status_ant = 'aceito' THEN
    RETURN jsonb_build_object('status', 'ja_importado', 'arquivo_id', v_arquivo_id, 'motivo', NULL,
                              'detalhe', NULL, 'qtd_linhas_novas', 0);
  END IF;

  <<avalia>>
  BEGIN
    -- 2. identidade (so digitos). O codigo do banco compara SEM zeros a esquerda (o OFX do Itau traz
    --    BANKID 0341; banco_conta guarda 341). '000' vira '' = ausente. Agencia e conta: exatas.
    v_banco   := ltrim(regexp_replace(coalesce(v_ext->>'banco', ''), '[^0-9]', '', 'g'), '0');
    v_agencia := regexp_replace(coalesce(v_ext->>'agencia', ''), '[^0-9]', '', 'g');
    v_conta   := regexp_replace(coalesce(v_ext->>'conta', ''), '[^0-9]', '', 'g');
    IF v_banco = '' OR v_agencia = '' OR v_conta = '' THEN
      v_status := 'recusado'; v_motivo := 'identidade_incompleta';
      v_detalhe := format('banco=%s agencia=%s conta=%s', v_banco <> '', v_agencia <> '', v_conta <> '');
      EXIT avalia;
    END IF;
    IF v_banco <> ltrim(v_c_banco, '0') OR v_agencia <> v_c_agencia OR v_conta <> v_c_conta THEN
      v_status := 'recusado'; v_motivo := 'conta_divergente';
      v_detalhe := format('banco_confere=%s agencia_confere=%s conta_confere=%s',
                          v_banco = ltrim(v_c_banco, '0'), v_agencia = v_c_agencia, v_conta = v_c_conta);
      EXIT avalia;
    END IF;

    -- 3. o dia corrente (SP, calculado pela edge) ainda esta aberto
    IF v_fim >= v_hoje THEN
      v_status := 'recusado'; v_motivo := 'periodo_inclui_dia_corrente';
      v_detalhe := format('periodo_fim=%s hoje=%s', v_fim, v_hoje);
      EXIT avalia;
    END IF;
    -- 3b. ...e o dia ainda estava aberto quando o BANCO gerou o arquivo (Ruling 6): baixado as 10h do dia X
    --     e enviado em X+1, o arquivo traz o dia X PARCIAL. Motivo proprio (o dia corrente e o do upload).
    IF v_fim >= v_gerado_sp THEN
      v_status := 'recusado'; v_motivo := 'dia_nao_fechado_na_geracao';
      v_detalhe := format('periodo_fim=%s gerado_em_sp=%s', v_fim, v_gerado_sp);
      EXIT avalia;
    END IF;

    -- 4. linhas: forma, periodo e chave unica no proprio arquivo
    FOR v_e, v_o IN SELECT t.e, t.o FROM jsonb_array_elements(v_linhas) WITH ORDINALITY t(e, o) LOOP
      v_txt := NULL;
      IF jsonb_typeof(v_e) <> 'object' THEN
        v_txt := 'nao e objeto';
      ELSE
        v_d := public.banco_extrato_aux_data(v_e->>'data');
        IF v_d IS NULL THEN
          v_txt := 'data invalida';
        ELSIF v_d < v_ini OR v_d > v_fim THEN
          v_txt := format('data %s fora do periodo', v_d);
        ELSIF coalesce(v_e->>'sentido', '') NOT IN ('C', 'D') THEN
          v_txt := 'sentido invalido';
        ELSIF public.banco_extrato_aux_centavos(v_e->'valor_centavos') IS NULL
           OR public.banco_extrato_aux_centavos(v_e->'valor_centavos') <= 0 THEN
          v_txt := 'valor_centavos invalido';
        ELSIF jsonb_typeof(v_e->'chave') IS DISTINCT FROM 'string' OR v_e->>'chave' = '' THEN
          v_txt := 'chave ausente';
        ELSIF jsonb_typeof(v_e->'descricao') IS DISTINCT FROM 'string' THEN
          v_txt := 'descricao ausente';
        ELSIF coalesce(jsonb_typeof(v_e->'documento'), 'null') NOT IN ('null', 'string')
           OR coalesce(jsonb_typeof(v_e->'id_bancario'), 'null') NOT IN ('null', 'string') THEN
          v_txt := 'documento/id_bancario invalido';
        END IF;
      END IF;
      IF v_txt IS NOT NULL THEN
        v_status := 'recusado'; v_motivo := 'linha_invalida';
        v_detalhe := format('linha %s: %s', v_o, v_txt);
        EXIT avalia;
      END IF;
    END LOOP;
    SELECT x.chave INTO v_txt
      FROM jsonb_to_recordset(v_linhas) AS x(chave text)
     GROUP BY x.chave HAVING count(*) > 1
     ORDER BY x.chave LIMIT 1;
    IF v_txt IS NOT NULL THEN
      v_status := 'recusado'; v_motivo := 'linha_invalida';
      v_detalhe := format('chave repetida no arquivo: %s', v_txt);
      EXIT avalia;
    END IF;

    SELECT coalesce(sum(CASE x.sentido WHEN 'C' THEN x.valor_centavos ELSE -x.valor_centavos END), 0)::bigint
      INTO v_soma
      FROM jsonb_to_recordset(v_linhas) AS x(sentido text, valor_centavos bigint);

    -- 5. fechamento em centavos (so com saldo inicial; sem ele, quem ancora e o passo 8)
    IF v_inicial IS NOT NULL AND v_inicial + v_soma <> v_final THEN
      v_status := 'recusado'; v_motivo := 'nao_fecha';
      v_detalhe := format('diferenca_centavos=%s calculado=%s informado=%s',
                          v_inicial + v_soma - v_final, v_inicial + v_soma, v_final);
      EXIT avalia;
    END IF;

    -- 6. um formato e uma estrategia de chave por conta
    IF (v_c_formato IS NOT NULL AND v_c_formato <> v_formato)
       OR (v_c_estrategia IS NOT NULL AND v_c_estrategia <> v_estrategia) THEN
      v_status := 'pendente_revisao'; v_motivo := 'formato_diferente';
      v_detalhe := format('conta=%s/%s arquivo=%s/%s', v_c_formato, v_c_estrategia, v_formato, v_estrategia);
      EXIT avalia;
    END IF;

    -- 7. sobreposicao: em todo dia ja coberto, o multiconjunto (chave, sentido, valor) do arquivo e
    --    IGUAL ao das linhas gravadas (nas duas direcoes — subconjunto nao basta).
    SELECT dd.d INTO v_d
      FROM (SELECT v_ini + g AS d FROM generate_series(0, v_fim - v_ini) g) dd
     WHERE EXISTS (SELECT 1 FROM public.banco_extrato_arquivo a
                    WHERE a.banco_conta_id = v_conta_id AND a.status = 'aceito'
                      AND dd.d BETWEEN a.periodo_inicio AND a.periodo_fim)
       AND (EXISTS (SELECT x.chave, x.sentido, x.valor_centavos
                      FROM jsonb_to_recordset(v_linhas) AS x(data date, sentido text, valor_centavos bigint, chave text)
                     WHERE x.data = dd.d
                    EXCEPT ALL
                    SELECT l.chave, l.sentido::text, l.valor_centavos
                      FROM public.banco_extrato_linha l
                     WHERE l.banco_conta_id = v_conta_id AND l.data = dd.d)
            OR EXISTS (SELECT l.chave, l.sentido::text, l.valor_centavos
                         FROM public.banco_extrato_linha l
                        WHERE l.banco_conta_id = v_conta_id AND l.data = dd.d
                       EXCEPT ALL
                       SELECT x.chave, x.sentido, x.valor_centavos
                         FROM jsonb_to_recordset(v_linhas) AS x(data date, sentido text, valor_centavos bigint, chave text)
                        WHERE x.data = dd.d))
     ORDER BY dd.d LIMIT 1;
    IF v_d IS NOT NULL THEN
      v_status := 'pendente_revisao'; v_motivo := 'sobreposicao_divergente';
      v_detalhe := format('data=%s', v_d);
      EXIT avalia;
    END IF;
    -- ...e nenhuma chave de dia NOVO ja existe na conta em outro dia (o ON CONFLICT do aceite a
    -- engoliria e o dia ficaria com menos linhas que o arquivo).
    SELECT x.chave INTO v_txt
      FROM jsonb_to_recordset(v_linhas) AS x(data date, chave text)
     WHERE EXISTS (SELECT 1 FROM public.banco_extrato_linha l WHERE l.banco_conta_id = v_conta_id AND l.chave = x.chave)
       AND NOT EXISTS (SELECT 1 FROM public.banco_extrato_arquivo a
                        WHERE a.banco_conta_id = v_conta_id AND a.status = 'aceito'
                          AND x.data BETWEEN a.periodo_inicio AND a.periodo_fim)
     ORDER BY x.chave LIMIT 1;
    IF v_txt IS NOT NULL THEN
      v_status := 'pendente_revisao'; v_motivo := 'sobreposicao_divergente';
      v_detalhe := format('chave ja gravada em outro dia: %s', v_txt);
      EXIT avalia;
    END IF;

    -- 8. continuidade: N(d) = S(d) para TODO d em [inicio - 1, fim] em que S(d) existe (vespera,
    --    dias comuns e o fim contra a abertura do arquivo que comeca em fim + 1).
    --    Sem saldo inicial o arquivo e ancorado pelo FINAL: N(d) = final - movimentos depois de d, e so
    --    vale se houver S(ini - 1), a VESPERA (Ruling 5). So ela confere TODAS as linhas: N(fim) = final
    --    e identidade aritmetica, entao um S(d) no meio/fim do periodo deixaria passar sem conferencia as
    --    linhas ate d (linha omitida + final certo = aceito com abertura fabricada). Sem vespera =
    --    pendente/sem_saldo_inicial, mesmo havendo S(d) adiante. Com inicial, confere todo S(d) do intervalo.
    v_abertura := coalesce(v_inicial, v_final - v_soma);
    IF v_inicial IS NULL AND NOT EXISTS (SELECT 1 FROM public.banco_extrato_saldos_conhecidos(v_conta_id, v_ini - 1, v_ini - 1)) THEN
      v_status := 'pendente_revisao'; v_motivo := 'sem_saldo_inicial';
      v_detalhe := format('nenhum saldo conhecido na vespera %s (arquivo aceito ou ancora)', v_ini - 1);
      EXIT avalia;
    END IF;
    SELECT k.data, k.saldo_centavos, k.n, k.fonte INTO v_d, v_s, v_n, v_fonte
      FROM (SELECT s.data, s.saldo_centavos, s.fonte,
                   v_abertura + coalesce((SELECT sum(CASE x.sentido WHEN 'C' THEN x.valor_centavos ELSE -x.valor_centavos END)
                                            FROM jsonb_to_recordset(v_linhas) AS x(data date, sentido text, valor_centavos bigint)
                                           WHERE x.data <= s.data), 0)::bigint AS n
              FROM public.banco_extrato_saldos_conhecidos(v_conta_id, v_ini - 1, v_fim) s) k
     WHERE k.n <> k.saldo_centavos
     ORDER BY k.data, k.fonte LIMIT 1;
    IF v_d IS NOT NULL THEN
      v_status := 'pendente_revisao'; v_motivo := 'descontinuidade_saldo';
      v_detalhe := format('data=%s diferenca_centavos=%s arquivo=%s conhecido=%s fonte=%s', v_d, v_n - v_s, v_n, v_s, v_fonte);
      EXIT avalia;
    END IF;

    -- 9. aceito
    v_status := 'aceito'; v_motivo := NULL; v_detalhe := NULL;
  END avalia;

  IF v_status = 'aceito' THEN
    SELECT count(*) INTO v_esperadas
      FROM jsonb_to_recordset(v_linhas) AS x(data date)
     WHERE NOT EXISTS (SELECT 1 FROM public.banco_extrato_arquivo a
                        WHERE a.banco_conta_id = v_conta_id AND a.status = 'aceito'
                          AND x.data BETWEEN a.periodo_inicio AND a.periodo_fim);
  END IF;

  IF v_arquivo_id IS NULL THEN
    INSERT INTO public.banco_extrato_arquivo (company, banco_conta_id, formato, storage_path, sha256, periodo_inicio, periodo_fim,
                                              saldo_inicial_centavos, saldo_final_centavos, saldo_abertura_centavos,
                                              qtd_linhas, qtd_linhas_novas, status, motivo, detalhe, enviado_por, gerado_em)
    VALUES (v_company, v_conta_id, v_formato, v_path, v_sha, v_ini, v_fim,
            v_inicial, v_final, CASE WHEN v_status = 'aceito' THEN v_abertura END,
            v_qtd, 0, v_status, v_motivo, v_detalhe, v_enviado_por, v_gerado_em)
    RETURNING id INTO v_arquivo_id;
  ELSE
    -- reavaliacao do MESMO arquivo (mesmo hash): a linha e atualizada, nunca duplicada. O storage_path e o
    -- autor do 1o envio FICAM (mesmos bytes): a edge deve reusar o objeto ja gravado (ou apagar o seu
    -- novo) — um objeto regravado em outro path fica orfao no bucket, sem linha que aponte para ele.
    UPDATE public.banco_extrato_arquivo
       SET formato = v_formato, periodo_inicio = v_ini, periodo_fim = v_fim, gerado_em = v_gerado_em,
           saldo_inicial_centavos = v_inicial, saldo_final_centavos = v_final,
           saldo_abertura_centavos = CASE WHEN v_status = 'aceito' THEN v_abertura END,
           qtd_linhas = v_qtd, qtd_linhas_novas = 0,
           status = v_status, motivo = v_motivo, detalhe = v_detalhe
     WHERE id = v_arquivo_id;
  END IF;

  IF v_status = 'aceito' THEN
    -- so dias que nenhum OUTRO arquivo aceito cobre; cada linha conta uma vez
    INSERT INTO public.banco_extrato_linha (company, banco_conta_id, arquivo_id, data, sentido, valor_centavos,
                                            descricao, documento, id_bancario, chave)
    SELECT v_company, v_conta_id, v_arquivo_id, x.data, x.sentido, x.valor_centavos, x.descricao, x.documento, x.id_bancario, x.chave
      FROM jsonb_to_recordset(v_linhas) AS x(data date, sentido text, valor_centavos bigint, descricao text,
                                             documento text, id_bancario text, chave text)
     WHERE NOT EXISTS (SELECT 1 FROM public.banco_extrato_arquivo a
                        WHERE a.banco_conta_id = v_conta_id AND a.status = 'aceito' AND a.id <> v_arquivo_id
                          AND x.data BETWEEN a.periodo_inicio AND a.periodo_fim)
    ON CONFLICT (banco_conta_id, chave) DO NOTHING;
    GET DIAGNOSTICS v_novas = ROW_COUNT;
    IF v_novas <> v_esperadas THEN
      -- invariante: o passo 7 ja provou que nenhuma chave nova colide. Se colidiu, aborta TUDO.
      RAISE EXCEPTION 'banco_extrato_registrar: invariante violada (% linhas novas esperadas, % gravadas)', v_esperadas, v_novas
        USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.banco_extrato_arquivo SET qtd_linhas_novas = v_novas WHERE id = v_arquivo_id;
    UPDATE public.banco_conta
       SET formato = coalesce(formato, v_formato), estrategia_chave = coalesce(estrategia_chave, v_estrategia)
     WHERE id = v_conta_id;
  END IF;

  RETURN jsonb_build_object('status', v_status, 'arquivo_id', v_arquivo_id, 'motivo', v_motivo,
                            'detalhe', v_detalhe, 'qtd_linhas_novas', v_novas);
END
$fn$;
REVOKE ALL ON FUNCTION public.banco_extrato_registrar(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.banco_extrato_registrar(jsonb) TO service_role;

-- banco_extrato_marcar_conferido: o financeiro atesta que conferiu um arquivo ACEITO. Autor = auth.uid()
-- real; a company e a do arquivo. Ja conferido = idempotente (mantem o 1o autor).
CREATE OR REPLACE FUNCTION public.banco_extrato_marcar_conferido(p_arquivo_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid      uuid := auth.uid();
  v_company  text;
  v_status   text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'banco_extrato_marcar_conferido: sem usuario autenticado' USING ERRCODE = '42501';
  END IF;
  SELECT a.company, a.status INTO v_company, v_status
    FROM public.banco_extrato_arquivo a WHERE a.id = p_arquivo_id FOR UPDATE;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'banco_extrato_marcar_conferido: arquivo inexistente' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.fin_user_can_access(v_company) THEN
    RAISE EXCEPTION 'banco_extrato_marcar_conferido: sem acesso a empresa do arquivo' USING ERRCODE = '42501';
  END IF;
  IF v_status <> 'aceito' THEN
    RAISE EXCEPTION 'banco_extrato_marcar_conferido: so arquivo aceito e conferido (status %)', v_status USING ERRCODE = '22023';
  END IF;
  UPDATE public.banco_extrato_arquivo
     SET conferido_por = v_uid, conferido_em = now()
   WHERE id = p_arquivo_id AND conferido_por IS NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.banco_extrato_marcar_conferido(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.banco_extrato_marcar_conferido(uuid) TO authenticated, service_role;

-- banco_extrato_resumo_dia: um registro por dia de [p_de, p_ate], SOB RLS (INVOKER).
-- Dia sem cobertura: coberto=false e os tres valores NULL (ausente != zero). Dia coberto sem movimento:
-- 0, 0 e o saldo. O saldo vem de banco_extrato_saldos_conhecidos (fonte 'arquivo'); se dois arquivos
-- aceitos divergirem no mesmo dia (nao deveria: a continuidade impede), o saldo e NULL, nunca um chute.
CREATE OR REPLACE FUNCTION public.banco_extrato_resumo_dia(p_banco_conta_id uuid, p_de date, p_ate date)
RETURNS TABLE (data date, coberto boolean, creditos_centavos bigint, debitos_centavos bigint, saldo_final_dia_centavos bigint)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
#variable_conflict use_column
BEGIN
  IF p_banco_conta_id IS NULL OR p_de IS NULL OR p_ate IS NULL THEN
    RAISE EXCEPTION 'banco_extrato_resumo_dia: conta, de e ate sao obrigatorios' USING ERRCODE = '22004';
  END IF;
  IF p_ate < p_de OR p_ate - p_de > 400 THEN
    RAISE EXCEPTION 'banco_extrato_resumo_dia: intervalo invalido (de % ate %, maximo 401 dias)', p_de, p_ate USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH dias AS (
    SELECT p_de + g AS d FROM generate_series(0, p_ate - p_de) g
  ), cob AS (
    SELECT dias.d,
           EXISTS (SELECT 1 FROM public.banco_extrato_arquivo a
                    WHERE a.banco_conta_id = p_banco_conta_id AND a.status = 'aceito'
                      AND dias.d BETWEEN a.periodo_inicio AND a.periodo_fim) AS coberto
      FROM dias
  ), mov AS (
    SELECT l.data AS d,
           sum(l.valor_centavos) FILTER (WHERE l.sentido = 'C')::bigint AS cred,
           sum(l.valor_centavos) FILTER (WHERE l.sentido = 'D')::bigint AS deb
      FROM public.banco_extrato_linha l
     WHERE l.banco_conta_id = p_banco_conta_id AND l.data BETWEEN p_de AND p_ate
     GROUP BY l.data
  ), sal AS (
    SELECT s.data AS d,
           CASE WHEN count(DISTINCT s.saldo_centavos) = 1 THEN min(s.saldo_centavos) END AS saldo
      FROM public.banco_extrato_saldos_conhecidos(p_banco_conta_id, p_de, p_ate) s
     WHERE s.fonte = 'arquivo'
     GROUP BY s.data
  )
  SELECT c.d,
         c.coberto,
         CASE WHEN c.coberto THEN coalesce(m.cred, 0) END,
         CASE WHEN c.coberto THEN coalesce(m.deb, 0) END,
         CASE WHEN c.coberto THEN s.saldo END
    FROM cob c
    LEFT JOIN mov m ON m.d = c.d
    LEFT JOIN sal s ON s.d = c.d
   ORDER BY c.d;
END
$fn$;
REVOKE ALL ON FUNCTION public.banco_extrato_resumo_dia(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.banco_extrato_resumo_dia(uuid, date, date) TO authenticated, service_role;

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

  -- (6) RPCs do extrato (Task 2): SECURITY DEFINER so onde o desenho pede, e o ACL de cada uma.
  --     assinatura | secdef | authenticated | service_role   (PUBLIC e anon: NUNCA)
  SELECT string_agg(f.sig, ', ' ORDER BY f.sig) INTO v_lista
    FROM (VALUES ('public.banco_extrato_registrar(jsonb)',                   true,  false, true),
                 ('public.banco_extrato_marcar_conferido(uuid)',             true,  true,  true),
                 ('public.banco_extrato_resumo_dia(uuid,date,date)',          false, true,  true),
                 ('public.banco_extrato_saldos_conhecidos(uuid,date,date)',   false, true,  true),
                 ('public.banco_extrato_aux_data(text)',                     false, false, NULL),
                 ('public.banco_extrato_aux_centavos(jsonb)',                false, false, NULL)) f(sig, secdef, auth, srv)
   WHERE to_regprocedure(f.sig) IS NULL
      OR (SELECT pr.prosecdef FROM pg_proc pr WHERE pr.oid = to_regprocedure(f.sig)) IS DISTINCT FROM f.secdef
      OR has_function_privilege('public', f.sig, 'EXECUTE')
      OR has_function_privilege('anon', f.sig, 'EXECUTE')
      OR has_function_privilege('authenticated', f.sig, 'EXECUTE') IS DISTINCT FROM f.auth
      OR (f.srv IS NOT NULL AND has_function_privilege('service_role', f.sig, 'EXECUTE') IS DISTINCT FROM f.srv);
  IF v_lista IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU rpc_extrato: % ausente(s), com SECURITY DEFINER trocado ou EXECUTE fora do desenho.', v_lista;
  END IF;
END
$post$;
