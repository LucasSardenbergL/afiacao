-- ============================================================================================
-- Radar: radar_registrar_cadastro_omie com o VÍNCULO como trava (Codex ALTO 3 do bloco 5)
-- ============================================================================================
-- Empilhada DEPOIS da 20261021120000 (confirmação do servidor via ledger `omie_cliente_confirmacoes`),
-- cujo corpo é o predecessor ÚNICO aceito pela PRE — sem ela aplicada, esta ABORTA. Mantém intactos o
-- gate, o guard do CNPJ, a exigência de confirmação (RADAR_SEM_CONFIRMACAO_OMIE) e a nota pelo ledger.
-- O que muda, sob a trava de linha (FOR UPDATE em radar_empresas — a MESMA para o lote e para a ficha):
--   · vínculo IGUAL ao recebido → no-op (nada regravado, nenhuma linha de histórico), sem exigir
--     prospeccao_status='virou_cliente': uma decisão posterior (registrar_contato_radar) não é desfeita
--     por uma retentativa (Codex 2026-10-21, (b));
--   · vínculo DIFERENTE → RAISE SQLSTATE 'RD001' (RADAR_VINCULO_DIVERGENTE) — antes, o UPDATE sobrescrevia;
--   · o MESMO código já vinculado a OUTRO CNPJ → SQLSTATE 'RD002' (RADAR_CODIGO_DE_OUTRO_CNPJ), pelo UNIQUE
--     parcial abaixo: a trava é por CNPJ, então (A,K) e (B,K) concorrentes travariam linhas diferentes.
-- Na camada ERP o fence é da edge (lookup estrito + codigo_cliente_integracao determinístico).
-- Envelope BEGIN/COMMIT (SQL Editor/MCP — objeto do `postgres`). Molde TRAVA → PRE → CREATE → PÓS.
-- Prova PG17: db/test-radar-cadastro-omie-idempotente.sh (--falsificar), inclusive 2 sessões concorrentes.
-- Diário: docs/historico/radar-cadastro-omie-idempotente.md
-- ============================================================================================

BEGIN;

-- TRAVA, antes de ler: volatilidade conferida ANTES do ALTER sem efeito (ele a normalizaria).
DO $trava$
DECLARE
  v_vol "char" := (SELECT p.provolatile FROM pg_catalog.pg_proc p
                    WHERE p.oid = to_regprocedure('public.radar_registrar_cadastro_omie(text,text,boolean)'));
BEGIN
  IF v_vol IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: radar_registrar_cadastro_omie(text,text,boolean) ausente';
  END IF;
  IF v_vol <> 'v' THEN
    RAISE EXCEPTION 'TRAVA FALHOU: radar_registrar_cadastro_omie(text,text,boolean) não é VOLATILE (%) — revise antes de recriar', v_vol;
  END IF;
  ALTER FUNCTION public.radar_registrar_cadastro_omie(text, text, boolean) VOLATILE;
END
$trava$;

-- PRE: md5(prosrc) vivo ∈ {corpo da 20261021120000 (confirmação do servidor), este}; o corpo de PROD de
-- 2026-10-21 (46717b26…, sem ledger) NÃO serve: esta versão lê o ledger. Sob a trava, atributos e ACL revisados.
DO $pre$
DECLARE
  v_fn oid := to_regprocedure('public.radar_registrar_cadastro_omie(text,text,boolean)');
  r record;
