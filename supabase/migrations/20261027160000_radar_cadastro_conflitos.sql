-- ============================================================================================
-- Radar: CONFLITO de cadastro Omie registrado no SERVIDOR (achado 3 do Codex no PR #3293)
-- ============================================================================================
-- O lote de cadastro vive no localStorage por usuário e cada aba regrava o lote INTEIRO: a aba A apagava o
-- `divergente` que a aba B persistiu, e a retomada de A (sem o código visto) relia o vínculo antigo e o devolvia
-- como "recuperado" — sucesso fabricado (reproduzido pelo Codex, desenho 2026-10-27). O vínculo autoritativo nunca
-- foi sobrescrito; o que se perdia era o AVISO para um humano conferir o Omie. Agora ele mora aqui:
--   · `radar_cadastro_conflitos` — um registro ABERTO por (cnpj, motivo, código recebido); nada é apagado;
--     resolver é marcar o PRÓPRIO registro (resolvido_em/por/nota), com `versao` para concorrência otimista;
--   · `radar_registrar_cadastro_omie_v2` — ENVOLVE a v1 intacta: trava a linha da empresa FORA do bloco de exceção
--     (o rollback do bloco soltaria a trava tomada dentro dele), devolve `{ok:false, bloqueado:true}` se já há
--     conflito aberto, chama a v1 e, em RD001/RD002, grava o conflito na MESMA transação e devolve `{ok:false}`
--     — a recusa que o banco conhece não depende mais da rede/aba para virar evidência;
--   · `radar_estado_cadastro_omie` — vínculo + conflitos abertos lidos JUNTOS sob FOR SHARE (a retomada decide
--     "recuperado" sem a corrida "consultei conflitos → outra aba registrou → reli o vínculo");
--   · `radar_registrar_conflito_cadastro` — divergências vistas FORA da RPC (retomada com código ≠ vínculo,
--     `OMIE_LOOKUP_DIVERGENTE` da edge); o servidor re-confere o que sabe (RD003 se desmente);
--   · `radar_resolver_conflito_cadastro` — "conferi no Omie" com nota; `versao` vista ≠ atual → RD004.
-- A v1 NÃO muda (md5 2b3dbe0d…, 20261021120500): bundles velhos seguem lendo RD001/RD002 como erro.
-- Envelope BEGIN/COMMIT (SQL Editor/MCP — objetos do `postgres`). Molde TRAVA → PRE → CREATE → PÓS.
-- Prova PG17: db/test-radar-cadastro-conflitos.sh (--falsificar), inclusive 2 sessões concorrentes.
-- Diário: docs/historico/radar-cadastro-conflitos.md
-- ============================================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- TRAVA: as funções deste arquivo, se já existem, têm de ser VOLATILE (conferido ANTES de qualquer recriação).
DO $trava$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, p.provolatile
      FROM pg_catalog.pg_proc p
     WHERE p.oid IN (to_regprocedure('public.radar_registrar_cadastro_omie_v2(text,text,boolean)'),
                     to_regprocedure('public.radar_estado_cadastro_omie(text)'),
                     to_regprocedure('public.radar_registrar_conflito_cadastro(text,text,text,text)'),
                     to_regprocedure('public.radar_resolver_conflito_cadastro(bigint,integer,text)'),
                     to_regprocedure('public._radar_cadastro_conflito_gravar(text,text,text,text,uuid)'))
  LOOP
    IF r.provolatile <> 'v' THEN
      RAISE EXCEPTION 'TRAVA FALHOU: % não é VOLATILE (%) — revise antes de recriar', r.fn, r.provolatile;
    END IF;
  END LOOP;
END
$trava$;

-- PRE: a v2 envolve a v1 revisada (RD001/RD002 da 20261021120500) — outro corpo ABORTA. As funções deste arquivo
-- ou não existem (1ª instalação) ou são ESTE arquivo (re-aplicação). Tabela sem as funções = procedência
-- desconhecida: as linhas dela bloqueariam cadastros sem ter passado pela re-conferência.
DO $pre$
DECLARE
  v_cad oid := to_regprocedure('public.radar_registrar_cadastro_omie(text,text,boolean)');
  v_md5 text;
  r record;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = v_cad;
  IF v_md5 IS DISTINCT FROM '2b3dbe0da01ac37b07b1cb5b76be139c' THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_registrar_cadastro_omie vivo (md5 %) não é o da 20261021120500 (RD001/RD002)', v_md5;
  END IF;
  FOR r IN
    SELECT f.assinatura, f.este, md5(p.prosrc) AS vivo
      FROM (VALUES
        ('public.radar_registrar_cadastro_omie_v2(text,text,boolean)', 'b07c1a878e9930cb1a1a3c175be691d6' /* este:radar_registrar_cadastro_omie_v2 */),
        ('public.radar_estado_cadastro_omie(text)', '79dea3224bbf32ad725a83d22b29aaac' /* este:radar_estado_cadastro_omie */),
        ('public.radar_registrar_conflito_cadastro(text,text,text,text)', '366ae6f80c6a9f032b8a0ebec3ca5ea0' /* este:radar_registrar_conflito_cadastro */),
        ('public.radar_resolver_conflito_cadastro(bigint,integer,text)', 'bd0848dc353f27e459818ed5402c2533' /* este:radar_resolver_conflito_cadastro */),
        ('public._radar_cadastro_conflito_gravar(text,text,text,text,uuid)', '079f28b6c1e52e73a06068f7971b972c' /* este:_radar_cadastro_conflito_gravar */)
      ) AS f(assinatura, este)
      LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure(f.assinatura)
  LOOP
    IF r.vivo IS NOT NULL AND r.vivo <> r.este THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) não é este arquivo — revise antes de recriar', r.assinatura, r.vivo;
    END IF;
    IF r.vivo IS NULL AND to_regclass('public.radar_cadastro_conflitos') IS NOT NULL THEN
      RAISE EXCEPTION 'PRE FALHOU: radar_cadastro_conflitos já existe sem % — procedência desconhecida, revise', r.assinatura;
    END IF;
  END LOOP;
