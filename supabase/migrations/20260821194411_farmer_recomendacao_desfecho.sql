-- ============================================================================
-- farmer_recommendations — o SENSOR DE DESFECHO
--
-- POR QUÊ (medido em prod via psql-ro, 2026-08-21):
--   17.316 linhas, 16.233 'expirado' + 1.083 'pendente', e ZERO desfecho em
--   TODAS as cinco colunas que existiam para registrá-lo:
--     offered_at=0  accepted_at=0  rejected_at=0  actual_margin=0  time_spent_seconds=0
--   O vocabulário 'ofertado'/'aceito'/'rejeitado' está no CHECK de `status` desde
--   fev/2026 e NUNCA foi escrito: os métodos `markAsOffered/Accepted/Rejected`
--   foram removidos em 2026-07-21 por não terem chamador nenhum, e a tela de
--   recomendações jamais ofereceu ação de resultado.
--
--   Consequência em cascata: `farmer_category_conversion` tem 0 linhas desde que
--   nasceu, e por isso TAXA_CONVERSAO_CROSS_SELL/UP_SELL e FATOR_COMPLEXIDADE são
--   constantes ARBITRADAS. O gate `clusterAdherence < 0.03` e os pesos do ranking
--   (corrigidos em #1841) nunca puderam ser calibrados porque não há contra o que.
--
--   Esta migration NÃO calibra nada. Ela instala o sensor — que é o passo (1) da
--   ordem obrigatória do post-mortem em docs/historico/farmer-aprendizado-conversao.md
--   e a resposta ao padrão de docs/historico/fase-sem-sinal.md ("fase N+1 exige
--   sinal da fase N"). Superfície de uso nasce COM o sensor.
--
-- O QUE ENTRA:
--   1. coluna `rejection_reason` (o "porquê" da recusa) — dedicada, vocabulário
--      fechado, um único escritor. NÃO vai em jsonb multi-writer (money-path).
--   2. dois CHECKs de coerência, que tornam impossível um desfecho meia-boca.
--   3. a RPC `farmer_recomendacao_registrar_desfecho` — o ÚNICO escritor.
--
-- PRÉ-VOO CONTRA A PROD (psql-ro, antes de escrever este arquivo):
--   rejection_reason_existe=0 · rpc_existe=0 · cap_carteira_escrever=1
--   violariam_coerencia=0  (as 17.316 linhas passam nos CHECKs novos)
--   grupos elegíveis (pendente+ofertado)=1083, duplicatas=0
-- ============================================================================

-- ─── 1) O "porquê" da recusa ────────────────────────────────────────────────
-- Coluna DEDICADA e nullable. `NULL` = não perguntamos / não respondeu, que é
-- diferente de "recusou sem motivo" — ausente ≠ zero vale para texto também.
ALTER TABLE public.farmer_recommendations
  ADD COLUMN IF NOT EXISTS rejection_reason text;

COMMENT ON COLUMN public.farmer_recommendations.rejection_reason IS
  'Motivo da recusa, vocabulário fechado. Escrito SÓ por farmer_recomendacao_registrar_desfecho. NULL = não informado (≠ "sem motivo").';

-- ─── 2) Coerência: um desfecho é o par (status, carimbo) ou não é nada ──────
-- Sem isto, `status='aceito'` com `accepted_at IS NULL` seria aceito pelo banco e
-- a query de leitura teria de escolher entre duas fontes que discordam.
--
-- ⚠️ Os DOIS lados do `=`: `(status='aceito') = (accepted_at IS NOT NULL)` barra
-- tanto o status sem carimbo quanto o carimbo sem status. Só `IS NOT NULL` no
-- status deixaria a segunda metade passar.
--
-- `offered_at` é o único que sobrevive à transição: quem marca "Ofertei" e depois
-- "Aceitou" fica com offered_at E accepted_at (a sequência é o dado). Quem marca
-- "Aceitou" direto fica com offered_at NULL — honesto, ninguém registrou quando
-- ofertou. Por isso 'aceito'/'rejeitado' NÃO exigem offered_at.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.farmer_recommendations'::regclass
       AND conname  = 'farmer_recommendations_desfecho_coerente'
  ) THEN
    ALTER TABLE public.farmer_recommendations
      ADD CONSTRAINT farmer_recommendations_desfecho_coerente CHECK (
        -- `status IS NOT NULL` explícito: um CHECK que resulta em NULL é considerado
        -- SATISFEITO pelo Postgres, e a coluna é nullable. Depender do
        -- `expirado_coerente` (que já exige NOT NULL) acoplaria este invariante à
        -- sobrevivência daquele.
            status IS NOT NULL
        AND ((status = 'aceito')    = (accepted_at IS NOT NULL))
        AND ((status = 'rejeitado') = (rejected_at IS NOT NULL))
        -- carimbo de oferta só existe em linha que teve oferta declarada
        AND (offered_at IS NULL OR status IN ('ofertado', 'aceito', 'rejeitado'))
        AND (status <> 'ofertado' OR offered_at IS NOT NULL)
      );
  END IF;
