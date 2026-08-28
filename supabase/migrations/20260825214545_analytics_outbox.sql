-- ============================================================
-- analytics_outbox — telemetria DECISÓRIA emitida server-side
--
-- Spec: docs/superpowers/specs/2026-08-25-analytics-outbox-design.md
-- Doc:  docs/agent/analytics.md §6 "A quarta saída: outbox server-side"
--
-- Dor: a telemetria client-side é CENSURADA por bloqueadores (PR #1984), e a
-- censura correlaciona com perfil — quem bloqueia tende a usar mais. Medido em
-- 2026-08-25: último evento de browser em 23/08, enquanto `dashboard_visits`
-- (PostgREST, fora do cano do PostHog) ganhou linha em 25/08 com 16 min de
-- sessão. O zero é do CANAL, não do fenômeno.
--
-- A regra "sinal que decide nasce em tabela própria" não basta sozinha porque
-- "sinal que decide" MUDA DEPOIS DA COLETA: o evento de conveniência de hoje é
-- a métrica decisória de amanhã, e aí o histórico dele já nasceu censurado.
--
-- Desenho: fato de negócio já persistido emite, NA MESMA TRANSAÇÃO, uma linha
-- nesta outbox; um worker a drena para o PostHog server-side com id idempotente.
-- Interação puramente de UI segue client-side e assumidamente censurável.
--
-- ⚠️ Por que TRIGGER e não dual-write no código: `aprovado_em` de
-- `pedido_compra_sugerido` tem DOIS escritores — o frontend (UPDATE PostgREST,
-- sob a identidade do usuário) e a edge `disparar-pedidos-aprovados`
-- (service_role). Só um trigger no banco captura os dois. Dual-write divergiria
-- no primeiro caminho esquecido, que é a falha que a outbox existe para não ter.
--
-- ⚠️ O CRON DO WORKER **NÃO** ESTÁ AQUI. Ele vive na migration irmã
-- `..._analytics_outbox_cron.sql`, que só deve ser aplicada DEPOIS do deploy da
-- edge `analytics-outbox-drain` — senão o cron bate num 404 a cada 5 minutos e
-- o `cron.job_run_details = succeeded` (que só prova o ENQUEUE) esconde isso.
-- ============================================================

-- ------------------------------------------------------------
-- 1. A tabela — FILA, não arquivo
-- ------------------------------------------------------------
-- A verdade permanente já vive em `pedido_compra_sugerido` (registro de
-- negócio) e no PostHog (destino). Esta tabela só TRANSPORTA — por isso toda
-- linha nasce com data de expurgo (bloco 6) e por isso ela não replica o
-- payload do domínio.
CREATE TABLE IF NOT EXISTS public.analytics_outbox (
  id           bigserial   PRIMARY KEY,

  -- ⚠️ Este uuid vai TOP-LEVEL no payload do PostHog, como `uuid` — não como
  -- `$insert_id` em properties. Verificado em posthog.com/docs/data/events em
  -- 2026-08-25: "Events that share the same uuid, event name, timestamp, and
  -- distinct_id are treated as duplicates". Os QUATRO campos precisam ser
  -- idênticos no retry, por isso `ocorrido_em` também é persistido aqui em vez
  -- de recalculado no envio.
  event_id     uuid        NOT NULL DEFAULT gen_random_uuid(),

  evento       text        NOT NULL,

  -- casa com o identify(userId) do front (src/lib/analytics.ts): mesma pessoa,
  -- uma série só. Fato sem titular usa um id sintético 'sistema:<dominio>'.
  distinct_id  text        NOT NULL,

  -- SET NULL (não CASCADE): apagar o usuário não pode apagar a CONTAGEM do fato.
  user_id      uuid        NULL REFERENCES auth.users(id) ON DELETE SET NULL,

  props        jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- dedup na ORIGEM (o uuid cobre o destino; esta chave cobre a escrita)
  chave_dedup  text        NOT NULL,

  -- quando o FATO aconteceu. Nunca reescrito — é metade da chave de dedup do
  -- PostHog, e mexer nele faz o retry virar evento novo.
  ocorrido_em  timestamptz NOT NULL DEFAULT now(),

  -- ⚠️ `aceito_em`, NÃO "enviado"/"entregue": o PostHog responde 200 e ainda
  -- assim descarta evento inválido. Isto marca ACEITE HTTP, que é o máximo que
  -- o worker consegue observar — a ingestão de fato se confere na origem, pela
  -- view de reconciliação do bloco 5.
  aceito_em    timestamptz NULL,

  tentativas   smallint    NOT NULL DEFAULT 0,
  proxima_tentativa_em timestamptz NOT NULL DEFAULT now(),

  -- erro permanente (400/401/403/schema) ou orçamento de tentativas esgotado.
  -- Quarentena PARA de tentar e fica visível — não fica em loop nem some.
  quarentena_em timestamptz NULL,

  -- ⚠️ mensagem curta e SEM payload: tirar PII da outbox e conservá-la no
  -- campo de erro (ou no log) não minimiza nada.
  ultimo_erro  text        NULL,

  -- ⚠️ LGPD art. 16 (eliminação ao fim do tratamento): TODA linha nasce com
  -- data de expurgo. Não existe estado "fica para sempre" nesta tabela — nem o
  -- da linha defeituosa, que é justamente a que nunca vai atingir a finalidade.
  purgar_em    timestamptz NOT NULL DEFAULT (now() + interval '30 days'),

  CONSTRAINT analytics_outbox_chave_dedup_key UNIQUE (chave_dedup),
  -- mesma convenção do track() do front: <area>.<action>
  CONSTRAINT analytics_outbox_evento_formato CHECK (evento ~ '^[a-z0-9_]+\.[a-z0-9_]+$'),
  -- teto de payload: o ledger é gravável pelo usuário (bloco 4)
  CONSTRAINT analytics_outbox_props_teto CHECK (pg_column_size(props) <= 4096),
  CONSTRAINT analytics_outbox_chave_teto CHECK (length(chave_dedup) <= 200),
  CONSTRAINT analytics_outbox_erro_teto CHECK (ultimo_erro IS NULL OR length(ultimo_erro) <= 500)
);

-- Índice PARCIAL da fila: o worker só olha o elegível, e o índice ENCOLHE
-- conforme a fila drena, em vez de crescer com a tabela inteira.
CREATE INDEX IF NOT EXISTS idx_analytics_outbox_fila
  ON public.analytics_outbox (proxima_tentativa_em, id)
  WHERE aceito_em IS NULL AND quarentena_em IS NULL;

-- Índice da purga (bloco 6) — uma regra só, um índice só.
CREATE INDEX IF NOT EXISTS idx_analytics_outbox_purga
  ON public.analytics_outbox (purgar_em);

-- Titular → atende pedido de eliminação (LGPD art. 18).
CREATE INDEX IF NOT EXISTS idx_analytics_outbox_titular
  ON public.analytics_outbox (user_id)
  WHERE user_id IS NOT NULL;

-- ------------------------------------------------------------
-- 2. RLS — o front NUNCA fala com esta tabela diretamente
-- ------------------------------------------------------------
-- A única escrita do usuário é pela RPC do bloco 4 (SECURITY DEFINER), que
-- carimba auth.uid() e valida contra allowlist. Sem policy para authenticated,
-- RLS ligada nega tudo.
ALTER TABLE public.analytics_outbox ENABLE ROW LEVEL SECURITY;

-- ⚠️ CLAUDE.md: REVOKE FROM PUBLIC **não** tira anon/authenticated (o grant
-- deles é explícito, via ALTER DEFAULT PRIVILEGES do Supabase) — revogar
-- NOMEANDO as roles. Cinto-e-suspensório sobre a RLS.
REVOKE ALL ON public.analytics_outbox FROM anon;
REVOKE ALL ON public.analytics_outbox FROM authenticated;

-- Worker (edge/cron)
DROP POLICY IF EXISTS "analytics_outbox_service_all" ON public.analytics_outbox;
CREATE POLICY "analytics_outbox_service_all"
  ON public.analytics_outbox
  FOR ALL
  USING (auth.role() = 'service_role');

-- Master lê, para auditoria de divergência (bloco 5)
DROP POLICY IF EXISTS "analytics_outbox_master_read" ON public.analytics_outbox;
CREATE POLICY "analytics_outbox_master_read"
  ON public.analytics_outbox
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'master'::public.app_role
    )
  );