END
$pre$;

CREATE TABLE IF NOT EXISTS public.radar_cadastro_conflitos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cnpj text NOT NULL CONSTRAINT radar_cadastro_conflitos_cnpj_chk CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  motivo text NOT NULL CONSTRAINT radar_cadastro_conflitos_motivo_chk
    CHECK (motivo IN ('vinculo_divergente', 'codigo_de_outro_cnpj', 'lookup_divergente')),
  -- O que o Omie disse (só o Omie/edge/front sabem); NULL quando a divergência veio antes do código.
  codigo_recebido text CONSTRAINT radar_cadastro_conflitos_codigo_chk CHECK (codigo_recebido ~ '^[1-9][0-9]{0,18}$'),
  -- O que o SERVIDOR tinha na última observação (lido sob a trava, nunca alegado pelo cliente).
  codigo_vinculado text,
  cnpj_do_codigo text,
  -- Mensagem da ÚLTIMA observação (o registro é um resumo por chave, não o histórico das respostas do Omie).
  detalhe text NOT NULL CONSTRAINT radar_cadastro_conflitos_detalhe_chk CHECK (length(detalhe) BETWEEN 1 AND 1000),
  ocorrencias integer NOT NULL DEFAULT 1 CONSTRAINT radar_cadastro_conflitos_ocorrencias_chk CHECK (ocorrencias >= 1),
  versao integer NOT NULL DEFAULT 1 CONSTRAINT radar_cadastro_conflitos_versao_chk CHECK (versao >= 1),
  criado_por uuid NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  ultimo_por uuid NOT NULL,
  ultima_em timestamptz NOT NULL DEFAULT now(),
  resolvido_em timestamptz,
  resolvido_por uuid,
  nota_resolucao text,
  CONSTRAINT radar_cadastro_conflitos_resolucao_chk CHECK (
    (resolvido_em IS NULL AND resolvido_por IS NULL AND nota_resolucao IS NULL)
    OR (resolvido_em IS NOT NULL AND resolvido_por IS NOT NULL AND length(nota_resolucao) BETWEEN 1 AND 500))
);
COMMENT ON TABLE public.radar_cadastro_conflitos IS
  'Conflito de identidade Radar×Omie no cadastro de lead (RD001/RD002/lookup divergente) para um HUMANO conferir; '
  'conflito aberto bloqueia novo cadastro do CNPJ. Escritor único: _radar_cadastro_conflito_gravar (via v2/registrar) '
  '+ radar_resolver_conflito_cadastro. Nada é apagado. Diário: docs/historico/radar-cadastro-conflitos.md';