END $$;

-- Motivo: vocabulário FECHADO (fail-closed — texto livre viraria pó estatístico e
-- não calibraria nada) e só em linha recusada. 'outro' existe para não forçar a
-- vendedora a mentir numa das cinco categorias.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.farmer_recommendations'::regclass
       AND conname  = 'farmer_recommendations_motivo_coerente'
  ) THEN
    ALTER TABLE public.farmer_recommendations
      ADD CONSTRAINT farmer_recommendations_motivo_coerente CHECK (
        -- EQUIVALÊNCIA, não implicação (achado do /codex xhigh): a primeira versão
        -- era `rejection_reason IS NULL OR status='rejeitado'`, que permite
        -- `status='rejeitado' AND rejection_reason IS NULL` — recusa sem porquê, que
        -- é metade do sinal que justifica este sensor existir. A RPC exigia o motivo,
        -- mas um UPDATE direto (authenticated tem `w` na tabela) não passaria por ela.
        (
          status = 'rejeitado'
          -- ⚠️ `IS NOT NULL` ANTES do `IN`: com rejection_reason NULL, `NULL IN (...)`
          -- devolve NULL, o ramo inteiro vira NULL, e um CHECK que resulta em NULL é
          -- considerado SATISFEITO pelo Postgres. Sem esta linha a constraint deixava
          -- passar exatamente o caso que ela existe para barrar — recusa sem porquê.
          -- (Pego pelo assert 18 do db/test-farmer-desfecho.sh, não por leitura.)
          AND rejection_reason IS NOT NULL
          AND rejection_reason IN (
            'preco', 'sem_necessidade', 'ja_compra_concorrente',
            'sem_estoque', 'prazo_entrega', 'outro'
          )
        )
        OR (status IS NOT NULL AND status <> 'rejeitado' AND rejection_reason IS NULL)
      );
  END IF;
END $$;

-- ─── 3) Imutabilidade do desfecho — no BANCO, não só na RPC ─────────────────
-- Achado do /codex xhigh: um CHECK valida ESTADO, não TRANSIÇÃO. Como `authenticated`
-- tem `w` direto na tabela (relacl medido em prod: authenticated=arwdDxtm), um único
-- UPDATE pode transformar 'aceito' em 'rejeitado' deixando o estado final coerente —
-- e os CHECKs aplaudiriam. A "imutabilidade histórica" existiria só dentro das RPCs.
--
-- Esta trigger é a fronteira real: o desfecho terminal congela em QUALQUER canal.
-- Ela NÃO congela a linha inteira — `actual_margin` e `time_spent_seconds` seguem
-- graváveis, porque apurar a margem depois é a fase seguinte deste mesmo sensor.
CREATE OR REPLACE FUNCTION private.frec_desfecho_imutavel()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status IN ('aceito', 'rejeitado')
     AND (
          NEW.status           IS DISTINCT FROM OLD.status
       OR NEW.accepted_at      IS DISTINCT FROM OLD.accepted_at
       OR NEW.rejected_at      IS DISTINCT FROM OLD.rejected_at
       OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason
     )
  THEN
    RAISE EXCEPTION
      'Desfecho já registrado (%) é histórico imutável — reescrevê-lo apagaria a medição',
      OLD.status USING ERRCODE = 'FD007';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_frec_desfecho_imutavel ON public.farmer_recommendations;
