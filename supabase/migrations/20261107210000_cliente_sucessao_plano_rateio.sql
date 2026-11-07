-- Rateio do histórico de compras numa sucessão/cisão DECLARADA (Radar, entrega 3 do "sucessor declarado", PR B:
-- a camada de DADOS). Desenho aprovado pelo founder em 2026-11-07 depois do Codex -r max (9 P1, nenhum P0).
-- Base: a entrega 2 (20261107013000_cliente_sucessoes.sql), em prod desde 2026-11-07.
--
-- O que esta migration cria:
--   1. O PLANO DE RATEIO, versionado: `public.cliente_sucessao_plano_revisoes` (uma revisão IMUTÁVEL por vez, por
--      evento da antiga) e `public.cliente_sucessao_plano_regras` (por ITEM INTEIRO: (empresa, omie_codigo_produto)
--      → uma declaração do evento como destino). A família é EXPANDIDA em regras de item na publicação.
--      Item sem regra fica com a antiga; destino pendente (declarada) ou revogado volta à origem, sem renormalizar.
--      Publicar é atômico (revisão + regras na mesma transação), com versão otimista por evento. Revogar o plano é
--      uma revisão nova `revoga`, sem regras: o histórico das revisões nunca é reescrito.
--   2. `private.historico_consumo_efetivo(p_ate)`: a trilha EFETIVA, SEPARADA de `private.venda_linhas_pedido` (que
--      não muda). Mesmo universo e mesmo dia, carregando `order_item_id`/`sales_order_id`. Cada linha FÍSICA sai
--      uma vez, com um comprador efetivo: o novo, se a linha é da antiga, anterior ao corte, e o item tem regra
--      para um destino `ativa` em `private.cliente_sucessoes_vigentes(hoje SP)`; senão o comprador do pedido.
--      Numa `sucessao` (a antiga morreu), a partir do corte a antiga sai das sugestões e do "parou de comprar"
--      (`private.historico_compradores_encerrados`). A nova NÃO herda preço: o líquido da linha herdada é o
--      FÍSICO (antes do rateio, NULL preservado), marcado `herdada` = referência da origem.
--   3. O cálculo AO VIVO das sugestões lê a trilha efetiva: `private.venda_recompra_efetiva_em`,
--      `private.venda_situacao_efetiva_em` e `private.venda_lista_calc_efetiva` (espelhos dos factuais, com a
--      paridade provada quando não há plano). `public.venda_gerar_lista` passa a gerar a recompra daí e MARCA a
--      origem (`venda_sugestao.sucessao_origem` = [{evento_id, revisao}] e `valor_ref_referencia_origem`).
--   4. Invalidação: publicar ou revogar o plano reprocessa as sugestões de recompra de HOJE dos farmers afetados
--      (`private.venda_sugestoes_reprocessar_sucessao`). Só sai a sugestão que mudou, nunca mostrada e sem
--      desfecho; ela vai para `public.venda_sugestao_substituida` (a linha inteira, imutável) e a substituta entra.
--      `mostrada_em`, os contatos (`venda_contato`) e os desfechos ficam como estão.
--   5. RPCs (gestor/master = pode_ver_carteira_completa): `cliente_sucessao_plano_publicar`,
--      `cliente_sucessao_plano_revogar` e `cliente_sucessao_plano_do_evento` (leitura).
--
-- Permanece FACTUAL (nenhum destes objetos é recriado aqui): `private.venda_linhas_pedido`, `public.venda_recompra_em`,
-- `public.venda_situacao_em`, `private.venda_lista_calc`, a TABELA `venda_recompra` e o `venda_recompra_atualizar`
-- (o repasse lê a tabela), todo o repasse (`_venda_repasse_base`, `venda_repasse_candidatos`, a substituição),
-- `venda_lista_preco`, preço, régua, tint, margem/DRE, `customer_metrics_mv`, `farmer_client_scores`, crédito,
-- reposição e apriori. O complemento de mix, a lista da farmer e a ficha são do PR C.
--
-- Recria UM objeto vivo (`public.venda_gerar_lista`) no molde TRAVA → PRE → CREATE → PÓS. Sem BEGIN/COMMIT: o SQL
-- Editor roda o script inteiro numa transação implícita. Idempotente.

-- ── 0. TRAVA (antes de ler): ALTER sem efeito, com a volatilidade VIVA, na função que este arquivo recria ─────
DO $trava$
BEGIN
  IF to_regprocedure('public.venda_gerar_lista(date,text)') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: public.venda_gerar_lista(date,text) ausente';
  END IF;
  ALTER FUNCTION public.venda_gerar_lista(date, text) VOLATILE;
END
$trava$;

-- ── PRE: a base e os corpos vivos que esta migration espelha (medidos em prod via psql-ro em 2026-11-07) ──────
DO $pre$
DECLARE
  r record;
BEGIN
  IF to_regprocedure('public.pode_ver_carteira_completa(uuid)') IS NULL
     OR to_regprocedure('private.cliente_sucessoes_vigentes(date)') IS NULL
     OR to_regprocedure('private.cliente_resolver_documento(text)') IS NULL
     OR to_regprocedure('private.venda_mediana(numeric[])') IS NULL
     OR to_regprocedure('public.venda_cidades_alvo(date)') IS NULL
     OR to_regclass('public.cliente_sucessoes') IS NULL
     OR to_regclass('public.venda_sugestao') IS NULL
     OR to_regclass('public.venda_gerador_execucao') IS NULL
     OR to_regclass('public.omie_products') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: falta a base (entrega 2 da sucessão, gerador de venda, omie_products)';
  END IF;
  -- O que é recriado: md5 EXATO do corpo vivo ∈ {predecessor revisado, este}. O que é ESPELHADO (lido, não
  -- recriado): o corpo vivo tem de ser o que foi copiado, senão o espelho nasce divergente do factual.
  FOR r IN
    SELECT v.alvo, v.aceitos,
           (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v.alvo)) AS vivo
      FROM (VALUES
        ('public.venda_gerar_lista(date,text)', ARRAY['5abe897dbcaaf3b70351da896e35b566', 'b5320515336793a8f5d149288edd83a3']),
        ('private.venda_linhas_pedido(date)', ARRAY['a7ff6d1c894aea2e16483b5084a097a1']),
        ('public.venda_recompra_em(date)', ARRAY['2b43b81254a7c13c019c65fae41ea90a']),
        ('public.venda_situacao_em(date)', ARRAY['e96cf9c931a13b209bb3017b8c4743ac']),
        ('private.venda_lista_calc(date)', ARRAY['cd7a7184e4b07d3665b1c39f70a3ac59'])
      ) AS v(alvo, aceitos)
  LOOP
    IF r.vivo IS NULL OR NOT (r.vivo = ANY (r.aceitos)) THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) não é o corpo revisado', r.alvo, r.vivo;
    END IF;
  END LOOP;
END
$pre$;

-- ── 1. O plano: revisões imutáveis + regras por item inteiro ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cliente_sucessao_plano_revisoes (
  evento_id     uuid NOT NULL,
  revisao       integer NOT NULL,
  revoga        boolean NOT NULL,
  motivo        text,
  publicado_por uuid NOT NULL,
  publicado_em  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (evento_id, revisao),
  CONSTRAINT cliente_sucessao_plano_revisoes_revisao_chk CHECK (revisao >= 1),
  -- `motivo IS NOT NULL` explícito: length(btrim(NULL)) > 0 é NULL, e CHECK aceita NULL.
  CONSTRAINT cliente_sucessao_plano_revisoes_motivo_chk CHECK (
    (motivo IS NULL OR length(btrim(motivo)) > 0)
    AND (NOT revoga OR (motivo IS NOT NULL AND length(btrim(motivo)) > 0)))
);
COMMENT ON TABLE public.cliente_sucessao_plano_revisoes IS
  'Revisões IMUTÁVEIS do plano de rateio de um evento de sucessão (cliente_sucessoes.evento_id). A vigente é a de '
  'maior número; `revoga` = o plano foi revogado (sem regras). Escritores: public.cliente_sucessao_plano_publicar / '
  'public.cliente_sucessao_plano_revogar. Lida por private.historico_consumo_efetivo.';

