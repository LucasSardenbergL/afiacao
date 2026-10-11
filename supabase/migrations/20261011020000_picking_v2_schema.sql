-- ============================================================================================
-- 20261011020000 · picking v2 — schema + RPCs (Fase 0.3)
-- Prova: db/test-picking-v2.sh (PG17: RPCs executadas, 2 sessões, replay offline, falsificação)
-- Spec: docs/superpowers/specs/2026-10-10-picking-v2-design.md §3 e os contratos da §3.6
--
-- O QUE: a fila de separação nasce da etapa 10 do Omie (edge `picking-fila-omie` → RPC
-- `picking_sincronizar_fila`, só service_role). Cada pedido vira UMA tarefa com linhas por
-- `codigo_item` do Omie. A separação é por bipe: cada leitura é um evento IMUTÁVEL com UUID do
-- aparelho (idempotência offline); o separado de uma linha é a SOMA das leituras aceitas da
-- REVISÃO VIGENTE da linha — nunca uma coluna escrita. Fecha por LINHA (separada = pedida), e
-- só por `picking_concluir`, que exige que o servidor tenha recebido TODAS as leituras do aparelho.
-- Pedido que muda no Omie sobe a revisão das linhas alteradas: o progresso delas deixa de contar.
-- Toda volta de uma tarefa que já foi pega passa por reconciliação física (zerar no banco não
-- tira peça do volume, e leitura offline rejeitada não tira peça do volume).
--
-- O QUE NÃO É: não escreve no Omie (Fase 2), não tem cron (Fase 0.5), não cadastra código de
-- barras (Fase 1 — aqui a tabela só é LIDA). O corte de data da fila fica na EDGE e só decide a
-- ADMISSÃO: tarefa já acompanhada recebe detalhe sempre (a sync recusa o lote sem ele).
--
-- v1: picking_tasks/picking_task_items/picking_events (0 linhas em prod) ficam; as 3 RPCs de
-- ESCRITA v1 perdem o EXECUTE de authenticated (soma global e UPDATE absoluto — spec §1).
--
-- SEGURANÇA: RLS em todas as tabelas; authenticated só LÊ (policy staff); nem authenticated nem
-- service_role escrevem direto — tudo pelas RPCs SECURITY DEFINER (gate staff no corpo).
-- `picking_sincronizar_fila` é exclusiva do service_role (um `pedidos=[]` forjado
-- interromperia a conta inteira).
--
-- CONCORRÊNCIA: pg_advisory_xact_lock por tarefa em toda RPC que decide sobre ela; a sync pega
-- antes o lock da CONTA e depois as tarefas em ordem de pedido. As RPCs do aparelho pegam UM
-- lock só → sem ciclo. Estado lido DEPOIS do lock; relógio = clock_timestamp().
--
-- APLICAR: bun run db:aplicar supabase/migrations/<este arquivo> — o executor fornece a
-- transação. Idempotente. ORDEM DO DEPLOY: esta migration ANTES de qualquer edge que chame a
-- sync; nenhuma edge chama nesta entrega.
-- ============================================================================================

-- ─── Tabelas ─────────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.picking_coleta_estado (
  account                    text        PRIMARY KEY CHECK (account IN ('oben', 'colacor')),
  ultima_coleta_iniciada_em  timestamptz NOT NULL,
  aplicada_em                timestamptz NOT NULL,
  ultimo_resumo              jsonb
);

CREATE TABLE IF NOT EXISTS public.picking_tarefas (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account             text        NOT NULL CHECK (account IN ('oben', 'colacor')),
  omie_codigo_pedido  bigint      NOT NULL CHECK (omie_codigo_pedido > 0),
  numero_pedido       text,
  cliente_nome        text,
  status              text        NOT NULL CHECK (status IN (
                        'aguardando', 'em_separacao', 'separado', 'aguardando_ajuste',
                        'suspensa_alteracao', 'interrompida_externa', 'bloqueado_dado')),
  revisao             integer     NOT NULL DEFAULT 1 CHECK (revisao >= 1),
  estado_seq          integer     NOT NULL DEFAULT 1 CHECK (estado_seq >= 1),
  versao_omie         text,
  hash_fisico         text,
  motivo_bloqueio     text,
  operador_id         uuid,
  atribuicao_id       uuid,
  pega_em             timestamptz,
  separado_em         timestamptz,
  ausente_desde       timestamptz,
  fora_da_etapa_em    timestamptz,
  ultima_coleta_em    timestamptz NOT NULL,
  criado_em           timestamptz NOT NULL DEFAULT now(),
  atualizado_em       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT picking_tarefas_pedido_unico UNIQUE (account, omie_codigo_pedido),
  CONSTRAINT picking_tarefas_id_conta UNIQUE (id, account),
  CONSTRAINT picking_tarefas_em_separacao_tem_dono
    CHECK (status <> 'em_separacao' OR (atribuicao_id IS NOT NULL AND operador_id IS NOT NULL)),
  CONSTRAINT picking_tarefas_bloqueio_tem_motivo
    CHECK ((status = 'bloqueado_dado') = (motivo_bloqueio IS NOT NULL)),
  CONSTRAINT picking_tarefas_fora_da_etapa_so_separado
    CHECK (fora_da_etapa_em IS NULL OR status = 'separado')
);

CREATE TABLE IF NOT EXISTS public.picking_linhas (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account              text        NOT NULL CHECK (account IN ('oben', 'colacor')),
  tarefa_id            uuid        NOT NULL,
  codigo_item          bigint      NOT NULL CHECK (codigo_item > 0),
  omie_codigo_produto  bigint      NOT NULL CHECK (omie_codigo_produto > 0),
  codigo_produto       text,
  descricao            text,
  quantidade           numeric     NOT NULL CHECK (quantidade > 0 AND quantidade < 'Infinity'),
  unidade              text        NOT NULL,
  ean                  text,
  fracionaria          boolean     NOT NULL,
  revisao              integer     NOT NULL DEFAULT 1 CHECK (revisao >= 1),
  ativa                boolean     NOT NULL DEFAULT true,
  hash_linha           text        NOT NULL,
  criado_em            timestamptz NOT NULL DEFAULT now(),
  atualizado_em        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT picking_linhas_tarefa_fk FOREIGN KEY (tarefa_id, account)
    REFERENCES public.picking_tarefas (id, account),
  CONSTRAINT picking_linhas_item_unico UNIQUE (tarefa_id, codigo_item),
  CONSTRAINT picking_linhas_id_tarefa_conta UNIQUE (id, tarefa_id, account)
);

CREATE TABLE IF NOT EXISTS public.picking_leituras (
  id                  uuid        PRIMARY KEY,
  account             text        NOT NULL CHECK (account IN ('oben', 'colacor')),
  tarefa_id           uuid        NOT NULL,
  linha_id            uuid,
  linha_revisao       integer,
  tarefa_revisao      integer     NOT NULL,
  tipo                text        NOT NULL CHECK (tipo IN ('bipe', 'manual', 'estorno')),
  codigo_lido         text,
  unidades            numeric     CHECK (unidades IS NULL OR (unidades > '-Infinity' AND unidades < 'Infinity')),
  estorna_leitura_id  uuid        REFERENCES public.picking_leituras (id),
  operador_id         uuid        NOT NULL,
  atribuicao_id       uuid,
  comando             jsonb       NOT NULL,
  lido_em             timestamptz,
  recebido_em         timestamptz NOT NULL DEFAULT clock_timestamp(),
  aceita              boolean     NOT NULL,
  motivo_rejeicao     text,
  CONSTRAINT picking_leituras_tarefa_fk FOREIGN KEY (tarefa_id, account)
    REFERENCES public.picking_tarefas (id, account),
  CONSTRAINT picking_leituras_linha_fk FOREIGN KEY (linha_id, tarefa_id, account)
    REFERENCES public.picking_linhas (id, tarefa_id, account),
  CONSTRAINT picking_leituras_motivo_coerente CHECK (aceita = (motivo_rejeicao IS NULL)),
  CONSTRAINT picking_leituras_aceita_completa
    CHECK (NOT aceita OR (linha_id IS NOT NULL AND linha_revisao IS NOT NULL AND unidades IS NOT NULL AND unidades <> 0)),
  CONSTRAINT picking_leituras_sinal_coerente
    CHECK (NOT aceita OR ((tipo = 'estorno') = (unidades < 0))),
  CONSTRAINT picking_leituras_estorno_coerente
    CHECK (NOT aceita OR ((tipo = 'estorno') = (estorna_leitura_id IS NOT NULL)))
);

CREATE UNIQUE INDEX IF NOT EXISTS picking_leituras_estorno_unico
  ON public.picking_leituras (estorna_leitura_id) WHERE aceita AND estorna_leitura_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS picking_leituras_linha_revisao
  ON public.picking_leituras (linha_id, linha_revisao) WHERE aceita;
CREATE INDEX IF NOT EXISTS picking_leituras_tarefa
  ON public.picking_leituras (tarefa_id, atribuicao_id);