BEGIN
  SELECT md5(p.prosrc) AS vivo, p.prosecdef, p.proconfig INTO r FROM pg_catalog.pg_proc p WHERE p.oid = v_fn;
  IF r.vivo IS NULL OR r.vivo NOT IN ('b537f95a00b83aab6bac3a5019ba380a', '2b3dbe0da01ac37b07b1cb5b76be139c' /* este:radar_registrar_cadastro_omie */) THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_registrar_cadastro_omie vivo (md5 %) não é o da 20261021120000 nem este — aplique a 20261021120000 antes', r.vivo;
  END IF;
  IF NOT r.prosecdef OR r.proconfig IS DISTINCT FROM ARRAY['search_path=public'] THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_registrar_cadastro_omie vivo mudou SECURITY/search_path (secdef=%, config=%)', r.prosecdef, r.proconfig;
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('public', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_registrar_cadastro_omie vivo tem ACL divergente do predecessor revisado';
  END IF;
END
$pre$;

-- UNIQUE parcial: um cliente Omie (Oben) ↔ um CNPJ (Codex D3). Pré-voo psql-ro 2026-10-21: 0 vínculos em prod.
-- A coluna é só da conta Oben; se passar a guardar várias contas, a chave tem de incluir a conta.
CREATE UNIQUE INDEX IF NOT EXISTS radar_empresas_omie_codigo_cliente_uniq
  ON public.radar_empresas (omie_codigo_cliente) WHERE omie_codigo_cliente IS NOT NULL;

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
  v_codigo_atual text;
  v_restricao text;
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN RAISE EXCEPTION 'cnpj inválido'; END IF;

  -- Trava partilhada: lote e ficha (ou duas abas) no MESMO CNPJ se enfileiram nesta linha; quem chega
  -- depois lê o vínculo que o primeiro gravou.
  SELECT prospeccao_status, NULLIF(btrim(omie_codigo_cliente), '') INTO v_status_atual, v_codigo_atual
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

  -- O vínculo é a trava: igual → nada a escrever (retentativa, duas abas, lote × ficha); diferente → erro
  -- explícito, nada regravado. O status NÃO é exigido nem reparado: mudá-lo depois é decisão do gestor.
  IF v_codigo_atual IS NOT NULL THEN
    IF v_codigo_atual = v_codigo THEN
      RETURN jsonb_build_object('ok', true, 'deduped', true);
    END IF;
    RAISE EXCEPTION 'RADAR_VINCULO_DIVERGENTE: CNPJ % já vinculado ao cliente Omie %, recebido %', p_cnpj, v_codigo_atual, v_codigo
      USING ERRCODE = 'RD001';
  END IF;

  BEGIN
    UPDATE public.radar_empresas SET
      omie_codigo_cliente = v_codigo,
      omie_cadastrado_em = now(),
      prospeccao_status = 'virou_cliente',
      prospeccao_atualizado_em = now(),
      ja_cliente = true,
      updated_at = now()
    WHERE cnpj = p_cnpj;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_restricao = CONSTRAINT_NAME;
    IF v_restricao = 'radar_empresas_omie_codigo_cliente_uniq' THEN
      RAISE EXCEPTION 'RADAR_CODIGO_DE_OUTRO_CNPJ: cliente Omie % já vinculado a outro CNPJ (recebido para %)', v_codigo, p_cnpj
        USING ERRCODE = 'RD002';
    END IF;
    RAISE;
  END;

  INSERT INTO public.radar_contatos (cnpj, acao, nota, criado_por, status_anterior)
  VALUES (p_cnpj, 'virou_cliente',
    CASE WHEN v_criado_por_nos
      THEN 'Cadastrado no Omie/Oben (cód. ' || v_codigo || ')'
      ELSE 'Já cadastrado no Omie/Oben (cód. ' || v_codigo || ')' END,
    v_uid, v_status_atual);

  RETURN jsonb_build_object('ok', true, 'deduped', false);
END $function$;

REVOKE ALL ON FUNCTION public.radar_registrar_cadastro_omie(text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_registrar_cadastro_omie(text, text, boolean) TO authenticated, service_role;

-- PÓS: corpo = ESTE; SECURITY DEFINER, search_path=public, VOLATILE; ACL revisado; índice UNIQUE parcial
-- válido com a definição exata (um homônimo diferente não passa pelo IF NOT EXISTS sem ser visto).
DO $pos$
DECLARE
  v_fn oid := to_regprocedure('public.radar_registrar_cadastro_omie(text,text,boolean)');
  v_idx oid := to_regclass('public.radar_empresas_omie_codigo_cliente_uniq');
  r record;
BEGIN
  SELECT p.prosrc, p.prosecdef, p.proconfig, p.provolatile INTO r FROM pg_catalog.pg_proc p WHERE p.oid = v_fn;
  IF r.prosrc IS NULL OR md5(r.prosrc) IS DISTINCT FROM '2b3dbe0da01ac37b07b1cb5b76be139c' /* este:radar_registrar_cadastro_omie */ THEN
    RAISE EXCEPTION 'POS FALHOU: radar_registrar_cadastro_omie não é este arquivo (md5 %)', md5(r.prosrc);
  END IF;
  IF NOT r.prosecdef OR r.proconfig IS DISTINCT FROM ARRAY['search_path=public'] OR r.provolatile <> 'v' THEN
    RAISE EXCEPTION 'POS FALHOU: perdeu SECURITY DEFINER/search_path=public/VOLATILE (%, %, %)', r.prosecdef, r.proconfig, r.provolatile;
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('public', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: ACL divergente (EXECUTE só authenticated/service_role)';
  END IF;
  IF v_idx IS NULL OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_index i
        WHERE i.indexrelid = v_idx AND i.indrelid = 'public.radar_empresas'::regclass
          AND i.indisunique AND i.indisvalid AND i.indisready
          AND pg_catalog.pg_get_indexdef(i.indexrelid) =
              'CREATE UNIQUE INDEX radar_empresas_omie_codigo_cliente_uniq ON public.radar_empresas USING btree (omie_codigo_cliente) WHERE (omie_codigo_cliente IS NOT NULL)') THEN
    RAISE EXCEPTION 'POS FALHOU: índice UNIQUE parcial radar_empresas_omie_codigo_cliente_uniq ausente, inválido ou com outra definição';
  END IF;
  RAISE NOTICE 'radar_registrar_cadastro_omie: vínculo igual = no-op, diferente = RD001, código de outro CNPJ = RD002';
END
$pos$;

COMMIT;