CREATE TABLE IF NOT EXISTS public.cliente_sucessao_plano_regras (
  evento_id           uuid NOT NULL,
  revisao             integer NOT NULL,
  empresa             text NOT NULL,
  omie_codigo_produto bigint NOT NULL,
  destino_sucessao_id uuid NOT NULL REFERENCES public.cliente_sucessoes (id),
  novo_documento      text NOT NULL,
  origem              text NOT NULL,
  familia             text,
  PRIMARY KEY (evento_id, revisao, empresa, omie_codigo_produto),
  FOREIGN KEY (evento_id, revisao) REFERENCES public.cliente_sucessao_plano_revisoes (evento_id, revisao),
  CONSTRAINT cliente_sucessao_plano_regras_empresa_chk CHECK (empresa IN ('oben', 'colacor', 'colacor_sc')),
  CONSTRAINT cliente_sucessao_plano_regras_origem_chk CHECK (
    (origem = 'item' AND familia IS NULL) OR (origem = 'familia' AND familia IS NOT NULL AND length(btrim(familia)) > 0))
);
COMMENT ON TABLE public.cliente_sucessao_plano_regras IS
  'Regras do plano de rateio: o ITEM INTEIRO (empresa, omie_codigo_produto) da antiga, antes do corte, vai para a '
  'declaração-destino (uma linha de cliente_sucessoes do MESMO evento). A família é expandida em itens na publicação '
  '(origem=familia). Imutável. Item sem regra fica com a antiga; destino não-ativo volta à origem.';

-- O arquivo das sugestões substituídas: a linha INTEIRA como era (jsonb), mais quem/quando/por quê.
CREATE TABLE IF NOT EXISTS public.venda_sugestao_substituida (
  id                  uuid PRIMARY KEY,
  reprocesso_id       uuid NOT NULL,
  substituida_em      timestamptz NOT NULL DEFAULT now(),
  motivo              text NOT NULL,
  evento_id           uuid NOT NULL,
  plano_revisao       integer NOT NULL,
  dia_referencia      date NOT NULL,
  fase                text NOT NULL,
  farmer_user_id      uuid NOT NULL,
  comprador_id        uuid NOT NULL,
  empresa             text NOT NULL,
  omie_codigo_produto bigint,
  sugestao            jsonb NOT NULL,
  CONSTRAINT venda_sugestao_substituida_motivo_chk CHECK (motivo IN ('plano_publicado', 'plano_revogado'))
);
CREATE INDEX IF NOT EXISTS venda_sugestao_substituida_dia_idx
  ON public.venda_sugestao_substituida (dia_referencia, farmer_user_id);
COMMENT ON TABLE public.venda_sugestao_substituida IS
  'Sugestões de recompra de HOJE que um reprocesso da sucessão (publicar/revogar o plano) tirou da lista porque o '
  'cálculo mudou. Só sai a nunca mostrada e sem desfecho. Imutável. Escritor: private.venda_sugestoes_reprocessar_sucessao.';

ALTER TABLE public.cliente_sucessao_plano_revisoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cliente_sucessao_plano_regras ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.venda_sugestao_substituida ENABLE ROW LEVEL SECURITY;
-- Fechadas ao JWT (escrita SÓ pelas RPCs, leitura pela RPC de leitura); o service_role só LÊ.
REVOKE ALL ON TABLE public.cliente_sucessao_plano_revisoes FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.cliente_sucessao_plano_regras FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.venda_sugestao_substituida FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.cliente_sucessao_plano_revisoes TO service_role;
GRANT SELECT ON TABLE public.cliente_sucessao_plano_regras TO service_role;
GRANT SELECT ON TABLE public.venda_sugestao_substituida TO service_role;

-- Imutabilidade + porta: sem UPDATE/DELETE/TRUNCATE; INSERT só com a porta que as RPCs abrem na própria transação
-- (`cliente_sucessao_plano.porta` = 'rpc', local). A revisão nova é exatamente a seguinte (max + 1) e regra só
-- entra em revisão que não revoga. A porta é PROTOCOLO, não cofre: a leitura revalida o destino (vigentes).
CREATE OR REPLACE FUNCTION private.cliente_sucessao_plano_imutavel()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION '%: imutável (publique uma revisão nova)', TG_TABLE_NAME USING ERRCODE = '23001';
  END IF;
  IF current_setting('cliente_sucessao_plano.porta', true) IS DISTINCT FROM 'rpc' THEN
    RAISE EXCEPTION '%: escrita fora das RPCs do plano', TG_TABLE_NAME USING ERRCODE = '23001';
  END IF;
  IF TG_TABLE_NAME = 'cliente_sucessao_plano_revisoes' THEN
    IF NEW.revisao IS DISTINCT FROM 1 + COALESCE((SELECT max(r.revisao) FROM public.cliente_sucessao_plano_revisoes r
                                                    WHERE r.evento_id = NEW.evento_id), 0) THEN
      RAISE EXCEPTION 'cliente_sucessao_plano_revisoes: a revisão nova é a seguinte à vigente' USING ERRCODE = '23001';
    END IF;
  ELSIF TG_TABLE_NAME = 'cliente_sucessao_plano_regras' THEN
    IF NOT EXISTS (SELECT 1 FROM public.cliente_sucessao_plano_revisoes r
                    WHERE r.evento_id = NEW.evento_id AND r.revisao = NEW.revisao AND NOT r.revoga) THEN
      RAISE EXCEPTION 'cliente_sucessao_plano_regras: regra só em revisão que não revoga' USING ERRCODE = '23001';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION private.cliente_sucessao_plano_imutavel() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS cliente_sucessao_plano_revisoes_imutavel_trg ON public.cliente_sucessao_plano_revisoes;
CREATE TRIGGER cliente_sucessao_plano_revisoes_imutavel_trg
  BEFORE INSERT OR UPDATE OR DELETE ON public.cliente_sucessao_plano_revisoes
  FOR EACH ROW EXECUTE FUNCTION private.cliente_sucessao_plano_imutavel();
DROP TRIGGER IF EXISTS cliente_sucessao_plano_revisoes_sem_truncate_trg ON public.cliente_sucessao_plano_revisoes;
CREATE TRIGGER cliente_sucessao_plano_revisoes_sem_truncate_trg
  BEFORE TRUNCATE ON public.cliente_sucessao_plano_revisoes
  FOR EACH STATEMENT EXECUTE FUNCTION private.cliente_sucessao_plano_imutavel();
DROP TRIGGER IF EXISTS cliente_sucessao_plano_regras_imutavel_trg ON public.cliente_sucessao_plano_regras;
CREATE TRIGGER cliente_sucessao_plano_regras_imutavel_trg
  BEFORE INSERT OR UPDATE OR DELETE ON public.cliente_sucessao_plano_regras
  FOR EACH ROW EXECUTE FUNCTION private.cliente_sucessao_plano_imutavel();
DROP TRIGGER IF EXISTS cliente_sucessao_plano_regras_sem_truncate_trg ON public.cliente_sucessao_plano_regras;
CREATE TRIGGER cliente_sucessao_plano_regras_sem_truncate_trg
  BEFORE TRUNCATE ON public.cliente_sucessao_plano_regras
  FOR EACH STATEMENT EXECUTE FUNCTION private.cliente_sucessao_plano_imutavel();

CREATE OR REPLACE FUNCTION private.venda_sugestao_substituida_imutavel()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'venda_sugestao_substituida: imutável' USING ERRCODE = '23001';
  END IF;
  IF current_setting('venda_sugestao_substituida.porta', true) IS DISTINCT FROM 'rpc' THEN
    RAISE EXCEPTION 'venda_sugestao_substituida: escrita fora do reprocesso da sucessão' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION private.venda_sugestao_substituida_imutavel() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS venda_sugestao_substituida_imutavel_trg ON public.venda_sugestao_substituida;
CREATE TRIGGER venda_sugestao_substituida_imutavel_trg
  BEFORE INSERT OR UPDATE OR DELETE ON public.venda_sugestao_substituida
  FOR EACH ROW EXECUTE FUNCTION private.venda_sugestao_substituida_imutavel();
DROP TRIGGER IF EXISTS venda_sugestao_substituida_sem_truncate_trg ON public.venda_sugestao_substituida;
CREATE TRIGGER venda_sugestao_substituida_sem_truncate_trg
  BEFORE TRUNCATE ON public.venda_sugestao_substituida
  FOR EACH STATEMENT EXECUTE FUNCTION private.venda_sugestao_substituida_imutavel();

