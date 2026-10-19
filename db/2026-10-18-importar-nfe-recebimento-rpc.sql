-- ============================================================
-- importar_nfe_recebimento — materialização ATÔMICA do recebimento de NF-e (cabeçalho + itens)
-- Money-path: entrada de mercadoria. Fecha as duas corridas que o PR #3142 (omie-nfe-webhook v1.3)
-- deixou abertas DE PROPÓSITO por exigirem migration:
--   (1) webhook × sync na MESMA chave de acesso: a sync gravava itens com id aleatório, e a PK
--       determinística do webhook não a barrava → 2N itens possíveis;
--   (2) `omie-nfe-reconcile` promovendo `pendente → efetivado` ENTRE a leitura do guard e o insert
--       dos itens → itens injetados em recebimento já efetivado.
-- Desenho (2ª opinião Codex 2026-10-18, que REPROVOU a v1 — ver docs/historico/
-- nfe-recebimento-rpc-transacional.md): UMA transação (lock consultivo por chave + FOR UPDATE no
-- cabeçalho + cabeçalho e lote no mesmo commit), idempotente no reenvio. Webhook E sync chamam SÓ
-- esta RPC — 1 writer de itens. "Já importada" só com o MESMO CONJUNTO (sequência, código,
-- quantidade): cardinalidade igual não é certificado. Lote vazio nunca cria cabeçalho (NFE03): o
-- recebimento pendente sem itens é invisível para a conferência, e a transação não evita o órfão
-- que o contrato aceitasse como sucesso. Falha determinística (NFE0x, tipo que não cabe) tem
-- registro DURÁVEL em `nfe_importacao_falhas`, gravado pelas edges FORA da transação abortada —
-- com rollback total a NF-e inválida voltaria a parecer inédita e a consumir a única consulta da
-- rodada do cron; a RPC apaga o registro no sucesso (mesma transação).
-- Prova executada: db/test-importar-nfe-recebimento.sh (PG17, 2 conexões com barreira observada,
-- falsificação). Runbook: docs/runbooks/importar-nfe-recebimento-rpc.md.
--
-- APLICAÇÃO: `bun run db:aplicar db/2026-10-18-importar-nfe-recebimento-rpc.sql` (SEM BEGIN/COMMIT
-- aqui: a transação é do executor, que recusa envelope) — ou, pelo SQL Editor do Lovable, colar
-- `BEGIN;` + este arquivo inteiro + `COMMIT;` (o runbook tem o bloco pronto). Idempotente: re-rodar
-- com o MESMO arquivo é no-op; com o corpo da função DIFERENTE do que vive em prod, a PÓS aborta.
--
-- Pré-voo prod (psql-ro, 2026-10-18 ~21:00 UTC): 0 duplicatas em (nfe_recebimento_id, sequencia)
-- sobre 133 itens / 72 cabeçalhos; função, tabela de falhas e coluna `origem` inexistentes; RLS
-- ligada nas 2 tabelas; os 4 `pendente` sem itens têm os 4 sinais de uso NULL (reparáveis).
-- ============================================================

-- ── 1. Origem do cabeçalho (o DENOMINADOR "cabeçalhos criados pelo webhook") + quem reparou ────
-- `origem` = quem CRIOU o cabeçalho; NULL = criado antes do sensor. NÃO há backfill: ausente ≠
-- fabricado (os 72 de hoje vieram da sync por inferência — 0/72 com xml/omie_nfe_id —, e inferência
-- não vira coluna). Reparo não reescreve a origem: fica em `reparada_origem`/`reparada_em`.
ALTER TABLE public.nfe_recebimentos ADD COLUMN IF NOT EXISTS origem text;
ALTER TABLE public.nfe_recebimentos ADD COLUMN IF NOT EXISTS reparada_origem text;
ALTER TABLE public.nfe_recebimentos ADD COLUMN IF NOT EXISTS reparada_em timestamptz;

