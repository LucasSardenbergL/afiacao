-- ============================================================
-- HEAD de geração do farmer — o SENSOR, antes da decisão.
--
-- PROBLEMA (limitação DECLARADA no #1756 / 20260814223445, achado do challenge
--   Codex xhigh): aquela migration fez o recálculo APOSENTAR a geração anterior —
--   mas só quando ele produz linha. Os hooks só chamam a RPC se `linhas.length > 0`
--   e a própria RPC recusa lote vazio (FG003). Quando o cálculo conclui CORRETAMENTE
--   que não deve haver recomendação nenhuma (carteira esvaziada, nenhum SKU vendável
--   sobrando, regras abaixo do piso), o banco continua servindo exatamente as
--   recomendações que o novo cálculo decidiu que não deveriam existir. O topo antigo
--   sobrevive indefinidamente. A causa estrutural é inferir a geração vigente da
--   EXISTÊNCIA de uma linha: um conjunto vazio não tem onde carimbar sua identidade.
--
-- MEDIÇÃO (prod, 2026-08-15 ~17:30 UTC, via psql-ro). O denominador é 3 FARMERS —
--   não os 473 grupos do #1756, que eram (farmer, cliente):
--     · 414a9727 — 3.858 scores, 171 c/ pedido, 671 pendentes, run_id=71946f20
--       (recalculado hoje 17:31 UTC: 671 inseridas e 5.325 EXPIRADAS no mesmo
--        instante — o #1756 está vivo e fez efeito real)
--     · 33f59dc7 — 1.245 scores, 294 c/ pedido, 690 pendentes com run_id NULL,
--       de 2026-04-10: 127 DIAS servindo a mesma oferta
--     · 700657a1 — 1.530 scores, 396 c/ pedido, ZERO recomendação: nunca rodou
--
--   ⚠️ A frequência de recálculo VAZIO é hoje estruturalmente NÃO-MENSURÁVEL. Um
--   recálculo que produz zero linhas sai por `return` mudo (useCrossSellEngine.ts:225
--   e :296), não grava linha e não registra execução (acoes_execucoes: 0 linhas com
--   slug de farmer). Há 28 execuções COM linha entre 03/03 e 15/08 — esse é o
--   numerador; o denominador não existe em lugar nenhum. Se a tela tivesse sido
--   aberta 500 vezes e 472 devolvessem zero, o rastro seria IDÊNTICO ao de hoje.
--   É o `Number(null)===0` da adoção, e é por isso que esta migration é um SENSOR e
--   não uma correção: "superfície de uso nasce COM o sensor" (CLAUDE.md).
--
--   E a medição revelou, sem ser procurado, o custo que já se paga: em 700657a1,
--   "NUNCA RODOU" e "RODOU E DEU VAZIO" são o MESMO estado no banco (ausência de
--   linha). Essa indistinguibilidade existe independente de a expiração ser ligada.
--
-- ESCOPO (decisão do founder, 2026-08-15): SENSOR, sem expirar. O head avança sempre
--   — inclusive na geração vazia — mas NADA é expirado por vazio nesta entrega. Sem
--   um único `vazio` medido, ligar a expiração seria assumir o risco de zerar a
--   carteira de uma vendedora sem contrapartida medida. Fora de escopo, declarado:
--   expiração por vazio, TTL por idade, backfill do head, loop de feedback.
--
-- SEM BACKFILL, de propósito: head ausente significa "não houve execução observada
--   desde o sensor" — uma verdade, não uma fabricação. Semear head para os farmers
--   atuais exigiria inventar um run_id para a geração legada (run_id NULL) ou tornar
--   a coluna nullable; as duas pioram a leitura em troca de nada, já que o head nasce
--   na primeira execução real.
--
-- DESENHO — DUAS tabelas, porque são DUAS perguntas:
--   · farmer_geracao_vigente   = HEAD (1 linha por motor+farmer). Serve o compare-and-swap
--     e responde "qual é o estado corrente". É o que deixa o CAS de pé sem depender de
--     haver linha — o pedido original do challenge.
--   · farmer_geracao_execucoes = LOG append-only. Responde "com que FREQUÊNCIA o vazio
--     acontece", que é a pergunta que originou a entrega. O head sozinho NÃO responde:
--     `ON CONFLICT DO UPDATE` sobrescreve, então um vazio+completo de hoje SOME no run
--     com linhas de amanhã, e a medição diria "nunca aconteceu" (achado do challenge
--     Codex xhigh). Escritos na MESMA transação, pela mesma RPC.
--
-- ESCRITA SÓ PELA RPC: as duas tabelas não têm grant de DML para `authenticated`, e
--   `farmer_geracao_registrar` é SECURITY DEFINER. A 1ª versão desta migration dava
--   GRANT INSERT/UPDATE e o browser podia forjar o head por UPDATE direto, pulando
--   FG105/FG106/FG107 — guard com porta ao lado não é guard, e aqui o contorno falsifica
--   a MEDIÇÃO, que é o produto inteiro.
--
-- DEPENDE de 20260814223445 (run_id/expired_at + as RPCs de substituição). O guard
--   abaixo ABORTA com a instrução no texto se ela não tiver sido aplicada.
-- ============================================================

-- ─── 0) Guard de ordem de apply (fail-closed, com a instrução no texto) ───
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'farmer_recommendations'
      AND column_name = 'run_id'
  ) THEN
    RAISE EXCEPTION 'DEPENDENCIA FALTANDO: aplique ANTES a migration 20260814223445_farmer_recomendacoes_geracao_vigente.sql (coluna farmer_recommendations.run_id ausente nesta base)'
      USING ERRCODE = 'FG100';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'farmer_recomendacoes_substituir'
  ) THEN
    RAISE EXCEPTION 'DEPENDENCIA FALTANDO: aplique ANTES a migration 20260814223445 (função farmer_recomendacoes_substituir ausente nesta base)'
      USING ERRCODE = 'FG100';
  END IF;
