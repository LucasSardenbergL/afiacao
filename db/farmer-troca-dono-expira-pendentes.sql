-- ============================================================================
-- Farmer — a oferta pendente NÃO sobrevive à troca de dono do cliente
--
-- POR QUE. O gate FG009 (#1850) fechou "gravar sob quem não é dono". Falta o outro sentido
-- do mesmo eixo: o cliente que troca de dono DEPOIS de a oferta ser gravada. A pendente
-- fica sob o dono ANTIGO, e o UPDATE de expiração das RPCs filtra
-- `WHERE farmer_id = p_farmer_id` — então o recálculo do dono NOVO não a alcança. Ela só
-- morre no próximo recálculo do dono ANTIGO: uma janela que dura o quanto ele demorar (no
-- lote de abril/2026 do #1850, meses).
--
-- MEDIÇÃO ANTES (psql-ro, 2026-08-21), COM denominador:
--   · farmer_recommendations:        0 pendentes fora de escopo / 1.083 pendentes
--   · farmer_bundle_recommendations: 0 pendentes fora de escopo /     1 pendente
--   · pendentes de cliente SEM linha de score (cego ao INNER JOIN da baseline): 0 nas duas
--   Logo: esta entrega é PREVENTIVA. Não há dano a sanear hoje — o saneamento da §6 é
--   NO-OP nesta data, e está aqui por ser a única forma de alcançar uma órfã anterior à
--   trigger, não porque achou sujeira. O buraco é real (o #1850 mediu 2.676 linhas pelo
--   OUTRO caminho do mesmo eixo); o que o fecha é o mecanismo, não a limpeza.
--
-- ONDE A CORREÇÃO MORA — e por que NÃO é onde a tarefa supunha.
-- A tarefa foi escrita supondo que a origem da reatribuição é a edge `calculate-scores`,
-- pelo `upsert(onConflict:'customer_user_id')` em `farmer_client_scores`. MEDIDO: esse
-- upsert só roda sobre a lista `missing` — os clientes AUSENTES de `farmer_client_scores`.
-- Cliente já existente nunca passa por ali. E `apply_score_updates` não toca `farmer_id`
-- (`pg_get_functiondef(...) ~* 'farmer_id\s*='` devolve false em prod).
-- Quem reatribui o dono de um cliente EXISTENTE é uma trigger:
--     trg_carteira_reconcile_score_owner  AFTER INSERT OR UPDATE OF owner_user_id
--       ON carteira_assignments  ->  reconcile_score_owner_from_carteira()
-- alimentada pela edge `carteira-rebuild` (upsert em `carteira_assignments`).
-- Corrigir em `calculate-scores` seria INERTE — e pior que inerte: pareceria feito.
--
-- Por isso o guard entra na FRONTEIRA `farmer_client_scores`, a MESMA tabela que o gate
-- FG009 consulta para decidir o dono — gate e invariante passam a olhar a mesma fonte:
--   (a) cobre TODOS os caminhos de escrita (trigger de carteira, upsert da edge, backfill
--       colado no SQL Editor, correção ad-hoc) em vez de N escritores;
--   (b) roda na MESMA transação da reatribuição: sem janela;
--   (c) não abre superfície nova. Trocar `farmer_id` já exige `cap_carteira_escrever` — o
--       WITH CHECK de `fcs_update_own_or_gestor` é
--       `cap_carteira_escrever(auth.uid()) OR farmer_id = auth.uid()`, e um farmer comum
--       não grava a linha com o farmer_id de OUTRO. NENHUMA policy muda aqui. É a
--       diferença que fez o challenge Codex do #1850 recusar a alternativa (ampliar a
--       policy de UPDATE de farmer_recommendations para "sou o dono atual"): aquilo
--       autorizaria LINHAS a mais via PostgREST, contornando RPC, CAS e auditoria.
--
-- CHALLENGE CODEX DESTA FATIA (gpt-5.6-terra, xhigh) — o que mudou por causa dele:
--
--  · ACEITO E IMPLEMENTADO (§7): "a trigger sozinha não garante a invariante sob
--    concorrência". Se a RPC do farmer A já passou pelo FG009 quando a troca comita, a
--    oferta nova nasce DEPOIS da varredura da trigger e sobrevive fora de escopo. O
--    advisory lock do passo 4 das RPCs é por FARMER, e quem reatribui não o toma. Fechado
--    com `FOR SHARE` nas linhas de score do lote, antes do gate — detalhe no bloco 6-ter.
--    Sem esta parte a correção "melhora o caso medido mas não prova a invariante".
--
--  · CORREÇÃO FACTUAL AO PARECER: ele afirma que `NEW` "não existe" em trigger DELETE e
--    que referenciar `NEW.farmer_id` ali "dá erro em runtime". MEDIDO em PG17 (spike
--    executável): `NEW.campo` num AFTER DELETE devolve NULL e NÃO estoura. O código usa
--    `TG_OP` mesmo assim — que é o que o parecer recomenda, por outro motivo: depender de
--    um detalhe não-documentado é apostar, e a aposta valeria "expira tudo" contra "não
--    expira nada".
--
--  · REGISTRADO, NÃO IMPLEMENTADO: `fcs_delete_own_or_gestor` deixa o farmer apagar o
--    próprio score, e com esta trigger isso vira autoridade INDIRETA de expirar as
--    pendentes daquele cliente. É autoridade por EFEITO, não caminho para ofertar sob
--    outro farmer. Restringir aquela policy é mexer em RLS — exatamente o que foi recusado
--    no #1850 — e é outra fatia. Fica dito, não mudado às escondidas.
--
--  · REGISTRADO, NÃO IMPLEMENTADO: `CREATE INDEX CONCURRENTLY` (não roda dentro de bloco
--    transacional, e o SQL Editor do Lovable executa o Run inteiro como um; as tabelas têm
--    17.316 e 13 linhas, lock curto) e trigger `FOR EACH STATEMENT` com transition tables
--    (otimização real se um rebuild mover milhares numa transação — mas transition tables
--    não combinam com `UPDATE OF coluna` nem com eventos múltiplos, então custaria o
--    `WHEN` que hoje evita o disparo em no-op).
--
-- DECISÃO EXPLÍCITA que o parecer pediu: a pendente PREEXISTENTE do dono NOVO sobrevive.
-- A regra implementada é a fraca — "toda pendente é do dono atual" —, não a forte — "toda
-- troca invalida toda oferta anterior". Motivo: precisão > recall. Expirar oferta do dono
-- ATUAL destrói trabalho válido, e ela é alcançável pelo recálculo dele (a RPC expira
-- todas as pendentes do próprio farmer). A do dono ANTIGO é que não tinha quem a
-- alcançasse — é esse o buraco, e só ele.
--
-- FATOS DE PG17 MEDIDOS ANTES DE ESCREVER (spike executável, não suposição):
--   · `WHEN (OLD.x IS DISTINCT FROM NEW.x)` numa trigger UPDATE **OR DELETE** combinada é
--     RECUSADA na criação: "DELETE trigger's WHEN condition cannot reference NEW values".
--     Por isso são DUAS triggers com UMA função. (A sintaxe combinada SEM `WHEN` é válida.)
--   · `UPDATE OF col` dispara mesmo quando o valor NÃO muda — basta a coluna estar no SET.
--     Sem o `WHEN`, todo re-upsert de carteira varreria as pendentes de cada cliente à toa.
--     Medido: com `WHEN`, 0 disparos no no-op e 1 na troca real.
--
-- ERRCODE: nenhum novo. A trigger não RAISE — ela expira. Conferido mesmo assim (barato de
-- conferir, caro de errar): FG001–FG009 e FG101–FG107 ocupados em prod; FG010 seguiria
-- livre. O sensor usa 42501, que é o padrão de negação e não é um código de domínio.
-- ============================================================================

-- ─── 1) Motivo da expiração: coluna dedicada, não assinatura inferida ───────
-- O parecer pediu contrato de auditoria explícito, e tem razão. A alternativa que eu tinha
-- escrito — inferir "foi a trigger" de `expired_by_run IS NULL` — é verdadeira HOJE (todos
-- os 16.233 expirados de reco e os 12 do bundle têm `expired_by_run IS NOT NULL`, medido
-- 2026-08-21), mas é uma coincidência de dados, não um contrato: o primeiro outro caminho
-- que expire sem run torna a assinatura ambígua e o sensor passa a contar errado sem que
-- nada falhe.
-- NULL segue significando "expirado por recálculo" (o `expired_by_run` diz qual run).
-- Preencher a coluna nas RPCs seria reescrever mais delas do que esta fatia justifica.
ALTER TABLE public.farmer_recommendations
  ADD COLUMN IF NOT EXISTS expired_reason text;