-- Código de barras → produto + quantas UNIDADES DA LINHA (na `unidade` declarada) uma leitura vale.
CREATE TABLE IF NOT EXISTS public.picking_codigos_barras (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account               text        NOT NULL CHECK (account IN ('oben', 'colacor')),
  codigo                text        NOT NULL CHECK (codigo = btrim(codigo) AND length(codigo) BETWEEN 1 AND 64),
  omie_codigo_produto   bigint      NOT NULL CHECK (omie_codigo_produto > 0),
  unidade               text        NOT NULL CHECK (unidade = upper(btrim(unidade)) AND unidade <> ''),
  unidades_por_leitura  numeric     NOT NULL CHECK (unidades_por_leitura > 0 AND unidades_por_leitura < 'Infinity'),
  origem                text        NOT NULL CHECK (origem IN ('omie', 'aprendido')),
  status                text        NOT NULL CHECK (status IN ('pendente', 'aprovado', 'revogado')),
  criado_por            uuid,
  aprovado_por          uuid,
  criado_em             timestamptz NOT NULL DEFAULT now(),
  aprovado_em           timestamptz,
  CONSTRAINT picking_codigos_barras_aprendido_aprovado_por_master
    CHECK (status <> 'aprovado' OR origem = 'omie' OR aprovado_por IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS picking_codigos_barras_vigente
  ON public.picking_codigos_barras (account, codigo) WHERE status <> 'revogado';

CREATE TABLE IF NOT EXISTS public.picking_eventos (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account      text        NOT NULL CHECK (account IN ('oben', 'colacor')),
  tarefa_id    uuid        NOT NULL,
  linha_id     uuid,
  tipo         text        NOT NULL,
  de_status    text,
  para_status  text,
  operador_id  uuid,
  detalhe      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  criado_em    timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT picking_eventos_tarefa_fk FOREIGN KEY (tarefa_id, account)
    REFERENCES public.picking_tarefas (id, account),
  CONSTRAINT picking_eventos_linha_fk FOREIGN KEY (linha_id, tarefa_id, account)
    REFERENCES public.picking_linhas (id, tarefa_id, account)
);

CREATE INDEX IF NOT EXISTS picking_eventos_tarefa ON public.picking_eventos (tarefa_id, criado_em);

COMMENT ON TABLE public.picking_tarefas IS
  'Picking v2: 1 tarefa por pedido da etapa 10 do Omie. Escrita só pelas RPCs picking_*. Ver migration 20261011020000.';
COMMENT ON TABLE public.picking_leituras IS
  'Picking v2: leituras IMUTÁVEIS (id = UUID do aparelho). Separado da linha = soma das aceitas da revisão vigente.';

-- Leituras são imutáveis: desfazer é estorno (leitura negativa vinculada), nunca UPDATE/DELETE.
CREATE OR REPLACE FUNCTION public.picking_leituras_imutavel()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  RAISE EXCEPTION 'picking_leituras é imutável (% bloqueado)', TG_OP USING ERRCODE = '55000';
END;
$function$;

DROP TRIGGER IF EXISTS picking_leituras_imutavel_linha ON public.picking_leituras;
CREATE TRIGGER picking_leituras_imutavel_linha
  BEFORE UPDATE OR DELETE ON public.picking_leituras
  FOR EACH ROW EXECUTE FUNCTION public.picking_leituras_imutavel();
DROP TRIGGER IF EXISTS picking_leituras_imutavel_truncate ON public.picking_leituras;
CREATE TRIGGER picking_leituras_imutavel_truncate
  BEFORE TRUNCATE ON public.picking_leituras
  FOR EACH STATEMENT EXECUTE FUNCTION public.picking_leituras_imutavel();

-- ─── Privilégios e RLS: cliente e edges só LEEM; escrita só pelas RPCs ──────────────────────

ALTER TABLE public.picking_coleta_estado  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.picking_tarefas        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.picking_linhas         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.picking_leituras       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.picking_codigos_barras ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.picking_eventos        ENABLE ROW LEVEL SECURITY;

-- service_role tem BYPASSRLS: sem este REVOKE uma edge escreveria direto, por fora das RPCs.
REVOKE ALL ON TABLE public.picking_coleta_estado, public.picking_tarefas, public.picking_linhas,
                    public.picking_leituras, public.picking_codigos_barras, public.picking_eventos
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.picking_tarefas, public.picking_linhas, public.picking_leituras,
                      public.picking_codigos_barras, public.picking_eventos
  TO authenticated;
GRANT SELECT ON TABLE public.picking_coleta_estado, public.picking_tarefas, public.picking_linhas,
                      public.picking_leituras, public.picking_codigos_barras, public.picking_eventos
  TO service_role;

DROP POLICY IF EXISTS picking_tarefas_staff_select ON public.picking_tarefas;
CREATE POLICY picking_tarefas_staff_select ON public.picking_tarefas FOR SELECT TO authenticated
  USING ((SELECT public.has_role((SELECT auth.uid()), 'employee'::public.app_role))
      OR (SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role)));
DROP POLICY IF EXISTS picking_linhas_staff_select ON public.picking_linhas;
CREATE POLICY picking_linhas_staff_select ON public.picking_linhas FOR SELECT TO authenticated
  USING ((SELECT public.has_role((SELECT auth.uid()), 'employee'::public.app_role))
      OR (SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role)));
DROP POLICY IF EXISTS picking_leituras_staff_select ON public.picking_leituras;
CREATE POLICY picking_leituras_staff_select ON public.picking_leituras FOR SELECT TO authenticated
  USING ((SELECT public.has_role((SELECT auth.uid()), 'employee'::public.app_role))
      OR (SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role)));
DROP POLICY IF EXISTS picking_codigos_barras_staff_select ON public.picking_codigos_barras;
CREATE POLICY picking_codigos_barras_staff_select ON public.picking_codigos_barras FOR SELECT TO authenticated
  USING ((SELECT public.has_role((SELECT auth.uid()), 'employee'::public.app_role))
      OR (SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role)));
DROP POLICY IF EXISTS picking_eventos_staff_select ON public.picking_eventos;
CREATE POLICY picking_eventos_staff_select ON public.picking_eventos FOR SELECT TO authenticated
  USING ((SELECT public.has_role((SELECT auth.uid()), 'employee'::public.app_role))
      OR (SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role)));

-- Progresso por linha: o separado é DERIVADO (soma das aceitas da revisão vigente).
CREATE OR REPLACE VIEW public.picking_linhas_progresso WITH (security_invoker = on) AS
SELECT l.id, l.account, l.tarefa_id, l.codigo_item, l.omie_codigo_produto, l.codigo_produto,
       l.descricao, l.quantidade, l.unidade, l.ean, l.fracionaria, l.revisao, l.ativa,
       coalesce(s.separada, 0) AS separada,
       l.quantidade - coalesce(s.separada, 0) AS saldo
  FROM public.picking_linhas l
  LEFT JOIN LATERAL (
    SELECT sum(r.unidades) AS separada
      FROM public.picking_leituras r
     WHERE r.linha_id = l.id AND r.aceita AND r.linha_revisao = l.revisao
  ) s ON true;

REVOKE ALL ON TABLE public.picking_linhas_progresso FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.picking_linhas_progresso TO authenticated, service_role;

-- ─── Funções internas (fechadas para o cliente) ──────────────────────────────────────────────

-- Separado de uma linha na revisão dada (soma das leituras aceitas).
CREATE OR REPLACE FUNCTION public.picking_v2_separada(p_linha_id uuid, p_revisao integer)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT coalesce(sum(r.unidades), 0)
    FROM public.picking_leituras r
   WHERE r.linha_id = p_linha_id AND r.aceita AND r.linha_revisao = p_revisao;
$function$;

-- Motivo pelo qual o pedido normalizado NÃO pode virar linhas (NULL = legível).
-- Contrato de linha (spec §1.1, §3.6.7): codigo_item presente e único, produto, quantidade > 0,
-- unidade, ≥ 1 item. Nunca pula linha em silêncio: um item ruim bloqueia o pedido inteiro.
CREATE OR REPLACE FUNCTION public.picking_v2_motivo_invalido(p_pedido jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
BEGIN
  IF jsonb_typeof(p_pedido -> 'itens') IS DISTINCT FROM 'array' OR jsonb_array_length(p_pedido -> 'itens') = 0 THEN
    RETURN 'pedido sem itens';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_pedido -> 'itens') i
              WHERE jsonb_typeof(i) IS DISTINCT FROM 'object'
                 OR coalesce(i ->> 'codigo_item', '') !~ '^[1-9][0-9]{0,17}$') THEN
    RETURN 'item sem codigo_item válido';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_pedido -> 'itens') i
              GROUP BY (i ->> 'codigo_item')::bigint HAVING count(*) > 1) THEN
    RETURN 'codigo_item duplicado';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_pedido -> 'itens') i
              WHERE coalesce(i ->> 'codigo_produto', '') !~ '^[1-9][0-9]{0,17}$') THEN
    RETURN 'item sem codigo_produto válido';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_pedido -> 'itens') i
              WHERE coalesce(i ->> 'quantidade', '') !~ '^[0-9]{1,12}(\.[0-9]{1,6})?$'
                 OR (i ->> 'quantidade')::numeric <= 0) THEN
    RETURN 'item com quantidade inválida';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_pedido -> 'itens') i
              WHERE coalesce(btrim(i ->> 'unidade'), '') = '') THEN
    RETURN 'item sem unidade';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_pedido -> 'itens') i
              WHERE length(btrim(i ->> 'ean')) > 64) THEN
    RETURN 'item com ean longo demais';
  END IF;
  RETURN NULL;