END $$;

-- ─── 1) A tabela do head ───
-- Uma linha por (motor, farmer_id) que AVANÇA — inclusive quando a geração é vazia.
-- É exatamente isto que a existência-de-linha não consegue representar.
CREATE TABLE IF NOT EXISTS public.farmer_geracao_vigente (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  motor          text        NOT NULL,
  farmer_id      uuid        NOT NULL,
  run_id         uuid        NOT NULL,
  resultado      text        NOT NULL,
  linhas_geradas integer     NOT NULL,
  completude     text        NOT NULL,
  motivo         text,
  insumos        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  calculado_em   timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_em  timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- A chave que AVANÇA. `IF NOT EXISTS` no índice único para o apply ser idempotente
-- (o snapshot do Lovable pode reaplicar).
CREATE UNIQUE INDEX IF NOT EXISTS farmer_geracao_vigente_motor_farmer_uk
  ON public.farmer_geracao_vigente (motor, farmer_id);

-- ─── 2) Invariantes na TABELA, não só no writer (money-path §2) ───
-- Todas as colunas destes predicados são NOT NULL, então — ao contrário do
-- `status IS NOT NULL AND` que o #1756 precisou — nenhum CHECK aqui pode devolver
-- NULL (que o Postgres ACEITA num CHECK: só `false` reprova).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'farmer_geracao_vigente_motor_check') THEN
    ALTER TABLE public.farmer_geracao_vigente ADD CONSTRAINT farmer_geracao_vigente_motor_check
      CHECK (motor = ANY (ARRAY['cross_sell'::text, 'bundle'::text]));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'farmer_geracao_vigente_resultado_check') THEN
    ALTER TABLE public.farmer_geracao_vigente ADD CONSTRAINT farmer_geracao_vigente_resultado_check
      CHECK (resultado = ANY (ARRAY['linhas'::text, 'vazio'::text]));
  END IF;
  -- `desconhecido` é estado de PRIMEIRA CLASSE, não um buraco: no Lovable o Publish do
  -- frontend é manual, então existe uma janela em que a migration já está aplicada e o
  -- browser ainda roda o bundle velho (assinatura de 4 args). Nessa janela o head grava
  -- `desconhecido` — NUNCA `completo`. É o §2 aplicado à própria instrumentação:
  -- ausente ≠ completo. Sem isso a janela de deploy envenena a medição com falsos
  -- `completo`, e é sobre essa medição que a fase 2 decidiria ligar a expiração.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'farmer_geracao_vigente_completude_check') THEN
    ALTER TABLE public.farmer_geracao_vigente ADD CONSTRAINT farmer_geracao_vigente_completude_check
      CHECK (completude = ANY (ARRAY['completo'::text, 'degradado'::text, 'desconhecido'::text]));
  END IF;
  -- Impede o head MENTIROSO ("resultado=linhas com 0 linhas"), que é como uma medição
  -- se corrompe sem ninguém ver — e a medição é o produto inteiro desta entrega.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'farmer_geracao_vigente_linhas_coerente') THEN
    ALTER TABLE public.farmer_geracao_vigente ADD CONSTRAINT farmer_geracao_vigente_linhas_coerente
      CHECK (linhas_geradas >= 0 AND (resultado = 'linhas') = (linhas_geradas > 0));
  END IF;
  -- Degradado sem motivo é rótulo sem conteúdo — e o motivo é justamente o que a
  -- fase 2 precisa para separar "zero de verdade" de "zero por dado faltando".
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'farmer_geracao_vigente_motivo_coerente') THEN
    ALTER TABLE public.farmer_geracao_vigente ADD CONSTRAINT farmer_geracao_vigente_motivo_coerente
      CHECK (completude <> 'degradado' OR motivo IS NOT NULL);
  END IF;
