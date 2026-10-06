-- ╔════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ Exclusão nominal e auditável no conversor do total líquido — o "caminho 3".            ║
-- ║                                                                                        ║
-- ║ PROBLEMA: 105 pedidos têm linha com `desconto_valor` NULL que o Omie não correlaciona  ║
-- ║ (piso da conciliação, medido pelo backfill de 2026-09-18/20: 98,4% das 13.006 linhas). ║
-- ║ O gate de mês completo — que está CERTO e não é afrouxado aqui — mantém 13 dos 14      ║
-- ║ meses fechados por causa deles, prendendo 564 pedidos e R$ 104.250,58 de desconto que   ║
-- ║ a tela não explica. Em 2025-12 são 45 convertíveis presos por UM bloqueador.           ║
-- ║                                                                                        ║
-- ║ ESTE ARQUIVO NÃO CONVERTE NADA. Ele instala a exceção e PROVA, por ensaio dentro da     ║
-- ║ própria transação, que a conversão passaria a ter alvo. A conversão é um apply à parte. ║
-- ║                                                                                        ║
-- ║ POR QUE TABELA E NÃO PARÂMETRO NOVO: a identidade de uma função inclui os tipos dos    ║
-- ║ argumentos, então `CREATE OR REPLACE` com um `p_ids_excluidos uuid[]` a mais criaria    ║
-- ║ um OVERLOAD em vez de substituir, e desfazer isso exigiria `DROP FUNCTION` + `CREATE`,  ║
-- ║ que RESETA o ACL (o `REPLACE` preserva) de uma função de money-path cujo ACL hoje é     ║
-- ║ nominal: {postgres, service_role, sandbox_exec_*}, sem PUBLIC. A tabela não toca a      ║
-- ║ assinatura, então o replace continua sendo um REPLACE puro.                            ║
-- ║                                                                                        ║
-- ║ O CORPO DA FUNÇÃO ABAIXO É O DA PRODUÇÃO (pg_get_functiondef de 2026-10-05) com duas    ║
-- ║ edições ancoradas, não reescrito à mão — apply manual diverge do repo, e a última a     ║
-- ║ recriar vence.                                                                         ║
-- ╚════════════════════════════════════════════════════════════════════════════════════════╝

BEGIN;

-- ─── 1. A tabela ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pedido_total_liquido_excecao (
  sales_order_id uuid PRIMARY KEY REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  motivo         text        NOT NULL CHECK (motivo IN ('sem_apuracao', 'apuracao_parcial')),
  evidencia      text        NOT NULL CHECK (length(btrim(evidencia)) > 0),
  criado_em      timestamptz NOT NULL DEFAULT now(),
  criado_por     text        NOT NULL CHECK (length(btrim(criado_por)) > 0),
  -- Exceção sem data de revisão é alarme silenciado: se o Omie passar a correlacionar o trio, a
  -- linha aqui vira lixo que esconde a regressão seguinte. O sensor cobra por esta coluna.
  revisar_em     date        NOT NULL
);

COMMENT ON TABLE public.pedido_total_liquido_excecao IS
  'Pedidos que o conversor do total liquido ignora NOMINALMENTE: nao contam no gate de mes completo '
  'e nunca sao convertidos. Fail-closed por omissao — pedido nao apurado e nao listado segue '
  'bloqueando o mes. Ver docs/historico/backfill-desconto-a-porta-fora-do-envelope.md';
COMMENT ON COLUMN public.pedido_total_liquido_excecao.motivo IS
  'Forma medida LOCALMENTE e verificavel: sem_apuracao = nenhuma linha do pedido tem '
  'desconto_valor; apuracao_parcial = tem linha apurada e linha NULL no mesmo pedido. O motivo do '
  'lado do Omie (sem_correspondencia/ambiguo) exige um dry-run do backfill e e enriquecimento, '
  'nao pre-requisito.';

ALTER TABLE public.pedido_total_liquido_excecao ENABLE ROW LEVEL SECURITY;
-- Sem policy: `authenticated`/`anon` não têm GRANT e não chegam. A função é SECURITY INVOKER, e
-- quem a chama é `postgres` (dono, não sujeito a RLS sem FORCE) ou `service_role` (bypassa RLS).
GRANT SELECT ON public.pedido_total_liquido_excecao TO service_role;

-- ─── 2. A lista, derivada por query determinística (não colada) ─────────────────────────────
-- A GUARDA DE 48h É A LIÇÃO DE 2026-10-05 VIRADA EM CÓDIGO: o `sync-reprocess` reescreve os itens
-- do pedido, e entre a reescrita e a reconciliação existe uma janela em que a linha está NULL. Sem
-- este filtro, um pedido EM VOO entraria na exceção por engano e perderia a conversão para sempre,
-- em silêncio. Hoje a guarda custa zero (105 bloqueadores, 105 parados, 0 em voo) — e é exatamente
-- por isso que ela precisa estar aqui antes de custar algo.
INSERT INTO public.pedido_total_liquido_excecao
       (sales_order_id, motivo, evidencia, criado_por, revisar_em)