END;
$function$;

-- Itens normalizados de um pedido JÁ validado, com o hash de cada linha: o FÍSICO (codigo_item,
-- codigo_produto, quantidade, unidade) e o EAN — este porque decide o que o bipe aceita; corrigir
-- o EAN muda a interpretação das leituras já aceitas e exige reconciliação. Preço/imposto, não.
CREATE OR REPLACE FUNCTION public.picking_v2_itens(p_pedido jsonb)
 RETURNS TABLE (codigo_item bigint, omie_codigo_produto bigint, codigo_produto text, descricao text,
                quantidade numeric, unidade text, ean text, fracionaria boolean, hash_linha text)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT x.ci, x.cp, nullif(btrim(i ->> 'codigo'), ''), nullif(btrim(i ->> 'descricao'), ''),
         x.q, x.un, x.ean,
         (x.un IN ('M2', 'M²', 'M', 'MT', 'L', 'LT', 'KG') OR x.q <> trunc(x.q)),
         md5(concat_ws('|', x.ci::text, x.cp::text, trim_scale(x.q)::text, x.un, coalesce(x.ean, '')))
    FROM jsonb_array_elements(p_pedido -> 'itens') i
    CROSS JOIN LATERAL (SELECT (i ->> 'codigo_item')::bigint AS ci,
                               (i ->> 'codigo_produto')::bigint AS cp,
                               (i ->> 'quantidade')::numeric AS q,
                               upper(btrim(i ->> 'unidade')) AS un,
                               nullif(btrim(i ->> 'ean'), '') AS ean) x;
$function$;

