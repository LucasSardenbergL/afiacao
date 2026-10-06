-- ============================================================================
-- Preço exato no PO Sayerlack — IPI por NCM na prova do portal e decomposição no item
-- ============================================================================
-- Spec: docs/superpowers/specs/2026-10-05-preco-exato-po-sayerlack-design.md (decisões do founder, 2026-10-05).
--
-- A "divergência aberta" da captura do portal (captura-custo.ts; #2459: 374,77 cobrados × 362,9698 na linha) é o
-- IPI: o portal cobra Σ Preço Venda (mercadoria, sem IPI) + o IPI de cada item pela alíquota do NCM. No backtest de
-- 29 pedidos (06/09 → 05/10) 13 alíquotas fecham todos em ≤ R$ 0,02. Esta migration:
--   1. cria ipi_aliquota_ncm — alíquota MEDIDA por NCM, com fonte e evidência — e semeia as 13;
--   2. dá a pedido_compra_item a decomposição que o PO usa (unitário sem IPI, IPI da linha, alíquota, NCM), com
--      escritor ÚNICO = a RPC abaixo e o CHECK que a mantém inteira (as 4 ou nenhuma);
--   3. cria sayerlack_ipi_itens(p_pedido_id): a alíquota de cada item (NCM do cadastro × tabela, conta
--      lower(empresa)) — UMA implementação, que a edge usa para calcular e a RPC para conferir;
--   4. reescreve sayerlack_aplicar_custo_portal com a MESMA assinatura: o payload vira o pedido INTEIRO
--      {item_id, qtde_final, valor_mercadoria, valor_ipi}; a RPC confere o IPI contra a tabela (igualdade EXATA —
--      a edge calcula em centavos inteiros, aqui em numeric), prova o total cobrado com a tolerância do
--      arredondamento e grava preco_unitario/valor_linha como CUSTO COM IPI (D1 do founder) junto da decomposição.
--
-- Compatibilidade (spec §5.3 — nenhuma combinação grava número errado): a edge anterior manda
-- {preco_unitario, valor_linha} ⇒ CP001 aqui (captura cega); a edge nova contra a RPC anterior cai em CP001 lá
-- (o payload novo não tem preco_unitario). Ordem segura: este BANCO antes das edges.
--
-- SQLSTATEs (classe CP = Custo do Portal; a edge casa a MARCA, nunca "lançou algo"):
--   CP001  payload inválido: vazio, chave ausente, tipo não-número, ≤ 0, IPI < 0, total não finito ou ≤ 0
--   CP002  PO Omie JÁ existe — recusa idempotente
--   CP003  pedido não elegível (inexistente ou status_envio_portal ≠ 'sucesso_portal')
--   CP004  itens divergentes: id repetido; o payload não é o pedido inteiro; id alheio; qtde_final ecoada ≠ a da
--          linha; qtde_final fracionária (o PO manda ceil — nQtde × nValUnit passaria da mercadoria)
--   CP006  item sem alíquota de IPI conhecida (NCM ausente ou fora de ipi_aliquota_ncm) — ausente ≠ zero
--   CP007  a prova não fecha: IPI do payload ≠ recalculado, ou |Σ(linha + IPI) − total cobrado| > tolerância
-- O CP005 da versão anterior (derivado indeterminado) sai: com o payload cobrindo todos os itens e cada um gravado
-- com valor_linha > 0, ele ficou inalcançável.
--
-- Prova: db/test-sayerlack-ipi-po.sh (PG17 descartável; paridade com os 29 pedidos reais; falsificação).
-- Apply MANUAL (Lovable: SQL Editor → cola → Run). Idempotente.
-- ============================================================================

BEGIN;

-- 1) ── ipi_aliquota_ncm ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ipi_aliquota_ncm (
  ncm           text        PRIMARY KEY,
  aliquota_pct  numeric     NOT NULL,
  fonte         text        NOT NULL,
  evidencia     text        NOT NULL,
  medido_em     date        NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
-- Constraints por DROP IF EXISTS + ADD: re-rodar a migration REAPLICA o contrato.
ALTER TABLE public.ipi_aliquota_ncm DROP CONSTRAINT IF EXISTS ipi_aliquota_ncm_ncm_8_digitos;
ALTER TABLE public.ipi_aliquota_ncm ADD CONSTRAINT ipi_aliquota_ncm_ncm_8_digitos CHECK (ncm ~ '^[0-9]{8}$');
-- `>= 0` e `< 100` juntos barram NaN ('NaN' >= 0 é TRUE em numeric, 'NaN' < 100 é FALSE) e ±Infinity. No máximo 2
-- casas, como a TIPI: é o que deixa o IPI exato em centavos dos DOIS lados.
ALTER TABLE public.ipi_aliquota_ncm DROP CONSTRAINT IF EXISTS ipi_aliquota_ncm_aliquota_faixa;
ALTER TABLE public.ipi_aliquota_ncm ADD CONSTRAINT ipi_aliquota_ncm_aliquota_faixa CHECK (aliquota_pct >= 0 AND aliquota_pct < 100 AND aliquota_pct = round(aliquota_pct, 2));
ALTER TABLE public.ipi_aliquota_ncm DROP CONSTRAINT IF EXISTS ipi_aliquota_ncm_fonte_valida;
ALTER TABLE public.ipi_aliquota_ncm ADD CONSTRAINT ipi_aliquota_ncm_fonte_valida CHECK (fonte IN ('nf', 'portal'));
ALTER TABLE public.ipi_aliquota_ncm DROP CONSTRAINT IF EXISTS ipi_aliquota_ncm_evidencia_nao_vazia;
ALTER TABLE public.ipi_aliquota_ncm ADD CONSTRAINT ipi_aliquota_ncm_evidencia_nao_vazia CHECK (btrim(evidencia) <> '');

ALTER TABLE public.ipi_aliquota_ncm ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ipi_aliquota_ncm FROM anon, authenticated;
GRANT SELECT ON public.ipi_aliquota_ncm TO service_role;

COMMENT ON TABLE public.ipi_aliquota_ncm IS
  'Alíquota de IPI MEDIDA por NCM (8 dígitos) — fonte nf (NF de entrada lida) ou portal (identificada pelo total cobrado). Lida por sayerlack_ipi_itens; a captura do portal a re-prova a cada pedido (soma das linhas + IPI = total cobrado). Escrita: SQL Editor. NCM fora daqui = captura cega ipi_ncm_desconhecido (nunca 0%).';

INSERT INTO public.ipi_aliquota_ncm (ncm, aliquota_pct, fonte, evidencia, medido_em) VALUES
  ('32081020', 3.25, 'nf',     'NF 000953881 (Renner Sayerlack, 02/10/2026), tela de recebimento do Omie; backtest de 29 pedidos Sayerlack 06/09–05/10: 19 linhas, a vizinha erra R$ 90,07', '2026-10-05'),
  ('32082020', 3.25, 'nf',     'NF 000953881 (Renner Sayerlack, 02/10/2026), tela de recebimento do Omie; backtest de 29 pedidos: 10 linhas, a vizinha erra R$ 22,75', '2026-10-05'),
  ('32089039', 6.5,  'nf',     'NF 000953881 (Renner Sayerlack, 02/10/2026), tela de recebimento do Omie; backtest de 29 pedidos: 22 linhas, a vizinha erra R$ 109,84', '2026-10-05'),
  ('38140090', 6.5,  'nf',     'NF 000953881 (Renner Sayerlack, 02/10/2026), tela de recebimento do Omie; backtest de 29 pedidos: 13 linhas, a vizinha erra R$ 50,17', '2026-10-05'),
  ('32081010', 3.25, 'portal', 'backtest de 29 pedidos Sayerlack 06/09–05/10 (total cobrado × Σ Preço Venda): 30 linhas, a vizinha erra R$ 54,02', '2026-10-05'),
  ('32082019', 3.25, 'portal', 'backtest de 29 pedidos Sayerlack 06/09–05/10: 11 linhas, a vizinha erra R$ 70,35', '2026-10-05'),
  ('32129090', 6.5,  'portal', 'backtest de 29 pedidos Sayerlack 06/09–05/10: 2 linhas, a vizinha erra R$ 12,93', '2026-10-05'),
  ('32141020', 1.3,  'portal', 'backtest de 29 pedidos Sayerlack 06/09–05/10: 1 linha (2% da TIPI com a redução de 35%), a vizinha erra R$ 4,87', '2026-10-05'),
  ('32149000', 0,    'portal', 'backtest de 29 pedidos Sayerlack 06/09–05/10: 13 linhas, a vizinha erra R$ 64,79', '2026-10-05'),
  ('29153999', 0,    'portal', 'backtest de 29 pedidos Sayerlack 06/09–05/10: 7 linhas, a vizinha erra R$ 18,82', '2026-10-05'),
  ('32041210', 0,    'portal', 'backtest de 29 pedidos Sayerlack 06/09–05/10: 2 linhas, a vizinha erra R$ 6,48', '2026-10-05'),
  ('38089219', 0,    'portal', 'backtest de 29 pedidos Sayerlack 06/09–05/10: 1 linha, a vizinha erra R$ 5,91', '2026-10-05'),
  ('29221919', 0,    'portal', 'backtest de 29 pedidos Sayerlack 06/09–05/10: 1 linha de R$ 13,71 (pedido 2662, ×1,0000 exato), a vizinha erra R$ 0,18', '2026-10-05')
ON CONFLICT (ncm) DO NOTHING;

-- 2) ── decomposição no item (escritor ÚNICO: sayerlack_aplicar_custo_portal) ──
ALTER TABLE public.pedido_compra_item
  ADD COLUMN IF NOT EXISTS preco_unitario_sem_ipi_portal numeric,
  ADD COLUMN IF NOT EXISTS valor_ipi_portal              numeric,
  ADD COLUMN IF NOT EXISTS aliquota_ipi_portal           numeric,
  ADD COLUMN IF NOT EXISTS ncm_ipi_portal                text;
