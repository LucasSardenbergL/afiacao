-- Portal Sayerlack, revisão 2, item 5.2 (5B), fatia 2 — "aceitar o portal" (opção (a), decisão do founder).
-- Migration MANUAL (custom não auto-aplica no Lovable): aplicar pelo envelope (`bun run db:aplicar`).
--
-- Antes: pedido do app alterado no portal ficava bloqueado para sempre (gate `portal_divergencia_aberta_id`; o claim
-- recusa e o re-disparo é negado) — a única saída era o portal "voltar". Agora um staff aceita o que o portal mostra:
--
--   1. `sayerlack_aceitar_portal(pedido, divergencia, justificativa)` — RPC do botão (authenticated, staff por
--      auth.uid()). Revalida sob FOR UPDATE (pedido e divergência), reescreve cabeçalho e itens a partir da LEITURA da
--      divergência aberta (gravada pela porta, imutável, ligada à evidência 7.2), recalcula o custo pela MESMA prova da
--      importação (`sayerlack_aplicar_custo_portal` + `sayerlack_ipi_itens`) e grava `acoes_execucoes` com o ANTES e o
--      DEPOIS. O humano só aceita o diff que VIU: a divergência aberta tem de ser a que a tela mostrou.
--   2. A porta única `sayerlack_conferir_portal` ganha o modo `aceito_portal` (mesma assinatura — sem DROP, ACL e cache
--      do PostgREST intactos): só entra nele quem a RPC autorizou pelo GUC local `app.sayerlack_aceitar_portal`; a
--      porta prova que os itens reescritos batem com a leitura, grava o retrato v+1 (origem 'aceito_portal'), fecha a
--      divergência como 'aceito_portal' e solta o gate. Retrato, divergência e gate seguem com 1 escritor.
--   3. O re-disparo é o de sempre: a tela chama a importadora com o protocolo, que RELÊ o portal, confere contra o
--      retrato novo e dispara pelo claim (portal mudou de novo no meio ⇒ divergência nova, fail-closed). O gate NÃO
--      solta no aceite (Codex código P1): fica apontando a divergência (já fechada como 'aceito_portal') até uma
--      leitura de redisparo POSTERIOR ao marco bater — senão o cron dispararia o conteúdo aceito sem ver o portal de
--      agora. Quem solta é a porta, no caminho de sempre ("bateu ⇒ gate nulo").
--
-- Codex (desenho, 3 × P1), corrigidos aqui:
--   a. "mesmo diff" sem retrato conservava a leitura VELHA (preço/total/condição superados não entram no diff sem
--      retrato) e o aceite aplicaria valores antigos ⇒ a aberta só se mantém se o CONTEÚDO da leitura (itens, valores,
--      total, condição normalizada) também for o mesmo; senão a leitura nova a substitui (novo id, nova aceitação).
--   b. leitura antiga em voo, chegando depois do aceite (sem aberta), abriria divergência contra o retrato aceito e
--      um 2º aceite restauraria o conteúdo velho ⇒ o retrato aceito guarda o marco `leitura_lido_ate` (fim da última
--      observação da leitura aceita) e a porta exige leitura de redisparo com lido_de posterior a ele.
--   c. PO lançado à mão no Omie durante o bloqueio: soltar o gate deixaria o cron criar o AFI-<id> (2º PO) ⇒ o aceite
--      recusa com PO vivo no espelho (AFI-<id> ou o protocolo como token do contrato — gramática da varredura).
--      Limite aceito (o mesmo do IP006/encerrar): o espelho tem a defasagem do sync.
--
-- Recusa de negócio volta como {aceito:false, motivo}; entrada malformada é 22023; ator sem staff é 42501; corrida é
-- 40001; leitura que não vira pedido (de-para, fração, condição, custo) desfaz tudo com o código da importação.
-- Ausente ≠ zero: nada degrada para default. A situação do portal só é LIDA (escritor único: registrar_situacao).

-- ── 0. O marco do retrato aceito (Codex b) ──────────────────────────────────────────────────────────
ALTER TABLE public.sayerlack_portal_retrato ADD COLUMN IF NOT EXISTS leitura_lido_ate timestamptz;
COMMENT ON COLUMN public.sayerlack_portal_retrato.leitura_lido_ate IS
  '5.2 fatia 2: fim da última observação da leitura ACEITA (só origem aceito_portal). Leitura de redisparo com lido_de ≤ marco é leitura_antiga. 1 escritor = sayerlack_conferir_portal.';

