-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Portal Sayerlack — cancelamento observado ANTES de o pedido existir não se perde (Codex revisão final, achado 2)
--
-- O furo: `sayerlack_registrar_situacao_portal` (o escritor da situação) só faz UPDATE em `pedido_compra_sugerido`.
-- Duas leituras do MESMO protocolo: X lê "Aberto" e segue para importar; Y lê "6 - Cancelado" depois, mas o pedido
-- ainda não existe ⇒ o veto some; X cria o pedido (com a SUA situação, mais velha) e dispara o PO de um pedido
-- cancelado. Repetir o UPDATE depois de criar NÃO resolve (Codex): a ordem é que importa.
-- Base medida (psql-ro 2026-11-16): `sayerlack_portal_evidencia` já tem 21 linhas com protocolo e pedido_id NULL —
-- a leitura existe sem pedido; falta guardar a situação dela num lugar que a importação consulte.
--
-- A correção (decisão do founder):
--   a. a evidência ganha `situacao_codigo` — COLUNA DEDICADA (nunca dentro de jsonb), insert-only (o trigger de
--      imutabilidade já fecha UPDATE/DELETE), 1 escritor (a edge, v1.16, no INSERT da leitura);
--   b. a RPC de importação ganha o 7º argumento `p_lido_de` e, sob o advisory lock do protocolo que já existia,
--      recusa (IP010 [cancelado_no_portal]) se houver evidência do MESMO protocolo com situação 6 e `lido_ate`
--      posterior ao início desta leitura.
-- Codex rodada 1 (3 P1; founder decidiu ampliar): (c) o INSERT da evidência "6" toma a MESMA advisory lock da
-- importação (trigger ALWAYS) — senão Y grava o "6" entre a checagem e o commit de X e o registrador de Y não acha o
-- pedido; (d) o pedido importado guarda `importado_portal_lido_de` e `reposicao_claim_disparo` recusa, no MESMO WHERE
-- que grava, evidência "6" posterior a esse marco (o que sobra: INSERT que commita depois do prazo da edge). A edge
-- v1.16 re-tenta a evidência de um "6" e, falhando, abre a pendência da varredura. FORA (PR seguinte): a varredura
-- descarta cancelado de protocolo ainda sem pedido (P1-3, preexistente).
-- Sem DROP: a assinatura de 6 argumentos (a que a edge v1.15 no ar chama) vira um WRAPPER do corpo novo com marco
-- NULL (qualquer cancelamento registrado recusa — fail-closed; a v1.15 não grava a coluna, então na transição nada
-- muda para ela). Sem DEFAULT no 7º argumento: o PostgREST resolve 6 × 7 argumentos sem ambiguidade.
--
-- Transação: do executor (`bun run db:aplicar`) — o arquivo NÃO leva BEGIN/COMMIT.
-- Prova: db/test-sayerlack-importar-cancelado.sh (PG17, os dois locales, --falsificar).
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

-- ── a. A situação lida, em coluna dedicada da evidência ──────────────────────────────────────────────
ALTER TABLE public.sayerlack_portal_evidencia ADD COLUMN IF NOT EXISTS situacao_codigo text;
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sayerlack_portal_evidencia_situacao_codigo'
                   AND conrelid = 'public.sayerlack_portal_evidencia'::regclass) THEN
    ALTER TABLE public.sayerlack_portal_evidencia ADD CONSTRAINT sayerlack_portal_evidencia_situacao_codigo
      CHECK (situacao_codigo IS NULL OR situacao_codigo ~ '^[1-7]$');
  END IF;
END
$chk$;
COMMENT ON COLUMN public.sayerlack_portal_evidencia.situacao_codigo IS
  'Código da situação do pedido no portal NESTA leitura (1..7; 6 = Cancelado), o mesmo que vai a sayerlack_registrar_situacao_portal. NULL = não lida/ilegível (ausente ≠ aberto). Insert-only, escritor único: edge sayerlack-importar-pedido-portal (v1.16+). Lida por sayerlack_importar_pedido_portal (IP010).';

-- ── a2. O marco da leitura que criou o pedido (Codex rodada 1, P1-1): é contra ele que o claim ordena a evidência ──
ALTER TABLE public.pedido_compra_sugerido ADD COLUMN IF NOT EXISTS importado_portal_lido_de timestamptz;
COMMENT ON COLUMN public.pedido_compra_sugerido.importado_portal_lido_de IS
  'Início da leitura do portal que CRIOU este pedido pela importação (p_lido_de da edge, v1.16+). NULL = pedido do app ou importado pela edge ≤ v1.15. reposicao_claim_disparo recusa se houver evidência de cancelado (situacao_codigo 6) do protocolo com lido_ate posterior. Escritor único: sayerlack_importar_pedido_portal.';