-- ─── RPC 1: picking_sincronizar_fila (só service_role) ───────────────────────────────────────
-- p_presentes = TODOS os códigos da listagem da etapa 10 (para ausência);
-- p_pedidos   = os que passaram do corte de data da edge E toda tarefa já acompanhada presente
--   na listagem (o corte decide só a admissão), normalizados:
--   {codigo_pedido, numero_pedido, cliente_nome, d_alt, h_alt,
--    itens:[{codigo_item, codigo_produto, codigo, descricao, quantidade, unidade, ean}]}
-- p_confirmados_fora = ausentes que a edge confirmou (ConsultarPedido) fora da etapa 10 NESTA
--   rodada, depois da listagem — protocolo: listar → consultar os ausentes (com teto) → UMA
--   chamada. Ausente sem confirmação volta em `ausentes_a_confirmar` (próxima rodada).
CREATE OR REPLACE FUNCTION public.picking_sincronizar_fila(
  p_account text,
  p_coleta_iniciada_em timestamptz,
  p_presentes bigint[],
  p_total_de_registros integer,
  p_pedidos jsonb,
  p_confirmados_fora bigint[] DEFAULT '{}'::bigint[]
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_agora        timestamptz;
  v_ultima       timestamptz;
  v_completa     boolean;
  v_ped          jsonb;
  v_cod          bigint;
  v_motivo       text;
  v_versao       text;
  v_hash         text;
  v_t            public.picking_tarefas%ROWTYPE;
  v_mudou        boolean;
  v_novo_status  text;
  v_ausentes     bigint[] := '{}'::bigint[];
  v_fora         bigint[] := coalesce(p_confirmados_fora, '{}'::bigint[]);
  v_criadas      integer := 0;
  v_revisadas    integer := 0;
  v_bloqueadas   integer := 0;
  v_interromp    integer := 0;
  v_saidas       integer := 0;
  v_resumo       jsonb;
BEGIN
  IF p_account IS NULL OR p_account NOT IN ('oben', 'colacor') THEN
    RAISE EXCEPTION 'picking_sincronizar_fila: conta inválida (%)', p_account USING ERRCODE = '22023';
  END IF;
  IF p_coleta_iniciada_em IS NULL OR p_presentes IS NULL OR p_total_de_registros IS NULL
     OR p_total_de_registros < 0 OR jsonb_typeof(p_pedidos) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'picking_sincronizar_fila: parâmetros ausentes ou malformados' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_presentes) x WHERE x IS NULL OR x <= 0)
     OR EXISTS (SELECT 1 FROM unnest(v_fora) x WHERE x IS NULL OR x <= 0) THEN
    RAISE EXCEPTION 'picking_sincronizar_fila: código de pedido nulo ou não positivo' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_pedidos) e
              WHERE jsonb_typeof(e) IS DISTINCT FROM 'object'
                 OR coalesce(e ->> 'codigo_pedido', '') !~ '^[1-9][0-9]{0,17}$') THEN
    RAISE EXCEPTION 'picking_sincronizar_fila: pedido sem codigo_pedido válido' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_pedidos) e
              GROUP BY (e ->> 'codigo_pedido')::bigint HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'picking_sincronizar_fila: pedido duplicado no lote' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_pedidos) e
              WHERE NOT ((e ->> 'codigo_pedido')::bigint = ANY (p_presentes))) THEN
    RAISE EXCEPTION 'picking_sincronizar_fila: pedido detalhado fora de p_presentes' USING ERRCODE = '22023';
  END IF;

  -- Uma coleta por conta de cada vez; geração monotônica (contrato 3).
  PERFORM pg_advisory_xact_lock(hashtextextended('picking_v2_conta:' || p_account, 0));
  v_agora := clock_timestamp();
  IF p_coleta_iniciada_em > v_agora + interval '5 minutes' THEN
    RAISE EXCEPTION 'picking_sincronizar_fila: coleta no futuro (%)', p_coleta_iniciada_em USING ERRCODE = '22023';
  END IF;
  SELECT e.ultima_coleta_iniciada_em INTO v_ultima
    FROM public.picking_coleta_estado e WHERE e.account = p_account FOR UPDATE;
  IF v_ultima IS NOT NULL AND p_coleta_iniciada_em <= v_ultima THEN
    RETURN jsonb_build_object('aplicada', false, 'motivo', 'coleta_velha', 'ultima_coleta_iniciada_em', v_ultima);
  END IF;

  -- O corte de data decide só a ADMISSÃO: tarefa acompanhada e presente tem de vir detalhada,
  -- senão uma alteração no Omie nunca chegaria a ela.
  IF EXISTS (SELECT 1 FROM public.picking_tarefas t
              WHERE t.account = p_account AND t.omie_codigo_pedido = ANY (p_presentes)
                AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_pedidos) e
                                 WHERE (e ->> 'codigo_pedido')::bigint = t.omie_codigo_pedido)) THEN
    RAISE EXCEPTION 'picking_sincronizar_fila: tarefa acompanhada presente na listagem sem detalhe' USING ERRCODE = '22023';
  END IF;

  -- Listagem só é fotografia se bate com o total do Omie e não tem duplicata (contrato 2).
  v_completa := cardinality(p_presentes) = p_total_de_registros
                AND (SELECT count(DISTINCT x) FROM unnest(p_presentes) x) = cardinality(p_presentes);

  FOR v_ped IN SELECT e FROM jsonb_array_elements(p_pedidos) e ORDER BY (e ->> 'codigo_pedido')::bigint LOOP
    v_cod    := (v_ped ->> 'codigo_pedido')::bigint;
    v_motivo := public.picking_v2_motivo_invalido(v_ped);
    v_versao := nullif(btrim(concat_ws(' ', v_ped ->> 'd_alt', v_ped ->> 'h_alt')), '');
    v_hash   := NULL;
    IF v_motivo IS NULL THEN
      SELECT md5(string_agg(i.hash_linha, ',' ORDER BY i.codigo_item)) INTO v_hash
        FROM public.picking_v2_itens(v_ped) i;
    END IF;

    SELECT * INTO v_t FROM public.picking_tarefas t
     WHERE t.account = p_account AND t.omie_codigo_pedido = v_cod;

    IF NOT FOUND THEN
      INSERT INTO public.picking_tarefas AS t
             (account, omie_codigo_pedido, numero_pedido, cliente_nome, status, versao_omie,
              hash_fisico, motivo_bloqueio, ultima_coleta_em)
      VALUES (p_account, v_cod, v_ped ->> 'numero_pedido', v_ped ->> 'cliente_nome',
              CASE WHEN v_motivo IS NULL THEN 'aguardando' ELSE 'bloqueado_dado' END,
              v_versao, v_hash, v_motivo, v_agora)
      RETURNING * INTO v_t;
      IF v_motivo IS NULL THEN
        INSERT INTO public.picking_linhas
               (account, tarefa_id, codigo_item, omie_codigo_produto, codigo_produto, descricao,
                quantidade, unidade, ean, fracionaria, hash_linha)
        SELECT p_account, v_t.id, i.codigo_item, i.omie_codigo_produto, i.codigo_produto, i.descricao,
               i.quantidade, i.unidade, i.ean, i.fracionaria, i.hash_linha
          FROM public.picking_v2_itens(v_ped) i;
      ELSE
        v_bloqueadas := v_bloqueadas + 1;
      END IF;
      INSERT INTO public.picking_eventos (account, tarefa_id, tipo, para_status, detalhe)
      VALUES (p_account, v_t.id, 'criada', v_t.status, jsonb_build_object('motivo', v_motivo));
      v_criadas := v_criadas + 1;
      CONTINUE;
    END IF;

    -- Estado relido DEPOIS do lock da tarefa.
    PERFORM pg_advisory_xact_lock(hashtextextended('picking_v2_tarefa:' || v_t.id::text, 0));
    SELECT * INTO v_t FROM public.picking_tarefas t WHERE t.id = v_t.id FOR UPDATE;

    UPDATE public.picking_tarefas t
       SET ausente_desde = NULL, fora_da_etapa_em = NULL, ultima_coleta_em = v_agora,
           numero_pedido = coalesce(v_ped ->> 'numero_pedido', t.numero_pedido),
           cliente_nome  = coalesce(v_ped ->> 'cliente_nome', t.cliente_nome)
     WHERE t.id = v_t.id;

    -- Dado ilegível: a tarefa inteira para (nunca pula linha); leituras em voo param de valer.
    IF v_motivo IS NOT NULL THEN
      IF v_t.status <> 'bloqueado_dado' OR v_t.motivo_bloqueio IS DISTINCT FROM v_motivo THEN
        UPDATE public.picking_tarefas t
           SET status = 'bloqueado_dado', motivo_bloqueio = v_motivo, versao_omie = v_versao,
               separado_em = NULL,
               revisao = t.revisao + CASE WHEN v_t.status <> 'bloqueado_dado' THEN 1 ELSE 0 END,
               estado_seq = t.estado_seq + 1, atualizado_em = v_agora
         WHERE t.id = v_t.id;
        INSERT INTO public.picking_eventos (account, tarefa_id, tipo, de_status, para_status, detalhe)
        VALUES (p_account, v_t.id, 'bloqueada_dado', v_t.status, 'bloqueado_dado',
                jsonb_build_object('motivo', v_motivo));
        v_bloqueadas := v_bloqueadas + 1;
      END IF;
      CONTINUE;
    END IF;

    -- Descrição e código acompanham o Omie sem subir revisão (não decidem o bipe).
    UPDATE public.picking_linhas l
       SET codigo_produto = n.codigo_produto, descricao = n.descricao
      FROM public.picking_v2_itens(v_ped) n
     WHERE l.tarefa_id = v_t.id AND n.codigo_item = l.codigo_item
       AND (l.codigo_produto IS DISTINCT FROM n.codigo_produto OR l.descricao IS DISTINCT FROM n.descricao);

    -- Mudou só preço/imposto (hash igual) numa tarefa saudável: nada a recontar.
    IF v_hash = v_t.hash_fisico AND v_t.status NOT IN ('bloqueado_dado', 'interrompida_externa') THEN
      UPDATE public.picking_tarefas t SET versao_omie = v_versao WHERE t.id = v_t.id
         AND t.versao_omie IS DISTINCT FROM v_versao;
      CONTINUE;
    END IF;

    v_mudou := v_hash IS DISTINCT FROM v_t.hash_fisico;
    IF v_mudou THEN
      UPDATE public.picking_linhas l
         SET ativa = false, revisao = l.revisao + 1, atualizado_em = v_agora
       WHERE l.tarefa_id = v_t.id AND l.ativa
         AND NOT EXISTS (SELECT 1 FROM public.picking_v2_itens(v_ped) n WHERE n.codigo_item = l.codigo_item);

      UPDATE public.picking_linhas l
         SET omie_codigo_produto = n.omie_codigo_produto, quantidade = n.quantidade,
             unidade = n.unidade, ean = n.ean, fracionaria = n.fracionaria, hash_linha = n.hash_linha,
             ativa = true, revisao = l.revisao + 1, atualizado_em = v_agora
        FROM public.picking_v2_itens(v_ped) n
       WHERE l.tarefa_id = v_t.id AND n.codigo_item = l.codigo_item
         AND (NOT l.ativa OR l.hash_linha <> n.hash_linha);

      INSERT INTO public.picking_linhas
             (account, tarefa_id, codigo_item, omie_codigo_produto, codigo_produto, descricao,
              quantidade, unidade, ean, fracionaria, hash_linha)
      SELECT p_account, v_t.id, n.codigo_item, n.omie_codigo_produto, n.codigo_produto, n.descricao,
             n.quantidade, n.unidade, n.ean, n.fracionaria, n.hash_linha
        FROM public.picking_v2_itens(v_ped) n
       WHERE NOT EXISTS (SELECT 1 FROM public.picking_linhas l
                          WHERE l.tarefa_id = v_t.id AND l.codigo_item = n.codigo_item);
    END IF;

    -- Tarefa que JÁ FOI PEGA nunca volta direto à fila: o volume pode ter peças que o banco não
    -- conta (revisão perdida, leitura offline rejeitada) → reconciliação física em picking_retomar.
    v_novo_status := CASE WHEN v_t.pega_em IS NOT NULL THEN 'suspensa_alteracao' ELSE 'aguardando' END;

    UPDATE public.picking_tarefas t
       SET status = v_novo_status, hash_fisico = v_hash, versao_omie = v_versao,
           motivo_bloqueio = NULL, separado_em = NULL,
           revisao = t.revisao + CASE WHEN v_mudou THEN 1 ELSE 0 END,
           estado_seq = t.estado_seq + 1, atualizado_em = v_agora
     WHERE t.id = v_t.id;
    INSERT INTO public.picking_eventos (account, tarefa_id, tipo, de_status, para_status, detalhe)
    VALUES (p_account, v_t.id, CASE WHEN v_mudou THEN 'linha_revisada' ELSE 'recuperada' END,
            v_t.status, v_novo_status, jsonb_build_object('versao_omie', v_versao));
    v_revisadas := v_revisadas + 1;
  END LOOP;

  -- Presente na listagem: limpa as marcas de ausência (inclusive de quem não tem tarefa a revisar).
  UPDATE public.picking_tarefas t
     SET ausente_desde = NULL, fora_da_etapa_em = NULL
   WHERE t.account = p_account AND t.omie_codigo_pedido = ANY (p_presentes)
     AND (t.ausente_desde IS NOT NULL OR t.fora_da_etapa_em IS NOT NULL);

  -- Ausência: só com listagem completa (fail-closed) e só vira estado com confirmação individual.
  IF v_completa THEN
    FOR v_t IN SELECT * FROM public.picking_tarefas t
                WHERE t.account = p_account AND t.status <> 'interrompida_externa'
                  AND t.fora_da_etapa_em IS NULL AND NOT (t.omie_codigo_pedido = ANY (p_presentes))
                ORDER BY t.omie_codigo_pedido LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended('picking_v2_tarefa:' || v_t.id::text, 0));
      SELECT * INTO v_t FROM public.picking_tarefas t WHERE t.id = v_t.id FOR UPDATE;
      IF v_t.omie_codigo_pedido = ANY (v_fora) THEN
        IF v_t.status = 'separado' THEN
          -- Fim normal: alguém moveu o pedido separado para a etapa seguinte.
          UPDATE public.picking_tarefas t
             SET fora_da_etapa_em = v_agora, ausente_desde = NULL, estado_seq = t.estado_seq + 1
           WHERE t.id = v_t.id;
          INSERT INTO public.picking_eventos (account, tarefa_id, tipo, de_status, para_status)
          VALUES (p_account, v_t.id, 'saiu_da_etapa', 'separado', 'separado');
          v_saidas := v_saidas + 1;
        ELSE
          UPDATE public.picking_tarefas t
             SET status = 'interrompida_externa', motivo_bloqueio = NULL, ausente_desde = NULL,
                 revisao = t.revisao + 1, estado_seq = t.estado_seq + 1, atualizado_em = v_agora
           WHERE t.id = v_t.id;
          INSERT INTO public.picking_eventos (account, tarefa_id, tipo, de_status, para_status)
          VALUES (p_account, v_t.id, 'interrompida_externa', v_t.status, 'interrompida_externa');
          v_interromp := v_interromp + 1;
        END IF;
      ELSE
        UPDATE public.picking_tarefas t SET ausente_desde = coalesce(t.ausente_desde, v_agora) WHERE t.id = v_t.id;
        v_ausentes := v_ausentes || v_t.omie_codigo_pedido;
      END IF;
    END LOOP;
  END IF;

  v_resumo := jsonb_build_object(
    'aplicada', true, 'listagem_completa', v_completa, 'criadas', v_criadas,
    'revisadas', v_revisadas, 'bloqueadas', v_bloqueadas, 'interrompidas', v_interromp,
    'saidas_da_etapa', v_saidas, 'ausentes_a_confirmar', to_jsonb(v_ausentes));

  INSERT INTO public.picking_coleta_estado AS e (account, ultima_coleta_iniciada_em, aplicada_em, ultimo_resumo)
  VALUES (p_account, p_coleta_iniciada_em, v_agora, v_resumo)
  ON CONFLICT (account) DO UPDATE
     SET ultima_coleta_iniciada_em = EXCLUDED.ultima_coleta_iniciada_em,
         aplicada_em = EXCLUDED.aplicada_em, ultimo_resumo = EXCLUDED.ultimo_resumo;

  RETURN v_resumo;