DO $ddl$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.nfe_recebimentos'::regclass AND conname = 'nfe_recebimentos_origem_check'
  ) THEN
    ALTER TABLE public.nfe_recebimentos
      ADD CONSTRAINT nfe_recebimentos_origem_check
      CHECK (origem IS NULL OR origem IN ('webhook', 'sync', 'importacao_chave'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.nfe_recebimentos'::regclass AND conname = 'nfe_recebimentos_reparada_origem_check'
  ) THEN
    ALTER TABLE public.nfe_recebimentos
      ADD CONSTRAINT nfe_recebimentos_reparada_origem_check
      CHECK (reparada_origem IS NULL OR reparada_origem IN ('webhook', 'sync', 'importacao_chave'));
  END IF;
END
$ddl$;

COMMENT ON COLUMN public.nfe_recebimentos.origem IS
  'Quem CRIOU o cabeçalho: webhook (omie-nfe-webhook), sync (cron da omie-nfe-recebimento-sync), importacao_chave (botão Importar NF-e). NULL = anterior ao sensor (2026-10-18) — ou criado por bundle antigo durante a troca de versões.';
COMMENT ON COLUMN public.nfe_recebimentos.reparada_origem IS
  'Quem COMPLETOU os itens de um cabeçalho que ficou sem itens (importar_nfe_recebimento → reparada). A origem de criação não muda.';

-- ── 2. UNIQUE (nfe_recebimento_id, sequencia): dois lotes do mesmo recebimento nunca coexistem ───
-- Defesa em profundidade atrás do lock: se um writer fora da RPC gravar o 2º lote, a constraint o
-- barra (0 ou N, nunca 2N). Pré-voo: 0 duplicatas hoje. `nItem` é a identidade fiscal do detalhe
-- (MOC, pk_nItem) e `nSequencia` é o sequencial do item do recebimento no Omie: repetido não é
-- desdobramento legítimo — é NFE02 na RPC.
DO $ddl$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.nfe_recebimento_itens'::regclass
      AND conname = 'nfe_recebimento_itens_recebimento_sequencia_key'
  ) THEN
    ALTER TABLE public.nfe_recebimento_itens
      ADD CONSTRAINT nfe_recebimento_itens_recebimento_sequencia_key
      UNIQUE (nfe_recebimento_id, sequencia);
  END IF;
END
$ddl$;

-- ── 3. Registro DURÁVEL de falha de importação (fora da transação abortada) ─────────────────────
-- Uma linha por chave: a edge faz upsert (tentativas+1) quando a RPC falha por erro de dado; a RPC
-- apaga a linha quando a chave importa (mesma transação). A triagem do cron PULA a chave com
-- tentativas ≥ 3 (a fila anda; a NF-e fica visível aqui, não some) e o botão "Importar NF-e" ignora
-- o estacionamento (é o reprocessamento humano). `bloqueada`/`divergente` NÃO entram: são estados
-- do próprio cabeçalho, já visíveis.
CREATE TABLE IF NOT EXISTS public.nfe_importacao_falhas (
  chave_acesso   varchar(44) PRIMARY KEY CHECK (chave_acesso ~ '^[0-9]{44}$'),
  warehouse_id   uuid REFERENCES public.warehouses(id),
  omie_id_receb  bigint,
  origem         text NOT NULL CHECK (origem IN ('webhook', 'sync', 'importacao_chave')),
  sqlstate       text,
  erro           text NOT NULL,
  tentativas     integer NOT NULL DEFAULT 1 CHECK (tentativas > 0),
  primeira_em    timestamptz NOT NULL DEFAULT now(),
  ultima_em      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.nfe_importacao_falhas IS
  'NF-e cuja importação (importar_nfe_recebimento) falhou por erro de DADO (NFE0x, tipo que não cabe). Escrita pelas edges fora da transação abortada; apagada pela RPC no sucesso. tentativas ≥ 3 estaciona a chave na triagem do cron. 2026-10-18.';

ALTER TABLE public.nfe_importacao_falhas ENABLE ROW LEVEL SECURITY;
-- Privilégio de TABELA explícito (policy não concede privilégio). Na prod a tabela NASCE com os
-- DEFAULT PRIVILEGES do Supabase (anon/authenticated/service_role com ALL) — medido no ensaio do
-- db:aplicar (A11 abortou): por isso REVOKE ALL antes do GRANT estreito. As edges (service_role)
-- escrevem, staff (authenticated, filtrado por policy) só lê, anon nada.
REVOKE ALL ON public.nfe_importacao_falhas FROM PUBLIC;
REVOKE ALL ON public.nfe_importacao_falhas FROM anon;
REVOKE ALL ON public.nfe_importacao_falhas FROM authenticated;
GRANT SELECT ON public.nfe_importacao_falhas TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.nfe_importacao_falhas TO service_role;

-- Mesmo molde das policies de nfe_recebimentos (medido em prod): service_role tudo, staff lê.
DROP POLICY IF EXISTS "Service role full access nfe_importacao_falhas" ON public.nfe_importacao_falhas;
CREATE POLICY "Service role full access nfe_importacao_falhas"
  ON public.nfe_importacao_falhas FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Staff can view nfe_importacao_falhas" ON public.nfe_importacao_falhas;
CREATE POLICY "Staff can view nfe_importacao_falhas"
  ON public.nfe_importacao_falhas FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role));