ALTER TABLE public.farmer_bundle_recommendations
  ADD COLUMN IF NOT EXISTS expired_reason text;

-- Vocabulário fechado: 'expired_reason' só existe em linha expirada, e só com um dos
-- motivos previstos. Sem o CHECK, um typo ('troca_dono') viraria uma categoria nova e
-- silenciosa — e o sensor, que agrupa por ela, contaria zero sem nada falhar.
ALTER TABLE public.farmer_recommendations
  DROP CONSTRAINT IF EXISTS farmer_recommendations_expired_reason_check;
ALTER TABLE public.farmer_recommendations
  ADD CONSTRAINT farmer_recommendations_expired_reason_check CHECK (
    expired_reason IS NULL
    OR (status = 'expirado'
        AND expired_reason IN ('troca_de_dono', 'perda_de_dono', 'saneamento_escopo'))
  );
ALTER TABLE public.farmer_bundle_recommendations
  DROP CONSTRAINT IF EXISTS farmer_bundle_recommendations_expired_reason_check;
ALTER TABLE public.farmer_bundle_recommendations
  ADD CONSTRAINT farmer_bundle_recommendations_expired_reason_check CHECK (
    expired_reason IS NULL
    OR (status = 'expirado'
        AND expired_reason IN ('troca_de_dono', 'perda_de_dono', 'saneamento_escopo'))
  );

-- ─── 2) A função da trigger ─────────────────────────────────────────────────
-- SECURITY DEFINER como a `reconcile_score_owner_from_carteira()` vizinha: a trigger roda
-- na transação de quem reatribui e precisa alcançar as pendentes do dono ANTIGO — linhas
-- que a RLS de `farmer_recommendations` esconderia do chamador. Sem DEFINER o guard
-- falharia ABERTO (não expiraria nada) exatamente no caso que existe para cobrir.
-- O parecer nota, com razão, que DEFINER é fronteira de privilégio: o SQL aqui é estático
-- e os valores vêm de OLD/NEW (não há injeção), o `search_path` é fixo, `private` não é
-- gravável pela aplicação, e todas as tabelas estão qualificadas com `public.`.
CREATE OR REPLACE FUNCTION private.farmer_expirar_pendentes_do_dono_anterior()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_dono_novo uuid;
  v_motivo    text;
  v_reco      integer;
  v_bundle    integer;
BEGIN
  -- No DELETE não há dono novo. O NULL aqui não é "não sei": combinado com o
  -- `IS DISTINCT FROM` abaixo ele significa "nenhum farmer é o dono atual deste cliente",
  -- e TODA pendente dele passa a estar fora de escopo — que é o estado real de um cliente
  -- cujo score sumiu (o que `cleanup_orphan_score_on_carteira_delete()` faz quando ele sai
  -- de todas as carteiras).
  IF TG_OP = 'DELETE' THEN
    v_dono_novo := NULL;
    v_motivo    := 'perda_de_dono';
  ELSE
    v_dono_novo := NEW.farmer_id;
    v_motivo    := 'troca_de_dono';
  END IF;

  -- `IS DISTINCT FROM`, não `<>` — mesma escolha do FG009, pelo mesmo motivo, com um caso
  -- a mais: no DELETE `v_dono_novo` é NULL, e `farmer_id <> NULL` é NULL, que o WHERE
  -- descarta. Com `<>` o ramo do DELETE não expiraria NADA e o teste do caminho feliz
  -- seguiria verde — falha silenciosa perfeita. (O harness falsifica exatamente isto.)
  --
  -- O predicado é "tudo que não é do dono NOVO", não "o que era do dono antigo": assim é
  -- AUTO-SANEANTE — uma órfã deixada por uma troca anterior (A→B→C) morre na próxima
  -- troca, em vez de sobreviver porque naquele instante o dono antigo era outro.
  --
  -- Só 'pendente' é tocado: 'ofertado'/'aceito'/'rejeitado' (e 'aceito_total'/
  -- 'aceito_parcial' no bundle) são DESFECHO — histórico imutável. E é UPDATE, nunca DELETE.
  UPDATE public.farmer_recommendations
     SET status         = 'expirado',
         expired_at     = clock_timestamp(),
         expired_reason = v_motivo,
         updated_at     = clock_timestamp()
   WHERE customer_user_id = OLD.customer_user_id
     AND status = 'pendente'
     AND farmer_id IS DISTINCT FROM v_dono_novo;
  GET DIAGNOSTICS v_reco = ROW_COUNT;

  UPDATE public.farmer_bundle_recommendations
     SET status         = 'expirado',
         expired_at     = clock_timestamp(),
         expired_reason = v_motivo,
         updated_at     = clock_timestamp()
   WHERE customer_user_id = OLD.customer_user_id
     AND status = 'pendente'
     AND farmer_id IS DISTINCT FROM v_dono_novo;
  GET DIAGNOSTICS v_bundle = ROW_COUNT;

  -- `expired_by_run` fica NULL de propósito: não houve run. Inventar um uuid-sentinela para
  -- "parecer rastreado" fabricaria um run que não existe — a mesma classe do
  -- `Number(null)===0`. Quem responde "por que expirou" é `expired_reason`, acima.
  IF v_reco > 0 OR v_bundle > 0 THEN
    RAISE LOG '[farmer_expirar_pendentes_do_dono_anterior] cliente=% motivo=% dono_novo=% expiradas: reco=% bundle=%',
      OLD.customer_user_id, v_motivo, coalesce(v_dono_novo::text, 'nenhum'), v_reco, v_bundle;
  END IF;

  RETURN NULL;  -- AFTER trigger: retorno ignorado.