CREATE TRIGGER trg_frec_desfecho_imutavel
  BEFORE UPDATE ON public.farmer_recommendations
  FOR EACH ROW EXECUTE FUNCTION private.frec_desfecho_imutavel();

-- ─── 4) O ÚNICO escritor de desfecho ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.farmer_recomendacao_registrar_desfecho(
  p_customer_user_id    uuid,
  p_product_id          uuid,
  p_recommendation_type text,
  p_desfecho            text,
  p_motivo              text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
-- SECURITY INVOKER (o default, explicitado de propósito): a policy
-- `frec_update_own_or_gestor` continua sendo a autorização. SECURITY DEFINER
-- bypassaria a RLS e obrigaria a reconstruir o gate aqui dentro — mais código
-- para chegar ao mesmo lugar, com uma falha ABERTA de brinde se errasse.
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id      uuid;
  v_n       integer := 0;
  v_rec     record;
  v_farmer  uuid := auth.uid();
  v_agora   timestamptz := clock_timestamp();
BEGIN
  -- ── Gate de identidade ────────────────────────────────────────────────────
  -- Explícito, e ANTES da busca: sem isto uma sessão expirada (uid NULL) cairia
  -- no "nenhuma oferta encontrada" e a vendedora leria "recarregue" quando o que
  -- ela precisa é logar de novo. Erro certo > erro plausível.
  IF v_farmer IS NULL THEN
    RAISE EXCEPTION 'Sem sessão autenticada — desfecho não registrado'
      USING ERRCODE = 'FD001';
  END IF;

  -- ── Vocabulário ───────────────────────────────────────────────────────────
  -- Só os dois desfechos TERMINAIS. 'ofertado' existe no CHECK de `status` desde
  -- fev/2026 e fica DELIBERADAMENTE de fora — ver a nota "por que não 'ofertado'"
  -- no fim deste arquivo. Não é esquecimento: é a correção de uma falha que o
  -- /codex xhigh encontrou neste desenho.
  IF p_desfecho IS NULL OR p_desfecho NOT IN ('aceito', 'rejeitado') THEN
    RAISE EXCEPTION 'Desfecho inválido: % (esperado aceito|rejeitado)', coalesce(p_desfecho, 'NULL')
      USING ERRCODE = 'FD002';
  END IF;

  -- Motivo OBRIGATÓRIO na recusa, PROIBIDO no aceite. O gate/pesos do ranking se
  -- calibram pelo PORQUÊ, não pelo placar: uma recusa sem motivo conta para a taxa
  -- e não ensina nada. (O CHECK da tabela cobre o mesmo invariante contra UPDATE
  -- direto; aqui a mensagem diz o que fazer.)
  IF p_desfecho = 'rejeitado' AND (p_motivo IS NULL OR btrim(p_motivo) = '') THEN
    RAISE EXCEPTION 'Recusa exige motivo — registre o porquê'
      USING ERRCODE = 'FD003';
  END IF;
  IF p_desfecho <> 'rejeitado' AND p_motivo IS NOT NULL THEN
    RAISE EXCEPTION 'Motivo só se aplica a recusa (recebido em "%")', p_desfecho
      USING ERRCODE = 'FD003';
  END IF;

  -- ── Localizar a linha ─────────────────────────────────────────────────────
  -- `farmer_id = v_farmer` é FIXO, nunca parâmetro. É isto que impede a lente
  -- "Ver como" de registrar desfecho na carteira alheia: sob a lente o `auth.uid()`
  -- continua sendo o master REAL, então a busca não acha a linha da vendedora e a
  -- RPC recusa. Um `disabled` de UI sozinho seria contornável por POST direto.
  -- (Não é a fronteira ÚNICA de segurança — a policy ainda deixa um gestor fazer
  -- UPDATE direto —, mas é a fronteira deste escritor, e a trigger acima cobre o
  -- resto do caminho.)
  --
  -- Busca por CHAVE DE NEGÓCIO e não por id porque o browser não TEM o id: o motor
  -- calcula em memória e a `farmer_recomendacoes_substituir` insere sem devolver os
  -- ids gerados.
  --
  -- ⚠️ Só `status = 'pendente'` é elegível, e isso é o que torna a chave de negócio
  -- uma IDENTIDADE: a RPC de substituição expira TODAS as pendentes do farmer antes
  -- de inserir a geração nova, na mesma transação — logo existe no máximo uma linha
  -- pendente por chave (medido: 1.083 grupos, 0 duplicatas).
  --
  -- `FOR UPDATE` serializa contra um recompute concorrente. Em READ COMMITTED o
  -- Postgres re-avalia o predicado depois do lock: se a substituição expirou esta
  -- linha no meio do caminho, ela deixa de casar e a busca volta vazia. Fail-closed.
  -- ⚠️ O cliente NÃO deve fazer retry automático nesse caso (achado /codex): depois
  -- da substituição, o retry acertaria a recomendação NOVA e atribuiria o desfecho
  -- a um cálculo que a vendedora nunca viu.
  FOR v_rec IN
    SELECT id
      FROM public.farmer_recommendations
     WHERE farmer_id           = v_farmer
       AND customer_user_id    = p_customer_user_id
       AND product_id          = p_product_id
       AND recommendation_type = p_recommendation_type
       AND status              = 'pendente'
     FOR UPDATE
  LOOP
    v_n := v_n + 1;
    v_id := v_rec.id;
  END LOOP;

  IF v_n = 0 THEN
    RAISE EXCEPTION 'Nenhuma oferta ativa sua para este cliente/produto — recarregue as recomendações'
      USING ERRCODE = 'FD004';
  END IF;

  -- AMBIGUIDADE → RECUSA, nunca escolha (precisão > recall). Um `ORDER BY ... LIMIT 1`
  -- só tornaria DETERMINÍSTICA uma atribuição possivelmente errada, e o dado errado
  -- é pior que dado nenhum: ele parece válido. Nada no schema garante unicidade da
  -- chave (um índice único parcial garantiria, mas derrubaria o recompute inteiro no
  -- dia em que o motor emitisse duas linhas iguais no mesmo lote). `current_product_id`
  -- fora da chave é um caminho concreto para isso: dois up-sells para o mesmo produto
  -- alvo com origens diferentes.
  IF v_n > 1 THEN
    RAISE EXCEPTION '% ofertas ativas iguais para este cliente/produto — desfecho não registrado, para não cair na errada', v_n
      USING ERRCODE = 'FD006';
  END IF;

  UPDATE public.farmer_recommendations
     SET status           = p_desfecho,
         accepted_at      = CASE WHEN p_desfecho = 'aceito'    THEN v_agora ELSE accepted_at END,
         rejected_at      = CASE WHEN p_desfecho = 'rejeitado' THEN v_agora ELSE rejected_at END,
         rejection_reason = CASE WHEN p_desfecho = 'rejeitado' THEN btrim(p_motivo) ELSE rejection_reason END,
         -- `actual_margin` e `time_spent_seconds` ficam INTOCADOS (NULL). Um toque
         -- captura UM fato. Gravar 0 fabricaria "margem zero apurada" e "ligação
         -- instantânea" — o `Number(null) === 0` do money-path, em SQL. E `offered_at`
         -- também não é carimbado: ninguém registrou QUANDO a oferta foi feita, e
         -- usar o instante do clique afirmaria oferta e desfecho simultâneos.
         updated_at       = v_agora
   WHERE id = v_id;

  RETURN jsonb_build_object('id', v_id, 'status', p_desfecho);
END $$;

COMMENT ON FUNCTION public.farmer_recomendacao_registrar_desfecho(uuid, uuid, text, text, text) IS
  'Único escritor de desfecho de farmer_recommendations. farmer_id = auth.uid() FIXO (a lente "Ver como" não alcança carteira alheia). Erros: FD001 sem sessão · FD002 desfecho inválido · FD003 motivo · FD004 oferta não encontrada · FD006 chave ambígua.';

-- ── ACL explícita ───────────────────────────────────────────────────────────
-- `REVOKE FROM PUBLIC` NÃO tira anon/authenticated: o grant deles é explícito e
-- precisa ser revogado POR NOME (CLAUDE.md). `anon` fica de fora — registrar
-- desfecho exige sessão, e a própria FD001 recusaria, mas a porta some antes.
REVOKE ALL ON FUNCTION public.farmer_recomendacao_registrar_desfecho(uuid, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.farmer_recomendacao_registrar_desfecho(uuid, uuid, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.farmer_recomendacao_registrar_desfecho(uuid, uuid, text, text, text) TO authenticated;

-- ─── 4) Índice de LEITURA do sensor ─────────────────────────────────────────
-- A query de denominador varre desfecho por período. Sem isto ela é seq scan na
-- tabela inteira, que só cresce (17.316 linhas hoje, uma geração nova por
-- recálculo). Parcial: as linhas COM desfecho são a minoria permanente.
CREATE INDEX IF NOT EXISTS idx_frec_desfecho
  ON public.farmer_recommendations (farmer_id, status, updated_at DESC)
  WHERE status IN ('ofertado', 'aceito', 'rejeitado');

-- ============================================================================
-- POR QUE NÃO 'ofertado' (fora de escopo DELIBERADO, não esquecimento)
--
-- O desenho original tinha três botões: "Ofertei" / "Aceitou" / "Recusou". O
-- /codex xhigh derrubou o primeiro com um cenário concreto:
--
--   1. R1 nasce 'pendente'; a vendedora marca "Ofertei" → R1 vira 'ofertado'.
--   2. O recompute expira só as 'pendente' — R1 SOBREVIVE (é o que queremos).
--   3. O motor recomenda a mesma chave de novo e insere R2 'pendente'.
--   4. A vendedora marca "Aceitou" pensando em R1 → a busca por chave de negócio
--      encontra DUAS linhas elegíveis e carimba a errada.
--
--   O aceite ficaria colado ao run_id, p_ij e afinidade de R2 — um cálculo que
--   ela nunca viu. O sensor produziria um dataset que PARECE válido e é falso,
--   que é pior do que o zero de hoje: contra dado ausente ninguém calibra, mas
--   contra dado errado alguém calibra com confiança.
--
--   Some-se o problema de UX que o mesmo parecer apontou: a tela lê o resultado
--   do motor em MEMÓRIA. Uma linha 'ofertado' some do próximo cálculo, e a
--   vendedora nunca mais alcança o card para registrar o desfecho que interessa.
--
-- 'ofertado' volta quando a UI tiver o `id` da linha — o que exige a
-- `farmer_recomendacoes_substituir` devolver os ids que insere, e o hook passar a
-- renderizar as linhas PERSISTIDAS em vez das calculadas em memória. Isso é uma
-- entrega própria, com risco próprio, sobre o arquivo mais quente do domínio.
--
-- Sem o estado intermediário, o conjunto elegível é só 'pendente' — e como a RPC
-- de substituição expira todas as pendentes antes de inserir a geração nova, na
-- MESMA transação, a chave de negócio volta a ser uma identidade.
--
-- ── A QUERY DE LEITURA (o "quando medir é query, não recado") ───────────────
-- Nunca colapse ausência em recusa. As cinco categorias são distintas:
--
--   SELECT
--     count(*)                                              AS geradas,
--     count(*) FILTER (WHERE accepted_at IS NOT NULL)        AS aceitas,
--     count(*) FILTER (WHERE rejected_at IS NOT NULL)        AS recusadas,
--     count(*) FILTER (WHERE status = 'expirado'
--                        AND accepted_at IS NULL
--                        AND rejected_at IS NULL)            AS expiradas_sem_interacao,
--     count(*) FILTER (WHERE status = 'pendente')            AS pendentes_sem_interacao
--   FROM farmer_recommendations
--   WHERE created_at >= '<data do Publish>';   -- coorte: antes disso o sensor não existia
--
-- A razão aceitas/(aceitas+recusadas) chama-se "aceitação entre desfechos
-- REGISTRADOS" — não é conversão nem precisão do motor. O denominador honesto de
-- adoção é (aceitas+recusadas)/geradas na coorte, e mesmo ele é um proxy: mede
-- cobertura entre recomendações GERADAS, não entre as VISTAS. Não há evento de
-- impressão — 'expirado' significa "substituída sem interação registrada", nunca
-- "rejeitada".
-- ============================================================================
