-- Onda D da tela Clientes — fatia 4b-2: contato principal numa RPC atômica.
-- Diário: docs/historico/clientes-onda-d-pii-carteira.md (§Fatia 4b-2).
--
-- Antes: o front (`useSaveContact`) mandava 2 requisições soltas — UPDATE is_primary=false em TODOS os contatos
-- do `customer_user_id` que o BROWSER informava, depois o insert/update do contato. Se a 2ª falhava, o cliente
-- ficava sem principal; e o 1º UPDATE confiava no dono vindo do browser, não no dono da linha.
--
-- Agora: `contato_cliente_definir_principal(p_contato_id)` lê o dono DA LINHA, trava todos os contatos dele
-- (ordem por id, sem deadlock entre 2 chamadas do mesmo dono), desliga o principal anterior e liga este — tudo
-- numa transação. Gate de staff igual ao da policy de UPDATE da tabela (employee/master). Não devolve PII:
-- só o uuid do dono (para o front invalidar a lista certa).
--
-- Novo, não substitui nada (sem pré-flight de corpo). Sem pré-requisito de front: o front novo passa a usá-la;
-- o antigo segue funcionando pela tabela até o Publish.
-- Aplicação: bun run db:aplicar (o EXECUTOR fornece a transação — sem BEGIN/COMMIT).

CREATE FUNCTION public.contato_cliente_definir_principal(p_contato_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_dono uuid;
  v_dono_travado uuid;
BEGIN
  IF v_uid IS NULL
     OR NOT (COALESCE(public.has_role(v_uid, 'employee'::public.app_role), false)
             OR COALESCE(public.has_role(v_uid, 'master'::public.app_role), false)) THEN
    RAISE EXCEPTION 'contato_cliente_definir_principal: sem permissao' USING ERRCODE = '42501';
  END IF;
  IF p_contato_id IS NULL THEN
    RAISE EXCEPTION 'contato_cliente_definir_principal: contato obrigatorio' USING ERRCODE = '22023';
  END IF;

  SELECT c.customer_user_id INTO v_dono FROM public.customer_contacts c WHERE c.id = p_contato_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contato_cliente_definir_principal: contato inexistente' USING ERRCODE = 'P0002';
  END IF;
  IF v_dono IS NULL THEN
    RAISE EXCEPTION 'contato_cliente_definir_principal: contato sem cliente' USING ERRCODE = '22023';
  END IF;

  -- Trava TODOS os contatos do dono em ordem fixa (2 chamadas concorrentes do mesmo dono se enfileiram).
  PERFORM 1 FROM public.customer_contacts c WHERE c.customer_user_id = v_dono ORDER BY c.id FOR UPDATE;

  -- Re-lê sob a trava: o dono pode ter mudado entre a 1ª leitura e o lock.
  SELECT c.customer_user_id INTO v_dono_travado FROM public.customer_contacts c WHERE c.id = p_contato_id;
  IF v_dono_travado IS DISTINCT FROM v_dono THEN
    RAISE EXCEPTION 'contato_cliente_definir_principal: o contato mudou de cliente, tente de novo'
      USING ERRCODE = '40001';
  END IF;

  -- Desliga antes de ligar: `idx_customer_contacts_one_primary` (UNIQUE parcial) não aceita 2 principais.
  UPDATE public.customer_contacts c SET is_primary = false
   WHERE c.customer_user_id = v_dono AND c.is_primary IS TRUE AND c.id <> p_contato_id;
  UPDATE public.customer_contacts c SET is_primary = true
   WHERE c.id = p_contato_id AND c.is_primary IS NOT TRUE;

  RETURN v_dono;
END
$function$;

REVOKE ALL ON FUNCTION public.contato_cliente_definir_principal(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.contato_cliente_definir_principal(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.contato_cliente_definir_principal(uuid) IS
  'Onda D 4b-2: define o contato principal do cliente de forma atomica (dono lido da linha, staff). Sem PII na saida.';

DO $post$
DECLARE
  v_oid oid := 'public.contato_cliente_definir_principal(uuid)'::regprocedure;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_oid AND prosecdef
                    AND proconfig @> ARRAY['search_path=""']) THEN
    RAISE EXCEPTION 'C1 FALHOU: definir_principal não é SECURITY DEFINER com search_path vazio';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'C2 FALHOU: anon executa definir_principal';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_oid AND a.grantee = 0) THEN
    RAISE EXCEPTION 'C2 FALHOU: PUBLIC executa definir_principal';
  END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'C3 FALHOU: authenticated não executa definir_principal (o front quebraria)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_customer_contacts_one_primary') THEN
    RAISE EXCEPTION 'C4 FALHOU: o UNIQUE parcial de principal sumiu (a RPC assume que ele existe)';
  END IF;
  RAISE NOTICE 'fatia 4b-2 ok: contato principal atômico';
END
$post$;