-- ── a3. A evidência de cancelado espera a importação do MESMO protocolo (Codex rodada 1, P1-1) ─────────
-- Sem isto, Y grava "6" DEPOIS da checagem do IP010 de X e ANTES do commit de X: o registrador de Y não acha o pedido
-- (UPDATE de 0 linhas) e X dispara. Com a mesma advisory lock da importação, o INSERT de Y ou commita antes (o IP010 de
-- X vê) ou espera o commit de X (e o registrador de Y, que roda depois, acha o pedido). O claim (c2) cobre o que sobra:
-- o INSERT que só commita depois do prazo da edge.
CREATE OR REPLACE FUNCTION public.sayerlack__evidencia_cancelado_espera_importacao()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('sayerlack_importar_pedido_portal:' || NEW.protocolo));
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sayerlack__evidencia_cancelado_espera_importacao() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sayerlack__evidencia_cancelado_espera_importacao() FROM anon;
REVOKE ALL ON FUNCTION public.sayerlack__evidencia_cancelado_espera_importacao() FROM authenticated;
DROP TRIGGER IF EXISTS trg_evidencia_cancelado_espera_importacao ON public.sayerlack_portal_evidencia;
CREATE TRIGGER trg_evidencia_cancelado_espera_importacao
  BEFORE INSERT ON public.sayerlack_portal_evidencia
  FOR EACH ROW WHEN (NEW.situacao_codigo = '6')
  EXECUTE FUNCTION public.sayerlack__evidencia_cancelado_espera_importacao();
ALTER TABLE public.sayerlack_portal_evidencia ENABLE ALWAYS TRIGGER trg_evidencia_cancelado_espera_importacao;

-- ── b. Pré-flight: 6 args vivo = o de 20261111150000 (md5 8627397926bfc664e57be761844ed42c, psql-ro 2026-11-16) ──
-- TRAVA antes de ler (ALTER sem efeito: a volatilidade viva) e PRE: md5 EXATO de cada corpo vivo ∈ {predecessor, este}.
DO $trava$
BEGIN
  IF to_regprocedure('public.sayerlack_importar_pedido_portal(text,date,numeric,jsonb,uuid,text)') IS NOT NULL THEN
    ALTER FUNCTION public.sayerlack_importar_pedido_portal(text,date,numeric,jsonb,uuid,text) VOLATILE;
  END IF;
  IF to_regprocedure('public.sayerlack_importar_pedido_portal(text,date,numeric,jsonb,uuid,text,timestamptz)') IS NOT NULL THEN
    ALTER FUNCTION public.sayerlack_importar_pedido_portal(text,date,numeric,jsonb,uuid,text,timestamptz) VOLATILE;
  END IF;
END
$trava$;
DO $pre$
DECLARE
  v6 text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.sayerlack_importar_pedido_portal(text,date,numeric,jsonb,uuid,text)'));
  v7 text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.sayerlack_importar_pedido_portal(text,date,numeric,jsonb,uuid,text,timestamptz)'));
BEGIN
  IF v6 IS NULL OR v6 NOT IN ('8627397926bfc664e57be761844ed42c', 'e8e7bf4cc7450b2e2caaa19db8a69f14') THEN
    RAISE EXCEPTION 'PRE FALHOU: sayerlack_importar_pedido_portal (6 args) viva (md5 %) não é a de 20261111150000 nem o wrapper desta', v6;
  END IF;
  -- Codex rodada 4 (P1, legado): evidência anterior a esta migration não tem `situacao_codigo` (imutável: sem
  -- backfill), então um importado ANTIGO ainda disparável escaparia do veto. Medido 0 em 2026-11-16 (10 importados,
  -- 0 disparáveis); a migration só passa se continuar 0 — senão, decisão do founder antes de aplicar.
  IF EXISTS (SELECT 1 FROM public.pedido_compra_sugerido p
              WHERE p.importado_portal_em IS NOT NULL
                AND p.status IN ('aprovado_aguardando_disparo', 'falha_envio')
                AND NULLIF(NULLIF(btrim(COALESCE(p.omie_pedido_compra_id, '')), ''), '0') IS NULL
                AND p.importado_portal_lido_de IS NULL) THEN   -- a coluna nasce na seção a2, antes deste bloco
    RAISE EXCEPTION 'PRE FALHOU: há pedido importado ANTES desta migration ainda disparável (sem PO) — a evidência antiga não tem situacao_codigo e o veto não o cobriria';
  END IF;
  IF v7 IS NOT NULL AND v7 <> 'ce4556cbc79994b1061fd64332dd1bc3' THEN
    RAISE EXCEPTION 'PRE FALHOU: sayerlack_importar_pedido_portal (7 args) já existe com outro corpo (md5 %)', v7;
  END IF;
END
$pre$;

-- ── c. O corpo (7 args): o de 20261111150000 + o marco da leitura + o IP010 sob o lock ───────────────
CREATE OR REPLACE FUNCTION public.sayerlack_importar_pedido_portal(p_protocolo text, p_data_entrega date, p_valor_total numeric, p_itens jsonb, p_operador uuid, p_condicao_portal text, p_lido_de timestamptz)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_conf        jsonb;
  v_existente   bigint;
  v_n           integer;
  v_sem_depara  text;
  v_fracionados text;
  v_fornecedor  text;
  v_n_fornec    integer;
  v_pedido_id   bigint;
  v_payload     jsonb;
  v_atualizados integer;
  v_po_omie     text;
  v_em_voo      text;
  v_cond_codigo text;
  v_cond_desc   text;
  v_cond_parc   integer;
  v_cancelado_ate timestamptz;