END $$;

COMMENT ON TABLE public.farmer_geracao_vigente IS
  'HEAD de geração por (motor, farmer): avança a cada execução CONCLUÍDA do motor, INCLUSIVE quando a geração é vazia. Sensor instalado em 2026-08-15 — nesta fase NÃO expira nada. Head ausente = não houve execução observada desde o sensor (não há backfill, de propósito). ⚠️ O head registra a ÚLTIMA EXECUÇÃO CONCLUÍDA, não o conteúdo de farmer_recommendations: com resultado=vazio as linhas pendentes anteriores CONTINUAM lá (é justamente o buraco que o sensor mede). Os dois só convergem quando a fase 2 ligar a expiração — e é por isso que, até lá, nenhum leitor de oferta pode usar o head como fonte.';
COMMENT ON COLUMN public.farmer_geracao_vigente.resultado IS
  'linhas | vazio. `vazio` com completude=completo é o "zero de verdade" — o sinal que a fase 2 (ligar a expiração) exige para existir.';
COMMENT ON COLUMN public.farmer_geracao_vigente.completude IS
  'Completude do SNAPSHOT, não do resultado: `completo` = todos os insumos lidos com sucesso e nenhum insumo estruturalmente obrigatório veio vazio. `desconhecido` = quem chamou não declarou (cliente anterior ao sensor). É DECLARAÇÃO do motor — audite pela evidência em `insumos`, não pelo rótulo.';
COMMENT ON COLUMN public.farmer_geracao_vigente.insumos IS
  'Evidência por trás do rótulo: por insumo, {ok, n}. Os SINAIS de decisão moram em colunas dedicadas (resultado/completude/linhas_geradas) e há 1 writer só (as RPCs desta migration) — por isso este jsonb não recai na regra "sinal money-path nunca em jsonb multi-writer". Serve para a fase 2 exigir contagens plausíveis em vez de confiar na string `completo` ("rótulo com DEFAULT constante não é fato").';

-- ─── 2b) O LOG APPEND-ONLY — o head sozinho NÃO mede frequência ───
-- Achado do challenge Codex xhigh: `ON CONFLICT DO UPDATE` sobrescreve a única linha do
-- par, então um `vazio+completo` pode acontecer HOJE e sumir no próximo run com linhas.
-- Um head responde "qual é o último estado dos até 6 pares", não "quantas vezes o vazio
-- aconteceu" — e a pergunta que originou esta entrega é EXATAMENTE a segunda. Sem o log,
-- a ausência de `vazio+completo` continuaria sendo ausência de dado, que é o defeito que
-- o sensor existe para curar.
--   Volume não é objeção: 28 execuções em 5,5 meses, 3 farmers.
-- Divisão de trabalho: `farmer_geracao_vigente` é o HEAD (serve o CAS, 1 linha por par);
-- `farmer_geracao_execucoes` é o HISTÓRICO (serve a medição, append-only). Escritos na
-- MESMA transação pela mesma RPC — divergir seria medir uma coisa e decidir por outra.
CREATE TABLE IF NOT EXISTS public.farmer_geracao_execucoes (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  motor          text        NOT NULL,
  farmer_id      uuid        NOT NULL,
  run_id         uuid        NOT NULL,
  resultado      text        NOT NULL,
  linhas_geradas integer     NOT NULL,
  completude     text        NOT NULL,
  motivo         text,
  insumos        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  calculado_em   timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Idempotência do registro: um retry do mesmo run não vira duas execuções na contagem
-- (sem isto, "frequência" mediria retries junto com execuções).
CREATE UNIQUE INDEX IF NOT EXISTS farmer_geracao_execucoes_run_uk
  ON public.farmer_geracao_execucoes (motor, farmer_id, run_id);
CREATE INDEX IF NOT EXISTS farmer_geracao_execucoes_medicao_idx
  ON public.farmer_geracao_execucoes (resultado, completude, calculado_em DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'farmer_geracao_execucoes_coerente') THEN
    ALTER TABLE public.farmer_geracao_execucoes ADD CONSTRAINT farmer_geracao_execucoes_coerente
      CHECK (
        motor      = ANY (ARRAY['cross_sell'::text, 'bundle'::text])
        AND resultado  = ANY (ARRAY['linhas'::text, 'vazio'::text])
        AND completude = ANY (ARRAY['completo'::text, 'degradado'::text, 'desconhecido'::text])
        AND linhas_geradas >= 0
        AND (resultado = 'linhas') = (linhas_geradas > 0)
        AND (completude <> 'degradado' OR motivo IS NOT NULL)
      );
  END IF;
END $$;

COMMENT ON TABLE public.farmer_geracao_execucoes IS
  'HISTÓRICO append-only de execuções CONCLUÍDAS do motor farmer. É daqui que sai a resposta a "com que frequência o recálculo produz zero?" — o head (farmer_geracao_vigente) guarda só o último estado e apagaria o evento. Nunca receber UPDATE/DELETE: a série é o produto.';

-- ─── 3) RLS (tabela nova nasce com RLS — regra do CLAUDE.md) ───
-- ⚠️ ESCRITA SÓ PELAS RPCs. A 1ª versão desta migration dava `GRANT INSERT, UPDATE` a
-- `authenticated` — o que deixava o browser fazer `UPDATE ... SET resultado='vazio',
-- completude='completo'` DIRETO na tabela, pulando FG105/FG106/FG107 inteiros (achado do
-- challenge Codex xhigh; o spec já dizia "a tabela não recebe grant de escrita direta" e a
-- migration fazia o contrário). Guard que se contorna pela porta ao lado não é guard —
-- e aqui o contorno falsifica a MEDIÇÃO, que é o produto.
-- Por isso `farmer_geracao_registrar` é SECURITY DEFINER: ela é a única porta de escrita,
-- e o gate DELA é a autorização (não a RLS, que o DEFINER bypassa — CLAUDE.md).
ALTER TABLE public.farmer_geracao_vigente ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farmer_geracao_execucoes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fgv_select_carteira      ON public.farmer_geracao_vigente;
DROP POLICY IF EXISTS fgv_insert_own_or_gestor ON public.farmer_geracao_vigente;
DROP POLICY IF EXISTS fgv_update_own_or_gestor ON public.farmer_geracao_vigente;
DROP POLICY IF EXISTS fge_select_carteira      ON public.farmer_geracao_execucoes;

