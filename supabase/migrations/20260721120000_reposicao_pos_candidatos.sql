-- Reposição — PR2: CANDIDATOS a PO excluído no Omie (detector, NÃO-MUTANTE) — money-path
-- ============================================================================
-- O PR1 (em prod desde 16/07) publica, a cada varredura COMPLETA e LIMPA, o marcador de run e o
-- `reposicao_po_last_seen` de todo PO visto. Esta RPC responde UMA pergunta factual: quais pedidos
-- `disparado`/`aprovado` têm um PO que NÃO apareceu no último run válido? Ela LISTA e EVIDENCIA.
-- Não muta, não cancela e — deliberadamente — **não decide**.
--
-- 🔑 POR QUE NÃO HÁ ROTA AUTOMÁTICA (a descoberta que encerrou 3 rodadas de endurecimento):
-- As versões anteriores tinham `rota = elegivel_prova_id | reconciliacao_humana`, tentando provar que
-- um pedido NÃO acionou o fornecedor (e portanto seria seguro cancelar). O Codex furou essa prova 3x
-- seguidas — sempre com um valor/shape novo — e o motivo é estrutural: `canal_usado`,
-- `status_envio_portal` e `resposta_canal` são TEXT/JSONB livres, multi-writer, sem contrato. Regex
-- sobre eles prova PRESENÇA, nunca AUSÊNCIA.
--
-- E o dado de PRODUÇÃO (18/07) mostrou que a pergunta era vazia: dos **59** pedidos disparados,
-- **46 `portal_sayerlack` + 13 `portal_b2b`, 100% com `resposta_canal`, ZERO sem sinal de fornecedor**.
-- O `disparar-pedidos-aprovados` só grava canal de portal — a allowlist ('omie','manual','interno') que
-- a v2/v3 usavam NÃO corresponde a nenhum canal real: era suposição minha.
-- ⇒ OBSERVAÇÃO (não implicação lógica — Codex v4): em prod, todo `disparado` tem canal de portal e
--   resposta_canal. Isso torna "elegível a auto-cancelamento" VAZIO na prática, e defendê-lo com heurística
--   sobre campos livres só criava superfície de bug. Ressalvas honestas: (a) "portal tentado" ≠ "fornecedor
--   compromissado" (timeout/rejeição existem); (b) `aprovado_aguardando_disparo` — hoje com ZERO registros —
--   é, pelo nome, anterior ao disparo e poderia legitimamente não ter compromisso. Uma rota automática
--   estreita para ESSE estado é possível no futuro, se houver garantia transacional do dispatcher.
--
-- Consequência para o PR3: cancelar automaticamente NÃO é seguro com os dados atuais. O caminho é
-- (a) prova por ID no Omie (`ConsultarPedCompra`) para saber se o PO existe, e (b) decisão HUMANA
-- sobre o compromisso com o fornecedor — provavelmente RECRIAR o PO no Omie, não cancelar e re-sugerir
-- (= comprar de novo). Caso real: pedidos 281/286 (Sayerlack, protocolos 2097501/2097910, entrega
-- prometida 10/06, ~R$3.060) — o fornecedor tem o pedido; o Omie é que perdeu o registro.
--
-- Design: docs/superpowers/specs/2026-07-11-reposicao-reconciliacao-po-excluido-omie-design.md §5.5
-- Prova PG17: db/test-reposicao-pos-candidatos.sh
-- NÃO editar esta migration depois de aplicada (snapshot é a fonte de DR).
-- ============================================================================
BEGIN;