-- ── 2. A marcação de origem na sugestão ──────────────────────────────────────────────────────────────────────
-- `sucessao_origem`: NULL = só histórico próprio; senão [{evento_id, revisao}] de onde veio a parte herdada.
-- `valor_ref_referencia_origem`: o valor_ref saiu do líquido de uma linha HERDADA (referência da origem, não
-- preço da nova). Fast default: o ADD COLUMN não reescreve a tabela.
ALTER TABLE public.venda_sugestao ADD COLUMN IF NOT EXISTS sucessao_origem jsonb;
ALTER TABLE public.venda_sugestao ADD COLUMN IF NOT EXISTS valor_ref_referencia_origem boolean NOT NULL DEFAULT false;
DO $ck$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.venda_sugestao'::regclass
                    AND conname = 'venda_sugestao_sucessao_origem_ck') THEN
    ALTER TABLE public.venda_sugestao ADD CONSTRAINT venda_sugestao_sucessao_origem_ck CHECK (
      sucessao_origem IS NULL
      OR (jsonb_typeof(sucessao_origem) = 'array' AND jsonb_array_length(sucessao_origem) > 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.venda_sugestao'::regclass
                    AND conname = 'venda_sugestao_ref_origem_ck') THEN
    -- referência da origem só existe com valor e com herança
    ALTER TABLE public.venda_sugestao ADD CONSTRAINT venda_sugestao_ref_origem_ck CHECK (
      NOT valor_ref_referencia_origem OR (valor_ref IS NOT NULL AND sucessao_origem IS NOT NULL));
  END IF;
END
$ck$;

-- ── 3. A trilha efetiva ──────────────────────────────────────────────────────────────────────────────────────
-- As antigas ENCERRADAS vistas de p_ate: sucessão (não cisão) ativa com o corte já alcançado. Elas saem das
-- sugestões e da situação ("parou de comprar"); as linhas físicas delas seguem na trilha (conservação).
CREATE OR REPLACE FUNCTION private.historico_compradores_encerrados(p_ate date)
 RETURNS TABLE(comprador_id uuid, evento_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT DISTINCT v.antigo_user_id, v.evento_id
    FROM private.cliente_sucessoes_vigentes((now() AT TIME ZONE 'America/Sao_Paulo')::date) v
   WHERE v.estado = 'ativa' AND v.tipo = 'sucessao' AND v.data_corte <= p_ate
$function$;
REVOKE ALL ON FUNCTION private.historico_compradores_encerrados(date) FROM PUBLIC, anon, authenticated;

-- O universo e o dia são os de private.venda_linhas_pedido (espelho: mudou um, mude o outro — a prova acusa a
-- paridade). A herança vem SÓ das linhas `ativa` de vigentes(hoje SP), com o corte alcançado na data vista
-- (data_corte ≤ p_ate) e a linha anterior ao corte. Revisão vigente = a maior; `revoga` = sem herança.
-- Unicidade da regra por (antiga, empresa, item): 1 evento por antiga entre as `ativa` (vigentes marca
-- evento_divergente) × 1 revisão vigente por evento × PK da regra — o LEFT JOIN casa no máximo 1.
CREATE OR REPLACE FUNCTION private.historico_consumo_efetivo(p_ate date)
 RETURNS TABLE(comprador_id uuid, comprador_fisico_id uuid, empresa text, omie_codigo_produto bigint,
               product_id uuid, quantidade numeric, preco_unit_liquido numeric, data_pedido date,
               sales_order_id uuid, order_item_id uuid, herdada boolean, sucessao_evento_id uuid,
               plano_revisao integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH v AS (
    SELECT s.id, s.evento_id, s.antigo_user_id, s.novo_user_id, s.data_corte
      FROM private.cliente_sucessoes_vigentes((now() AT TIME ZONE 'America/Sao_Paulo')::date) s
     WHERE s.estado = 'ativa' AND s.data_corte <= p_ate
  ),
  rev AS (
    SELECT DISTINCT ON (r.evento_id) r.evento_id, r.revisao, r.revoga
      FROM public.cliente_sucessao_plano_revisoes r
     WHERE r.evento_id IN (SELECT v.evento_id FROM v)
     ORDER BY r.evento_id, r.revisao DESC
  ),
  regra AS (
    SELECT g.empresa, g.omie_codigo_produto, v.antigo_user_id, v.novo_user_id, v.data_corte, g.evento_id, g.revisao
      FROM rev
      JOIN public.cliente_sucessao_plano_regras g ON g.evento_id = rev.evento_id AND g.revisao = rev.revisao
      JOIN v ON v.id = g.destino_sucessao_id AND v.evento_id = g.evento_id
     WHERE NOT rev.revoga
  ),
  l AS (
    SELECT x.comprador_id, x.empresa, x.omie_codigo_produto, x.product_id,
           x.quantidade, x.preco_unit_liquido, x.data_pedido, x.sales_order_id, x.order_item_id
      FROM (
        SELECT COALESCE(a.canonical_user_id, so.customer_user_id) AS comprador_id,
               so.account AS empresa,
               oi.omie_codigo_produto,
               oi.product_id,
               oi.quantity AS quantidade,
               CASE WHEN oi.desconto_valor IS NULL OR oi.unit_price IS NULL THEN NULL
                    ELSE oi.unit_price - oi.desconto_valor / oi.quantity
               END AS preco_unit_liquido,
               COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) AS data_pedido,
               so.id AS sales_order_id,
               oi.id AS order_item_id
          FROM public.order_items oi
          JOIN public.sales_orders so ON so.id = oi.sales_order_id
          LEFT JOIN public.customer_canonical_alias a
                 ON a.alias_user_id = so.customer_user_id AND a.status = 'active'
         WHERE so.deleted_at IS NULL
           AND so.status NOT IN ('cancelado', 'rascunho', 'pendente', 'orcamento')
           AND so.customer_user_id IS NOT NULL
           AND so.account IN ('oben', 'colacor', 'colacor_sc')
           AND oi.omie_codigo_produto IS NOT NULL
           AND oi.quantity > 0
      ) x
     WHERE x.data_pedido < p_ate
  )
  SELECT COALESCE(rg.novo_user_id, l.comprador_id), l.comprador_id, l.empresa, l.omie_codigo_produto,
         l.product_id, l.quantidade, l.preco_unit_liquido, l.data_pedido,
         l.sales_order_id, l.order_item_id, rg.novo_user_id IS NOT NULL, rg.evento_id, rg.revisao
    FROM l
    LEFT JOIN regra rg
           ON rg.antigo_user_id = l.comprador_id AND rg.empresa = l.empresa
          AND rg.omie_codigo_produto = l.omie_codigo_produto AND l.data_pedido < rg.data_corte
$function$;
REVOKE ALL ON FUNCTION private.historico_consumo_efetivo(date) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION private.historico_consumo_efetivo(date) IS
  'Trilha EFETIVA do consumo (separada de private.venda_linhas_pedido, que segue factual): cada linha física uma vez, '
  'com o comprador efetivo pelo plano de rateio vigente da sucessão. herdada = referência da origem (sem preço da nova).';

-- ── 4. O cálculo ao vivo sobre a trilha efetiva (espelhos dos factuais; paridade provada sem plano) ─────────
-- = public.venda_recompra_em, lendo a trilha efetiva, sem as antigas encerradas, e com a origem da herança.
CREATE OR REPLACE FUNCTION private.venda_recompra_efetiva_em(p_data date)
 RETURNS TABLE(comprador_id uuid, empresa text, omie_codigo_produto bigint, product_id uuid, n_pedidos integer,
               cadencia_dias numeric, qtd_sugerida numeric, ultima_compra date, ultimo_preco numeric,
               due_ratio numeric, atrasado boolean, valor_esperado numeric,
               sucessao_origem jsonb, ultimo_preco_referencia_origem boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH enc AS (SELECT e.comprador_id FROM private.historico_compradores_encerrados(p_data) e),
  lin AS (
    SELECT l.*
      FROM private.historico_consumo_efetivo(p_data) l
     WHERE l.data_pedido >= p_data - 540
       AND NOT EXISTS (SELECT 1 FROM enc WHERE enc.comprador_id = l.comprador_id)
  ),
  por_dia AS (
    SELECT l.comprador_id, l.empresa, l.omie_codigo_produto, l.data_pedido,
           sum(l.quantidade) AS qtd,
           sum(l.quantidade * l.preco_unit_liquido) FILTER (WHERE l.preco_unit_liquido IS NOT NULL)
             / NULLIF(sum(l.quantidade) FILTER (WHERE l.preco_unit_liquido IS NOT NULL), 0) AS preco_dia,
           (array_agg(l.product_id ORDER BY l.product_id) FILTER (WHERE l.product_id IS NOT NULL))[1] AS product_id,
           bool_or(l.herdada) AS herdada_dia
      FROM lin l
     GROUP BY l.comprador_id, l.empresa, l.omie_codigo_produto, l.data_pedido
  ),
  com_gap AS (
    SELECT d.*,
           d.data_pedido - lag(d.data_pedido) OVER w AS gap,
           row_number() OVER (PARTITION BY d.comprador_id, d.empresa, d.omie_codigo_produto
                              ORDER BY d.data_pedido DESC) AS rn_desc
      FROM por_dia d
    WINDOW w AS (PARTITION BY d.comprador_id, d.empresa, d.omie_codigo_produto ORDER BY d.data_pedido)
  ),
  agg AS (
    SELECT g.comprador_id, g.empresa, g.omie_codigo_produto,
           count(*)::int AS n,
           private.venda_mediana(array_agg(g.gap::numeric) FILTER (WHERE g.gap IS NOT NULL)) AS cad,
           private.venda_mediana(array_agg(g.qtd)) AS qtd,
           max(g.data_pedido) AS ultima,
           max(g.preco_dia) FILTER (WHERE g.rn_desc = 1) AS ultimo_preco,
           (array_agg(g.product_id ORDER BY g.data_pedido DESC) FILTER (WHERE g.product_id IS NOT NULL))[1] AS product_id,
           COALESCE(bool_or(g.herdada_dia) FILTER (WHERE g.rn_desc = 1), false) AS ultimo_herdado
      FROM com_gap g
     GROUP BY g.comprador_id, g.empresa, g.omie_codigo_produto
    HAVING count(*) >= 3
  ),
  orig AS (
    SELECT l.comprador_id, l.empresa, l.omie_codigo_produto,
           jsonb_agg(DISTINCT jsonb_build_object('evento_id', l.sucessao_evento_id, 'revisao', l.plano_revisao)) AS o
      FROM lin l
     WHERE l.herdada
     GROUP BY l.comprador_id, l.empresa, l.omie_codigo_produto
  )
  SELECT a.comprador_id, a.empresa, a.omie_codigo_produto, a.product_id,
         a.n, a.cad, a.qtd, a.ultima, a.ultimo_preco,
         (p_data - a.ultima)::numeric / a.cad AS due_ratio,
         2 * (p_data - a.ultima) >= 3 * a.cad AS atrasado,
         a.qtd * a.ultimo_preco AS valor_esperado,
         o.o,
         a.ultimo_herdado AND a.ultimo_preco IS NOT NULL
    FROM agg a
    LEFT JOIN orig o ON o.comprador_id = a.comprador_id AND o.empresa = a.empresa
                    AND o.omie_codigo_produto = a.omie_codigo_produto
$function$;
REVOKE ALL ON FUNCTION private.venda_recompra_efetiva_em(date) FROM PUBLIC, anon, authenticated;

-- = public.venda_situacao_em, sobre a trilha efetiva e sem as antigas encerradas.
CREATE OR REPLACE FUNCTION private.venda_situacao_efetiva_em(p_data date)
 RETURNS TABLE(comprador_id uuid, situacao text, dias_sem_compra integer, valor_atrasado numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH enc AS (SELECT e.comprador_id FROM private.historico_compradores_encerrados(p_data) e),
  hist AS (
    SELECT l.comprador_id, max(l.data_pedido) AS ultima, count(DISTINCT l.data_pedido) AS n_dias
      FROM private.historico_consumo_efetivo(p_data) l
     WHERE NOT EXISTS (SELECT 1 FROM enc WHERE enc.comprador_id = l.comprador_id)
     GROUP BY l.comprador_id
  ),
  sk AS (
    SELECT r.comprador_id,
           private.venda_mediana(array_agg(r.cadencia_dias)) AS cad_mediana,
           count(*) FILTER (WHERE r.atrasado) AS n_atrasados,
           sum(r.valor_esperado) FILTER (WHERE r.atrasado) AS valor_atrasados
      FROM private.venda_recompra_efetiva_em(p_data) r
     GROUP BY r.comprador_id
  )
  SELECT h.comprador_id,
         CASE
           WHEN sk.comprador_id IS NULL AND h.n_dias < 3 THEN 'sem_base'
           WHEN (p_data - h.ultima) > GREATEST(3 * COALESCE(sk.cad_mediana, 0), 365) THEN 'perdido'
           WHEN COALESCE(sk.n_atrasados, 0) > 0 THEN 'atrasado'
           ELSE 'em_dia'
         END AS situacao,
         (p_data - h.ultima)::int AS dias_sem_compra,
         CASE WHEN COALESCE(sk.n_atrasados, 0) = 0 THEN 0 ELSE sk.valor_atrasados END AS valor_atrasado
    FROM hist h
    LEFT JOIN sk ON sk.comprador_id = h.comprador_id
$function$;
REVOKE ALL ON FUNCTION private.venda_situacao_efetiva_em(date) FROM PUBLIC, anon, authenticated;

-- = private.venda_lista_calc, sobre a recompra e a situação efetivas, carregando a marcação de origem.
CREATE OR REPLACE FUNCTION private.venda_lista_calc_efetiva(p_dia date)
 RETURNS TABLE(farmer_user_id uuid, comprador_id uuid, empresa text, omie_codigo_produto bigint, qtd_ref numeric,
               valor_ref numeric, motivo_entrada text, sucessao_origem jsonb, valor_ref_referencia_origem boolean)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_teto jsonb;
BEGIN
  IF p_dia IS NULL THEN
    RAISE EXCEPTION 'venda_lista_calc_efetiva: p_dia NULL' USING ERRCODE = '22023';
  END IF;
  SELECT c.valor INTO v_teto FROM public.venda_config c WHERE c.chave = 'teto_maiores_atrasos';
  IF jsonb_typeof(v_teto) IS DISTINCT FROM 'number' OR (v_teto #>> '{}')::numeric < 0
     OR (v_teto #>> '{}')::numeric <> trunc((v_teto #>> '{}')::numeric) THEN
    RAISE EXCEPTION 'venda_lista_calc_efetiva: venda_config.teto_maiores_atrasos ausente ou invalido' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH carteira AS (
    SELECT DISTINCT c.owner_user_id AS farmer, COALESCE(ca.canonical_user_id, c.customer_user_id) AS comprador
      FROM public.carteira_assignments c
      JOIN public.commercial_roles cr ON cr.user_id = c.owner_user_id AND cr.commercial_role = 'farmer'
      LEFT JOIN public.customer_canonical_alias ca
             ON ca.alias_user_id = c.customer_user_id AND ca.status = 'active'
     WHERE c.eligible
  ),
  situacao AS (
    SELECT s.comprador_id, s.situacao FROM private.venda_situacao_efetiva_em(p_dia) s
  ),
  atrasado AS (
    SELECT k.farmer, r.comprador_id AS comprador, r.empresa, r.omie_codigo_produto,
           r.qtd_sugerida, r.valor_esperado, r.sucessao_origem, r.ultimo_preco_referencia_origem
      FROM private.venda_recompra_efetiva_em(p_dia) r
      JOIN carteira k ON k.comprador = r.comprador_id
      JOIN situacao s ON s.comprador_id = r.comprador_id
     WHERE r.atrasado
       AND s.situacao <> 'perdido'
  ),
  alvo AS (
    SELECT a.city_norm, COALESCE(a.uf, '') AS uf FROM public.venda_cidades_alvo(p_dia) a
  ),
  na_rota AS (
    SELECT x.comprador, min(x.city_norm) AS city_norm
      FROM (
        SELECT COALESCE(ca.canonical_user_id, v.customer_user_id) AS comprador, al.city_norm
          FROM public.customer_visit_scores v
          JOIN alvo al ON al.city_norm = v.city_norm
          LEFT JOIN public.customer_canonical_alias ca
                 ON ca.alias_user_id = v.customer_user_id AND ca.status = 'active'
         WHERE al.uf = '' OR private.venda_city_uf(v.city) = '' OR private.venda_city_uf(v.city) = al.uf
      ) x
     GROUP BY x.comprador
  ),
  comprador AS (
    SELECT t.farmer, t.comprador, sum(t.valor_esperado) AS valor_atrasado, nr.city_norm
      FROM atrasado t
      LEFT JOIN na_rota nr ON nr.comprador = t.comprador
     GROUP BY t.farmer, t.comprador, nr.city_norm
  ),
  ranqueado AS (
    SELECT c.farmer, c.comprador,
           row_number() OVER (PARTITION BY c.farmer
                              ORDER BY c.valor_atrasado DESC NULLS LAST, c.comprador) AS pos
      FROM comprador c
     WHERE c.city_norm IS NULL
  ),
  escolhido AS (
    SELECT c.farmer, c.comprador, 'entrega amanhã em ' || initcap(c.city_norm) AS motivo
      FROM comprador c
     WHERE c.city_norm IS NOT NULL
    UNION ALL
    SELECT r.farmer, r.comprador, 'maior atraso da carteira'
      FROM ranqueado r
     WHERE r.pos <= (v_teto #>> '{}')::int
  )
  SELECT t.farmer, t.comprador, t.empresa, t.omie_codigo_produto,
         CASE WHEN t.qtd_sugerida > 0 THEN t.qtd_sugerida END,
         CASE WHEN t.valor_esperado > 0 THEN t.valor_esperado END,
         e.motivo,
         t.sucessao_origem,
         COALESCE(t.ultimo_preco_referencia_origem AND t.valor_esperado > 0 AND t.sucessao_origem IS NOT NULL, false)
    FROM atrasado t
    JOIN escolhido e ON e.farmer = t.farmer AND e.comprador = t.comprador;
END
$function$;
REVOKE ALL ON FUNCTION private.venda_lista_calc_efetiva(date) FROM PUBLIC, anon, authenticated;

-- ── 5. O gerador passa a gerar a recompra da trilha efetiva, com a marcação de origem ──────────────────────
-- Corpo vivo de prod (md5 5abe897d…) com UMA mudança: o 1º INSERT lê private.venda_lista_calc_efetiva e grava
-- sucessao_origem / valor_ref_referencia_origem. As ondas 2 (complemento) e 3 (preço) seguem idênticas.
CREATE OR REPLACE FUNCTION public.venda_gerar_lista(p_dia date, p_fase text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_n     integer;
  v_k     integer;
  v_total integer;
BEGIN
  IF p_dia IS NULL THEN
    RAISE EXCEPTION 'venda_gerar_lista: p_dia NULL' USING ERRCODE = '22023';
  END IF;
  IF p_fase IS NULL OR p_fase NOT IN ('historico','sombra','ativa') THEN
    RAISE EXCEPTION 'venda_gerar_lista: fase invalida' USING ERRCODE = '22023';
  END IF;
  IF p_fase = 'historico' AND p_dia >= (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN
    RAISE EXCEPTION 'venda_gerar_lista: historico so para dia passado' USING ERRCODE = '22023';
  END IF;
  IF p_fase = 'ativa' AND NOT EXISTS (SELECT 1 FROM public.venda_config
                                       WHERE chave = 'onda_recompra' AND valor = 'true'::jsonb) THEN
    RAISE EXCEPTION 'venda_gerar_lista: fase ativa com onda_recompra desligada' USING ERRCODE = '22023';
  END IF;

  -- Uma rodada por vez (cron + reconstrução manual + reprocesso da sucessão).
  PERFORM pg_advisory_xact_lock(hashtext('venda_gerar_lista'));

  -- Recompra sobre a trilha EFETIVA (sucessão declarada + plano de rateio), com a origem marcada.
  INSERT INTO public.venda_sugestao
         (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto,
          qtd_ref, valor_ref, motivo_entrada, sucessao_origem, valor_ref_referencia_origem)
  SELECT 'recompra', p_fase, p_dia, l.farmer_user_id, l.comprador_id, l.empresa, l.omie_codigo_produto,
         l.qtd_ref, l.valor_ref, l.motivo_entrada, l.sucessao_origem, l.valor_ref_referencia_origem
    FROM private.venda_lista_calc_efetiva(p_dia) l
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  SELECT count(*) INTO v_total
    FROM public.venda_sugestao
   WHERE dia_referencia = p_dia AND fase = p_fase AND tipo = 'recompra';

  INSERT INTO public.venda_gerador_execucao (dia_referencia, fase, linhas)
  VALUES (p_dia, p_fase, v_total)
  ON CONFLICT (dia_referencia, fase)
  DO UPDATE SET ultima_em = now(), linhas = EXCLUDED.linhas;

  -- Ondas 2 e 3: só na lista ATIVA de hoje (núcleo do Mix/Gap e último preço ao vivo leem now()).
  IF p_fase = 'ativa' AND p_dia = (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN
    IF EXISTS (SELECT 1 FROM public.venda_config WHERE chave = 'onda_complemento' AND valor = 'true'::jsonb) THEN
      INSERT INTO public.venda_sugestao
             (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, familia, motivo_entrada)
      SELECT 'complemento', p_fase, p_dia, c.farmer_user_id, c.comprador_id, c.empresa, c.familia,
             'clientes parecidos compram'
        FROM private.venda_lista_complemento(p_dia) c
       WHERE NOT EXISTS (SELECT 1 FROM public.venda_sugestao s
                          WHERE s.dia_referencia = p_dia AND s.fase = p_fase AND s.tipo = 'complemento'
                            AND s.farmer_user_id = c.farmer_user_id AND s.comprador_id = c.comprador_id)
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS v_k = ROW_COUNT;
      v_n := v_n + v_k;
    END IF;

    IF EXISTS (SELECT 1 FROM public.venda_config WHERE chave = 'onda_preco' AND valor = 'true'::jsonb) THEN
      INSERT INTO public.venda_sugestao
             (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto,
              preco_alvo, preco_anterior, motivo_entrada)
      SELECT 'preco', p_fase, p_dia, p.farmer_user_id, p.comprador_id, 'oben', p.omie_codigo_produto,
             p.preco_alvo, p.preco_anterior, 'repasse aprovado'
        FROM private.venda_lista_preco(p_dia) p
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS v_k = ROW_COUNT;
      v_n := v_n + v_k;
    END IF;
  END IF;

  RETURN v_n;
END
$function$;
-- O ACL vivo (medido): EXECUTE só de postgres e service_role. CREATE OR REPLACE preserva; reafirmado.
REVOKE ALL ON FUNCTION public.venda_gerar_lista(date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venda_gerar_lista(date, text) TO service_role;

-- ── 6. Invalidação: reprocessa a recompra de HOJE dos farmers afetados ─────────────────────────────────────
-- Escopo: os compradores do evento (todas as declarações, inclusive revogadas: o destino revogado devolve o item
-- à antiga) + os que têm sugestão de hoje marcada com este evento; os farmers = os da carteira deles + os das
-- sugestões deles (o ranking "maior atraso" é POR FARMER, então a lista inteira do farmer depende do plano).
-- Só as fases que o gerador já rodou hoje (venda_gerador_execucao): antes disso, o cron gera com o plano.
-- Sai (para o arquivo) a sugestão do escopo cujo cálculo mudou, NUNCA mostrada e SEM desfecho; entra a substituta
-- (ON CONFLICT DO NOTHING: a preservada, mostrada ou com desfecho, fica). Mesma trava do gerador.
CREATE OR REPLACE FUNCTION private.venda_sugestoes_reprocessar_sucessao(p_evento_id uuid, p_revisao integer, p_motivo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_dia date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_reproc uuid := gen_random_uuid();
  v_compradores uuid[];
  v_farmers uuid[];
  v_fase text;
  v_novo jsonb;
  v_k integer;
  v_sai integer := 0;
  v_entra integer := 0;
  v_pres integer := 0;
BEGIN
  IF p_evento_id IS NULL OR p_revisao IS NULL OR p_motivo IS NULL OR p_motivo NOT IN ('plano_publicado', 'plano_revogado') THEN
    RAISE EXCEPTION 'venda_sugestoes_reprocessar_sucessao: evento, revisão e motivo' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('venda_gerar_lista'));

  SELECT array_agg(DISTINCT z.uid) INTO v_compradores
    FROM (
      SELECT r.user_id AS uid
        FROM public.cliente_sucessoes s
       CROSS JOIN LATERAL private.cliente_resolver_documento(s.antigo_documento) r
       WHERE s.evento_id = p_evento_id
      UNION
      SELECT r.user_id
        FROM public.cliente_sucessoes s
       CROSS JOIN LATERAL private.cliente_resolver_documento(s.novo_documento) r
       WHERE s.evento_id = p_evento_id
      UNION
      SELECT s.comprador_id
        FROM public.venda_sugestao s
       WHERE s.dia_referencia = v_dia AND s.tipo = 'recompra'
         AND s.sucessao_origem @> jsonb_build_array(jsonb_build_object('evento_id', p_evento_id))
    ) z
   WHERE z.uid IS NOT NULL;

  SELECT array_agg(DISTINCT f.farmer) INTO v_farmers
    FROM (
      SELECT c.owner_user_id AS farmer
        FROM public.carteira_assignments c
        JOIN public.commercial_roles cr ON cr.user_id = c.owner_user_id AND cr.commercial_role = 'farmer'
        LEFT JOIN public.customer_canonical_alias ca
               ON ca.alias_user_id = c.customer_user_id AND ca.status = 'active'
       WHERE c.eligible AND COALESCE(ca.canonical_user_id, c.customer_user_id) = ANY (v_compradores)
      UNION
      SELECT s.farmer_user_id
        FROM public.venda_sugestao s
       WHERE s.dia_referencia = v_dia AND s.tipo = 'recompra' AND s.comprador_id = ANY (v_compradores)
    ) f
   WHERE f.farmer IS NOT NULL;

  IF v_farmers IS NULL OR NOT EXISTS (SELECT 1 FROM public.venda_gerador_execucao e WHERE e.dia_referencia = v_dia) THEN
    RETURN jsonb_build_object('dia', v_dia, 'farmers', COALESCE(cardinality(v_farmers), 0),
                              'substituidas', 0, 'novas', 0, 'preservadas', 0);
  END IF;

  -- O cálculo de hoje, uma vez (é o mesmo que o gerador roda), só dos farmers do escopo.
  SELECT COALESCE(jsonb_agg(to_jsonb(l)), '[]'::jsonb) INTO v_novo
    FROM private.venda_lista_calc_efetiva(v_dia) l
   WHERE l.farmer_user_id = ANY (v_farmers);

  FOR v_fase IN SELECT e.fase FROM public.venda_gerador_execucao e WHERE e.dia_referencia = v_dia ORDER BY e.fase LOOP
    -- Preservadas: mudaram, mas foram mostradas ou já têm desfecho (ficam como estão).
    SELECT count(*) INTO v_k
      FROM public.venda_sugestao s
     WHERE s.dia_referencia = v_dia AND s.fase = v_fase AND s.tipo = 'recompra'
       AND s.farmer_user_id = ANY (v_farmers)
       AND (s.mostrada_em IS NOT NULL OR s.desfecho IS NOT NULL)
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_to_recordset(v_novo) AS n(farmer_user_id uuid, comprador_id uuid, empresa text,
                 omie_codigo_produto bigint, qtd_ref numeric, valor_ref numeric, motivo_entrada text,
                 sucessao_origem jsonb, valor_ref_referencia_origem boolean)
          WHERE n.farmer_user_id = s.farmer_user_id AND n.comprador_id = s.comprador_id AND n.empresa = s.empresa
            AND n.omie_codigo_produto = s.omie_codigo_produto
            AND (n.qtd_ref, n.valor_ref, n.motivo_entrada, n.sucessao_origem, n.valor_ref_referencia_origem)
                IS NOT DISTINCT FROM
                (s.qtd_ref, s.valor_ref, s.motivo_entrada, s.sucessao_origem, s.valor_ref_referencia_origem));
    v_pres := v_pres + v_k;

    PERFORM set_config('venda_sugestao_substituida.porta', 'rpc', true);
    WITH sai AS (
      DELETE FROM public.venda_sugestao s
       WHERE s.dia_referencia = v_dia AND s.fase = v_fase AND s.tipo = 'recompra'
         AND s.farmer_user_id = ANY (v_farmers)
         AND s.mostrada_em IS NULL AND s.desfecho IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_to_recordset(v_novo) AS n(farmer_user_id uuid, comprador_id uuid, empresa text,
                   omie_codigo_produto bigint, qtd_ref numeric, valor_ref numeric, motivo_entrada text,
                   sucessao_origem jsonb, valor_ref_referencia_origem boolean)
            WHERE n.farmer_user_id = s.farmer_user_id AND n.comprador_id = s.comprador_id AND n.empresa = s.empresa
              AND n.omie_codigo_produto = s.omie_codigo_produto
              AND (n.qtd_ref, n.valor_ref, n.motivo_entrada, n.sucessao_origem, n.valor_ref_referencia_origem)
                  IS NOT DISTINCT FROM
                  (s.qtd_ref, s.valor_ref, s.motivo_entrada, s.sucessao_origem, s.valor_ref_referencia_origem))
      RETURNING s.*
    )
    INSERT INTO public.venda_sugestao_substituida
           (id, reprocesso_id, substituida_em, motivo, evento_id, plano_revisao, dia_referencia, fase,
            farmer_user_id, comprador_id, empresa, omie_codigo_produto, sugestao)
    SELECT sai.id, v_reproc, clock_timestamp(), p_motivo, p_evento_id, p_revisao, sai.dia_referencia, sai.fase,
           sai.farmer_user_id, sai.comprador_id, sai.empresa, sai.omie_codigo_produto, to_jsonb(sai)
      FROM sai;
    GET DIAGNOSTICS v_k = ROW_COUNT;
    v_sai := v_sai + v_k;
    PERFORM set_config('venda_sugestao_substituida.porta', '', true);

    INSERT INTO public.venda_sugestao
           (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto,
            qtd_ref, valor_ref, motivo_entrada, sucessao_origem, valor_ref_referencia_origem)
    SELECT 'recompra', v_fase, v_dia, n.farmer_user_id, n.comprador_id, n.empresa, n.omie_codigo_produto,
           n.qtd_ref, n.valor_ref, n.motivo_entrada, n.sucessao_origem, n.valor_ref_referencia_origem
      FROM jsonb_to_recordset(v_novo) AS n(farmer_user_id uuid, comprador_id uuid, empresa text,
             omie_codigo_produto bigint, qtd_ref numeric, valor_ref numeric, motivo_entrada text,
             sucessao_origem jsonb, valor_ref_referencia_origem boolean)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_k = ROW_COUNT;
    v_entra := v_entra + v_k;

    UPDATE public.venda_gerador_execucao e
       SET ultima_em = now(),
           linhas = (SELECT count(*) FROM public.venda_sugestao s
                      WHERE s.dia_referencia = v_dia AND s.fase = v_fase AND s.tipo = 'recompra')
     WHERE e.dia_referencia = v_dia AND e.fase = v_fase;
  END LOOP;

  RETURN jsonb_build_object('dia', v_dia, 'reprocesso_id', v_reproc, 'farmers', cardinality(v_farmers),
                            'substituidas', v_sai, 'novas', v_entra, 'preservadas', v_pres);
END
$function$;
REVOKE ALL ON FUNCTION private.venda_sugestoes_reprocessar_sucessao(uuid, integer, text) FROM PUBLIC, anon, authenticated;

-- ── 7. Publicar uma revisão do plano ─────────────────────────────────────────────────────────────────────────
-- p_regras: array de {empresa, omie_codigo_produto | familia, novo_documento}. A família é expandida nos itens
-- que a antiga comprou ANTES do corte (private.venda_linhas_pedido, factual) com aquela família no omie_products.
-- Item explícito e família no mesmo item: mesmo destino vale (o explícito fica), destino diferente é recusado.
-- Ordem: gate → forma → TRAVA (a do grafo da sucessão) → versão → evento → destinos → expansão → escrita →
-- reprocesso. Entrada malformada é 22023; recusa de domínio volta {ok:false, motivo}; sem gestor é 42501.
CREATE OR REPLACE FUNCTION public.cliente_sucessao_plano_publicar(
  p_evento_id uuid, p_revisao_esperada integer, p_regras jsonb, p_motivo text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_atual integer;
  v_rev integer;
  v_antigo uuid;
  v_corte date;
  v_el jsonb;
  v_i bigint;
  v_itens jsonb;
  v_conf jsonb;
  v_vazia text;
  v_fora text;
  v_n integer;
  v_reproc jsonb;
BEGIN
  IF NOT (COALESCE(public.pode_ver_carteira_completa(v_uid), false)) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only' USING ERRCODE = '42501';
  END IF;
  IF p_evento_id IS NULL OR p_revisao_esperada IS NULL OR p_revisao_esperada < 0
     OR p_regras IS NULL OR jsonb_typeof(p_regras) IS DISTINCT FROM 'array' OR jsonb_array_length(p_regras) = 0 THEN
    RAISE EXCEPTION 'cliente_sucessao_plano_publicar: evento, revisão esperada e regras (array não vazio)' USING ERRCODE = '22023';
  END IF;
  FOR v_el, v_i IN SELECT e.el, e.i FROM jsonb_array_elements(p_regras) WITH ORDINALITY AS e(el, i) LOOP
    IF jsonb_typeof(v_el) IS DISTINCT FROM 'object'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_el) k WHERE k NOT IN ('empresa', 'omie_codigo_produto', 'familia', 'novo_documento'))
       OR jsonb_typeof(v_el -> 'empresa') IS DISTINCT FROM 'string'
       OR (v_el ->> 'empresa') NOT IN ('oben', 'colacor', 'colacor_sc')
       OR jsonb_typeof(v_el -> 'novo_documento') IS DISTINCT FROM 'string'
       OR regexp_replace(upper(btrim(v_el ->> 'novo_documento')), '[^0-9A-Z]', '', 'g') !~ '^[0-9A-Z]{12}[0-9]{2}$'
       OR ((v_el ? 'omie_codigo_produto') = (v_el ? 'familia'))
       OR (v_el ? 'omie_codigo_produto' AND (jsonb_typeof(v_el -> 'omie_codigo_produto') IS DISTINCT FROM 'number'
             OR (v_el ->> 'omie_codigo_produto') !~ '^[1-9][0-9]{0,17}$'))
       OR (v_el ? 'familia' AND (jsonb_typeof(v_el -> 'familia') IS DISTINCT FROM 'string'
             OR length(btrim(v_el ->> 'familia')) = 0)) THEN
      RAISE EXCEPTION 'cliente_sucessao_plano_publicar: regra % malformada', v_i USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- A mesma trava do grafo da sucessão: o plano não cruza uma declaração/revogação em voo.
  PERFORM pg_advisory_xact_lock(hashtextextended('cliente_sucessoes:grafo', 0));
  SELECT COALESCE(max(r.revisao), 0) INTO v_atual
    FROM public.cliente_sucessao_plano_revisoes r WHERE r.evento_id = p_evento_id;
  IF v_atual IS DISTINCT FROM p_revisao_esperada THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'revisao_mudou', 'revisao', v_atual);
  END IF;

  SELECT ra.user_id, s.data_corte INTO v_antigo, v_corte
    FROM public.cliente_sucessoes s
   CROSS JOIN LATERAL private.cliente_resolver_documento(s.antigo_documento) ra
   WHERE s.evento_id = p_evento_id AND s.revogado_em IS NULL
   ORDER BY s.declarado_em, s.id
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'evento_sem_declaracao_ativa');
  END IF;
  IF v_antigo IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'antigo_nao_resolvido');
  END IF;

  SELECT string_agg(e.doc, ',' ORDER BY e.i) INTO v_fora
    FROM (SELECT x.i, regexp_replace(upper(btrim(x.el ->> 'novo_documento')), '[^0-9A-Z]', '', 'g') AS doc
            FROM jsonb_array_elements(p_regras) WITH ORDINALITY AS x(el, i)) e
   WHERE NOT EXISTS (SELECT 1 FROM public.cliente_sucessoes s
                      WHERE s.evento_id = p_evento_id AND s.revogado_em IS NULL AND s.novo_documento = e.doc);
  IF v_fora IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'destino_fora_do_evento', 'documentos', v_fora);
  END IF;

  WITH e AS (
    SELECT x.i, x.el ->> 'empresa' AS empresa,
           (x.el ->> 'omie_codigo_produto')::bigint AS codigo,
           btrim(x.el ->> 'familia') AS familia,
           regexp_replace(upper(btrim(x.el ->> 'novo_documento')), '[^0-9A-Z]', '', 'g') AS doc
      FROM jsonb_array_elements(p_regras) WITH ORDINALITY AS x(el, i)
  ),
  d AS (
    SELECT e.*, s.id AS destino_id
      FROM e JOIN public.cliente_sucessoes s
        ON s.evento_id = p_evento_id AND s.revogado_em IS NULL AND s.novo_documento = e.doc
  ),
  hist AS (
    SELECT DISTINCT l.empresa, l.omie_codigo_produto
      FROM private.venda_linhas_pedido(v_corte) l
     WHERE l.comprador_id = v_antigo
  ),
  fam AS (
    SELECT DISTINCT d.i, d.empresa, h.omie_codigo_produto AS codigo, d.familia, d.doc, d.destino_id
      FROM d
      JOIN hist h ON h.empresa = d.empresa
     WHERE d.familia IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.omie_products op
                    WHERE op.account = h.empresa AND op.omie_codigo_produto = h.omie_codigo_produto
                      AND btrim(op.familia) = d.familia)
  ),
  todos AS (
    SELECT d.empresa, d.codigo, d.doc, d.destino_id, 'item'::text AS origem, NULL::text AS familia
      FROM d WHERE d.codigo IS NOT NULL
    UNION ALL
    SELECT f.empresa, f.codigo, f.doc, f.destino_id, 'familia', f.familia FROM fam f
  )
  SELECT
    (SELECT jsonb_agg(jsonb_build_object('empresa', c.empresa, 'omie_codigo_produto', c.codigo)
                      ORDER BY c.empresa, c.codigo)
       FROM (SELECT t.empresa, t.codigo FROM todos t GROUP BY t.empresa, t.codigo
              HAVING count(DISTINCT t.destino_id) > 1) c),
    (SELECT string_agg(d.familia, ',' ORDER BY d.i) FROM d
      WHERE d.familia IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fam f WHERE f.i = d.i)),
    (SELECT jsonb_agg(to_jsonb(u))
       FROM (SELECT DISTINCT ON (t.empresa, t.codigo) t.empresa, t.codigo, t.doc, t.destino_id, t.origem, t.familia
               FROM todos t
              ORDER BY t.empresa, t.codigo, (t.origem = 'item') DESC, t.familia) u)
    INTO v_conf, v_vazia, v_itens;

  IF v_conf IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'regra_conflitante', 'itens', v_conf);
  END IF;
  IF v_vazia IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'familia_sem_itens', 'familias', v_vazia);
  END IF;

  v_rev := v_atual + 1;
  PERFORM set_config('cliente_sucessao_plano.porta', 'rpc', true);
  INSERT INTO public.cliente_sucessao_plano_revisoes (evento_id, revisao, revoga, motivo, publicado_por, publicado_em)
  VALUES (p_evento_id, v_rev, false, NULLIF(btrim(p_motivo), ''), v_uid, clock_timestamp());
  INSERT INTO public.cliente_sucessao_plano_regras
         (evento_id, revisao, empresa, omie_codigo_produto, destino_sucessao_id, novo_documento, origem, familia)
  SELECT p_evento_id, v_rev, u.empresa, u.codigo, u.destino_id, u.doc, u.origem, u.familia
    FROM jsonb_to_recordset(v_itens) AS u(empresa text, codigo bigint, doc text, destino_id uuid, origem text, familia text);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('cliente_sucessao_plano.porta', '', true);

  v_reproc := private.venda_sugestoes_reprocessar_sucessao(p_evento_id, v_rev, 'plano_publicado');
  RETURN jsonb_build_object('ok', true, 'revisao', v_rev, 'regras', v_n, 'sugestoes', v_reproc);
