-- ============================================================================================
-- Radar: `radar_registrar_cadastro_omie` só marca `ja_cliente` com CONFIRMAÇÃO DO SERVIDOR
-- ============================================================================================
-- Achado ALTO do Codex (preexistente, 2026-10-20 — diário docs/historico/radar-cnpj-alfanumerico.md):
-- a RPC aceitava `p_codigo_cliente` nulo ou inventado vindo do front e marcava o lead como cliente
-- (`ja_cliente = true`, `prospeccao_status = 'virou_cliente'`). O gate só provava que quem chama é
-- gestor (`pode_ver_carteira_completa`), não que o cliente existe no Omie.
--
-- Desenho (fontes server-side medidas em prod 2026-10-21 e rejeitadas: `omie_clientes_nao_vinculados`
-- é snapshot reescrito em lote pelo omie-analytics-sync — um cliente recém-criado só aparece no próximo
-- sync; `omie_customer_account_map` exige user/profile e prospect não tem):
--   1. Ledger append-only `omie_cliente_confirmacoes`, UM escritor: a edge `omie-vendas-sync` action
--      `criar_cliente` (service_role), depois do lookup que conferiu o documento OU do IncluirCliente que
--      devolveu código. Só conta Oben e só CNPJ (o mesmo formato do Radar) — sem CPF, sem outra conta.
--   2. A RPC exige uma confirmação (oben, documento = p_cnpj, código = o informado). Ausente ou
--      divergente → RAISE 'RADAR_SEM_CONFIRMACAO_OMIE' e o lead fica na fila (precisão > recall).
--      `p_ja_existia` (do front) deixa de decidir a nota: vem do ledger (houve 'incluir' para o par?).
-- Medido em prod antes: 0 leads com `omie_codigo_cliente`/`omie_cadastrado_em` (fluxo nunca usado).
-- Envelope BEGIN/COMMIT (SQL Editor/MCP — objetos do `postgres`). Molde TRAVA → PRE → CREATE → PÓS.
-- Prova PG17: db/test-radar-cadastro-omie-confirmacao.sh (--falsificar).
-- ============================================================================================
BEGIN;

-- TRAVA, antes de ler: ALTER sem efeito (volatilidade VIVA = v). Conferida ANTES do ALTER.
DO $trava$
DECLARE
  v_vol "char";
BEGIN
  SELECT p.provolatile INTO v_vol FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.radar_registrar_cadastro_omie(text,text,boolean)');
  IF v_vol IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: radar_registrar_cadastro_omie(text,text,boolean) ausente';
  END IF;
  IF v_vol <> 'v' THEN
    RAISE EXCEPTION 'TRAVA FALHOU: radar_registrar_cadastro_omie(text,text,boolean) não é VOLATILE (%) — revise antes de recriar', v_vol;
  END IF;
  ALTER FUNCTION public.radar_registrar_cadastro_omie(text, text, boolean) VOLATILE;
END
$trava$;

-- PRE: md5(prosrc) vivo ∈ {predecessor revisado (PROD 2026-10-21 = 20261019225545), este}; atributos e ACL
-- do predecessor são os revisados (o md5 do corpo não vê um ALTER FUNCTION/REVOKE concorrente).
DO $pre$
DECLARE
  v_fn oid := to_regprocedure('public.radar_registrar_cadastro_omie(text,text,boolean)');
  v_vivo text;
  v_secdef boolean;
  v_config text[];
