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

-- Normaliza texto para decisão de "tem conteúdo?": remove TODO whitespace unicode (btrim() padrão só
-- remove espaço ASCII, então E'\t' e NBSP passavam como valor preenchido — Codex v5).
CREATE OR REPLACE FUNCTION public.reposicao__nz(p text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$fn$ SELECT COALESCE(regexp_replace(p, '[[:space:]\u0085\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000]+', '', 'g'), '') $fn$;

-- IDENTIDADE do PO — função SEPARADA da nz(), porque os propósitos são INCOMPATÍVEIS (Codex v6):
--   nz() responde "tem conteúdo?" → remover whitespace INTERNO é inofensivo;
--   aqui responde "QUAL PO é este?" → remover interno seria COLISÃO ('12 34' e '1234' viram o mesmo PO).
-- Portanto: trim só nas BORDAS; whitespace interno INVALIDA. Leading zeros são normalizados ('00145' = 145,
-- inclusive com 20+ chars). Fora do range de bigint → NULL (o cast estouraria e DERRUBARIA a RPC).
-- Retorna NULL para "não interpretável" — e a RPC distingue isso de "ausente", em vez de afirmar ausência.
CREATE OR REPLACE FUNCTION public.reposicao__po_id(p text)
RETURNS bigint LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
DECLARE t text; b text := '[[:space:]\u0085\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000]';
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
  dano_ativo             boolean,
  valor_total            numeric,
  visto_status           text,
  po_no_espelho          boolean,
  fornecedor_nome        text,
  canal_usado            text,
  -- EVIDÊNCIA encontrada (não decisão): qual sinal de compromisso com o fornecedor existe.
  compromisso_fornecedor text,
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
      (SELECT sum(i.valor_linha) FROM public.pedido_compra_item i WHERE i.pedido_id = p.id) AS valor_total,
      EXISTS (
        SELECT 1 FROM public.purchase_orders_tracking t
        WHERE t.empresa = v_empresa
          -- compara NUMERICAMENTE (não texto): '00101' e '101' são o MESMO PO. Comparar `bigint::text`
          -- com o texto cru faria o PO "desaparecer" do espelho por leading zero (Codex v3).
          -- {1,18} dígitos: 19+ estoura o bigint e o cast DERRUBA a RPC inteira ('numeric value out of
          -- range' — Codex v4). btrim ANTES da regex: o filtro já usava btrim, a regex não (' 00126 ' virava
          -- NULL e o PO "desaparecia"). Comparação NUMÉRICA: '00126' e 126 são o MESMO PO.
          AND t.omie_codigo_pedido = public.reposicao__po_id(p.omie_pedido_compra_id)
      ) AS po_no_espelho
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
    (b.idade_dias <= 7) AS dano_ativo,
    b.valor_total,
    -- ⚠️ identidade ILEGÍVEL não é "nunca visto": o LEFT JOIN não pôde nem comparar. Afirmar ausência aqui
    -- era falha ABERTA (Codex v6 P1) — e o assert J3 chegava a FIXAR esse falso-positivo como esperado.
    CASE
      WHEN public.reposicao__po_id(b.omie_codigo_pedido) IS NULL THEN 'identidade_nao_interpretavel'
      WHEN b.visto_run_id IS NULL                                THEN 'nunca_carimbado'
      ELSE 'visto_em_run_anterior'
    END AS visto_status,
    -- SINAL FRACO: o sync do tracking é upsert-only (nunca remove) → ausência do espelho NÃO prova exclusão.
    b.po_no_espelho,
    b.fornecedor_nome,
    b.canal_usado,
    -- EVIDÊNCIA, não decisão. As regexes provam PRESENÇA de compromisso; a ausência delas NÃO prova
    -- ausência de compromisso — por isso o rótulo final é 'sem_sinal_conhecido', não 'nenhum'.
    -- Rótulos FACTUAIS: dizem o que foi OBSERVADO, não o que se conclui. 'protocolado' afirmava que HÁ
    -- protocolo — mas portal_protocolo='N/A' e {"erro":"protocolo ausente"} também casavam, produzindo
    -- EVIDÊNCIA FALSA (Codex v4 P1-1: o problema "chave não prova valor" migrou de rota falsa p/ rótulo falso).
    -- E 'sem_sinal_conhecido' mentia quando canal_usado estava preenchido: o canal É um sinal (P1-2).
    -- ⚠️ btrim() padrão só remove ESPAÇO ASCII: E'\t' e NBSP passavam como "preenchido" (Codex v5).
    -- nz() abaixo normaliza TODO whitespace unicode antes de decidir se o campo tem conteúdo.
    CASE
      WHEN public.reposicao__nz(b.portal_protocolo) <> ''                             THEN 'protocolo_preenchido'
      WHEN COALESCE(b.resposta_canal::text, '') ~* 'protocolo'                         THEN 'resposta_menciona_protocolo'
      -- limite à DIREITA também: sem ele 'sucessor' virava 'menciona sucesso' (Codex v5).
      WHEN lower(public.reposicao__nz(b.status_envio_portal)) ~ '(^|[^a-z])sucesso([^a-z]|$)' THEN 'status_menciona_sucesso'
      WHEN COALESCE(b.resposta_canal::text, '') ~* 'fornecedor.?notificad|notificado'  THEN 'resposta_menciona_notificacao'
      -- "presente" = tem CONTEÚDO (canal='' NÃO é sinal). portal_protocolo não entra aqui: se tivesse
      -- conteúdo já teria retornado 'protocolo_preenchido' acima — o ramo era redundante (Codex v6).
      WHEN public.reposicao__nz(b.canal_usado) <> ''
        OR public.reposicao__nz(b.status_envio_portal) <> ''
        OR b.resposta_canal IS NOT NULL                                               THEN 'sinal_presente_nao_reconhecido'
      ELSE 'sem_dado_de_canal'
    END AS compromisso_fornecedor,
    b.marcador_run_id,
    b.marcador_seq
  FROM base b
  ORDER BY (b.idade_dias <= 7) DESC, b.valor_total DESC NULLS LAST, b.pedido_id;
END;
$$;

COMMENT ON FUNCTION public.reposicao_pos_candidatos(text) IS
  'PR2 (NÃO-MUTANTE): pedidos disparado/aprovado cujo PO não apareceu no último run VÁLIDO. LISTA e EVIDENCIA — NÃO decide. Deliberadamente SEM rota automática: em prod 59/59 dos disparados acionaram portal do fornecedor (46 sayerlack + 13 b2b, 0 sem sinal), então "elegível a auto-cancelamento" é logicamente vazio; e canal/status/resposta são text/jsonb livres onde regex prova presença, nunca ausência. Todo candidato exige decisão humana; o PR3 deve provar por ID no Omie e tratar o compromisso com o fornecedor (provável: RECRIAR o PO, não cancelar). Sem marcador válido retorna VAZIO (fail-closed).';

REVOKE ALL ON FUNCTION public.reposicao_pos_candidatos(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reposicao_pos_candidatos(text) TO authenticated, service_role;

COMMIT;
