-- ============================================================
-- ATP/reserva de estoque — FASE 3: a reserva do pedido para de morrer por TTL
-- [money-path] · Programa Cabreúva Pista B (docs/historico/programa-cabreuva-colacor.md)
-- Depende das fases 1 (20260806101417), 1.1 (20260806225052) e 2 (20260807015000),
-- todas APLICADAS em produção (conferido via psql-ro em 2026-08-08).
--
-- PROBLEMA: reserva que já virou pedido morre por TTL (30min) antes de o Omie
-- baixar o estoque — o Omie só baixa no FATURAMENTO. Medido em prod (oben, 60d):
-- p50 12,4h entre criação e último update; p90 324h; máx 971h. O único pedido do
-- app que fechou o ciclo levou 818h (34 dias). A unidade volta a parecer livre e
-- pode ser vendida de novo. Já vivo: a 1ª reserva real (08/08 00:03) expirava 00:33.
--
-- O TTL é a defesa ERRADA para esta janela (parecer Codex 2026-08-06): subir o TTL
-- não alcança 34 dias e causa undersell. O conserto é a reserva de um PV FIRME não
-- expirar por relógio.
--
-- ⚠️ O TTL atua em DOIS lugares independentes, e mexer só num é INERTE:
--   (1) private.atp_disponivel — `AND r.expira_em > now()` no CTE `res`. É AQUI que
--       a reserva deixa de descontar. Este é o mecanismo que abre a janela.
--   (2) private.expirar_reservas_vencidas_job — carimba status='expirada', e o
--       cálculo exige status='ativa'. Sozinha, ela também mataria a reserva.
--   Confirmado pelo challenge: não há uma terceira atuação do relógio. As duas
--   juntas fecham a expiração por TTL; qualquer uma sozinha deixa a janela aberta.
--
-- ────────────────────────────────────────────────────────────
-- O QUE O CHALLENGE ADVERSARIAL (/codex gpt-5.6-sol xhigh, 2026-08-08) DERRUBOU
-- do desenho original, com cada achado MEDIDO contra a prod antes de aceitar:
--
-- A) A RESERVA APONTA PARA A LINHA ERRADA. O app cria a linha "push" de
--    sales_orders e a reserva se vincula a ela; o sync de pedidos mantém o status
--    canônico numa linha "pull" IRMÃ. Medido: 19 pedidos oben com 2+ linhas para o
--    mesmo omie_pedido_id, e o pedido da reserva viva é um deles — a push está em
--    'enviado' (hash_payload vazio) e a pull em 'importado'
--    (hash_payload='omie_oben_12156020937'). Ler so.status pelo vínculo direto
--    NUNCA veria 'faturado' nem 'cancelado'. É por isso que há linhas push paradas
--    em 'enviado' desde abril.
--    ⇒ o fato é lido da LINHA CANÔNICA, casada por (account, omie_pedido_id) com
--      hash_payload preenchido — o mesmo critério que o sync usa
--      (omie-vendas-sync:1408 "busca os pais por hash_payload determinístico, NÃO
--      por omie_pedido_id") e que o índice único uniq_sales_orders_omie_pedido_id
--      já garante ser no máximo UMA linha.
--
-- B) `synced_at` POSTERIOR NÃO PROVA A BAIXA. O consumo automático saiu do escopo.
--    Três razões independentes, todas verificadas:
--     • o inventory sync captura UM timestamp por run APÓS coletar as páginas
--       (omie-analytics-sync:1157, comentário no próprio código: "capturado APÓS a
--       coleta Omie") — uma run iniciada ANTES do faturamento grava synced_at
--       posterior ao carimbo com dado PRÉ-baixa;
--     • o Omie permite faturar item marcado para NÃO movimentar estoque — então
--       'faturado' não implica baixa nem em princípio;
--     • faturamento PARCIAL cria pedidos filhos com outro omie_pedido_id; os
--       movimentos não pertencem ao pedido de origem ao qual a reserva se liga.
--    Provar a baixa exige fato causal por SKU/quantidade (movimento de estoque ou
--    itens da NF-e) — integração nova, que é OUTRA entrega. Aqui a reserva de
--    pedido faturado é OBSERVADA e LISTADA; quem a resolve é a RPC auditada.
--    Isso troca oversell por undersell até a resolução: o lado certo do
--    fail-closed (precisão > recall).
--
-- C) `deleted_at` NÃO É PROVA DE CANCELAMENTO. O front grava deleted_at ANTES de
--    chamar o Omie e só faz rollback se o edge devolver erro (soft-delete.ts:17);
--    um job rodando na janela liberaria estoque de pedido ainda vivo.
--    ⇒ libera só por 'cancelado' (etapa 80) na linha canônica. deleted_at não age.
--
-- D) `sales_order_id IS NOT NULL` NÃO É "PV FIRME". O vínculo nasce no gate ANTES
--    da chamada ao Omie (fase 2:196); se a criação do PV falhar em definitivo, a
--    reserva ficaria imortal sem pedido nenhum do outro lado.
--    ⇒ o que suspende o TTL é o PV CONFIRMADO: omie_pedido_id preenchido. Reserva
--      pré-PV segue no TTL, que é a resposta certa ali (não há fato futuro).
--
-- E) REGRESSÃO DE STATUS. statusEhOmie('faturado') é true, então o reprocess pode
--    trocar 'faturado' de volta por outra etapa. O carimbo de observação é LIMPO
--    quando o status canônico deixa de ser 'faturado', para um faturamento futuro
--    não reaproveitar uma observação velha.
--
-- SOBRE O ADVISORY LOCK (a assimetria é DESENHO, não descuido): o job NÃO trava e
-- a atp_resolver_reserva TRAVA. A razão de fundo vale para os dois — tudo o que a
-- fase 3 faz é LIBERAR capacidade (a reserva sai de 'ativa', o reservado do SKU
-- diminui), e uma leitura defasada disso é CONSERVADORA: reservar_estoque enxerga
-- reservado a MAIS, nunca a menos, então não há oversell. E atp_disponivel é STABLE
-- num único statement, então saldo e reservas vêm do MESMO snapshot: não existe o
-- caso de ler saldo velho com reserva nova. O que separa os dois é o custo: o job
-- varre todas as reservas ativas e travar cada SKU bloquearia venda em curso; a RPC
-- humana trava UM SKU por chamada, custo nulo, e ali a serialização é defesa em
-- profundidade barata. Se um dia a reconciliação passar a CRIAR ou AUMENTAR reserva,
-- esta análise deixa de valer e o lock volta a ser obrigatório no job.
--
-- NÃO entra (registrado de propósito — cada um é outra entrega):
--  • Consumo automático da reserva (precisa do fato causal do item B).
--  • O protocolo de lock do SYNC (P0 estrutural conhecido): quem escreve
--    inventory_position não toma o advisory lock do SKU.
--  • Reconciliar a duplicidade push/pull de sales_orders (o item A é contornado
--    aqui lendo a canônica; consertar a duplicidade é do domínio do sync).
--  • UI de backorder e ampliação do pool para 'colacor'.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1) Carimbo da OBSERVAÇÃO do faturamento (não afirma consumo — ver item B)
-- ────────────────────────────────────────────────────────────
ALTER TABLE public.estoque_reservas
  ADD COLUMN IF NOT EXISTS faturamento_observado_em timestamptz;