-- ── 4. TRAVA → PRE anti-deriva (recriar objeto vivo: database.md §2) ────────────────────────────
-- Hoje a função não existe em prod (pré-voo). Se um dia existir com corpo DIFERENTE deste arquivo
-- (alguém a evoluiu por outro caminho), a PÓS aborta a transação inteira — "a última a recriar
-- vence" não pode apagar ninguém em silêncio. Re-rodar este MESMO arquivo passa (md5 igual).
DO $pre$
DECLARE
  v_oid oid := to_regprocedure('public.importar_nfe_recebimento(jsonb, jsonb, text)');
  v_md5 text := '';
BEGIN
  IF v_oid IS NOT NULL THEN
    -- A trava: reescrever a linha de pg_proc prende o CREATE concorrente até o nosso commit.
    ALTER FUNCTION public.importar_nfe_recebimento(jsonb, jsonb, text) SET search_path TO 'public', 'pg_temp';
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_oid;
  END IF;
  PERFORM set_config('importar_nfe_recebimento.md5_antes', v_md5, true);
END
$pre$;

-- ── 5. A RPC ───────────────────────────────────────────────────────────────────────────────────
-- SECURITY INVOKER: quem chama é a service_role das edges (bypassa RLS por papel, não por DEFINER).
-- Executável SÓ pela service_role (REVOKE em PUBLIC, anon e authenticated — as três pontas).
-- "1 writer" é propriedade do CÓDIGO implantado, não da ACL: a service_role continua podendo
-- inserir direto nas tabelas — é a UNIQUE que segura esse caso.
CREATE OR REPLACE FUNCTION public.importar_nfe_recebimento(
  p_cabecalho jsonb,
  p_itens     jsonb,
  p_origem    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_chave       text;
  v_n           integer;
  v_sem_seq     integer;
  v_repetidas   integer;
  v_cab         public.nfe_recebimentos%ROWTYPE;
  v_novo        public.nfe_recebimentos%ROWTYPE;
  v_id          uuid;
  v_existentes  integer;
  v_diferentes  integer;
  v_resultado   text;
  v_inserir     boolean := false;
  v_motivo      text;
BEGIN
  -- Entrada inválida é NFE01: determinístico, reenviar o MESMO payload não conserta. A edge responde
  -- 4xx com o motivo e registra em nfe_importacao_falhas (o Omie tenta 3× e manda à DLQ por 5 dias
  -- em QUALQUER não-2xx — o registro durável é nosso, não dele).
  IF p_origem IS NULL OR p_origem NOT IN ('webhook', 'sync', 'importacao_chave') THEN
    RAISE EXCEPTION 'importar_nfe_recebimento: origem invalida (%)', coalesce(p_origem, 'NULL')
      USING ERRCODE = 'NFE01';
  END IF;
  IF p_cabecalho IS NULL OR jsonb_typeof(p_cabecalho) <> 'object' THEN
    RAISE EXCEPTION 'importar_nfe_recebimento: cabecalho precisa ser um objeto JSON'
      USING ERRCODE = 'NFE01';
  END IF;
  v_chave := p_cabecalho ->> 'chave_acesso';
  IF v_chave IS NULL OR v_chave !~ '^[0-9]{44}$' THEN
    RAISE EXCEPTION 'importar_nfe_recebimento: chave_acesso invalida — sao 44 digitos'
      USING ERRCODE = 'NFE01';
  END IF;
  -- NULL SQL e `null` JSON valem "sem itens"; qualquer outra coisa que não seja array é NFE01.
  IF p_itens IS NULL OR jsonb_typeof(p_itens) = 'null' THEN
    p_itens := '[]'::jsonb;
  END IF;
  IF jsonb_typeof(p_itens) <> 'array' THEN
    RAISE EXCEPTION 'importar_nfe_recebimento: itens precisa ser um array JSON'
      USING ERRCODE = 'NFE01';
  END IF;
  v_n := jsonb_array_length(p_itens);
  -- Lote vazio NÃO materializa nem CERTIFICA recebimento: cabeçalho sem itens é NF-e invisível para a
  -- conferência, e 2xx diria ao Omie "pode descartar o evento". Vale para chave nova E existente
  -- (parecer adversarial: "já importada" com payload vazio era a exceção ao certificado por conjunto).
  IF v_n = 0 THEN
    RAISE EXCEPTION 'importar_nfe_recebimento: lote sem itens nao materializa nem certifica recebimento'
      USING ERRCODE = 'NFE03';
  END IF;

  -- Sequência: obrigatória em cada item e ÚNICA no payload. (`e ->> 'sequencia'` ausente é NULL: o
  -- coalesce é o que faz "ausente" contar como inválida. Número em string — "3", como o nItem do
  -- XML — vale, e "01" é o MESMO 1: a comparação é numérica.) Repetida é NFE02 — não se fabrica
  -- sequência (ocorrência/posição) para caber na UNIQUE: quem decide é quem olha a NF-e.
  SELECT count(*) FILTER (WHERE coalesce(e ->> 'sequencia', '') !~ '^[0-9]+$')
    INTO v_sem_seq
    FROM jsonb_array_elements(p_itens) AS e;
  IF v_sem_seq > 0 THEN
    RAISE EXCEPTION 'importar_nfe_recebimento: item sem sequencia numerica' USING ERRCODE = 'NFE01';
  END IF;
  SELECT count(*) - count(DISTINCT (e ->> 'sequencia')::bigint)
    INTO v_repetidas
    FROM jsonb_array_elements(p_itens) AS e;
  IF v_repetidas > 0 THEN
    RAISE EXCEPTION 'importar_nfe_recebimento: sequencia repetida no payload (% repeticoes)', v_repetidas
      USING ERRCODE = 'NFE02';
  END IF;

  -- Serializa TODOS os writers desta chave — inclusive quando o cabeçalho ainda não existe (aí não há
  -- linha para o FOR UPDATE prender). Namespace próprio para não colidir com outros usos consultivos.
  PERFORM pg_advisory_xact_lock(hashtext('nfe_recebimento'), hashtext(v_chave));

  -- FOR UPDATE: o reconcile (UPDATE … WHERE status='pendente') espera o nosso commit; se ele commitou
  -- antes, lemos a versão promovida (READ COMMITTED relê a tupla ao travar) e caímos em `bloqueada`.
  SELECT * INTO v_cab FROM public.nfe_recebimentos WHERE chave_acesso = v_chave FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.nfe_recebimentos (
      warehouse_id, numero_nfe, serie_nfe, chave_acesso, cnpj_emitente, razao_social_emitente,
      data_emissao, valor_total, xml_completo, status, omie_nfe_id, omie_id_receb, origem
    )
    SELECT c.warehouse_id, c.numero_nfe, c.serie_nfe, v_chave, c.cnpj_emitente, c.razao_social_emitente,
           c.data_emissao, c.valor_total, c.xml_completo, 'pendente', c.omie_nfe_id, c.omie_id_receb, p_origem
      FROM jsonb_populate_record(NULL::public.nfe_recebimentos, p_cabecalho) AS c
    RETURNING id INTO v_id;
    v_resultado := 'importada';
    v_inserir   := true;
  ELSE
    v_id := v_cab.id;
    SELECT count(*) INTO v_existentes FROM public.nfe_recebimento_itens WHERE nfe_recebimento_id = v_id;
    -- O payload fala do MESMO recebimento? Armazém e id do recebimento no Omie compatíveis (NULL de um
    -- lado é metadado ausente, não conflito). Vale ANTES de qualquer sucesso — reparo OU certificado:
    -- conjunto igual com cabeçalho de outro armazém não é "já importada". Conflito é divergência.
    SELECT * INTO v_novo FROM jsonb_populate_record(NULL::public.nfe_recebimentos, p_cabecalho);
    IF (v_novo.warehouse_id IS NOT NULL AND v_novo.warehouse_id IS DISTINCT FROM v_cab.warehouse_id)
       OR (v_novo.omie_id_receb IS NOT NULL AND v_cab.omie_id_receb IS NOT NULL
           AND v_novo.omie_id_receb IS DISTINCT FROM v_cab.omie_id_receb) THEN
      RETURN jsonb_build_object('resultado', 'divergente', 'id', v_id, 'itens', v_existentes, 'esperados', v_n,
                                'motivo', 'cabecalho de outro armazem ou outro recebimento do Omie');
    END IF;
    IF v_existentes = 0 THEN
      -- Reparável = ainda não entrou na conferência/efetivação e ninguém o tocou (os 4 sinais NULL).
      IF NOT (v_cab.status = 'pendente'
              AND v_cab.conferente_id IS NULL AND v_cab.conferido_at IS NULL
              AND v_cab.efetivado_at IS NULL AND v_cab.efetivacao_lock_at IS NULL) THEN
        v_motivo := CASE WHEN v_cab.status IS DISTINCT FROM 'pendente' THEN 'status ' || v_cab.status
                         ELSE 'em uso (conferencia ou efetivacao em curso)' END;
        RETURN jsonb_build_object('resultado', 'bloqueada', 'id', v_id, 'itens', 0, 'motivo', v_motivo);
      END IF;
      -- Metadados AUSENTES no cabeçalho são preenchidos pelo payload (procedência: o mesmo lock e o
      -- mesmo Omie); os presentes não mudam.
      UPDATE public.nfe_recebimentos
         SET omie_id_receb   = coalesce(omie_id_receb, v_novo.omie_id_receb),
             omie_nfe_id     = coalesce(omie_nfe_id, v_novo.omie_nfe_id),
             xml_completo    = coalesce(xml_completo, v_novo.xml_completo),
             reparada_origem = p_origem,
             reparada_em     = now()
       WHERE id = v_id;
      v_resultado := 'reparada';
      v_inserir   := true;
    ELSE
      -- Com itens gravados, "já importada" exige o MESMO CONJUNTO (sequência, código do produto,
      -- quantidade da NF-e) — cardinalidade igual com conteúdo diferente é outra obrigação de
      -- conferência. Diferença em qualquer direção é `divergente`: não apaga, não completa, não
      -- certifica.
      WITH payload AS (
        SELECT r.sequencia, btrim(coalesce(r.codigo_produto, '')) AS codigo, r.quantidade_nfe
          FROM jsonb_populate_recordset(NULL::public.nfe_recebimento_itens, p_itens) AS r
      ), banco AS (
        SELECT i.sequencia, btrim(coalesce(i.codigo_produto, '')) AS codigo, i.quantidade_nfe
          FROM public.nfe_recebimento_itens AS i
         WHERE i.nfe_recebimento_id = v_id
      )
      SELECT count(*) INTO v_diferentes
        FROM ((TABLE payload EXCEPT TABLE banco) UNION ALL (TABLE banco EXCEPT TABLE payload)) AS d;
      IF v_existentes IS DISTINCT FROM v_n OR v_diferentes > 0 THEN
        RETURN jsonb_build_object('resultado', 'divergente', 'id', v_id, 'itens', v_existentes, 'esperados', v_n,
                                  'motivo', CASE WHEN v_existentes IS DISTINCT FROM v_n THEN 'cardinalidade' ELSE 'conteudo dos itens' END);
      END IF;
      RETURN jsonb_build_object('resultado', 'ja_importada', 'id', v_id, 'itens', v_existentes);
    END IF;
  END IF;

  IF v_inserir THEN
    -- Colunas explícitas: chave desconhecida no JSON (id, nfe_recebimento_id, …) é ignorada; o `id`
    -- vem do default. Conferência nasce zerada e pendente — o payload não manda nisso. Tipo que não
    -- cabe (ncm > 8, descricao NULL) aborta a transação INTEIRA: nunca cabeçalho sem itens.
    INSERT INTO public.nfe_recebimento_itens (
      nfe_recebimento_id, sequencia, codigo_produto, descricao, ncm, ean, unidade_nfe, quantidade_nfe,
      valor_unitario, valor_total, unidade_estoque, quantidade_convertida, quantidade_conferida,
      quantidade_esperada, status_item, produto_omie_id
    )
    SELECT v_id, r.sequencia, r.codigo_produto, r.descricao, r.ncm, r.ean, r.unidade_nfe, r.quantidade_nfe,
           r.valor_unitario, r.valor_total, r.unidade_estoque, r.quantidade_convertida, 0,
           r.quantidade_esperada, 'pendente', r.produto_omie_id
      FROM jsonb_populate_recordset(NULL::public.nfe_recebimento_itens, p_itens) AS r;
    -- A chave importou: o registro de falha (se houver) sai na MESMA transação.
    DELETE FROM public.nfe_importacao_falhas WHERE chave_acesso = v_chave;
  END IF;

  RETURN jsonb_build_object('resultado', v_resultado, 'id', v_id, 'itens', v_n);
END
$fn$;

COMMENT ON FUNCTION public.importar_nfe_recebimento(jsonb, jsonb, text) IS
  'Materializa NF-e (cabeçalho + itens) numa transação, com lock por chave de acesso. Idempotente no reenvio: importada | reparada | ja_importada (mesmo conjunto de itens) | bloqueada | divergente. NFE01 = entrada inválida, NFE02 = sequência repetida, NFE03 = lote vazio (não materializa nem certifica). Único writer de nfe_recebimento_itens (webhook e sync). 2026-10-18.';

REVOKE ALL ON FUNCTION public.importar_nfe_recebimento(jsonb, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.importar_nfe_recebimento(jsonb, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.importar_nfe_recebimento(jsonb, jsonb, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.importar_nfe_recebimento(jsonb, jsonb, text) TO service_role;

-- ── 5b. Registro de falha: `tentativas + 1` ATÔMICO (um upsert do PostgREST não incrementa) ─────
-- Chamada pelas edges FORA da transação abortada da RPC acima. Devolve as tentativas acumuladas.
CREATE OR REPLACE FUNCTION public.nfe_importacao_falha_registrar(
  p_chave_acesso  text,
  p_origem        text,
  p_sqlstate      text,
  p_erro          text,
  p_warehouse_id  uuid DEFAULT NULL,
  p_omie_id_receb bigint DEFAULT NULL
)
RETURNS integer
LANGUAGE sql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  INSERT INTO public.nfe_importacao_falhas AS f
    (chave_acesso, warehouse_id, omie_id_receb, origem, sqlstate, erro)
  VALUES (p_chave_acesso, p_warehouse_id, p_omie_id_receb, p_origem, p_sqlstate, left(p_erro, 500))
  ON CONFLICT (chave_acesso) DO UPDATE
    SET tentativas    = f.tentativas + 1,
        ultima_em     = now(),
        origem        = EXCLUDED.origem,
        sqlstate      = EXCLUDED.sqlstate,
        erro          = EXCLUDED.erro,
        warehouse_id  = coalesce(EXCLUDED.warehouse_id, f.warehouse_id),
        omie_id_receb = coalesce(EXCLUDED.omie_id_receb, f.omie_id_receb)
  RETURNING tentativas;
$fn$;

REVOKE ALL ON FUNCTION public.nfe_importacao_falha_registrar(text, text, text, text, uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nfe_importacao_falha_registrar(text, text, text, text, uuid, bigint) FROM anon;
REVOKE ALL ON FUNCTION public.nfe_importacao_falha_registrar(text, text, text, text, uuid, bigint) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.nfe_importacao_falha_registrar(text, text, text, text, uuid, bigint) TO service_role;

-- ── 6. PÓS — postcondição embutida: a migration que não pegou aborta aqui, com o motivo ─────────
DO $post$
DECLARE
  v_oid   oid  := to_regprocedure('public.importar_nfe_recebimento(jsonb, jsonb, text)');
  v_antes text := current_setting('importar_nfe_recebimento.md5_antes', true);
  v_agora text;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'A1 FALHOU: importar_nfe_recebimento(jsonb, jsonb, text) nao existe — as edges responderiam PGRST202';
  END IF;
  SELECT md5(prosrc) INTO v_agora FROM pg_proc WHERE oid = v_oid;
  IF nullif(v_antes, '') IS NOT NULL AND v_agora IS DISTINCT FROM v_antes THEN
    RAISE EXCEPTION 'A2 FALHOU: prod tinha OUTRO corpo de importar_nfe_recebimento (md5 % ≠ %) — deriva; nada foi aplicado (rollback)', v_antes, v_agora;
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'A3 FALHOU: a RPC virou SECURITY DEFINER — o desenho e INVOKER pela service_role';
  END IF;
  IF has_function_privilege('public', v_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'A4 FALHOU: importar_nfe_recebimento executavel por PUBLIC/anon/authenticated — escrita de recebimento aberta';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'A5 FALHOU: service_role sem EXECUTE — webhook e sync parariam de gravar';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.nfe_recebimento_itens'::regclass
      AND conname = 'nfe_recebimento_itens_recebimento_sequencia_key'
      AND contype = 'u' AND convalidated
  ) THEN
    RAISE EXCEPTION 'A6 FALHOU: UNIQUE (nfe_recebimento_id, sequencia) ausente ou nao validada — 2 lotes podem coexistir';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'nfe_recebimentos'
         AND column_name IN ('origem', 'reparada_origem', 'reparada_em')) IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'A7 FALHOU: colunas origem/reparada_origem/reparada_em incompletas em nfe_recebimentos — a RPC falharia no INSERT/UPDATE';
  END IF;
  IF (SELECT count(*) FROM pg_constraint
       WHERE conrelid = 'public.nfe_recebimentos'::regclass
         AND conname IN ('nfe_recebimentos_origem_check', 'nfe_recebimentos_reparada_origem_check')
         AND contype = 'c' AND convalidated) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'A8 FALHOU: CHECK de origem/reparada_origem ausente — vocabulario da origem aberto';
  END IF;
  IF to_regprocedure('public.nfe_importacao_falha_registrar(text, text, text, text, uuid, bigint)') IS NULL
     OR has_function_privilege('public', 'public.nfe_importacao_falha_registrar(text, text, text, text, uuid, bigint)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.nfe_importacao_falha_registrar(text, text, text, text, uuid, bigint)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.nfe_importacao_falha_registrar(text, text, text, text, uuid, bigint)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.nfe_importacao_falha_registrar(text, text, text, text, uuid, bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A10 FALHOU: nfe_importacao_falha_registrar ausente ou com ACL errada (so service_role executa)';
  END IF;
  IF to_regclass('public.nfe_importacao_falhas') IS NULL
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.nfe_importacao_falhas'::regclass)
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'nfe_importacao_falhas') IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'A9 FALHOU: nfe_importacao_falhas ausente, sem RLS ou sem as 2 policies — registro de falha aberto ou inexistente';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.nfe_importacao_falhas', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.nfe_importacao_falhas', 'SELECT')
     OR has_table_privilege('anon', 'public.nfe_importacao_falhas', 'SELECT')
     OR has_table_privilege('authenticated', 'public.nfe_importacao_falhas', 'INSERT') THEN
    RAISE EXCEPTION 'A11 FALHOU: privilegios de nfe_importacao_falhas fora do desenho (service_role escreve · authenticated so le · anon nada)';
  END IF;
  RAISE NOTICE 'importar_nfe_recebimento OK: funcao INVOKER so-service_role · UNIQUE(nfe_recebimento_id, sequencia) validada · origem/reparada_* com CHECK · nfe_importacao_falhas com RLS';
END
$post$;