ALTER TABLE public.pedido_compra_item DROP CONSTRAINT IF EXISTS pedido_compra_item_ipi_portal_coerente;
ALTER TABLE public.pedido_compra_item ADD CONSTRAINT pedido_compra_item_ipi_portal_coerente CHECK (
  num_nulls(preco_unitario_sem_ipi_portal, valor_ipi_portal, aliquota_ipi_portal, ncm_ipi_portal) IN (0, 4)
  AND (preco_unitario_sem_ipi_portal IS NULL OR (preco_unitario_sem_ipi_portal > 0 AND preco_unitario_sem_ipi_portal < 'Infinity'::numeric))
  AND (valor_ipi_portal IS NULL OR (valor_ipi_portal >= 0 AND valor_ipi_portal < 'Infinity'::numeric))
  AND (aliquota_ipi_portal IS NULL OR (aliquota_ipi_portal >= 0 AND aliquota_ipi_portal < 100))
  AND (ncm_ipi_portal IS NULL OR ncm_ipi_portal ~ '^[0-9]{8}$')
);
COMMENT ON COLUMN public.pedido_compra_item.preco_unitario_sem_ipi_portal IS
  'Unitário SEM IPI provado pelo portal (round2(Preço Venda) ÷ qtde_final) — vai em nValUnit do PO. Escritor único: sayerlack_aplicar_custo_portal. Nulo = sem prova (o PO usa preco_unitario, como antes).';