COMMENT ON COLUMN public.estoque_reservas.faturamento_observado_em IS
  'Instante em que a reconciliação viu a linha CANÔNICA do pedido em status=faturado. '
  'Não afirma que o Omie baixou o estoque (faturar item sem movimentação e faturamento '
  'parcial quebram essa inferência) — é o gatilho da revisão humana via '
  'public.atp_resolver_reserva. Limpo se o status canônico regredir.';

-- Varredura do job: reservas ativas vinculadas a pedido.
CREATE INDEX IF NOT EXISTS idx_estoque_reservas_pedido_ativa
  ON public.estoque_reservas (sales_order_id) WHERE status = 'ativa' AND sales_order_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────
-- 2) A trilha ganha os desfechos da fase 3. Isto altera o CHECK de DOMÍNIO;
--    os privilégios (append-only: nem service_role tem UPDATE/DELETE) ficam
--    intactos — nenhum GRANT/REVOKE é tocado aqui.
-- ────────────────────────────────────────────────────────────
ALTER TABLE public.atp_decisoes DROP CONSTRAINT IF EXISTS atp_decisoes_decisao_check;
ALTER TABLE public.atp_decisoes ADD CONSTRAINT atp_decisoes_decisao_check
  CHECK (decisao IN (
    -- fases 1/2
    'reservado', 'bloqueado', 'backorder_autorizado', 'verificacao_indisponivel',
    -- fase 3: automáticos (job)
    'liberado_por_cancelamento', 'faturamento_observado',
    -- fase 3: resolução humana auditada (atp_resolver_reserva)
    'consumo_confirmado_manual', 'cancelamento_confirmado_manual', 'liberacao_forcada'));