END;
$function$;

REVOKE ALL ON FUNCTION private.farmer_expirar_pendentes_do_dono_anterior() FROM PUBLIC;
-- `REVOKE FROM PUBLIC` NÃO tira grant explícito de anon/authenticated (database.md §4):
-- revogar NOMEANDO as roles. Função de trigger não é chamável como RPC, mas o REVOKE é
-- barato e o hábito é o que impede o descuido na próxima.
REVOKE ALL ON FUNCTION private.farmer_expirar_pendentes_do_dono_anterior() FROM anon, authenticated;

-- ─── 3) As triggers (duas, não uma — ver cabeçalho) ─────────────────────────
DROP TRIGGER IF EXISTS trg_fcs_troca_dono_expira_pendentes ON public.farmer_client_scores;
DROP TRIGGER IF EXISTS trg_fcs_perda_dono_expira_pendentes ON public.farmer_client_scores;

-- O `WHEN` é o que evita varrer as pendentes de um cliente a cada re-upsert de carteira que
-- reescreve o MESMO farmer_id (medido: `UPDATE OF col` dispara com valor igual).
CREATE TRIGGER trg_fcs_troca_dono_expira_pendentes
  AFTER UPDATE OF farmer_id ON public.farmer_client_scores
  FOR EACH ROW
  WHEN (OLD.farmer_id IS DISTINCT FROM NEW.farmer_id)
  EXECUTE FUNCTION private.farmer_expirar_pendentes_do_dono_anterior();

CREATE TRIGGER trg_fcs_perda_dono_expira_pendentes
  AFTER DELETE ON public.farmer_client_scores
  FOR EACH ROW
  EXECUTE FUNCTION private.farmer_expirar_pendentes_do_dono_anterior();

-- ─── 4) Índices que a trigger precisa ───────────────────────────────────────
-- Os parciais existentes lideram por `farmer_id`
-- (`idx_frec_farmer_status_pendente (farmer_id, customer_user_id) WHERE status='pendente'`)
-- e a trigger busca por `customer_user_id`. Sem estes, um rebuild que reatribui N clientes
-- faz N varreduras. Parciais em 'pendente': 1.083 e 1 linha contra 17.316 e 13 totais.
CREATE INDEX IF NOT EXISTS idx_frec_cliente_pendente
  ON public.farmer_recommendations (customer_user_id)
  WHERE status = 'pendente';

CREATE INDEX IF NOT EXISTS idx_fbrec_cliente_pendente
  ON public.farmer_bundle_recommendations (customer_user_id)
  WHERE status = 'pendente';

-- ─── 5) O SENSOR — a invariante COM denominador ─────────────────────────────
-- "Fase N+1 exige SINAL da fase N" (CLAUDE.md): sem denominador, 0 não julga desenho.
--
-- Por que função e não view: os counts precisam ser da BASE INTEIRA. Uma view
-- `security_invoker` contaria só o que o chamador enxerga pela RLS, e o denominador
-- encolheria junto com o numerador — 0/0 com aparência de saúde. DEFINER + gate explícito
-- é o padrão de `get_data_health()`.
--
-- Os três números que o parecer pediu, separados de propósito:
--   · pendentes_total          — denominador honesto: TODA pendente, com ou sem score;
--   · pendentes_dono_divergente— pendente cujo cliente TEM score e o dono não bate;
--   · pendentes_sem_dono       — pendente de cliente SEM linha de score. É o que o INNER
--     JOIN da baseline não vê: no caminho do DELETE a linha sairia do numerador E do
--     denominador ao mesmo tempo, e o ponto cego mediria "melhora".
-- `violacoes` é a soma — o SLO é violacoes = 0, não um percentual. Uma oferta inválida
-- importa no money-path. `pct_violacao` é só contexto e é NULL (não 0) quando não há
-- universo: "não medido" e "medido e limpo" são estados diferentes.
CREATE OR REPLACE FUNCTION public.farmer_escopo_invariante()
RETURNS TABLE (
  tabela                     text,
  pendentes_total            bigint,
  violacoes                  bigint,
  pendentes_dono_divergente  bigint,
  pendentes_sem_dono         bigint,
  pct_violacao               numeric,
  expiradas_troca_de_dono    bigint,
  expiradas_perda_de_dono    bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- `IS NOT TRUE`, não `NOT (...)`: numa sessão sem JWT (psql, pg_cron) `auth.uid()` é NULL
  -- e a disjunção vira NULL — e `IF NOT NULL THEN` não dispara em PL/pgSQL. Mesmo cuidado
  -- do passo 1 das RPCs, e pela mesma razão: o gate falharia ABERTO.
  IF (
    coalesce(auth.role(), '') = 'service_role'
    OR coalesce(private.cap_carteira_ler(auth.uid()), false)
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Acesso negado: farmer_escopo_invariante é diagnóstico de carteira'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH r AS (
    SELECT
      count(*) FILTER (WHERE x.status = 'pendente')                                AS pend,
      count(*) FILTER (WHERE x.status = 'pendente' AND s.customer_user_id IS NOT NULL
                             AND x.farmer_id IS DISTINCT FROM s.farmer_id)         AS diverg,
      count(*) FILTER (WHERE x.status = 'pendente' AND s.customer_user_id IS NULL) AS sem_dono,
      count(*) FILTER (WHERE x.expired_reason = 'troca_de_dono')                   AS exp_troca,
      count(*) FILTER (WHERE x.expired_reason = 'perda_de_dono')                   AS exp_perda
    FROM public.farmer_recommendations x
    LEFT JOIN public.farmer_client_scores s ON s.customer_user_id = x.customer_user_id
  ), b AS (
    SELECT
      count(*) FILTER (WHERE x.status = 'pendente')                                AS pend,
      count(*) FILTER (WHERE x.status = 'pendente' AND s.customer_user_id IS NOT NULL
                             AND x.farmer_id IS DISTINCT FROM s.farmer_id)         AS diverg,
      count(*) FILTER (WHERE x.status = 'pendente' AND s.customer_user_id IS NULL) AS sem_dono,
      count(*) FILTER (WHERE x.expired_reason = 'troca_de_dono')                   AS exp_troca,
      count(*) FILTER (WHERE x.expired_reason = 'perda_de_dono')                   AS exp_perda
    FROM public.farmer_bundle_recommendations x
    LEFT JOIN public.farmer_client_scores s ON s.customer_user_id = x.customer_user_id
  )
  SELECT 'farmer_recommendations'::text, r.pend, r.diverg + r.sem_dono, r.diverg, r.sem_dono,
         CASE WHEN r.pend > 0 THEN round(100.0 * (r.diverg + r.sem_dono) / r.pend, 2) END,
         r.exp_troca, r.exp_perda FROM r
  UNION ALL
  SELECT 'farmer_bundle_recommendations'::text, b.pend, b.diverg + b.sem_dono, b.diverg, b.sem_dono,
         CASE WHEN b.pend > 0 THEN round(100.0 * (b.diverg + b.sem_dono) / b.pend, 2) END,
         b.exp_troca, b.exp_perda FROM b;
END;
$function$;

REVOKE ALL ON FUNCTION public.farmer_escopo_invariante() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.farmer_escopo_invariante() FROM anon;
GRANT EXECUTE ON FUNCTION public.farmer_escopo_invariante() TO authenticated;

-- ─── 6) Saneamento único das órfãs já existentes ────────────────────────────
-- Idempotente e NO-OP nesta data (medido: 0 nas duas tabelas). Existe porque a trigger só
-- age no MOMENTO da troca: uma órfã anterior a ela não teria evento que a alcançasse.
-- Mesmas regras: só 'pendente', UPDATE nunca DELETE.
UPDATE public.farmer_recommendations r
   SET status = 'expirado', expired_at = clock_timestamp(),
       expired_reason = 'saneamento_escopo', updated_at = clock_timestamp()
  FROM public.farmer_client_scores s
 WHERE s.customer_user_id = r.customer_user_id
   AND r.status = 'pendente'
   AND r.farmer_id IS DISTINCT FROM s.farmer_id;