-- Conteúdo comparável de uma leitura (Codex a): itens por SKU (qtde e valor somados, escala aparada), total e condição
-- normalizada. Pura; só a porta a usa.
CREATE OR REPLACE FUNCTION public.sayerlack__portal_leitura_conteudo(p_leitura jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT jsonb_build_object(
    'itens', (SELECT jsonb_agg(jsonb_build_array(x.sku, x.q, x.v) ORDER BY x.sku)
                FROM (SELECT upper(btrim(e->>'sku_portal')) AS sku,
                             trim_scale(sum((e->>'qtde_portal')::numeric)) AS q,
                             trim_scale(sum((e->>'valor_mercadoria')::numeric)) AS v
                        FROM jsonb_array_elements(p_leitura->'itens') e GROUP BY 1) x),
    'total', trim_scale((p_leitura->>'valor_total')::numeric),
    'condicao', public.sayerlack_condicao_portal_normalizar(btrim(p_leitura->>'condicao')))
$$;
REVOKE ALL ON FUNCTION public.sayerlack__portal_leitura_conteudo(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sayerlack__portal_leitura_conteudo(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.sayerlack__portal_leitura_conteudo(jsonb) FROM authenticated;

-- ── 1. A porta: modo 'aceito_portal' + correções a/b ────────────────────────────────────────────────
-- Pré-flight: pg_get_functiondef da PROD em 2026-11-09 = a de 20261111150000 (md5 2dc8ed2b9a39782c4f6feb822cdaa0fb).
-- Isto a recria com: a origem nova na entrada; o marco do retrato aceito na regra de ordem (b); o ramo do modo aceito
-- depois do diff de SKU/quantidade; e o conteúdo da leitura na condição do "mesmo diff" (a). O resto é idêntico.
-- TRAVA antes de ler (ALTER sem efeito: a volatilidade viva) e PRE: md5 EXATO do corpo vivo ∈ {predecessor = prod
-- conferida em 2026-11-09 (= 20261111150000), este}. Ausente ABORTA (a fatia 1 é predecessora obrigatória).
DO $trava$
BEGIN
  IF to_regprocedure('public.sayerlack_conferir_portal(bigint,jsonb,bigint,text)') IS NOT NULL THEN
    ALTER FUNCTION public.sayerlack_conferir_portal(bigint, jsonb, bigint, text) VOLATILE;
  END IF;
END
$trava$;
DO $pre$
DECLARE
  v_vivo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                   WHERE p.oid = to_regprocedure('public.sayerlack_conferir_portal(bigint,jsonb,bigint,text)'));
BEGIN
  IF v_vivo IS NULL OR v_vivo NOT IN ('ed4d529aa8fc99f40e6af28d48ad8f1c', 'f6d244caaf4fc661507cf6bf3fad78d4') THEN
    RAISE EXCEPTION 'PRE FALHOU: sayerlack_conferir_portal viva (md5 %) não é a da fatia 1 nem esta', v_vivo;
  END IF;
END
$pre$;
CREATE OR REPLACE FUNCTION public.sayerlack_conferir_portal(
  p_pedido_id bigint, p_leitura jsonb, p_evidencia_id bigint, p_origem text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  r          public.pedido_compra_sugerido%ROWTYPE;
  v_proto    text;
  v_cond     text;
  v_norm     text;
  v_de       timestamptz;
  v_ate      timestamptz;
  v_ret      public.sayerlack_portal_retrato%ROWTYPE;
  v_criado   boolean := false;
  v_diff     jsonb;
  v_aberta   public.sayerlack_portal_divergencia%ROWTYPE;
  v_div_id   bigint;
  v_posterior boolean;
  v_marco    timestamptz;
  v_guc      text;
  v_ator     uuid;
BEGIN
  -- Entrada: a leitura inteira, ou nada. `IS DISTINCT FROM`, nunca `<>`: chave ausente dá NULL.
  IF p_pedido_id IS NULL OR p_origem IS NULL OR p_origem NOT IN ('importacao', 'redisparo', 'aceito_portal')
     OR p_leitura IS NULL OR jsonb_typeof(p_leitura) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_leitura->'protocolo') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_leitura->'condicao') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_leitura->'valor_total') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_leitura->'itens') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_leitura->'itens') = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[CONFERIR-ENTRADA] pedido, origem (importacao|redisparo|aceito_portal) e leitura completa são obrigatórios';
  END IF;
  -- CASE, não OR, antes de cada cast: o SQL não garante a ordem do OR e o cast de um não-número lançaria 22P02.
  IF NOT ((p_leitura->>'valor_total')::numeric > 0)
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_leitura->'itens') e
        WHERE jsonb_typeof(e) IS DISTINCT FROM 'object'
           OR jsonb_typeof(e->'sku_portal') IS DISTINCT FROM 'string'
           OR btrim(e->>'sku_portal') = ''
           OR CASE WHEN jsonb_typeof(e->'qtde_portal') = 'number' THEN (e->>'qtde_portal')::numeric <= 0 ELSE true END
           OR CASE WHEN jsonb_typeof(e->'valor_mercadoria') = 'number' THEN (e->>'valor_mercadoria')::numeric < 0 ELSE true END) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[CONFERIR-ENTRADA] leitura com total ou item ilegível';
  END IF;
  v_cond := btrim(p_leitura->>'condicao');
  v_norm := public.sayerlack_condicao_portal_normalizar(v_cond);
  IF v_norm IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[CONFERIR-ENTRADA] condição de pagamento ilegível na leitura';
  END IF;
  BEGIN
    v_de  := NULLIF(p_leitura->>'lido_de', '')::timestamptz;
    v_ate := NULLIF(p_leitura->>'lido_ate', '')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_time_zone_displacement_value THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[CONFERIR-ENTRADA] intervalo da leitura ilegível';
  END;
  IF (v_de IS NULL) <> (v_ate IS NULL) OR v_ate < v_de OR NOT isfinite(v_de) OR NOT isfinite(v_ate) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[CONFERIR-ENTRADA] intervalo da leitura incompleto ou invertido';
  END IF;

  SELECT * INTO r FROM public.pedido_compra_sugerido WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('conferido', false, 'motivo', 'pedido_nao_encontrado');
  END IF;
  v_proto := btrim(COALESCE(r.portal_protocolo, ''));
  IF v_proto = '' OR v_proto IS DISTINCT FROM btrim(p_leitura->>'protocolo') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[CONFERIR-ENTRADA] a leitura não é do protocolo deste pedido';
  END IF;
  IF NULLIF(NULLIF(btrim(COALESCE(r.omie_pedido_compra_id, '')), ''), '0') IS NOT NULL THEN
    RETURN jsonb_build_object('conferido', false, 'motivo', 'tem_po', 'pedido_id', r.id);
  END IF;
  IF r.status IS NULL OR r.status NOT IN ('aprovado_aguardando_disparo', 'falha_envio') THEN
    RETURN jsonb_build_object('conferido', false, 'motivo', 'status_nao_conferivel', 'pedido_id', r.id, 'status', r.status);
  END IF;

  -- 0. A divergência aberta e a ORDEM das observações, ANTES de qualquer escrita (Codex 5.2 rodada 2): só uma leitura
  --    provadamente posterior à última que viu a aberta pode semear retrato, fechar ou substituir. A importação
  --    (instante da gravação, não da captura) nunca é posterior a uma aberta. Fatia 2 (Codex b): nem ao marco do
  --    último retrato ACEITO — a leitura que o humano aceitou também ordena as que chegam depois.
  SELECT * INTO v_aberta FROM public.sayerlack_portal_divergencia
   WHERE pedido_id = r.id AND resolvida_em IS NULL FOR UPDATE;
  SELECT t.leitura_lido_ate INTO v_marco FROM public.sayerlack_portal_retrato t
   WHERE t.pedido_id = r.id ORDER BY t.versao DESC LIMIT 1;
  v_posterior := (v_aberta.id IS NULL
                  OR (p_origem = 'redisparo' AND v_de IS NOT NULL AND v_de > GREATEST(v_aberta.lido_ate, v_aberta.ultima_lido_ate)))
             AND (v_marco IS NULL OR (p_origem = 'redisparo' AND v_de IS NOT NULL AND v_de > v_marco));

  -- 0b. Modo 'aceito_portal' (fatia 2): só pela RPC `sayerlack_aceitar_portal`, que autoriza ESTA chamada pelo GUC
  --     local '<pedido>:<divergência>:<ator>' — e só sobre a leitura da PRÓPRIA divergência aberta (a ordem das
  --     observações não se aplica: não é uma leitura nova, é a que o humano aceitou).
  IF p_origem = 'aceito_portal' THEN
    v_guc := NULLIF(current_setting('app.sayerlack_aceitar_portal', true), '');
    IF v_guc IS NULL OR v_aberta.id IS NULL
       OR v_guc !~ '^[0-9]+:[0-9]+:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR split_part(v_guc, ':', 1) IS DISTINCT FROM r.id::text
       OR split_part(v_guc, ':', 2) IS DISTINCT FROM v_aberta.id::text
       OR r.portal_divergencia_aberta_id IS DISTINCT FROM v_aberta.id THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '[CONFERIR-ACEITO] o modo aceito_portal é só da RPC sayerlack_aceitar_portal, sobre a divergência aberta do pedido';
    END IF;
    v_ator := split_part(v_guc, ':', 3)::uuid;
    IF p_leitura IS DISTINCT FROM v_aberta.leitura OR p_evidencia_id IS DISTINCT FROM v_aberta.evidencia_id THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[CONFERIR-ACEITO] a leitura aceita tem de ser a da divergência aberta';
    END IF;
  END IF;

  -- 1. SKU e quantidade contra os itens do PRÓPRIO pedido (não dependem do retrato).
  WITH app_item AS (
    SELECT i.id, upper(btrim(i.sku_portal_aprovado)) AS sku, i.qtde_final * i.fator_portal_aprovado AS q,
           (NULLIF(btrim(COALESCE(i.sku_portal_aprovado, '')), '') IS NULL
            OR i.fator_portal_aprovado IS NULL OR i.fator_portal_aprovado <= 0
            OR i.qtde_final IS NULL OR i.qtde_final <= 0) AS ausente
      FROM public.pedido_compra_item i WHERE i.pedido_id = r.id
  ), app AS (
    SELECT sku, trim_scale(sum(q)) AS q FROM app_item WHERE NOT ausente GROUP BY 1
  ), portal AS (
    SELECT upper(btrim(e->>'sku_portal')) AS sku, trim_scale(sum((e->>'qtde_portal')::numeric)) AS q
      FROM jsonb_array_elements(p_leitura->'itens') e GROUP BY 1
  ), d AS (
    -- Ausente ≠ zero: pedido sem item, ou item sem SKU do portal/fator/quantidade, é diferença.
    SELECT 'pedido_sem_itens' AS tipo, NULL::text AS sku, NULL::numeric AS app, NULL::numeric AS portal
     WHERE NOT EXISTS (SELECT 1 FROM app_item)
    UNION ALL
    SELECT 'item_sem_mapa_portal', 'item ' || a.id, NULL, NULL FROM app_item a WHERE a.ausente
    UNION ALL
    SELECT CASE WHEN a.sku IS NULL THEN 'sku_novo_no_portal' WHEN p.sku IS NULL THEN 'sku_fora_do_portal'
                ELSE 'quantidade' END,
           COALESCE(a.sku, p.sku), a.q, p.q
      FROM app a FULL JOIN portal p ON p.sku = a.sku
     WHERE a.sku IS NULL OR p.sku IS NULL OR a.q <> p.q
  )
  SELECT jsonb_agg(jsonb_build_object('tipo', d.tipo, 'sku', d.sku, 'app', d.app, 'portal', d.portal))
    INTO v_diff FROM d;

  -- 1b. Aceito: os itens que a RPC acabou de reescrever TÊM de bater com a leitura em SKU e quantidade — senão nada
  --     se grava (a RPC desfaz tudo). Depois: retrato v+1 desta leitura com o marco da última observação dela e a
  --     divergência fecha como 'aceito_portal'. O gate FICA (Codex código P1): o claim segue recusando até a releitura
  --     posterior ao marco bater com este retrato — aí o passo "bateu" abaixo o solta.
  IF p_origem = 'aceito_portal' THEN
    IF v_diff IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'AP009',
        MESSAGE = '[CONFERIR-ACEITO] os itens reescritos não batem com a leitura aceita: ' || left(v_diff::text, 300);
    END IF;
    INSERT INTO public.sayerlack_portal_retrato (pedido_id, versao, protocolo, origem, evidencia_id, itens,
                                                 valor_total, condicao_portal, condicao_normalizada, leitura_lido_ate)
    SELECT r.id,
           COALESCE((SELECT max(t.versao) FROM public.sayerlack_portal_retrato t WHERE t.pedido_id = r.id), 0) + 1,
           v_proto, 'aceito_portal', v_aberta.evidencia_id,
           (SELECT jsonb_agg(jsonb_build_object('sku_portal', upper(btrim(x.e->>'sku_portal')),
                                                'qtde_portal', (x.e->>'qtde_portal')::numeric,
                                                'valor_mercadoria', (x.e->>'valor_mercadoria')::numeric) ORDER BY x.o)
              FROM jsonb_array_elements(p_leitura->'itens') WITH ORDINALITY AS x(e, o)),
           (p_leitura->>'valor_total')::numeric, v_cond, v_norm,
           GREATEST(v_aberta.lido_ate, v_aberta.ultima_lido_ate)
    RETURNING * INTO v_ret;
    UPDATE public.sayerlack_portal_divergencia
       SET resolvida_em = now(), resolucao = 'aceito_portal', resolvida_por = v_ator
     WHERE id = v_aberta.id AND resolvida_em IS NULL;
    RETURN jsonb_build_object('conferido', true, 'divergente', false, 'aceito', true, 'pedido_id', r.id,
                              'retrato_criado', true, 'retrato_versao', v_ret.versao,
                              'divergencia_fechada_id', v_aberta.id, 'aguardando_releitura', true);
  END IF;

  -- 2. Retrato vigente (a maior versão). Sem retrato, ESTA leitura vira o retrato — SÓ se SKU e quantidade bateram
  --    (Codex 5.2 P1): uma 1ª leitura já divergente não pode virar a referência de valor e condição; quando o portal
  --    voltar ao pedido, a leitura que bater semeia.
  SELECT * INTO v_ret FROM public.sayerlack_portal_retrato WHERE pedido_id = r.id ORDER BY versao DESC LIMIT 1;
  IF NOT FOUND AND v_diff IS NULL AND v_posterior THEN
    INSERT INTO public.sayerlack_portal_retrato (pedido_id, versao, protocolo, origem, evidencia_id, itens,
                                                 valor_total, condicao_portal, condicao_normalizada)
    SELECT r.id, 1, v_proto, p_origem, p_evidencia_id,
           (SELECT jsonb_agg(jsonb_build_object('sku_portal', upper(btrim(x.e->>'sku_portal')),
                                                'qtde_portal', (x.e->>'qtde_portal')::numeric,
                                                'valor_mercadoria', (x.e->>'valor_mercadoria')::numeric) ORDER BY x.o)
              FROM jsonb_array_elements(p_leitura->'itens') WITH ORDINALITY AS x(e, o)),
           (p_leitura->>'valor_total')::numeric, v_cond, v_norm
    RETURNING * INTO v_ret;
    v_criado := true;
  END IF;

  -- 3. Valor por SKU, total e condição contra o retrato (sem retrato não há referência: só SKU/quantidade valem).
  IF v_ret.pedido_id IS NOT NULL THEN
    WITH portal AS (
      SELECT upper(btrim(e->>'sku_portal')) AS sku, sum((e->>'valor_mercadoria')::numeric) AS v
        FROM jsonb_array_elements(p_leitura->'itens') e GROUP BY 1
    ), ret AS (
      SELECT e->>'sku_portal' AS sku, sum((e->>'valor_mercadoria')::numeric) AS v
        FROM jsonb_array_elements(v_ret.itens) e GROUP BY 1
    ), d AS (
      -- Valor por SKU contra o retrato (FULL JOIN: SKU que entrou/saiu desde o retrato também conta).
      SELECT 'valor_item' AS tipo, COALESCE(p.sku, t.sku) AS sku, t.v AS app, p.v AS portal
        FROM portal p FULL JOIN ret t ON t.sku = p.sku
       WHERE p.sku IS NULL OR t.sku IS NULL OR abs(p.v - t.v) > 0.005
      UNION ALL
      SELECT 'valor_total', NULL, v_ret.valor_total, (p_leitura->>'valor_total')::numeric
       WHERE abs(v_ret.valor_total - (p_leitura->>'valor_total')::numeric) > 0.005
    )
    SELECT COALESCE(v_diff, '[]'::jsonb)
           || COALESCE(jsonb_agg(jsonb_build_object('tipo', d.tipo, 'sku', d.sku, 'app', d.app, 'portal', d.portal)), '[]'::jsonb)
      INTO v_diff FROM d;
    IF v_ret.condicao_normalizada IS DISTINCT FROM v_norm THEN
      v_diff := v_diff || jsonb_build_array(jsonb_build_object(
        'tipo', 'condicao', 'sku', NULL, 'app', v_ret.condicao_portal, 'portal', v_cond));
    END IF;
  END IF;
  -- Ordem estável (o "mesmo diff" compara jsonb); vazio = NULL.
  SELECT jsonb_agg(e ORDER BY e->>'tipo', e->>'sku') INTO v_diff FROM jsonb_array_elements(COALESCE(v_diff, '[]'::jsonb)) e;
  IF v_diff IS NOT NULL AND v_de IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[CONFERIR-ENTRADA] divergência exige o intervalo da leitura (lido_de/lido_ate)';
  END IF;

  -- O mesmo diff E o mesmo conteúdo (Codex fatia 2, a): a aberta segue valendo (não empilha linha a cada importação,
  -- e a ordem não importa). Sem retrato, valor/total/condição não entram no diff — o conteúdo é que prova que a
  -- leitura guardada (a que o aceite aplica) ainda é a do portal.
  IF v_diff IS NOT NULL AND v_aberta.id IS NOT NULL AND v_aberta.diferencas = v_diff
     AND v_aberta.retrato_versao IS NOT DISTINCT FROM v_ret.versao
     AND public.sayerlack__portal_leitura_conteudo(v_aberta.leitura) = public.sayerlack__portal_leitura_conteudo(p_leitura) THEN
    -- Carimba a ÚLTIMA observação do mesmo diff (Codex 5.2 P1): uma leitura mais velha que ESTA não pode fechá-la.
    UPDATE public.sayerlack_portal_divergencia
       SET ultima_lido_ate = v_ate, ultima_evidencia_id = p_evidencia_id
     WHERE id = v_aberta.id AND v_ate > GREATEST(v_aberta.lido_ate, v_aberta.ultima_lido_ate);
    RETURN jsonb_build_object('conferido', true, 'divergente', true, 'pedido_id', r.id, 'divergencia_id', v_aberta.id,
                              'retrato_criado', v_criado, 'retrato_versao', v_ret.versao, 'diferencas', v_diff,
                              'pendente_desde', r.disparo_claim_em);
  END IF;
  -- Fechar ou substituir a aberta exige leitura provadamente POSTERIOR à dela (e ao marco do retrato aceito).
  IF NOT v_posterior THEN
    RETURN jsonb_build_object('conferido', false, 'motivo', 'leitura_antiga', 'pedido_id', r.id,
                              'divergencia_id', v_aberta.id,
                              'divergencia_lido_ate', GREATEST(v_aberta.lido_ate, v_aberta.ultima_lido_ate),
                              'aceito_lido_ate', v_marco);
  END IF;

  IF v_diff IS NULL THEN
    IF v_aberta.id IS NOT NULL THEN
      UPDATE public.sayerlack_portal_divergencia SET resolvida_em = now(), resolucao = 'portal_voltou'
       WHERE id = v_aberta.id;
    END IF;
    UPDATE public.pedido_compra_sugerido SET portal_divergencia_aberta_id = NULL
     WHERE id = r.id AND portal_divergencia_aberta_id IS NOT NULL;
    RETURN jsonb_build_object('conferido', true, 'divergente', false, 'pedido_id', r.id,
                              'retrato_criado', v_criado, 'retrato_versao', v_ret.versao,
                              'divergencia_fechada_id', v_aberta.id, 'pendente_desde', r.disparo_claim_em);
  END IF;

  IF v_aberta.id IS NOT NULL THEN
    UPDATE public.sayerlack_portal_divergencia SET resolvida_em = now(), resolucao = 'substituida'
     WHERE id = v_aberta.id;
  END IF;
  INSERT INTO public.sayerlack_portal_divergencia (pedido_id, protocolo, evidencia_id, retrato_versao, leitura,
                                                   lido_de, lido_ate, diferencas)
  VALUES (r.id, v_proto, p_evidencia_id, v_ret.versao, p_leitura, v_de, v_ate, v_diff)
  RETURNING id INTO v_div_id;
  UPDATE public.pedido_compra_sugerido SET portal_divergencia_aberta_id = v_div_id WHERE id = r.id;

  RETURN jsonb_build_object('conferido', true, 'divergente', true, 'pedido_id', r.id, 'divergencia_id', v_div_id,
                            'retrato_criado', v_criado, 'retrato_versao', v_ret.versao, 'diferencas', v_diff,
                            'pendente_desde', r.disparo_claim_em);
