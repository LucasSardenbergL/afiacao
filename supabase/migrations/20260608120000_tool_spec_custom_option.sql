-- Medida customizada ("Outros") nos dropdowns de especificação de ferramenta.
-- (a) coluna allow_custom_option (fecha campos de FAIXA, onde digitar medida pontual
--     não faz sentido); (b) drop da policy de escrita (canaliza toda escrita via API
--     pela RPC — zero callsites no app usam PATCH direto; master no SQL Editor é
--     service_role e ignora RLS); (c) RPC adicionar_opcao_tool_spec (gate staff,
--     normaliza NFC, dedupe case-insensitive, append atômico, retorna {options,valor_canonico}).
-- Ritual Lovable: aplicar manualmente no SQL Editor. Sem edge function.

-- (a) coluna
ALTER TABLE public.tool_specifications
  ADD COLUMN IF NOT EXISTS allow_custom_option boolean NOT NULL DEFAULT true;

-- fecha campos de FAIXA detectáveis (options tipo "de X a Y", "até X", "entre X e Y")
UPDATE public.tool_specifications
   SET allow_custom_option = false
 WHERE spec_type = 'select'
   AND options IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements_text(options) o
      WHERE o ILIKE 'de %a %' OR o ILIKE 'até %' OR o ILIKE 'entre %'
   );

-- (b) drop da policy de escrita (RPC vira único escritor via API)
DROP POLICY IF EXISTS "Only admins can manage specifications" ON public.tool_specifications;

-- (c) RPC
CREATE OR REPLACE FUNCTION public.adicionar_opcao_tool_spec(p_spec_id uuid, p_valor text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_norm       text;
  v_options    jsonb;
  v_spec_type  text;
  v_allow      boolean;
  v_existente  text;
BEGIN
  -- gate staff (employee ou master)
  IF NOT (public.has_role(auth.uid(), 'master'::public.app_role)
          OR public.has_role(auth.uid(), 'employee'::public.app_role)) THEN
    RAISE EXCEPTION 'não autorizado' USING errcode = '42501';
  END IF;

  -- rejeita NULL (senão btrim/concat viram NULL e corrompem options)
  IF p_valor IS NULL THEN
    RAISE EXCEPTION 'valor obrigatório' USING errcode = '22004';
  END IF;

  -- normaliza: NFC + remove control chars + colapsa espaços (incl. Unicode) + trim
  v_norm := regexp_replace(normalize(p_valor, NFC), '[[:cntrl:]]', '', 'g');
  -- converte espaços Unicode (NBSP, narrow NBSP, ideographic, BOM, line/para sep, etc.)
  -- p/ espaço comum ANTES de colapsar: o \s do Postgres não os cobre confiavelmente em
  -- todo locale, mas o \s do JS (helper de validação) cobre. Sem isto, '290<NBSP>mm' e
  -- '290 mm' virariam 2 opções visivelmente iguais no catálogo. chr() decimal = ASCII puro.
  v_norm := regexp_replace(
    v_norm,
    '[' || chr(160) || chr(5760) || chr(8192) || '-' || chr(8202)
        || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279) || ']',
    ' ', 'g'
  );
  v_norm := btrim(regexp_replace(v_norm, '\s+', ' ', 'g'));

  IF v_norm = '' THEN
    RAISE EXCEPTION 'valor vazio' USING errcode = '22023';
  END IF;
  IF length(v_norm) > 60 THEN
    RAISE EXCEPTION 'valor muito longo (máx 60)' USING errcode = '22001';
  END IF;
  IF upper(v_norm) = '__OUTROS__' THEN
    RAISE EXCEPTION 'valor reservado' USING errcode = '22023';
  END IF;

  -- lê com lock de linha
  SELECT options, spec_type, allow_custom_option
    INTO v_options, v_spec_type, v_allow
    FROM public.tool_specifications
   WHERE id = p_spec_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'especificação inexistente' USING errcode = 'P0002';
  END IF;
  IF v_spec_type <> 'select' THEN
    RAISE EXCEPTION 'este campo não é uma lista' USING errcode = '22023';
  END IF;
  IF v_allow IS NOT TRUE THEN
    RAISE EXCEPTION 'este campo não aceita medida nova' USING errcode = '22023';
  END IF;

  v_options := COALESCE(v_options, '[]'::jsonb);

  -- limite de quantidade (anti-inflar JSONB)
  IF jsonb_array_length(v_options) >= 200 THEN
    RAISE EXCEPTION 'limite de opções atingido' USING errcode = '54000';
  END IF;

  -- dedupe case-insensitive → devolve o canônico existente
  SELECT e INTO v_existente
    FROM jsonb_array_elements_text(v_options) e
   WHERE lower(e) = lower(v_norm)
   LIMIT 1;
  IF v_existente IS NOT NULL THEN
    RETURN jsonb_build_object('options', v_options, 'valor_canonico', v_existente);
  END IF;

  -- append atômico
  UPDATE public.tool_specifications
     SET options = v_options || jsonb_build_array(v_norm)
   WHERE id = p_spec_id
   RETURNING options INTO v_options;

  RETURN jsonb_build_object('options', v_options, 'valor_canonico', v_norm);
END;
$$;

REVOKE ALL    ON FUNCTION public.adicionar_opcao_tool_spec(uuid, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.adicionar_opcao_tool_spec(uuid, text) TO authenticated;