BEGIN
  -- Gate de papel (defesa em profundidade; a tranca é o privilégio: só service_role executa).
  IF auth.uid() IS NOT NULL AND NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;

  -- IP001 — payload. Ausente ≠ zero: nada aqui degrada para default.
  IF p_protocolo IS NULL OR p_protocolo !~ '^[0-9]{3,12}$' THEN
    RAISE EXCEPTION 'importar_portal: protocolo inválido (%)', coalesce(p_protocolo, 'null') USING ERRCODE = 'IP001';
  END IF;
  IF p_data_entrega IS NULL THEN
    RAISE EXCEPTION 'importar_portal: data de entrega ausente' USING ERRCODE = 'IP001';
  END IF;
  IF p_valor_total IS NULL OR p_valor_total = 'NaN'::numeric OR NOT (p_valor_total > 0 AND p_valor_total < 'Infinity'::numeric) THEN
    RAISE EXCEPTION 'importar_portal: valor_total não finito ou ≤ 0 (%)', coalesce(p_valor_total::text, 'null') USING ERRCODE = 'IP001';
  END IF;
  -- O início DESTA leitura do portal (o `lido_de` da edge): o marco contra o qual um cancelamento observado por outra
  -- leitura é ordenado (IP010). NULL só pelo wrapper de 6 argumentos (edge ≤ v1.15): sem marco, qualquer cancelamento
  -- registrado do protocolo recusa. Futuro além da folga de relógio = marco inventado ⇒ recusa (nunca pula o IP010).
  IF p_lido_de IS NOT NULL AND (NOT isfinite(p_lido_de) OR p_lido_de > now() + interval '5 minutes') THEN
    RAISE EXCEPTION 'importar_portal: início da leitura inválido (%)', p_lido_de USING ERRCODE = 'IP001';
  END IF;
  IF p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' OR jsonb_array_length(p_itens) = 0 THEN
    RAISE EXCEPTION 'importar_portal: pedido sem itens' USING ERRCODE = 'IP001';
  END IF;
  -- `IS DISTINCT FROM`, nunca `<>`: chave ausente dá NULL e `NULL <> 'number'` passaria (verde por ausência).
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_itens) e
     WHERE jsonb_typeof(e) IS DISTINCT FROM 'object'
        OR jsonb_typeof(e->'sku_portal') IS DISTINCT FROM 'string'
        OR btrim(e->>'sku_portal') = ''
        OR jsonb_typeof(e->'qtde_portal') IS DISTINCT FROM 'number'
        OR jsonb_typeof(e->'valor_mercadoria') IS DISTINCT FROM 'number'
  ) THEN
    RAISE EXCEPTION 'importar_portal: item sem sku_portal/qtde_portal/valor_mercadoria' USING ERRCODE = 'IP001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_itens) e
     WHERE NOT ((e->>'qtde_portal')::numeric > 0 AND (e->>'valor_mercadoria')::numeric > 0)
  ) THEN
    RAISE EXCEPTION 'importar_portal: qtde_portal ou valor_mercadoria ≤ 0' USING ERRCODE = 'IP001';
  END IF;

  -- Serializa importações do MESMO protocolo (duas abas, duplo clique): a 2ª espera e cai no "já existe".
  PERFORM pg_advisory_xact_lock(hashtext('sayerlack_importar_pedido_portal:' || p_protocolo));

  SELECT id INTO v_existente FROM public.pedido_compra_sugerido WHERE portal_protocolo = p_protocolo;
  IF v_existente IS NOT NULL THEN
    RETURN jsonb_build_object('pedido_id', v_existente, 'ja_existia', true);
  END IF;

  -- IP010 [CANCELADO-ANTES-DO-PEDIDO] (Codex revisão final, achado 2): o escritor da situação só faz UPDATE no pedido —
  -- um cancelamento lido por OUTRA leitura enquanto este pedido ainda não existia se perdia, e esta importação (lida
  -- antes) criava o pedido e disparava o PO. A evidência guarda a situação em coluna dedicada (insert-only, 1 escritor);
  -- sob o MESMO advisory lock do protocolo, cancelado (6) observado com `lido_ate` posterior ao início desta leitura
  -- recusa. Nada é gravado; a próxima importação (leitura nova, posterior ao cancelamento) decide de novo.
  SELECT max(e.lido_ate) INTO v_cancelado_ate
    FROM public.sayerlack_portal_evidencia e
   WHERE e.protocolo = p_protocolo
     AND e.situacao_codigo = '6'
     AND (p_lido_de IS NULL OR e.lido_ate > p_lido_de);
  IF v_cancelado_ate IS NOT NULL THEN
    RAISE EXCEPTION 'importar_portal: [cancelado_no_portal] o pedido % foi lido cancelado no portal (leitura até %) depois do início desta leitura (%) — nada gravado',
      p_protocolo, v_cancelado_ate, coalesce(p_lido_de::text, 'sem marco') USING ERRCODE = 'IP010';
  END IF;

  -- IP006 — PO lançado DIRETO no Omie com este nº do portal no contrato (sem passar pelo app: 210 Sayerlack
  -- assim em 2026-10-14). Importar criaria um 2º PO com outra chave AFI-<id>. Codex 2026-10-14, P1.
  -- Limite: o espelho `purchase_orders_tracking` tem a defasagem do sync — PO digitado no Omie minutos antes escapa.
  SELECT string_agg(coalesce(t.numero_pedido, '?'), ', ') INTO v_po_omie
    FROM public.purchase_orders_tracking t
   WHERE t.empresa::text = 'OBEN'
     -- Contrato COMPOSTO ("1998739/1998740", 15 POs em prod): compara cada número (Codex+Fable 2026-11, P1).
     AND EXISTS (SELECT 1 FROM unnest(string_to_array(t.numero_contrato_fornecedor, '/')) AS c(n) WHERE btrim(c.n) = p_protocolo);
  IF v_po_omie IS NOT NULL THEN
    RAISE EXCEPTION 'importar_portal: já existe pedido de compra no Omie com o contrato % (PO %)', p_protocolo, v_po_omie USING ERRCODE = 'IP006';
  END IF;

  -- IP008 — pedido do PRÓPRIO app em envio/conciliação no portal (ainda sem protocolo no banco): o nº digitado pode
  -- ser ele — importar criaria 2º pedido e tomaria o protocolo do envio em voo (Codex+Fable 2026-11). Mesma trava do cron.
  SELECT string_agg('#' || id || ' (' || status_envio_portal || ')', ', ' ORDER BY id) INTO v_em_voo
    FROM public.pedido_compra_sugerido
   WHERE empresa = 'OBEN'
     AND status_envio_portal IN ('enviando_portal', 'aceito_portal_sem_protocolo', 'indeterminado_requer_conciliacao');
  IF v_em_voo IS NOT NULL THEN
    RAISE EXCEPTION 'importar_portal: pedido(s) do app em envio/conciliação no portal: % — espere terminar (ou concilie) e importe de novo', v_em_voo USING ERRCODE = 'IP008';
  END IF;

  -- IP007 — condição de pagamento LIDA do portal ("70 - 7 DIAS") → código do catálogo Omie OBEN por UMA função
  -- (sayerlack_condicao_portal_para_omie): de-para explícito do founder primeiro (D-2), regra exata de texto depois.
  -- Sem correspondência única ⇒ a função lança IP007. Nunca chuta e nunca cai em "À Vista" (ausente ≠ à vista).
  SELECT c.codigo, c.descricao, c.num_parcelas INTO v_cond_codigo, v_cond_desc, v_cond_parc
    FROM public.sayerlack_condicao_portal_para_omie(p_condicao_portal) c;

  v_n := jsonb_array_length(p_itens);

  -- IP005 — o mesmo SKU duas vezes no pedido do portal: a prova de custo é por item, não somamos às cegas.
  IF (SELECT count(DISTINCT upper(btrim(e->>'sku_portal'))) FROM jsonb_array_elements(p_itens) e) <> v_n THEN
    RAISE EXCEPTION 'importar_portal: SKU repetido no pedido % do portal', p_protocolo USING ERRCODE = 'IP005';
  END IF;

  -- De-para inverso: EXATAMENTE um mapeamento ativo OBEN por sku_portal (o UNIQUE é por sku_omie,
  -- então 2 sku_omie com o mesmo sku_portal é possível — e é ambíguo, logo "sem de-para").
  CREATE TEMP TABLE IF NOT EXISTS _importar_portal_itens (
    ordem int, sku_portal text, qtde_portal numeric, valor_mercadoria numeric,
    n_map int, sku_omie text, fornecedor_nome text, fator numeric, qtde_omie numeric, descricao text
  ) ON COMMIT DROP;
  TRUNCATE _importar_portal_itens;
  INSERT INTO _importar_portal_itens (ordem, sku_portal, qtde_portal, valor_mercadoria, n_map, sku_omie, fornecedor_nome, fator)
  SELECT e.ord::int,
         upper(btrim(e.val->>'sku_portal')),
         (e.val->>'qtde_portal')::numeric,
         (e.val->>'valor_mercadoria')::numeric,
         (SELECT count(*) FROM public.sku_fornecedor_externo d
           WHERE d.empresa = 'OBEN' AND d.ativo AND upper(btrim(d.sku_portal)) = upper(btrim(e.val->>'sku_portal'))),
         (SELECT min(d.sku_omie) FROM public.sku_fornecedor_externo d
           WHERE d.empresa = 'OBEN' AND d.ativo AND upper(btrim(d.sku_portal)) = upper(btrim(e.val->>'sku_portal'))),
         (SELECT min(d.fornecedor_nome) FROM public.sku_fornecedor_externo d
           WHERE d.empresa = 'OBEN' AND d.ativo AND upper(btrim(d.sku_portal)) = upper(btrim(e.val->>'sku_portal'))),
         (SELECT min(d.fator_conversao) FROM public.sku_fornecedor_externo d
           WHERE d.empresa = 'OBEN' AND d.ativo AND upper(btrim(d.sku_portal)) = upper(btrim(e.val->>'sku_portal')))
    FROM jsonb_array_elements(p_itens) WITH ORDINALITY AS e(val, ord);

  SELECT string_agg(sku_portal || CASE WHEN n_map > 1 THEN ' (ambíguo: ' || n_map || ' SKUs Omie)' ELSE '' END, ', ' ORDER BY ordem)
    INTO v_sem_depara
    FROM _importar_portal_itens WHERE n_map <> 1;
  IF v_sem_depara IS NOT NULL THEN
    RAISE EXCEPTION 'importar_portal: sem de-para ativo no app para: %', v_sem_depara USING ERRCODE = 'IP002';
  END IF;

  -- IP004 — todos do MESMO fornecedor, e ele é a Sayerlack (o disparo decide portal×Omie pelo nome).
  SELECT count(DISTINCT fornecedor_nome), min(fornecedor_nome) INTO v_n_fornec, v_fornecedor FROM _importar_portal_itens;
  IF v_n_fornec <> 1 OR v_fornecedor IS NULL OR v_fornecedor !~* 'sayerlack' THEN
    RAISE EXCEPTION 'importar_portal: de-para aponta fornecedor(es) inesperado(s): %',
      (SELECT string_agg(DISTINCT coalesce(fornecedor_nome, 'null'), ', ') FROM _importar_portal_itens) USING ERRCODE = 'IP004';
  END IF;

  -- IP003 — fator = unidades do PORTAL por unidade do Omie ⇒ qtde_omie = qtde_portal ÷ fator, INTEIRA.
  -- (O PO manda nQtde inteiro e a RPC de custo exige qtde_final inteira; arredondar aqui mudaria o preço.)
  UPDATE _importar_portal_itens
     SET qtde_omie = CASE WHEN fator > 0 THEN qtde_portal / fator END
   WHERE qtde_omie IS NULL;  -- WHERE obrigatório: o pg-safeupdate do Supabase recusa UPDATE sem WHERE vindo da API
  SELECT string_agg(sku_portal || ' (' || trim_scale(qtde_portal) || ' ÷ fator ' || coalesce(trim_scale(fator)::text, 'null') || ')', ', ' ORDER BY ordem)
    INTO v_fracionados
    FROM _importar_portal_itens
   WHERE qtde_omie IS NULL OR NOT (qtde_omie > 0) OR qtde_omie <> trunc(qtde_omie);
  IF v_fracionados IS NOT NULL THEN
    RAISE EXCEPTION 'importar_portal: quantidade não vira inteira no Omie: %', v_fracionados USING ERRCODE = 'IP003';
  END IF;

  UPDATE _importar_portal_itens t
     SET descricao = (SELECT p.descricao FROM public.omie_products p
                       WHERE p.account = 'oben' AND p.omie_codigo_produto::text = t.sku_omie
                       LIMIT 1)
   WHERE t.descricao IS NULL;  -- idem: sem WHERE o pg-safeupdate recusa (1º uso real, 2026-10-16)

  INSERT INTO public.pedido_compra_sugerido (
    empresa, fornecedor_nome, valor_total, num_skus, status,
    aprovado_por, aprovado_em, canal_usado,
    condicao_pagamento_codigo, condicao_pagamento_descricao, num_parcelas, condicao_origem, condicao_portal_lida,
    status_envio_portal, enviado_portal_em, portal_protocolo, portal_data_entrega,
    importado_portal_em, importado_portal_por, resposta_canal, importado_portal_lido_de
  ) VALUES (
    'OBEN', v_fornecedor,
    (SELECT sum(valor_mercadoria) FROM _importar_portal_itens),  -- provisório: a RPC de custo regrava com o IPI
    v_n, 'aprovado_aguardando_disparo',
    p_operador, now(), 'portal_sayerlack',
    v_cond_codigo, v_cond_desc, v_cond_parc, 'portal_sayerlack', btrim(p_condicao_portal),
    'sucesso_portal', now(), p_protocolo, p_data_entrega,
    now(), p_operador,
    jsonb_build_object('importado_portal', true, 'valor_total_portal', p_valor_total), p_lido_de
  ) RETURNING id INTO v_pedido_id;

  INSERT INTO public.pedido_compra_item (
    pedido_id, sku_codigo_omie, sku_descricao, qtde_sugerida, qtde_final,
    preco_unitario, valor_linha, sku_portal_aprovado, fator_portal_aprovado
  )
  SELECT v_pedido_id, t.sku_omie, coalesce(t.descricao, t.sku_portal), t.qtde_omie, t.qtde_omie,
         t.valor_mercadoria / t.qtde_omie, t.valor_mercadoria, t.sku_portal, t.fator
    FROM _importar_portal_itens t
   ORDER BY t.ordem;

  -- O custo pela MESMA prova do fluxo normal. O IPI do payload é a conta da própria RPC de custo
  -- (round(round(merc,2) × alíquota ÷ 100, 2)) sobre a alíquota de `sayerlack_ipi_itens`; a prova
  -- EXTERNA é o total cobrado pelo portal (p_valor_total). Alíquota ausente vira 0 só aqui, no
  -- payload — a RPC de custo recusa antes (CP006, ausente ≠ zero) e nada é gravado.
  SELECT jsonb_agg(jsonb_build_object(
           'item_id', i.id,
           'qtde_final', i.qtde_final,
           'valor_mercadoria', i.valor_linha,
           'valor_ipi', round(round(i.valor_linha, 2) * coalesce(x.aliquota_pct, 0) / 100, 2)
         ) ORDER BY i.id)
    INTO v_payload
    FROM public.pedido_compra_item i
    LEFT JOIN public.sayerlack_ipi_itens(v_pedido_id) x ON x.item_id = i.id
   WHERE i.pedido_id = v_pedido_id;

  v_atualizados := public.sayerlack_aplicar_custo_portal(v_pedido_id, v_payload, p_valor_total);
  IF v_atualizados <> v_n THEN
    RAISE EXCEPTION 'importar_portal: custo aplicado em % de % itens — nada gravado', v_atualizados, v_n USING ERRCODE = 'IP001';
  END IF;

  -- 5.2 (Codex P1): o retrato desta leitura nasce AQUI, na mesma transação do pedido — uma resposta perdida ou uma
  -- falha depois deste ponto não pode deixar o pedido sem a referência contra a qual a próxima leitura se compara.
  -- A porta também prova que o pedido recém-gravado bate com a leitura; se não bater, nada fica gravado.
  v_conf := public.sayerlack_conferir_portal(
    v_pedido_id,
    jsonb_build_object(
      'protocolo', p_protocolo, 'condicao', btrim(p_condicao_portal), 'valor_total', p_valor_total,
      'lido_de', now(), 'lido_ate', now(),
      'itens', (SELECT jsonb_agg(jsonb_build_object('sku_portal', e->'sku_portal', 'qtde_portal', e->'qtde_portal',
                                                    'valor_mercadoria', e->'valor_mercadoria') ORDER BY o)
                  FROM jsonb_array_elements(p_itens) WITH ORDINALITY AS x(e, o))),
    NULL, 'importacao');
  IF v_conf->>'conferido' IS DISTINCT FROM 'true' OR v_conf->>'divergente' IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'importar_portal: o pedido gravado não bate com a leitura do portal (%)', left(v_conf::text, 300)
      USING ERRCODE = 'IP009';
  END IF;

  RETURN jsonb_build_object('pedido_id', v_pedido_id, 'ja_existia', false);