-- ------------------------------------------------------------
-- 3. Caminho (A) — fato de domínio, na MESMA transação
-- ------------------------------------------------------------
-- ⚠️ Estes eventos NÃO carregam pessoa, e isso é desenho, não descuido.
-- `pedido_compra_sugerido.aprovado_por` é `text` e guarda o E-MAIL (medido:
-- 139/139 linhas com o e-mail do founder). Resolver e-mail→uuid é AMBÍGUO —
-- `profiles` tem 402 e-mails duplicados, e o próprio aprovador tem 2 perfis —
-- então o distinct_id sairia não-determinístico. E mandar o e-mail cru seria
-- EXPORTAR PII para um processador nos EUA.
-- A pergunta que este funil responde é "quantos aprovados contra expirados",
-- não "quem aprovou" — e quem aprovou já está na tabela, legível por psql-ro.
-- Trade-off aceito e explícito: o PostHog não conta APROVADORES ÚNICOS aqui.
CREATE OR REPLACE FUNCTION public.analytics_outbox_pedido_compra()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_evento text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_evento := 'reposicao.sugestao_criada';
  ELSIF NEW.aprovado_em IS NOT NULL AND OLD.aprovado_em IS NULL THEN
    v_evento := 'reposicao.sugestao_aprovada';
  -- ⚠️ `IS DISTINCT FROM` e não `UPDATE OF status`: o Postgres dispara
  -- `UPDATE OF` mesmo quando o valor final não mudou.
  ELSIF NEW.status = 'expirado_sem_aprovacao' AND OLD.status IS DISTINCT FROM NEW.status THEN
    v_evento := 'reposicao.sugestao_expirada';
  ELSIF NEW.status = 'cancelado_humano' AND OLD.status IS DISTINCT FROM NEW.status THEN
    v_evento := 'reposicao.sugestao_cancelada';
  ELSE
    RETURN NULL;  -- AFTER trigger: o retorno é ignorado
  END IF;

  -- FAIL-OPEN deliberado: telemetria NUNCA reprova o money-path. Aprovar uma
  -- compra não pode falhar porque a outbox está indisponível.
  -- ⚠️ Isto deixa de ser outbox transacional ESTRITA, e a troca é declarada,
  -- não escondida. O que impede virar a "sonda que degrada em silêncio" do
  -- CLAUDE.md é a view do bloco 5: o silêncio é AUDITÁVEL contra a fonte, e a
  -- ausência ganha denominador. Fail-open SEM reconciliação seria a armadilha.
  BEGIN
    INSERT INTO public.analytics_outbox (evento, distinct_id, user_id, props, chave_dedup, ocorrido_em)
    VALUES (
      v_evento,
      'sistema:reposicao',
      NULL,
      jsonb_build_object(
        'sugestao_id',        NEW.id,
        'status',             NEW.status,
        'condicao_origem',    NEW.condicao_origem,
        'origem_evento_tipo', NEW.origem_evento_tipo,
        -- booleano, não o e-mail: diz SE houve humano, sem dizer QUEM.
        'aprovacao_humana',   (NEW.aprovado_por IS NOT NULL)
      ),
      -- ⚠️ a chave inclui o EVENTO, não só o id: um pedido passa por criada →
      -- aprovada → (expirada|cancelada) e cada transição é uma linha. Chavear
      -- só por id engoliria o funil inteiro depois do primeiro evento.
      'pcs:' || NEW.id::text || ':' || v_evento,
      now()
    )
    ON CONFLICT (chave_dedup) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[analytics_outbox] evento % do pedido % perdido (fail-open): % / %',
      v_evento, NEW.id, SQLSTATE, SQLERRM;
  END;

  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_analytics_outbox_pedido_compra ON public.pedido_compra_sugerido;
