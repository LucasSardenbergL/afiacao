-- Portal Sayerlack — revisão 2, B13 (2026-11-08): condição com variante "(C)" no catálogo é AMBÍGUA → IP007.
--
-- O catálogo de condições da OBEN tem pares com e sem "(C)" para o mesmo prazo (prod, psql-ro 07/11):
--   A04 "Para 4 dias" · B23 "Para 4 dias (C)" · U89 "Para 6 dias" · D43 "Para 6 dias (C)" ·
--   A13 "Para 13 dias" · A84 "Para 13 dias (C)" · T54 "Para 30 dias" · A30 "Para 30 dias (C)" · V06 "30/60/75 (C)".
-- A regra exata de texto ("N DIAS" → "Para N dias") escolhia em SILÊNCIO a variante sem "(C)". O founder ainda não
-- disse o que o "(C)" significa (🧭 no adendo `2026-11-08-sayerlack-revisao-2.md`); para "30 DIAS" ele escolheu A30
-- "(C)" — o oposto do que a regra daria. Até decidir (decisão de engenharia, fail-closed): se o catálogo tem a
-- variante "(C)" do MESMO texto que a regra casaria, a tradução recusa com IP007 (a importadora mostra as opções do
-- portal; o envio mantém a condição de hoje e grava `condicao_portal_lida`, e o disparo recusa o default à vista).
-- O de-para explícito (`sayerlack_condicao_portal_de_para`, hoje só "30 DIAS → A30") continua vencendo a regra.
--
-- Só a função muda (CREATE OR REPLACE preserva o ACL; o REVOKE é reemitido por higiene). Corpo de partida =
-- o de prod (md5(prosrc) c5dbf8d65885a2ed0bd48429f8ab930d = o da 20261107140000, conferido por psql-ro em 07/11).

CREATE OR REPLACE FUNCTION public.sayerlack_condicao_portal_para_omie(p_condicao_portal text)
RETURNS TABLE (codigo text, descricao text, num_parcelas integer)
LANGUAGE plpgsql STABLE
SET search_path TO 'public'
AS $fn$
DECLARE
  v_norm    text := public.sayerlack_condicao_portal_normalizar(p_condicao_portal);
  v_txt     text;
  v_alvo    text;
  v_dp      text;
  v_matches integer;
  v_codigo  text;
  v_desc    text;
  v_parc    integer;
  v_c       text;   -- descrição da variante "(C)" do mesmo texto, se existir ATIVA (B13)
BEGIN
  SELECT d.codigo_omie INTO v_dp FROM public.sayerlack_condicao_portal_de_para d WHERE d.condicao_portal = v_norm;
  IF v_dp IS NOT NULL THEN
    -- De-para explícito: o código tem de existir ATIVO no catálogo OBEN — senão recusa (nunca cai na regra de texto).
    SELECT count(*), min(c.codigo), min(c.descricao), min(c.num_parcelas) INTO v_matches, v_codigo, v_desc, v_parc
      FROM public.omie_condicao_pagamento_catalogo c
     WHERE c.empresa = 'OBEN' AND c.ativo AND c.codigo = v_dp;
  ELSE
    -- Regra exata do founder (2026-11): "N DIAS" → "Para N dias"; "28/56" → a de mesmo texto; "À VISTA" → 000.
    v_txt := btrim(regexp_replace(coalesce(v_norm, ''), '\s*(DIAS|DIA|DDL|DD)\.?\s*$', ''));
    IF v_txt ~ '^[0-9]+$' THEN
      v_alvo := 'para ' || v_txt::integer || ' dias';
      SELECT count(*), min(c.codigo), min(c.descricao), min(c.num_parcelas) INTO v_matches, v_codigo, v_desc, v_parc
        FROM public.omie_condicao_pagamento_catalogo c
       WHERE c.empresa = 'OBEN' AND c.ativo AND lower(btrim(c.descricao)) = v_alvo;
      SELECT min(c.descricao) INTO v_c
        FROM public.omie_condicao_pagamento_catalogo c
       WHERE c.empresa = 'OBEN' AND c.ativo
         AND regexp_replace(lower(btrim(c.descricao)), '\s+', ' ', 'g') = v_alvo || ' (c)';
    ELSIF v_txt ~ '^[0-9]+(\s*/\s*[0-9]+)+$' THEN
      v_alvo := regexp_replace(v_txt, '\s*/\s*', '/', 'g');
      SELECT count(*), min(c.codigo), min(c.descricao), min(c.num_parcelas) INTO v_matches, v_codigo, v_desc, v_parc
        FROM public.omie_condicao_pagamento_catalogo c
       WHERE c.empresa = 'OBEN' AND c.ativo AND regexp_replace(btrim(c.descricao), '\s*/\s*', '/', 'g') = v_alvo;
      SELECT min(c.descricao) INTO v_c
        FROM public.omie_condicao_pagamento_catalogo c
       WHERE c.empresa = 'OBEN' AND c.ativo
         AND regexp_replace(upper(regexp_replace(btrim(c.descricao), '\s*/\s*', '/', 'g')), '\s+', ' ', 'g') = upper(v_alvo) || ' (C)';
    ELSIF v_txt ~ '^(A|À) ?VISTA$' THEN
      SELECT count(*), min(c.codigo), min(c.descricao), min(c.num_parcelas) INTO v_matches, v_codigo, v_desc, v_parc
        FROM public.omie_condicao_pagamento_catalogo c
       WHERE c.empresa = 'OBEN' AND c.ativo AND c.codigo = '000';
    ELSE
      v_matches := 0;
    END IF;
    -- B13: a variante "(C)" do mesmo texto existe ⇒ o significado do "(C)" decide — e ninguém decidiu. Recusa.
    IF v_c IS NOT NULL THEN
      RAISE EXCEPTION 'importar_portal: condição de pagamento "%" do portal é ambígua no Omie (existe também "%"; o significado do "(C)" aguarda decisão — cadastre o de-para)',
        coalesce(p_condicao_portal, '(vazia)'), v_c USING ERRCODE = 'IP007';
    END IF;
  END IF;
  IF coalesce(v_matches, 0) <> 1 OR v_codigo IS NULL OR coalesce(v_parc, 0) < 1 THEN
    RAISE EXCEPTION 'importar_portal: condição de pagamento "%" do portal sem correspondente único no Omie', coalesce(p_condicao_portal, '(vazia)') USING ERRCODE = 'IP007';
  END IF;
  codigo := v_codigo; descricao := v_desc; num_parcelas := v_parc;
  RETURN NEXT;
