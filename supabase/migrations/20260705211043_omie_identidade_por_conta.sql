-- P0-B: identidade Omie por conta derivada/provada no servidor.
-- Spec: docs/superpowers/specs/2026-07-05-identidade-omie-por-conta-design.md
-- Prova: db/test-omie-identidade-backfill.sh (PG17, falsificação).

-- (1) Âncora confiável do cliente por pedido: o documento (CNPJ/CPF) capturado na seleção.
--     Imune ao fallback `customer_user_id || user.id` (que pode virar o VENDEDOR). O edge
--     `criar_pedido` deriva o código Omie por-conta DESTE documento (não de customer_user_id).
ALTER TABLE public.sales_orders ADD COLUMN IF NOT EXISTS customer_document text;

-- (2) Backfill guardado do espelho `omie_clientes` (auto-cura: preenche oben/colacor_sc que hoje
--     têm 0 linhas). Invariante money-path — NUNCA overwrite às cegas de uma identidade:
--       'inserted'  : não havia (user_id, empresa) → cria;
--       'noop'      : já existe com o MESMO código → idempotente;
--       'contested' : (user_id,empresa) existe com código DIFERENTE, OU (codigo,empresa) já é de
--                     OUTRO user → identidade contestada; o edge fail-closa o PV (não envia).
CREATE OR REPLACE FUNCTION public.omie_cliente_upsert_mapping(
  p_user_id uuid,
  p_empresa text,
  p_codigo_cliente bigint,
  p_codigo_vendedor bigint
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_codigo bigint;
  v_owner uuid;
BEGIN
  IF p_user_id IS NULL OR p_empresa IS NULL OR p_codigo_cliente IS NULL THEN
    RAISE EXCEPTION 'omie_cliente_upsert_mapping: argumentos obrigatorios nulos'
      USING ERRCODE = '22004';
  END IF;

  -- (user_id, empresa) já mapeado?
  SELECT omie_codigo_cliente INTO v_existing_codigo
  FROM public.omie_clientes
  WHERE user_id = p_user_id AND empresa_omie = p_empresa;
  IF FOUND THEN
    IF v_existing_codigo = p_codigo_cliente THEN
      RETURN 'noop';
    END IF;
    RETURN 'contested';  -- código diferente para o mesmo (user,empresa) — NÃO sobrescreve
  END IF;

  -- (codigo, empresa) já pertence a OUTRO user?
  SELECT user_id INTO v_owner
  FROM public.omie_clientes
  WHERE omie_codigo_cliente = p_codigo_cliente AND empresa_omie = p_empresa;
  IF FOUND AND v_owner <> p_user_id THEN
    RETURN 'contested';  -- código já é de outro user na empresa — não rouba
  END IF;

  INSERT INTO public.omie_clientes (user_id, empresa_omie, omie_codigo_cliente, omie_codigo_vendedor)
  VALUES (p_user_id, p_empresa, p_codigo_cliente, p_codigo_vendedor);
  RETURN 'inserted';
EXCEPTION
  WHEN unique_violation THEN
    -- corrida com o sync concorrente que também escreve omie_clientes: trata como contested
    -- (não sobrescreve às cegas). O edge fail-closa; o reenvio resolve.
    RETURN 'contested';
END;
$$;

-- Writer money-path: SÓ o service_role (edge) executa. No Supabase, anon/authenticated recebem
-- EXECUTE por default privileges — `REVOKE FROM PUBLIC` sozinho NÃO os tira (database.md §5/§7).
REVOKE ALL ON FUNCTION public.omie_cliente_upsert_mapping(uuid, text, bigint, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omie_cliente_upsert_mapping(uuid, text, bigint, bigint)
  TO service_role;
