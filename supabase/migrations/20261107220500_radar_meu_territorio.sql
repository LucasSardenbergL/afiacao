-- Radar pacote F (achado 2): "Sua fila de hoje" não era do vendedor — o /radar abria em ordem de score em
-- "MG e vizinhos" para todo mundo. O front ganha o recorte "Perto dos seus clientes" (default de quem tem território)
-- e, para isso, precisa LER o território do usuário logado.
--
-- RPC FINA: public.radar_meu_territorio só embrulha private.radar_territorio_do_vendedor (pacote D, migration
-- 20261106181000). A regra do território (carteira elegível, endereço padrão, um dono por município) vive LÁ e não é
-- tocada aqui. Gate = o do card radar_prospectar_hoje: cap_radar_prospectar; pedir o território de OUTRO vendedor (a
-- lente "Ver como") exige pode_ver_carteira_completa. Leitura pura (STABLE): entra na allowlist de leitura da lente.
--
-- Idempotente: CREATE OR REPLACE de função NOVA + REVOKE/GRANT nomeando as roles; PRE e PÓS abortam o apply.

-- PRE: as dependências existem com a assinatura que este corpo chama (plpgsql é late-bound: sem isto, o erro só
-- apareceria na 1ª chamada do app).
DO $pre$
BEGIN
  IF to_regprocedure('private.radar_territorio_do_vendedor(uuid,integer)') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: private.radar_territorio_do_vendedor(uuid,integer) ausente (migration 20261106181000)';
  END IF;
  IF to_regprocedure('private.cap_radar_prospectar(uuid)') IS NULL
     OR to_regprocedure('private.pode_ver_carteira_completa(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: gates private.cap_radar_prospectar/pode_ver_carteira_completa ausentes';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.radar_meu_territorio(p_vendedor uuid DEFAULT NULL, p_top integer DEFAULT 3)
RETURNS TABLE (municipio_codigo text, municipio_nome text, uf text, clientes integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid  uuid := (SELECT auth.uid());
  v_alvo uuid;
BEGIN
  IF NOT COALESCE(private.cap_radar_prospectar(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  v_alvo := COALESCE(p_vendedor, v_uid);
  IF v_alvo <> v_uid AND NOT COALESCE(private.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: territorio de outro vendedor exige gestor' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT t.municipio_codigo, t.municipio_nome, t.uf, t.clientes
      FROM private.radar_territorio_do_vendedor(v_alvo, p_top) t  -- o teto [1,10] de p_top é da privada
     ORDER BY t.clientes DESC, t.municipio_codigo;
END
$fn$;

REVOKE ALL ON FUNCTION public.radar_meu_territorio(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_meu_territorio(uuid, integer) TO authenticated;

COMMENT ON FUNCTION public.radar_meu_territorio(uuid, integer) IS
  'Radar pacote F: território (municípios onde o vendedor tem mais clientes) do usuário logado, para o recorte '
  '"Perto dos seus clientes" do /radar. Embrulha private.radar_territorio_do_vendedor; gate cap_radar_prospectar; '
  'p_vendedor de outro exige gestor.';

-- PÓS: SECURITY DEFINER, uma sobrecarga, e o ACL fechado nas DUAS pontas (PUBLIC e anon) com authenticated aberto.
DO $pos$
DECLARE
  v_fn oid := to_regprocedure('public.radar_meu_territorio(uuid,integer)');
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'POS FALHOU: radar_meu_territorio ausente';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'radar_meu_territorio') <> 1 THEN
    RAISE EXCEPTION 'POS FALHOU: radar_meu_territorio com mais de uma sobrecarga';
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = v_fn) THEN
    RAISE EXCEPTION 'POS FALHOU: radar_meu_territorio não é SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: anon executa radar_meu_territorio';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
              WHERE p.oid = v_fn AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: PUBLIC executa radar_meu_territorio';
  END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: authenticated não executa radar_meu_territorio';
  END IF;
  RAISE NOTICE 'radar pacote F: radar_meu_territorio ok (definer, uma sobrecarga, ACL PUBLIC/anon fechado)';
END
$pos$;
