-- ============================================================
-- reposicao_po_a_baixar — Entrega A: PARES item a item no card + REGISTRO DA DECISÃO (sensor com denominador)
-- Predecessora: 20261118150731_reposicao_po_a_baixar.sql (fila só-leitura, Fase 1). Nada aqui escreve no Omie.
--
-- POR QUE UMA FUNÇÃO NOVA (_v2) E NÃO DROP+CREATE da reposicao_po_a_baixar: o RETURNS TABLE ganha colunas, o que
-- exige DROP — e DROP é DDL destrutivo, fora do envelope da sessão (database.md §1). A v2 é ADITIVA: o front que
-- já está no ar segue lendo a v1 até o Publish; a v1 fica intocada (aposentá-la é decisão do founder, depois).
--
-- 1. private._po_a_baixar_fila(empresa) — a LÓGICA da fila, sem gate (1 lugar; quem chama gateia). Mesma regra da v1
--    (po_contado_com_nf + nf_pendente) e, a mais:
--      · `pares` (jsonb) — os pares que a sombra JÁ calculou (recebimento_associacao_sombra.pares/.pedidos), com o
--        item do PO resolvido no espelho (raw_data.produtos_consulta por nCodItem): seq. da NF, PO, nº do item na
--        lista do PO, código/descrição do produto, quantidade, unidade, cobertura total/parcial. SÓ para
--        `associavel` com evidência FRESCA (≤ 36 h) — para ambigua/orfa/velha sai NULL e a tela mostra candidatos +
--        motivos (precisão > recall: par velho copiado no Omie é pior que par nenhum).
--      · `fornecedor_nome` nas nf_pendente (a v1 devolvia NULL): o nome do PO mais recente do mesmo
--        (empresa, fornecedor_codigo_omie) no espelho — a mesma fonte do nome no tipo po_contado_com_nf.
--      · `chave` (omie_codigo_pedido | nid_receb, em texto) e `proposta_versao` = md5 do que a tela MOSTRA como
--        proposta (classe, motivos, POs sugeridos, pares, unidades, NF, frescor) — sem o instante da leitura, para
--        uma releitura que não mudou nada não invalidar a decisão de quem está com a tela aberta.
-- 2. public.reposicao_po_a_baixar_v2(empresa) — gate idêntico ao da v1 + `decisao_vigente`/`decisao_vigente_em` do
--    episódio aberto (para a equipe ver "já marquei").
-- 3. Sensor (parecer Codex 2026-11-18, modo challenge, aplicado):
--      · reposicao_po_a_baixar_episodio — cada ENTRADA na fila é um episódio (reentrada abre outro: a decisão de um
--        episódio nunca confirma o seguinte). É o DENOMINADOR: registra quem entrou na fila mesmo sem decisão.
--        Writer ÚNICO: private.reposicao_po_a_baixar_registrar_episodios, com DUAS portas — pg_cron horário e a RPC
--        de decisão (que reconcilia antes de gravar, então o episódio existe mesmo se o cron ainda não passou).
--        Advisory xact lock por empresa nas duas portas (sem ele, o cron lê ausência e fecha depois de a decisão ter
--        lido presença). NÃO roda dentro da RPC de leitura (STABLE, paginada — N execuções por abertura de tela) nem
--        no edge da sombra (só conhece nf_pendente e exigiria deploy de edge).
--        O desfecho guarda FATOS lidos na releitura (estado/vínculo/classe da sombra, NF casada no espelho, PO
--        encerrado no Omie), revistos por 14 dias após a saída — a INTERPRETAÇÃO (confirmado ou não) é da query do
--        sensor (db/sensor-po-a-baixar.sql), nunca gravada.
--      · reposicao_po_a_baixar_decisao — ledger append-only da DECLARAÇÃO humana. Writer ÚNICO:
--        public.reposicao_po_a_baixar_registrar_decisao (gate uid + cap_compras_ler; cron não decide). Idempotência
--        por `intencao` (uuid gerado pelo cliente por clique, reusado no retry); mudar de ideia é nova linha; a
--        vigente é a de maior id do episódio. Precondição: a `proposta_versao` que a pessoa VIU tem de ser a viva
--        (PB002), e o item tem de estar na fila viva (PB001). Tipo × decisão: `encerrei` só para PO, `associei` só
--        para NF (CHECK na tabela + validação na RPC).
--      · A declaração é SENSOR, não verdade: não muda o motor de reposição nem a fila — a fila só sai por releitura.
-- Gate cron-or-staff NULL-aware (uid presente exige cap_compras_ler) na v2, igual à v1.
-- ============================================================
BEGIN;