END
$function$;
REVOKE ALL ON FUNCTION public.cliente_sucessao_plano_publicar(uuid,integer,jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cliente_sucessao_plano_publicar(uuid,integer,jsonb,text) TO authenticated, service_role;
COMMENT ON FUNCTION public.cliente_sucessao_plano_publicar(uuid,integer,jsonb,text) IS
  'Gestor/master publica uma revisão NOVA (imutável) do plano de rateio do evento: item inteiro → declaração-destino '
  'do evento; família expandida nos itens da antiga antes do corte. Versão otimista; reprocessa a recompra de hoje.';

-- ── 8. Revogar o plano (uma revisão nova, `revoga`, sem regras) ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cliente_sucessao_plano_revogar(p_evento_id uuid, p_revisao_esperada integer, p_motivo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_atual integer;
  v_revoga boolean;
  v_rev integer;
  v_reproc jsonb;
BEGIN
  IF NOT (COALESCE(public.pode_ver_carteira_completa(v_uid), false)) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only' USING ERRCODE = '42501';
  END IF;
  IF p_evento_id IS NULL OR p_revisao_esperada IS NULL OR p_motivo IS NULL OR length(btrim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'cliente_sucessao_plano_revogar: evento, revisão esperada e motivo' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('cliente_sucessoes:grafo', 0));
  SELECT r.revisao, r.revoga INTO v_atual, v_revoga
    FROM public.cliente_sucessao_plano_revisoes r WHERE r.evento_id = p_evento_id
   ORDER BY r.revisao DESC LIMIT 1;
  IF COALESCE(v_atual, 0) IS DISTINCT FROM p_revisao_esperada THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'revisao_mudou', 'revisao', COALESCE(v_atual, 0));
  END IF;
  IF v_atual IS NULL OR v_revoga THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'sem_plano');
  END IF;

  v_rev := v_atual + 1;
  PERFORM set_config('cliente_sucessao_plano.porta', 'rpc', true);
  INSERT INTO public.cliente_sucessao_plano_revisoes (evento_id, revisao, revoga, motivo, publicado_por, publicado_em)
  VALUES (p_evento_id, v_rev, true, btrim(p_motivo), v_uid, clock_timestamp());
  PERFORM set_config('cliente_sucessao_plano.porta', '', true);

  v_reproc := private.venda_sugestoes_reprocessar_sucessao(p_evento_id, v_rev, 'plano_revogado');
  RETURN jsonb_build_object('ok', true, 'revisao', v_rev, 'sugestoes', v_reproc);