END;
$function$;
REVOKE ALL ON FUNCTION public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid, text, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid, text, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid, text, timestamptz) TO service_role;

-- ── d. 6 args: wrapper do corpo novo (REPLACE preserva o ACL; reemitido mesmo assim) ─────────────────
CREATE OR REPLACE FUNCTION public.sayerlack_importar_pedido_portal(p_protocolo text, p_data_entrega date, p_valor_total numeric, p_itens jsonb, p_operador uuid, p_condicao_portal text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Edge ≤ v1.15 (sem o início da leitura): o mesmo corpo, sem marco — qualquer cancelamento registrado recusa.
  RETURN public.sayerlack_importar_pedido_portal(p_protocolo, p_data_entrega, p_valor_total, p_itens, p_operador,
                                                 p_condicao_portal, NULL::timestamptz);
END;
$function$;
REVOKE ALL ON FUNCTION public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid, text) TO service_role;

-- ── c2. Claim: o veto da evidência de cancelado, NO MESMO WHERE QUE GRAVA (Codex rodada 1, P1-1) ─────────────
-- Pré-flight: pg_get_functiondef da PROD em 2026-11-16 = a de 20261111150000 (md5 d0229b984e3d60d30d334fb2c0289daf).
DO $trava_c$
BEGIN
  IF to_regprocedure('public.reposicao_claim_disparo(bigint,text)') IS NOT NULL THEN
    ALTER FUNCTION public.reposicao_claim_disparo(bigint,text) VOLATILE;
  END IF;