-- ── tabelas do sensor ──────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reposicao_po_a_baixar_episodio (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa text NOT NULL CHECK (empresa IN ('OBEN', 'COLACOR')),
  tipo text NOT NULL CHECK (tipo IN ('po_contado_com_nf', 'nf_pendente')),
  chave text NOT NULL CHECK (btrim(chave) <> ''),
  numero_pedido text,
  numero_nfe text,
  -- carga_inicial = já estava na fila quando o sensor nasceu (idade desconhecida: fica FORA do tempo até resolução)
  origem text NOT NULL CHECK (origem IN ('carga_inicial', 'cron', 'decisao')),
  classe_na_entrada text,
  desatualizada_na_entrada boolean NOT NULL,
  -- quando a sombra viu a NF pela 1ª vez (≠ quando entrou na classe atual): guardada À PARTE, nunca como aberto_em
  sombra_primeira_observacao_em timestamptz,
  aberto_em timestamptz NOT NULL,
  visto_por_ultimo_em timestamptz NOT NULL,
  classe_atual text,
  desatualizada_atual boolean NOT NULL,
  proposta_versao_atual text NOT NULL,
  evidencia_em_atual timestamptz,
  fechado_em timestamptz,
  -- FATOS da releitura depois da saída (NULL = ainda não lido; revistos por 14 dias)
  desfecho_lido_em timestamptz,
  desfecho_estado_nf text,
  desfecho_vinculo text,
  desfecho_classe text,
  desfecho_nf_casada_espelho boolean,
  desfecho_po_encerrado_em timestamptz,
  CHECK (fechado_em IS NULL OR fechado_em >= aberto_em)
);
COMMENT ON TABLE public.reposicao_po_a_baixar_episodio IS
  'Sensor da fila "PO a baixar no Omie": 1 linha por ENTRADA na fila (denominador). Writer único: private.reposicao_po_a_baixar_registrar_episodios (cron horário + RPC de decisão). Desfecho = fatos da releitura; a interpretação é de db/sensor-po-a-baixar.sql.';
-- no máximo UM episódio aberto por item
CREATE UNIQUE INDEX IF NOT EXISTS reposicao_po_a_baixar_episodio_aberto_uniq
  ON public.reposicao_po_a_baixar_episodio (empresa, tipo, chave) WHERE fechado_em IS NULL;
CREATE INDEX IF NOT EXISTS reposicao_po_a_baixar_episodio_fechado_idx
  ON public.reposicao_po_a_baixar_episodio (empresa, fechado_em) WHERE fechado_em IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.reposicao_po_a_baixar_decisao (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  intencao uuid NOT NULL UNIQUE,
  episodio_id bigint NOT NULL REFERENCES public.reposicao_po_a_baixar_episodio(id),
  empresa text NOT NULL,
  tipo text NOT NULL,
  chave text NOT NULL,
  decisao text NOT NULL,
  operador uuid NOT NULL,
  decidido_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  proposta_versao text NOT NULL,
  evidencia_em timestamptz,
  classe_na_decisao text,
  evidencia_desatualizada boolean NOT NULL,
  CONSTRAINT reposicao_po_a_baixar_decisao_tipo_x_decisao CHECK (
    (tipo = 'po_contado_com_nf' AND decisao IN ('encerrei', 'parcial_aguardo_saldo', 'nao_se_aplica'))
    OR (tipo = 'nf_pendente' AND decisao IN ('associei', 'parcial_aguardo_saldo', 'nao_se_aplica'))
  )
);
COMMENT ON TABLE public.reposicao_po_a_baixar_decisao IS
  'Ledger append-only da DECLARAÇÃO humana na fila "PO a baixar no Omie" (sensor, não verdade). Writer único: public.reposicao_po_a_baixar_registrar_decisao. Vigente = maior id do episódio.';
CREATE INDEX IF NOT EXISTS reposicao_po_a_baixar_decisao_episodio_idx
  ON public.reposicao_po_a_baixar_decisao (episodio_id, id);

-- RLS: leitura só para quem lê compras; NENHUMA policy de escrita (os writers são SECURITY DEFINER)
ALTER TABLE public.reposicao_po_a_baixar_episodio ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reposicao_po_a_baixar_decisao ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reposicao_po_a_baixar_episodio_sel ON public.reposicao_po_a_baixar_episodio;
CREATE POLICY reposicao_po_a_baixar_episodio_sel ON public.reposicao_po_a_baixar_episodio
  FOR SELECT TO authenticated USING ((SELECT private.cap_compras_ler((SELECT auth.uid()))));