END
$fn$;

REVOKE ALL ON FUNCTION public.sayerlack_condicao_portal_para_omie(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sayerlack_condicao_portal_para_omie(text) FROM anon;
REVOKE ALL ON FUNCTION public.sayerlack_condicao_portal_para_omie(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sayerlack_condicao_portal_para_omie(text) TO service_role;

-- Postcondição (vale em prod e no harness): todo texto "Para N dias" do catálogo que tem variante "(C)" ATIVA e NÃO
-- tem de-para recusa IP007; todo de-para ativo segue resolvendo para o próprio código; e o ACL segue fechado.
DO $pos$
DECLARE
  r record;
  v_cod text;
  v_n int := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT substring(lower(btrim(c.descricao)) from '^para ([0-9]+) dias \(c\)$') AS n
      FROM public.omie_condicao_pagamento_catalogo c
     WHERE c.empresa = 'OBEN' AND c.ativo AND lower(btrim(c.descricao)) ~ '^para [0-9]+ dias \(c\)$'
  LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.sayerlack_condicao_portal_de_para d WHERE d.condicao_portal = r.n || ' DIAS');
    BEGIN
      SELECT x.codigo INTO v_cod FROM public.sayerlack_condicao_portal_para_omie(r.n || ' DIAS') x;
      RAISE EXCEPTION 'B13 FALHOU: "% DIAS" tem variante (C) e deu %', r.n, v_cod;
    EXCEPTION WHEN SQLSTATE 'IP007' THEN
      v_n := v_n + 1;
    END;
  END LOOP;
  FOR r IN
    SELECT d.condicao_portal, d.codigo_omie FROM public.sayerlack_condicao_portal_de_para d
      JOIN public.omie_condicao_pagamento_catalogo c ON c.empresa = 'OBEN' AND c.ativo AND c.codigo = d.codigo_omie
  LOOP
    SELECT x.codigo INTO v_cod FROM public.sayerlack_condicao_portal_para_omie(r.condicao_portal) x;
    IF v_cod IS DISTINCT FROM r.codigo_omie THEN
      RAISE EXCEPTION 'B13 FALHOU: de-para "%" deveria dar %, deu %', r.condicao_portal, r.codigo_omie, v_cod;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.sayerlack_condicao_portal_para_omie(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.sayerlack_condicao_portal_para_omie(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'B13 FALHOU: ACL de sayerlack_condicao_portal_para_omie aberto';
  END IF;
  RAISE NOTICE 'POSTCONDICAO_OK sayerlack condicao (C) ambigua: % prazo(s) com (C) recusam IP007', v_n;
END
$pos$;