END;
$$;
REVOKE ALL ON FUNCTION public.sayerlack_conferir_portal(bigint, jsonb, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sayerlack_conferir_portal(bigint, jsonb, bigint, text) FROM anon;
REVOKE ALL ON FUNCTION public.sayerlack_conferir_portal(bigint, jsonb, bigint, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sayerlack_conferir_portal(bigint, jsonb, bigint, text) TO service_role;

-- ── 2. A RPC do botão ───────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sayerlack_aceitar_portal(
  p_pedido_id bigint, p_divergencia_id bigint, p_justificativa text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_ator        uuid := auth.uid();
  v_just        text := btrim(COALESCE(p_justificativa, ''));
  r             public.pedido_compra_sugerido%ROWTYPE;
  d             public.sayerlack_portal_divergencia%ROWTYPE;
  v_leitura     jsonb;
  v_total       numeric;
  v_n           integer;
  v_po_espelho  text;
  v_sem_depara  text;
  v_fracionados text;
  v_fornecedor  text;
  v_n_fornec    integer;
  v_cond_codigo text;
  v_cond_desc   text;
  v_cond_parc   integer;
  v_antes       jsonb;
  v_depois      jsonb;
  v_payload     jsonb;
  v_atualizados integer;
  v_conf        jsonb;
  v_exec        uuid;
BEGIN
  -- Gate na fronteira: staff pelo JWT (identidade REAL; a lente "Ver como" não muda auth.uid()).
  IF v_ator IS NULL OR NOT (public.has_role(v_ator, 'employee'::app_role) OR public.has_role(v_ator, 'master'::app_role)) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '[ACEITAR-STAFF] só staff aceita o pedido do portal';
  END IF;
  IF p_pedido_id IS NULL OR p_divergencia_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[ACEITAR-ENTRADA] pedido e divergência são obrigatórios';
  END IF;
  IF length(v_just) < 10 OR length(v_just) > 1000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[ACEITAR-JUSTIFICATIVA] justificativa de 10 a 1000 caracteres';
  END IF;

  -- 1. Pedido sob a trava e as recusas de negócio.
  SELECT * INTO r FROM public.pedido_compra_sugerido WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('aceito', false, 'motivo', 'pedido_nao_encontrado');
  END IF;
  IF r.empresa IS DISTINCT FROM 'OBEN' OR btrim(COALESCE(r.portal_protocolo, '')) = '' THEN
    RETURN jsonb_build_object('aceito', false, 'motivo', 'sem_protocolo_do_portal');
  END IF;
  IF NULLIF(NULLIF(btrim(COALESCE(r.omie_pedido_compra_id, '')), ''), '0') IS NOT NULL
     OR r.omie_pedido_compra_numero IS NOT NULL THEN
    RETURN jsonb_build_object('aceito', false, 'motivo', 'tem_po');
  END IF;
  IF r.status IS NULL OR r.status NOT IN ('aprovado_aguardando_disparo', 'falha_envio') THEN
    RETURN jsonb_build_object('aceito', false, 'motivo', 'status_nao_aceitavel', 'status', r.status);
  END IF;
  IF r.status_envio_portal IS DISTINCT FROM 'sucesso_portal' THEN
    RETURN jsonb_build_object('aceito', false, 'motivo', 'portal_nao_confirmado', 'status_envio_portal', r.status_envio_portal);
  END IF;
  -- Claim aberto, de QUALQUER idade: uma tentativa pode ter criado o AFI-<id> no Omie com a resposta perdida — e com
  -- o pedido ANTIGO. Quem resolve é a conciliação por consulta do disparador; reescrever aqui arriscaria o 2º PO.
  IF r.disparo_claim_em IS NOT NULL THEN
    RETURN jsonb_build_object('aceito', false, 'motivo', 'disparo_pendente', 'pendente_desde', r.disparo_claim_em);
  END IF;
  -- Situação do portal: só Aberto (1) ou Suspenso (5), lida DESTE protocolo. Ausente ≠ aberto.
  IF r.portal_situacao_codigo IS NULL OR r.portal_situacao_codigo NOT IN ('1', '5')
     OR r.portal_situacao_protocolo IS DISTINCT FROM r.portal_protocolo THEN
    RETURN jsonb_build_object('aceito', false, 'motivo', 'situacao_nao_aceitavel', 'situacao', r.portal_situacao_codigo);
  END IF;
  IF r.portal_divergencia_aberta_id IS NULL THEN
    RETURN jsonb_build_object('aceito', false, 'motivo', 'sem_divergencia');
  END IF;
  -- O humano só aceita o diff que VIU: substituída por uma leitura mais nova, a tela tem de recarregar.
  IF r.portal_divergencia_aberta_id IS DISTINCT FROM p_divergencia_id THEN
    RETURN jsonb_build_object('aceito', false, 'motivo', 'divergencia_mudou',
                              'divergencia_aberta_id', r.portal_divergencia_aberta_id);
  END IF;
  -- PO vivo no espelho do Omie (Codex c): o AFI-<id> do app ou o protocolo como token do contrato (split '/' + btrim,
  -- a gramática da varredura). Soltar o gate com ele deixaria o cron criar o 2º PO. Quem resolve: a vinculação (7.1)
  -- ou a conciliação. Limite: a defasagem do sync do espelho (a mesma do IP006 e do encerrar).
  SELECT string_agg(COALESCE(t.numero_pedido, '?'), ', ') INTO v_po_espelho
    FROM public.purchase_orders_tracking t
   WHERE t.empresa::text = 'OBEN'
     AND t.status::text IS DISTINCT FROM 'CANCELADO'
     AND (btrim(COALESCE(t.omie_codigo_integracao, '')) = 'AFI-' || r.id
          OR EXISTS (SELECT 1 FROM unnest(string_to_array(t.numero_contrato_fornecedor, '/')) AS c(n)
                      WHERE btrim(c.n) = btrim(r.portal_protocolo)));
  IF v_po_espelho IS NOT NULL THEN
    RETURN jsonb_build_object('aceito', false, 'motivo', 'po_no_espelho', 'po_numero', v_po_espelho);
  END IF;

  -- 2. A divergência sob a trava: aberta, deste pedido, a do gate. Fora disso o gate e a tabela discordam.
  SELECT * INTO d FROM public.sayerlack_portal_divergencia WHERE id = p_divergencia_id FOR UPDATE;
  -- Já aceita, gate mantido até a releitura (Codex código P1): não há o que aceitar de novo — falta reler o portal.
  IF FOUND AND d.pedido_id = r.id AND d.resolucao = 'aceito_portal' THEN
    RETURN jsonb_build_object('aceito', false, 'motivo', 'aguardando_releitura', 'divergencia_id', d.id);
  END IF;
  IF NOT FOUND OR d.pedido_id IS DISTINCT FROM r.id OR d.resolvida_em IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = '[ACEITAR-CORRIDA] a divergência mudou durante o aceite';
  END IF;
  v_leitura := d.leitura;

  -- 3. A leitura vira itens pelo MESMO caminho da importação (sayerlack_importar_pedido_portal), com os mesmos códigos.
  IF jsonb_typeof(v_leitura->'itens') IS DISTINCT FROM 'array' OR jsonb_array_length(v_leitura->'itens') = 0
     OR jsonb_typeof(v_leitura->'valor_total') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_leitura->'condicao') IS DISTINCT FROM 'string'
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_leitura->'itens') e
        WHERE jsonb_typeof(e) IS DISTINCT FROM 'object'
           OR jsonb_typeof(e->'sku_portal') IS DISTINCT FROM 'string'
           OR btrim(e->>'sku_portal') = ''
           OR CASE WHEN jsonb_typeof(e->'qtde_portal') = 'number' THEN (e->>'qtde_portal')::numeric <= 0 ELSE true END
           OR CASE WHEN jsonb_typeof(e->'valor_mercadoria') = 'number' THEN (e->>'valor_mercadoria')::numeric <= 0 ELSE true END) THEN
    RAISE EXCEPTION 'aceitar_portal: a leitura da divergência % não tem itens com qtde e valor > 0', d.id USING ERRCODE = 'IP001';
  END IF;
  v_total := (v_leitura->>'valor_total')::numeric;
  IF NOT (v_total > 0) THEN
    RAISE EXCEPTION 'aceitar_portal: valor_total da leitura ≤ 0' USING ERRCODE = 'IP001';
  END IF;
  v_n := jsonb_array_length(v_leitura->'itens');
  IF (SELECT count(DISTINCT upper(btrim(e->>'sku_portal'))) FROM jsonb_array_elements(v_leitura->'itens') e) <> v_n THEN
    RAISE EXCEPTION 'aceitar_portal: SKU repetido na leitura do portal' USING ERRCODE = 'IP005';
  END IF;
  -- IP007 — condição pela MESMA função (de-para do founder primeiro; B13 sem "(C)", "30 DIAS" → T54 moram lá).
  SELECT c.codigo, c.descricao, c.num_parcelas INTO v_cond_codigo, v_cond_desc, v_cond_parc
    FROM public.sayerlack_condicao_portal_para_omie(v_leitura->>'condicao') c;

  CREATE TEMP TABLE IF NOT EXISTS _aceitar_portal_itens (
    ordem int, sku_portal text, qtde_portal numeric, valor_mercadoria numeric,
    n_map int, sku_omie text, fornecedor_nome text, fator numeric, qtde_omie numeric, descricao text
  ) ON COMMIT DROP;
  TRUNCATE _aceitar_portal_itens;
  INSERT INTO _aceitar_portal_itens (ordem, sku_portal, qtde_portal, valor_mercadoria, n_map, sku_omie, fornecedor_nome, fator)
  SELECT e.ord::int,
         upper(btrim(e.val->>'sku_portal')),
         (e.val->>'qtde_portal')::numeric,
         (e.val->>'valor_mercadoria')::numeric,
         (SELECT count(*) FROM public.sku_fornecedor_externo x
           WHERE x.empresa = 'OBEN' AND x.ativo AND upper(btrim(x.sku_portal)) = upper(btrim(e.val->>'sku_portal'))),
         (SELECT min(x.sku_omie) FROM public.sku_fornecedor_externo x
           WHERE x.empresa = 'OBEN' AND x.ativo AND upper(btrim(x.sku_portal)) = upper(btrim(e.val->>'sku_portal'))),
         (SELECT min(x.fornecedor_nome) FROM public.sku_fornecedor_externo x
           WHERE x.empresa = 'OBEN' AND x.ativo AND upper(btrim(x.sku_portal)) = upper(btrim(e.val->>'sku_portal'))),
         (SELECT min(x.fator_conversao) FROM public.sku_fornecedor_externo x
           WHERE x.empresa = 'OBEN' AND x.ativo AND upper(btrim(x.sku_portal)) = upper(btrim(e.val->>'sku_portal')))
    FROM jsonb_array_elements(v_leitura->'itens') WITH ORDINALITY AS e(val, ord);

  SELECT string_agg(sku_portal || CASE WHEN n_map > 1 THEN ' (ambíguo: ' || n_map || ' SKUs Omie)' ELSE '' END, ', ' ORDER BY ordem)
    INTO v_sem_depara FROM _aceitar_portal_itens WHERE n_map <> 1;
  IF v_sem_depara IS NOT NULL THEN
    RAISE EXCEPTION 'aceitar_portal: sem de-para ativo no app para: %', v_sem_depara USING ERRCODE = 'IP002';
  END IF;
  SELECT count(DISTINCT fornecedor_nome), min(fornecedor_nome) INTO v_n_fornec, v_fornecedor FROM _aceitar_portal_itens;
  IF v_n_fornec <> 1 OR v_fornecedor IS NULL OR v_fornecedor !~* 'sayerlack' THEN
    RAISE EXCEPTION 'aceitar_portal: de-para aponta fornecedor(es) inesperado(s): %',
      (SELECT string_agg(DISTINCT coalesce(fornecedor_nome, 'null'), ', ') FROM _aceitar_portal_itens) USING ERRCODE = 'IP004';
  END IF;
  -- IP003 — fator = unidades do PORTAL por unidade do Omie ⇒ qtde_omie = qtde_portal ÷ fator, INTEIRA.
  UPDATE _aceitar_portal_itens SET qtde_omie = CASE WHEN fator > 0 THEN qtde_portal / fator END WHERE qtde_omie IS NULL;
  SELECT string_agg(sku_portal || ' (' || trim_scale(qtde_portal) || ' ÷ fator ' || coalesce(trim_scale(fator)::text, 'null') || ')', ', ' ORDER BY ordem)
    INTO v_fracionados FROM _aceitar_portal_itens
   WHERE qtde_omie IS NULL OR NOT (qtde_omie > 0) OR qtde_omie <> trunc(qtde_omie);
  IF v_fracionados IS NOT NULL THEN
    RAISE EXCEPTION 'aceitar_portal: quantidade não vira inteira no Omie: %', v_fracionados USING ERRCODE = 'IP003';
  END IF;
  UPDATE _aceitar_portal_itens t
     SET descricao = (SELECT p.descricao FROM public.omie_products p
                       WHERE p.account = 'oben' AND p.omie_codigo_produto::text = t.sku_omie LIMIT 1)
   WHERE t.descricao IS NULL;

  -- 4. ANTES (cabeçalho + itens inteiros), para a trilha.
  v_antes := jsonb_build_object(
    'cabecalho', jsonb_build_object(
      'valor_total', r.valor_total, 'num_skus', r.num_skus,
      'condicao_pagamento_codigo', r.condicao_pagamento_codigo, 'condicao_pagamento_descricao', r.condicao_pagamento_descricao,
      'num_parcelas', r.num_parcelas, 'condicao_origem', r.condicao_origem, 'condicao_portal_lida', r.condicao_portal_lida,
      'valor_total_portal_provado', r.valor_total_portal_provado),
    'itens', (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb)
                FROM public.pedido_compra_item i WHERE i.pedido_id = r.id));

  -- 5. Itens: sai o pedido antigo, entra o do portal. Do item antigo do MESMO SKU Omie herda só o retrato de estoque
  --    do motor (o porquê da compra); preço, promoção e IPI são do portal e da prova de custo — o que era do preço
  --    antigo (desconto, economia) fica nulo, nunca herdado como se valesse para o preço novo.
  CREATE TEMP TABLE IF NOT EXISTS _aceitar_portal_antigos ON COMMIT DROP AS
    SELECT * FROM public.pedido_compra_item WITH NO DATA;
  TRUNCATE _aceitar_portal_antigos;
  INSERT INTO _aceitar_portal_antigos SELECT * FROM public.pedido_compra_item WHERE pedido_id = r.id;
  DELETE FROM public.pedido_compra_item WHERE pedido_id = r.id;
  INSERT INTO public.pedido_compra_item (
    pedido_id, sku_codigo_omie, sku_descricao, qtde_sugerida, qtde_final, preco_unitario, valor_linha,
    sku_portal_aprovado, fator_portal_aprovado,
    estoque_atual, ponto_pedido, estoque_maximo, primeira_compra, estoque_fisico, estoque_a_caminho,
    estoque_comprometido, qtde_sem_teto, teto_cobertura_aplicado, fator_embalagem_portal
  )
  SELECT r.id, t.sku_omie, coalesce(t.descricao, a.sku_descricao, t.sku_portal), coalesce(a.qtde_sugerida, t.qtde_omie),
         t.qtde_omie, t.valor_mercadoria / t.qtde_omie, t.valor_mercadoria, t.sku_portal, t.fator,
         a.estoque_atual, a.ponto_pedido, a.estoque_maximo, a.primeira_compra, a.estoque_fisico, a.estoque_a_caminho,
         a.estoque_comprometido, a.qtde_sem_teto, coalesce(a.teto_cobertura_aplicado, false), a.fator_embalagem_portal
    FROM _aceitar_portal_itens t
    LEFT JOIN LATERAL (SELECT * FROM _aceitar_portal_antigos o WHERE btrim(o.sku_codigo_omie) = t.sku_omie
                        ORDER BY o.id LIMIT 1) a ON true
   ORDER BY t.ordem;

  -- 6. Cabeçalho (o valor_total é provisório: a prova de custo regrava com o IPI). O WHERE repete as guardas: sob o
  --    FOR UPDATE é impossível falhar; se falhar, nada fica meio feito.
  UPDATE public.pedido_compra_sugerido
     SET valor_total = (SELECT sum(valor_mercadoria) FROM _aceitar_portal_itens),
         num_skus = v_n,
         condicao_pagamento_codigo = v_cond_codigo,
         condicao_pagamento_descricao = v_cond_desc,
         num_parcelas = v_cond_parc,
         condicao_origem = 'portal_sayerlack',
         condicao_portal_lida = btrim(v_leitura->>'condicao'),
         atualizado_em = now()
   WHERE id = r.id
     AND status = r.status
     AND disparo_claim_em IS NULL
     AND portal_divergencia_aberta_id = d.id
     AND NULLIF(NULLIF(btrim(COALESCE(omie_pedido_compra_id, '')), ''), '0') IS NULL;
  GET DIAGNOSTICS v_atualizados = ROW_COUNT;
  IF v_atualizados <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = '[ACEITAR-CORRIDA] o pedido mudou durante o aceite';
  END IF;

  -- 7. O custo pela MESMA prova da importação: IPI do payload = a conta da RPC de custo sobre a alíquota de
  --    `sayerlack_ipi_itens`; a prova EXTERNA é o total cobrado pelo portal na leitura aceita. Alíquota ausente vira 0
  --    só no payload — a RPC de custo recusa antes (CP006) e nada é gravado.
  SELECT jsonb_agg(jsonb_build_object(
           'item_id', i.id, 'qtde_final', i.qtde_final, 'valor_mercadoria', i.valor_linha,
           'valor_ipi', round(round(i.valor_linha, 2) * coalesce(x.aliquota_pct, 0) / 100, 2)) ORDER BY i.id)
    INTO v_payload
    FROM public.pedido_compra_item i
    LEFT JOIN public.sayerlack_ipi_itens(r.id) x ON x.item_id = i.id
   WHERE i.pedido_id = r.id;
  v_atualizados := public.sayerlack_aplicar_custo_portal(r.id, v_payload, v_total);
  IF v_atualizados IS DISTINCT FROM v_n THEN
    RAISE EXCEPTION 'aceitar_portal: custo aplicado em % de % itens — nada gravado', v_atualizados, v_n USING ERRCODE = 'IP001';
  END IF;

  -- 8. A porta única: prova que os itens batem com a leitura, grava o retrato v+1, fecha a divergência, solta o gate.
  PERFORM set_config('app.sayerlack_aceitar_portal', r.id || ':' || d.id || ':' || v_ator, true);
  v_conf := public.sayerlack_conferir_portal(r.id, v_leitura, d.evidencia_id, 'aceito_portal');
  PERFORM set_config('app.sayerlack_aceitar_portal', '', true);
  IF v_conf->>'aceito' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'aceitar_portal: a porta não aceitou (%)', left(v_conf::text, 300) USING ERRCODE = 'AP009';
  END IF;

  -- 9. DEPOIS + trilha, na MESMA transação.
  SELECT jsonb_build_object(
           'cabecalho', jsonb_build_object(
             'valor_total', p.valor_total, 'num_skus', p.num_skus,
             'condicao_pagamento_codigo', p.condicao_pagamento_codigo, 'condicao_pagamento_descricao', p.condicao_pagamento_descricao,
             'num_parcelas', p.num_parcelas, 'condicao_origem', p.condicao_origem, 'condicao_portal_lida', p.condicao_portal_lida,
             'valor_total_portal_provado', p.valor_total_portal_provado),
           'itens', (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb)
                       FROM public.pedido_compra_item i WHERE i.pedido_id = r.id))
    INTO v_depois FROM public.pedido_compra_sugerido p WHERE p.id = r.id;

  INSERT INTO public.acoes_execucoes (acao, origem, executado_por, iniciado_em, finalizado_em, status, detalhes)
  VALUES ('sayerlack_aceitar_portal', 'manual', v_ator, now(), now(), 'sucesso',
          jsonb_build_object(
            'pedido_id', r.id, 'protocolo', r.portal_protocolo, 'divergencia_id', d.id, 'evidencia_id', d.evidencia_id,
            'justificativa', v_just, 'diferencas', d.diferencas, 'leitura_lido_de', d.lido_de,
            'leitura_lido_ate', GREATEST(d.lido_ate, d.ultima_lido_ate), 'retrato_versao_antes', d.retrato_versao,
            'retrato_versao', (v_conf->>'retrato_versao')::int, 'situacao_portal', r.portal_situacao_codigo,
            'antes', v_antes, 'depois', v_depois))
  RETURNING id INTO v_exec;

  RETURN jsonb_build_object('aceito', true, 'motivo', 'aceito', 'pedido_id', r.id, 'protocolo', r.portal_protocolo,
                            'divergencia_id', d.id, 'retrato_versao', (v_conf->>'retrato_versao')::int,
                            'valor_total', (v_depois->'cabecalho'->>'valor_total')::numeric, 'execucao_id', v_exec);