DROP POLICY IF EXISTS reposicao_po_a_baixar_decisao_sel ON public.reposicao_po_a_baixar_decisao;
CREATE POLICY reposicao_po_a_baixar_decisao_sel ON public.reposicao_po_a_baixar_decisao
  FOR SELECT TO authenticated USING ((SELECT private.cap_compras_ler((SELECT auth.uid()))));
REVOKE ALL ON TABLE public.reposicao_po_a_baixar_episodio FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.reposicao_po_a_baixar_decisao FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.reposicao_po_a_baixar_episodio TO authenticated;
GRANT SELECT ON TABLE public.reposicao_po_a_baixar_decisao TO authenticated;
GRANT ALL ON TABLE public.reposicao_po_a_baixar_episodio TO service_role;
GRANT ALL ON TABLE public.reposicao_po_a_baixar_decisao TO service_role;

-- ── 1. a lógica da fila (sem gate; só owner executa) ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private._po_a_baixar_fila(p_empresa text)
RETURNS TABLE(
  tipo text,
  empresa text,
  chave text,
  numero_pedido text,
  omie_codigo_pedido bigint,
  fornecedor_nome text,
  unidades_contadas numeric,
  numero_nfe text,
  nid_receb bigint,
  nf_recebida_em timestamptz,
  classe text,
  motivos text[],
  pedidos_sugeridos text[],
  pares jsonb,
  evidencia_em timestamptz,
  evidencia_desatualizada boolean,
  run_iniciado_em timestamptz,
  proposta_versao text
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
#variable_conflict use_column
DECLARE
  v_empresa text := upper(btrim(coalesce(p_empresa, '')));
BEGIN
  IF v_empresa NOT IN ('OBEN', 'COLACOR') THEN
    RAISE EXCEPTION '_po_a_baixar_fila: empresa invalida (%)', p_empresa USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH run AS (
    SELECT r.run_id, r.iniciado_em
      FROM public.reposicao_po_observado_run r
     WHERE r.empresa = v_empresa AND r.varredura_completa AND r.pendente_aplicado
     ORDER BY r.iniciado_em DESC
     LIMIT 1
  ), contado AS (
    SELECT i.omie_codigo_pedido AS cod, max(i.numero_pedido) AS num, sum(i.contribuicao) AS unidades
      FROM run JOIN public.reposicao_po_observado_item i ON i.run_id = run.run_id
     GROUP BY i.omie_codigo_pedido
    HAVING sum(i.contribuicao) > 0
  ), f AS (
    SELECT 'po_contado_com_nf'::text AS f_tipo, c.cod::text AS f_chave,
           coalesce(p.numero_pedido, c.num) AS f_numero_pedido, c.cod AS f_cod, p.fornecedor_nome AS f_fornecedor,
           c.unidades AS f_unidades, p.nfe_numero AS f_nfe, p.nid_receb AS f_nid, p.t4_data_recebimento AS f_nf_em,
           NULL::text AS f_classe, NULL::text[] AS f_motivos, NULL::text[] AS f_sugeridos, NULL::jsonb AS f_pares,
           run.iniciado_em AS f_evid, false AS f_velha, run.iniciado_em AS f_run
      FROM contado c
      CROSS JOIN run
      JOIN public.purchase_orders_tracking p
        ON p.empresa::text = v_empresa AND p.omie_codigo_pedido = c.cod
     WHERE p.t4_data_recebimento IS NOT NULL
    UNION ALL
    SELECT 'nf_pendente'::text, s.nid_receb::text,
           NULL::text, NULL::bigint,
           (SELECT pf.fornecedor_nome
              FROM public.purchase_orders_tracking pf
             WHERE pf.empresa::text = v_empresa
               AND pf.fornecedor_codigo_omie = s.fornecedor_codigo_omie
               AND nullif(btrim(pf.fornecedor_nome), '') IS NOT NULL
             ORDER BY pf.omie_codigo_pedido DESC
             LIMIT 1),
           NULL::numeric,
           s.numero_nfe, s.nid_receb, NULL::timestamptz,
           s.classe, s.motivos,
           (SELECT coalesce(array_agg(DISTINCT po.numero_pedido ORDER BY po.numero_pedido), ARRAY[]::text[])
              FROM public.purchase_orders_tracking po
             WHERE po.empresa::text = v_empresa
               AND po.omie_codigo_pedido > 0
               AND po.encerrado_omie_em IS NULL
               AND po.numero_contrato_fornecedor = ANY (s.contratos)),
           -- os pares SÓ para associavel com evidência fresca; o resto sai NULL (a tela mostra candidatos + motivos)
           CASE WHEN s.classe = 'associavel' AND s.observado_em >= now() - interval '36 hours' THEN (
             SELECT coalesce(jsonb_agg(jsonb_build_object(
                      'seq_nf', pr.par -> 'nSequencia',
                      'numero_pedido', coalesce(pd.numero_pedido, pop.numero_pedido),
                      'item_po', it.ord,
                      'codigo_produto', nullif(btrim(it.elem ->> 'cProduto'), ''),
                      'descricao', nullif(btrim(it.elem ->> 'cDescricao'), ''),
                      'quantidade', CASE WHEN jsonb_typeof(pr.par -> 'quantidade') = 'number' THEN pr.par -> 'quantidade' END,
                      'unidade', pr.par ->> 'unidade',
                      'cobertura', pd.cobertura
                    ) ORDER BY pr.par -> 'nSequencia', pr.ord), '[]'::jsonb)
               FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.pares) = 'array' THEN s.pares ELSE '[]'::jsonb END)
                    WITH ORDINALITY AS pr(par, ord)
               LEFT JOIN LATERAL (
                 SELECT d ->> 'numero_pedido' AS numero_pedido, d ->> 'cobertura' AS cobertura
                   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.pedidos) = 'array' THEN s.pedidos ELSE '[]'::jsonb END) d
                  WHERE d ->> 'nIdPedido' = pr.par ->> 'nIdPedido'
                  LIMIT 1) pd ON true
               LEFT JOIN LATERAL (
                 SELECT x.numero_pedido, x.raw_data
                   FROM public.purchase_orders_tracking x
                  WHERE x.empresa::text = v_empresa AND x.omie_codigo_pedido::text = pr.par ->> 'nIdPedido'
                  LIMIT 1) pop ON true
               LEFT JOIN LATERAL (
                 SELECT e.elem, e.ord
                   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(pop.raw_data -> 'produtos_consulta') = 'array'
                                                  THEN pop.raw_data -> 'produtos_consulta' ELSE '[]'::jsonb END)
                        WITH ORDINALITY AS e(elem, ord)
                  WHERE e.elem ->> 'nCodItem' = pr.par ->> 'nIdItPedido'
                  LIMIT 1) it ON true
           ) END,
           s.observado_em, s.observado_em < now() - interval '36 hours', NULL::timestamptz
      FROM public.recebimento_associacao_sombra s
     WHERE s.empresa = v_empresa
       AND s.estado_nf = 'pendente'
       AND s.classe IN ('associavel', 'ambigua', 'orfa')
       AND NOT EXISTS (SELECT 1 FROM public.purchase_orders_tracking pr
                        WHERE pr.empresa::text = v_empresa
                          AND pr.nid_receb = s.nid_receb
                          AND pr.t4_data_recebimento IS NOT NULL)
  )
  SELECT f.f_tipo, v_empresa, f.f_chave, f.f_numero_pedido, f.f_cod, f.f_fornecedor, f.f_unidades,
         f.f_nfe, f.f_nid, f.f_nf_em, f.f_classe, f.f_motivos, f.f_sugeridos, f.f_pares,
         f.f_evid, f.f_velha, f.f_run,
         md5(jsonb_build_array(f.f_tipo, f.f_chave, f.f_classe, to_jsonb(f.f_motivos), to_jsonb(f.f_sugeridos),
                               f.f_pares, f.f_unidades, f.f_nfe, f.f_velha)::text)
    FROM f;