UPDATE public.farmer_bundle_recommendations r
   SET status = 'expirado', expired_at = clock_timestamp(),
       expired_reason = 'saneamento_escopo', updated_at = clock_timestamp()
  FROM public.farmer_client_scores s
 WHERE s.customer_user_id = r.customer_user_id
   AND r.status = 'pendente'
   AND r.farmer_id IS DISTINCT FROM s.farmer_id;

-- Pendente de cliente SEM linha de score. Separado do UPDATE acima porque um JOIN não
-- alcança a linha que não existe — é o mesmo ponto cego que o sensor mede em separado.
UPDATE public.farmer_recommendations r
   SET status = 'expirado', expired_at = clock_timestamp(),
       expired_reason = 'saneamento_escopo', updated_at = clock_timestamp()
 WHERE r.status = 'pendente'
   AND NOT EXISTS (SELECT 1 FROM public.farmer_client_scores s
                    WHERE s.customer_user_id = r.customer_user_id);

UPDATE public.farmer_bundle_recommendations r
   SET status = 'expirado', expired_at = clock_timestamp(),
       expired_reason = 'saneamento_escopo', updated_at = clock_timestamp()
 WHERE r.status = 'pendente'
   AND NOT EXISTS (SELECT 1 FROM public.farmer_client_scores s
                    WHERE s.customer_user_id = r.customer_user_id);