ALTER TABLE public.atp_decisoes DROP CONSTRAINT IF EXISTS atp_decisoes_contexto_check;
ALTER TABLE public.atp_decisoes ADD CONSTRAINT atp_decisoes_contexto_check
  CHECK (contexto IN ('criacao', 'edicao', 'reconciliacao', 'resolucao_manual'));

-- ────────────────────────────────────────────────────────────
-- 3) M1 — o cálculo: a reserva de um PV FIRME desconta sem olhar o relógio.
--    Recriada INTEIRA (CREATE OR REPLACE substitui o corpo todo — transcrição da
--    versão VIVA em prod, conferida hoje por pg_get_functiondef: corpo byte-a-byte
--    igual ao repo da fase 1.1). A ÚNICA mudança é o predicado do CTE `res`.
--    Assinatura e as 6 colunas de retorno preservadas na mesma ordem.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.atp_disponivel(
  p_pool text,
  p_sku bigint,
  p_excluir_checkout uuid DEFAULT NULL
)
RETURNS TABLE (
  saldo numeric,
  saldo_synced_at timestamptz,
  saldo_confiavel boolean,
  reservado numeric,
  seguranca numeric,
  disponivel numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH pool_contas AS (
    SELECT CASE p_pool WHEN 'oben' THEN ARRAY['vendas','oben'] ELSE ARRAY[]::text[] END AS contas
  ),
  linha AS (
    -- eleição por frescor entre as contas do pool (padrão ESTOQUE_ACCOUNTS do
    -- cockpit): a linha mais recente vence; empate → account em ordem estável.
    -- Elege entre TODAS as linhas (não só as válidas) de propósito: se a mais
    -- fresca for inválida, o guard abaixo reprova o SKU inteiro (fail-closed)
    -- em vez de cair numa linha velha que por acaso passa.
    SELECT ip.saldo, ip.synced_at
    FROM public.inventory_position ip, pool_contas pc
    WHERE ip.omie_codigo_produto = p_sku
      AND ip.account = ANY (pc.contas)
    ORDER BY ip.synced_at DESC NULLS LAST, ip.account
    LIMIT 1
  ),
  frescas AS (
    -- posições do pool que passariam TODOS os guards por si só. Serve só para
    -- medir concordância entre contas (C3).
    SELECT ip.saldo
    FROM public.inventory_position ip, pool_contas pc
    WHERE ip.omie_codigo_produto = p_sku
      AND ip.account = ANY (pc.contas)
      AND ip.synced_at IS NOT NULL
      AND ip.synced_at > now() - interval '24 hours'
      AND ip.synced_at <= now() + interval '5 minutes'
      AND ip.saldo IS NOT NULL
      AND ip.saldo <> 'NaN'::numeric
      AND ip.saldo >= 0
      AND ip.saldo < 'Infinity'::numeric
  ),
  base AS (
    SELECT
      (SELECT l.saldo FROM linha l) AS saldo,
      (SELECT l.synced_at FROM linha l) AS synced_at,
      -- C3: 2+ saldos distintos entre posições frescas e válidas = as contas
      -- deixaram de ser espelho ⇒ não sabemos qual é a verdade ⇒ não prometer.
      (SELECT count(DISTINCT f.saldo) > 1 FROM frescas f) AS divergente
  ),
  seg AS (
    -- Parâmetro AUSENTE = sem colchão configurado (0) — default de política,
    -- não dado fabricado. Parâmetro PRESENTE mas inválido (NaN/Infinity/<0) =
    -- C2: não dá para calcular ⇒ o SKU vira não-confiável (nunca colchão 0,
    -- que removeria a proteção em silêncio).
    -- LIMIT 1 sem ORDER BY é seguro: prod tem UNIQUE(empresa, sku_codigo_omie),
    -- conferido via psql-ro — a duplicata que a fase 1 tratava é impossível.
    SELECT
      COALESCE((
        SELECT sp.estoque_seguranca
        FROM public.sku_parametros sp
        WHERE sp.empresa = (CASE p_pool WHEN 'oben' THEN 'OBEN' END)
          AND sp.sku_codigo_omie = p_sku
          AND sp.estoque_seguranca IS NOT NULL
          AND sp.estoque_seguranca <> 'NaN'::numeric
          AND sp.estoque_seguranca >= 0
          AND sp.estoque_seguranca < 'Infinity'::numeric
        LIMIT 1
      ), 0) AS seguranca,
      EXISTS (
        SELECT 1
        FROM public.sku_parametros sp
        WHERE sp.empresa = (CASE p_pool WHEN 'oben' THEN 'OBEN' END)
          AND sp.sku_codigo_omie = p_sku
          AND sp.estoque_seguranca IS NOT NULL
          AND NOT (
            sp.estoque_seguranca <> 'NaN'::numeric
            AND sp.estoque_seguranca >= 0
            AND sp.estoque_seguranca < 'Infinity'::numeric
          )
      ) AS seg_invalida
  ),
  calc AS (
    SELECT
      b.saldo,
      b.synced_at,
      -- FAIL-CLOSED. NaN em numeric ordena ACIMA de tudo ('NaN' >= 0 é true) e
      -- 'NaN' = 'NaN' é true, então o <> 'NaN' pega. Infinity também passaria o
      -- >= 0 — daí o bound de finitude (C1).
      (b.synced_at IS NOT NULL
        AND b.synced_at > now() - interval '24 hours'
        AND b.synced_at <= now() + interval '5 minutes'
        AND b.saldo IS NOT NULL
        AND b.saldo <> 'NaN'::numeric
        AND b.saldo >= 0
        AND b.saldo < 'Infinity'::numeric
        AND NOT b.divergente
        AND NOT s.seg_invalida) AS confiavel
    FROM base b CROSS JOIN seg s
  ),
  res AS (
    -- FASE 3 — a ÚNICA mudança desta migration no cálculo.
    -- Reserva de PV FIRME (o pedido vinculado já tem omie_pedido_id) desconta
    -- enquanto estiver 'ativa', SEM olhar expira_em: o Omie só baixa o saldo no
    -- faturamento (p90 medido de 324h) e o TTL de 30min mataria a reserva antes,
    -- devolvendo a mesma unidade ao ATP. Quem a tira de 'ativa' é o desfecho —
    -- cancelamento confirmado (job) ou resolução humana auditada.
    -- O discriminante é omie_pedido_id, NÃO sales_order_id: o vínculo nasce ANTES
    -- da chamada ao Omie (fase 2), então reserva pré-PV (ou de PV que falhou em
    -- definitivo) segue no TTL — ali o relógio é a resposta certa, porque não há
    -- fato futuro que a resolva.
    SELECT COALESCE(sum(r.quantidade), 0) AS reservado
    FROM public.estoque_reservas r
    WHERE r.pool = p_pool
      AND r.omie_codigo_produto = p_sku
      AND r.status = 'ativa'
      AND (
        r.expira_em > now()
        OR EXISTS (
          SELECT 1 FROM public.sales_orders so
          WHERE so.id = r.sales_order_id
            AND so.omie_pedido_id IS NOT NULL
        )
      )
      AND (p_excluir_checkout IS NULL OR r.checkout_id <> p_excluir_checkout)
  )
  SELECT
    c.saldo,
    c.synced_at,
    COALESCE(c.confiavel, false),
    r.reservado,
    s.seguranca,
    -- disponivel pode ser NEGATIVO (reservas+colchão > saldo após queda no sync):
    -- informação honesta p/ a reconciliação — não clampar em 0.
    CASE WHEN COALESCE(c.confiavel, false)
         THEN c.saldo - r.reservado - s.seguranca
         ELSE NULL END
  FROM calc c
  CROSS JOIN res r
  CROSS JOIN seg s;
$function$;

REVOKE ALL ON FUNCTION private.atp_disponivel(text, bigint, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.atp_disponivel(text, bigint, uuid) FROM anon;
REVOKE ALL ON FUNCTION private.atp_disponivel(text, bigint, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION private.atp_disponivel(text, bigint, uuid) TO service_role;

-- ────────────────────────────────────────────────────────────
-- 4) M2 — a higiene por TTL passa a pular a reserva de PV FIRME.
--    Recriada INTEIRA (transcrição da versão VIVA em prod, conferida hoje).
--    O predicado é o MESMO do cálculo (M1): se divergissem, a reserva sairia de
--    'ativa' aqui e o M1 pararia de contá-la — a janela de volta pela porta do
--    status.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.expirar_reservas_vencidas_job()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.estoque_reservas r
     SET status = 'expirada',
         motivo = 'expirada por TTL',
         atualizado_em = now()
   WHERE r.status = 'ativa'
     AND r.expira_em <= now()
     -- FASE 3: reserva de PV firme não morre pelo relógio (mesmo predicado do M1).
     AND NOT EXISTS (
       SELECT 1 FROM public.sales_orders so
       WHERE so.id = r.sales_order_id
         AND so.omie_pedido_id IS NOT NULL
     );
  GET DIAGNOSTICS v_n = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'expiradas', v_n);
END;
$function$;

REVOKE ALL ON FUNCTION private.expirar_reservas_vencidas_job() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.expirar_reservas_vencidas_job() FROM anon;
REVOKE ALL ON FUNCTION private.expirar_reservas_vencidas_job() FROM authenticated;

-- ────────────────────────────────────────────────────────────
-- 5) A linha CANÔNICA de um pedido — onde o sync mantém o status de verdade.
--    Casada por (account, omie_pedido_id) com hash_payload preenchido: é o mesmo
--    critério do sync (omie-vendas-sync:1408) e o índice único
--    uniq_sales_orders_omie_pedido_id garante no máximo uma linha.
--    Devolve 0 linhas quando não há canônica — e aí NADA age (ausente ≠ zero).
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.atp_pedido_canonico(p_sales_order_id uuid)
RETURNS TABLE (canonico_id uuid, status text, omie_pedido_id bigint, account text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT c.id, c.status, c.omie_pedido_id, c.account
  FROM public.sales_orders push
  JOIN public.sales_orders c
    ON c.account = push.account
   AND c.omie_pedido_id = push.omie_pedido_id
   AND c.hash_payload IS NOT NULL
  WHERE push.id = p_sales_order_id
    AND push.omie_pedido_id IS NOT NULL
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION private.atp_pedido_canonico(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.atp_pedido_canonico(uuid) FROM anon;
REVOKE ALL ON FUNCTION private.atp_pedido_canonico(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION private.atp_pedido_canonico(uuid) TO service_role;

-- ────────────────────────────────────────────────────────────
-- 6) M3 — a reconciliação automática. Entrypoint de JOB (sem gate de JWT —
--    pg_cron roda sem claims) + RPC pública gateada delegando. 1 writer.
--    Só age por FATO POSITIVO lido da linha canônica.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.atp_reconciliar_job()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_liberadas integer := 0;
  v_observadas integer := 0;
  v_rearmadas integer := 0;
  v_aguardando integer;
  v_presas integer;
BEGIN
  -- ── (a) LIBERAÇÃO por cancelamento CONFIRMADO no Omie (etapa 80 → 'cancelado'
  --        na linha canônica). Aqui o Omie não baixou nada, então o estoque volta
  --        a estar livre de verdade — não há fato futuro a esperar.
  --        deleted_at NÃO entra: é gravado pelo front ANTES da confirmação remota.
  WITH alvo AS (
    SELECT r.id, r.checkout_id, r.sales_order_id, k.account
    FROM public.estoque_reservas r
    CROSS JOIN LATERAL private.atp_pedido_canonico(r.sales_order_id) k
    WHERE r.status = 'ativa'
      AND r.sales_order_id IS NOT NULL
      AND k.status = 'cancelado'
  ),
  upd AS (
    UPDATE public.estoque_reservas r
       SET status = 'liberada',
           motivo = 'reconciliacao: cancelamento confirmado no Omie',
           atualizado_em = now()
      FROM alvo a
     WHERE r.id = a.id
    RETURNING a.sales_order_id AS so_id, a.checkout_id AS ck, a.account AS acc
  ),
  trilha AS (
    INSERT INTO public.atp_decisoes
      (sales_order_id, checkout_id, pool, account, decisao, contexto, enforcement, actor_user_id)
    SELECT DISTINCT u.so_id, u.ck, 'oben', COALESCE(u.acc, 'oben'),
           'liberado_por_cancelamento', 'reconciliacao', true, NULL::uuid
    FROM upd u
    RETURNING 1
  )
  SELECT count(*) INTO v_liberadas FROM upd;

  -- ── (b) OBSERVAÇÃO do faturamento. Só CARIMBA — não consome. O carimbo não
  --        afirma que o estoque baixou (ver item B do cabeçalho); ele é o gatilho
  --        da revisão humana. clock_timestamp(), não now(): o carimbo é um
  --        instante de parede, e now() é o do BEGIN.
  WITH alvo AS (
    SELECT r.id, r.checkout_id, r.sales_order_id, k.account
    FROM public.estoque_reservas r
    CROSS JOIN LATERAL private.atp_pedido_canonico(r.sales_order_id) k
    WHERE r.status = 'ativa'
      AND r.sales_order_id IS NOT NULL
      AND r.faturamento_observado_em IS NULL
      AND k.status = 'faturado'
  ),
  upd AS (
    UPDATE public.estoque_reservas r
       SET faturamento_observado_em = clock_timestamp(),
           atualizado_em = now()
      FROM alvo a
     WHERE r.id = a.id
    RETURNING a.sales_order_id AS so_id, a.checkout_id AS ck, a.account AS acc
  ),
  trilha AS (
    INSERT INTO public.atp_decisoes
      (sales_order_id, checkout_id, pool, account, decisao, contexto, enforcement, actor_user_id)
    SELECT DISTINCT u.so_id, u.ck, 'oben', COALESCE(u.acc, 'oben'),
           'faturamento_observado', 'reconciliacao', true, NULL::uuid
    FROM upd u
    RETURNING 1
  )
  SELECT count(*) INTO v_observadas FROM upd;

  -- ── (c) REARMA o carimbo quando o status canônico REGREDIU. statusEhOmie
  --        aceita trocar 'faturado' por outra etapa conhecida; sem isto, um
  --        faturamento futuro reaproveitaria uma observação velha.
  UPDATE public.estoque_reservas r
     SET faturamento_observado_em = NULL,
         atualizado_em = now()
   WHERE r.status = 'ativa'
     AND r.faturamento_observado_em IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM private.atp_pedido_canonico(r.sales_order_id) k
       WHERE k.status = 'faturado'
     );
  GET DIAGNOSTICS v_rearmadas = ROW_COUNT;

  -- ── Observabilidade. Sem escape por relógio, "reserva parada" é o modo de
  --     falha que substitui o oversell — e é um número que alguém precisa olhar
  --     (sync de pedidos parado trava TODAS em silêncio).
  SELECT count(*) INTO v_aguardando
  FROM public.estoque_reservas r
  WHERE r.status = 'ativa' AND r.faturamento_observado_em IS NOT NULL;

  SELECT count(*) INTO v_presas
  FROM public.estoque_reservas r
  WHERE r.status = 'ativa'
    AND r.sales_order_id IS NOT NULL
    AND r.created_at <= now() - interval '7 days';

  RETURN jsonb_build_object(
    'ok', true,
    'liberadas_por_cancelamento', v_liberadas,
    'faturamentos_observados', v_observadas,
    'carimbos_rearmados', v_rearmadas,
    'aguardando_resolucao', v_aguardando,
    'ativas_ha_mais_de_7d', v_presas
  );
END;
$function$;

REVOKE ALL ON FUNCTION private.atp_reconciliar_job() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.atp_reconciliar_job() FROM anon;
REVOKE ALL ON FUNCTION private.atp_reconciliar_job() FROM authenticated;

CREATE OR REPLACE FUNCTION public.atp_reconciliar()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
BEGIN
  IF NOT private.cap_estoque_reservar(v_uid) THEN
    RAISE EXCEPTION 'Sem permissão para reconciliar reservas de estoque (staff apenas)'
      USING ERRCODE = '42501';
  END IF;

  RETURN private.atp_reconciliar_job();
END;
$function$;

REVOKE ALL ON FUNCTION public.atp_reconciliar() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atp_reconciliar() FROM anon;
GRANT EXECUTE ON FUNCTION public.atp_reconciliar() TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────
-- 7) A VÁLVULA HUMANA AUDITADA. Sem escape por relógio, alguém precisa poder
--    encerrar uma reserva — e esse ato tem de deixar rastro melhor que o da
--    liberar_reserva_checkout (que apaga TODAS as reservas do checkout sem exigir
--    motivo, sem ator e sem trilha).
--    Aqui: uma reserva por chamada, ator humano obrigatório (cron não resolve),
--    motivo textual obrigatório, desfecho EXPLÍCITO e evento append-only.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.atp_resolver_reserva(
  p_reserva_id uuid,
  p_desfecho text,
  p_motivo text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_r record;
  v_status text;
BEGIN
  IF NOT private.cap_estoque_reservar(v_uid) THEN
    RAISE EXCEPTION 'Sem permissão para resolver reserva de estoque (staff apenas)'
      USING ERRCODE = '42501';
  END IF;
  -- Ator humano obrigatório: service_role passa o gate acima (engines/cron), mas
  -- encerrar reserva é ato de PESSOA — é o que a trilha precisa poder nomear.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'resolver reserva exige um ator humano (cron/sistema não resolve)'
      USING ERRCODE = '42501';
  END IF;
  IF p_reserva_id IS NULL THEN
    RAISE EXCEPTION 'p_reserva_id é obrigatório' USING ERRCODE = '22023';
  END IF;
  IF p_desfecho IS NULL OR p_desfecho NOT IN
     ('consumo_confirmado_manual', 'cancelamento_confirmado_manual', 'liberacao_forcada') THEN
    RAISE EXCEPTION 'p_desfecho inválido: % (use consumo_confirmado_manual, cancelamento_confirmado_manual ou liberacao_forcada)', p_desfecho
      USING ERRCODE = '22023';
  END IF;
  IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN
    RAISE EXCEPTION 'resolver reserva exige motivo textual' USING ERRCODE = '22023';
  END IF;

  SELECT r.id, r.pool, r.checkout_id, r.sales_order_id, r.omie_codigo_produto, r.status
    INTO v_r
  FROM public.estoque_reservas r
  WHERE r.id = p_reserva_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reserva % não existe', p_reserva_id USING ERRCODE = '22023';
  END IF;
  IF v_r.status <> 'ativa' THEN
    -- Recusa de NEGÓCIO (não é erro de contrato): a reserva já teve desfecho.
    RETURN jsonb_build_object('ok', false, 'motivo', 'reserva_nao_ativa', 'status', v_r.status);
  END IF;

  -- Serializa contra reservar_estoque pelo MESMO namespace da fase 1. Só o lock do
  -- SKU: a reconciliação nunca toma o do checkout, então não há ciclo com quem
  -- toma checkout → SKUs (deadlock-free).
  PERFORM pg_advisory_xact_lock(hashtextextended('atp:sku:' || v_r.pool || ':' || v_r.omie_codigo_produto::text, 0));

  v_status := CASE p_desfecho WHEN 'consumo_confirmado_manual' THEN 'consumida' ELSE 'liberada' END;

  UPDATE public.estoque_reservas
     SET status = v_status,
         motivo = p_desfecho || ': ' || btrim(p_motivo),
         atualizado_em = now()
   WHERE id = p_reserva_id
     AND status = 'ativa';

  INSERT INTO public.atp_decisoes
    (sales_order_id, checkout_id, pool, account, decisao, contexto, enforcement,
     motivo_backorder, actor_user_id)
  VALUES
    (v_r.sales_order_id, v_r.checkout_id, v_r.pool, 'oben', p_desfecho, 'resolucao_manual', true,
     btrim(p_motivo), v_uid);

  RETURN jsonb_build_object('ok', true, 'reserva_id', p_reserva_id,
                            'desfecho', p_desfecho, 'status', v_status);
END;
$function$;

REVOKE ALL ON FUNCTION public.atp_resolver_reserva(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atp_resolver_reserva(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.atp_resolver_reserva(uuid, text, text) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────
-- 8) A fila da resolução humana — quem for resolver precisa ver quais são,
--    com o status CANÔNICO ao lado (a linha vinculada mente, item A).
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.atp_reservas_pendentes(p_dias integer DEFAULT 0)
RETURNS TABLE (
  reserva_id uuid,
  sales_order_id uuid,
  omie_pedido_id bigint,
  omie_codigo_produto bigint,
  quantidade numeric,
  status_vinculado text,
  status_canonico text,
  faturamento_observado_em timestamptz,
  ativa_ha_dias numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT private.cap_estoque_reservar((SELECT auth.uid())) THEN
    RAISE EXCEPTION 'Sem permissão para listar reservas de estoque (staff apenas)'
      USING ERRCODE = '42501';
  END IF;
  IF p_dias IS NULL OR p_dias < 0 THEN
    RAISE EXCEPTION 'p_dias deve ser >= 0' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT r.id, r.sales_order_id, so.omie_pedido_id, r.omie_codigo_produto, r.quantidade,
         so.status, k.status, r.faturamento_observado_em,
         round((EXTRACT(epoch FROM (now() - r.created_at)) / 86400)::numeric, 1)
  FROM public.estoque_reservas r
  LEFT JOIN public.sales_orders so ON so.id = r.sales_order_id
  LEFT JOIN LATERAL private.atp_pedido_canonico(r.sales_order_id) k ON true
  WHERE r.status = 'ativa'
    AND r.sales_order_id IS NOT NULL
    AND r.created_at <= now() - make_interval(days => p_dias)
  ORDER BY r.faturamento_observado_em NULLS LAST, r.created_at;
END;
$function$;

REVOKE ALL ON FUNCTION public.atp_reservas_pendentes(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atp_reservas_pendentes(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.atp_reservas_pendentes(integer) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────
-- 9) Agenda a reconciliação. Idempotente: desagenda antes de agendar.
--    A cada 10min — o sync de pedidos (que traz 'cancelado'/'faturado') roda a
--    cada 2h, então 10min é folgado e não acrescenta latência própria.
-- ────────────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM cron.unschedule('atp-reconciliar');
EXCEPTION WHEN OTHERS THEN
  NULL;  -- job ainda não existe: primeira aplicação
END $$;

SELECT cron.schedule(
  'atp-reconciliar',
  '*/10 * * * *',
  $cron$SELECT private.atp_reconciliar_job()$cron$
);