-- ⚠️ `cap_carteira_escrever` entra no SELECT de propósito (a policy irmã de
-- farmer_recommendations não o tem). Quem escreve PRECISA ler: o CAS do head lê a linha
-- vigente antes de decidir, e um gestor com escrever-mas-não-ler veria NULL, passaria o
-- CAS trivialmente e sobrescreveria o head de outro run. CAS cego não é CAS.
CREATE POLICY fgv_select_carteira ON public.farmer_geracao_vigente
  FOR SELECT TO authenticated
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid())))
         OR (SELECT private.cap_carteira_escrever((SELECT auth.uid())))
         OR (farmer_id = (SELECT auth.uid())));

CREATE POLICY fge_select_carteira ON public.farmer_geracao_execucoes
  FOR SELECT TO authenticated
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid())))
         OR (SELECT private.cap_carteira_escrever((SELECT auth.uid())))
         OR (farmer_id = (SELECT auth.uid())));

-- ⚠️ NENHUMA policy de INSERT/UPDATE, e NENHUM grant de escrita: sem policy a RLS já nega,
-- mas o grant é a fechadura que importa — `REVOKE FROM PUBLIC` NÃO tira anon/authenticated
-- (grant explícito, revogar por nome). Escrita só pela RPC SECURITY DEFINER.
-- E DELETE nunca: a série do log é o produto.
REVOKE ALL ON TABLE public.farmer_geracao_vigente   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.farmer_geracao_execucoes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.farmer_geracao_vigente   TO authenticated;
GRANT SELECT ON TABLE public.farmer_geracao_execucoes TO authenticated;
GRANT ALL    ON TABLE public.farmer_geracao_vigente   TO service_role;
GRANT ALL    ON TABLE public.farmer_geracao_execucoes TO service_role;