-- ─── 7) As duas RPCs, com o LOCK CAUSAL DO ESCOPO ───────────────────────────
-- Corpo VERBATIM da PRODUÇÃO (lido com `pg_get_functiondef` em 2026-08-21) + o bloco
-- 6-ter inserido programaticamente antes do gate FG009 — não reconstruído a partir do
-- repo, de propósito: apply manual diverge, e em `CREATE OR REPLACE` a última a recriar
-- VENCE (database.md §4). Nenhuma outra linha das RPCs muda.
CREATE OR REPLACE FUNCTION public.farmer_recomendacoes_substituir(p_farmer_id uuid, p_run_id uuid, p_geracao_vista uuid, p_linhas jsonb, p_completude text DEFAULT NULL::text, p_motivo text DEFAULT NULL::text, p_insumos jsonb DEFAULT NULL::jsonb, p_head_visto uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total          integer;
  v_invalidas      integer;
  v_fora_escopo        integer;
  v_geracao_atual  uuid;
  v_expiradas      integer;
  v_inseridas      integer;
  v_head_atual     uuid;
BEGIN
  -- 1) Gate de MENSAGEM (a RLS é quem autoriza — ver cabeçalho).
  IF p_farmer_id IS NULL OR p_run_id IS NULL THEN
    RAISE EXCEPTION 'p_farmer_id e p_run_id são obrigatórios' USING ERRCODE = 'FG001';
  END IF;
  -- ⚠️ `IS NOT TRUE`, não `NOT (...)`. Numa sessão SEM JWT (pg_cron, psql) `auth.uid()`
  -- devolve NULL, então `p_farmer_id = auth.uid()` é NULL e a disjunção inteira vira
  -- NULL — e `IF NOT NULL THEN` NÃO dispara em PL/pgSQL. Medido em prod:
  --   NOT (false OR NULL OR false)          => NULL   (o RAISE nunca acontece)
  --   (false OR NULL OR false) IS NOT TRUE  => true   (barra, como se quer)
  IF (
    coalesce(auth.role(), '') = 'service_role'
    OR p_farmer_id = auth.uid()
    OR coalesce(private.cap_carteira_escrever(auth.uid()), false)
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Acesso negado: só o próprio farmer ou quem tem cap_carteira_escrever substitui recomendações'
      USING ERRCODE = '42501';
  END IF;

  -- 2) FORMATO.
  IF p_linhas IS NULL OR jsonb_typeof(p_linhas) <> 'array' THEN
    RAISE EXCEPTION 'p_linhas deve ser um array jsonb (recebido: %)',
      coalesce(jsonb_typeof(p_linhas), 'null') USING ERRCODE = 'FG002';
  END IF;

  v_total := jsonb_array_length(p_linhas);

  -- 3) LOTE VAZIO = RECUSA, não "expira tudo e deixa o farmer sem oferta".
  -- Zero recomendação quase sempre é dado faltando a montante (catálogo, scores,
  -- get_skus_margem_positiva), não "este farmer não tem o que oferecer" — mesmo
  -- raciocínio que farmer_association_rules_substituir aplica ao lote vazio.
  -- ⚠️ Isto SEGUE valendo depois do head: quem tem geração legitimamente vazia
  -- chama `farmer_geracao_registrar` (que move o head e não toca em linha nenhuma),
  -- e não esta função. Afrouxar aqui religaria a expiração — que está FORA do escopo
  -- desta fase por decisão explícita.
  IF v_total = 0 THEN
    RAISE EXCEPTION 'lote vazio: as % recomendação(ões) pendentes deste farmer foram preservadas',
      (SELECT count(*) FROM public.farmer_recommendations
        WHERE farmer_id = p_farmer_id AND status = 'pendente')
      USING ERRCODE = 'FG003';
  END IF;

  -- Teto defensivo: a maior geração medida em prod tem ~1.000 linhas
  -- (3 cross + 2 up por cliente). 50k é ~50x isso — folga sem ficar ilimitado.
  IF v_total > 50000 THEN
    RAISE EXCEPTION 'lote de % linhas excede o teto de 50000', v_total USING ERRCODE = 'FG004';
  END IF;

  -- 4) SERIALIZAÇÃO por FARMER (não global: duas vendedoras recalculando ao mesmo
  -- tempo mexem em escopos disjuntos e não têm por que esperar uma pela outra).
  -- `xact` = o lock sai sozinho no commit/rollback.
  IF NOT pg_try_advisory_xact_lock(
        hashtext('farmer_recomendacoes_substituir'), hashtext(p_farmer_id::text)) THEN
    RAISE EXCEPTION 'outro recálculo deste farmer está em andamento — nada foi alterado'
      USING ERRCODE = 'FG005';
  END IF;

  -- 5) GUARD CAUSAL (compare-and-swap).
  -- O advisory lock acima só cobre a TRANSAÇÃO da RPC — ele não cobre a janela
  -- longa entre "o motor leu o snapshot" e "o motor chamou esta função". Sem este
  -- guard, dois recálculos sobrepostos terminam com o MAIS LENTO vencendo, e o
  -- mais lento é justamente o que leu o snapshot mais VELHO (money-path §10: o
  -- degradado terminar depois do saudável é o desfecho esperado, não o azar).
  -- NULL casa NULL: primeira execução, e as linhas legadas (run_id NULL).
  SELECT run_id INTO v_geracao_atual
  FROM public.farmer_recommendations
  WHERE farmer_id = p_farmer_id AND status = 'pendente'
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  IF v_geracao_atual IS DISTINCT FROM p_geracao_vista THEN
    RAISE EXCEPTION 'geração vigente mudou durante o cálculo (vista: %, atual: %) — nada foi alterado',
      coalesce(p_geracao_vista::text, 'nenhuma'), coalesce(v_geracao_atual::text, 'nenhuma')
      USING ERRCODE = 'FG006';
  END IF;

  -- 6) VALIDAÇÃO ANTES DE MEXER (nada é expirado se o lote tem lixo).
  SELECT count(*) INTO v_invalidas
  FROM jsonb_to_recordset(p_linhas) AS r(
    customer_user_id        uuid,
    recommendation_type     text,
    product_id              uuid,
    affinity_score          numeric
  )
  WHERE r.customer_user_id IS NULL
     OR r.product_id IS NULL
     OR r.recommendation_type IS NULL
     OR r.recommendation_type NOT IN ('cross_sell', 'up_sell')
     -- Finitude nos TRÊS lados. `>= 0` sozinho NÃO sanea: medido em prod,
     -- `'NaN' >= 0` é TRUE e `'Infinity' >= 0` é TRUE (money-path §2).
     OR r.affinity_score IS NULL
     OR NOT (
          r.affinity_score >= 0
          AND r.affinity_score < 'Infinity'::numeric
          AND r.affinity_score <> 'NaN'::numeric
        );

  IF v_invalidas > 0 THEN
    RAISE EXCEPTION '% de % linha(s) inválidas (cliente/produto/tipo ausente, ou afinidade nula/negativa/NaN/Infinita) — nada foi expirado',
      v_invalidas, v_total USING ERRCODE = 'FG007';
  END IF;
  -- 6-bis) ESCOPO DE CARTEIRA — o cliente do lote precisa ser DESTE farmer.
  --
  -- `farmer_client_scores` tem UNIQUE (customer_user_id): o dono de um cliente é uma
  -- FUNÇÃO, computável aqui dentro. Até esta versão a RPC aceitava qualquer cliente e
  -- carimbava `p_farmer_id` por cima — foi por essa porta que o fallback do browser
  -- ("carteira vazia ⇒ carregue TODOS os scores") gravou 2.676 linhas com `farmer_id` ≠
  -- dono do cliente. Medido em prod (psql-ro, 21/08/2026): o lote de abril sob o farmer
  -- 33f59dc7 cobria 166 clientes e só 25,9% eram dele, contra os 18,8% da base que ele
  -- detém — a assinatura de quem sorteou da base inteira, não de quem leu a própria carteira.
  --
  -- O gate tinha que ser AQUI, não só no browser: o cliente não pode ser a autoridade
  -- sobre o próprio escopo (#1840 — o browser reescrevia as regras do servidor por cima).
  --
  -- E o dano SOBREVIVE ao conserto do browser porque a etapa 7 expira
  -- `WHERE farmer_id = p_farmer_id`: a linha do cliente C gravada sob A, quando o dono é B,
  -- é INVISÍVEL ao recálculo de B — o dono real recalcula e ela segue pendente, dando ao
  -- mesmo cliente duas gerações vivas ao mesmo tempo.
  --
  -- `IS DISTINCT FROM`, não `<>`: o cliente SEM linha de score precisa cair do MESMO lado.
  -- `<>` com NULL devolve NULL, o `WHERE` descarta, e o cliente de dono desconhecido passaria
  -- — exatamente o caso mais suspeito. Dono desconhecido é recusa, nunca "grave assim mesmo".
  --
  -- Isto é FAIL-CLOSED sob a RLS: a função é SECURITY INVOKER e `farmer_client_scores` só
  -- se deixa ler por `cap_carteira_ler(uid) OR carteira_visivel_para(cliente, uid)`. Se a RLS
  -- esconder do chamador a linha de um cliente alheio, o LEFT JOIN devolve NULL — e NULL é
  -- recusado. A cegueira da RLS vira RECUSA, não passagem.
  -- 6-ter) LOCK CAUSAL DO ESCOPO — a metade que a trigger de troca de dono NÃO cobre.
  -- O guard do #1850 compara o lote com o dono LIDO aqui; a trigger nova
  -- (private.farmer_expirar_pendentes_do_dono_anterior) expira o que já existia quando o
  -- dono muda. Nenhum dos dois cobre a janela ENTRE eles:
  --
  --   T1 (esta RPC, farmer A)          T2 (reatribuição do cliente C para B)
  --   ------------------------         -------------------------------------
  --   FG009 lê score de C = A
  --                                    UPDATE farmer_client_scores: C -> B
  --                                    trigger expira as pendentes de C que existiam
  --   INSERT da oferta C sob A         (a linha NOVA nasce depois da varredura)
  --   COMMIT                           COMMIT
  --
  -- A oferta nova sobrevive fora de escopo. O advisory lock do passo 4 não ajuda: ele é
  -- por FARMER, e quem reatribui não o toma. Travar as linhas de score do lote até o
  -- COMMIT resolve nos dois sentidos — se a troca chega antes, ela espera e a trigger
  -- alcança a linha nova; se chega depois, esta RPC já lê o dono novo e o FG009 recusa.
  --
  -- `FOR SHARE`, não `FOR KEY SHARE`: um UPDATE que não mexe em chave toma
  -- `FOR NO KEY UPDATE`, que NÃO conflita com `FOR KEY SHARE` — o lock mais fraco
  -- deixaria a corrida exatamente como estava, e o teste do caminho feliz seguiria verde.
  -- `FOR SHARE` conflita, e é compartilhado: duas vendedoras com lotes disjuntos não se
  -- esperam (só quem tenta REATRIBUIR espera).
  --
  -- O `ORDER BY` é best-effort contra deadlock (o PG não garante ordem de travamento sob
  -- ORDER BY). A garantia real é a ordem de RECURSOS, que esta fatia mantém única em todo
  -- o domínio: farmer_client_scores -> farmer_recommendations. A trigger segue a mesma
  -- ordem (é disparada POR um UPDATE em scores e só então toca recomendações), então não
  -- há ciclo a inverter.
  --
  -- Cliente do lote SEM linha de score não trava nada — não há linha. Não é buraco: o
  -- FG009 logo abaixo recusa o lote inteiro nesse caso (dono desconhecido é recusa).
  PERFORM 1
    FROM public.farmer_client_scores s
   WHERE s.customer_user_id IN (
           SELECT DISTINCT c.customer_user_id
             FROM jsonb_to_recordset(p_linhas) AS c(customer_user_id uuid)
            WHERE c.customer_user_id IS NOT NULL
         )
   ORDER BY s.customer_user_id
     FOR SHARE;

  SELECT count(*) INTO v_fora_escopo
  FROM jsonb_to_recordset(p_linhas) AS r(customer_user_id uuid)
  LEFT JOIN public.farmer_client_scores s ON s.customer_user_id = r.customer_user_id
  WHERE s.farmer_id IS DISTINCT FROM p_farmer_id;

  -- FG009, não FG008: o 008 JÁ É de outra defesa deste mesmo domínio — a trigger que barra
  -- INSERT direto de pendente sem `run_id` (migration 20260814223445). Reusar o código
  -- tornaria dois erros distintos indistinguíveis pela SQLSTATE, que é justamente o que um
  -- chamador usa para decidir o que fazer. Verificado em prod: FG001–FG008 e FG101–FG107
  -- ocupados; 009 livre.
  IF v_fora_escopo > 0 THEN
    RAISE EXCEPTION '% de % linha(s) são de cliente fora da carteira deste farmer — nada foi expirado',
      v_fora_escopo, v_total USING ERRCODE = 'FG009';
  END IF;

  -- 7) A TROCA — os dois statements na MESMA transação.
  -- Só 'pendente' é tocado: linha com desfecho ('ofertado'/'aceito'/'rejeitado')
  -- é histórico e fica imutável. E é UPDATE, nunca DELETE.
  UPDATE public.farmer_recommendations
     SET status         = 'expirado',
         expired_at     = clock_timestamp(),
         expired_by_run = p_run_id,
         updated_at     = clock_timestamp()
   WHERE farmer_id = p_farmer_id
     AND status = 'pendente';
  GET DIAGNOSTICS v_expiradas = ROW_COUNT;

  INSERT INTO public.farmer_recommendations (
    farmer_id, customer_user_id, recommendation_type, product_id, current_product_id,
    p_ij, m_ij, lie, affinity_score, complexity_factor, cluster_volume_estimate,
    status, run_id
  )
  SELECT
    p_farmer_id, r.customer_user_id, r.recommendation_type, r.product_id, r.current_product_id,
    r.p_ij,
    -- m_ij e lie são DINHEIRO e saíram de cena no #1520 (o custo não chega mais ao
    -- browser). Fixados em NULL aqui, não copiados do payload: o cliente não tem
    -- como fabricá-los de volta.
    NULL, NULL,
    r.affinity_score, coalesce(r.complexity_factor, 1), coalesce(r.cluster_volume_estimate, 1),
    'pendente', p_run_id
  FROM jsonb_to_recordset(p_linhas) AS r(
    customer_user_id        uuid,
    recommendation_type     text,
    product_id              uuid,
    current_product_id      uuid,
    p_ij                    numeric,
    affinity_score          numeric,
    complexity_factor       numeric,
    cluster_volume_estimate numeric
  );
  GET DIAGNOSTICS v_inseridas = ROW_COUNT;

  -- 8) O HEAD, na MESMA transação — com o head que o CHAMADOR viu ANTES do cálculo.
  --
  -- ⚠️ A 1ª versão lia o head AQUI DENTRO e o passava adiante, o que satisfazia o CAS por
  -- construção e abria a assimetria que o challenge Codex xhigh encontrou: um run VAZIO
  -- que commita entre a leitura e a escrita de um run COM LINHAS não é visto pelo CAS da
  -- etapa 5 (ele compara LINHAS, e o vazio não mexeu em linha nenhuma), então o run antigo
  -- sobrescrevia um vazio mais novo. O sistema misturava duas ordens: frescor causal para
  -- o vazio e ordem-de-commit para as linhas. Comparar o head ORIGINAL alinha as duas.
  --
  -- `p_completude IS NULL` é o marcador de chamador ANTERIOR ao sensor (assinatura de 4
  -- args, bundle velho em cache): ele não tem head para declarar, então cai no head
  -- corrente em vez de ser recusado por não saber de algo que não existia quando foi
  -- escrito. Os dois sinais de "cliente antigo" são o mesmo, de propósito.
  IF p_completude IS NULL THEN
    SELECT run_id INTO v_head_atual
    FROM public.farmer_geracao_vigente
    WHERE motor = 'cross_sell' AND farmer_id = p_farmer_id;
  ELSE
    v_head_atual := p_head_visto;
  END IF;

  PERFORM public.farmer_geracao_registrar(
    'cross_sell', p_farmer_id, p_run_id, 'linhas', v_inseridas,
    p_completude, p_motivo, p_insumos, v_head_atual
  );

  RETURN jsonb_build_object(
    'run_id',    p_run_id,
    'expiradas', v_expiradas,
    'inseridas', v_inseridas
  );
