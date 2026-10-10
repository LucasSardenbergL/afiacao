-- ============================================================================================
-- 20261010163424 · resolver_cliente_por_telefone — o discador passa a reconhecer o cliente
-- Prova: db/test-resolver-cliente-por-telefone.sh (PG17: função real, RLS real sob authenticated)
--
-- O QUE: quem é o dono de um número de telefone, comparando SÓ DÍGITOS (sufixo de 8). Substitui a
-- busca do front (`resolve-customer.ts`), que fazia `phone ILIKE '%<8 dígitos>%'` sobre o texto CRU:
-- o cadastro guarda `99999-9999`/`9999-9999`, o hífen quebra a sequência e o ILIKE não casa.
-- Medido em prod (2026-10-10): das 2.714 pessoas das carteiras das 2 vendedoras com telefone, a busca
-- antiga reconhecia 115 (4%). Número não reconhecido = 'desconhecido' = a ligação NÃO grava e NÃO vira
-- farmer_calls — a vendedora liga e o cliente segue "nunca contatado" (12 ligações da Regina em
-- 09/06, 11 atendidas, 0 registros).
--
-- AMBIGUIDADE: 404 sufixos são compartilhados por >1 cliente (1.046 cadastros, maior grupo = 22). A
-- busca antiga usava `.maybeSingle()` e o erro de "mais de uma linha" virava 'desconhecido' calado.
-- Aqui: 1 candidato → ele; vários → o ÚNICO que está na carteira de quem liga; senão o número é de
-- cliente mas o dono fica NULL (`candidatos` > 1) — a ligação grava e a vendedora associa depois em
-- /farmer/calls/pending-link. Não se escolhe um cliente ao acaso: atribuir o contato à empresa errada
-- é pior que deixá-lo sem dono.
--
-- ORDEM DAS FONTES (a mesma da busca antiga): customer_contacts primeiro (traz nome/cargo do contato);
-- profiles só se nenhum contato casar. Perfil de staff (employee/master) NÃO é cliente — a busca antiga
-- o aceitava; medido: 1 perfil de staff com telefone, sem colisão hoje.
--
-- SEGURANÇA: SECURITY INVOKER — a RLS de quem chama vale em todas as leituras (staff lê contatos,
-- perfis e a própria carteira; um customer só alcança o próprio perfil). Nada aqui escreve.
-- Zero linhas = desconhecido (telefone com < 8 dígitos, placeholder de dígito repetido, ou nenhum dono).
--
-- APLICAR: bun run db:aplicar supabase/migrations/<este arquivo> — o executor fornece a transação
-- (não há BEGIN/COMMIT aqui). Idempotente. A postcondição no fim aborta tudo se o estado final não for
-- o desenhado. ORDEM DO DEPLOY: esta migration ANTES do Publish do front (o front sem a RPC degrada
-- para 'desconhecido' — o comportamento de hoje —, nunca quebra a ligação).
-- ============================================================================================

