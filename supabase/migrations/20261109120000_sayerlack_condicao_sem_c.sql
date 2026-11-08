-- Portal Sayerlack — revisão 2, B13 (2026-11-08): condição do portal → SEMPRE a variante SEM "(C)" do catálogo Omie.
--
-- Decisão (delegada pelo founder: "pode escolher você se mantém ou tira, quero apenas que funcione"), tomada pela
-- MEDIDA: os POs Sayerlack no Omie (purchase_orders_tracking.raw_data cCodParc, abr–nov/2026) usaram 000 ×396,
-- A15 ×26, A07 ×7, 001 ×3, A10 ×1 — NENHUM usou variante "(C)" (A30, A84, B23, D43, V06 no catálogo OBEN), e nenhum
-- pedido do app gravou uma delas (psql-ro 07/11: 0).
--
-- A regra exata de texto da `sayerlack_condicao_portal_para_omie` ("N DIAS" → "Para N dias") JÁ escolhe a variante
-- sem "(C)" (4 → A04, 6 → U89, 13 → A13, 30 → T54) e dá IP007 quando não há par algum — a função NÃO muda.
-- O que muda é a ÚNICA semente do de-para, "30 DIAS → A30 'Para 30 dias (C)'": ela NÃO foi escolha do founder
-- (o "(C)" entrou como exemplo no plano) e passa a ser T54 "Para 30 dias".

UPDATE public.sayerlack_condicao_portal_de_para
   SET codigo_omie = 'T54',
       evidencia   = 'Revisão 2 B13 (2026-11-08): regra "sem (C)" — POs Sayerlack no Omie abr–nov/2026 nunca usaram '
                     || 'variante (C) (000×396, A15×26, A07×7, 001×3, A10×1); o A30 anterior não foi escolha do founder.'
 WHERE condicao_portal = '30 DIAS' AND codigo_omie = 'A30';

-- Postcondição (prod e harness): nenhum de-para aponta para variante "(C)"; todo prazo "Para N dias" que tem par com
-- e sem "(C)" ATIVOS traduz para o SEM "(C)"; o de-para "30 DIAS", se existir, é T54.
DO $pos$
DECLARE
  r record;
  v_cod text;
  v_n int := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM public.sayerlack_condicao_portal_de_para d
               JOIN public.omie_condicao_pagamento_catalogo c ON c.empresa = 'OBEN' AND c.codigo = d.codigo_omie
              WHERE c.descricao ~* '\(c\)\s*$') THEN
    RAISE EXCEPTION 'B13 FALHOU: de-para aponta para variante (C)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sayerlack_condicao_portal_de_para WHERE condicao_portal = '30 DIAS' AND codigo_omie <> 'T54') THEN
    RAISE EXCEPTION 'B13 FALHOU: de-para "30 DIAS" não é T54';
  END IF;
  -- Traduz EXECUTANDO (Codex rodada 2: T54 inativo/ausente passaria na checagem textual e "30 DIAS" daria IP007).
  BEGIN
    SELECT x.codigo INTO v_cod FROM public.sayerlack_condicao_portal_para_omie('30 DIAS') x;
  EXCEPTION WHEN SQLSTATE 'IP007' THEN
    RAISE EXCEPTION 'B13 FALHOU: "30 DIAS" não traduz (T54 ausente ou inativo no catálogo OBEN?)';
  END;
  IF v_cod IS DISTINCT FROM 'T54' THEN
    RAISE EXCEPTION 'B13 FALHOU: "30 DIAS" deveria dar T54, deu %', v_cod;
  END IF;
  FOR r IN
    SELECT s.codigo AS sem_c, substring(lower(btrim(s.descricao)) from '^para ([0-9]+) dias$') AS n
      FROM public.omie_condicao_pagamento_catalogo s
     WHERE s.empresa = 'OBEN' AND s.ativo AND lower(btrim(s.descricao)) ~ '^para [0-9]+ dias$'
       AND EXISTS (SELECT 1 FROM public.omie_condicao_pagamento_catalogo c
                    WHERE c.empresa = 'OBEN' AND c.ativo
                      AND regexp_replace(lower(btrim(c.descricao)), '\s+', ' ', 'g') = lower(btrim(s.descricao)) || ' (c)')
       AND (SELECT count(*) FROM public.omie_condicao_pagamento_catalogo u
             WHERE u.empresa = 'OBEN' AND u.ativo AND lower(btrim(u.descricao)) = lower(btrim(s.descricao))) = 1
  LOOP
    SELECT x.codigo INTO v_cod FROM public.sayerlack_condicao_portal_para_omie(r.n || ' DIAS') x;
    IF v_cod IS DISTINCT FROM r.sem_c THEN
      RAISE EXCEPTION 'B13 FALHOU: "% DIAS" deveria dar % (sem (C)), deu %', r.n, r.sem_c, v_cod;
    END IF;
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'POSTCONDICAO_OK sayerlack condicao sem (C): % prazo(s) com par traduzem para a variante sem (C)', v_n;
END
$pos$;