END;
$function$

;
CREATE OR REPLACE FUNCTION public.farmer_bundle_recomendacoes_substituir(p_farmer_id uuid, p_run_id uuid, p_geracao_vista uuid, p_linhas jsonb, p_completude text DEFAULT NULL::text, p_motivo text DEFAULT NULL::text, p_insumos jsonb DEFAULT NULL::jsonb, p_head_visto uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total         integer;
  v_invalidas     integer;
  v_fora_escopo       integer;
  v_geracao_atual uuid;
  v_expiradas     integer;
  v_inseridas     integer;
  v_head_atual    uuid;
BEGIN
  IF p_farmer_id IS NULL OR p_run_id IS NULL THEN
    RAISE EXCEPTION 'p_farmer_id e p_run_id são obrigatórios' USING ERRCODE = 'FG001';
  END IF;
  IF (
    coalesce(auth.role(), '') = 'service_role'
    OR p_farmer_id = auth.uid()
    OR coalesce(private.cap_carteira_escrever(auth.uid()), false)
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Acesso negado: só o próprio farmer ou quem tem cap_carteira_escrever substitui recomendações'
      USING ERRCODE = '42501';
  END IF;

  IF p_linhas IS NULL OR jsonb_typeof(p_linhas) <> 'array' THEN
    RAISE EXCEPTION 'p_linhas deve ser um array jsonb (recebido: %)',
      coalesce(jsonb_typeof(p_linhas), 'null') USING ERRCODE = 'FG002';
  END IF;

  v_total := jsonb_array_length(p_linhas);

  IF v_total = 0 THEN
    RAISE EXCEPTION 'lote vazio: os % bundle(s) pendentes deste farmer foram preservados',
      (SELECT count(*) FROM public.farmer_bundle_recommendations
        WHERE farmer_id = p_farmer_id AND status = 'pendente')
      USING ERRCODE = 'FG003';
  END IF;

  IF v_total > 50000 THEN
    RAISE EXCEPTION 'lote de % linhas excede o teto de 50000', v_total USING ERRCODE = 'FG004';
  END IF;

  IF NOT pg_try_advisory_xact_lock(
        hashtext('farmer_bundle_recomendacoes_substituir'), hashtext(p_farmer_id::text)) THEN
    RAISE EXCEPTION 'outro recálculo de bundles deste farmer está em andamento — nada foi alterado'
      USING ERRCODE = 'FG005';
  END IF;

  SELECT run_id INTO v_geracao_atual
  FROM public.farmer_bundle_recommendations
  WHERE farmer_id = p_farmer_id AND status = 'pendente'
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  IF v_geracao_atual IS DISTINCT FROM p_geracao_vista THEN
    RAISE EXCEPTION 'geração vigente de bundles mudou durante o cálculo (vista: %, atual: %) — nada foi alterado',
      coalesce(p_geracao_vista::text, 'nenhuma'), coalesce(v_geracao_atual::text, 'nenhuma')
      USING ERRCODE = 'FG006';
  END IF;

  SELECT count(*) INTO v_invalidas
  FROM jsonb_to_recordset(p_linhas) AS r(
    customer_user_id uuid,
    bundle_products  jsonb,
    affinity_bundle  numeric
  )
  WHERE r.customer_user_id IS NULL
     OR r.bundle_products IS NULL
     OR jsonb_typeof(r.bundle_products) <> 'array'
     OR jsonb_array_length(r.bundle_products) = 0
     OR r.affinity_bundle IS NULL
     OR NOT (
          r.affinity_bundle >= 0
          AND r.affinity_bundle < 'Infinity'::numeric
          AND r.affinity_bundle <> 'NaN'::numeric
        );

  IF v_invalidas > 0 THEN
    RAISE EXCEPTION '% de % bundle(s) inválidos (cliente/produtos ausentes, ou afinidade nula/negativa/NaN/Infinita) — nada foi expirado',
      v_invalidas, v_total USING ERRCODE = 'FG007';
  END IF;
  -- 6-bis) ESCOPO DE CARTEIRA — o cliente do lote precisa ser DESTE farmer.
  --
  -- `farmer_client_scores` tem UNIQUE (customer_user_id): o dono de um cliente é uma
  -- FUNÇÃO, computável aqui dentro. Até esta versão a RPC aceitava qualquer cliente e
  -- carimbava `p_farmer_id` por cima — foi por essa porta que o fallback do browser
  -- ("carteira vazia ⇒ carregue TODOS os scores") gravou 2.676 linhas com `farmer_id` ≠
  -- dono do cliente. Medido em prod (psql-ro, 21/08/2026): o lote de abril sob o farmer
  -- 33f59dc7 cobria 166 clientes e só 25,9% eram dele, contra os 18,8% da base que ele
  -- detém — a assinatura de quem sorteou da base inteira, não de quem leu a própria carteira.
  --
  -- O gate tinha que ser AQUI, não só no browser: o cliente não pode ser a autoridade
  -- sobre o próprio escopo (#1840 — o browser reescrevia as regras do servidor por cima).
  --
  -- E o dano SOBREVIVE ao conserto do browser porque a etapa 7 expira
  -- `WHERE farmer_id = p_farmer_id`: a linha do cliente C gravada sob A, quando o dono é B,
  -- é INVISÍVEL ao recálculo de B — o dono real recalcula e ela segue pendente, dando ao
  -- mesmo cliente duas gerações vivas ao mesmo tempo.
  --
  -- `IS DISTINCT FROM`, não `<>`: o cliente SEM linha de score precisa cair do MESMO lado.
  -- `<>` com NULL devolve NULL, o `WHERE` descarta, e o cliente de dono desconhecido passaria
  -- — exatamente o caso mais suspeito. Dono desconhecido é recusa, nunca "grave assim mesmo".
  --
  -- Isto é FAIL-CLOSED sob a RLS: a função é SECURITY INVOKER e `farmer_client_scores` só
  -- se deixa ler por `cap_carteira_ler(uid) OR carteira_visivel_para(cliente, uid)`. Se a RLS
  -- esconder do chamador a linha de um cliente alheio, o LEFT JOIN devolve NULL — e NULL é
  -- recusado. A cegueira da RLS vira RECUSA, não passagem.
  -- 6-ter) LOCK CAUSAL DO ESCOPO — a metade que a trigger de troca de dono NÃO cobre.
  -- O guard do #1850 compara o lote com o dono LIDO aqui; a trigger nova
  -- (private.farmer_expirar_pendentes_do_dono_anterior) expira o que já existia quando o
  -- dono muda. Nenhum dos dois cobre a janela ENTRE eles:
  --
  --   T1 (esta RPC, farmer A)          T2 (reatribuição do cliente C para B)
  --   ------------------------         -------------------------------------
  --   FG009 lê score de C = A
  --                                    UPDATE farmer_client_scores: C -> B
  --                                    trigger expira as pendentes de C que existiam
  --   INSERT da oferta C sob A         (a linha NOVA nasce depois da varredura)
  --   COMMIT                           COMMIT
  --
  -- A oferta nova sobrevive fora de escopo. O advisory lock do passo 4 não ajuda: ele é
  -- por FARMER, e quem reatribui não o toma. Travar as linhas de score do lote até o
  -- COMMIT resolve nos dois sentidos — se a troca chega antes, ela espera e a trigger
  -- alcança a linha nova; se chega depois, esta RPC já lê o dono novo e o FG009 recusa.
  --
  -- `FOR SHARE`, não `FOR KEY SHARE`: um UPDATE que não mexe em chave toma
  -- `FOR NO KEY UPDATE`, que NÃO conflita com `FOR KEY SHARE` — o lock mais fraco
  -- deixaria a corrida exatamente como estava, e o teste do caminho feliz seguiria verde.
  -- `FOR SHARE` conflita, e é compartilhado: duas vendedoras com lotes disjuntos não se
  -- esperam (só quem tenta REATRIBUIR espera).
  --
  -- O `ORDER BY` é best-effort contra deadlock (o PG não garante ordem de travamento sob
  -- ORDER BY). A garantia real é a ordem de RECURSOS, que esta fatia mantém única em todo
  -- o domínio: farmer_client_scores -> farmer_recommendations. A trigger segue a mesma
  -- ordem (é disparada POR um UPDATE em scores e só então toca recomendações), então não
  -- há ciclo a inverter.
  --
  -- Cliente do lote SEM linha de score não trava nada — não há linha. Não é buraco: o
  -- FG009 logo abaixo recusa o lote inteiro nesse caso (dono desconhecido é recusa).
  PERFORM 1
    FROM public.farmer_client_scores s
   WHERE s.customer_user_id IN (
           SELECT DISTINCT c.customer_user_id
             FROM jsonb_to_recordset(p_linhas) AS c(customer_user_id uuid)
            WHERE c.customer_user_id IS NOT NULL
         )
   ORDER BY s.customer_user_id
     FOR SHARE;

  SELECT count(*) INTO v_fora_escopo
  FROM jsonb_to_recordset(p_linhas) AS r(customer_user_id uuid)
  LEFT JOIN public.farmer_client_scores s ON s.customer_user_id = r.customer_user_id
  WHERE s.farmer_id IS DISTINCT FROM p_farmer_id;

  IF v_fora_escopo > 0 THEN
    RAISE EXCEPTION '% de % linha(s) são de cliente fora da carteira deste farmer — nada foi expirado',
      v_fora_escopo, v_total USING ERRCODE = 'FG009';
  END IF;

  UPDATE public.farmer_bundle_recommendations
     SET status         = 'expirado',
         expired_at     = clock_timestamp(),
         expired_by_run = p_run_id,
         updated_at     = clock_timestamp()
   WHERE farmer_id = p_farmer_id
     AND status = 'pendente';
  GET DIAGNOSTICS v_expiradas = ROW_COUNT;

  INSERT INTO public.farmer_bundle_recommendations (
    farmer_id, customer_user_id, bundle_products, support, confidence, lift,
    p_bundle, m_bundle, lie_bundle, affinity_bundle, complexity_factor,
    status, run_id
  )
  SELECT
    p_farmer_id, r.customer_user_id, r.bundle_products,
    r.support, r.confidence, r.lift, r.p_bundle,
    -- m_bundle/lie_bundle: dinheiro, fora de cena desde o #1520 (ver RPC irmã).
    NULL, NULL,
    r.affinity_bundle, coalesce(r.complexity_factor, 1),
    'pendente', p_run_id
  FROM jsonb_to_recordset(p_linhas) AS r(
    customer_user_id  uuid,
    bundle_products   jsonb,
    support           numeric,
    confidence        numeric,
    lift              numeric,
    p_bundle          numeric,
    affinity_bundle   numeric,
    complexity_factor numeric
  );
  GET DIAGNOSTICS v_inseridas = ROW_COUNT;

  -- O HEAD, na MESMA transação, com o head ORIGINAL do chamador (ver RPC irmã para o
  -- racional da assimetria que isto fecha).
  IF p_completude IS NULL THEN
    SELECT run_id INTO v_head_atual
    FROM public.farmer_geracao_vigente
    WHERE motor = 'bundle' AND farmer_id = p_farmer_id;
  ELSE
    v_head_atual := p_head_visto;
  END IF;

  PERFORM public.farmer_geracao_registrar(
    'bundle', p_farmer_id, p_run_id, 'linhas', v_inseridas,
    p_completude, p_motivo, p_insumos, v_head_atual
  );

  RETURN jsonb_build_object(
    'run_id',    p_run_id,
    'expiradas', v_expiradas,
    'inseridas', v_inseridas
  );
END;
$function$

;

-- ─── 8) Validação pós-apply (rode junto, no MESMO Run) ──────────────────────
-- Espera: 2 linhas, ambas com violacoes = 0.
--
-- ⚠️ É a query DIRETA, não `SELECT * FROM public.farmer_escopo_invariante()`. O SQL Editor
-- do Lovable executa SEM JWT, então `auth.role()`/`auth.uid()` são NULL ali e o gate da
-- função — que é fail-closed de propósito, como o das RPCs e o de `get_data_health()` —
-- NEGA. Isso foi descoberto executando: a primeira versão deste arquivo abortava o próprio
-- Run no último statement, depois de já ter aplicado tudo. A função existe para o app
-- (`authenticated` com `cap_carteira_ler`); para o SQL Editor e para o psql-ro, é esta
-- query que dá o mesmo número.
WITH r AS (
  SELECT 'farmer_recommendations'::text AS tabela,
    count(*) FILTER (WHERE x.status = 'pendente')                                AS pendentes_total,
    count(*) FILTER (WHERE x.status = 'pendente' AND s.customer_user_id IS NOT NULL
                           AND x.farmer_id IS DISTINCT FROM s.farmer_id)         AS dono_divergente,
    count(*) FILTER (WHERE x.status = 'pendente' AND s.customer_user_id IS NULL) AS sem_dono
  FROM public.farmer_recommendations x
  LEFT JOIN public.farmer_client_scores s ON s.customer_user_id = x.customer_user_id
  UNION ALL
  SELECT 'farmer_bundle_recommendations',
    count(*) FILTER (WHERE x.status = 'pendente'),
    count(*) FILTER (WHERE x.status = 'pendente' AND s.customer_user_id IS NOT NULL
                           AND x.farmer_id IS DISTINCT FROM s.farmer_id),
    count(*) FILTER (WHERE x.status = 'pendente' AND s.customer_user_id IS NULL)
  FROM public.farmer_bundle_recommendations x
  LEFT JOIN public.farmer_client_scores s ON s.customer_user_id = x.customer_user_id
)
SELECT tabela, pendentes_total, dono_divergente + sem_dono AS violacoes,
       dono_divergente, sem_dono,
       CASE WHEN pendentes_total > 0
            THEN round(100.0 * (dono_divergente + sem_dono) / pendentes_total, 2) END AS pct_violacao
FROM r;