BEGIN
  SELECT md5(p.prosrc), p.prosecdef, p.proconfig INTO v_vivo, v_secdef, v_config
    FROM pg_catalog.pg_proc p WHERE p.oid = v_fn;
  IF v_vivo IS NULL OR (v_vivo <> '46717b268a9c44abaf09024de816c72b' AND v_vivo <> 'b537f95a00b83aab6bac3a5019ba380a' /* este:radar_registrar_cadastro_omie */) THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_registrar_cadastro_omie vivo (md5 %) não é o predecessor revisado nem este', v_vivo;
  END IF;
  IF NOT v_secdef OR v_config IS DISTINCT FROM ARRAY['search_path=public'] THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_registrar_cadastro_omie vivo mudou SECURITY/search_path (secdef=%, config=%)', v_secdef, v_config;
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('public', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_registrar_cadastro_omie vivo tem ACL divergente do predecessor revisado';
  END IF;
  -- 1ª instalação (corpo = predecessor) com o ledger JÁ existente = tabela de procedência desconhecida: as linhas
  -- dela virariam "prova" para a RPC nova. Não adotar em silêncio (Codex desenho 2026-10-21, MÉDIO 2).
  IF v_vivo = '46717b268a9c44abaf09024de816c72b' AND to_regclass('public.omie_cliente_confirmacoes') IS NOT NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: omie_cliente_confirmacoes já existe antes da 1ª instalação — procedência desconhecida, revise';
  END IF;
END
$pre$;

-- Ledger de confirmação. Append-only: service_role só SELECT/INSERT; authenticated/anon nada (RLS ligada
-- e sem policy = defesa em profundidade se alguém conceder privilégio por engano).
CREATE TABLE IF NOT EXISTS public.omie_cliente_confirmacoes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account text NOT NULL CONSTRAINT omie_cliente_confirmacoes_account_chk CHECK (account = 'oben'),
  documento text NOT NULL CONSTRAINT omie_cliente_confirmacoes_documento_chk CHECK (documento ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  codigo_cliente text NOT NULL CONSTRAINT omie_cliente_confirmacoes_codigo_chk CHECK (codigo_cliente ~ '^[1-9][0-9]{0,18}$'),
  origem text NOT NULL CONSTRAINT omie_cliente_confirmacoes_origem_chk CHECK (origem IN ('incluir', 'lookup')),
  confirmado_por uuid,
  confirmado_em timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.omie_cliente_confirmacoes IS
  'Confirmação PRODUZIDA PELO SERVIDOR de que o Omie (conta) tem o cliente <codigo_cliente> para o <documento>. '
  'Único escritor: edge omie-vendas-sync action criar_cliente (service_role). Lida por radar_registrar_cadastro_omie. '
  'Append-only. Diário: docs/historico/radar-cnpj-alfanumerico.md';
CREATE INDEX IF NOT EXISTS omie_cliente_confirmacoes_doc_idx
  ON public.omie_cliente_confirmacoes (account, documento, codigo_cliente);
ALTER TABLE public.omie_cliente_confirmacoes ENABLE ROW LEVEL SECURITY;
-- Os default privileges de prod (pg_default_acl, psql-ro 2026-10-21) dão arwdDxtm a anon/authenticated/service_role
-- e INSERT aos sandbox_exec*: um GRANT mínimo por cima NÃO os remove (Codex MÉDIO 1). Revoga a ESCRITA de todo
-- grantee que não é o dono (SELECT de quem só lê — claude_ro, sandbox_exec* — fica: a sentinela do claude_ro
-- exige "0 objetos sem SELECT"), tira tudo de PUBLIC/anon/authenticated e concede o mínimo ao service_role.
DO $acl$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT a.grantee::regrole::text AS papel
      FROM pg_catalog.pg_class c, LATERAL aclexplode(c.relacl) a
     WHERE c.oid = 'public.omie_cliente_confirmacoes'::regclass AND a.grantee <> 0 AND a.grantee <> c.relowner
  LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.omie_cliente_confirmacoes FROM %s', r.papel);
  END LOOP;
END
$acl$;
REVOKE ALL ON TABLE public.omie_cliente_confirmacoes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.omie_cliente_confirmacoes TO service_role;

-- radar_registrar_cadastro_omie: corpo de PROD + a exigência de confirmação. Assinatura preservada (o front
-- em cache do SW ainda manda os 3 parâmetros); `p_ja_existia` fica só por compatibilidade.
CREATE OR REPLACE FUNCTION public.radar_registrar_cadastro_omie(p_cnpj text, p_codigo_cliente text, p_ja_existia boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_status_atual text;
  v_codigo text := btrim(p_codigo_cliente);
  v_criado_por_nos boolean;
  v_ja_cliente boolean;
  v_codigo_atual text;
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN RAISE EXCEPTION 'cnpj inválido'; END IF;

  SELECT prospeccao_status, ja_cliente, omie_codigo_cliente INTO v_status_atual, v_ja_cliente, v_codigo_atual
    FROM public.radar_empresas WHERE cnpj = p_cnpj FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'empresa não encontrada: %', p_cnpj; END IF;

  -- Ausente ≠ confirmado: sem a linha que o SERVIDOR gravou (conta Oben + este CNPJ + este código), nada muda.
  -- Código nulo/vazio/não numérico cai aqui também (o CHECK do ledger só admite ^[1-9][0-9]{0,18}$).
  SELECT bool_or(c.origem = 'incluir') INTO v_criado_por_nos
    FROM public.omie_cliente_confirmacoes c
   WHERE c.account = 'oben' AND c.documento = p_cnpj AND c.codigo_cliente = v_codigo;
  IF v_criado_por_nos IS NULL THEN
    RAISE EXCEPTION 'RADAR_SEM_CONFIRMACAO_OMIE: o servidor não confirmou o cliente % no Omie/Oben para este CNPJ — o lead fica na fila', v_codigo;
  END IF;

  -- Repetição (resposta perdida, duas abas): a transição já está feita para ESTE código → nada a escrever.
  IF v_ja_cliente AND v_codigo_atual = v_codigo AND v_status_atual = 'virou_cliente' THEN
    RETURN jsonb_build_object('ok', true, 'deduped', true);
  END IF;

  UPDATE public.radar_empresas SET
    omie_codigo_cliente = v_codigo,
    omie_cadastrado_em = now(),
    prospeccao_status = 'virou_cliente',
    prospeccao_atualizado_em = now(),
    ja_cliente = true,
    updated_at = now()
  WHERE cnpj = p_cnpj;

  INSERT INTO public.radar_contatos (cnpj, acao, nota, criado_por, status_anterior)
  VALUES (p_cnpj, 'virou_cliente',
    CASE WHEN v_criado_por_nos
      THEN 'Cadastrado no Omie/Oben (cód. ' || v_codigo || ')'
      ELSE 'Já cadastrado no Omie/Oben (cód. ' || v_codigo || ')' END,
    v_uid, v_status_atual);

  RETURN jsonb_build_object('ok', true, 'deduped', false);
END $function$;

-- ACL: CREATE OR REPLACE preserva, mas o REVOKE/GRANT fica explícito nomeando as roles.
REVOKE ALL ON FUNCTION public.radar_registrar_cadastro_omie(text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_registrar_cadastro_omie(text, text, boolean) TO authenticated, service_role;

-- PÓS: corpo = ESTE, atributos preservados, exigência de confirmação presente no texto; tabela com RLS
-- ligada e o ACL append-only exato.
DO $pos$
DECLARE
  v_fn oid := to_regprocedure('public.radar_registrar_cadastro_omie(text,text,boolean)');
  v_tab oid := to_regclass('public.omie_cliente_confirmacoes');
  r record;
BEGIN
  SELECT p.prosrc, p.prosecdef, p.proconfig, p.provolatile INTO r FROM pg_catalog.pg_proc p WHERE p.oid = v_fn;
  IF r.prosrc IS NULL OR md5(r.prosrc) IS DISTINCT FROM 'b537f95a00b83aab6bac3a5019ba380a' /* este:radar_registrar_cadastro_omie */ THEN
    RAISE EXCEPTION 'POS FALHOU: radar_registrar_cadastro_omie não é este arquivo (md5 %)', md5(r.prosrc);
  END IF;
  IF NOT r.prosecdef OR r.proconfig IS DISTINCT FROM ARRAY['search_path=public'] OR r.provolatile <> 'v' THEN
    RAISE EXCEPTION 'POS FALHOU: radar_registrar_cadastro_omie perdeu SECURITY DEFINER/search_path=public/VOLATILE';
  END IF;
  IF position('FROM public.omie_cliente_confirmacoes c' IN r.prosrc) = 0
     OR position('IF v_criado_por_nos IS NULL THEN' IN r.prosrc) = 0 THEN
    RAISE EXCEPTION 'POS FALHOU: radar_registrar_cadastro_omie não exige a confirmação do servidor';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('public', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: ACL de radar_registrar_cadastro_omie divergente';
  END IF;
  IF v_tab IS NULL OR NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class c WHERE c.oid = v_tab) THEN
    RAISE EXCEPTION 'POS FALHOU: omie_cliente_confirmacoes ausente ou sem RLS';
  END IF;
  IF (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = v_tab)
     IS DISTINCT FROM (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = v_fn) THEN
    RAISE EXCEPTION 'POS FALHOU: omie_cliente_confirmacoes e a RPC têm donos diferentes';
  END IF;
  -- Forma exata (a re-aplicação passa pelo IF NOT EXISTS: aqui se confere que a tabela é ESTA).
  IF (SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull, ',' ORDER BY a.attnum)
        FROM pg_catalog.pg_attribute a WHERE a.attrelid = v_tab AND a.attnum > 0 AND NOT a.attisdropped)
     IS DISTINCT FROM 'id:bigint:true,account:text:true,documento:text:true,codigo_cliente:text:true,origem:text:true,confirmado_por:uuid:false,confirmado_em:timestamp with time zone:true'
     OR (SELECT count(*) FROM pg_catalog.pg_constraint k WHERE k.conrelid = v_tab AND k.convalidated) <> 5
     OR (SELECT count(*) FROM pg_catalog.pg_constraint k WHERE k.conrelid = v_tab) <> 5
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy pol WHERE pol.polrelid = v_tab) THEN
    RAISE EXCEPTION 'POS FALHOU: omie_cliente_confirmacoes não tem a forma revisada (colunas/constraints/policies)';
  END IF;
  -- ACL EFETIVO: só o service_role escreve, e só INSERT; anon/authenticated/PUBLIC não têm nada; ninguém tem
  -- privilégio de coluna.
  IF EXISTS (
       SELECT 1 FROM pg_catalog.pg_class c, LATERAL aclexplode(c.relacl) a
        WHERE c.oid = v_tab AND a.grantee <> c.relowner
          AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN ('anon', 'authenticated'))
               OR (a.privilege_type <> 'SELECT'
                   AND NOT (a.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role') AND a.privilege_type = 'INSERT'))))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = v_tab AND a.attacl IS NOT NULL)
     OR NOT has_table_privilege('service_role', v_tab, 'SELECT') OR NOT has_table_privilege('service_role', v_tab, 'INSERT') THEN
    RAISE EXCEPTION 'POS FALHOU: ACL de omie_cliente_confirmacoes não é o append-only revisado';
  END IF;
  RAISE NOTICE 'radar: radar_registrar_cadastro_omie exige confirmação do servidor (omie_cliente_confirmacoes)';
END
$pos$;

COMMIT;