CREATE OR REPLACE FUNCTION public.resolver_cliente_por_telefone(p_telefone text)
 RETURNS TABLE (
   customer_user_id uuid,
   contato_nome text,
   contato_cargo text,
   fonte text,
   candidatos integer
 )
 LANGUAGE plpgsql
 STABLE
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
DECLARE
  v_sufixo     text := right(regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g'), 8);
  v_ids        uuid[];
  v_fonte      text;
  v_na_carteira uuid[];
  v_escolhido  uuid;
BEGIN
  IF length(v_sufixo) < 8 THEN
    RETURN;
  END IF;
  -- placeholder (00000000, 99999999…): não identifica ninguém — há 3 perfis assim em prod
  -- (2026-10-10). Casar por ele gravaria ligação de quem não é cliente.
  IF v_sufixo ~ '^(\d)\1{7}$' THEN
    RETURN;
  END IF;

  -- 1) contatos cadastrados (mais específicos: trazem nome e cargo)
  SELECT array_agg(DISTINCT cc.customer_user_id)
    INTO v_ids
    FROM public.customer_contacts cc
   WHERE cc.customer_user_id IS NOT NULL
     AND right(regexp_replace(coalesce(cc.phone, ''), '\D', '', 'g'), 8) = v_sufixo;

  IF v_ids IS NOT NULL THEN
    v_fonte := 'contato';
  ELSE
    -- 2) telefone do perfil, só de quem NÃO é staff
    SELECT array_agg(DISTINCT pr.user_id)
      INTO v_ids
      FROM public.profiles pr
     WHERE right(regexp_replace(coalesce(pr.phone, ''), '\D', '', 'g'), 8) = v_sufixo
       AND NOT EXISTS (
             SELECT 1 FROM public.user_roles r
              WHERE r.user_id = pr.user_id
                AND r.role IN ('employee'::public.app_role, 'master'::public.app_role)
           );
    IF v_ids IS NULL THEN
      RETURN;
    END IF;
    v_fonte := 'perfil';
  END IF;

  IF cardinality(v_ids) = 1 THEN
    v_escolhido := v_ids[1];
  ELSE
    -- desempate: o único candidato da carteira de quem liga; sem isso, fica sem dono
    SELECT array_agg(DISTINCT a.customer_user_id)
      INTO v_na_carteira
      FROM public.carteira_assignments a
     WHERE a.customer_user_id = ANY (v_ids)
       AND a.owner_user_id = auth.uid()
       AND a.eligible IS TRUE;
    IF cardinality(v_na_carteira) = 1 THEN
      v_escolhido := v_na_carteira[1];
    END IF;
  END IF;

  RETURN QUERY
  SELECT v_escolhido,
         c.nome,
         c.cargo,
         v_fonte,
         cardinality(v_ids)
    FROM (SELECT 1) um
    LEFT JOIN LATERAL (
      SELECT cc.nome, cc.cargo
        FROM public.customer_contacts cc
       WHERE v_fonte = 'contato'
         AND cc.customer_user_id = v_escolhido
         AND right(regexp_replace(coalesce(cc.phone, ''), '\D', '', 'g'), 8) = v_sufixo
       ORDER BY cc.is_primary DESC NULLS LAST, cc.created_at
       LIMIT 1
    ) c ON true;
END
$function$;

COMMENT ON FUNCTION public.resolver_cliente_por_telefone(text) IS
  'Dono de um telefone por sufixo de 8 DÍGITOS (ignora formatação). customer_contacts antes de profiles; perfil de staff não conta. Vários donos: o único da carteira de quem chama, senão customer_user_id NULL com candidatos > 1. Zero linhas = desconhecido. SECURITY INVOKER (RLS de quem chama).';

-- Função nova nasce com EXECUTE para PUBLIC e, no Supabase, com grant explícito para anon:
-- revogar PUBLIC não tira o anon (CLAUDE.md, armadilha de RLS) — revoga-se pelo nome.
REVOKE ALL ON FUNCTION public.resolver_cliente_por_telefone(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolver_cliente_por_telefone(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolver_cliente_por_telefone(text) TO authenticated, service_role;

DO $post$
DECLARE
  v_oid oid := to_regprocedure('public.resolver_cliente_por_telefone(text)');
  v_n   integer;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'P1 FALHOU: resolver_cliente_por_telefone(text) não existe — o discador seguiria sem reconhecer o cliente';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'P2 FALHOU: a função saiu SECURITY DEFINER — leria contatos/perfis por cima da RLS de quem chama';
  END IF;
  IF NOT coalesce((SELECT 'search_path=""' = ANY (proconfig) FROM pg_proc WHERE oid = v_oid), false) THEN
    RAISE EXCEPTION 'P3 FALHOU: search_path da função não é vazio';
  END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'P4 FALHOU: authenticated não executa — o front recebe erro e o número vira desconhecido';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'P5 FALHOU: anon executa a função — o grant default não foi revogado pelo nome';
  END IF;
  -- execução de verdade (PL/pgSQL é late-bound): telefone curto devolve zero linhas, sem erro
  SELECT count(*) INTO v_n FROM public.resolver_cliente_por_telefone('1234');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'P6 FALHOU: telefone com 4 dígitos devolveu % linha(s) — esperado 0', v_n;
  END IF;
  -- e um telefone de 8+ dígitos percorre os dois ramos de busca sem erro de runtime
  PERFORM * FROM public.resolver_cliente_por_telefone('(00) 00000-0000');
  RAISE NOTICE 'resolver_cliente_por_telefone: invoker, search_path vazio, authenticated sim, anon não, executa';
END
$post$;
