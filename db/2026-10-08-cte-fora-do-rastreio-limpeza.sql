-- ╔══════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ CT-e fora do rastreio — limpeza das 137 linhas modelo 57 (decisão do founder, 2026-10-07)  ║
-- ║                                                                                          ║
-- ║ O QUE: apaga de `purchase_orders_tracking` as linhas cuja chave de acesso é de CT-e         ║
-- ║ (modelo 57 nas posições 21-22, parser estrito de 44 dígitos). O CASCADE das duas FKs leva   ║
-- ║ as 81 linhas de controle delas (`sku_items_sync_controle`) e NENHUMA de leadtime (o pré     ║
-- ║ exige 0). Os 13 vínculos de frete gravados nelas (`t3_data_cte`/`cte_chave_acesso`) saem   ║
-- ║ junto. Os 3 CT-e que nunca chegaram a uma NF-e NÃO são re-casados (decisão do founder).     ║
-- ║                                                                                          ║
-- ║ POR QUE PODE: a fonte parou de gravar CT-e (`omie-sync-nfes-recebidas` v1.4, no ar desde    ║
-- ║ 20:37Z de 06/10, #2821) e nenhum leitor do produto depende delas (medido 2026-10-07):       ║
-- ║ o motor parte do histórico de leadtime, onde CT-e não tem linha; `reposicao_pos_candidatos` ║
-- ║ casa o PO pelo código, e as 137 usam código NEGATIVO (0 colisões); `_data_health_compute`   ║
-- ║ só cita a tabela em comentário; as 3 views que as contam não têm leitor. Sem trigger de     ║
-- ║ DELETE nem rule na tabela; só as duas FKs (ambas CASCADE) apontam para ela.               ║
-- ║                                                                                          ║
-- ║ BACKUP: ~/.config/afiacao/backups/2026-10-08-cte-rastreio/ (\copy por psql-ro às 00:45Z:   ║
-- ║ 137 + 81 registros, md5 dos IDs conferido contra o banco).                                 ║
-- ║                                                                                          ║
-- ║ RÉGUA (Caminho B — Codex em 100% até 09/10 22:30Z, revisor adversarial independente):     ║
-- ║  1. o conjunto é TRAVADO (FOR UPDATE) e tem de ser o do pré-voo: 137 + md5 dos IDs;        ║
-- ║  2. o CASCADE não alcança leadtime: 0 linhas de histórico em CT-e, exigido ANTES;          ║
-- ║  3. nenhuma linha não-57 some: os IDs capturados antes existem TODOS depois;               ║
-- ║  4. o histórico de leadtime não encolhe (concorrência só soma);                            ║
-- ║  5. pós: 137 apagadas com o MESMO md5 (RETURNING), 0 linhas 57, 0 controle das 137.        ║
-- ║ Reaplicar: o pré aborta (n=0) sem efeito, e o `db:aplicar` recusa o mesmo sha (exit 3).    ║
-- ║ Narrativa: docs/historico/cte-fora-do-rastreio.md §7 e sku-items-cte-fora-da-fila.md §7.   ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════╝

-- A transacao e do `db:aplicar` (o corpo roda dentro dela, via EXECUTE): este arquivo NAO
-- leva BEGIN;/COMMIT;. As mensagens de RAISE sao ASCII com rotulo fixo na frente.

DO $limpeza$
DECLARE
  c_n_esperado   constant int  := 137;
  c_md5_esperado constant text := '2268839510f5de40d0ae27ba64ae02e8';
  c_ctl_esperado constant int  := 81;
  v_ids      uuid[];
  v_n        int;
  v_md5      text;
  v_hist57   int;
  v_ctl57    int;
  v_outras   uuid[];
  v_hist_ant bigint;
  v_del      int;
  v_md5_del  text;
  v_resta    int;
  v_sumiram  int;
  v_ctl_resta int;
  v_hist_dep bigint;
BEGIN
  -- PRE 1: TRAVA (FOR UPDATE) e captura o conjunto; ele tem de ser EXATAMENTE o do pre-voo.
  -- O lock tambem barra filho novo nessas linhas (a FK pega FOR KEY SHARE no pai).
  SELECT array_agg(s.id ORDER BY s.id) INTO v_ids
  FROM (SELECT id FROM public.purchase_orders_tracking
        WHERE nfe_chave_acesso ~ '^[0-9]{44}$' AND substr(nfe_chave_acesso, 21, 2) = '57'
        ORDER BY id FOR UPDATE) s;
  v_n   := coalesce(array_length(v_ids, 1), 0);
  v_md5 := md5(array_to_string(v_ids, ','));
  IF v_n IS DISTINCT FROM c_n_esperado OR v_md5 IS DISTINCT FROM c_md5_esperado THEN
    RAISE EXCEPTION 'PRE_CONJUNTO: linhas 57 mudaram desde o pre-voo (n=%, md5=%) - nada apagado',
      v_n, v_md5;
  END IF;

  -- PRE 2: o CASCADE de sku_leadtime_history nao pode alcancar historico.
  SELECT count(*) INTO v_hist57 FROM public.sku_leadtime_history WHERE tracking_id = ANY(v_ids);
  IF v_hist57 <> 0 THEN
    RAISE EXCEPTION 'PRE_HISTORICO: % linhas de leadtime em CT-e - o CASCADE apagaria historico',
      v_hist57;
  END IF;

  -- PRE 3: o controle que o CASCADE leva e o medido no pre-voo (lido DEPOIS do lock).
  SELECT count(*) INTO v_ctl57 FROM public.sku_items_sync_controle WHERE tracking_id = ANY(v_ids);
  IF v_ctl57 <> c_ctl_esperado THEN
    RAISE EXCEPTION 'PRE_CONTROLE: % linhas de controle em CT-e, esperado %',
      v_ctl57, c_ctl_esperado;
  END IF;

  -- Testemunhas do que NAO pode mudar: as linhas nao-57 e o tamanho do historico.
  SELECT array_agg(id) INTO v_outras
  FROM public.purchase_orders_tracking
  WHERE NOT (coalesce(nfe_chave_acesso, '') ~ '^[0-9]{44}$'
             AND substr(nfe_chave_acesso, 21, 2) = '57');
  IF coalesce(array_length(v_outras, 1), 0) = 0 THEN
    RAISE EXCEPTION 'PRE_TESTEMUNHA: captura vazia das linhas nao-57 - a POS_OUTRAS ficaria cega';
  END IF;
  SELECT count(*) INTO v_hist_ant FROM public.sku_leadtime_history;

  -- O DELETE e por ID travado E pelo predicado; a IDENTIDADE do que saiu vem do RETURNING.
  WITH d AS (
    DELETE FROM public.purchase_orders_tracking
    WHERE id = ANY(v_ids)
      AND empresa = 'OBEN'
      AND nfe_chave_acesso ~ '^[0-9]{44}$' AND substr(nfe_chave_acesso, 21, 2) = '57'
    RETURNING id
  )
  SELECT count(*), md5(string_agg(id::text, ',' ORDER BY id)) INTO v_del, v_md5_del FROM d;

  -- POS 1: apagou exatamente o conjunto do pre-voo (contagem E identidade).
  IF v_del <> c_n_esperado OR v_md5_del IS DISTINCT FROM c_md5_esperado THEN
    RAISE EXCEPTION 'POS_APAGADAS: % linhas apagadas (md5=%), esperado % (md5=%)',
      v_del, v_md5_del, c_n_esperado, c_md5_esperado;
  END IF;

  -- POS 2: nao resta linha 57 no rastreio.
  SELECT count(*) INTO v_resta
  FROM public.purchase_orders_tracking
  WHERE nfe_chave_acesso ~ '^[0-9]{44}$' AND substr(nfe_chave_acesso, 21, 2) = '57';
  IF v_resta <> 0 THEN
    RAISE EXCEPTION 'POS_RESTAM: % linhas 57 ainda no rastreio', v_resta;
  END IF;

  -- POS 3: nenhuma linha nao-57 sumiu.
  SELECT count(*) INTO v_sumiram
  FROM unnest(v_outras) AS o(id)
  WHERE NOT EXISTS (SELECT 1 FROM public.purchase_orders_tracking t WHERE t.id = o.id);
  IF v_sumiram <> 0 THEN
    RAISE EXCEPTION 'POS_OUTRAS: % linhas nao-57 sumiram', v_sumiram;
  END IF;

  -- POS 4: o CASCADE levou o controle das 137 (nada delas restou).
  SELECT count(*) INTO v_ctl_resta FROM public.sku_items_sync_controle WHERE tracking_id = ANY(v_ids);
  IF v_ctl_resta <> 0 THEN
    RAISE EXCEPTION 'POS_CONTROLE: % linhas de controle das CT-e restaram', v_ctl_resta;
  END IF;

  -- POS 5: o historico de leadtime nao encolheu.
  SELECT count(*) INTO v_hist_dep FROM public.sku_leadtime_history;
  IF v_hist_dep < v_hist_ant THEN
    RAISE EXCEPTION 'POS_HISTORICO: o leadtime encolheu (% -> %)', v_hist_ant, v_hist_dep;
  END IF;
END
$limpeza$;

SELECT 'FIM_APLICACAO_OK';