-- Um ABERTO por (cnpj, motivo, código recebido): duas abas que pegam o mesmo conflito somam ocorrências; depois de
-- resolvido, uma observação nova da mesma chave abre OUTRO registro (o encerrado fica).
CREATE UNIQUE INDEX IF NOT EXISTS radar_cadastro_conflitos_aberto_uniq
  ON public.radar_cadastro_conflitos (cnpj, motivo, (COALESCE(codigo_recebido, ''))) WHERE resolvido_em IS NULL;

ALTER TABLE public.radar_cadastro_conflitos ENABLE ROW LEVEL SECURITY;
-- Default privileges de prod dão arwdDxtm a anon/authenticated/service_role e INSERT aos sandbox_exec*: revoga a
-- ESCRITA de todo grantee que não é o dono (SELECT de quem só lê fica — sentinela do claude_ro) e concede o mínimo.
DO $acl$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT a.grantee::regrole::text AS papel
      FROM pg_catalog.pg_class c, LATERAL aclexplode(c.relacl) a
     WHERE c.oid = 'public.radar_cadastro_conflitos'::regclass AND a.grantee <> 0 AND a.grantee <> c.relowner
  LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.radar_cadastro_conflitos FROM %s', r.papel);
  END LOOP;
END
$acl$;
REVOKE ALL ON TABLE public.radar_cadastro_conflitos FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.radar_cadastro_conflitos TO authenticated, service_role;
DROP POLICY IF EXISTS radar_cadastro_conflitos_select_gestor ON public.radar_cadastro_conflitos;
CREATE POLICY radar_cadastro_conflitos_select_gestor ON public.radar_cadastro_conflitos FOR SELECT TO authenticated
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid()))));