SELECT p.id,
       CASE WHEN p.apuradas = 0 THEN 'sem_apuracao' ELSE 'apuracao_parcial' END,
       format('backfill de 2026-09-18/20 nas duas contas apurou 98,4%% de 13.006 linhas; '
              'esta linha segue NULL e o pedido esta parado desde %s', p.updated_at::date),
       'claude:acervo-2026-10-05',
       (current_date + interval '90 days')::date
  FROM (SELECT so.id,
               so.updated_at,
               count(*) FILTER (WHERE oi.desconto_valor IS NOT NULL) AS apuradas,
               bool_or(oi.desconto_valor IS NULL)                     AS bloqueador
          FROM public.sales_orders so
          JOIN public.order_items  oi ON oi.sales_order_id = so.id
         WHERE so.order_date_kpi >= '2025-09-18'
         GROUP BY so.id, so.updated_at) p
 WHERE p.bloqueador
   AND p.updated_at < now() - interval '48 hours'
ON CONFLICT (sales_order_id) DO NOTHING;

-- ─── 3. O conversor, por SUBSTITUIÇÃO PROGRAMÁTICA ──────────────────────────────────────────
-- NÃO se cola aqui o corpo de 246 linhas. Migration/apply é imutável depois de commitado, então um
-- corpo copiado vira uma bomba de relógio: se outra sessão endurecer o conversor amanhã, re-rodar
-- este arquivo REVERTE o endurecimento em silêncio — "a última a recriar vence". O padrão do repo é
-- ler o corpo VIVO, trocar só as âncoras e reexecutar; quem não tem a âncora, aborta.
DO $patch$
DECLARE
  v_fn  text := 'public.pedido_total_liquido_converter(boolean,timestamptz,text[],date,date,integer,boolean)';
  v_def text;
  v_novo text;
  v_a1v text := $a1v$    'exigir_mes_completo', p_exigir_mes_completo
  );$a1v$;
  v_a1n text := $a1n$    'exigir_mes_completo', p_exigir_mes_completo,
    'excecoes_ativas',     (SELECT count(*) FROM public.pedido_total_liquido_excecao)
  );$a1n$;
  v_a2v text := $a2v$  WITH c AS MATERIALIZED (
    SELECT * FROM public.pedido_total_liquido_classificar(p_corte, NULL)
  ),$a2v$;
  v_a2n text := $a2n$  WITH c AS MATERIALIZED (
    -- Exclusao NOMINAL: o pedido listado em `pedido_total_liquido_excecao` sai do universo ANTES de
    -- tudo, e isso lhe da as duas propriedades de uma vez — nao conta no `n_nao_apurado` que bloqueia
    -- o mes, e nunca entra em `elegivel`, porque sua classe nunca foi 'convertivel'. A exclusao deixa
    -- de CONSERTAR o pedido; nao lhe fabrica desconto (`ausente != zero`): ele segue com cabecalho
    -- bruto na tela, visivel e nao mentido.
    SELECT z.*
      FROM public.pedido_total_liquido_classificar(p_corte, NULL) z
     WHERE NOT EXISTS (SELECT 1
                         FROM public.pedido_total_liquido_excecao x
                        WHERE x.sales_order_id = z.sales_order_id)
  ),$a2n$;
BEGIN
  -- `to_regprocedure` resolve por TIPOS e devolve NULL em vez de erro: o cast cru derrubaria o
  -- apply inteiro com a mensagem errada.
  IF to_regprocedure(v_fn) IS NULL THEN
    RAISE EXCEPTION 'patch: % nao existe nesta base', v_fn;
  END IF;
  v_def := pg_get_functiondef(to_regprocedure(v_fn));

  IF position('pedido_total_liquido_excecao' IN v_def) > 0 THEN
    RAISE NOTICE 'patch: o conversor JA le a tabela de excecao — idempotente, nada a trocar';
    RETURN;
  END IF;

  IF (length(v_def) - length(replace(v_def, v_a1v, ''))) / length(v_a1v) <> 1 THEN
    RAISE EXCEPTION 'patch: a ancora 1 (v_escopo) nao aparece EXATAMENTE 1x no corpo vivo — o '
                    'conversor mudou e esta troca precisa ser revista a mao';
  END IF;
  IF (length(v_def) - length(replace(v_def, v_a2v, ''))) / length(v_a2v) <> 1 THEN
    RAISE EXCEPTION 'patch: a ancora 2 (CTE c) nao aparece EXATAMENTE 1x no corpo vivo — o '
                    'conversor mudou e esta troca precisa ser revista a mao';
  END IF;

  v_novo := replace(replace(v_def, v_a1v, v_a1n), v_a2v, v_a2n);
  IF v_novo = v_def THEN
    RAISE EXCEPTION 'patch: a substituicao nao mudou nada — nao reexecuto corpo identico';
  END IF;

  -- CREATE OR REPLACE (nunca DROP): preserva o ACL nominal {postgres, service_role, sandbox_exec_*}.
  EXECUTE v_novo;
