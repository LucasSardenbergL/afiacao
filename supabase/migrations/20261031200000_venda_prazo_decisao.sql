-- ============================================================
-- Aviso + sugestão de prazo no pedido para cliente com título VENCIDO em aberto
-- (plano Oben PME/PMR, Frente B, PR1 — spec docs/superpowers/specs/2026-10-31-oben-frente-b-pedido-cobranca-cet-design.md §2)
--
-- Decisão do founder (2026-10-31): o pedido AVISA a vendedora e SUGERE condição menor;
-- ela decide e a decisão fica REGISTRADA com motivo. Nada trava — `venda_gate_credito`
-- (vencido > 60 d com exceção de gestor) segue INALTERADO.
--
-- Três objetos, nenhum deles existe em prod (sem PRE anti-deriva: não há objeto vivo a recriar):
--   1) venda_prazo_aviso(p_company, p_codigo) → jsonb    — leitura, 0,5 ms (fin_contas_receber por
--      (company, omie_codigo_cliente)); espelha a regra `vencida_aberta` de v_ciclo_cr_titulos
--      (20261014120000) para aviso e fila de cobrança falarem do MESMO universo (achado Codex P1 #4).
--      A view inteira custa 2,7 s por cliente (agrega a empresa; medido 2026-10-31) — não serve a tela.
--   2) venda_prazo_decisao                                 — 1 decisão por (pedido, conta); 1 WRITER
--      (a RPC abaixo); sem policy de escrita para usuários; auditoria SOBREVIVE à exclusão do pedido
--      (sem FK — o vínculo é conferido na escrita).
--   3) venda_prazo_decisao_registrar(p jsonb) → jsonb      — confere no SERVIDOR que o pedido é de quem
--      registra (ou gestor/master), que a conta do pedido é a informada e que o cliente do pedido tem
--      ESTE código Omie nesta conta (omie_customer_account_map); recomputa o vencido no instante;
--      grava o evento `venda.prazo_sugerido` em analytics_outbox na MESMA transação, com chave de dedup
--      = id da decisão (achado Codex P1 #12). Não estende a allowlist de analytics_ledger_registrar
--      (função quente, 3 frentes paralelas) — este writer é o único emissor do evento.
--
-- Caminho: `bun run db:aplicar supabase/migrations/20261031200000_venda_prazo_decisao.sql`
-- (sem envelope: a transação é do executor). Postcondição embutida no fim.
-- Prova PG17: db/test-venda-prazo-decisao.sh (controle verde + sabotagens declaradas).
-- ============================================================

-- ------------------------------------------------------------
-- 1) Aviso: vencido em aberto do par (company, código Omie) pela regra da view do Ciclo.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.venda_prazo_aviso(p_company text, p_codigo bigint)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_vencido numeric;
  v_n int;
  v_dias_max int;
  v_mais_antigo date;
  v_atraso_medio numeric;
  v_n_ambiguos int;
  v_n_invalidos int;
  v_sync timestamptz;