COMMENT ON COLUMN public.pedido_compra_item.valor_ipi_portal IS
  'IPI da LINHA em R$ (round2(linha × alíquota ÷ 100)) — vai em nValorIpi do PO. 0 = alíquota 0% MEDIDA, nunca ausência. Escritor único: sayerlack_aplicar_custo_portal.';
COMMENT ON COLUMN public.pedido_compra_item.aliquota_ipi_portal IS
  'Alíquota (%) de ipi_aliquota_ncm usada na prova deste item (auditoria — a tabela pode mudar depois). Escritor único: sayerlack_aplicar_custo_portal.';
COMMENT ON COLUMN public.pedido_compra_item.ncm_ipi_portal IS
  'NCM (8 dígitos, do omie_products da conta do pedido) usado na prova deste item. Escritor único: sayerlack_aplicar_custo_portal.';

-- 3) ── a alíquota de cada item — UMA implementação (edge calcula, RPC confere) ──
CREATE OR REPLACE FUNCTION public.sayerlack_ipi_itens(p_pedido_id bigint)
RETURNS TABLE (item_id bigint, ncm text, aliquota_pct numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
  SELECT i.id,
         n.ncm,
         a.aliquota_pct
    FROM public.pedido_compra_item i
    JOIN public.pedido_compra_sugerido s ON s.id = i.pedido_id
    LEFT JOIN public.omie_products op
      ON op.omie_codigo_produto::text = i.sku_codigo_omie AND op.account = lower(s.empresa)
    CROSS JOIN LATERAL (SELECT NULLIF(regexp_replace(coalesce(op.ncm, ''), '[^0-9]', '', 'g'), '') AS ncm) n
    LEFT JOIN public.ipi_aliquota_ncm a ON a.ncm = n.ncm
   WHERE i.pedido_id = p_pedido_id
   ORDER BY i.id
$function$;
COMMENT ON FUNCTION public.sayerlack_ipi_itens(bigint) IS
  'Por item do pedido: NCM (só dígitos, de omie_products na conta lower(empresa)) e a alíquota de ipi_aliquota_ncm (NULL = NCM ausente ou fora da tabela). Usada pela edge enviar-pedido-portal-sayerlack e pela RPC sayerlack_aplicar_custo_portal. service_role.';
REVOKE ALL ON FUNCTION public.sayerlack_ipi_itens(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sayerlack_ipi_itens(bigint) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sayerlack_ipi_itens(bigint) TO service_role;

-- 4) ── a RPC de custo, v3 (mesma assinatura) ──
CREATE OR REPLACE FUNCTION public.sayerlack_aplicar_custo_portal(
  p_pedido_id   bigint,
  p_itens       jsonb,
  p_valor_total numeric
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_n              integer;
  v_afetadas       integer;
  v_atualizados    integer;
  v_omie           text;
  v_status         text;
  v_ids_distintos  integer;
  v_itens_total    integer;
  v_pertencem      integer;
  v_sem_aliquota   text;
  v_ipi_divergente integer;
  v_total_modelado numeric;
  v_tolerancia     numeric;
  v_aliq           jsonb;
BEGIN
  -- Gate de papel (defesa em profundidade; a tranca é o privilégio).
  IF auth.uid() IS NOT NULL
     AND NOT (public.has_role(auth.uid(), 'employee'::app_role)
              OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;

  -- CP001 — payload. Ausente ≠ zero: nada aqui degrada para default.
  IF p_pedido_id IS NULL OR p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' THEN
    RAISE EXCEPTION 'custo_portal: payload inválido (pedido=%, itens=%)',
      coalesce(p_pedido_id::text, 'null'), coalesce(jsonb_typeof(p_itens), 'null') USING ERRCODE = 'CP001';
  END IF;
  v_n := jsonb_array_length(p_itens);
  IF v_n = 0 THEN
    RAISE EXCEPTION 'custo_portal: payload sem itens — a prova cobre o pedido inteiro' USING ERRCODE = 'CP001';
  END IF;
  IF p_valor_total IS NULL OR p_valor_total = 'NaN'::numeric
     OR NOT (p_valor_total > 0 AND p_valor_total < 'Infinity'::numeric) THEN
    RAISE EXCEPTION 'custo_portal: valor_total não finito ou ≤ 0 (%)', coalesce(p_valor_total::text, 'null') USING ERRCODE = 'CP001';
  END IF;
  -- Cada item: id inteiro e 3 NÚMEROS JSON. `IS DISTINCT FROM`, nunca `<>`: chave AUSENTE dá jsonb_typeof NULL, e
  -- `NULL <> 'number'` é NULL — o EXISTS leria "nada errado" e o item sem IPI passaria (verde por ausência).
  -- Número JSON nunca é NaN/Infinity (a string "NaN" tem tipo 'string').
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_itens) e
     WHERE jsonb_typeof(e) IS DISTINCT FROM 'object'
        OR (e->>'item_id') IS NULL OR (e->>'item_id') !~ '^[0-9]+$'
        OR jsonb_typeof(e->'qtde_final')       IS DISTINCT FROM 'number'
        OR jsonb_typeof(e->'valor_mercadoria') IS DISTINCT FROM 'number'
        OR jsonb_typeof(e->'valor_ipi')        IS DISTINCT FROM 'number'
  ) THEN
    RAISE EXCEPTION 'custo_portal: item sem id inteiro ou sem qtde_final/valor_mercadoria/valor_ipi numéricos' USING ERRCODE = 'CP001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_itens) e
     WHERE NOT ((e->>'qtde_final')::numeric > 0 AND (e->>'valor_mercadoria')::numeric > 0 AND (e->>'valor_ipi')::numeric >= 0)
  ) THEN
    RAISE EXCEPTION 'custo_portal: qtde_final/valor_mercadoria ≤ 0 ou valor_ipi < 0 no payload' USING ERRCODE = 'CP001';
  END IF;
  -- CP004 (forma barata): id repetido.
  SELECT count(DISTINCT (e->>'item_id')::bigint) INTO v_ids_distintos FROM jsonb_array_elements(p_itens) e;
  IF v_ids_distintos <> v_n THEN
    RAISE EXCEPTION 'custo_portal: item_id repetido no payload (% ids, % distintos)', v_n, v_ids_distintos USING ERRCODE = 'CP004';
  END IF;

  -- (1) CAS no próprio UPDATE: só grava se AINDA não há PO Omie e o pedido está em sucesso_portal. O row-lock
  -- serializa contra quem grava omie_pedido_compra_numero; sob READ COMMITTED o predicado é reavaliado.
  UPDATE public.pedido_compra_sugerido p
     SET valor_total_portal_provado           = p_valor_total,
         valor_total_portal_provado_em        = now(),
         valor_total_portal_provado_protocolo = p.portal_protocolo
   WHERE p.id = p_pedido_id
     AND p.omie_pedido_compra_numero IS NULL
     AND p.status_envio_portal = 'sucesso_portal';
  GET DIAGNOSTICS v_afetadas = ROW_COUNT;
  IF v_afetadas <> 1 THEN
    SELECT p.omie_pedido_compra_numero, p.status_envio_portal INTO v_omie, v_status
      FROM public.pedido_compra_sugerido p WHERE p.id = p_pedido_id;
    IF FOUND AND v_omie IS NOT NULL THEN
      RAISE EXCEPTION 'custo_portal: pedido % já tem PO Omie (%) — custo não muda mais', p_pedido_id, v_omie USING ERRCODE = 'CP002';
    END IF;
    RAISE EXCEPTION 'custo_portal: pedido % não elegível (status_envio_portal=%)',
      p_pedido_id, coalesce(v_status, 'inexistente') USING ERRCODE = 'CP003';
  END IF;

  -- (2) CP004 — o payload é o pedido INTEIRO: nem item a menos, nem item alheio. A decomposição tem de nascer em
  -- todo item; PO com metade dos itens sem IPI seria o custo misto que o tudo-ou-nada existe para impedir.
  SELECT count(*) INTO v_itens_total FROM public.pedido_compra_item WHERE pedido_id = p_pedido_id;
  SELECT count(*) INTO v_pertencem
    FROM jsonb_array_elements(p_itens) e
    JOIN public.pedido_compra_item i ON i.id = (e->>'item_id')::bigint AND i.pedido_id = p_pedido_id;
  IF v_n <> v_itens_total OR v_pertencem <> v_n THEN
    RAISE EXCEPTION 'custo_portal: o payload (% itens, % do pedido) não é o pedido % inteiro (% itens) — nada gravado',
      v_n, v_pertencem, p_pedido_id, v_itens_total USING ERRCODE = 'CP004';
  END IF;

  -- (3) CP006 — a alíquota de cada item, pela MESMA função que a edge leu. Ausente ≠ zero. UMA leitura só: sob
  -- READ COMMITTED cada comando vê um snapshot novo, e reler no UPDATE poderia gravar um IPI que a prova não validou
  -- (alíquota ou NCM alterados no meio). CP006, CP007 e a escrita usam esta mesma leitura materializada.
  SELECT coalesce(jsonb_agg(jsonb_build_object('item_id', x.item_id, 'ncm', x.ncm, 'aliquota_pct', x.aliquota_pct)), '[]'::jsonb)
    INTO v_aliq
    FROM public.sayerlack_ipi_itens(p_pedido_id) x;
  SELECT string_agg(coalesce(x.ncm, '(sem NCM)'), ', ' ORDER BY x.item_id) INTO v_sem_aliquota
    FROM jsonb_to_recordset(v_aliq) AS x(item_id bigint, ncm text, aliquota_pct numeric)
   WHERE x.aliquota_pct IS NULL;
  IF v_sem_aliquota IS NOT NULL THEN
    RAISE EXCEPTION 'custo_portal: item sem alíquota de IPI conhecida no pedido % (NCM: %) — nada gravado',
      p_pedido_id, v_sem_aliquota USING ERRCODE = 'CP006';
  END IF;

  -- (4) CP007 — a prova. IPI do item = round(round(mercadoria, 2) × alíquota ÷ 100, 2), meio centavo para cima: a
  -- edge faz a MESMA conta em centavos inteiros, logo a igualdade é EXATA. O total modelado (Σ linha + IPI) fecha
  -- com o cobrado dentro do arredondamento: meio centavo do total + 0,0101 por linha (spec §6).
  SELECT count(*) FILTER (WHERE c.ipi_payload IS DISTINCT FROM c.ipi), sum(c.linha + c.ipi)
    INTO v_ipi_divergente, v_total_modelado
    FROM (
      SELECT (e->>'valor_ipi')::numeric AS ipi_payload,
             round((e->>'valor_mercadoria')::numeric, 2) AS linha,
             round(round((e->>'valor_mercadoria')::numeric, 2) * x.aliquota_pct / 100, 2) AS ipi
        FROM jsonb_array_elements(p_itens) e
        JOIN jsonb_to_recordset(v_aliq) AS x(item_id bigint, ncm text, aliquota_pct numeric) ON x.item_id = (e->>'item_id')::bigint
    ) c;
  v_tolerancia := 0.005 + 0.0101 * v_n;
  IF v_ipi_divergente <> 0 OR v_total_modelado IS NULL OR abs(v_total_modelado - p_valor_total) > v_tolerancia THEN
    RAISE EXCEPTION 'custo_portal: a prova do IPI não fecha no pedido % (% IPI divergente; modelado %, cobrado %, tolerância %) — nada gravado',
      p_pedido_id, v_ipi_divergente, coalesce(v_total_modelado::text, 'null'), p_valor_total, v_tolerancia USING ERRCODE = 'CP007';
  END IF;

  -- (5) grava a decomposição (o que o PO leva) e o CUSTO COM IPI (o que tela, e-mail e valor_total leem — D1). O
  -- WHERE confere a quantidade: a ecoada pela edge tem de ser a da linha, e inteira — o PO manda
  -- nQtde = ceil(qtde_final); com 3,6 L, `4 × mercadoria ÷ 3,6` passaria 11% da mercadoria.
  UPDATE public.pedido_compra_item i
     SET preco_unitario_sem_ipi_portal = c.linha / i.qtde_final,
         valor_ipi_portal              = c.ipi,
         aliquota_ipi_portal           = c.aliquota_pct,
         ncm_ipi_portal                = c.ncm,
         valor_linha                   = c.linha + c.ipi,
         preco_unitario                = (c.linha + c.ipi) / i.qtde_final
    FROM (
      SELECT (e->>'item_id')::bigint AS item_id,
             (e->>'qtde_final')::numeric AS qtde_eco,
             round((e->>'valor_mercadoria')::numeric, 2) AS linha,
             round(round((e->>'valor_mercadoria')::numeric, 2) * x.aliquota_pct / 100, 2) AS ipi,
             x.aliquota_pct,
             x.ncm
        FROM jsonb_array_elements(p_itens) e
        JOIN jsonb_to_recordset(v_aliq) AS x(item_id bigint, ncm text, aliquota_pct numeric) ON x.item_id = (e->>'item_id')::bigint
    ) c
   WHERE i.id = c.item_id AND i.pedido_id = p_pedido_id AND i.qtde_final = c.qtde_eco AND i.qtde_final = trunc(i.qtde_final);
  GET DIAGNOSTICS v_atualizados = ROW_COUNT;
  IF v_atualizados <> v_n THEN
    RAISE EXCEPTION 'custo_portal: % de % itens com qtde_final igual à ecoada e inteira no pedido % — nada gravado',
      v_atualizados, v_n, p_pedido_id USING ERRCODE = 'CP004';
  END IF;

  -- (6) o DERIVADO, na mesma transação. Todo item acabou de ganhar valor_linha > 0: a soma não tem NULL.
  UPDATE public.pedido_compra_sugerido
     SET valor_total = (SELECT sum(valor_linha) FROM public.pedido_compra_item WHERE pedido_id = p_pedido_id)
   WHERE id = p_pedido_id;

  RETURN v_atualizados;