END;
$function$;

-- ─── RPC 2: picking_pegar_task (staff) ───────────────────────────────────────────────────────
-- p_estado_seq = o seq que o aparelho viu (comando atrasado não age sobre outro ciclo).
-- Assumir a tarefa de outro operador exige reconciliação física: as leituras offline dele
-- passam a ser rejeitadas, mas as peças delas continuam no volume.
CREATE OR REPLACE FUNCTION public.picking_pegar_task(
  p_evento_id uuid,
  p_account text,
  p_tarefa_id uuid,
  p_estado_seq integer,
  p_assumir boolean DEFAULT false,
  p_reconciliacao_fisica boolean DEFAULT false
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_cmd  jsonb;
  v_ev   public.picking_eventos%ROWTYPE;
  v_t    public.picking_tarefas%ROWTYPE;
  v_atr  uuid;
  v_res  jsonb;
  v_para text;
  v_inseriu integer;
BEGIN
  IF NOT (public.has_role(v_uid, 'employee'::public.app_role) OR public.has_role(v_uid, 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'picking_pegar_task: só staff' USING ERRCODE = '42501';
  END IF;
  IF p_evento_id IS NULL OR p_tarefa_id IS NULL OR p_account IS NULL OR p_estado_seq IS NULL THEN
    RAISE EXCEPTION 'picking_pegar_task: parâmetros ausentes' USING ERRCODE = '22023';
  END IF;
  v_cmd := jsonb_build_object('op', 'pegar', 'account', p_account, 'tarefa', p_tarefa_id,
                              'estado_seq', p_estado_seq, 'assumir', p_assumir IS TRUE,
                              'reconciliacao', p_reconciliacao_fisica IS TRUE);

  PERFORM pg_advisory_xact_lock(hashtextextended('picking_v2_tarefa:' || p_tarefa_id::text, 0));
  SELECT * INTO v_t FROM public.picking_tarefas t WHERE t.id = p_tarefa_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'picking_pegar_task: tarefa inexistente' USING ERRCODE = 'P0002';
  END IF;
  IF v_t.account <> p_account THEN
    RAISE EXCEPTION 'picking_pegar_task: tarefa de outra conta' USING ERRCODE = '22023';
  END IF;

  -- UUID já processado: devolve o resultado gravado ANTES de olhar o estado (contrato 5).
  SELECT * INTO v_ev FROM public.picking_eventos e WHERE e.id = p_evento_id;
  IF FOUND THEN
    IF v_ev.operador_id IS DISTINCT FROM v_uid OR v_ev.detalhe -> 'comando' IS DISTINCT FROM v_cmd THEN
      RAISE EXCEPTION 'picking_pegar_task: evento % reutilizado em outro comando', p_evento_id USING ERRCODE = '22023';
    END IF;
    RETURN (v_ev.detalhe -> 'resultado') || jsonb_build_object('replay', true);
  END IF;

  IF v_t.estado_seq <> p_estado_seq THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'estado_mudou');
  ELSIF v_t.status = 'aguardando' THEN
    v_atr := gen_random_uuid();
  ELSIF v_t.status = 'em_separacao' AND v_t.operador_id = v_uid THEN
    v_res := jsonb_build_object('ok', true, 'atribuicao_id', v_t.atribuicao_id, 'tarefa_revisao', v_t.revisao,
                                'estado_seq', v_t.estado_seq);
  ELSIF v_t.status = 'em_separacao' AND p_assumir IS NOT TRUE THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'em_separacao_por_outro');
  ELSIF v_t.status = 'em_separacao' AND p_reconciliacao_fisica IS NOT TRUE THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'exige_reconciliacao_fisica');
  ELSIF v_t.status = 'em_separacao' THEN
    v_atr := gen_random_uuid();
  ELSE
    v_res := jsonb_build_object('ok', false, 'motivo', 'status_' || v_t.status);
  END IF;

  IF v_atr IS NOT NULL THEN
    UPDATE public.picking_tarefas t
       SET status = 'em_separacao', operador_id = v_uid, atribuicao_id = v_atr,
           pega_em = clock_timestamp(), estado_seq = t.estado_seq + 1, atualizado_em = clock_timestamp()
     WHERE t.id = v_t.id;
    v_para := 'em_separacao';
    v_res := jsonb_build_object('ok', true, 'atribuicao_id', v_atr, 'tarefa_revisao', v_t.revisao,
                                'estado_seq', v_t.estado_seq + 1);
  END IF;

  INSERT INTO public.picking_eventos (id, account, tarefa_id, tipo, de_status, para_status, operador_id, detalhe)
  VALUES (p_evento_id, v_t.account, v_t.id, 'pegar', v_t.status, v_para, v_uid,
          jsonb_build_object('comando', v_cmd, 'resultado', v_res))
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_inseriu = ROW_COUNT;
  IF v_inseriu = 0 THEN
    RAISE EXCEPTION 'evento % gravado por outra transação', p_evento_id USING ERRCODE = '22023';
  END IF;
  RETURN v_res || jsonb_build_object('replay', false);
END;
$function$;