BEGIN
  -- SECURITY DEFINER bypassa a RLS de fin_contas_receber ⇒ o gate vive AQUI. Staff = quem vende
  -- (o mesmo recorte que já lê fin_contas_receber pela RLS staff no alerta de crédito da tela).
  IF v_uid IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = v_uid AND ur.role IN ('employee'::public.app_role, 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'venda_prazo_aviso: exige staff' USING ERRCODE = '42501';
  END IF;

  -- Sem código não há evidência possível → indisponível, nunca "cliente OK" (precisão > recall).
  IF p_company IS NULL OR p_codigo IS NULL OR p_codigo <= 0 THEN
    RETURN jsonb_build_object('disponivel', false, 'motivo', 'sem_codigo');
  END IF;

  -- Vocabulário espelha OPEN_TITLE_STATUSES (src/lib/financeiro/titulo-status.ts; paridade por vitest).
  -- `vencido` = a regra `vencida_aberta` de v_ciclo_cr_titulos: status nativo (ATRASADO, ou A VENCER/
  -- VENCE HOJE já passado = lag de sync), saldo finito > 0, documento e datas válidos.
  -- `ambiguo` = fallback do ingest (ABERTO/VENCIDO/PARCIAL) — contado à parte, NUNCA somado.
  -- `invalido` = o que a view também descarta (valor/datas) — contado à parte.
  SELECT count(*) FILTER (WHERE x.vencido),
         coalesce(sum(x.saldo) FILTER (WHERE x.vencido), 0),
         max(greatest(v_hoje - x.data_vencimento, 0)) FILTER (WHERE x.vencido),
         min(x.data_vencimento) FILTER (WHERE x.vencido),
         CASE WHEN coalesce(sum(x.saldo) FILTER (WHERE x.vencido), 0) > 0
              THEN round(sum(x.saldo * greatest(v_hoje - x.data_vencimento, 0)) FILTER (WHERE x.vencido)
                         / sum(x.saldo) FILTER (WHERE x.vencido), 1) END,
         count(*) FILTER (WHERE x.ambiguo),
         count(*) FILTER (WHERE x.invalido)
    INTO v_n, v_vencido, v_dias_max, v_mais_antigo, v_atraso_medio, v_n_ambiguos, v_n_invalidos
    FROM (
      SELECT r.saldo, r.data_vencimento,
             (r.status_titulo IN ('ABERTO', 'VENCIDO', 'PARCIAL')) AS ambiguo,
             NOT (r.valor_documento IS NOT NULL AND r.valor_documento <> 'NaN' AND r.valor_documento < 'Infinity'
                  AND r.valor_documento > 0 AND r.data_emissao IS NOT NULL AND r.data_vencimento IS NOT NULL
                  AND r.data_vencimento >= r.data_emissao
                  AND r.saldo IS NOT NULL AND r.saldo <> 'NaN' AND r.saldo < 'Infinity' AND r.saldo > 0) AS invalido,
             (r.status_titulo = 'ATRASADO'
              OR (r.status_titulo IN ('A VENCER', 'VENCE HOJE') AND r.data_vencimento < v_hoje))
             AND r.valor_documento IS NOT NULL AND r.valor_documento <> 'NaN' AND r.valor_documento < 'Infinity'
             AND r.valor_documento > 0 AND r.data_emissao IS NOT NULL AND r.data_vencimento IS NOT NULL
             AND r.data_vencimento >= r.data_emissao
             AND r.saldo IS NOT NULL AND r.saldo <> 'NaN' AND r.saldo < 'Infinity' AND r.saldo > 0 AS vencido
        FROM public.fin_contas_receber r
       WHERE r.company = p_company
         AND r.omie_codigo_cliente = p_codigo
         AND r.status_titulo IN ('A VENCER', 'ATRASADO', 'VENCE HOJE', 'ABERTO', 'VENCIDO', 'PARCIAL')
         AND r.saldo > 0
    ) x;

  -- Frescor do CR DESTA empresa (sync de outra conta não mascara defasagem — achado Codex P1 #5).
  SELECT max(l.completed_at) INTO v_sync
    FROM public.fin_sync_log l
   WHERE l.status = 'complete'
     AND l.action IN ('sync_contas_receber', 'sync_all')
     AND p_company = ANY (l.companies);

  RETURN jsonb_build_object(
    'disponivel', true,
    'vencido', v_vencido,
    'n_titulos', v_n,
    'dias_vencido_max', v_dias_max,
    'vencimento_mais_antigo', v_mais_antigo,
    -- Atraso médio SÓ do vencido em aberto, ponderado por saldo (não é o atraso histórico da view).
    'atraso_medio_vencido_dias', v_atraso_medio,
    'n_ambiguos', v_n_ambiguos,
    'n_invalidos', v_n_invalidos,
    'sync_em', v_sync,
    'qualidade', CASE WHEN v_sync IS NULL THEN 'sem_sync'
                      WHEN v_sync < now() - interval '24 hours' THEN 'defasado'
                      ELSE 'ok' END
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.venda_prazo_aviso(text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.venda_prazo_aviso(text, bigint) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 2) Decisão registrada — 1 por (pedido, conta). Sem FK ao pedido: a auditoria sobrevive à exclusão.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.venda_prazo_decisao (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL,
  company text NOT NULL CHECK (company IN ('oben', 'colacor')),
  omie_codigo_cliente bigint NOT NULL CHECK (omie_codigo_cliente > 0),
  nome_cliente text,
  -- Leitura do SERVIDOR no instante do registro (nunca o número que o cliente mandou).
  vencido_no_momento numeric NOT NULL
    CHECK (vencido_no_momento <> 'NaN' AND vencido_no_momento >= 0 AND vencido_no_momento <= 100000000),
  n_titulos integer NOT NULL CHECK (n_titulos >= 0),
  dias_vencido_max integer CHECK (dias_vencido_max IS NULL OR dias_vencido_max >= 0),
  -- Condições (código de parcela Omie): habitual do cliente, sugerida pela tela, escolhida no envio.
  parcela_habitual text,
  parcela_sugerida text,
  parcela_escolhida text NOT NULL CHECK (btrim(parcela_escolhida) <> ''),
  decisao text NOT NULL CHECK (decisao IN ('aceitou', 'recusou', 'recusou_sem_motivo', 'ignorou', 'sem_sugestao')),
  motivo text,
  motivo_sistema text,
  -- A escolhida não é a sugerida mas ANTECIPA tanto ou mais (dominância de calendário na tela).
  escolhida_cobre boolean NOT NULL DEFAULT false,
  -- O que aconteceu com o envio na mesma tentativa (denominador honesto: cobre bloqueio e erro).
  desfecho_envio text NOT NULL CHECK (desfecho_envio IN ('enviado', 'bloqueado_credito', 'erro', 'ja_enviado')),
  total_pedido numeric,
  decidido_por uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Coerência: só `recusou` carrega motivo obrigatório; `sem_sugestao` não tem parcela sugerida;
  -- `aceitou` = escolheu a sugerida (ou uma que a COBRE, flag `escolhida_cobre` declarada pela tela);
  -- recusa/ignorou = escolheu OUTRA (achado Codex código P2 #11).
  CONSTRAINT venda_prazo_decisao_motivo_recusa
    CHECK (decisao <> 'recusou' OR (motivo IS NOT NULL AND btrim(motivo) <> '')),
  CONSTRAINT venda_prazo_decisao_sugerida_coerente
    CHECK ((decisao = 'sem_sugestao') = (parcela_sugerida IS NULL)),
  CONSTRAINT venda_prazo_decisao_aceite_coerente
    CHECK (decisao <> 'aceitou' OR parcela_escolhida = parcela_sugerida OR escolhida_cobre),
  CONSTRAINT venda_prazo_decisao_recusa_coerente
    CHECK (decisao NOT IN ('recusou', 'recusou_sem_motivo', 'ignorou') OR parcela_escolhida <> parcela_sugerida),
  CONSTRAINT venda_prazo_decisao_unica UNIQUE (sales_order_id, company)
);

CREATE INDEX IF NOT EXISTS idx_venda_prazo_decisao_cliente
  ON public.venda_prazo_decisao (company, omie_codigo_cliente, created_at);

ALTER TABLE public.venda_prazo_decisao ENABLE ROW LEVEL SECURITY;

-- Nasce ABERTA pelo default privilege do Supabase → fecha e reabre só o que vale.
REVOKE ALL ON TABLE public.venda_prazo_decisao FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.venda_prazo_decisao TO authenticated;
GRANT ALL ON TABLE public.venda_prazo_decisao TO service_role;

-- Lê quem registrou a decisão e quem vê a carteira completa (gestor/master). Vendedora não lê a decisão
-- de outra (achado Codex P0: a policy "staff lê tudo" exporia cliente e vencido de pedidos alheios).
DROP POLICY IF EXISTS "venda_prazo_decisao_select" ON public.venda_prazo_decisao;
CREATE POLICY "venda_prazo_decisao_select"
  ON public.venda_prazo_decisao FOR SELECT
  USING (
    decidido_por = (SELECT auth.uid())
    -- `private.` e nao `public.`: o wrapper public nao tem EXECUTE para authenticated (hardening 20260718180000)
    -- e a policy roda como o CALLER — com o wrapper, todo SELECT de staff daria 42501 (achado Codex codigo PR2 #2).
    OR coalesce((SELECT private.pode_ver_carteira_completa((SELECT auth.uid()))), false)
  );

DROP POLICY IF EXISTS "venda_prazo_decisao_service_all" ON public.venda_prazo_decisao;
CREATE POLICY "venda_prazo_decisao_service_all"
  ON public.venda_prazo_decisao FOR ALL
  USING ((SELECT auth.role()) = 'service_role');

-- ------------------------------------------------------------
-- 3) O writer único da decisão (+ evento no ledger, mesma transação).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.venda_prazo_decisao_registrar(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_so uuid;
  v_company text;
  v_codigo bigint;
  v_decisao text;
  v_desfecho text;
  v_motivo text;
  v_sugerida text;
  v_escolhida text;
  v_cobre boolean := coalesce((p ->> 'escolhida_cobre')::boolean, false);
  v_pedido record;
  v_aviso jsonb;
  v_dias int;
  v_id uuid;
  v_criada boolean := false;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = v_uid AND ur.role IN ('employee'::public.app_role, 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'venda_prazo_decisao_registrar: exige staff' USING ERRCODE = '42501';
  END IF;

  -- Domínio fechado: o JSON do cliente só escolhe entre valores conhecidos.
  BEGIN
    v_so     := (p ->> 'sales_order_id')::uuid;
    v_codigo := (p ->> 'omie_codigo_cliente')::bigint;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'venda_prazo_decisao_registrar: payload invalido' USING ERRCODE = '22023';
  END;
  v_company  := p ->> 'company';
  v_decisao  := p ->> 'decisao';
  v_desfecho := p ->> 'desfecho_envio';
  v_motivo   := nullif(btrim(coalesce(p ->> 'motivo', '')), '');
  v_sugerida := nullif(btrim(coalesce(p ->> 'parcela_sugerida', '')), '');
  v_escolhida := nullif(btrim(coalesce(p ->> 'parcela_escolhida', '')), '');

  IF v_so IS NULL OR v_codigo IS NULL OR v_codigo <= 0 OR v_escolhida IS NULL
     OR v_company IS NULL OR v_company NOT IN ('oben', 'colacor')
     OR v_decisao IS NULL OR v_decisao NOT IN ('aceitou', 'recusou', 'recusou_sem_motivo', 'ignorou', 'sem_sugestao')
     OR v_desfecho IS NULL OR v_desfecho NOT IN ('enviado', 'bloqueado_credito', 'erro', 'ja_enviado') THEN
    RAISE EXCEPTION 'venda_prazo_decisao_registrar: payload invalido' USING ERRCODE = '22023';
  END IF;
  IF v_decisao = 'recusou' AND v_motivo IS NULL THEN
    RAISE EXCEPTION 'venda_prazo_decisao_registrar: recusa exige motivo' USING ERRCODE = '22023';
  END IF;
  IF (v_decisao = 'sem_sugestao') <> (v_sugerida IS NULL) THEN
    RAISE EXCEPTION 'venda_prazo_decisao_registrar: parcela_sugerida incoerente com a decisao' USING ERRCODE = '22023';
  END IF;
  -- Decisão × parcelas: aceitou ⇒ escolheu a sugerida (ou declarou que a escolhida a cobre);
  -- recusou/ignorou ⇒ escolheu outra. Contradição no payload é 22023, não um fato gravado.
  IF v_decisao = 'aceitou' AND v_escolhida <> v_sugerida AND NOT v_cobre THEN
    RAISE EXCEPTION 'venda_prazo_decisao_registrar: aceitou exige escolhida = sugerida (ou escolhida_cobre)' USING ERRCODE = '22023';
  END IF;
  IF v_decisao IN ('recusou', 'recusou_sem_motivo', 'ignorou') AND v_escolhida = v_sugerida THEN
    RAISE EXCEPTION 'venda_prazo_decisao_registrar: recusa/ignorou com escolhida = sugerida' USING ERRCODE = '22023';
  END IF;

  -- O pedido existe, é de quem registra (ou o caller vê a carteira completa), e a conta é a informada.
  SELECT so.created_by, so.account, so.customer_user_id, so.total
    INTO v_pedido
    FROM public.sales_orders so
   WHERE so.id = v_so;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'venda_prazo_decisao_registrar: pedido inexistente' USING ERRCODE = '22023';
  END IF;
  IF v_pedido.created_by IS DISTINCT FROM v_uid
     AND NOT coalesce(private.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'venda_prazo_decisao_registrar: pedido de outro vendedor' USING ERRCODE = '42501';
  END IF;
  IF v_pedido.account IS DISTINCT FROM v_company THEN
    RAISE EXCEPTION 'venda_prazo_decisao_registrar: conta nao corresponde ao pedido' USING ERRCODE = '22023';
  END IF;
  -- O cliente do pedido tem ESTE código Omie NESTA conta (proof-table do mapa; achado Codex P1 #2).
  IF v_pedido.customer_user_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.omie_customer_account_map m
        WHERE m.user_id = v_pedido.customer_user_id
          AND m.account = v_company
          AND m.omie_codigo_cliente = v_codigo) THEN
    RAISE EXCEPTION 'venda_prazo_decisao_registrar: cliente nao corresponde ao pedido' USING ERRCODE = '22023';
  END IF;

  -- O vencido é relido AQUI, no instante do registro — o número do cliente não é evidência.
  v_aviso := public.venda_prazo_aviso(v_company, v_codigo);
  IF (v_aviso ->> 'disponivel') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'venda_prazo_decisao_registrar: aviso indisponivel para o par' USING ERRCODE = '22023';
  END IF;
  v_dias := (v_aviso ->> 'dias_vencido_max')::int;

  INSERT INTO public.venda_prazo_decisao (
    sales_order_id, company, omie_codigo_cliente, nome_cliente,
    vencido_no_momento, n_titulos, dias_vencido_max,
    parcela_habitual, parcela_sugerida, parcela_escolhida, escolhida_cobre,
    decisao, motivo, motivo_sistema, desfecho_envio, total_pedido, decidido_por
  ) VALUES (
    v_so, v_company, v_codigo, nullif(btrim(coalesce(p ->> 'nome_cliente', '')), ''),
    (v_aviso ->> 'vencido')::numeric, (v_aviso ->> 'n_titulos')::int, v_dias,
    nullif(btrim(coalesce(p ->> 'parcela_habitual', '')), ''), v_sugerida, v_escolhida, v_cobre AND v_decisao = 'aceitou',
    v_decisao, v_motivo, nullif(btrim(coalesce(p ->> 'motivo_sistema', '')), ''), v_desfecho,
    v_pedido.total, v_uid
  )
  ON CONFLICT (sales_order_id, company) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    -- Retry do envio: devolve a decisão já registrada, sem 2º evento (idempotência pelo fato).
    SELECT d.id INTO v_id FROM public.venda_prazo_decisao d
     WHERE d.sales_order_id = v_so AND d.company = v_company;
    RETURN jsonb_build_object('id', v_id, 'criada', false);
  END IF;
  v_criada := true;

  -- Sensor no ledger, mesma transação do fato. Chave = id da decisão (estável entre contas e dias).
  -- Props fechadas, sem R$ exato nem nome de cliente (faixa do atraso, não o valor).
  INSERT INTO public.analytics_outbox (evento, distinct_id, user_id, props, chave_dedup)
  VALUES (
    'venda.prazo_sugerido',
    v_uid::text,
    v_uid,
    jsonb_build_object(
      'company', v_company,
      'decisao', v_decisao,
      'parcela_sugerida', v_sugerida,
      'parcela_escolhida', v_escolhida,
      'desfecho_envio', v_desfecho,
      'motivo_sistema', nullif(btrim(coalesce(p ->> 'motivo_sistema', '')), ''),
      'faixa_vencido', CASE WHEN v_dias IS NULL OR v_dias <= 0 THEN NULL
                            WHEN v_dias <= 15 THEN '<=15d'
                            WHEN v_dias <= 45 THEN '16-45d'
                            WHEN v_dias <= 90 THEN '46-90d'
                            ELSE '>90d' END
    ),
    'ledger:venda.prazo_sugerido:' || v_id::text
  )
  ON CONFLICT (chave_dedup) DO NOTHING;

  RETURN jsonb_build_object('id', v_id, 'criada', v_criada);
END;
$fn$;

REVOKE ALL ON FUNCTION public.venda_prazo_decisao_registrar(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.venda_prazo_decisao_registrar(jsonb) TO authenticated, service_role;

-- ------------------------------------------------------------
-- Postcondição: a migration que não pegou não termina em silêncio.
-- ------------------------------------------------------------
DO $post$
DECLARE
  v_aviso oid := to_regprocedure('public.venda_prazo_aviso(text,bigint)');
  v_reg   oid := to_regprocedure('public.venda_prazo_decisao_registrar(jsonb)');
BEGIN
  IF v_aviso IS NULL OR v_reg IS NULL THEN
    RAISE EXCEPTION 'P1 FALHOU: RPC ausente (aviso=%, registrar=%)', v_aviso, v_reg;
  END IF;
  IF NOT (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid = v_aviso)
     OR NOT (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid = v_reg) THEN
    RAISE EXCEPTION 'P2 FALHOU: RPC sem SECURITY DEFINER — a RLS de fin_contas_receber barraria a vendedora';
  END IF;
  IF has_function_privilege('anon', v_aviso, 'EXECUTE') OR has_function_privilege('anon', v_reg, 'EXECUTE')
     OR has_function_privilege('public', v_aviso, 'EXECUTE') OR has_function_privilege('public', v_reg, 'EXECUTE') THEN
    RAISE EXCEPTION 'P3 FALHOU: RPC executavel por anon/PUBLIC — fechar as DUAS pontas';
  END IF;
  IF NOT has_function_privilege('authenticated', v_aviso, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_reg, 'EXECUTE') THEN
    RAISE EXCEPTION 'P4 FALHOU: authenticated sem EXECUTE — a tela do pedido nao conseguiria avisar/registrar';
  END IF;
  IF to_regclass('public.venda_prazo_decisao') IS NULL
     OR NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.venda_prazo_decisao'::regclass) THEN
    RAISE EXCEPTION 'P5 FALHOU: venda_prazo_decisao ausente ou sem RLS';
  END IF;
  IF has_table_privilege('authenticated', 'public.venda_prazo_decisao', 'INSERT')
     OR has_table_privilege('authenticated', 'public.venda_prazo_decisao', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.venda_prazo_decisao', 'DELETE')
     OR has_table_privilege('anon', 'public.venda_prazo_decisao', 'SELECT') THEN
    RAISE EXCEPTION 'P6 FALHOU: venda_prazo_decisao com escrita para authenticated ou leitura para anon — 1 writer e a RPC';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_policies
       WHERE schemaname = 'public' AND tablename = 'venda_prazo_decisao'
         AND policyname IN ('venda_prazo_decisao_select', 'venda_prazo_decisao_service_all')) <> 2 THEN
    RAISE EXCEPTION 'P7 FALHOU: policies de venda_prazo_decisao incompletas';
  END IF;
  IF (SELECT convalidated FROM pg_catalog.pg_constraint WHERE conname = 'venda_prazo_decisao_unica') IS NOT TRUE THEN
    RAISE EXCEPTION 'P8 FALHOU: UNIQUE (sales_order_id, company) ausente ou nao validada — retry duplicaria decisao e evento';
  END IF;
  RAISE NOTICE 'venda_prazo_decisao: 2 RPCs SECDEF fechadas a anon/PUBLIC, tabela com RLS e 1 writer — OK';
END
$post$;