END
$patch$;

-- ─── 4. Postcondições — e um CONTROLE que prova a CAUSA, não só o efeito ─────────────────────
DO $post$
DECLARE
  v_corte     timestamptz := '2026-09-14 20:09:13+00';
  v_de        date        := '2025-09-01';
  v_ate       date        := '2026-10-01';
  v_n         int;
  v_rls       boolean;
  v_controle  int;
  v_ensaio    jsonb;
  v_elegiveis int;
  v_excecoes  int;
BEGIN
  -- (a) RLS ligada. Tabela nova sem RLS é a falha que o CI não vê.
  SELECT c.relrowsecurity INTO v_rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'pedido_total_liquido_excecao';
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'postcondicao (a): RLS nao esta ligada em pedido_total_liquido_excecao';
  END IF;

  -- (b) Lista vazia não é sucesso: nada a excluir significa nada a destravar.
  SELECT count(*) INTO v_n FROM public.pedido_total_liquido_excecao;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'postcondicao (b): a lista nasceu VAZIA — a query determinista nao achou '
                    'bloqueador nenhum, o que contradiz a medicao de 105';
  END IF;

  -- (c) INVARIANTE da lista, não contagem congelada (que gritaria a cada pedido novo): todo
  --     excluido tem linha NULL e esta PARADO. Pedido em voo nunca entra.
  SELECT count(*) INTO v_n
    FROM public.pedido_total_liquido_excecao x
   WHERE NOT EXISTS (SELECT 1 FROM public.order_items oi
                      WHERE oi.sales_order_id = x.sales_order_id AND oi.desconto_valor IS NULL)
      OR EXISTS     (SELECT 1 FROM public.sales_orders so
                      WHERE so.id = x.sales_order_id
                        AND so.updated_at >= now() - interval '48 hours');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'postcondicao (c): % excecao(oes) sem linha NULL ou com pedido tocado nas '
                    'ultimas 48h — pedido EM VOO nao entra na lista', v_n;
  END IF;

  -- (d) A postcondição de OURO: nenhum excluido era convertivel. Se fosse, a exclusao descartaria
  --     um conserto POSSIVEL — conservador, mas silencioso, e portanto inaceitavel.
  SELECT count(*) INTO v_n
    FROM public.pedido_total_liquido_classificar(
           v_corte,
           (SELECT array_agg(x.sales_order_id) FROM public.pedido_total_liquido_excecao x)) k
   WHERE k.classe = 'convertivel';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'postcondicao (d): % pedido(s) da lista sao CONVERTIVEIS — a lista esta errada '
                    'e estaria jogando fora conserto possivel', v_n;
  END IF;

  -- (e) CONTROLE na MESMA transação: com a lista VAZIA o ensaio tem de dar ZERO. Sem este ramo, um
  --     "> 0" aprovaria um mundo em que a conversao ja funcionava e a exclusao nao fez nada —
  --     postcondicao sempre-verde aprova tudo. O sub-bloco PL/pgSQL e uma subtransacao: o DELETE
  --     volta atras no RAISE, e a variavel sobrevive porque variavel nao e transacional.
  BEGIN
    DELETE FROM public.pedido_total_liquido_excecao;
    SELECT (public.pedido_total_liquido_converter(false, v_corte, NULL, v_de, v_ate)->>'elegiveis')::int
      INTO v_controle;
    RAISE EXCEPTION 'desfazer-controle' USING ERRCODE = '22023';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;
  IF v_controle IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'postcondicao (e): o CONTROLE sem excecao devolveu % elegiveis, esperado 0 — a '
                    'conversao nao estava bloqueada pelo que este apply diz destravar', v_controle;
  END IF;

  -- (f) Com a exceção de pé: o ensaio tem alvo, e `excecoes_ativas` chega ao relatório.
  v_ensaio    := public.pedido_total_liquido_converter(false, v_corte, NULL, v_de, v_ate);
  v_elegiveis := (v_ensaio->>'elegiveis')::int;
  v_excecoes  := (v_ensaio->'escopo'->>'excecoes_ativas')::int;
  SELECT count(*) INTO v_n FROM public.pedido_total_liquido_excecao;

  IF v_excecoes IS DISTINCT FROM v_n THEN
    RAISE EXCEPTION 'postcondicao (f): o relatorio diz % excecoes e a tabela tem % — o conversor '
                    'novo nao esta lendo a tabela', v_excecoes, v_n;
  END IF;
  IF v_elegiveis <= 0 THEN
    RAISE EXCEPTION 'postcondicao (f): com % excecoes o ensaio segue com 0 elegiveis — a exclusao '
                    'nao destravou nada', v_n;
  END IF;

  RAISE NOTICE 'EXCECAO INSTALADA: % pedidos excluidos | controle sem excecao = 0 elegiveis | '
               'com excecao = % elegiveis | soma prevista = %',
               v_n, v_elegiveis, v_ensaio->>'soma_mudanca_prevista';
END
$post$;

SELECT 'FIM_APLICACAO_OK' AS marcador;

COMMIT;