-- ─── RPC 3: picking_registrar_leitura (staff) ────────────────────────────────────────────────
-- O aparelho manda o código LIDO; o servidor resolve produto/fator/unidade (contrato 6) e aloca
-- na 1ª linha incompleta por codigo_item (contrato 7). Rejeição definitiva também é gravada — o
-- mesmo UUID devolve sempre o mesmo veredito. Estorno cujo original ainda não chegou NÃO é
-- gravado (`pendente`): o aparelho reenvia depois. NÃO conclui a tarefa: isso é picking_concluir.
CREATE OR REPLACE FUNCTION public.picking_registrar_leitura(
  p_leitura_id uuid,
  p_account text,
  p_tarefa_id uuid,
  p_atribuicao_id uuid,
  p_tarefa_revisao integer,
  p_tipo text,
  p_codigo_lido text DEFAULT NULL,
  p_linha_id uuid DEFAULT NULL,
  p_quantidade numeric DEFAULT NULL,
  p_estorna_leitura_id uuid DEFAULT NULL,
  p_lido_em timestamptz DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_codigo    text := nullif(btrim(p_codigo_lido), '');
  v_cmd       jsonb;
  v_ex        public.picking_leituras%ROWTYPE;
  v_t         public.picking_tarefas%ROWTYPE;
  v_l         public.picking_linhas%ROWTYPE;
  v_orig      public.picking_leituras%ROWTYPE;
  v_motivo    text;
  v_linha     uuid;
  v_linrev    integer;
  v_unid      numeric;
  v_prod      bigint;
  v_fator     numeric;
  v_cb_status text;
  v_cb_unid   text;
  v_tem_cb    boolean;
  v_nprod     integer;
  v_inseriu   integer;
BEGIN
  IF NOT (public.has_role(v_uid, 'employee'::public.app_role) OR public.has_role(v_uid, 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'picking_registrar_leitura: só staff' USING ERRCODE = '42501';
  END IF;
  IF p_leitura_id IS NULL OR p_tarefa_id IS NULL OR p_account IS NULL OR p_tarefa_revisao IS NULL
     OR p_atribuicao_id IS NULL OR p_tipo IS NULL OR p_tipo NOT IN ('bipe', 'manual', 'estorno') THEN
    RAISE EXCEPTION 'picking_registrar_leitura: parâmetros ausentes ou tipo inválido' USING ERRCODE = '22023';
  END IF;
  -- Domínio positivo e FINITO (NaN > Infinity no Postgres, então `< 'Infinity'` também barra NaN).
  IF (p_tipo = 'bipe' AND (v_codigo IS NULL OR length(v_codigo) > 64 OR p_linha_id IS NOT NULL
                           OR p_quantidade IS NOT NULL OR p_estorna_leitura_id IS NOT NULL))
     OR (p_tipo = 'manual' AND (p_linha_id IS NULL OR p_quantidade IS NULL
                                OR NOT (p_quantidade > 0 AND p_quantidade < 'Infinity')
                                OR v_codigo IS NOT NULL OR p_estorna_leitura_id IS NOT NULL))
     OR (p_tipo = 'estorno' AND (p_estorna_leitura_id IS NULL OR p_quantidade IS NOT NULL
                                 OR v_codigo IS NOT NULL OR p_linha_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'picking_registrar_leitura: parâmetros incompatíveis com o tipo %', p_tipo USING ERRCODE = '22023';
  END IF;
  v_cmd := jsonb_build_object('account', p_account, 'tarefa', p_tarefa_id, 'atribuicao', p_atribuicao_id,
                              'tarefa_revisao', p_tarefa_revisao, 'tipo', p_tipo, 'codigo', v_codigo,
                              'linha', p_linha_id, 'quantidade', p_quantidade, 'estorno', p_estorna_leitura_id);

  PERFORM pg_advisory_xact_lock(hashtextextended('picking_v2_tarefa:' || p_tarefa_id::text, 0));
  SELECT * INTO v_t FROM public.picking_tarefas t WHERE t.id = p_tarefa_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'picking_registrar_leitura: tarefa inexistente' USING ERRCODE = 'P0002';
  END IF;
  IF v_t.account <> p_account THEN
    RAISE EXCEPTION 'picking_registrar_leitura: tarefa de outra conta' USING ERRCODE = '22023';
  END IF;

  -- UUID já processado: resolvido ANTES do estado atual (contrato 5), e só para o MESMO comando.
  SELECT * INTO v_ex FROM public.picking_leituras r WHERE r.id = p_leitura_id;
  IF FOUND THEN
    IF v_ex.operador_id <> v_uid OR v_ex.comando IS DISTINCT FROM v_cmd THEN
      RAISE EXCEPTION 'picking_registrar_leitura: leitura % reutilizada em outro comando', p_leitura_id USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('ok', v_ex.aceita, 'motivo', v_ex.motivo_rejeicao, 'linha_id', v_ex.linha_id,
                              'unidades', v_ex.unidades, 'replay', true);
  END IF;

  IF v_t.status <> 'em_separacao' THEN
    v_motivo := 'tarefa_fora_de_separacao';
  ELSIF v_t.atribuicao_id IS DISTINCT FROM p_atribuicao_id OR v_t.operador_id IS DISTINCT FROM v_uid THEN
    v_motivo := 'atribuicao_antiga';
  ELSIF v_t.revisao <> p_tarefa_revisao THEN
    v_motivo := 'revisao_antiga';
  END IF;

  IF v_motivo IS NULL AND p_tipo = 'bipe' THEN
    SELECT c.omie_codigo_produto, c.unidades_por_leitura, c.status, c.unidade
      INTO v_prod, v_fator, v_cb_status, v_cb_unid
      FROM public.picking_codigos_barras c
     WHERE c.account = v_t.account AND c.codigo = v_codigo AND c.status <> 'revogado';
    v_tem_cb := FOUND;
    -- Interpretações distintas do EAN = pares (produto, unidade): o mesmo EAN numa linha UN e
    -- noutra CX do mesmo produto faria 1 peça avulsa valer 1 caixa.
    SELECT count(DISTINCT (l.omie_codigo_produto, l.unidade)) INTO v_nprod
      FROM public.picking_linhas l
     WHERE l.tarefa_id = v_t.id AND l.ativa AND l.ean = v_codigo;

    IF v_tem_cb AND v_cb_status <> 'aprovado' THEN
      v_motivo := 'codigo_pendente_aprovacao';
    ELSIF v_tem_cb AND EXISTS (SELECT 1 FROM public.picking_linhas l
                                WHERE l.tarefa_id = v_t.id AND l.ativa AND l.ean = v_codigo
                                  AND (l.omie_codigo_produto <> v_prod OR l.unidade <> v_cb_unid
                                       OR v_fator <> 1)) THEN
      -- O mesmo código lido como EAN da linha (1 unidade) e como cadastro (outro produto,
      -- unidade ou fator): duas interpretações físicas — não se escolhe uma no escuro.
      v_motivo := 'codigo_ambiguo';
    ELSIF NOT v_tem_cb AND v_nprod = 0 THEN
      v_motivo := 'codigo_desconhecido';
    ELSIF NOT v_tem_cb AND v_nprod > 1 THEN
      v_motivo := 'codigo_ambiguo';
    ELSIF v_tem_cb AND NOT EXISTS (SELECT 1 FROM public.picking_linhas l
                                    WHERE l.tarefa_id = v_t.id AND l.ativa AND l.omie_codigo_produto = v_prod) THEN
      v_motivo := 'codigo_fora_do_pedido';
    ELSIF v_tem_cb AND NOT EXISTS (SELECT 1 FROM public.picking_linhas l
                                    WHERE l.tarefa_id = v_t.id AND l.ativa AND l.omie_codigo_produto = v_prod
                                      AND l.unidade = v_cb_unid) THEN
      v_motivo := 'unidade_incompativel';
    END IF;

    IF v_motivo IS NULL THEN
      IF NOT v_tem_cb THEN v_fator := 1; END IF;  -- EAN do próprio item: 1 leitura = 1 unidade da linha
      -- Candidatas: código cadastrado → linhas do produto NA UNIDADE do código; EAN → linhas com esse EAN.
      IF NOT EXISTS (SELECT 1 FROM public.picking_linhas l
                      WHERE l.tarefa_id = v_t.id AND l.ativa AND NOT l.fracionaria
                        AND CASE WHEN v_tem_cb THEN l.omie_codigo_produto = v_prod AND l.unidade = v_cb_unid
                                 ELSE l.ean = v_codigo END) THEN
        v_motivo := 'linha_fracionaria_exige_manual';
      ELSE
        SELECT * INTO v_l FROM public.picking_linhas l
         WHERE l.tarefa_id = v_t.id AND l.ativa AND NOT l.fracionaria
           AND CASE WHEN v_tem_cb THEN l.omie_codigo_produto = v_prod AND l.unidade = v_cb_unid
                    ELSE l.ean = v_codigo END
           AND l.quantidade - public.picking_v2_separada(l.id, l.revisao) > 0
         ORDER BY l.codigo_item LIMIT 1;
        IF NOT FOUND THEN
          v_motivo := 'excesso';
        ELSE
          v_linha := v_l.id; v_linrev := v_l.revisao; v_unid := v_fator;
          IF v_fator > v_l.quantidade - public.picking_v2_separada(v_l.id, v_l.revisao) THEN
            v_motivo := 'excesso';
          END IF;
        END IF;
      END IF;
    END IF;

  ELSIF v_motivo IS NULL AND p_tipo = 'manual' THEN
    SELECT * INTO v_l FROM public.picking_linhas l WHERE l.id = p_linha_id AND l.tarefa_id = v_t.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'picking_registrar_leitura: linha não pertence à tarefa' USING ERRCODE = '22023';
    END IF;
    v_linha := v_l.id; v_linrev := v_l.revisao; v_unid := p_quantidade;
    IF NOT v_l.ativa THEN
      v_motivo := 'linha_inativa';
    ELSIF NOT v_l.fracionaria AND (v_l.ean IS NOT NULL OR EXISTS (
            SELECT 1 FROM public.picking_codigos_barras c
             WHERE c.account = v_t.account AND c.omie_codigo_produto = v_l.omie_codigo_produto
               AND c.unidade = v_l.unidade AND c.status = 'aprovado')) THEN
      v_motivo := 'manual_nao_permitido';
    ELSIF NOT v_l.fracionaria AND p_quantidade <> trunc(p_quantidade) THEN
      v_motivo := 'quantidade_nao_inteira';
    ELSIF p_quantidade > v_l.quantidade - public.picking_v2_separada(v_l.id, v_l.revisao) THEN
      v_motivo := 'excesso';
    END IF;

  ELSIF v_motivo IS NULL AND p_tipo = 'estorno' THEN
    SELECT * INTO v_orig FROM public.picking_leituras r WHERE r.id = p_estorna_leitura_id;
    IF NOT FOUND THEN
      -- Dependência ainda não recebida (offline fora de ordem): NÃO grava; o aparelho reenvia.
      RETURN jsonb_build_object('ok', false, 'motivo', 'original_nao_recebido', 'pendente', true, 'replay', false);
    END IF;
    IF v_orig.tarefa_id <> v_t.id OR NOT v_orig.aceita OR v_orig.tipo = 'estorno' THEN
      v_motivo := 'estorno_invalido';
    ELSE
      SELECT * INTO v_l FROM public.picking_linhas l WHERE l.id = v_orig.linha_id;
      v_linha := v_l.id; v_linrev := v_orig.linha_revisao; v_unid := -v_orig.unidades;
      IF NOT v_l.ativa OR v_l.revisao <> v_orig.linha_revisao THEN
        v_motivo := 'estorno_revisao_antiga';
      ELSIF EXISTS (SELECT 1 FROM public.picking_leituras r
                     WHERE r.estorna_leitura_id = v_orig.id AND r.aceita) THEN
        v_motivo := 'ja_estornada';
      END IF;
    END IF;
  END IF;

  -- UUID concorrente em OUTRA tarefa (lock diferente): o ON CONFLICT espera a outra transação.
  INSERT INTO public.picking_leituras
         (id, account, tarefa_id, linha_id, linha_revisao, tarefa_revisao, tipo, codigo_lido, unidades,
          estorna_leitura_id, operador_id, atribuicao_id, comando, lido_em, recebido_em, aceita, motivo_rejeicao)
  VALUES (p_leitura_id, v_t.account, v_t.id, v_linha, v_linrev, p_tarefa_revisao, p_tipo, v_codigo, v_unid,
          v_orig.id, v_uid, p_atribuicao_id, v_cmd, p_lido_em, clock_timestamp(), v_motivo IS NULL, v_motivo)
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_inseriu = ROW_COUNT;
  IF v_inseriu = 0 THEN
    RAISE EXCEPTION 'picking_registrar_leitura: leitura % gravada por outra transação', p_leitura_id USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object('ok', v_motivo IS NULL, 'motivo', v_motivo, 'linha_id', v_linha,
                            'unidades', v_unid, 'replay', false);
END;
$function$;

-- ─── RPC 4: picking_marcar_falta (staff) ─────────────────────────────────────────────────────
-- Falta BLOQUEIA a separação: a tarefa vai a aguardando_ajuste e vendas ajusta o pedido no Omie.
CREATE OR REPLACE FUNCTION public.picking_marcar_falta(
  p_evento_id uuid,
  p_account text,
  p_tarefa_id uuid,
  p_atribuicao_id uuid,
  p_linha_id uuid,
  p_observacao text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_cmd   jsonb;
  v_ev    public.picking_eventos%ROWTYPE;
  v_t     public.picking_tarefas%ROWTYPE;
  v_l     public.picking_linhas%ROWTYPE;
  v_saldo numeric;
  v_res   jsonb;
  v_para  text;
  v_inseriu integer;
BEGIN
  IF NOT (public.has_role(v_uid, 'employee'::public.app_role) OR public.has_role(v_uid, 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'picking_marcar_falta: só staff' USING ERRCODE = '42501';
  END IF;
  IF p_evento_id IS NULL OR p_tarefa_id IS NULL OR p_account IS NULL OR p_linha_id IS NULL OR p_atribuicao_id IS NULL THEN
    RAISE EXCEPTION 'picking_marcar_falta: parâmetros ausentes' USING ERRCODE = '22023';
  END IF;
  v_cmd := jsonb_build_object('op', 'falta', 'account', p_account, 'tarefa', p_tarefa_id,
                              'atribuicao', p_atribuicao_id, 'linha', p_linha_id);

  PERFORM pg_advisory_xact_lock(hashtextextended('picking_v2_tarefa:' || p_tarefa_id::text, 0));
  SELECT * INTO v_t FROM public.picking_tarefas t WHERE t.id = p_tarefa_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'picking_marcar_falta: tarefa inexistente' USING ERRCODE = 'P0002';
  END IF;
  IF v_t.account <> p_account THEN
    RAISE EXCEPTION 'picking_marcar_falta: tarefa de outra conta' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_l FROM public.picking_linhas l WHERE l.id = p_linha_id AND l.tarefa_id = v_t.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'picking_marcar_falta: linha não pertence à tarefa' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ev FROM public.picking_eventos e WHERE e.id = p_evento_id;
  IF FOUND THEN
    IF v_ev.operador_id IS DISTINCT FROM v_uid OR v_ev.detalhe -> 'comando' IS DISTINCT FROM v_cmd THEN
      RAISE EXCEPTION 'picking_marcar_falta: evento % reutilizado em outro comando', p_evento_id USING ERRCODE = '22023';
    END IF;
    RETURN (v_ev.detalhe -> 'resultado') || jsonb_build_object('replay', true);
  END IF;

  IF v_t.status <> 'em_separacao' THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'tarefa_fora_de_separacao');
  ELSIF v_t.atribuicao_id IS DISTINCT FROM p_atribuicao_id OR v_t.operador_id IS DISTINCT FROM v_uid THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'atribuicao_antiga');
  ELSIF NOT v_l.ativa THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'linha_inativa');
  ELSE
    v_saldo := v_l.quantidade - public.picking_v2_separada(v_l.id, v_l.revisao);
    IF v_saldo <= 0 THEN
      v_res := jsonb_build_object('ok', false, 'motivo', 'linha_completa');
    ELSE
      UPDATE public.picking_tarefas t
         SET status = 'aguardando_ajuste', estado_seq = t.estado_seq + 1, atualizado_em = clock_timestamp()
       WHERE t.id = v_t.id;
      v_para := 'aguardando_ajuste';
      v_res := jsonb_build_object('ok', true, 'codigo_item', v_l.codigo_item, 'faltante', v_saldo);
    END IF;
  END IF;

  INSERT INTO public.picking_eventos (id, account, tarefa_id, linha_id, tipo, de_status, para_status, operador_id, detalhe)
  VALUES (p_evento_id, v_t.account, v_t.id, v_l.id, 'falta', v_t.status, v_para, v_uid,
          jsonb_build_object('comando', v_cmd, 'resultado', v_res, 'observacao', left(p_observacao, 500)))
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_inseriu = ROW_COUNT;
  IF v_inseriu = 0 THEN
    RAISE EXCEPTION 'evento % gravado por outra transação', p_evento_id USING ERRCODE = '22023';
  END IF;
  RETURN v_res || jsonb_build_object('replay', false);
END;
$function$;

-- ─── RPC 5: picking_retomar (staff) ──────────────────────────────────────────────────────────
-- Recuperação explícita (contratos 4 e 8). TODA retomada exige reconciliação física — a de
-- suspensa_alteracao, a de aguardando_ajuste e a reabertura de separado: o volume pode ter peças
-- que o banco não conta. p_estado_seq amarra a confirmação ao estado que o operador viu.
-- Separado que já saiu da etapa 10 não reabre (só a sync, na reentrada).
CREATE OR REPLACE FUNCTION public.picking_retomar(
  p_evento_id uuid,
  p_account text,
  p_tarefa_id uuid,
  p_estado_seq integer,
  p_reconciliacao_fisica boolean DEFAULT false
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_cmd  jsonb;
  v_ev   public.picking_eventos%ROWTYPE;
  v_t    public.picking_tarefas%ROWTYPE;
  v_atr  uuid;
  v_res  jsonb;
  v_para text;
  v_inseriu integer;
BEGIN
  IF NOT (public.has_role(v_uid, 'employee'::public.app_role) OR public.has_role(v_uid, 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'picking_retomar: só staff' USING ERRCODE = '42501';
  END IF;
  IF p_evento_id IS NULL OR p_tarefa_id IS NULL OR p_account IS NULL OR p_estado_seq IS NULL THEN
    RAISE EXCEPTION 'picking_retomar: parâmetros ausentes' USING ERRCODE = '22023';
  END IF;
  v_cmd := jsonb_build_object('op', 'retomar', 'account', p_account, 'tarefa', p_tarefa_id,
                              'estado_seq', p_estado_seq, 'reconciliacao', p_reconciliacao_fisica IS TRUE);

  PERFORM pg_advisory_xact_lock(hashtextextended('picking_v2_tarefa:' || p_tarefa_id::text, 0));
  SELECT * INTO v_t FROM public.picking_tarefas t WHERE t.id = p_tarefa_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'picking_retomar: tarefa inexistente' USING ERRCODE = 'P0002';
  END IF;
  IF v_t.account <> p_account THEN
    RAISE EXCEPTION 'picking_retomar: tarefa de outra conta' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ev FROM public.picking_eventos e WHERE e.id = p_evento_id;
  IF FOUND THEN
    IF v_ev.operador_id IS DISTINCT FROM v_uid OR v_ev.detalhe -> 'comando' IS DISTINCT FROM v_cmd THEN
      RAISE EXCEPTION 'picking_retomar: evento % reutilizado em outro comando', p_evento_id USING ERRCODE = '22023';
    END IF;
    RETURN (v_ev.detalhe -> 'resultado') || jsonb_build_object('replay', true);
  END IF;

  IF v_t.estado_seq <> p_estado_seq THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'estado_mudou');
  ELSIF v_t.status NOT IN ('suspensa_alteracao', 'separado', 'aguardando_ajuste') THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'status_' || v_t.status);
  ELSIF v_t.fora_da_etapa_em IS NOT NULL THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'fora_da_etapa');
  ELSIF p_reconciliacao_fisica IS NOT TRUE THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'exige_reconciliacao_fisica');
  ELSE
    v_atr := gen_random_uuid();
    UPDATE public.picking_tarefas t
       SET status = 'em_separacao', operador_id = v_uid, atribuicao_id = v_atr, separado_em = NULL,
           pega_em = clock_timestamp(), estado_seq = t.estado_seq + 1, atualizado_em = clock_timestamp()
     WHERE t.id = v_t.id;
    v_para := 'em_separacao';
    v_res := jsonb_build_object('ok', true, 'atribuicao_id', v_atr, 'tarefa_revisao', v_t.revisao,
                                'estado_seq', v_t.estado_seq + 1);
  END IF;

  INSERT INTO public.picking_eventos (id, account, tarefa_id, tipo, de_status, para_status, operador_id, detalhe)
  VALUES (p_evento_id, v_t.account, v_t.id, 'retomar', v_t.status, v_para, v_uid,
          jsonb_build_object('comando', v_cmd, 'resultado', v_res))
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_inseriu = ROW_COUNT;
  IF v_inseriu = 0 THEN
    RAISE EXCEPTION 'evento % gravado por outra transação', p_evento_id USING ERRCODE = '22023';
  END IF;
  RETURN v_res || jsonb_build_object('replay', false);
END;
$function$;

-- ─── RPC 6: picking_concluir (staff) ─────────────────────────────────────────────────────────
-- Fecha por LINHA (separada = pedida em toda linha ativa, ≥ 1 linha) e SÓ quando o servidor já
-- recebeu TODAS as leituras que o aparelho emitiu nesta atribuição (p_leituras) — senão um
-- estorno ou bipe ainda em voo deixaria o banco 'separado' com o volume diferente.
CREATE OR REPLACE FUNCTION public.picking_concluir(
  p_evento_id uuid,
  p_account text,
  p_tarefa_id uuid,
  p_atribuicao_id uuid,
  p_tarefa_revisao integer,
  p_leituras uuid[]
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_cmd  jsonb;
  v_ev   public.picking_eventos%ROWTYPE;
  v_t    public.picking_tarefas%ROWTYPE;
  v_res  jsonb;
  v_para text;
  v_faltam integer;
  v_inseriu integer;
BEGIN
  IF NOT (public.has_role(v_uid, 'employee'::public.app_role) OR public.has_role(v_uid, 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'picking_concluir: só staff' USING ERRCODE = '42501';
  END IF;
  IF p_evento_id IS NULL OR p_tarefa_id IS NULL OR p_account IS NULL OR p_atribuicao_id IS NULL
     OR p_tarefa_revisao IS NULL OR p_leituras IS NULL OR array_position(p_leituras, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'picking_concluir: parâmetros ausentes' USING ERRCODE = '22023';
  END IF;
  v_cmd := jsonb_build_object('op', 'concluir', 'account', p_account, 'tarefa', p_tarefa_id,
                              'atribuicao', p_atribuicao_id, 'tarefa_revisao', p_tarefa_revisao,
                              'leituras', (SELECT to_jsonb(array_agg(DISTINCT x ORDER BY x)) FROM unnest(p_leituras) x));

  PERFORM pg_advisory_xact_lock(hashtextextended('picking_v2_tarefa:' || p_tarefa_id::text, 0));
  SELECT * INTO v_t FROM public.picking_tarefas t WHERE t.id = p_tarefa_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'picking_concluir: tarefa inexistente' USING ERRCODE = 'P0002';
  END IF;
  IF v_t.account <> p_account THEN
    RAISE EXCEPTION 'picking_concluir: tarefa de outra conta' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ev FROM public.picking_eventos e WHERE e.id = p_evento_id;
  IF FOUND THEN
    IF v_ev.operador_id IS DISTINCT FROM v_uid OR v_ev.detalhe -> 'comando' IS DISTINCT FROM v_cmd THEN
      RAISE EXCEPTION 'picking_concluir: evento % reutilizado em outro comando', p_evento_id USING ERRCODE = '22023';
    END IF;
    RETURN (v_ev.detalhe -> 'resultado') || jsonb_build_object('replay', true);
  END IF;

  SELECT count(*) INTO v_faltam FROM unnest(p_leituras) x
   WHERE NOT EXISTS (SELECT 1 FROM public.picking_leituras r
                      WHERE r.id = x AND r.tarefa_id = v_t.id AND r.atribuicao_id = p_atribuicao_id);

  IF v_t.status <> 'em_separacao' THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'tarefa_fora_de_separacao');
  ELSIF v_t.atribuicao_id IS DISTINCT FROM p_atribuicao_id OR v_t.operador_id IS DISTINCT FROM v_uid THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'atribuicao_antiga');
  ELSIF v_t.revisao <> p_tarefa_revisao THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'revisao_antiga');
  ELSIF v_faltam > 0 THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'leituras_pendentes', 'faltam', v_faltam);
  ELSIF NOT EXISTS (SELECT 1 FROM public.picking_linhas l WHERE l.tarefa_id = v_t.id AND l.ativa) THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'sem_linhas');
  ELSIF EXISTS (SELECT 1 FROM public.picking_linhas l
                 WHERE l.tarefa_id = v_t.id AND l.ativa
                   AND public.picking_v2_separada(l.id, l.revisao) <> l.quantidade) THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'linhas_incompletas');
  ELSE
    UPDATE public.picking_tarefas t
       SET status = 'separado', separado_em = clock_timestamp(), estado_seq = t.estado_seq + 1,
           atualizado_em = clock_timestamp()
     WHERE t.id = v_t.id;
    v_para := 'separado';
    v_res := jsonb_build_object('ok', true, 'estado_seq', v_t.estado_seq + 1);
  END IF;

  INSERT INTO public.picking_eventos (id, account, tarefa_id, tipo, de_status, para_status, operador_id, detalhe)
  VALUES (p_evento_id, v_t.account, v_t.id, 'concluir', v_t.status, v_para, v_uid,
          jsonb_build_object('comando', v_cmd, 'resultado', v_res))
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_inseriu = ROW_COUNT;
  IF v_inseriu = 0 THEN
    RAISE EXCEPTION 'evento % gravado por outra transação', p_evento_id USING ERRCODE = '22023';
  END IF;
  RETURN v_res || jsonb_build_object('replay', false);
END;
$function$;

-- ─── ACL das funções ─────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.picking_leituras_imutavel() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.picking_v2_separada(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.picking_v2_motivo_invalido(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.picking_v2_itens(jsonb) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.picking_sincronizar_fila(text, timestamptz, bigint[], integer, jsonb, bigint[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.picking_sincronizar_fila(text, timestamptz, bigint[], integer, jsonb, bigint[])
  TO service_role;

REVOKE ALL ON FUNCTION public.picking_pegar_task(uuid, text, uuid, integer, boolean, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.picking_registrar_leitura(uuid, text, uuid, uuid, integer, text, text, uuid, numeric, uuid, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.picking_marcar_falta(uuid, text, uuid, uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.picking_retomar(uuid, text, uuid, integer, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.picking_concluir(uuid, text, uuid, uuid, integer, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.picking_pegar_task(uuid, text, uuid, integer, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.picking_registrar_leitura(uuid, text, uuid, uuid, integer, text, text, uuid, numeric, uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.picking_marcar_falta(uuid, text, uuid, uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.picking_retomar(uuid, text, uuid, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.picking_concluir(uuid, text, uuid, uuid, integer, uuid[]) TO authenticated;

-- v1: caminhos de ESCRITA incompatíveis desativados (0 linhas em prod; soma global e UPDATE absoluto).
REVOKE EXECUTE ON FUNCTION public.ensure_picking_task_for_sales_order(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recalcular_picking_task(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.confirmar_item_picking(uuid, uuid, uuid, integer, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated;

-- ─── Postcondição: o estado final é o desenhado, ou a transação inteira aborta ───────────────
DO $post$
DECLARE
  v_tab text;
  v_fn  text;
  v_r   text;
BEGIN
  FOREACH v_tab IN ARRAY ARRAY['picking_coleta_estado', 'picking_tarefas', 'picking_linhas',
                               'picking_leituras', 'picking_codigos_barras', 'picking_eventos'] LOOP
    IF (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = v_tab) IS NOT TRUE THEN
      RAISE EXCEPTION 'POSTCONDICAO: % sem RLS', v_tab;
    END IF;
    IF has_table_privilege('anon', 'public.' || v_tab, 'SELECT') THEN
      RAISE EXCEPTION 'POSTCONDICAO: % legível por anon', v_tab;
    END IF;
    FOREACH v_r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF has_table_privilege(v_r, 'public.' || v_tab, 'INSERT')
         OR has_table_privilege(v_r, 'public.' || v_tab, 'UPDATE')
         OR has_table_privilege(v_r, 'public.' || v_tab, 'DELETE')
         OR has_table_privilege(v_r, 'public.' || v_tab, 'TRUNCATE') THEN
        RAISE EXCEPTION 'POSTCONDICAO: % gravável direto por %', v_tab, v_r;
      END IF;
    END LOOP;
  END LOOP;
  IF has_table_privilege('authenticated', 'public.picking_coleta_estado', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICAO: picking_coleta_estado legível por authenticated';
  END IF;
  IF NOT coalesce((SELECT c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = 'picking_linhas_progresso')
                  && ARRAY['security_invoker=on', 'security_invoker=true'], false) THEN
    RAISE EXCEPTION 'POSTCONDICAO: picking_linhas_progresso sem security_invoker';
  END IF;

  v_fn := 'public.picking_sincronizar_fila(text, timestamptz, bigint[], integer, jsonb, bigint[])';
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO: % executável por anon/authenticated', v_fn;
  END IF;
  IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO: % sem EXECUTE para service_role', v_fn;
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.picking_pegar_task(uuid, text, uuid, integer, boolean, boolean)',
    'public.picking_registrar_leitura(uuid, text, uuid, uuid, integer, text, text, uuid, numeric, uuid, timestamptz)',
    'public.picking_marcar_falta(uuid, text, uuid, uuid, uuid, text)',
    'public.picking_retomar(uuid, text, uuid, integer, boolean)',
    'public.picking_concluir(uuid, text, uuid, uuid, integer, uuid[])'
  ] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICAO: % executável por anon', v_fn;
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICAO: % sem EXECUTE para authenticated', v_fn;
    END IF;
  END LOOP;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.picking_leituras_imutavel()',
    'public.picking_v2_separada(uuid, integer)',
    'public.picking_v2_motivo_invalido(jsonb)',
    'public.picking_v2_itens(jsonb)',
    'public.ensure_picking_task_for_sales_order(uuid)',
    'public.recalcular_picking_task(uuid)',
    'public.confirmar_item_picking(uuid, uuid, uuid, integer, text, text, timestamp with time zone)'
  ] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICAO: % executável por anon/authenticated', v_fn;
    END IF;
  END LOOP;
END
$post$;