END;
$$;
REVOKE ALL ON FUNCTION public.sayerlack_aceitar_portal(bigint, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sayerlack_aceitar_portal(bigint, bigint, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.sayerlack_aceitar_portal(bigint, bigint, text) TO authenticated, service_role;

-- ── POS ───────────────────────────────────────────────────────────────────────────────────────────
DO $pos$
DECLARE
  f text := 'public.sayerlack_conferir_portal(bigint,jsonb,bigint,text)';
  a text := 'public.sayerlack_aceitar_portal(bigint,bigint,text)';
  h text := 'public.sayerlack__portal_leitura_conteudo(jsonb)';
BEGIN
  IF to_regprocedure(a) IS NULL OR to_regprocedure(h) IS NULL THEN RAISE EXCEPTION 'AC1 FALHOU: RPC ou helper ausente'; END IF;
  IF has_function_privilege('anon', a, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE')
     OR has_function_privilege('authenticated', f, 'EXECUTE')
     OR has_function_privilege('anon', h, 'EXECUTE') OR has_function_privilege('authenticated', h, 'EXECUTE') THEN
    RAISE EXCEPTION 'AC2 FALHOU: RPC aberta para anon, ou porta/helper abertos para authenticated';
  END IF;
  IF NOT has_function_privilege('authenticated', a, 'EXECUTE') OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'AC3 FALHOU: authenticated sem a RPC ou service_role sem a porta';
  END IF;
  IF position('[ACEITAR-STAFF]' IN pg_get_functiondef(a::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'AC4 FALHOU: a RPC não tem o gate de staff';
  END IF;
  IF position('app.sayerlack_aceitar_portal' IN pg_get_functiondef(f::regprocedure)) = 0
     OR position('v_marco' IN pg_get_functiondef(f::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'AC5 FALHOU: a porta sem o modo aceito_portal ou sem o marco do retrato aceito';
  END IF;
  IF to_regclass('public.sayerlack_portal_retrato') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                      AND table_name = 'sayerlack_portal_retrato' AND column_name = 'leitura_lido_ate') THEN
    RAISE EXCEPTION 'AC6 FALHOU: retrato sem o marco leitura_lido_ate';
  END IF;
  RAISE NOTICE 'ACEITAR_PORTAL_POS_OK';
END
$pos$;