END
$fn$;
REVOKE ALL ON FUNCTION private._po_a_baixar_fila(text) FROM PUBLIC, anon, authenticated;

-- ── 2. a fila para a tela ──────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reposicao_po_a_baixar_v2(p_empresa text)
RETURNS TABLE(
  tipo text,
  empresa text,
  chave text,
  numero_pedido text,
  omie_codigo_pedido bigint,
  fornecedor_nome text,
  unidades_contadas numeric,
  numero_nfe text,
  nid_receb bigint,
  nf_recebida_em timestamptz,
  classe text,
  motivos text[],
  pedidos_sugeridos text[],
  pares jsonb,
  evidencia_em timestamptz,
  evidencia_desatualizada boolean,
  run_iniciado_em timestamptz,
  proposta_versao text,
  decisao_vigente text,
  decisao_vigente_em timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
#variable_conflict use_column
DECLARE
  v_empresa text := upper(btrim(coalesce(p_empresa, '')));
BEGIN
  -- ⚠️ IS NOT TRUE (não NOT(...)): NULL vira negado — fail-closed (ver reposicao_pos_candidatos).
  IF (SELECT auth.uid()) IS NOT NULL
     AND (SELECT private.cap_compras_ler((SELECT auth.uid()))) IS NOT TRUE THEN
    RAISE EXCEPTION 'reposicao_po_a_baixar: acesso negado' USING ERRCODE = '42501';
  END IF;
  IF v_empresa NOT IN ('OBEN', 'COLACOR') THEN
    RAISE EXCEPTION 'reposicao_po_a_baixar: empresa invalida (%)', p_empresa USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT q.tipo, q.empresa, q.chave, q.numero_pedido, q.omie_codigo_pedido, q.fornecedor_nome, q.unidades_contadas,
         q.numero_nfe, q.nid_receb, q.nf_recebida_em, q.classe, q.motivos, q.pedidos_sugeridos, q.pares,
         q.evidencia_em, q.evidencia_desatualizada, q.run_iniciado_em, q.proposta_versao,
         dv.decisao, dv.decidido_em
    FROM private._po_a_baixar_fila(v_empresa) q
    LEFT JOIN public.reposicao_po_a_baixar_episodio ep
      ON ep.empresa = v_empresa AND ep.tipo = q.tipo AND ep.chave = q.chave AND ep.fechado_em IS NULL
    LEFT JOIN LATERAL (
      SELECT d.decisao, d.decidido_em
        FROM public.reposicao_po_a_baixar_decisao d
       WHERE d.episodio_id = ep.id
       ORDER BY d.id DESC
       LIMIT 1) dv ON true;
END
$fn$;
COMMENT ON FUNCTION public.reposicao_po_a_baixar_v2(text) IS
  'Fila "PO a baixar no Omie" (só leitura) com os pares item a item da sombra, fornecedor da NF, versão da proposta e a decisão vigente do episódio aberto. Sucessora aditiva da reposicao_po_a_baixar. Spec baixa-pedido-compra §19.';
REVOKE ALL ON FUNCTION public.reposicao_po_a_baixar_v2(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reposicao_po_a_baixar_v2(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.reposicao_po_a_baixar_v2(text) TO authenticated, service_role;

-- ── 3a. writer ÚNICO dos episódios (cron + RPC de decisão) ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.reposicao_po_a_baixar_registrar_episodios(p_empresa text, p_origem text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_empresa text := upper(btrim(coalesce(p_empresa, '')));
  v_agora timestamptz;
  v_fila jsonb;
  v_primeira boolean;
  v_fechados int;
  v_vistos int;
  v_abertos int;
  v_desfechos int;
BEGIN
  IF v_empresa NOT IN ('OBEN', 'COLACOR') THEN
    RAISE EXCEPTION 'reposicao_po_a_baixar_registrar_episodios: empresa invalida (%)', p_empresa USING ERRCODE = '22023';
  END IF;
  IF p_origem IS NULL OR p_origem NOT IN ('cron', 'decisao') THEN
    RAISE EXCEPTION 'reposicao_po_a_baixar_registrar_episodios: origem invalida (%)', p_origem USING ERRCODE = '22023';
  END IF;
  -- serializa as DUAS portas por empresa ANTES de ler (sem isto, uma fecha o que a outra acabou de ver presente)
  PERFORM pg_advisory_xact_lock(hashtext('reposicao_po_a_baixar_episodio'), hashtext(v_empresa));
  v_agora := clock_timestamp();
  v_primeira := NOT EXISTS (SELECT 1 FROM public.reposicao_po_a_baixar_episodio e WHERE e.empresa = v_empresa);
  -- a fila inteira numa tupla: um snapshot só para fechar, atualizar e abrir
  SELECT coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) INTO v_fila FROM private._po_a_baixar_fila(v_empresa) q;

  UPDATE public.reposicao_po_a_baixar_episodio e
     SET fechado_em = v_agora
   WHERE e.empresa = v_empresa
     AND e.fechado_em IS NULL
     AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(v_fila) AS x(tipo text, chave text)
                      WHERE x.tipo = e.tipo AND x.chave = e.chave);
  GET DIAGNOSTICS v_fechados = ROW_COUNT;

  UPDATE public.reposicao_po_a_baixar_episodio e
     SET visto_por_ultimo_em = v_agora,
         classe_atual = x.classe,
         desatualizada_atual = coalesce(x.evidencia_desatualizada, true),
         proposta_versao_atual = x.proposta_versao,
         evidencia_em_atual = x.evidencia_em,
         numero_pedido = coalesce(x.numero_pedido, e.numero_pedido),
         numero_nfe = coalesce(x.numero_nfe, e.numero_nfe)
    FROM jsonb_to_recordset(v_fila) AS x(tipo text, chave text, numero_pedido text, numero_nfe text, classe text,
                                         evidencia_desatualizada boolean, proposta_versao text, evidencia_em timestamptz)
   WHERE e.empresa = v_empresa AND e.fechado_em IS NULL AND e.tipo = x.tipo AND e.chave = x.chave;
  GET DIAGNOSTICS v_vistos = ROW_COUNT;

  INSERT INTO public.reposicao_po_a_baixar_episodio AS e (
    empresa, tipo, chave, numero_pedido, numero_nfe, origem, classe_na_entrada, desatualizada_na_entrada,
    sombra_primeira_observacao_em, aberto_em, visto_por_ultimo_em, classe_atual, desatualizada_atual,
    proposta_versao_atual, evidencia_em_atual)
  SELECT v_empresa, x.tipo, x.chave, x.numero_pedido, x.numero_nfe,
         CASE WHEN v_primeira THEN 'carga_inicial' ELSE p_origem END,
         x.classe, coalesce(x.evidencia_desatualizada, true),
         CASE WHEN x.tipo = 'nf_pendente' THEN
           (SELECT s.primeira_observacao_em FROM public.recebimento_associacao_sombra s
             WHERE s.empresa = v_empresa AND s.nid_receb::text = x.chave) END,
         v_agora, v_agora, x.classe, coalesce(x.evidencia_desatualizada, true), x.proposta_versao, x.evidencia_em
    FROM jsonb_to_recordset(v_fila) AS x(tipo text, chave text, numero_pedido text, numero_nfe text, classe text,
                                         evidencia_desatualizada boolean, proposta_versao text, evidencia_em timestamptz)
   WHERE NOT EXISTS (SELECT 1 FROM public.reposicao_po_a_baixar_episodio o
                      WHERE o.empresa = v_empresa AND o.tipo = x.tipo AND o.chave = x.chave AND o.fechado_em IS NULL)
  ON CONFLICT (empresa, tipo, chave) WHERE fechado_em IS NULL DO NOTHING;
  GET DIAGNOSTICS v_abertos = ROW_COUNT;

  -- desfecho: FATOS da releitura, revistos por 14 dias (uma saída lida cedo demais é corrigida quando a fonte anda)
  UPDATE public.reposicao_po_a_baixar_episodio e
     SET desfecho_lido_em = v_agora,
         desfecho_estado_nf = CASE WHEN e.tipo = 'nf_pendente' THEN s.estado_nf END,
         desfecho_vinculo = CASE WHEN e.tipo = 'nf_pendente' THEN s.vinculo END,
         desfecho_classe = CASE WHEN e.tipo = 'nf_pendente' THEN s.classe END,
         desfecho_nf_casada_espelho = CASE WHEN e.tipo = 'nf_pendente' THEN EXISTS (
           SELECT 1 FROM public.purchase_orders_tracking pr
            WHERE pr.empresa::text = v_empresa AND pr.nid_receb::text = e.chave AND pr.t4_data_recebimento IS NOT NULL) END,
         desfecho_po_encerrado_em = CASE WHEN e.tipo = 'po_contado_com_nf' THEN (
           SELECT max(po.encerrado_omie_em) FROM public.purchase_orders_tracking po
            WHERE po.empresa::text = v_empresa AND po.omie_codigo_pedido::text = e.chave) END
    FROM public.reposicao_po_a_baixar_episodio e2
    LEFT JOIN public.recebimento_associacao_sombra s
      ON e2.tipo = 'nf_pendente' AND s.empresa = v_empresa AND s.nid_receb::text = e2.chave
   WHERE e2.id = e.id
     AND e.empresa = v_empresa
     AND e.fechado_em IS NOT NULL
     AND e.fechado_em >= v_agora - interval '14 days';
  GET DIAGNOSTICS v_desfechos = ROW_COUNT;

  RETURN jsonb_build_object('empresa', v_empresa, 'na_fila', jsonb_array_length(v_fila), 'abertos', v_abertos,
                            'vistos', v_vistos, 'fechados', v_fechados, 'desfechos_lidos', v_desfechos,
                            'carga_inicial', v_primeira);
END
$fn$;
REVOKE ALL ON FUNCTION private.reposicao_po_a_baixar_registrar_episodios(text, text) FROM PUBLIC, anon, authenticated;

-- ── 3b. writer ÚNICO das decisões ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reposicao_po_a_baixar_registrar_decisao(
  p_empresa text, p_tipo text, p_chave text, p_decisao text, p_proposta_versao text, p_intencao uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_empresa text := upper(btrim(coalesce(p_empresa, '')));
  v_ex public.reposicao_po_a_baixar_decisao%ROWTYPE;
  v_ep public.reposicao_po_a_baixar_episodio%ROWTYPE;
  v_id bigint;
BEGIN
  -- cron/serviço NÃO decide: sem uid é negado (≠ do gate da leitura, que deixa o cron passar)
  IF v_uid IS NULL OR (SELECT private.cap_compras_ler(v_uid)) IS NOT TRUE THEN
    RAISE EXCEPTION 'reposicao_po_a_baixar_registrar_decisao: acesso negado' USING ERRCODE = '42501';
  END IF;
  IF v_empresa NOT IN ('OBEN', 'COLACOR') THEN
    RAISE EXCEPTION 'reposicao_po_a_baixar_registrar_decisao: empresa invalida (%)', p_empresa USING ERRCODE = '22023';
  END IF;
  IF p_intencao IS NULL OR nullif(btrim(p_chave), '') IS NULL OR nullif(btrim(p_proposta_versao), '') IS NULL THEN
    RAISE EXCEPTION 'reposicao_po_a_baixar_registrar_decisao: intencao, chave e proposta_versao sao obrigatorias' USING ERRCODE = '22023';
  END IF;
  IF NOT ((p_tipo = 'po_contado_com_nf' AND p_decisao IN ('encerrei', 'parcial_aguardo_saldo', 'nao_se_aplica'))
       OR (p_tipo = 'nf_pendente' AND p_decisao IN ('associei', 'parcial_aguardo_saldo', 'nao_se_aplica'))) THEN
    RAISE EXCEPTION 'reposicao_po_a_baixar_registrar_decisao: decisao % nao vale para %', p_decisao, p_tipo USING ERRCODE = '22023';
  END IF;

  -- retry da MESMA intenção é reconhecido ANTES de exigir a fila viva: a fila pode ter andado entre o 1º envio
  -- (que gravou) e o retry (cuja resposta se perdeu) — o retry não pode virar PB001/PB002 de algo já registrado

  SELECT * INTO v_ex FROM public.reposicao_po_a_baixar_decisao d WHERE d.intencao = p_intencao;
  IF FOUND THEN
    IF v_ex.operador = v_uid AND v_ex.empresa = v_empresa AND v_ex.tipo = p_tipo AND v_ex.chave = p_chave
       AND v_ex.decisao = p_decisao THEN
      RETURN jsonb_build_object('id', v_ex.id, 'episodio_id', v_ex.episodio_id, 'ja_registrada', true);
    END IF;
    RAISE EXCEPTION 'reposicao_po_a_baixar_registrar_decisao: intencao reutilizada com outro conteudo' USING ERRCODE = '22023';
  END IF;

  PERFORM private.reposicao_po_a_baixar_registrar_episodios(v_empresa, 'decisao');
  SELECT * INTO v_ep FROM public.reposicao_po_a_baixar_episodio e
   WHERE e.empresa = v_empresa AND e.tipo = p_tipo AND e.chave = p_chave AND e.fechado_em IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reposicao_po_a_baixar_registrar_decisao: item saiu da fila' USING ERRCODE = 'PB001';
  END IF;
  IF v_ep.proposta_versao_atual IS DISTINCT FROM p_proposta_versao THEN
    RAISE EXCEPTION 'reposicao_po_a_baixar_registrar_decisao: a proposta mudou desde a leitura' USING ERRCODE = 'PB002';
  END IF;

  INSERT INTO public.reposicao_po_a_baixar_decisao (
    intencao, episodio_id, empresa, tipo, chave, decisao, operador, proposta_versao, evidencia_em,
    classe_na_decisao, evidencia_desatualizada)
  VALUES (p_intencao, v_ep.id, v_empresa, p_tipo, p_chave, p_decisao, v_uid, v_ep.proposta_versao_atual,
          v_ep.evidencia_em_atual, v_ep.classe_atual, v_ep.desatualizada_atual)
  ON CONFLICT (intencao) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN  -- retry concorrente da mesma intenção ganhou a corrida
    SELECT * INTO v_ex FROM public.reposicao_po_a_baixar_decisao d WHERE d.intencao = p_intencao;
    RETURN jsonb_build_object('id', v_ex.id, 'episodio_id', v_ex.episodio_id, 'ja_registrada', true);
  END IF;
  RETURN jsonb_build_object('id', v_id, 'episodio_id', v_ep.id, 'ja_registrada', false);
END
$fn$;
COMMENT ON FUNCTION public.reposicao_po_a_baixar_registrar_decisao(text, text, text, text, text, uuid) IS
  'Registra a DECLARAÇÃO da equipe sobre um item da fila "PO a baixar no Omie" (sensor; não muda motor nem fila). Idempotente por intencao; PB001 = saiu da fila, PB002 = proposta mudou.';
REVOKE ALL ON FUNCTION public.reposicao_po_a_baixar_registrar_decisao(text, text, text, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reposicao_po_a_baixar_registrar_decisao(text, text, text, text, text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.reposicao_po_a_baixar_registrar_decisao(text, text, text, text, text, uuid) TO authenticated, service_role;

-- ── 3c. a porta do cron (horária; SQL puro, sem net.http_post — não há timeout a configurar) ─────────────────────
SELECT cron.schedule('reposicao-po-a-baixar-episodios', '17 * * * *',
  $cron$SELECT private.reposicao_po_a_baixar_registrar_episodios('OBEN', 'cron'); SELECT private.reposicao_po_a_baixar_registrar_episodios('COLACOR', 'cron');$cron$);

-- ── postcondição ───────────────────────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_fila oid := to_regprocedure('private._po_a_baixar_fila(text)');
  v_v2 oid := to_regprocedure('public.reposicao_po_a_baixar_v2(text)');
  v_ep oid := to_regprocedure('private.reposicao_po_a_baixar_registrar_episodios(text,text)');
  v_dec oid := to_regprocedure('public.reposicao_po_a_baixar_registrar_decisao(text,text,text,text,text,uuid)');
  r record;
BEGIN
  IF v_fila IS NULL OR v_v2 IS NULL OR v_ep IS NULL OR v_dec IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: alguma funcao nao existe (fila=% v2=% episodios=% decisao=%)', v_fila, v_v2, v_ep, v_dec;
  END IF;
  FOR r IN SELECT p.oid, p.proname, p.prosecdef, p.proconfig FROM pg_proc p WHERE p.oid IN (v_v2, v_ep, v_dec) LOOP
    IF NOT r.prosecdef THEN
      RAISE EXCEPTION 'POSTCONDICAO FALHOU: % sem SECURITY DEFINER', r.proname;
    END IF;
    IF NOT (r.proconfig @> ARRAY['search_path=public, pg_temp']) THEN
      RAISE EXCEPTION 'POSTCONDICAO FALHOU: % sem search_path fixo (SECURITY DEFINER sequestravel)', r.proname;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', v_v2, 'EXECUTE') OR has_function_privilege('anon', v_dec, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: anon tem EXECUTE na v2 ou na RPC de decisao';
  END IF;
  IF NOT has_function_privilege('authenticated', v_v2, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_dec, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: authenticated sem EXECUTE na v2 ou na RPC de decisao (a tela quebraria)';
  END IF;
  IF has_function_privilege('authenticated', v_ep, 'EXECUTE') OR has_function_privilege('anon', v_ep, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fila, 'EXECUTE') OR has_function_privilege('anon', v_fila, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: writer de episodios ou logica da fila executavel por anon/authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c WHERE c.oid IN ('public.reposicao_po_a_baixar_episodio'::regclass,
                                                       'public.reposicao_po_a_baixar_decisao'::regclass)
              AND NOT c.relrowsecurity) THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: tabela do sensor sem RLS';
  END IF;
  IF has_table_privilege('authenticated', 'public.reposicao_po_a_baixar_decisao', 'INSERT')
     OR has_table_privilege('authenticated', 'public.reposicao_po_a_baixar_episodio', 'INSERT')
     OR has_table_privilege('authenticated', 'public.reposicao_po_a_baixar_decisao', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.reposicao_po_a_baixar_episodio', 'UPDATE')
     OR has_table_privilege('anon', 'public.reposicao_po_a_baixar_decisao', 'SELECT')
     OR has_table_privilege('anon', 'public.reposicao_po_a_baixar_episodio', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: escrita direta (authenticated) ou leitura anon nas tabelas do sensor';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = 'reposicao-po-a-baixar-episodios' AND j.active
                   AND j.schedule = '17 * * * *' AND j.username = current_user) THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: cron reposicao-po-a-baixar-episodios ausente/inativo/com outro dono';
  END IF;
  RAISE NOTICE 'POSTCONDICAO OK: fila v2 + episodios + decisao (SECURITY DEFINER, search_path fixo, RLS, cron horario)';
END
$post$;

COMMIT;