END
$function$;
REVOKE ALL ON FUNCTION public.cliente_sucessao_plano_revogar(uuid,integer,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cliente_sucessao_plano_revogar(uuid,integer,text) TO authenticated, service_role;
COMMENT ON FUNCTION public.cliente_sucessao_plano_revogar(uuid,integer,text) IS
  'Gestor/master revoga o plano de rateio do evento: revisão nova `revoga`, sem regras (o histórico fica). '
  'Todo item volta à antiga; reprocessa a recompra de hoje.';

-- ── 9. Ler o plano do evento (o painel do PR C) ──────────────────────────────────────────────────────────────
-- Gestor/master. Regras da revisão vigente (com o estado do destino em vigentes) + o histórico das revisões.
-- Só itens, documentos, nomes, datas e estado: nenhum valor monetário.
CREATE OR REPLACE FUNCTION public.cliente_sucessao_plano_do_evento(p_evento_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_atual integer;
  v_revoga boolean;
BEGIN
  IF NOT (COALESCE(public.pode_ver_carteira_completa(v_uid), false)) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only' USING ERRCODE = '42501';
  END IF;
  IF p_evento_id IS NULL THEN
    RAISE EXCEPTION 'cliente_sucessao_plano_do_evento: evento obrigatório' USING ERRCODE = '22023';
  END IF;
  SELECT r.revisao, r.revoga INTO v_atual, v_revoga
    FROM public.cliente_sucessao_plano_revisoes r WHERE r.evento_id = p_evento_id
   ORDER BY r.revisao DESC LIMIT 1;
  RETURN jsonb_build_object(
    'evento_id', p_evento_id,
    'revisao', COALESCE(v_atual, 0),
    'revogado', COALESCE(v_revoga, false),
    'regras', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'empresa', g.empresa, 'omie_codigo_produto', g.omie_codigo_produto,
               'descricao', (SELECT o.descricao FROM public.omie_products o
                              WHERE o.account = g.empresa AND o.omie_codigo_produto = g.omie_codigo_produto
                              ORDER BY o.descricao LIMIT 1),
               'novo_documento', g.novo_documento, 'destino_sucessao_id', g.destino_sucessao_id,
               'origem', g.origem, 'familia', g.familia,
               'destino_estado', COALESCE(v.estado, 'revogada'), 'destino_impedimento', v.impedimento)
             ORDER BY g.empresa, g.omie_codigo_produto)
        FROM public.cliente_sucessao_plano_regras g
        LEFT JOIN private.cliente_sucessoes_vigentes(v_hoje) v ON v.id = g.destino_sucessao_id
       WHERE g.evento_id = p_evento_id AND g.revisao = v_atual), '[]'::jsonb),
    'revisoes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'revisao', r.revisao, 'revoga', r.revoga, 'motivo', r.motivo,
               'publicado_por_nome', (SELECT p.name FROM public.profiles p WHERE p.user_id = r.publicado_por),
               'publicado_em', r.publicado_em,
               'regras', (SELECT count(*) FROM public.cliente_sucessao_plano_regras g
                           WHERE g.evento_id = r.evento_id AND g.revisao = r.revisao))
             ORDER BY r.revisao DESC)
        FROM public.cliente_sucessao_plano_revisoes r WHERE r.evento_id = p_evento_id), '[]'::jsonb));