-- Remove whitespace unicode apenas nas BORDAS. Substituiu a antiga nz(), que removia TAMBÉM o interno:
-- isso fazia a REGEX mentir — status_envio_portal='su cesso' virava 'sucesso' e o rótulo afirmava
-- 'status_menciona_sucesso' para um valor que NÃO menciona sucesso (Codex v8). Para "tem conteúdo?" o trim
-- de bordas basta; para identidade existe reposicao__po_id().
CREATE OR REPLACE FUNCTION public.reposicao__trim(p text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$fn$ SELECT COALESCE(regexp_replace(regexp_replace(p,
       '^[[:space:]\u0085\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]+', ''),
       '[[:space:]\u0085\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]+$', ''), '') $fn$;

-- IDENTIDADE do PO — função SEPARADA da nz(), porque os propósitos são INCOMPATÍVEIS (Codex v6):
--   nz() responde "tem conteúdo?" → remover whitespace INTERNO é inofensivo;
--   aqui responde "QUAL PO é este?" → remover interno seria COLISÃO ('12 34' e '1234' viram o mesmo PO).
-- Portanto: trim só nas BORDAS; whitespace interno INVALIDA. Leading zeros são normalizados ('00145' = 145,
-- inclusive com 20+ chars). Fora do range de bigint → NULL (o cast estouraria e DERRUBARIA a RPC).
-- Retorna NULL para "não interpretável" — e a RPC distingue isso de "ausente", em vez de afirmar ausência.
CREATE OR REPLACE FUNCTION public.reposicao__po_id(p text)
RETURNS bigint LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
DECLARE t text; b text := '[[:space:]\u0085\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]';
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  t := regexp_replace(regexp_replace(p, '^' || b || '+', ''), b || '+$', '');
  IF t !~ '^[0-9]+$' THEN RETURN NULL; END IF;   -- inclui whitespace interno e vazio
  t := ltrim(t, '0');
  IF t = '' THEN RETURN 0; END IF;
  IF length(t) > 19 OR (length(t) = 19 AND t > '9223372036854775807') THEN RETURN NULL; END IF;
  RETURN t::bigint;
END $fn$;


CREATE OR REPLACE FUNCTION public.reposicao_pos_candidatos(p_empresa text)
RETURNS TABLE (
  pedido_id              bigint,
  omie_codigo_pedido     text,
  data_ciclo             date,
  idade_dias             integer,
  na_janela_7d           boolean,
  valor_total            numeric,
  itens_sem_valor        integer,
  visto_status           text,
  po_no_espelho          boolean,
  fornecedor_nome        text,
  canal_usado            text,
  -- CAMPOS CRUS: sem eles, os fatos binários abaixo tornam 'sucesso' e 'sem sucesso' INDISTINGUÍVEIS —
  -- o comentário prometia que o consumidor leria os campos, mas eles não eram retornados (Codex v10).
  portal_protocolo       text,
  status_envio_portal    text,
  resposta_canal         jsonb,
  -- FATOS binários, sem interpretação (ver o comentário no corpo).
  tem_protocolo          boolean,
  tem_status_portal      boolean,
  tem_resposta_canal     boolean,
  tem_canal              boolean,
  algum_sinal_de_canal   boolean,
  marcador_run_id        uuid,
  marcador_seq           bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_empresa public.empresa_reposicao := upper(btrim(p_empresa))::public.empresa_reposicao;
BEGIN
  -- Gate cron-or-staff NULL-aware: uid presente exige staff; uid NULL (service_role/cron SQL-local) passa.
  -- ⚠️ NUNCA gatear por auth.role()='service_role' — o pg_cron roda como postgres SEM JWT (auth.role()=NULL)
  -- e o gate mataria o cron em SILÊNCIO (reposicao.md: mordido 2x, migrations 20260627130000/20260627200000).
  IF (SELECT auth.uid()) IS NOT NULL
     AND NOT (SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))) THEN
    RAISE EXCEPTION 'reposicao_pos_candidatos: acesso negado' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH marcador AS (
    -- "último completo válido" = maior fencing seq com volume_ok TRUE. Sem marcador → CROSS JOIN vazio →
    -- retorna VAZIO. Fail-closed: sem base de verdade não se classifica ninguém como ausente.
    SELECT r.run_id, r.seq
    FROM public.reposicao_pedidos_compra_run r
    WHERE r.empresa = v_empresa AND r.status = 'ok' AND r.volume_ok IS TRUE
    ORDER BY r.seq DESC
    LIMIT 1
  ),
  base AS (
    SELECT
      p.id AS pedido_id,
      p.omie_pedido_compra_id AS omie_codigo_pedido,
      p.data_ciclo::date AS data_ciclo,
      (now()::date - p.data_ciclo::date)::integer AS idade_dias,
      p.fornecedor_nome,
      p.canal_usado,
      p.portal_protocolo,
      p.status_envio_portal,
      p.resposta_canal,
      m.run_id AS marcador_run_id,
      m.seq AS marcador_seq,
      ls.run_id AS visto_run_id,
      -- ⚠️ sum() IGNORA NULL: itens (100.00, NULL) davam 100.00, apresentando SUBTOTAL como total apurado —
      -- fabricação de número, o que o money-path.md proíbe ("ausente ≠ zero"). Agora o total só existe se
      -- TODOS os itens têm valor; senão NULL, e itens_sem_valor diz por quê (Codex v8).
      (SELECT CASE WHEN count(*) FILTER (WHERE i.valor_linha IS NULL) = 0
                   THEN sum(i.valor_linha) END
         FROM public.pedido_compra_item i WHERE i.pedido_id = p.id) AS valor_total,
      (SELECT count(*) FILTER (WHERE i.valor_linha IS NULL)
         FROM public.pedido_compra_item i WHERE i.pedido_id = p.id)::integer AS itens_sem_valor,
      -- ⚠️ NULL (não FALSE) quando a identidade é ILEGÍVEL: `EXISTS(... = NULL)` retorna false, e a RPC
      -- estaria AFIRMANDO ausência no espelho sem sequer conseguir identificar o PO (Codex v7).
      -- "Não apurei" ≠ "não há" — a mesma distinção de visto_status='identidade_nao_interpretavel'.
      CASE WHEN public.reposicao__po_id(p.omie_pedido_compra_id) IS NULL THEN NULL ELSE EXISTS (
        SELECT 1 FROM public.purchase_orders_tracking t
        WHERE t.empresa = v_empresa
          -- identidade NUMÉRICA canônica (reposicao__po_id): '00101' e '101' são o MESMO PO; whitespace de
          -- borda tolerado, interno invalida; fora do range de bigint → NULL em vez de derrubar a RPC.
          AND t.omie_codigo_pedido = public.reposicao__po_id(p.omie_pedido_compra_id)
      ) END AS po_no_espelho
    FROM public.pedido_compra_sugerido p
    CROSS JOIN marcador m
    LEFT JOIN public.reposicao_po_last_seen ls
           ON ls.empresa = v_empresa
          AND ls.omie_codigo_pedido = public.reposicao__po_id(p.omie_pedido_compra_id)
    -- ⚠️ `pedido_compra_sugerido.empresa` é **text** ('OBEN'); as outras tabelas usam o ENUM empresa_reposicao.
    -- text = enum direto é erro de TIPO em runtime (PL/pgSQL late-bound: o CREATE passa, quebra ao EXECUTAR).
    WHERE upper(btrim(p.empresa)) = v_empresa::text
      AND p.status IN ('disparado', 'aprovado_aguardando_disparo')
      AND p.omie_pedido_compra_id IS NOT NULL
      AND btrim(p.omie_pedido_compra_id) <> ''
      -- CANDIDATO = o PO não foi visto no marcador atual (carimbado por run ANTERIOR ou NUNCA carimbado).
      AND (ls.run_id IS NULL OR ls.run_id <> m.run_id)
  )
  SELECT
    b.pedido_id,
    b.omie_codigo_pedido,
    b.data_ciclo,
    b.idade_dias,
    -- DANO ATIVO = a CTE em_transito só soma disparados dos últimos 7d. Idade = PRIORIDADE, não verdade.
    -- NOME FACTUAL: a RPC apura a JANELA, nao o dano (um aprovado_aguardando_disparo de 3 dias sem canal
    -- nenhum recebia dano_ativo=true so pela idade — Codex v9). Quem decide se ha dano e o consumidor.
    (b.idade_dias BETWEEN 0 AND 7) AS na_janela_7d,
    b.valor_total,
    b.itens_sem_valor,
    -- ⚠️ identidade ILEGÍVEL não é "nunca visto": o LEFT JOIN não pôde nem comparar. Afirmar ausência aqui
    -- era falha ABERTA (Codex v6 P1) — e o assert J3 chegava a FIXAR esse falso-positivo como esperado.
    CASE
      WHEN public.reposicao__po_id(b.omie_codigo_pedido) IS NULL THEN 'identidade_nao_interpretavel'
      -- 'sem_registro_last_seen', não 'nunca_carimbado': a RPC prova a ausência ATUAL da linha, não que o PO
      -- nunca foi visto — a linha pode ter sido apagada/reconstruída (Codex v10). "Nunca" é afirmação de
      -- histórico, e histórico esta RPC não consulta.
      WHEN b.visto_run_id IS NULL                                THEN 'sem_registro_last_seen'
      ELSE 'visto_em_run_anterior'
    END AS visto_status,
    -- SINAL FRACO: o sync do tracking é upsert-only (nunca remove) → ausência do espelho NÃO prova exclusão.
    b.po_no_espelho,
    b.fornecedor_nome,
    b.canal_usado,
    -- 🔑 SEM REGEX SEMÂNTICA (Codex v9). Quatro rodadas seguidas acharam um valor que enganava o rótulo:
    -- 'su cesso' virava sucesso por coerção de whitespace; 'sem sucesso' casava a regex; e a guarda de
    -- negação criou falso-NEGATIVO ('login: sucesso' — o `in` casa no fim de "log-IN") e falso-POSITIVO
    -- ('não houve sucesso' — o [^a-z]* não atravessa "houve"). Interpretar texto LIVRE de terceiro por regex
    -- não converge, e o rótulo não decide nada desde que a coluna `rota` morreu na v4.
    -- Ficam só FATOS BINÁRIOS incontestáveis. O humano/PR3 lê os campos crus (portal_protocolo,
    -- status_envio_portal, resposta_canal, canal_usado) e interpreta com o contexto que a RPC não tem.
    b.portal_protocolo,
    b.status_envio_portal,
    b.resposta_canal,
    (public.reposicao__trim(b.portal_protocolo) <> '')    AS tem_protocolo,
    (public.reposicao__trim(b.status_envio_portal) <> '') AS tem_status_portal,
    -- ⚠️ JSON null ('null'::jsonb) NÃO é SQL NULL: `IS NOT NULL` dava true e a RPC afirmava resposta
    -- existente onde não há nenhuma (Codex v10).
    (b.resposta_canal IS NOT NULL AND jsonb_typeof(b.resposta_canal) <> 'null') AS tem_resposta_canal,
    (public.reposicao__trim(b.canal_usado) <> '')         AS tem_canal,
    -- "há algum indício de que o fornecedor foi acionado?" — OR simples, sem inferência.
    (public.reposicao__trim(b.portal_protocolo) <> ''
      OR public.reposicao__trim(b.status_envio_portal) <> ''
      OR (b.resposta_canal IS NOT NULL AND jsonb_typeof(b.resposta_canal) <> 'null')
      OR public.reposicao__trim(b.canal_usado) <> '')     AS algum_sinal_de_canal,
    b.marcador_run_id,
    b.marcador_seq
  FROM base b
  ORDER BY (b.idade_dias BETWEEN 0 AND 7) DESC, b.valor_total DESC NULLS LAST, b.pedido_id;
END;
$$;

COMMENT ON FUNCTION public.reposicao_pos_candidatos(text) IS
  'PR2 (NÃO-MUTANTE): pedidos disparado/aprovado cujo PO não apareceu no último run VÁLIDO. LISTA e EVIDENCIA — NÃO decide. Deliberadamente SEM rota automática: em prod 59/59 dos disparados acionaram portal do fornecedor (46 sayerlack + 13 b2b, 0 sem sinal), então "elegível a auto-cancelamento" é logicamente vazio; e canal/status/resposta são text/jsonb livres onde regex prova presença, nunca ausência. Todo candidato exige decisão humana; o PR3 deve provar por ID no Omie e tratar o compromisso com o fornecedor (provável: RECRIAR o PO, não cancelar). Sem marcador válido retorna VAZIO (fail-closed).';

REVOKE ALL ON FUNCTION public.reposicao_pos_candidatos(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reposicao_pos_candidatos(text) TO authenticated, service_role;

COMMIT;