CREATE TRIGGER trg_analytics_outbox_pedido_compra
  AFTER INSERT OR UPDATE ON public.pedido_compra_sugerido
  FOR EACH ROW
  EXECUTE FUNCTION public.analytics_outbox_pedido_compra();

-- ------------------------------------------------------------
-- 4. Caminho (B) — ledger autenticado (jornada SEM mutação de domínio)
-- ------------------------------------------------------------
-- UM ledger, não 111 tabelas espelho. O usuário NUNCA passa a própria
-- identidade: ela vem de auth.uid(). É o que impede forjar evento de terceiro.
--
-- ⚠️ Honestidade do nome: o evento é `mixgap_servido`, não `mixgap_visto`. O
-- servidor prova que ENTREGOU a informação; percepção humana ele não consegue
-- provar, e um nome que afirma "visto" é uma garantia sem teste. O
-- `carteira.mixgap_visto` client-side continua existindo — e continua sendo
-- alegação do cliente, agora só por um canal censurável.
CREATE OR REPLACE FUNCTION public.analytics_ledger_registrar(
  p_evento text,
  p_chave  text,
  p_props  jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_dia  text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD');
BEGIN
  -- SECURITY DEFINER bypassa RLS ⇒ o gate vive AQUI, na fronteira.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'analytics_ledger_registrar: exige usuario autenticado'
      USING ERRCODE = '28000';
  END IF;

  -- Allowlist FECHADA: o ledger não é canal genérico de escrita no banco.
  IF p_evento NOT IN ('carteira.mixgap_servido') THEN
    RAISE EXCEPTION 'analytics_ledger_registrar: evento % fora da allowlist', p_evento
      USING ERRCODE = '22023';
  END IF;

  IF pg_column_size(coalesce(p_props, '{}'::jsonb)) > 2048 THEN
    RAISE EXCEPTION 'analytics_ledger_registrar: props acima do teto'
      USING ERRCODE = '22023';
  END IF;

  -- Teto por titular/dia — guard contra flood por chave variada. Silencioso de
  -- propósito: telemetria nunca quebra a tela de quem está trabalhando.
  IF (
    SELECT count(*) FROM public.analytics_outbox
    WHERE user_id = v_uid AND ocorrido_em > now() - interval '1 day'
  ) >= 500 THEN
    RETURN;
  END IF;

  INSERT INTO public.analytics_outbox (evento, distinct_id, user_id, props, chave_dedup)
  VALUES (
    p_evento,
    v_uid::text,                       -- casa com identify(userId) do front
    v_uid,
    coalesce(p_props, '{}'::jsonb),
    -- left() protege o teto do CHECK e do índice B-tree; o dia fecha a janela
    -- de dedup (mesmo estado revisto amanhã é sinal NOVO, não repetição).
    'ledger:' || v_uid::text || ':' || p_evento || ':' || left(coalesce(p_chave, ''), 100) || ':' || v_dia
  )
  ON CONFLICT (chave_dedup) DO NOTHING;
END;
$fn$;

-- ⚠️ CLAUDE.md: revogar NOMEANDO as roles — FROM PUBLIC não tira anon.
-- (E função nova nasce com EXECUTE para PUBLIC por padrão.)
REVOKE ALL ON FUNCTION public.analytics_ledger_registrar(text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_ledger_registrar(text, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.analytics_ledger_registrar(text, text, jsonb) TO authenticated;

-- ------------------------------------------------------------
-- 5. Reconciliação — o que torna o fail-open do bloco 3 auditável
-- ------------------------------------------------------------
-- Sem isto, um trigger quebrado some em silêncio e o funil parece só "baixo".
-- Com isto, a ausência tem denominador: a fonte de negócio é o numerador
-- esperado, e divergência ≠ 0 é trigger falhando.
--
-- ⚠️ LIMITE HONESTO desta view: `pedido_compra_sugerido` é ESTADO ATUAL, não
-- histórico de transições. `aprovado_em` é um timestamp próprio e imutável, e
-- por isso a linha `aprovada` reconcilia de verdade. Já a expiração não tem
-- timestamp dedicado — ela usa `atualizado_em`, que qualquer UPDATE posterior
-- reescreve. Logo a linha `expirada` é INDICATIVA, não prova: um pedido
-- expirado e depois tocado de novo sai da janela e some do numerador esperado.
-- Corrigir isso exige um timestamp `expirado_em` no domínio — fora do escopo
-- deste PR, registrado de propósito em vez de fingido.
--
-- ⚠️ security_invoker=on: a view lê com a RLS de QUEM consulta, não do owner.
-- Omitir a opção num CREATE OR REPLACE futuro RESETA para OWNER e bypassa RLS
-- (falha ABERTA que o CI não vê) — repetir o WITH em TODO replace.
CREATE OR REPLACE VIEW public.analytics_outbox_reconciliacao
WITH (security_invoker = on) AS
SELECT
  'reposicao.sugestao_aprovada'::text AS evento,
  'prova'::text                       AS confianca,
  (SELECT count(*) FROM public.pedido_compra_sugerido
    WHERE aprovado_em > now() - interval '7 days')          AS na_fonte,
  (SELECT count(*) FROM public.analytics_outbox
    WHERE evento = 'reposicao.sugestao_aprovada'
      AND ocorrido_em > now() - interval '7 days')          AS na_outbox
UNION ALL
SELECT
  'reposicao.sugestao_expirada',
  'indicativa',   -- ver LIMITE HONESTO acima: atualizado_em é mutável
  (SELECT count(*) FROM public.pedido_compra_sugerido
    WHERE status = 'expirado_sem_aprovacao'
      AND atualizado_em > now() - interval '7 days'),
  (SELECT count(*) FROM public.analytics_outbox
    WHERE evento = 'reposicao.sugestao_expirada'
      AND ocorrido_em > now() - interval '7 days');

-- ⚠️ NÃO conceder a `authenticated`, e o motivo é o inverso do intuitivo.
-- Com `security_invoker=on` a view lê sob a RLS de quem consulta, e a policy da
-- outbox só deixa `master` ler. Um employee consultando veria `na_fonte = 44` e
-- `na_outbox = 0` — zero por FALTA DE PERMISSÃO, com cara de trigger quebrado.
-- É o sensor que colapsa dois estados num só (ausência de dado × ausência de
-- fato), a classe que o repo mais paga caro. Reconciliação é ferramenta de
-- operador: lê-se pelo `psql-ro` ou pelo SQL Editor, onde o privilégio existe.
REVOKE ALL ON public.analytics_outbox_reconciliacao FROM anon;
REVOKE ALL ON public.analytics_outbox_reconciliacao FROM authenticated;

-- ------------------------------------------------------------
-- 6. Retenção — LGPD art. 6º III (necessidade) e art. 16 (eliminação)
-- ------------------------------------------------------------
-- Decisão do ritual Codex (2026-08-25). A outbox é TRANSPORTE, não arquivo:
--   • aceito pelo PostHog → 7 dias (cobre reconciliação diária e reparo)
--   • pendente/retry      → teto de 30 dias desde a CRIAÇÃO, não desde a
--                           última tentativa (senão o retry renova o prazo
--                           para sempre)
--   • quarentena          → o mesmo teto de 30 dias já herdado do default
--
-- ⚠️ A posição inicial — "linha não enviada NUNCA é purgada" — foi REFUTADA e
-- fica registrada como tal: um payload inválido ou uma credencial errada nunca
-- vão atingir a finalidade, e guardá-los indefinidamente não transforma falha
-- em necessidade. Fica a linha mais defeituosa retida para sempre, que é o
-- oposto de minimização. Por isso `purgar_em` é NOT NULL: nesta tabela não
-- existe estado "fica para sempre".
--
-- Uma extensão além do teto é decisão humana, e passa por alterar `purgar_em`
-- explicitamente — não por acidente de retry.
CREATE OR REPLACE FUNCTION public.analytics_outbox_purgar()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_removidas integer;
BEGIN
  DELETE FROM public.analytics_outbox WHERE purgar_em < now();
  GET DIAGNOSTICS v_removidas = ROW_COUNT;
  RETURN v_removidas;
END;
$fn$;

REVOKE ALL ON FUNCTION public.analytics_outbox_purgar() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_outbox_purgar() FROM anon;
REVOKE ALL ON FUNCTION public.analytics_outbox_purgar() FROM authenticated;

SELECT cron.unschedule('analytics-outbox-purgar')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'analytics-outbox-purgar');

SELECT cron.schedule(
  'analytics-outbox-purgar',
  '20 4 * * *',   -- 04:20, fora da janela do purge-cron-job-run-details (04:00)
  $$ SELECT public.analytics_outbox_purgar() $$
);

-- ------------------------------------------------------------
-- 7. API do worker — claim atômico, aceite e quarentena
-- ------------------------------------------------------------
-- A regra de retenção mora AQUI, no banco, e não espalhada no worker: um só
-- lugar decide por quanto tempo o dado pessoal fica.
--
-- ⚠️ O claim empurra `proxima_tentativa_em` ANTES do HTTP. Isso é o lease: se o
-- worker morrer no meio da requisição, a linha volta sozinha à fila depois do
-- backoff em vez de ficar presa — e `FOR UPDATE SKIP LOCKED` impede que duas
-- execuções sobrepostas do cron reivindiquem a mesma linha (o padrão que o
-- Postgres documenta para tabela-fila). Sem coluna de worker_id: com este
-- volume, o lease implícito basta, e cada estado a mais é um estado a errar.
CREATE OR REPLACE FUNCTION public.analytics_outbox_claim(p_limite integer DEFAULT 200)
RETURNS TABLE (
  id           bigint,
  event_id     uuid,
  evento       text,
  distinct_id  text,
  props        jsonb,
  ocorrido_em  timestamptz,
  tentativas   smallint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
-- ⚠️ SEM esta diretiva a função COMPILA e quebra só EXECUTANDO, com
-- "column reference tentativas is ambiguous" — pego pela prova PG17
-- (db/test-analytics-outbox.sh) em 2026-08-25. Cada nome do `RETURNS TABLE`
-- vira uma variável OUT que colide com a coluna homônima no SET/WHERE, e o
-- plpgsql é late-bound: `CREATE OR REPLACE` não reclama, e o erro só apareceria
-- no cron — onde `job_run_details = succeeded` (que prova o ENQUEUE) o esconde.
-- Esta função não usa as OUT como variáveis em lugar nenhum, então resolver
-- sempre a favor da COLUNA é o que se quer — e mantém os nomes de saída limpos
-- para o PostgREST, que um prefixo `r_` estragaria.
#variable_conflict use_column
BEGIN
  -- Orçamento esgotado vira quarentena com motivo — não fica em loop infinito
  -- nem desaparece. `purgar_em` já garante que a quarentena também expira.
  UPDATE public.analytics_outbox
     SET quarentena_em = now(),
         ultimo_erro   = coalesce(ultimo_erro, 'orcamento de tentativas esgotado')
   WHERE aceito_em IS NULL AND quarentena_em IS NULL AND tentativas >= 8;

  RETURN QUERY
  UPDATE public.analytics_outbox o
     SET tentativas = o.tentativas + 1,
         -- backoff exponencial 3^n minutos, teto de 4h
         proxima_tentativa_em =
           now() + (interval '1 minute' * least(power(3, o.tentativas)::integer, 240))
   WHERE o.id IN (
     SELECT o2.id
       FROM public.analytics_outbox o2
      WHERE o2.aceito_em IS NULL
        AND o2.quarentena_em IS NULL
        AND o2.proxima_tentativa_em <= now()
      ORDER BY o2.proxima_tentativa_em, o2.id
      LIMIT greatest(1, least(p_limite, 500))
      FOR UPDATE SKIP LOCKED
   )
  RETURNING o.id, o.event_id, o.evento, o.distinct_id, o.props, o.ocorrido_em, o.tentativas;
END;
$fn$;

-- Aceite HTTP: encurta a retenção de 30 para 7 dias. É aqui que a decisão do
-- ritual Codex vira efeito — e o nome diz ACEITO, não entregue.
CREATE OR REPLACE FUNCTION public.analytics_outbox_aceitar(p_ids bigint[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.analytics_outbox
     SET aceito_em   = now(),
         ultimo_erro = NULL,
         purgar_em   = now() + interval '7 days'
   WHERE id = ANY(p_ids) AND aceito_em IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$fn$;

-- Erro permanente (400/401/403/schema): para de tentar, fica visível, expira.
-- ⚠️ o erro é TRUNCADO e nunca carrega payload: tirar PII da outbox e
-- conservá-la no campo de erro não minimiza nada.
CREATE OR REPLACE FUNCTION public.analytics_outbox_quarentena(p_ids bigint[], p_erro text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.analytics_outbox
     SET quarentena_em = now(),
         ultimo_erro   = left(coalesce(p_erro, 'erro permanente'), 500)
   WHERE id = ANY(p_ids) AND aceito_em IS NULL AND quarentena_em IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$fn$;

-- Falha transitória: só registra o motivo. O backoff já foi aplicado no claim.
CREATE OR REPLACE FUNCTION public.analytics_outbox_falhar(p_ids bigint[], p_erro text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.analytics_outbox
     SET ultimo_erro = left(coalesce(p_erro, 'erro transitorio'), 500)
   WHERE id = ANY(p_ids) AND aceito_em IS NULL AND quarentena_em IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$fn$;

-- Só o worker (service_role) chama estas quatro. `authenticated` e `anon` não
-- têm nada que fazer aqui — e função nova nasce com EXECUTE para PUBLIC.
REVOKE ALL ON FUNCTION public.analytics_outbox_claim(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_outbox_claim(integer) FROM anon;
REVOKE ALL ON FUNCTION public.analytics_outbox_claim(integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.analytics_outbox_aceitar(bigint[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_outbox_aceitar(bigint[]) FROM anon;
REVOKE ALL ON FUNCTION public.analytics_outbox_aceitar(bigint[]) FROM authenticated;
REVOKE ALL ON FUNCTION public.analytics_outbox_quarentena(bigint[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_outbox_quarentena(bigint[], text) FROM anon;
REVOKE ALL ON FUNCTION public.analytics_outbox_quarentena(bigint[], text) FROM authenticated;
REVOKE ALL ON FUNCTION public.analytics_outbox_falhar(bigint[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_outbox_falhar(bigint[], text) FROM anon;
REVOKE ALL ON FUNCTION public.analytics_outbox_falhar(bigint[], text) FROM authenticated;