END
$function$;
REVOKE ALL ON FUNCTION public.cliente_sucessao_plano_do_evento(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cliente_sucessao_plano_do_evento(uuid) TO authenticated, service_role;

-- ── PÓS: relê o catálogo; qualquer estado insuficiente aborta a transação inteira ───────────────────────────
DO $post$
DECLARE
  r record;
  v text;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('public.cliente_sucessao_plano_revisoes'), ('public.cliente_sucessao_plano_regras'),
                                 ('public.venda_sugestao_substituida')) AS x(t)
  LOOP
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = r.t::regclass)
       OR has_table_privilege('authenticated', r.t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
       OR has_table_privilege('anon', r.t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
       OR has_table_privilege('service_role', r.t, 'INSERT,UPDATE,DELETE,TRUNCATE') THEN
      RAISE EXCEPTION 'P1 FALHOU: % sem RLS ou aberta à escrita fora das RPCs', r.t;
    END IF;
    -- tgtype: 1 = ROW, 4 = INSERT, 8 = DELETE, 16 = UPDATE, 32 = TRUNCATE
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = r.t::regclass AND NOT t.tgisinternal
                      AND t.tgenabled = 'O' AND (t.tgtype::int & 29) = 29)
       OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = r.t::regclass AND NOT t.tgisinternal
                         AND t.tgenabled = 'O' AND (t.tgtype::int & 32) = 32) THEN
      RAISE EXCEPTION 'P2 FALHOU: % sem os triggers de imutabilidade (linha I/U/D + TRUNCATE)', r.t;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'venda_sugestao'
                    AND column_name = 'sucessao_origem')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'venda_sugestao'
                       AND column_name = 'valor_ref_referencia_origem' AND is_nullable = 'NO')
     OR (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.venda_sugestao'::regclass AND convalidated
           AND conname IN ('venda_sugestao_sucessao_origem_ck', 'venda_sugestao_ref_origem_ck')) <> 2 THEN
    RAISE EXCEPTION 'P3 FALHOU: marcação de origem em venda_sugestao ausente ou sem as constraints validadas';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.venda_gerar_lista(date,text)'))
       IS DISTINCT FROM 'b5320515336793a8f5d149288edd83a3'
     OR has_function_privilege('anon', 'public.venda_gerar_lista(date,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.venda_gerar_lista(date,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.venda_gerar_lista(date,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P4 FALHOU: venda_gerar_lista não é este corpo, ou o ACL mudou';
  END IF;
  FOR r IN SELECT * FROM (VALUES
      ('public.cliente_sucessao_plano_publicar(uuid,integer,jsonb,text)'),
      ('public.cliente_sucessao_plano_revogar(uuid,integer,text)'),
      ('public.cliente_sucessao_plano_do_evento(uuid)')) AS x(sig)
  LOOP
    SELECT p.prosrc INTO v FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig) AND p.prosecdef;
    IF v IS NULL OR strpos(v, 'IF NOT (COALESCE(public.pode_ver_carteira_completa(v_uid), false)) THEN') = 0 THEN
      RAISE EXCEPTION 'P5 FALHOU: % ausente, sem SECDEF ou sem o gate', r.sig;
    END IF;
    IF has_function_privilege('anon', r.sig, 'EXECUTE') OR has_function_privilege('public', r.sig, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'P6 FALHOU: ACL de % (anon/PUBLIC fechados, authenticated aberto)', r.sig;
    END IF;
  END LOOP;
  FOR r IN SELECT * FROM (VALUES ('private.historico_consumo_efetivo(date)'), ('private.historico_compradores_encerrados(date)'),
                                  ('private.venda_recompra_efetiva_em(date)'), ('private.venda_situacao_efetiva_em(date)'),
                                  ('private.venda_lista_calc_efetiva(date)'),
                                  ('private.venda_sugestoes_reprocessar_sucessao(uuid,integer,text)'),
                                  ('private.cliente_sucessao_plano_imutavel()'),
                                  ('private.venda_sugestao_substituida_imutavel()')) AS x(sig)
  LOOP
    IF to_regprocedure(r.sig) IS NULL
       OR has_function_privilege('anon', r.sig, 'EXECUTE') OR has_function_privilege('authenticated', r.sig, 'EXECUTE')
       OR has_function_privilege('public', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'P7 FALHOU: % ausente ou aberto ao JWT', r.sig;
    END IF;
  END LOOP;
  -- Os factuais NÃO mudaram (a herança entra só pela trilha efetiva).
  FOR r IN SELECT * FROM (VALUES
      ('private.venda_linhas_pedido(date)', 'a7ff6d1c894aea2e16483b5084a097a1'),
      ('public.venda_recompra_em(date)', '2b43b81254a7c13c019c65fae41ea90a'),
      ('public.venda_situacao_em(date)', 'e96cf9c931a13b209bb3017b8c4743ac'),
      ('private.venda_lista_calc(date)', 'cd7a7184e4b07d3665b1c39f70a3ac59')) AS x(sig, m)
  LOOP
    IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig)) IS DISTINCT FROM r.m THEN
      RAISE EXCEPTION 'P8 FALHOU: o factual % mudou', r.sig;
    END IF;
  END LOOP;
  RAISE NOTICE 'cliente_sucessao_plano: 3 tabelas + marcação + trilha efetiva + gerador + reprocesso + 3 RPCs OK';
END
$post$;
