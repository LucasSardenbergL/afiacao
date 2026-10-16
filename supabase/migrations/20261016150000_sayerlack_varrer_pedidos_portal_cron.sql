-- ============================================================================================
-- 20261016150000 · varredura do portal Sayerlack → PO no Omie (cron 12:30 · 17:30 · 22:30 SP)  [money-path]
--
-- O QUE: (1) tabela `sayerlack_varredura_falha` — 1 linha por protocolo do portal que a varredura achou e NÃO
-- conseguiu importar (sem de-para, NCM sem alíquota, total que não bate…), com `notificado_em` para o e-mail sair
-- UMA vez por protocolo; (2) job `sayerlack-varrer-pedidos-portal` chamando a edge de mesmo nome em modo "importar".
--
-- POR QUÊ: palavra do founder (2026-10-16) — "caso algum pedido esteja lançado no portal da Sayerlack e não exista
-- no Omie, ele seja lançado no Omie", às 12:30, 17:30 e 22:30. A importação é a MESMA do botão (edge
-- `sayerlack-importar-pedido-portal` → RPC `sayerlack_importar_pedido_portal`, tudo-ou-nada, idempotente por
-- protocolo, IP006 contra PO já no Omie). Nenhuma função nova aqui: a tabela tem 1 escritor (a edge, service_role).
--
-- HORÁRIO: o pg_cron roda em UTC; SP é UTC−3 (sem horário de verão desde 2019): 15:30 / 20:30 / 01:30 UTC.
-- Sábado 12:30 e os horários de domingo caem na janela do portal fechado (sáb 12h → seg 6h): a edge pula sem abrir
-- o navegador.
--
-- TIMEOUT: `timeout_milliseconds` explícito (CLAUDE.md: o default de 5 s mata silencioso). 150 s é o teto do
-- pg_net usado pelos jobs do portal; a edge pode passar disso (leitura + importações) e TERMINA assim mesmo — a
-- verdade da rodada é o registro server-side em `acoes_execucoes` (acao `reposicao.varrer_portal_sayerlack`), não
-- o `net._http_response`.
--
-- LISTA FECHADA: a edge só importa situação do portal cujo código esteja em `SITUACOES_IMPORTAVEIS` (varredura.ts),
-- VAZIA na partida — as primeiras rodadas só relatam (inclusive as situações reais do select) até o founder decidir.
--
-- APLICAR: bun run db:aplicar supabase/migrations/<este arquivo> — o executor fornece a transação.
-- Idempotente (IF NOT EXISTS; cron.schedule com o mesmo nome ATUALIZA o job). Postcondição no fim.
-- ============================================================================================

CREATE TABLE IF NOT EXISTS public.sayerlack_varredura_falha (
  protocolo     text PRIMARY KEY CHECK (protocolo ~ '^[0-9]{3,12}$'),
  mensagem      text NOT NULL,
  primeira_em   timestamptz NOT NULL DEFAULT now(),
  ultima_em     timestamptz NOT NULL DEFAULT now(),
  tentativas    integer NOT NULL DEFAULT 1 CHECK (tentativas >= 1),
  notificado_em timestamptz,
  resolvido_em  timestamptz
);

COMMENT ON TABLE public.sayerlack_varredura_falha IS
  'Pedidos do portal Sayerlack que a varredura (edge sayerlack-varrer-pedidos-portal) não conseguiu importar. 1 escritor: a edge (service_role). notificado_em = e-mail já enviado (1 vez por protocolo).';

ALTER TABLE public.sayerlack_varredura_falha ENABLE ROW LEVEL SECURITY;
-- Sem policy: só o service_role (que ignora RLS) lê e escreve. Fecha também o GRANT padrão do Supabase.
REVOKE ALL ON TABLE public.sayerlack_varredura_falha FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.sayerlack_varredura_falha TO service_role;

SELECT cron.schedule(
  'sayerlack-varrer-pedidos-portal',
  '30 1,15,20 * * *',
  $cron$SELECT net.http_post(url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/sayerlack-varrer-pedidos-portal', headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)), body:=jsonb_build_object('modo','importar'), timeout_milliseconds:=150000);$cron$
);

DO $post$
DECLARE
  v_n     integer;
  v_cmd   text;
  v_sched text;
  v_ativo boolean;
BEGIN
  IF to_regclass('public.sayerlack_varredura_falha') IS NULL THEN
    RAISE EXCEPTION 'P1 FALHOU: tabela sayerlack_varredura_falha ausente';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sayerlack_varredura_falha'::regclass) THEN
    RAISE EXCEPTION 'P2 FALHOU: RLS desligada em sayerlack_varredura_falha';
  END IF;
  IF has_table_privilege('anon', 'public.sayerlack_varredura_falha', 'SELECT')
     OR has_table_privilege('authenticated', 'public.sayerlack_varredura_falha', 'SELECT') THEN
    RAISE EXCEPTION 'P3 FALHOU: anon/authenticated ainda leem sayerlack_varredura_falha';
  END IF;
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'sayerlack-varrer-pedidos-portal';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'P4 FALHOU: % job(s) sayerlack-varrer-pedidos-portal — esperado exatamente 1', v_n;
  END IF;
  SELECT command, schedule, active INTO v_cmd, v_sched, v_ativo FROM cron.job WHERE jobname = 'sayerlack-varrer-pedidos-portal';
  IF v_sched <> '30 1,15,20 * * *' THEN
    RAISE EXCEPTION 'P5 FALHOU: horário do job inesperado: %', v_sched;
  END IF;
  IF position('timeout_milliseconds:=150000' IN v_cmd) = 0 OR position('''modo'',''importar''' IN v_cmd) = 0
     OR position('/functions/v1/sayerlack-varrer-pedidos-portal''' IN v_cmd) = 0 THEN
    RAISE EXCEPTION 'P6 FALHOU: comando do job sem timeout explícito, modo ou URL esperados: %', v_cmd;
  END IF;
  IF NOT v_ativo THEN
    RAISE EXCEPTION 'P7 FALHOU: job inativo';
  END IF;
  RAISE NOTICE 'sayerlack-varrer-pedidos-portal: tabela com RLS fechada + 1 job ativo (30 1,15,20 * * * UTC = 22:30/12:30/17:30 SP)';
END
$post$;