-- Escritor ÚNICO de observações. INVOKER e sem EXECUTE para ninguém além do dono: só as RPCs DEFINER abaixo chegam
-- aqui, e todas já seguram a trava da linha da empresa (FOR UPDATE) — o vínculo lido é o que vale no COMMIT.
CREATE OR REPLACE FUNCTION public._radar_cadastro_conflito_gravar(p_cnpj text, p_motivo text, p_codigo_recebido text, p_detalhe text, p_uid uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_codigo text := NULLIF(btrim(p_codigo_recebido), '');
  v_detalhe text := left(NULLIF(btrim(p_detalhe), ''), 1000);
  v_vinculo text;
  v_outro text;
  v_linha public.radar_cadastro_conflitos;
BEGIN
  IF p_uid IS NULL THEN RAISE EXCEPTION 'autor obrigatório'; END IF;
  IF p_motivo IS NULL OR p_motivo NOT IN ('vinculo_divergente', 'codigo_de_outro_cnpj', 'lookup_divergente') THEN
    RAISE EXCEPTION 'motivo inválido: %', p_motivo;
  END IF;
  IF v_codigo IS NOT NULL AND v_codigo !~ '^[1-9][0-9]{0,18}$' THEN RAISE EXCEPTION 'código Omie inválido: %', v_codigo; END IF;
  IF v_detalhe IS NULL THEN RAISE EXCEPTION 'detalhe obrigatório'; END IF;

  SELECT NULLIF(btrim(e.omie_codigo_cliente), '') INTO v_vinculo FROM public.radar_empresas e WHERE e.cnpj = p_cnpj;
  IF NOT FOUND THEN RAISE EXCEPTION 'empresa não encontrada: %', p_cnpj; END IF;
  IF v_codigo IS NOT NULL THEN
    SELECT e.cnpj INTO v_outro FROM public.radar_empresas e WHERE e.omie_codigo_cliente = v_codigo AND e.cnpj <> p_cnpj;
  END IF;

  -- O servidor re-confere o que sabe; a alegação que ele DESMENTE não vira aviso (RD003). Não exige o ledger: o caso
  -- "Omie devolveu K, a confirmação não gravou, a retomada achou V≠K" é justamente evidência a guardar (Codex, c).
  IF p_motivo = 'vinculo_divergente' AND (v_codigo IS NULL OR v_vinculo IS NULL OR v_vinculo = v_codigo) THEN
    RAISE EXCEPTION 'RADAR_CONFLITO_NAO_CONFIRMADO: CNPJ % tem vínculo %, recebido % — não há divergência', p_cnpj,
      COALESCE(v_vinculo, '∅'), COALESCE(v_codigo, '∅') USING ERRCODE = 'RD003';
  END IF;
  IF p_motivo = 'codigo_de_outro_cnpj' AND v_outro IS NULL THEN
    RAISE EXCEPTION 'RADAR_CONFLITO_NAO_CONFIRMADO: cliente Omie % não está vinculado a outro CNPJ', COALESCE(v_codigo, '∅')
      USING ERRCODE = 'RD003';
  END IF;
  -- lookup_divergente: só a edge viu o Omie — relato do gestor, não verificável pelo banco (a tela diz isso).

  INSERT INTO public.radar_cadastro_conflitos AS t
    (cnpj, motivo, codigo_recebido, codigo_vinculado, cnpj_do_codigo, detalhe, criado_por, ultimo_por)
  VALUES (p_cnpj, p_motivo, v_codigo, v_vinculo, v_outro, v_detalhe, p_uid, p_uid)
  ON CONFLICT (cnpj, motivo, (COALESCE(codigo_recebido, ''))) WHERE resolvido_em IS NULL
  DO UPDATE SET ocorrencias = t.ocorrencias + 1, versao = t.versao + 1, ultima_em = now(), ultimo_por = EXCLUDED.ultimo_por,
                codigo_vinculado = EXCLUDED.codigo_vinculado, cnpj_do_codigo = EXCLUDED.cnpj_do_codigo, detalhe = EXCLUDED.detalhe
  RETURNING t.* INTO v_linha;
  RETURN to_jsonb(v_linha);
END $function$;

CREATE OR REPLACE FUNCTION public.radar_registrar_cadastro_omie_v2(p_cnpj text, p_codigo_cliente text, p_ja_existia boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_aberto public.radar_cadastro_conflitos;
  v_motivo text;
  v_msg text;
  r jsonb;
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN RAISE EXCEPTION 'cnpj inválido'; END IF;

  -- A trava da v1, tomada AQUI, fora do bloco de exceção: o rollback do bloco soltaria a trava tomada dentro dele,
  -- e o conflito seria gravado sem ela.
  PERFORM 1 FROM public.radar_empresas WHERE cnpj = p_cnpj FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'empresa não encontrada: %', p_cnpj; END IF;

  -- Conflito ABERTO bloqueia o CNPJ (inclusive vínculo igual): só um humano libera. Bloqueio não é observação nova.
  SELECT * INTO v_aberto FROM public.radar_cadastro_conflitos c
   WHERE c.cnpj = p_cnpj AND c.resolvido_em IS NULL ORDER BY c.id LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', false, 'bloqueado', true, 'conflito', to_jsonb(v_aberto));
  END IF;

  BEGIN
    r := public.radar_registrar_cadastro_omie(p_cnpj, p_codigo_cliente, p_ja_existia);
    RETURN r;
  EXCEPTION
    WHEN SQLSTATE 'RD001' THEN
      v_motivo := 'vinculo_divergente';
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    WHEN SQLSTATE 'RD002' THEN
      v_motivo := 'codigo_de_outro_cnpj';
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
  END;

  -- A recusa vira evidência na MESMA transação; retornar normalmente é o que a mantém (relançar desfaria o INSERT).
  RETURN jsonb_build_object('ok', false, 'bloqueado', false,
    'conflito', public._radar_cadastro_conflito_gravar(p_cnpj, v_motivo, p_codigo_cliente, v_msg, v_uid));
END $function$;

CREATE OR REPLACE FUNCTION public.radar_estado_cadastro_omie(p_cnpj text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_vinculo text;
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN RAISE EXCEPTION 'cnpj inválido'; END IF;
  -- FOR SHARE espera quem está gravando vínculo/conflito (FOR UPDATE): vínculo e conflitos saem do MESMO instante.
  SELECT NULLIF(btrim(e.omie_codigo_cliente), '') INTO v_vinculo FROM public.radar_empresas e WHERE e.cnpj = p_cnpj FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'empresa não encontrada: %', p_cnpj; END IF;
  RETURN jsonb_build_object(
    'vinculo', v_vinculo,
    'conflitos', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM public.radar_cadastro_conflitos c
                            WHERE c.cnpj = p_cnpj AND c.resolvido_em IS NULL), '[]'::jsonb));
END $function$;

CREATE OR REPLACE FUNCTION public.radar_registrar_conflito_cadastro(p_cnpj text, p_motivo text, p_codigo_recebido text, p_detalhe text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN RAISE EXCEPTION 'cnpj inválido'; END IF;
  PERFORM 1 FROM public.radar_empresas WHERE cnpj = p_cnpj FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'empresa não encontrada: %', p_cnpj; END IF;
  RETURN public._radar_cadastro_conflito_gravar(p_cnpj, p_motivo, p_codigo_recebido, p_detalhe, v_uid);
END $function$;

CREATE OR REPLACE FUNCTION public.radar_resolver_conflito_cadastro(p_id bigint, p_versao_vista integer, p_nota text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_nota text := left(NULLIF(btrim(p_nota), ''), 500);
  v_cnpj text;
  v_versao integer;
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  IF v_nota IS NULL THEN RAISE EXCEPTION 'nota obrigatória: diga o que foi conferido no Omie'; END IF;
  SELECT c.cnpj INTO v_cnpj FROM public.radar_cadastro_conflitos c WHERE c.id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'conflito não encontrado: %', p_id; END IF;
  -- Mesma ordem de trava das gravações (empresa → conflito): registrar × resolver se enfileiram, sem deadlock.
  PERFORM 1 FROM public.radar_empresas WHERE cnpj = v_cnpj FOR UPDATE;

  -- Concorrência otimista NO PRÓPRIO UPDATE: ocorrência registrada depois da leitura da tela (versao mudou) ou
  -- resolução de outra aba → 0 linhas → RD004; nada que ninguém viu é encerrado.
  UPDATE public.radar_cadastro_conflitos
     SET resolvido_em = now(), resolvido_por = v_uid, nota_resolucao = v_nota, versao = versao + 1
   WHERE id = p_id AND versao = p_versao_vista AND resolvido_em IS NULL
  RETURNING versao INTO v_versao;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RADAR_CONFLITO_MUDOU: o conflito % mudou ou já foi resolvido desde a leitura (versão vista %) — releia', p_id,
      COALESCE(p_versao_vista::text, '∅') USING ERRCODE = 'RD004';
  END IF;
  RETURN jsonb_build_object('ok', true, 'versao', v_versao);
END $function$;

REVOKE ALL ON FUNCTION public._radar_cadastro_conflito_gravar(text, text, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.radar_registrar_cadastro_omie_v2(text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_registrar_cadastro_omie_v2(text, text, boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.radar_estado_cadastro_omie(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_estado_cadastro_omie(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.radar_registrar_conflito_cadastro(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_registrar_conflito_cadastro(text, text, text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.radar_resolver_conflito_cadastro(bigint, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_resolver_conflito_cadastro(bigint, integer, text) TO authenticated, service_role;

-- PÓS: corpos = ESTES; search_path=public + VOLATILE; DEFINER nas 4 RPCs e INVOKER no escritor; ACL das funções e da
-- tabela; RLS ligada só com a policy de leitura; índice parcial com a definição exata; v1 intocada.
DO $pos$
DECLARE
  r record;
  v_tab oid := to_regclass('public.radar_cadastro_conflitos');
BEGIN
  FOR r IN
    SELECT f.assinatura, f.este, f.publica, p.oid, md5(p.prosrc) AS vivo, p.prosecdef, p.proconfig, p.provolatile
      FROM (VALUES
        ('public.radar_registrar_cadastro_omie_v2(text,text,boolean)', 'b07c1a878e9930cb1a1a3c175be691d6' /* este:radar_registrar_cadastro_omie_v2 */, true),
        ('public.radar_estado_cadastro_omie(text)', '79dea3224bbf32ad725a83d22b29aaac' /* este:radar_estado_cadastro_omie */, true),
        ('public.radar_registrar_conflito_cadastro(text,text,text,text)', '366ae6f80c6a9f032b8a0ebec3ca5ea0' /* este:radar_registrar_conflito_cadastro */, true),
        ('public.radar_resolver_conflito_cadastro(bigint,integer,text)', 'bd0848dc353f27e459818ed5402c2533' /* este:radar_resolver_conflito_cadastro */, true),
        ('public._radar_cadastro_conflito_gravar(text,text,text,text,uuid)', '079f28b6c1e52e73a06068f7971b972c' /* este:_radar_cadastro_conflito_gravar */, false)
      ) AS f(assinatura, este, publica)
      LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure(f.assinatura)
  LOOP
    IF r.vivo IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'POS FALHOU: % ausente ou não é este arquivo (md5 %)', r.assinatura, r.vivo;
    END IF;
    IF r.prosecdef IS DISTINCT FROM r.publica OR r.proconfig IS DISTINCT FROM ARRAY['search_path=public'] OR r.provolatile <> 'v' THEN
      RAISE EXCEPTION 'POS FALHOU: % com segurança/search_path/volatilidade divergente (%, %, %)', r.assinatura, r.prosecdef, r.proconfig, r.provolatile;
    END IF;
    IF has_function_privilege('anon', r.oid, 'EXECUTE') OR has_function_privilege('public', r.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', r.oid, 'EXECUTE') IS DISTINCT FROM r.publica
       OR has_function_privilege('service_role', r.oid, 'EXECUTE') IS DISTINCT FROM r.publica THEN
      RAISE EXCEPTION 'POS FALHOU: % com ACL divergente', r.assinatura;
    END IF;
  END LOOP;
  IF NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class c WHERE c.oid = v_tab) THEN
    RAISE EXCEPTION 'POS FALHOU: radar_cadastro_conflitos sem RLS';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_policy p WHERE p.polrelid = v_tab) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = v_tab
                     AND p.polname = 'radar_cadastro_conflitos_select_gestor' AND p.polcmd = 'r') THEN
    RAISE EXCEPTION 'POS FALHOU: radar_cadastro_conflitos tem de ter SÓ a policy de leitura do gestor';
  END IF;
  IF has_table_privilege('anon', v_tab, 'SELECT') OR has_table_privilege('public', v_tab, 'SELECT')
     OR has_table_privilege('anon', v_tab, 'INSERT') OR has_table_privilege('authenticated', v_tab, 'INSERT')
     OR has_table_privilege('authenticated', v_tab, 'UPDATE') OR has_table_privilege('authenticated', v_tab, 'DELETE')
     OR has_table_privilege('authenticated', v_tab, 'TRUNCATE') OR has_table_privilege('service_role', v_tab, 'INSERT')
     OR has_table_privilege('service_role', v_tab, 'UPDATE') OR has_table_privilege('service_role', v_tab, 'DELETE')
     OR NOT has_table_privilege('authenticated', v_tab, 'SELECT') THEN
    RAISE EXCEPTION 'POS FALHOU: ACL de radar_cadastro_conflitos divergente (só SELECT para authenticated/service_role)';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_index i
        WHERE i.indexrelid = to_regclass('public.radar_cadastro_conflitos_aberto_uniq') AND i.indrelid = v_tab
          AND i.indisunique AND i.indisvalid AND i.indisready
          AND pg_catalog.pg_get_indexdef(i.indexrelid) =
              'CREATE UNIQUE INDEX radar_cadastro_conflitos_aberto_uniq ON public.radar_cadastro_conflitos USING btree (cnpj, motivo, COALESCE(codigo_recebido, ''''::text)) WHERE (resolvido_em IS NULL)') THEN
    RAISE EXCEPTION 'POS FALHOU: índice parcial radar_cadastro_conflitos_aberto_uniq ausente, inválido ou com outra definição';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.radar_registrar_cadastro_omie(text,text,boolean)'))
       IS DISTINCT FROM '2b3dbe0da01ac37b07b1cb5b76be139c' THEN
    RAISE EXCEPTION 'POS FALHOU: radar_registrar_cadastro_omie (v1) mudou — esta migration não a recria';
  END IF;
  RAISE NOTICE 'radar_cadastro_conflitos: conflito persistido no servidor (v2 atômica, estado conjunto, resolver otimista)';
END
$pos$;

COMMIT;