-- ─── 4) A RPC de registro — o caminho que NÃO toca linha ───
-- É a única via para a geração VAZIA (e para a degradada). O caminho COM linhas passa
-- pelas RPCs de substituição, que chamam esta aqui DENTRO da mesma transação.
CREATE OR REPLACE FUNCTION public.farmer_geracao_registrar(
  p_motor          text,
  p_farmer_id      uuid,
  p_run_id         uuid,
  p_resultado      text,
  p_linhas_geradas integer,
  p_completude     text    DEFAULT NULL,
  p_motivo         text    DEFAULT NULL,
  p_insumos        jsonb   DEFAULT NULL,
  p_head_visto     uuid    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
-- ⚠️ SECURITY DEFINER, e é a decisão central de autorização desta migration. As tabelas
-- do sensor não têm grant de escrita para `authenticated`, então esta função é a ÚNICA
-- porta — e é isso que faz FG103/FG105/FG106/FG107 valerem alguma coisa. Com grant direto
-- (a 1ª versão desta migration tinha) o browser contornava todos por um UPDATE simples.
-- DEFINER bypassa RLS (CLAUDE.md), então o GATE ABAIXO é a autorização inteira: ele roda
-- ANTES de qualquer escrita e fecha em `IS NOT TRUE`. `auth.uid()` continua sendo o do
-- CHAMADOR (lê o JWT, não o role do Postgres), então o DEFINER não afrouxa o gate.
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_head_atual  uuid;
  v_completude  text;
  v_existia     boolean;
  v_reais       integer;
BEGIN
  -- 1) Obrigatórios.
  IF p_motor IS NULL OR p_farmer_id IS NULL OR p_run_id IS NULL THEN
    RAISE EXCEPTION 'p_motor, p_farmer_id e p_run_id são obrigatórios' USING ERRCODE = 'FG101';
  END IF;

  -- 2) Gate de MENSAGEM (a RLS é quem autoriza). `IS NOT TRUE`, não `NOT (...)`:
  -- numa sessão SEM JWT (pg_cron, psql) auth.uid() é NULL, a disjunção vira NULL e
  -- `IF NOT NULL THEN` NÃO dispara em PL/pgSQL — a forma "óbvia" é um guard que não
  -- nega, ele devolve nulo. Mesma lição do #1756.
  IF (
    coalesce(auth.role(), '') = 'service_role'
    OR p_farmer_id = auth.uid()
    OR coalesce(private.cap_carteira_escrever(auth.uid()), false)
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Acesso negado: só o próprio farmer ou quem tem cap_carteira_escrever registra geração'
      USING ERRCODE = '42501';
  END IF;

  IF p_motor NOT IN ('cross_sell', 'bundle') THEN
    RAISE EXCEPTION 'p_motor inválido: % (esperado cross_sell ou bundle)', p_motor
      USING ERRCODE = 'FG102';
  END IF;

  -- 3) Coerência resultado × contagem. Recusar aqui — e não deixar o CHECK da tabela
  -- pegar — dá ao chamador uma SQLSTATE própria e a mensagem com os dois valores.
  IF p_resultado IS NULL OR p_resultado NOT IN ('linhas', 'vazio') THEN
    RAISE EXCEPTION 'p_resultado inválido: % (esperado linhas ou vazio)',
      coalesce(p_resultado, 'null') USING ERRCODE = 'FG103';
  END IF;
  IF p_linhas_geradas IS NULL OR p_linhas_geradas < 0 THEN
    RAISE EXCEPTION 'p_linhas_geradas deve ser >= 0 (recebido: %)',
      coalesce(p_linhas_geradas::text, 'null') USING ERRCODE = 'FG103';
  END IF;
  IF (p_resultado = 'linhas') <> (p_linhas_geradas > 0) THEN
    RAISE EXCEPTION 'resultado=% é incoerente com linhas_geradas=%', p_resultado, p_linhas_geradas
      USING ERRCODE = 'FG103';
  END IF;

  -- 4) Completude: ausente vira `desconhecido`, NUNCA `completo` (§2: ausente ≠ completo).
  v_completude := coalesce(p_completude, 'desconhecido');
  IF v_completude NOT IN ('completo', 'degradado', 'desconhecido') THEN
    RAISE EXCEPTION 'p_completude inválido: % (esperado completo, degradado ou desconhecido)', p_completude
      USING ERRCODE = 'FG103';
  END IF;
  IF v_completude = 'degradado' AND (p_motivo IS NULL OR btrim(p_motivo) = '') THEN
    RAISE EXCEPTION 'completude=degradado exige p_motivo — sem ele o rótulo não distingue "zero de verdade" de "zero por dado faltando"'
      USING ERRCODE = 'FG104';
  END IF;

  IF p_insumos IS NOT NULL AND jsonb_typeof(p_insumos) <> 'object' THEN
    RAISE EXCEPTION 'p_insumos deve ser objeto jsonb (recebido: %)', jsonb_typeof(p_insumos)
      USING ERRCODE = 'FG103';
  END IF;
  -- Teto: o payload é diagnóstico, não carga. ~8 kB cobre uma dezena de insumos com folga.
  IF p_insumos IS NOT NULL AND length(p_insumos::text) > 8000 THEN
    RAISE EXCEPTION 'p_insumos excede 8000 chars (%) — é diagnóstico, não carga', length(p_insumos::text)
      USING ERRCODE = 'FG103';
  END IF;

  -- 4b) `resultado='linhas'` é ANCORADO NA REALIDADE, não na palavra de quem chama.
  -- Sem isto, o browser pode gravar um head afirmando "linhas" sem existir linha nenhuma —
  -- e o head é MEDIÇÃO: medição forjável é medição corrompida, e é sobre ela que a fase 2
  -- decidiria ligar a expiração. Funciona porque as RPCs de substituição INSEREM antes de
  -- chamar esta função, na MESMA transação, então as linhas já estão visíveis aqui.
  -- (O caminho 'vazio' não precisa do espelho: o run é novo, então "não há linha com este
  -- run_id" é trivialmente verdade. Forjar 'vazio' só prejudica o próprio farmer, que é o
  -- único que o gate deixa passar — e nesta fase nada é expirado por causa disso.)
  -- ⚠️ CONTA no servidor, não confia no número do chamador. `EXISTS` sozinho aceitava
  -- "1 linha real, 999 declaradas" (achado do challenge Codex xhigh) — e `linhas_geradas`
  -- é o que a fase 2 leria para dimensionar. O parâmetro do chamador vira o que ele
  -- sempre foi: uma alegação, conferida contra o fato.
  IF p_resultado = 'linhas' THEN
    IF p_motor = 'cross_sell' THEN
      SELECT count(*) INTO v_reais FROM public.farmer_recommendations
      WHERE farmer_id = p_farmer_id AND run_id = p_run_id AND status = 'pendente';
    ELSE
      SELECT count(*) INTO v_reais FROM public.farmer_bundle_recommendations
      WHERE farmer_id = p_farmer_id AND run_id = p_run_id AND status = 'pendente';
    END IF;

    IF v_reais = 0 THEN
      RAISE EXCEPTION 'resultado=linhas sem nenhuma linha gravada para o run % — o head não inventa geração', p_run_id
        USING ERRCODE = 'FG107';
    END IF;
    IF v_reais <> p_linhas_geradas THEN
      RAISE EXCEPTION 'resultado=linhas declarou % linha(s), mas há % gravada(s) para o run %',
        p_linhas_geradas, v_reais, p_run_id USING ERRCODE = 'FG107';
    END IF;
  ELSE
    -- `vazio` também é ancorado: declarar vazio com linhas pendentes daquele run seria
    -- um head que contradiz a própria tabela. (O run é novo no caminho normal, então isto
    -- é trivialmente verdade — o guard existe para o chamador que reusa um run_id.)
    IF p_motor = 'cross_sell' THEN
      SELECT count(*) INTO v_reais FROM public.farmer_recommendations
      WHERE farmer_id = p_farmer_id AND run_id = p_run_id AND status = 'pendente';
    ELSE
      SELECT count(*) INTO v_reais FROM public.farmer_bundle_recommendations
      WHERE farmer_id = p_farmer_id AND run_id = p_run_id AND status = 'pendente';
    END IF;
    IF v_reais > 0 THEN
      RAISE EXCEPTION 'resultado=vazio, mas há % linha(s) pendente(s) gravada(s) para o run %',
        v_reais, p_run_id USING ERRCODE = 'FG107';
    END IF;
  END IF;

  -- 5) SERIALIZAÇÃO — o MESMO lock da RPC de substituição do motor correspondente.
  -- Lock próprio serializaria este caminho só consigo mesmo, o que é o mesmo que não
  -- serializar: um registro de "vazio" correria em paralelo com uma substituição com
  -- linhas. Reentrante de propósito: quando a própria RPC de substituição chama esta
  -- função, a transação JÁ detém o lock e o try devolve true.
  -- ⚠️ A reentrância é APOSTA de desenho, então foi MEDIDA no PG17 antes de confiar nela
  -- (3 `pg_try_advisory_xact_lock` com as mesmas chaves na mesma transação):
  --   1ª/2ª/3ª => true, true, true
  --   pg_locks WHERE locktype='advisory' => 1 (uma entrada, não três: o variante `xact`
  --     NÃO faz refcount como o `pg_advisory_lock` de sessão, então não há unlock a dever)
  --   após COMMIT => 0 (some sozinho, que é o motivo de ser `xact` e não de sessão)
  IF NOT pg_try_advisory_xact_lock(
        hashtext(CASE p_motor
                   WHEN 'cross_sell' THEN 'farmer_recomendacoes_substituir'
                   ELSE                    'farmer_bundle_recomendacoes_substituir'
                 END),
        hashtext(p_farmer_id::text)) THEN
    RAISE EXCEPTION 'outro recálculo deste farmer está em andamento — o head não foi movido'
      USING ERRCODE = 'FG105';
  END IF;

  -- 6) CAS do head. O advisory lock cobre só ESTA transação — não a janela longa entre
  -- "o motor leu o head" e "o motor chamou esta função". Sem o CAS, um run VAZIO lento
  -- sobrescreveria o head de um run COM LINHAS que terminou antes, e a medição
  -- registraria `vazio` para um estado que é `linhas` (money-path §10: o degradado
  -- terminar depois do saudável é o desfecho ESPERADO, não o azar). Não depende de
  -- relógio nenhum — nem do browser, nem do servidor. NULL casa NULL: head ainda ausente.
  SELECT run_id INTO v_head_atual
  FROM public.farmer_geracao_vigente
  WHERE motor = p_motor AND farmer_id = p_farmer_id;
  v_existia := FOUND;

  IF v_head_atual IS DISTINCT FROM p_head_visto THEN
    RAISE EXCEPTION 'head de geração mudou durante o cálculo (visto: %, atual: %) — nada foi registrado',
      coalesce(p_head_visto::text, 'nenhum'), coalesce(v_head_atual::text, 'nenhum')
      USING ERRCODE = 'FG106';
  END IF;

  -- 7) O head AVANÇA — inclusive quando resultado='vazio'. É o ponto inteiro da entrega.
  INSERT INTO public.farmer_geracao_vigente AS h (
    motor, farmer_id, run_id, resultado, linhas_geradas, completude, motivo, insumos,
    calculado_em, atualizado_em
  )
  VALUES (
    p_motor, p_farmer_id, p_run_id, p_resultado, p_linhas_geradas, v_completude,
    p_motivo, coalesce(p_insumos, '{}'::jsonb), clock_timestamp(), clock_timestamp()
  )
  ON CONFLICT (motor, farmer_id) DO UPDATE
    SET run_id         = EXCLUDED.run_id,
        resultado      = EXCLUDED.resultado,
        linhas_geradas = EXCLUDED.linhas_geradas,
        completude     = EXCLUDED.completude,
        motivo         = EXCLUDED.motivo,
        insumos        = EXCLUDED.insumos,
        calculado_em   = EXCLUDED.calculado_em,
        -- `clock_timestamp()`, não `now()`: now() é o instante do BEGIN, e entre o BEGIN
        -- e esta escrita pode haver espera arbitrária (money-path §2).
        atualizado_em  = clock_timestamp();

  -- 8) O LOG, na MESMA transação — é ele que responde "com que FREQUÊNCIA", porque o head
  -- acima acabou de sobrescrever o estado anterior. `DO NOTHING` no conflito: um retry do
  -- mesmo run não pode virar duas execuções na contagem, senão a frequência mede retries.
  INSERT INTO public.farmer_geracao_execucoes (
    motor, farmer_id, run_id, resultado, linhas_geradas, completude, motivo, insumos, calculado_em
  )
  VALUES (
    p_motor, p_farmer_id, p_run_id, p_resultado, p_linhas_geradas, v_completude,
    p_motivo, coalesce(p_insumos, '{}'::jsonb), clock_timestamp()
  )
  ON CONFLICT (motor, farmer_id, run_id) DO NOTHING;

  RETURN jsonb_build_object(
    'motor',      p_motor,
    'run_id',     p_run_id,
    'resultado',  p_resultado,
    'completude', v_completude,
    'criado',     NOT v_existia
  );