END;
$function$;

COMMENT ON FUNCTION public.sayerlack_aplicar_custo_portal(bigint, jsonb, numeric) IS
  'Custo do portal Sayerlack com IPI (edge enviar-pedido-portal-sayerlack, service_role): CAS omie IS NULL + sucesso_portal; payload = pedido inteiro {item_id, qtde_final, valor_mercadoria, valor_ipi}; IPI conferido contra ipi_aliquota_ncm (sayerlack_ipi_itens) com igualdade exata; prova contra o total cobrado; grava a decomposição (sem IPI/IPI/alíquota/NCM) e o custo com IPI, e remantém o derivado — uma transação. SQLSTATE CP001–CP004, CP006, CP007.';

-- CREATE OR REPLACE preserva o ACL; reemitir é barato e a postcondição confere.
REVOKE ALL ON FUNCTION public.sayerlack_aplicar_custo_portal(bigint, jsonb, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sayerlack_aplicar_custo_portal(bigint, jsonb, numeric) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sayerlack_aplicar_custo_portal(bigint, jsonb, numeric) TO service_role;

-- O #2459 caiu em PGRST202 com a função existindo: emitir o reload é o que separa a captura gravar de cair em erro_rpc.
NOTIFY pgrst, 'reload schema';

-- Postcondição: tudo no ar, e a RPC é a NOVA. Colar metade do bloco não pode passar calado.
DO $post$
DECLARE v_rpc oid; v_ipi oid; v_def text;
BEGIN
  IF (SELECT count(*) FROM public.ipi_aliquota_ncm WHERE ncm IN ('32081020','32082020','32089039','38140090','32081010',
        '32082019','32129090','32141020','32149000','29153999','32041210','38089219','29221919')) <> 13 THEN
    RAISE EXCEPTION 'POST FALHOU: ipi_aliquota_ncm sem as 13 alíquotas medidas — a captura ficaria cega por NCM';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ipi_aliquota_ncm'::regclass) THEN
    RAISE EXCEPTION 'POST FALHOU: ipi_aliquota_ncm sem RLS';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pedido_compra_item'
       AND column_name IN ('preco_unitario_sem_ipi_portal', 'valor_ipi_portal', 'aliquota_ipi_portal', 'ncm_ipi_portal')) <> 4 THEN
    RAISE EXCEPTION 'POST FALHOU: as 4 colunas da decomposição não existem em pedido_compra_item';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pedido_compra_item_ipi_portal_coerente'
                   AND conrelid = 'public.pedido_compra_item'::regclass) THEN
    RAISE EXCEPTION 'POST FALHOU: CHECK pedido_compra_item_ipi_portal_coerente ausente';
  END IF;
  SELECT p.oid INTO v_ipi FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'sayerlack_ipi_itens' AND pg_get_function_identity_arguments(p.oid) = 'p_pedido_id bigint';
  IF v_ipi IS NULL THEN
    RAISE EXCEPTION 'POST FALHOU: sayerlack_ipi_itens(bigint) não existe — a edge cairia em ipi_leitura_falhou';
  END IF;
  IF has_function_privilege('anon', v_ipi, 'EXECUTE') OR has_function_privilege('authenticated', v_ipi, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU: anon/authenticated executam sayerlack_ipi_itens — REVOKE por nome não pegou';
  END IF;
  IF NOT has_function_privilege('service_role', v_ipi, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU: service_role sem EXECUTE em sayerlack_ipi_itens — a edge não leria as alíquotas';
  END IF;
  SELECT p.oid INTO v_rpc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'sayerlack_aplicar_custo_portal'
     AND pg_get_function_identity_arguments(p.oid) = 'p_pedido_id bigint, p_itens jsonb, p_valor_total numeric';
  IF v_rpc IS NULL THEN
    RAISE EXCEPTION 'POST FALHOU: sayerlack_aplicar_custo_portal(bigint,jsonb,numeric) não existe';
  END IF;
  v_def := pg_get_functiondef(v_rpc);
  IF v_def NOT LIKE '%valor_mercadoria%' OR v_def NOT LIKE '%CP007%' OR v_def NOT LIKE '%sayerlack_ipi_itens%' THEN
    RAISE EXCEPTION 'POST FALHOU: a RPC no ar é a versão ANTERIOR (não cita valor_mercadoria/CP007/sayerlack_ipi_itens)';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_rpc) THEN
    RAISE EXCEPTION 'POST FALHOU: a RPC não é SECURITY DEFINER';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_rpc AND proconfig::text LIKE '%search_path=public%') THEN
    RAISE EXCEPTION 'POST FALHOU: search_path da RPC não está preso em public';
  END IF;
  IF has_function_privilege('anon', v_rpc, 'EXECUTE') OR has_function_privilege('authenticated', v_rpc, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU: anon/authenticated ainda executam sayerlack_aplicar_custo_portal — REVOKE por nome não pegou';
  END IF;
  IF NOT has_function_privilege('service_role', v_rpc, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU: service_role sem EXECUTE — a edge não conseguiria gravar custo';
  END IF;
  RAISE NOTICE 'preco_exato_po_sayerlack_ipi: 13 alíquotas, RLS, decomposição + CHECK, sayerlack_ipi_itens fechada, RPC v3 SECDEF/search_path/ACL ok';
END
$post$;

COMMIT;