END
$trava_c$;
DO $pre_c$
DECLARE
  v text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.reposicao_claim_disparo(bigint,text)'));
BEGIN
  IF v IS NULL OR v NOT IN ('d0229b984e3d60d30d334fb2c0289daf', '29220979b99f9520183abb68d9ae5301') THEN
    RAISE EXCEPTION 'PRE FALHOU: reposicao_claim_disparo viva (md5 %) não é a de 20261111150000 nem esta', v;
  END IF;
END
$pre_c$;
CREATE OR REPLACE FUNCTION public.reposicao_claim_disparo(p_pedido_id bigint, p_origem text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status text;
  v_desde  timestamptz;
  v_atual  text;
  v_cod    text;
  v_sprot  text;
  v_sem    timestamptz;
  v_claim  timestamptz;
  v_div    bigint;
  v_canc_ev timestamptz;
  v_proto_lock text;
BEGIN
  -- ⚠️ O guard e a escrita são UMA instrução. Não separe: o `status IN (…)`, o veto de cancelado no portal e o da
  -- divergência portal × app (5.2) presos a ESTE WHERE são o que faz o Postgres re-avaliá-los contra a linha
  -- recém-commitada (EvalPlanQual, READ COMMITTED). Movê-los para um SELECT acima reabre o Cenário B.
  -- `atualizado_em` NÃO é tocado.
  -- [CLAIM-LOCK-PROTOCOLO] Codex 2 (rodada 2, P1): a MESMA advisory lock da importação e da evidência "6", ANTES do
  -- UPDATE. Sem ela, um claim que espera a trava da LINHA reavalia só a linha (EvalPlanQual) e não enxerga a evidência
  -- que commitou nesse meio; com ela, o UPDATE abaixo começa depois de qualquer INSERT de "6" em voo — snapshot novo.
  SELECT NULLIF(btrim(COALESCE(portal_protocolo, '')), '') INTO v_proto_lock FROM pedido_compra_sugerido WHERE id = p_pedido_id;
  IF v_proto_lock IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('sayerlack_importar_pedido_portal:' || v_proto_lock));
  END IF;

  UPDATE pedido_compra_sugerido
     SET disparo_claim_em  = COALESCE(disparo_claim_em, NOW()),
         disparo_claim_por = COALESCE(disparo_claim_por,
                                      left(COALESCE(NULLIF(btrim(p_origem), ''), 'edge'), 120))
   WHERE id = p_pedido_id
     AND status IN ('aprovado_aguardando_disparo', 'falha_envio')
     AND portal_situacao_codigo IS DISTINCT FROM '6'
     AND portal_divergencia_aberta_id IS NULL
     -- [CANCELADO-NA-EVIDENCIA] Codex 2 (rodada 1, P1-1): pedido importado e cancelado no portal por OUTRA leitura
     -- posterior à que o criou — o veto que o registrador da situação não conseguiu gravar (o pedido não existia).
     -- Importado (importado_portal_em) com marco NULL = edge ≤ v1.15 pelo wrapper: sem ordem possível, qualquer "6"
     -- registrado veta (Codex rodada 3, P1) — salvo re-aberto depois.
     AND NOT (importado_portal_em IS NOT NULL AND EXISTS (SELECT 1 FROM public.sayerlack_portal_evidencia e
                  WHERE e.protocolo = btrim(pedido_compra_sugerido.portal_protocolo)
                    AND e.situacao_codigo = '6'
                    AND (pedido_compra_sugerido.importado_portal_lido_de IS NULL
                         OR e.lido_ate > pedido_compra_sugerido.importado_portal_lido_de)
                    -- Re-aberto no portal (Codex rodada 2, P2): leitura POSTERIOR ao cancelamento com outra situação.
                    AND NOT EXISTS (SELECT 1 FROM public.sayerlack_portal_evidencia z
                                     WHERE z.protocolo = e.protocolo AND z.situacao_codigo IS DISTINCT FROM '6'
                                       AND z.situacao_codigo IS NOT NULL AND z.lido_de > e.lido_ate)))
  RETURNING status, disparo_claim_em INTO v_status, v_desde;

  IF v_status IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', true, 'pedido_id', p_pedido_id,
                              'status', v_status, 'desde', v_desde);
  END IF;

  -- 0 linhas. A DECISÃO já foi tomada acima — esta leitura só MONTA A MENSAGEM.
  SELECT status, portal_situacao_codigo, portal_situacao_protocolo, portal_situacao_em, disparo_claim_em,
         portal_divergencia_aberta_id
    INTO v_atual, v_cod, v_sprot, v_sem, v_claim, v_div
    FROM pedido_compra_sugerido WHERE id = p_pedido_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'pedido_id', p_pedido_id,
                              'motivo', 'pedido não encontrado');
  END IF;

  SELECT max(e.lido_ate) INTO v_canc_ev
    FROM public.pedido_compra_sugerido p
    JOIN public.sayerlack_portal_evidencia e
      ON e.protocolo = btrim(p.portal_protocolo) AND e.situacao_codigo = '6'
     AND (p.importado_portal_lido_de IS NULL OR e.lido_ate > p.importado_portal_lido_de)
   WHERE p.id = p_pedido_id
     AND p.importado_portal_em IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.sayerlack_portal_evidencia z
                      WHERE z.protocolo = e.protocolo AND z.situacao_codigo IS DISTINCT FROM '6'
                        AND z.situacao_codigo IS NOT NULL AND z.lido_de > e.lido_ate);
  IF v_canc_ev IS NOT NULL AND v_atual IN ('aprovado_aguardando_disparo', 'falha_envio') THEN
    RETURN jsonb_build_object(
      'claimed', false, 'pedido_id', p_pedido_id, 'status', v_atual,
      'bloqueio', 'cancelado_no_portal', 'pendente_desde', v_claim, 'situacao_em', v_canc_ev,
      'motivo', 'pedido cancelado no portal Sayerlack (lido por outra leitura em ' ||
                to_char(v_canc_ev AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') || ', depois da que o importou): disparo bloqueado'
    );
  END IF;

  IF v_cod = '6' AND v_atual IN ('aprovado_aguardando_disparo', 'falha_envio') THEN
    -- `pendente_desde` não nulo = uma tentativa anterior abriu a pendência e não chegou ao desfecho: pode haver
    -- PO no Omie com resposta perdida. A edge concilia SÓ POR CONSULTA (nunca IncluirPedCompra).
    RETURN jsonb_build_object(
      'claimed', false, 'pedido_id', p_pedido_id, 'status', v_atual,
      'bloqueio', 'cancelado_no_portal', 'pendente_desde', v_claim, 'situacao_em', v_sem,
      'motivo', 'pedido cancelado no portal Sayerlack (protocolo ' || COALESCE(v_sprot, '?') ||
                ', lido em ' || COALESCE(to_char(v_sem AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI'), '?') ||
                '): disparo bloqueado'
    );
  END IF;

  IF v_div IS NOT NULL AND v_atual IN ('aprovado_aguardando_disparo', 'falha_envio') THEN
    -- Idem: com pendência aberta (`pendente_desde`), a edge concilia SÓ POR CONSULTA — repetir o IncluirPedCompra
    -- mandaria ao Omie o pedido antigo que o portal já não tem.
    RETURN jsonb_build_object(
      'claimed', false, 'pedido_id', p_pedido_id, 'status', v_atual,
      'bloqueio', 'alterado_no_portal', 'pendente_desde', v_claim, 'divergencia_id', v_div,
      'motivo', 'pedido alterado no portal Sayerlack (divergência #' || v_div ||
                ' com o pedido do app): disparo bloqueado até aceitar o portal ou o portal voltar'
    );
  END IF;

  RETURN jsonb_build_object(
    'claimed', false, 'pedido_id', p_pedido_id, 'status', v_atual,
    'motivo', 'pedido não está mais disparável (status atual: '
              || COALESCE(v_atual, '(desconhecido)') || ')'
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.reposicao_claim_disparo(bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reposicao_claim_disparo(bigint, text) FROM anon;
REVOKE ALL ON FUNCTION public.reposicao_claim_disparo(bigint, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_claim_disparo(bigint, text) TO service_role;

-- ── POS ───────────────────────────────────────────────────────────────────────────────────────────
DO $pos$
DECLARE
  f7 text := 'public.sayerlack_importar_pedido_portal(text,date,numeric,jsonb,uuid,text,timestamptz)';
  f6 text := 'public.sayerlack_importar_pedido_portal(text,date,numeric,jsonb,uuid,text)';
  r  text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                   AND table_name = 'sayerlack_portal_evidencia' AND column_name = 'situacao_codigo') THEN
    RAISE EXCEPTION 'CA1 FALHOU: evidência sem a coluna situacao_codigo';
  END IF;
  IF to_regprocedure(f7) IS NULL OR position('[CANCELADO-ANTES-DO-PEDIDO]' IN pg_get_functiondef(f7::regprocedure)) = 0
     OR position('pg_advisory_xact_lock' IN pg_get_functiondef(f7::regprocedure)) = 0
     OR position('IP009' IN pg_get_functiondef(f7::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'CA2 FALHOU: a importação de 7 args sem o IP010, sem o lock ou sem a conferência do retrato';
  END IF;
  IF position('NULL::timestamptz' IN pg_get_functiondef(f6::regprocedure)) = 0
     OR position('pg_advisory_xact_lock' IN pg_get_functiondef(f6::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'CA3 FALHOU: a assinatura de 6 args não é o wrapper do corpo novo';
  END IF;
  FOREACH r IN ARRAY ARRAY[f6, f7] LOOP
    IF has_function_privilege('anon', r, 'EXECUTE') OR has_function_privilege('authenticated', r, 'EXECUTE')
       OR NOT has_function_privilege('service_role', r, 'EXECUTE') THEN
      RAISE EXCEPTION 'CA4 FALHOU: % aberta para anon/authenticated ou fechada para service_role', r;
    END IF;
  END LOOP;
  IF to_regprocedure('public.reposicao_claim_disparo(bigint,text)') IS NULL
     OR position('[CLAIM-LOCK-PROTOCOLO]' IN pg_get_functiondef('public.reposicao_claim_disparo(bigint,text)'::regprocedure)) = 0
     OR position('[CANCELADO-NA-EVIDENCIA]' IN pg_get_functiondef('public.reposicao_claim_disparo(bigint,text)'::regprocedure)) = 0
     OR position('portal_divergencia_aberta_id IS NULL' IN pg_get_functiondef('public.reposicao_claim_disparo(bigint,text)'::regprocedure)) = 0
     OR has_function_privilege('anon', 'public.reposicao_claim_disparo(bigint,text)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.reposicao_claim_disparo(bigint,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'CA5 FALHOU: o claim sem o veto da evidência (ou perdeu o gate da divergência), ou aberto';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_evidencia_cancelado_espera_importacao'
                   AND tgrelid = 'public.sayerlack_portal_evidencia'::regclass AND tgenabled = 'A')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                      AND table_name = 'pedido_compra_sugerido' AND column_name = 'importado_portal_lido_de') THEN
    RAISE EXCEPTION 'CA6 FALHOU: sem o trigger ALWAYS da evidência de cancelado ou sem o marco no pedido';
  END IF;
  RAISE NOTICE 'CANCELADO_ANTES_DO_PEDIDO_POS_OK';
END
$pos$;