END;
$function$;

-- ─── 5) As RPCs de substituição passam a mover o head na MESMA transação ───
-- Head e linhas em transações separadas divergiriam — e head divergente é MEDIÇÃO
-- CORROMPIDA, que é justamente o insumo com que a fase 2 decidiria ligar a expiração.
--
-- ⚠️ DROP + CREATE, não `CREATE OR REPLACE`: os parâmetros novos mudam a ARIDADE, e
-- `CREATE OR REPLACE` com aridade diferente cria uma SOBRECARGA em vez de substituir —
-- aí uma chamada de 4 args fica ambígua (42725) e o motor quebra em produção. Os
-- DEFAULTs preservam a assinatura de 4 args para o bundle velho em cache (o Publish do
-- Lovable é manual e não é instantâneo); nessa janela o head grava `desconhecido`.
--
-- O DROP foi medido em PROD antes de ser proposto — dropar função money-path às cegas é
-- como se derruba um caminho que ninguém sabia que existia (2026-08-15, psql-ro):
--   · pg_depend (deptype <> 'n') sobre as 2 funções ......... 0 dependentes
--     (nenhuma view, trigger ou DEFAULT de coluna presa a elas)
--   · funções cujo corpo as menciona ......................... só a própria MENSAGEM de
--     erro da trigger farmer_rec_exige_run_id e a auto-referência dos comentários delas
--     — nenhum chamador SQL real
--   · cron.job apontando para elas ........................... 0
--   · sobrecargas pré-existentes ............................. nenhuma (só a de 4 args)
-- Ou seja: o único chamador é o browser, via PostgREST — e ele resolve pela aridade, que
-- os DEFAULTs preservam.
DROP FUNCTION IF EXISTS public.farmer_recomendacoes_substituir(uuid, uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.farmer_bundle_recomendacoes_substituir(uuid, uuid, uuid, jsonb);

CREATE OR REPLACE FUNCTION public.farmer_recomendacoes_substituir(
  p_farmer_id     uuid,
  p_run_id        uuid,
  p_geracao_vista uuid,
  p_linhas        jsonb,
  p_completude    text  DEFAULT NULL,
  p_motivo        text  DEFAULT NULL,
  p_insumos       jsonb DEFAULT NULL,
  p_head_visto    uuid  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total          integer;
  v_invalidas      integer;
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
$function$;

CREATE OR REPLACE FUNCTION public.farmer_bundle_recomendacoes_substituir(
  p_farmer_id     uuid,
  p_run_id        uuid,
  p_geracao_vista uuid,
  p_linhas        jsonb,
  p_completude    text  DEFAULT NULL,
  p_motivo        text  DEFAULT NULL,
  p_insumos       jsonb DEFAULT NULL,
  p_head_visto    uuid  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total         integer;
  v_invalidas     integer;
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
$function$;

-- ─── 6) Permissões das assinaturas NOVAS ───
-- As antigas (4 args) foram DROPADAS acima, junto com os grants delas.
REVOKE ALL ON FUNCTION public.farmer_geracao_registrar(text, uuid, uuid, text, integer, text, text, jsonb, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.farmer_recomendacoes_substituir(uuid, uuid, uuid, jsonb, text, text, jsonb, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.farmer_bundle_recomendacoes_substituir(uuid, uuid, uuid, jsonb, text, text, jsonb, uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.farmer_geracao_registrar(text, uuid, uuid, text, integer, text, text, jsonb, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.farmer_recomendacoes_substituir(uuid, uuid, uuid, jsonb, text, text, jsonb, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.farmer_bundle_recomendacoes_substituir(uuid, uuid, uuid, jsonb, text, text, jsonb, uuid) TO authenticated, service_role;

-- ⚠️ O PostgREST só enxerga assinatura nova depois de recarregar o schema cache. Sem isto,
-- a janela entre o apply e o reload devolve 404/PGRST202 para a RPC nova — e como o
-- registro do head é fail-open, a falha sairia só num console.error: o sensor nasceria
-- cego sem ninguém perceber. O repo já usa este NOTIFY (padrão das migrations tint).
NOTIFY pgrst, 'reload schema';

-- ─── 7) QUANDO MEDIR — é query, não recado ───
-- ⚠️ A medição sai do LOG (`farmer_geracao_execucoes`), NÃO do head: o head guarda só o
-- último estado de cada par, então um `vazio+completo` que aconteceu ontem e foi seguido
-- de um run com linhas SUMIRIA dele. Perguntar frequência ao head devolveria "nunca
-- aconteceu" para algo que aconteceu — a mesma ausência-de-dado que o sensor cura.
--
--   -- FREQUÊNCIA (a pergunta que originou a entrega), com DENOMINADOR:
--   SELECT motor, resultado, completude,
--          count(*)                                        AS execucoes,
--          round(100.0*count(*)/sum(count(*)) OVER (PARTITION BY motor), 1) AS pct_do_motor,
--          count(DISTINCT farmer_id)                       AS farmers,
--          min(calculado_em)::date                         AS desde,
--          max(calculado_em)                               AS ultima
--   FROM public.farmer_geracao_execucoes
--   GROUP BY 1,2,3 ORDER BY 1,2,3;
--
--   -- O SINAL que a fase 2 exige (>= 1 linha aqui, com insumos plausíveis):
--   SELECT farmer_id, run_id, calculado_em, insumos
--   FROM public.farmer_geracao_execucoes
--   WHERE resultado = 'vazio' AND completude = 'completo'
--     AND (insumos->'scores'->>'n')::int    > 0
--     AND (insumos->'vendaveis'->>'n')::int > 0
--   ORDER BY calculado_em DESC;
--
-- Enquanto a 2ª query não devolver linha, "está no ar e ninguém reclamou" continua sendo
-- AUSÊNCIA DE DADO — e a expiração por vazio não tem sinal que a justifique.
--
-- O head segue útil para outra pergunta (estado corrente + o CAS):
--   SELECT motor, farmer_id, resultado, completude, calculado_em
--   FROM public.farmer_geracao_vigente ORDER BY 1,2;
