-- ============================================================================================
-- 20261019090100 · cron `fin-dre-recalculo-diario` — DRE das 3 empresas recalculado todo dia às
-- 12:30 SP: competência dos 12 meses fechados + corrente, caixa do mês anterior + corrente  [money-path]
--
-- O QUE: um job que chama a edge `omie-financeiro` com `action='calcular_dre'` (a MESMA rota do botão
-- de /financeiro e do fechamento). Nenhuma função nova; o escritor de `fin_dre_snapshots` continua
-- sendo só a edge.
--
-- POR QUÊ (incidente): `fin_dre_snapshots` NUNCA teve escritor automático. O cron mensal foi escrito
-- só COMENTADO em 20260328200400_fix_cron_sync.sql (`fin-dre-mensal`) e nunca agendado; o DRE só se
-- recalculava por clique. Medido em prod (2026-10-18, psql-ro, fin_sync_log): o último `calcular_dre*`
-- da Oben foi 2026-05-30 (só caixa de abril) e o último de competência 2026-03-29 → Oben e Colacor SC
-- pararam em 2026-03; a Colacor só tem os meses porque sessões a recalcularam à mão em 13–14/10.
-- Consequência: o `fin-cashflow-engine` v1.5 (#3146) devolve PME `null` para a Oben ("CMV do DRE cobre
-- 6/12 meses fechados (último: 2026-03)") — docs/historico/ciclo-financeiro-cliente.md.
--
-- JANELAS (por regime, em chamadas SEPARADAS — uma falha no caixa não leva a competência junto):
--   · competência: 12 meses fechados + corrente, 1 chamada por (empresa, ano). Custa ~0,2 s/mês e é o
--     que o PME consome; recalcular 13 meses todo dia fecha sozinho o buraco de um cron que falhe por
--     semanas e pega título lançado com emissão retroativa.
--   · caixa: mês anterior + corrente, 1 chamada por (empresa, mês) — ~30 s/mês por empresa (fin_sync_log
--     de 14/10: 5 meses = 150 s). Meses mais velhos de caixa só por backfill deliberado.
-- O mês corrente sai parcial (movimento até hoje); `resultado_provisorio` NÃO marca isso — ele só
-- reflete pendência de fora_dre. Quem consome o mês corrente sabe que ele está aberto (o PME do
-- fin-cashflow-engine só usa meses FECHADOS).
--
-- MÊS COM FECHAMENTO: o job pula (empresa, mês) com QUALQUER versão de `fin_fechamentos` em status
-- ≠ 'aberto'. O fechamento guarda só a FK do snapshot, e o upsert da edge (onConflict
-- company,ano,mes,regime) reescreveria os números que ele referencia — inclusive os de uma versão
-- antiga quando o mês foi reaberto. Mês reaberto recalcula-se pelo botão, por decisão humana.
-- Resíduo conhecido: a checagem é no enqueue e a escrita é na edge, segundos depois; fechar o mês
-- nessa janela não é barrado. Hoje há 0 linhas em fin_fechamentos.
--
-- HORÁRIO: pg_cron em UTC; SP = UTC−3. 15:30 UTC = 12:30 SP, depois do 2º ciclo de sync do dia
-- (cp 14:00 · cr 14:20 · mov 14:40 UTC). O mês é o de SP.
--
-- TIMEOUT: `timeout_milliseconds` explícito (CLAUDE.md: o default de 5 s mata silencioso). A edge
-- termina mesmo se o pg_net desistir; a verdade da rodada é `fin_sync_log` (action `calcular_dre`).
--
-- APLICAR: bun run db:aplicar supabase/migrations/<este arquivo> — o executor fornece a transação.
-- Idempotente (cron.schedule com o mesmo nome ATUALIZA o job). Postcondição no fim.
-- ============================================================================================

SELECT cron.schedule(
  'fin-dre-recalculo-diario',
  '30 15 * * *',
  $cron$DO $inner$ DECLARE c text; y int; ms jsonb; d date; m0 timestamp := date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo')::date::timestamp); hdr jsonb := jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)); BEGIN FOREACH c IN ARRAY ARRAY['oben','colacor','colacor_sc'] LOOP FOR y, ms IN SELECT extract(year FROM g)::int, jsonb_agg(extract(month FROM g)::int ORDER BY g) FROM generate_series(m0 - interval '12 months', m0, interval '1 month') g WHERE NOT EXISTS (SELECT 1 FROM public.fin_fechamentos f WHERE f.company = c AND f.ano = extract(year FROM g)::int AND f.mes = extract(month FROM g)::int AND f.status <> 'aberto') GROUP BY 1 LOOP PERFORM net.http_post(url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro', headers:=hdr, body:=jsonb_build_object('action','calcular_dre','company',c,'ano',y,'meses',ms,'regime','competencia'), timeout_milliseconds:=150000); END LOOP; FOR d IN SELECT g::date FROM generate_series(m0 - interval '1 month', m0, interval '1 month') g WHERE NOT EXISTS (SELECT 1 FROM public.fin_fechamentos f WHERE f.company = c AND f.ano = extract(year FROM g)::int AND f.mes = extract(month FROM g)::int AND f.status <> 'aberto') LOOP PERFORM net.http_post(url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro', headers:=hdr, body:=jsonb_build_object('action','calcular_dre','company',c,'ano',extract(year FROM d)::int,'meses',jsonb_build_array(extract(month FROM d)::int),'regime','caixa'), timeout_milliseconds:=150000); END LOOP; END LOOP; END $inner$;$cron$
);

DO $post$
DECLARE
  v_n     integer;
  v_cmd   text;
  v_sched text;
  v_ativo boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' AND decrypted_secret IS NOT NULL) THEN
    RAISE EXCEPTION 'P0 FALHOU: CRON_SECRET ausente no vault — o job chamaria a edge sem credencial';
  END IF;
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'fin-dre-recalculo-diario';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'P1 FALHOU: % job(s) fin-dre-recalculo-diario — esperado exatamente 1', v_n;
  END IF;
  SELECT command, schedule, active INTO v_cmd, v_sched, v_ativo FROM cron.job WHERE jobname = 'fin-dre-recalculo-diario';
  IF v_sched <> '30 15 * * *' OR NOT v_ativo THEN
    RAISE EXCEPTION 'P2 FALHOU: job inativo ou horário inesperado: % (active=%)', v_sched, v_ativo;
  END IF;
  IF position('timeout_milliseconds:=150000' IN v_cmd) = 0
     OR position('''action'',''calcular_dre''' IN v_cmd) = 0
     OR position('''regime'',''competencia''' IN v_cmd) = 0
     OR position('''regime'',''caixa''' IN v_cmd) = 0
     OR position('''CRON_SECRET''' IN v_cmd) = 0
     OR position('f.status <> ''aberto''' IN v_cmd) = 0
     OR position('''oben'',''colacor'',''colacor_sc''' IN v_cmd) = 0 THEN
    RAISE EXCEPTION 'P3 FALHOU: comando do job sem timeout/ação/regimes/segredo do vault/guarda de fechamento/3 empresas';
  END IF;
  RAISE NOTICE 'fin-dre-recalculo-diario agendado (30 15 * * * UTC = 12:30 SP)';
END
$post$;
