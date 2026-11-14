-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Venda R2 · Entrega 4 — "falta completar o sistema": o founder confirma pares tinta/verniz → catalisador/diluente,
-- e só os pares CONFIRMADOS viram sugestão (tipo 'sistema' em venda_sugestao), com desfecho medido como os outros.
-- Spec base: docs/superpowers/specs/2026-10-20-venda-por-cliente-design.md · Registro: docs/historico/venda-sistema-completo.md
--
-- Por que tabela DEDICADA e não kb_catalisador_links: aquela tabela tem OUTRO escritor (RPC
-- confirmar_catalisador_vinculo, módulo KB congelado até 10/01/2027) e outra semântica (código de catalisador CITADO
-- no boletim ↔ SKU do catalisador, um SKU por código). Aqui a chave é (empresa, SKU-base, SKU-par) e o escritor da
-- decisão é único: venda_sistema_decidir (master). A fila só INSERE o candidato que mostrou (status 'pendente').
--
-- Compatibilidade técnica, nunca coocorrência: a coocorrência no mesmo pedido (12m) só ORDENA a fila de candidatos;
-- nada vira sugestão sem o 'confirmado' do founder, e rejeitar depois desliga NA HORA (a ficha e o e-mail só mostram
-- par ainda confirmado; o fechamento fecha a sugestão aberta como nao_medivel/par_revogado).
--
-- Recria 4 funções VIVAS a partir dos corpos de prod (md5 medidos via psql-ro em 13/11/2026), molde TRAVA→PRE→CREATE→PÓS:
--  public.venda_gerar_lista          (3b93a5e8…) — bloco 'sistema' depois do preço (só lista ATIVA de hoje, onda_sistema)
--  public.venda_fechar_desfechos     (6c962e84…) — janela 'sistema'; casa o par sugerido OU outro par confirmado do mesmo
--                                                  sistema; par revogado → nao_medivel/par_revogado; medido como recompra
--                                                  (intenção de tratar: o braço controle é o contrafactual)
--  private._venda_sugestoes_json     (ccc8189a…) — ondas.sistema + bloco 'sistema' na sugestão + par revogado some
--  private.venda_resumo_bloco        (143dc394…) — linha "Falta completar o sistema" no e-mail + ids no item
-- Aplicar: `bun run db:aplicar` (sem BEGIN/COMMIT — a transação é do executor). Prova: db/test-venda-sistema.sh.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════

-- ── TRAVA: prende as 4 vivas antes de ler (outra sessão não recria no meio) ───────────────────────────────
DO $trava$
BEGIN
  IF to_regprocedure('public.venda_gerar_lista(date,text)') IS NOT NULL THEN
    ALTER FUNCTION public.venda_gerar_lista(date, text) VOLATILE;
  END IF;
  IF to_regprocedure('public.venda_fechar_desfechos(date)') IS NOT NULL THEN
    ALTER FUNCTION public.venda_fechar_desfechos(date) VOLATILE;
  END IF;
  IF to_regprocedure('private._venda_sugestoes_json(uuid,date)') IS NOT NULL THEN
    ALTER FUNCTION private._venda_sugestoes_json(uuid, date) STABLE;
  END IF;
  IF to_regprocedure('private.venda_resumo_bloco(uuid,date,uuid,integer,text,numeric,text)') IS NOT NULL THEN
    ALTER FUNCTION private.venda_resumo_bloco(uuid, date, uuid, integer, text, numeric, text) STABLE;
  END IF;
END
$trava$;

-- ── PRE: cada corpo vivo é o medido em prod (13/11) ou já é este ─────────────────────────────────────────
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(x.alvo)) AS vivo,
           x.predecessor, x.este
      FROM (VALUES
        ('public.venda_gerar_lista(date,text)',      '3b93a5e827ebc78af6dd325c5b5b0c7f', 'fa710709f8a598258460f2971d2ec2fe'),
        ('public.venda_fechar_desfechos(date)',      '6c962e84f9b821d5612b555e10489616', '18b1768290af7e0ce66601cc389b37da'),
        ('private._venda_sugestoes_json(uuid,date)', 'ccc8189a3d2962e073a3d360581efb61', 'd2ead2156bf76b6047a591e156148e64'),
        ('private.venda_resumo_bloco(uuid,date,uuid,integer,text,numeric,text)',
                                                     '143dc394cd9a2a079c50127da243f1ae', '3b2c0dd39af68a0a50e4320cb48f6ebb')
      ) AS x(alvo, predecessor, este)
  LOOP
    IF r.vivo IS NULL OR r.vivo NOT IN (r.predecessor, r.este) THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) nao e o medido em prod nem este', r.alvo, r.vivo;
    END IF;
  END LOOP;
END
$pre$;

-- ── 1. Configuração (o founder ajusta sem migration) ────────────────────────────────────────────────────
INSERT INTO public.venda_config (chave, valor) VALUES
  ('onda_sistema', 'true'::jsonb),
  ('sistema_regras', '{"base_dias":30,"par_dias":90,"max_por_comprador":2,"fila_por_empresa":30,"fila_por_base_papel":2,"fila_min_juntos":3,"fila_min_share":0.05}'::jsonb),
  ('sistema_familias', '{"base":["Vernizes PU","Fundos PU","Primer PU","Laca PU","Laca Fundo Acabamento","Verniz Acrílico","Fundo Acrílico","Fundo Acabamento Acrílico","Seladora Nitrocelulose","Primer Nitrocelulose","Laca Nitro","Laca Vidro","Tinta Mordente"],"catalisador":["Catalisadores PU"],"diluente":["Diluente PU","Thinner Nitrocelulose","Retardador PU"]}'::jsonb)
ON CONFLICT (chave) DO NOTHING;

UPDATE public.venda_config
   SET valor = valor || '{"sistema":30}'::jsonb, atualizado_em = now()
 WHERE chave = 'janela_dias' AND NOT (valor ? 'sistema');

-- ── 2. O par e a trilha de decisões ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.venda_sistema_par (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa       text NOT NULL CHECK (empresa IN ('oben','colacor')),
  base_codigo   bigint NOT NULL,                       -- SKU tinta/verniz (omie_codigo_produto)
  par_codigo    bigint NOT NULL,                       -- SKU catalisador/diluente
  papel         text NOT NULL CHECK (papel IN ('catalisador','diluente')),
  status        text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','confirmado','rejeitado','nao_sei')),
  mostrado_em   timestamptz NOT NULL DEFAULT now(),    -- 1ª vez na fila = denominador do sensor
  evidencia     jsonb NOT NULL,                        -- coocorrência quando entrou na fila (só candidato)
  decidido_por  uuid,
  decidido_em   timestamptz,
  CONSTRAINT venda_sistema_par_distintos_ck CHECK (base_codigo <> par_codigo),
  CONSTRAINT venda_sistema_par_decisao_ck CHECK ((status = 'pendente') = (decidido_em IS NULL)
                                                 AND (decidido_em IS NULL) = (decidido_por IS NULL)),
  CONSTRAINT venda_sistema_par_uq UNIQUE (empresa, base_codigo, par_codigo)
);
CREATE INDEX IF NOT EXISTS idx_venda_sistema_par_confirmado ON public.venda_sistema_par (empresa, base_codigo, papel)
  WHERE status = 'confirmado';

CREATE TABLE IF NOT EXISTS public.venda_sistema_par_decisao (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  par_id       bigint NOT NULL REFERENCES public.venda_sistema_par(id),
  status       text NOT NULL CHECK (status IN ('confirmado','rejeitado','nao_sei')),
  decidido_por uuid NOT NULL,
  decidido_em  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_venda_sistema_par_decisao_par ON public.venda_sistema_par_decisao (par_id);

CREATE OR REPLACE FUNCTION private.venda_sistema_decisao_imutavel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'VENDA_SISTEMA_DECISAO_IMUTAVEL: a trilha de decisoes e append-only' USING ERRCODE = '55000';
END
$function$;
REVOKE ALL ON FUNCTION private.venda_sistema_decisao_imutavel() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS venda_sistema_par_decisao_imutavel ON public.venda_sistema_par_decisao;
CREATE TRIGGER venda_sistema_par_decisao_imutavel BEFORE UPDATE OR DELETE ON public.venda_sistema_par_decisao
  FOR EACH ROW EXECUTE FUNCTION private.venda_sistema_decisao_imutavel();
DROP TRIGGER IF EXISTS venda_sistema_par_decisao_imutavel_trunc ON public.venda_sistema_par_decisao;
CREATE TRIGGER venda_sistema_par_decisao_imutavel_trunc BEFORE TRUNCATE ON public.venda_sistema_par_decisao
  FOR EACH STATEMENT EXECUTE FUNCTION private.venda_sistema_decisao_imutavel();

ALTER TABLE public.venda_sistema_par ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.venda_sistema_par_decisao ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.venda_sistema_par, public.venda_sistema_par_decisao FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.venda_sistema_par, public.venda_sistema_par_decisao TO authenticated;
GRANT ALL ON public.venda_sistema_par, public.venda_sistema_par_decisao TO service_role;
DROP POLICY IF EXISTS venda_sistema_par_select_master ON public.venda_sistema_par;
CREATE POLICY venda_sistema_par_select_master ON public.venda_sistema_par FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'master'::public.app_role));
DROP POLICY IF EXISTS venda_sistema_par_decisao_select_master ON public.venda_sistema_par_decisao;
CREATE POLICY venda_sistema_par_decisao_select_master ON public.venda_sistema_par_decisao FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'master'::public.app_role));

-- ── 3. venda_sugestao aceita o tipo 'sistema' (alvo = SKU do par; par_id obrigatório) ───────────────────
-- Os CHECKs são recriados MAIS LARGOS na mesma transação (nenhuma linha existente deixa de passar).
ALTER TABLE public.venda_sugestao ADD COLUMN IF NOT EXISTS sistema_par_id bigint REFERENCES public.venda_sistema_par(id);

ALTER TABLE public.venda_sugestao DROP CONSTRAINT IF EXISTS venda_sugestao_tipo_check;
ALTER TABLE public.venda_sugestao ADD CONSTRAINT venda_sugestao_tipo_check
  CHECK (tipo IN ('recompra','complemento','preco','sistema'));
ALTER TABLE public.venda_sugestao DROP CONSTRAINT IF EXISTS venda_sugestao_alvo_ck;
ALTER TABLE public.venda_sugestao ADD CONSTRAINT venda_sugestao_alvo_ck CHECK (
  (tipo IN ('recompra','preco','sistema') AND omie_codigo_produto IS NOT NULL)
  OR (tipo = 'complemento' AND familia IS NOT NULL));
ALTER TABLE public.venda_sugestao DROP CONSTRAINT IF EXISTS venda_sugestao_sistema_ck;
ALTER TABLE public.venda_sugestao ADD CONSTRAINT venda_sugestao_sistema_ck
  CHECK ((tipo = 'sistema') = (sistema_par_id IS NOT NULL));

-- ── 4. Helpers privados ──────────────────────────────────────────────────────────────────────────────────
-- O texto CITA o código? Fronteira dos dois lados: 'DF.4068' não casa 'DFA.4068' nem 'DF.40681' (o sufixo de
-- embalagem 'LT'/'QT'/'.RAL5' pode vir colado). Código curto (< 4) nunca cita. NULL → false.
CREATE OR REPLACE FUNCTION private.venda_sistema_cita(p_texto text, p_codigo text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(length(btrim(p_codigo)) >= 4
                  AND upper(p_texto) ~ ('(^|[^A-Z0-9])'
                                        || regexp_replace(upper(btrim(p_codigo)), '([^A-Z0-9])', '\\\1', 'g')
                                        || '([^0-9]|$)'), false)
$function$;

-- Candidatos da fila: coocorrência no MESMO pedido (12m, universo de venda de universo-pedidos.ts) entre SKU de
-- família-base e SKU de família catalisador/diluente. Só CANDIDATO: corta ruído (≥ min_juntos pedidos e ≥ min_share
-- dos pedidos da base), no máx. N por base×papel, ignora o já decidido (confirmado/rejeitado), 'nao_sei' por último,
-- ordena pelo volume da base (R$ bruto 12m) — o eixo da decisão: onde está a venda que o sistema completa.
CREATE OR REPLACE FUNCTION private.venda_sistema_candidatos(p_empresa text, p_hoje date)
RETURNS TABLE (empresa text, base_codigo bigint, par_codigo bigint, papel text, juntos integer,
               pedidos_base integer, valor_base numeric, share numeric)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $function$
  WITH fam AS (
    SELECT ARRAY(SELECT jsonb_array_elements_text(c.valor -> 'base'))        AS base,
           ARRAY(SELECT jsonb_array_elements_text(c.valor -> 'catalisador')) AS cat,
           ARRAY(SELECT jsonb_array_elements_text(c.valor -> 'diluente'))    AS dil
      FROM public.venda_config c WHERE c.chave = 'sistema_familias'
  ),
  reg AS (
    SELECT (c.valor ->> 'fila_min_juntos')::int AS min_juntos, (c.valor ->> 'fila_min_share')::numeric AS min_share,
           (c.valor ->> 'fila_por_base_papel')::int AS por_bp, (c.valor ->> 'fila_por_empresa')::int AS teto
      FROM public.venda_config c WHERE c.chave = 'sistema_regras'
  ),
  it AS (
    SELECT so.id AS so_id, oi.omie_codigo_produto AS cod, op.familia, oi.quantity * oi.unit_price AS valor
      FROM public.sales_orders so
      JOIN public.order_items oi ON oi.sales_order_id = so.id
      JOIN LATERAL (SELECT o.familia FROM public.omie_products o
                     WHERE o.omie_codigo_produto = oi.omie_codigo_produto AND o.account = so.account
                     LIMIT 1) op ON true
     WHERE so.account = p_empresa
       AND so.deleted_at IS NULL
       AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
       AND COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= p_hoje - 365
       AND COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) <  p_hoje
  ),
  base AS (SELECT it.* FROM it, fam WHERE it.familia = ANY (fam.base)),
  par AS (
    SELECT it.so_id, it.cod, CASE WHEN it.familia = ANY (fam.cat) THEN 'catalisador' ELSE 'diluente' END AS papel
      FROM it, fam WHERE it.familia = ANY (fam.cat) OR it.familia = ANY (fam.dil)
  ),
  bvol AS (SELECT b.cod, count(DISTINCT b.so_id) AS ped, sum(b.valor) AS vol FROM base b GROUP BY b.cod),
  pp AS (
    SELECT b.cod AS base_cod, p.cod AS par_cod, p.papel, count(DISTINCT b.so_id) AS juntos
      FROM base b JOIN par p ON p.so_id = b.so_id AND p.cod <> b.cod
     GROUP BY b.cod, p.cod, p.papel
  ),
  cand AS (
    SELECT pp.*, bv.ped, bv.vol, pp.juntos::numeric / bv.ped AS share,
           row_number() OVER (PARTITION BY pp.base_cod, pp.papel ORDER BY pp.juntos DESC, pp.par_cod) AS rn_bp
      FROM pp
      JOIN bvol bv ON bv.cod = pp.base_cod
      CROSS JOIN reg
     WHERE pp.juntos >= reg.min_juntos
       AND pp.juntos::numeric / bv.ped >= reg.min_share
       AND NOT EXISTS (SELECT 1 FROM public.venda_sistema_par v
                        WHERE v.empresa = p_empresa AND v.base_codigo = pp.base_cod AND v.par_codigo = pp.par_cod
                          AND v.status IN ('confirmado','rejeitado'))
  )
  SELECT p_empresa, c.base_cod, c.par_cod, c.papel, c.juntos::int, c.ped::int, c.vol, round(c.share, 4)
    FROM cand c
    CROSS JOIN reg
    LEFT JOIN public.venda_sistema_par v
           ON v.empresa = p_empresa AND v.base_codigo = c.base_cod AND v.par_codigo = c.par_cod
   WHERE c.rn_bp <= reg.por_bp
   ORDER BY COALESCE(v.status = 'nao_sei', false), c.vol DESC NULLS LAST, c.ped DESC, c.base_cod, c.papel,
            c.juntos DESC, c.par_cod
   LIMIT (SELECT reg.teto FROM reg)
$function$;

-- O que o boletim diz (dica ao founder, NUNCA decisão): spec aprovada cujo código a descrição da base CITA. Mais de
-- uma spec citada = 'ambiguo' (ambiguidade ⇒ nenhuma ficha, docs/agent/knowledge-base.md). Sem spec = NULL.
CREATE OR REPLACE FUNCTION private.venda_sistema_boletim(p_empresa text, p_base bigint, p_par bigint, p_papel text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $function$
  WITH b AS (
    SELECT (SELECT o.descricao FROM public.omie_products o
             WHERE o.account = p_empresa AND o.omie_codigo_produto = p_base LIMIT 1) AS descricao
  ),
  p AS (
    SELECT (SELECT o.descricao FROM public.omie_products o
             WHERE o.account = p_empresa AND o.omie_codigo_produto = p_par LIMIT 1) AS descricao
  ),
  s AS (
    SELECT k.product_code, k.product_name, k.catalisador_proporcao_pct,
           CASE p_papel WHEN 'catalisador' THEN k.catalisador_codigo ELSE k.diluente_codigo END AS citado
      FROM public.kb_product_specs k, b
     WHERE k.approved_at IS NOT NULL AND k.product_code IS NOT NULL
       AND private.venda_sistema_cita(b.descricao, k.product_code)
  )
  SELECT CASE
           WHEN (SELECT count(*) FROM s) = 0 THEN NULL
           WHEN (SELECT count(*) FROM s) > 1 THEN jsonb_build_object('situacao', 'ambiguo', 'boletins', (SELECT count(*) FROM s))
           ELSE (SELECT jsonb_build_object(
                          'situacao', CASE WHEN NULLIF(btrim(s.citado), '') IS NULL THEN 'nao_cita'
                                           WHEN private.venda_sistema_cita(p.descricao, s.citado) THEN 'confere'
                                           ELSE 'outro' END,
                          'boletim', s.product_name, 'codigo_boletim', s.product_code,
                          'codigo_citado', NULLIF(btrim(s.citado), ''),
                          'proporcao_pct', CASE WHEN p_papel = 'catalisador' THEN s.catalisador_proporcao_pct END)
                   FROM s, p)
         END
$function$;

-- Quem entra hoje: comprador da lista ATIVA de hoje (a ligação já vai acontecer) que comprou a base nos últimos
-- base_dias e NÃO comprou nenhum par confirmado daquele sistema (base×papel) nos últimos par_dias. Sugere o par
-- confirmado de maior evidência; no máx. max_por_comprador por dia; nunca repete o mesmo par ao mesmo comprador
-- dentro da janela de desfecho (a sugestão anterior ainda está sendo medida).
CREATE OR REPLACE FUNCTION private.venda_lista_sistema(p_dia date)
RETURNS TABLE (farmer_user_id uuid, comprador_id uuid, empresa text, omie_codigo_produto bigint,
               sistema_par_id bigint, motivo_entrada text)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $function$
  WITH reg AS (
    SELECT (c.valor ->> 'base_dias')::int AS base_dias, (c.valor ->> 'par_dias')::int AS par_dias,
           (c.valor ->> 'max_por_comprador')::int AS mx
      FROM public.venda_config c WHERE c.chave = 'sistema_regras'
  ),
  jan AS (SELECT (c.valor ->> 'sistema')::int AS dias FROM public.venda_config c WHERE c.chave = 'janela_dias'),
  lista AS (
    SELECT DISTINCT s.farmer_user_id, s.comprador_id
      FROM public.venda_sugestao s
     WHERE s.dia_referencia = p_dia AND s.fase = 'ativa' AND s.tipo = 'recompra'
  ),
  conf AS (SELECT v.* FROM public.venda_sistema_par v WHERE v.status = 'confirmado'),
  compra AS (
    SELECT COALESCE(ca.canonical_user_id, so.customer_user_id) AS comprador, so.account AS empresa,
           oi.omie_codigo_produto AS cod,
           COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) AS data_pedido,
           oi.quantity * oi.unit_price AS valor
      FROM public.sales_orders so
      JOIN public.order_items oi ON oi.sales_order_id = so.id
      LEFT JOIN public.customer_canonical_alias ca
             ON ca.alias_user_id = so.customer_user_id AND ca.status = 'active'
      CROSS JOIN reg
     WHERE so.deleted_at IS NULL
       AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
       AND COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date)
             >= p_dia - greatest(reg.base_dias, reg.par_dias)
       AND COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) < p_dia
       AND COALESCE(ca.canonical_user_id, so.customer_user_id) IN (SELECT l.comprador_id FROM lista l)
  ),
  base_comprada AS (
    SELECT c.comprador, c.empresa, s.base_codigo, s.papel, sum(c.valor) AS valor_base
      FROM compra c
      JOIN (SELECT DISTINCT v.empresa, v.base_codigo, v.papel FROM conf v) s
        ON s.empresa = c.empresa AND s.base_codigo = c.cod
      CROSS JOIN reg
     WHERE c.data_pedido >= p_dia - reg.base_dias
     GROUP BY c.comprador, c.empresa, s.base_codigo, s.papel
  ),
  falta AS (
    SELECT b.* FROM base_comprada b, reg
     WHERE NOT EXISTS (
       SELECT 1 FROM compra c
         JOIN conf v ON v.empresa = c.empresa AND v.par_codigo = c.cod
        WHERE c.comprador = b.comprador AND c.empresa = b.empresa
          AND v.base_codigo = b.base_codigo AND v.papel = b.papel
          AND c.data_pedido >= p_dia - reg.par_dias)
  ),
  escolha AS (
    SELECT DISTINCT ON (f.comprador, f.empresa, f.base_codigo, f.papel)
           f.comprador, f.empresa, f.base_codigo, f.papel, f.valor_base, v.id AS par_id, v.par_codigo
      FROM falta f
      JOIN conf v ON v.empresa = f.empresa AND v.base_codigo = f.base_codigo AND v.papel = f.papel
     ORDER BY f.comprador, f.empresa, f.base_codigo, f.papel,
              CASE WHEN jsonb_typeof(v.evidencia -> 'juntos') = 'number' THEN (v.evidencia ->> 'juntos')::numeric END
                DESC NULLS LAST, v.id
  ),
  fresca AS (
    SELECT e.* FROM escolha e, jan
     WHERE NOT EXISTS (SELECT 1 FROM public.venda_sugestao s
                        WHERE s.tipo = 'sistema' AND s.fase = 'ativa' AND s.comprador_id = e.comprador
                          AND s.empresa = e.empresa AND s.omie_codigo_produto = e.par_codigo
                          AND s.dia_referencia < p_dia AND s.dia_referencia > p_dia - jan.dias)
  ),
  ranq AS (
    SELECT f.*, row_number() OVER (PARTITION BY f.comprador
                                   ORDER BY f.valor_base DESC NULLS LAST, f.base_codigo, f.papel) AS rn
      FROM fresca f
  )
  SELECT l.farmer_user_id, r.comprador, r.empresa, r.par_codigo, r.par_id,
         'comprou ' || COALESCE((SELECT o.descricao FROM public.omie_products o
                                  WHERE o.account = r.empresa AND o.omie_codigo_produto = r.base_codigo LIMIT 1),
                                'SKU ' || r.base_codigo)
         || ' sem o ' || r.papel
    FROM ranq r
    JOIN lista l ON l.comprador_id = r.comprador
    CROSS JOIN reg
   WHERE r.rn <= reg.mx
$function$;

REVOKE ALL ON FUNCTION private.venda_sistema_cita(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.venda_sistema_candidatos(text, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.venda_sistema_boletim(text, bigint, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.venda_lista_sistema(date) FROM PUBLIC, anon, authenticated;

-- ── 5. RPCs do founder ───────────────────────────────────────────────────────────────────────────────────
-- A fila: registra (1ª vez) os candidatos que MOSTRA — é o denominador do sensor — e devolve candidatos + decididos.
CREATE OR REPLACE FUNCTION public.venda_sistema_fila(p_empresa text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_cand jsonb;
  v_dec  jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'master'::public.app_role) THEN
    RAISE EXCEPTION 'venda_sistema_fila: requer master' USING ERRCODE = '42501';
  END IF;
  IF p_empresa IS NULL OR p_empresa NOT IN ('oben','colacor') THEN
    RAISE EXCEPTION 'venda_sistema_fila: empresa invalida' USING ERRCODE = '22023';
  END IF;

  WITH x AS (
    SELECT c.* FROM private.venda_sistema_candidatos(p_empresa, v_hoje)
           WITH ORDINALITY AS c(empresa, base_codigo, par_codigo, papel, juntos, pedidos_base, valor_base, share, ordem)
  ),
  ins AS (
    INSERT INTO public.venda_sistema_par (empresa, base_codigo, par_codigo, papel, evidencia)
    SELECT x.empresa, x.base_codigo, x.par_codigo, x.papel,
           jsonb_build_object('juntos', x.juntos, 'pedidos_base', x.pedidos_base, 'valor_base_12m', x.valor_base,
                              'share', x.share, 'medido_em', v_hoje)
      FROM x
    ON CONFLICT (empresa, base_codigo, par_codigo) DO NOTHING
    RETURNING id, empresa, base_codigo, par_codigo, status
  ),
  par AS (
    -- o par recém-inserido (ins) ou o que já estava lá (pendente/nao_sei de outra leitura)
    SELECT i.id, i.empresa, i.base_codigo, i.par_codigo, i.status FROM ins i
    UNION ALL
    SELECT v.id, v.empresa, v.base_codigo, v.par_codigo, v.status FROM public.venda_sistema_par v
     WHERE v.empresa = p_empresa
       AND NOT EXISTS (SELECT 1 FROM ins i WHERE i.id = v.id)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', v.id, 'status', v.status, 'papel', x.papel,
           'base', jsonb_build_object('omie_codigo_produto', x.base_codigo, 'descricao', ob.descricao, 'familia', ob.familia,
                                      'pedidos_12m', x.pedidos_base, 'valor_12m', x.valor_base),
           'par', jsonb_build_object('omie_codigo_produto', x.par_codigo, 'descricao', opr.descricao, 'familia', opr.familia),
           'juntos', x.juntos, 'share', x.share,
           'boletim', private.venda_sistema_boletim(p_empresa, x.base_codigo, x.par_codigo, x.papel))
           ORDER BY x.ordem), '[]'::jsonb)
    INTO v_cand
    FROM x
    JOIN par v ON v.empresa = x.empresa AND v.base_codigo = x.base_codigo AND v.par_codigo = x.par_codigo
    LEFT JOIN LATERAL (SELECT o.descricao, o.familia FROM public.omie_products o
                        WHERE o.account = p_empresa AND o.omie_codigo_produto = x.base_codigo LIMIT 1) ob ON true
    LEFT JOIN LATERAL (SELECT o.descricao, o.familia FROM public.omie_products o
                        WHERE o.account = p_empresa AND o.omie_codigo_produto = x.par_codigo LIMIT 1) opr ON true;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', v.id, 'status', v.status, 'papel', v.papel, 'decidido_em', v.decidido_em,
           'base', jsonb_build_object('omie_codigo_produto', v.base_codigo, 'descricao', ob.descricao),
           'par', jsonb_build_object('omie_codigo_produto', v.par_codigo, 'descricao', opr.descricao))
           ORDER BY v.status, v.decidido_em DESC, v.id), '[]'::jsonb)
    INTO v_dec
    FROM public.venda_sistema_par v
    LEFT JOIN LATERAL (SELECT o.descricao FROM public.omie_products o
                        WHERE o.account = v.empresa AND o.omie_codigo_produto = v.base_codigo LIMIT 1) ob ON true
    LEFT JOIN LATERAL (SELECT o.descricao FROM public.omie_products o
                        WHERE o.account = v.empresa AND o.omie_codigo_produto = v.par_codigo LIMIT 1) opr ON true
   WHERE v.empresa = p_empresa AND v.status IN ('confirmado','rejeitado');

  RETURN jsonb_build_object('empresa', p_empresa, 'medido_em', v_hoje, 'candidatos', v_cand, 'decididos', v_dec);
END
$function$;

-- O ÚNICO escritor da decisão. Rejeitar um par confirmado desliga na hora: o gerador só lê 'confirmado', a ficha e
-- o e-mail só mostram par confirmado, e o fechamento fecha a sugestão aberta como nao_medivel/par_revogado.
CREATE OR REPLACE FUNCTION public.venda_sistema_decidir(p_par_id bigint, p_status text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_id  bigint;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'master'::public.app_role) THEN
    RAISE EXCEPTION 'venda_sistema_decidir: requer master' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('confirmado','rejeitado','nao_sei') THEN
    RAISE EXCEPTION 'venda_sistema_decidir: status invalido' USING ERRCODE = '22023';
  END IF;
  UPDATE public.venda_sistema_par
     SET status = p_status, decidido_por = v_uid, decidido_em = now()
   WHERE id = p_par_id
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'venda_sistema_decidir: par % inexistente', p_par_id USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.venda_sistema_par_decisao (par_id, status, decidido_por) VALUES (v_id, p_status, v_uid);
  RETURN jsonb_build_object('id', v_id, 'status', p_status);
END
$function$;

-- Sensor (master): (1) confirmados ÷ candidatos mostrados; (2) sistemas completos ÷ pedidos elegíveis — pedido com a
-- base de um sistema confirmado (HOJE) é elegível por base×papel; completo se o MESMO pedido leva um par confirmado
-- daquele sistema; por braço do comprador; (3) desfecho das sugestões 'sistema' por braço (intenção de tratar).
CREATE OR REPLACE FUNCTION public.venda_sistema_sensor(p_de date, p_ate date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_fila jsonb;
  v_ped  jsonb;
  v_sug  jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'master'::public.app_role) THEN
    RAISE EXCEPTION 'venda_sistema_sensor: requer master' USING ERRCODE = '42501';
  END IF;
  IF p_de IS NULL OR p_ate IS NULL OR p_de > p_ate OR p_ate - p_de > 400 THEN
    RAISE EXCEPTION 'venda_sistema_sensor: periodo invalido' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'empresa', f.empresa, 'mostrados', f.mostrados, 'confirmados', f.confirmados, 'rejeitados', f.rejeitados,
           'nao_sei', f.nao_sei, 'pendentes', f.pendentes,
           'taxa_confirmacao', CASE WHEN f.mostrados > 0 THEN round(f.confirmados::numeric / f.mostrados, 4) END)
           ORDER BY f.empresa), '[]'::jsonb)
    INTO v_fila
    FROM (SELECT v.empresa, count(*) AS mostrados,
                 count(*) FILTER (WHERE v.status = 'confirmado') AS confirmados,
                 count(*) FILTER (WHERE v.status = 'rejeitado')  AS rejeitados,
                 count(*) FILTER (WHERE v.status = 'nao_sei')    AS nao_sei,
                 count(*) FILTER (WHERE v.status = 'pendente')   AS pendentes
            FROM public.venda_sistema_par v GROUP BY v.empresa) f;

  WITH conf AS (SELECT v.* FROM public.venda_sistema_par v WHERE v.status = 'confirmado'),
  pedido AS (
    SELECT so.id, so.account, COALESCE(ca.canonical_user_id, so.customer_user_id) AS comprador
      FROM public.sales_orders so
      LEFT JOIN public.customer_canonical_alias ca
             ON ca.alias_user_id = so.customer_user_id AND ca.status = 'active'
     WHERE so.deleted_at IS NULL
       AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
       AND COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) BETWEEN p_de AND p_ate
  ),
  elegivel AS (
    SELECT DISTINCT p.id, p.account, p.comprador, s.base_codigo, s.papel
      FROM pedido p
      JOIN public.order_items oi ON oi.sales_order_id = p.id
      JOIN (SELECT DISTINCT c.empresa, c.base_codigo, c.papel FROM conf c) s
        ON s.empresa = p.account AND s.base_codigo = oi.omie_codigo_produto
  ),
  medido AS (
    SELECT e.*, COALESCE(b.braco, 'sem_braco') AS braco,
           EXISTS (SELECT 1 FROM public.order_items oi
                     JOIN conf c ON c.empresa = e.account AND c.base_codigo = e.base_codigo AND c.papel = e.papel
                                AND c.par_codigo = oi.omie_codigo_produto
                    WHERE oi.sales_order_id = e.id) AS completo
      FROM elegivel e
      LEFT JOIN public.venda_braco_comprador b ON b.comprador_id = e.comprador
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'braco', m.braco, 'elegiveis', m.elegiveis, 'completos', m.completos,
           'taxa', CASE WHEN m.elegiveis > 0 THEN round(m.completos::numeric / m.elegiveis, 4) END)
           ORDER BY m.braco), '[]'::jsonb)
    INTO v_ped
    FROM (SELECT md.braco, count(*) AS elegiveis, count(*) FILTER (WHERE md.completo) AS completos
            FROM medido md GROUP BY md.braco) m;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'braco', g.braco, 'geradas', g.geradas, 'mostradas', g.mostradas, 'abertas', g.abertas,
           'viraram', g.viraram, 'nao_virou', g.nao_virou, 'nao_medivel', g.nao_medivel,
           'taxa', CASE WHEN g.viraram + g.nao_virou > 0 THEN round(g.viraram::numeric / (g.viraram + g.nao_virou), 4) END)
           ORDER BY g.braco), '[]'::jsonb)
    INTO v_sug
    FROM (SELECT COALESCE(s.braco, 'sem_braco') AS braco, count(*) AS geradas,
                 count(*) FILTER (WHERE s.mostrada_em IS NOT NULL)     AS mostradas,
                 count(*) FILTER (WHERE s.desfecho IS NULL)            AS abertas,
                 count(*) FILTER (WHERE s.desfecho = 'virou_pedido')   AS viraram,
                 count(*) FILTER (WHERE s.desfecho = 'nao_virou')      AS nao_virou,
                 count(*) FILTER (WHERE s.desfecho = 'nao_medivel')    AS nao_medivel
            FROM public.venda_sugestao s
           WHERE s.tipo = 'sistema' AND s.fase = 'ativa' AND s.dia_referencia BETWEEN p_de AND p_ate
           GROUP BY 1) g;

  RETURN jsonb_build_object('de', p_de, 'ate', p_ate, 'fila', v_fila, 'pedidos', v_ped, 'sugestoes', v_sug,
                            'base_pedidos', 'pares confirmados no momento da leitura');
END
$function$;

REVOKE ALL ON FUNCTION public.venda_sistema_fila(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.venda_sistema_decidir(bigint, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.venda_sistema_sensor(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.venda_sistema_fila(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.venda_sistema_decidir(bigint, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.venda_sistema_sensor(date, date) TO authenticated, service_role;

-- ── 6. Gerador: bloco 'sistema' (corpo vivo 3b93a5e8… + o bloco) ─────────────────────────────────────────
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

    -- R2 · Entrega 4: "falta completar o sistema" — só par CONFIRMADO pelo founder; os dois braços entram (o trigger
    -- marca o braço; o controle é medido e nunca mostrado).
    IF EXISTS (SELECT 1 FROM public.venda_config WHERE chave = 'onda_sistema' AND valor = 'true'::jsonb) THEN
      INSERT INTO public.venda_sugestao
             (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto,
              sistema_par_id, motivo_entrada)
      SELECT 'sistema', p_fase, p_dia, x.farmer_user_id, x.comprador_id, x.empresa, x.omie_codigo_produto,
             x.sistema_par_id, x.motivo_entrada
        FROM private.venda_lista_sistema(p_dia) x
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS v_k = ROW_COUNT;
      v_n := v_n + v_k;
    END IF;
  END IF;

  -- A lista de HOJE sai reconciliada com o plano/estado da sucessão pendente na fila (mesma trava, reentrante).
  IF p_dia = (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN
    PERFORM private.venda_sugestoes_drenar_reprocesso();
  END IF;

  RETURN v_n;
END
$function$;

-- ── 7. Fechamento: janela 'sistema', casamento pelo sistema, par revogado (corpo vivo 6c962e84… + sistema) ──
CREATE OR REPLACE FUNCTION public.venda_fechar_desfechos(p_hoje date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_janela jsonb;
  v_n      integer;
BEGIN
  IF p_hoje IS NULL THEN
    RAISE EXCEPTION 'venda_fechar_desfechos: p_hoje NULL' USING ERRCODE = '22023';
  END IF;

  SELECT valor INTO v_janela FROM public.venda_config WHERE chave = 'janela_dias';
  IF jsonb_typeof(v_janela -> 'recompra') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_janela -> 'complemento') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_janela -> 'preco') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_janela -> 'sistema') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'venda_fechar_desfechos: venda_config.janela_dias ausente ou incompleta' USING ERRCODE = '22023';
  END IF;

  -- Um fechamento por vez (cron + chamada manual da reconstrução histórica).
  PERFORM pg_advisory_xact_lock(hashtext('venda_fechar_desfechos'));

  WITH jan(tipo, dias) AS (
    VALUES ('recompra',    (v_janela ->> 'recompra')::int),
           ('complemento', (v_janela ->> 'complemento')::int),
           ('preco',       (v_janela ->> 'preco')::int),
           ('sistema',     (v_janela ->> 'sistema')::int)
  ),
  alvo0 AS (
    SELECT s.id, s.tipo, s.empresa, s.fase,
           COALESCE(ca.canonical_user_id, s.comprador_id) AS comprador,
           s.omie_codigo_produto, s.familia, s.preco_alvo, s.preco_anterior, s.mostrada_em,
           s.dia_referencia AS de,
           s.dia_referencia + j.dias AS ate,                 -- exclusivo
           -- Sistema: o par deixou de ser confirmado → a sugestão sai do ar e não é medida (o founder disse que o
           -- par não vale; "virou" sobre ele creditaria uma sugestão tecnicamente errada).
           (s.tipo = 'sistema' AND NOT EXISTS (SELECT 1 FROM public.venda_sistema_par sp
                                                WHERE sp.id = s.sistema_par_id AND sp.status = 'confirmado')) AS revogado,
           -- Sistema completo = o par sugerido OU outro par confirmado do MESMO sistema (base×papel: outra embalagem).
           CASE WHEN s.tipo = 'sistema' THEN
             ARRAY(SELECT s.omie_codigo_produto
                   UNION
                   SELECT sp2.par_codigo FROM public.venda_sistema_par sp1
                     JOIN public.venda_sistema_par sp2
                       ON sp2.empresa = sp1.empresa AND sp2.base_codigo = sp1.base_codigo AND sp2.papel = sp1.papel
                    WHERE sp1.id = s.sistema_par_id AND sp2.status = 'confirmado')
           END AS pares
      FROM public.venda_sugestao s
      JOIN jan j ON j.tipo = s.tipo
      LEFT JOIN public.customer_canonical_alias ca
             ON ca.alias_user_id = s.comprador_id AND ca.status = 'active'
     WHERE s.desfecho IS NULL
  ),
  alvo AS (
    SELECT a.* FROM alvo0 a WHERE a.ate <= p_hoje OR a.revogado
  ),
  pedido AS (
    -- Universo de venda de src/lib/farmer/universo-pedidos.ts (denylist; NULL não passa).
    SELECT so.id, so.account,
           COALESCE(ca.canonical_user_id, so.customer_user_id) AS comprador,
           COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) AS data_pedido
      FROM public.sales_orders so
      LEFT JOIN public.customer_canonical_alias ca
             ON ca.alias_user_id = so.customer_user_id AND ca.status = 'active'
     WHERE so.deleted_at IS NULL
       AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
  ),
  item AS (
    SELECT a.id AS sug_id, a.tipo, a.preco_alvo, a.preco_anterior, p.id AS so_id, p.data_pedido,
           oi.quantity                                                             AS qtd,
           oi.quantity * oi.unit_price - oi.desconto_valor                          AS valor_liq,
           (oi.quantity * oi.unit_price - oi.desconto_valor) / NULLIF(oi.quantity, 0) AS preco_liq,
           oi.unit_price                                                           AS preco_bruto
      FROM alvo a
      JOIN pedido p
        ON p.comprador = a.comprador
       AND p.account = a.empresa
       AND p.data_pedido >= a.de
       AND p.data_pedido <  a.ate
      JOIN public.order_items oi ON oi.sales_order_id = p.id
     WHERE NOT a.revogado
       AND ((a.tipo IN ('recompra','preco') AND oi.omie_codigo_produto = a.omie_codigo_produto)
        OR (a.tipo = 'sistema' AND oi.omie_codigo_produto = ANY (a.pares))
        OR (a.tipo = 'complemento' AND EXISTS (
              SELECT 1 FROM public.omie_products op
               WHERE op.omie_codigo_produto = oi.omie_codigo_produto
                 AND op.account = p.account
                 AND op.familia = a.familia)))
  ),
  -- Preço: o PEDIDO é a unidade (média ponderada do SKU no pedido, sem bonificação de líquido 0).
  pedido_preco AS (
    SELECT i.sug_id, i.so_id, i.data_pedido, min(i.preco_alvo) AS preco_alvo, min(i.preco_anterior) AS preco_anterior,
           CASE WHEN bool_and(i.valor_liq IS NOT NULL) THEN sum(i.valor_liq) END            AS valor_liq,
           bool_and(i.valor_liq IS NOT NULL)                                                AS liq_apurado,
           sum(i.valor_liq) FILTER (WHERE i.preco_liq > 0)
             / NULLIF(sum(i.qtd) FILTER (WHERE i.preco_liq > 0), 0)                         AS preco_medio_liq,
           sum(i.qtd * i.preco_bruto) / NULLIF(sum(i.qtd), 0)                               AS preco_medio_bruto
      FROM item i
     WHERE i.tipo = 'preco'
     GROUP BY i.sug_id, i.so_id, i.data_pedido
  ),
  item_q AS (
    SELECT i.sug_id, i.so_id, i.data_pedido, i.valor_liq, true AS qualifica
      FROM item i
     WHERE i.tipo <> 'preco'
    UNION ALL
    SELECT pp.sug_id, pp.so_id, pp.data_pedido, pp.valor_liq,
           -- preco_anterior NULL (impossível pelo CHECK) cai em NULL = indeterminado, nunca "virou"
           CASE WHEN pp.liq_apurado THEN COALESCE(pp.preco_medio_liq >= pp.preco_alvo * 0.99
                                                  AND pp.preco_medio_liq > pp.preco_anterior, false)
                WHEN pp.preco_medio_bruto < pp.preco_alvo * 0.99
                  OR pp.preco_medio_bruto <= pp.preco_anterior THEN false   -- desconto só abaixa
                ELSE NULL                                                  -- desconto não apurado
           END
      FROM pedido_preco pp
  ),
  agg AS (
    SELECT sug_id,
           (array_agg(so_id ORDER BY data_pedido, so_id) FILTER (WHERE qualifica))[1] AS so_id,
           CASE WHEN bool_and(valor_liq IS NOT NULL) FILTER (WHERE qualifica)
                THEN sum(valor_liq) FILTER (WHERE qualifica) END                     AS valor,
           bool_or(qualifica IS NULL)                                                AS indeterminado
      FROM item_q
     GROUP BY sug_id
  ),
  faixa AS (
    SELECT empresa, min(de) AS de, max(ate) AS ate FROM alvo WHERE NOT revogado GROUP BY empresa
  ),
  descoberto AS (
    SELECT f.empresa, g.d::date AS dia
      FROM faixa f
      CROSS JOIN LATERAL generate_series(f.de, f.ate - 1, interval '1 day') AS g(d)
     WHERE NOT private.venda_sync_dia_coberto(f.empresa, g.d::date)
  ),
  -- Linha de base (fase='historico'): dia sem heartbeat/cursor ainda conta como coberto se o MÊS passar na
  -- prova por dados (private.venda_mes_completo_por_dados). Só os dias de mês reprovado seguem descobertos.
  mes_descoberto AS (
    SELECT DISTINCT x.empresa, date_trunc('month', x.dia)::date AS mes FROM descoberto x
  ),
  mes_reprovado AS (
    SELECT m.empresa, m.mes FROM mes_descoberto m
     WHERE NOT private.venda_mes_completo_por_dados(m.empresa, m.mes)
  ),
  descoberto_hist AS (
    SELECT x.empresa, x.dia
      FROM descoberto x
      JOIN mes_reprovado r ON r.empresa = x.empresa AND r.mes = date_trunc('month', x.dia)::date
  ),
  decisao AS (
    SELECT a.id, g.so_id, g.valor,
           CASE
             WHEN a.revogado THEN 'nao_medivel'
             -- 'sistema' é medido como recompra (intenção de tratar): o braço controle, nunca mostrado, é o contrafactual.
             WHEN a.tipo NOT IN ('recompra','sistema') AND a.mostrada_em IS NULL THEN 'nao_medivel'   -- a farmer não viu
             WHEN g.so_id IS NOT NULL THEN 'virou_pedido'
             WHEN g.indeterminado     THEN 'nao_medivel'
             WHEN a.fase = 'historico' THEN
               CASE
                 WHEN EXISTS (SELECT 1 FROM descoberto_hist x
                               WHERE x.empresa = a.empresa AND x.dia >= a.de AND x.dia < a.ate
                                 AND x.dia + 5 < p_hoje)       THEN 'nao_medivel'
                 WHEN EXISTS (SELECT 1 FROM descoberto_hist x
                               WHERE x.empresa = a.empresa AND x.dia >= a.de AND x.dia < a.ate)
                                                               THEN NULL   -- ainda cobrível: reavalia amanhã
                 ELSE 'nao_virou'
               END
             WHEN EXISTS (SELECT 1 FROM descoberto x
                           WHERE x.empresa = a.empresa AND x.dia >= a.de AND x.dia < a.ate
                             AND x.dia + 5 < p_hoje)           THEN 'nao_medivel'
             WHEN EXISTS (SELECT 1 FROM descoberto x
                           WHERE x.empresa = a.empresa AND x.dia >= a.de AND x.dia < a.ate)
                                                               THEN NULL   -- ainda cobrível: reavalia amanhã
             ELSE 'nao_virou'
           END AS desfecho,
           CASE
             WHEN a.revogado THEN 'par_revogado'
             WHEN a.tipo NOT IN ('recompra','sistema') AND a.mostrada_em IS NULL THEN 'nao_exibida'
             WHEN g.so_id IS NOT NULL THEN NULL
             WHEN g.indeterminado     THEN 'desconto_nao_apurado'
             WHEN a.fase = 'historico' THEN 'historico_incompleto'
             ELSE 'sync_atrasado'
           END AS motivo
      FROM alvo a
      LEFT JOIN agg g ON g.sug_id = a.id
  )
  UPDATE public.venda_sugestao s
     SET desfecho        = d.desfecho,
         desfecho_motivo = CASE WHEN d.desfecho = 'nao_medivel' THEN d.motivo END,
         sales_order_id  = CASE WHEN d.desfecho = 'virou_pedido' THEN d.so_id END,
         valor_realizado = CASE WHEN d.desfecho = 'virou_pedido' THEN d.valor END,
         avaliado_em     = now()
    FROM decisao d
   WHERE d.id = s.id
     AND d.desfecho IS NOT NULL
     AND s.desfecho IS NULL;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$function$;

-- ── 8. Lista do Meu Dia / ficha: ondas.sistema, bloco 'sistema', par revogado some (corpo vivo ccc8189a…) ──
CREATE OR REPLACE FUNCTION private._venda_sugestoes_json(p_farmer uuid, p_dia date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ondas jsonb;
  v_out   jsonb;
BEGIN
  IF p_farmer IS NULL OR p_dia IS NULL THEN
    RAISE EXCEPTION '_venda_sugestoes_json: p_farmer/p_dia NULL' USING ERRCODE = '22023';
  END IF;

  -- Liga/desliga do servidor (vale para o aparelho da farmer). Chave ausente = desligada.
  SELECT jsonb_build_object(
           'recompra',    COALESCE(bool_or(c.chave = 'onda_recompra'    AND c.valor = 'true'::jsonb), false),
           'complemento', COALESCE(bool_or(c.chave = 'onda_complemento' AND c.valor = 'true'::jsonb), false),
           'preco',       COALESCE(bool_or(c.chave = 'onda_preco'       AND c.valor = 'true'::jsonb), false),
           'sistema',     COALESCE(bool_or(c.chave = 'onda_sistema'     AND c.valor = 'true'::jsonb), false))
    INTO v_ondas
    FROM public.venda_config c;

  WITH s AS (
    SELECT s.*, op.descricao, round(vr.cadencia_dias)::int AS cadencia_dias, ho.nomes AS herdada_de,
           CASE WHEN s.tipo = 'sistema' THEN jsonb_build_object(
                  'papel', sp.papel, 'base_omie_codigo_produto', sp.base_codigo, 'base_descricao', sb.descricao)
           END AS sistema
      FROM public.venda_sugestao s
      LEFT JOIN LATERAL (
        SELECT o.descricao FROM public.omie_products o
         WHERE o.omie_codigo_produto = s.omie_codigo_produto AND o.account = s.empresa
         LIMIT 1) op ON true
      LEFT JOIN public.venda_recompra vr
             ON s.tipo = 'recompra' AND vr.comprador_id = s.comprador_id
            AND vr.empresa = s.empresa AND vr.omie_codigo_produto = s.omie_codigo_produto
      -- A herança (PR B): o nome de quem passou o histórico, por evento da origem. Compara o evento como TEXTO:
      -- um elemento fora da forma vira "sem nome", nunca um cast que derruba a lista inteira.
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(DISTINCT COALESCE(
                 (SELECT r.nome FROM private.cliente_resolver_documento(cs.antigo_documento) r), cs.antigo_documento))
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.sucessao_origem) = 'array'
                                         THEN s.sucessao_origem ELSE '[]'::jsonb END) e(el)
          JOIN LATERAL (
            SELECT c.antigo_documento FROM public.cliente_sucessoes c
             WHERE c.evento_id::text = e.el ->> 'evento_id'
             ORDER BY c.declarado_em, c.id LIMIT 1) cs ON true
        ) ho(nomes) ON s.sucessao_origem IS NOT NULL
      -- Sistema (R2 · Entrega 4): o par e a descrição da base; par que deixou de ser confirmado SOME na hora.
      LEFT JOIN public.venda_sistema_par sp ON sp.id = s.sistema_par_id
      LEFT JOIN LATERAL (
        SELECT o.descricao FROM public.omie_products o
         WHERE o.omie_codigo_produto = sp.base_codigo AND o.account = sp.empresa
         LIMIT 1) sb ON s.tipo = 'sistema'
     WHERE s.fase = 'ativa'
       AND s.braco IS DISTINCT FROM 'controle'
       AND s.farmer_user_id = p_farmer
       AND s.dia_referencia = p_dia
       AND (s.tipo <> 'sistema' OR sp.status = 'confirmado')
  ),
  c AS (
    SELECT s.comprador_id,
           min(s.motivo_entrada) FILTER (WHERE s.tipo = 'recompra') AS motivo_entrada,
           -- ausente ≠ zero: total só quando TODAS as sugestões de recompra têm valor de referência.
           CASE WHEN bool_and(s.valor_ref IS NOT NULL) FILTER (WHERE s.tipo = 'recompra')
                THEN sum(s.valor_ref) FILTER (WHERE s.tipo = 'recompra') END AS valor_ref_total,
           COALESCE(bool_or(s.valor_ref_referencia_origem AND s.valor_ref IS NOT NULL)
                      FILTER (WHERE s.tipo = 'recompra'), false) AS valor_ref_total_referencia_origem,
           jsonb_agg(jsonb_build_object(
             'id', s.id, 'tipo', s.tipo, 'empresa', s.empresa,
             'omie_codigo_produto', s.omie_codigo_produto, 'descricao', s.descricao,
             'familia', s.familia, 'qtd_ref', s.qtd_ref, 'valor_ref', s.valor_ref,
             'preco_alvo', s.preco_alvo, 'cadencia_dias', s.cadencia_dias,
             'sucessao_origem', s.sucessao_origem, 'herdada_de', s.herdada_de,
             'valor_ref_referencia_origem', s.valor_ref_referencia_origem,
             'sistema', s.sistema)
             ORDER BY s.tipo, s.valor_ref DESC NULLS LAST, s.omie_codigo_produto, s.familia) AS sugestoes
      FROM s
     GROUP BY s.comprador_id
  )
  SELECT jsonb_build_object(
           'dia', p_dia,
           'ondas', v_ondas,
           'compradores', COALESCE(jsonb_agg(jsonb_build_object(
               'comprador_id', c.comprador_id,
               'nome', pr.nome,
               'telefone', pr.telefone,
               'motivo_entrada', c.motivo_entrada,
               'valor_ref_total', c.valor_ref_total,
               'valor_ref_total_referencia_origem', c.valor_ref_total_referencia_origem,
               'sugestoes', c.sugestoes)
             ORDER BY c.valor_ref_total DESC NULLS LAST, c.comprador_id), '[]'::jsonb))
    INTO v_out
    FROM c
    LEFT JOIN LATERAL (
      SELECT COALESCE(p.name, p.razao_social) AS nome, p.phone AS telefone
        FROM public.profiles p WHERE p.user_id = c.comprador_id
       ORDER BY p.created_at LIMIT 1) pr ON true;

  RETURN v_out;
END
$function$;

-- ── 9. E-mail: linha "Falta completar o sistema" (corpo vivo 143dc394… + a linha) ────────────────────────
CREATE OR REPLACE FUNCTION private.venda_resumo_bloco(p_farmer uuid, p_dia date, p_comprador uuid, p_posicao integer, p_motivo text, p_valor numeric, p_link text)
 RETURNS TABLE(texto text, sugestao_ids uuid[])
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_nome   text;
  v_tel    text;
  v_itens  text := '';
  v_ids    uuid[] := '{}';
  v_resto  integer;
  v_fams   text;
  v_fids   uuid[];
  v_sis    text;
  v_sids   uuid[];
  i        record;
BEGIN
  SELECT COALESCE(NULLIF(btrim(p.name), ''), NULLIF(btrim(p.razao_social), ''), 'Cliente sem nome no cadastro'),
         NULLIF(btrim(p.phone), '')
    INTO v_nome, v_tel
    FROM public.profiles p WHERE p.user_id = p_comprador
   ORDER BY p.created_at LIMIT 1;
  -- Sem linha em profiles o SELECT INTO deixa NULL (o COALESCE de cima só age com linha) — e NULL zeraria o e-mail.
  v_nome := COALESCE(v_nome, 'Cliente sem nome no cadastro');

  FOR i IN
    SELECT s.id, s.qtd_ref, s.valor_ref, s.empresa,
           COALESCE((SELECT o.descricao FROM public.omie_products o
                      WHERE o.omie_codigo_produto = s.omie_codigo_produto AND o.account = s.empresa LIMIT 1),
                    'SKU ' || s.omie_codigo_produto) AS descricao,
           vr.ultimo_preco, vr.cadencia_dias, vr.ultima_compra
      FROM public.venda_sugestao s
      LEFT JOIN public.venda_recompra vr
             ON vr.comprador_id = s.comprador_id AND vr.empresa = s.empresa
            AND vr.omie_codigo_produto = s.omie_codigo_produto
     WHERE s.fase = 'ativa' AND s.tipo = 'recompra' AND s.farmer_user_id = p_farmer
       AND s.comprador_id = p_comprador AND s.dia_referencia = p_dia
     ORDER BY s.valor_ref DESC NULLS LAST, s.omie_codigo_produto
     LIMIT 3
  LOOP
    v_ids := v_ids || i.id;
    v_itens := v_itens || E'\n' || '   - ' || i.descricao
      || COALESCE(' · ' || private.venda_qtd(i.qtd_ref) || ' un', '')
      || ' · último preço ' || COALESCE(private.venda_brl(i.ultimo_preco), 'sem registro')
      || CASE WHEN i.cadencia_dias IS NOT NULL AND i.ultima_compra IS NOT NULL
              THEN ' · comprava a cada ' || round(i.cadencia_dias)::int || ' dias, última há '
                   || (p_dia - i.ultima_compra) || ' dias'
              ELSE '' END;
  END LOOP;

  SELECT count(*) - cardinality(v_ids) INTO v_resto
    FROM public.venda_sugestao s
   WHERE s.fase = 'ativa' AND s.tipo = 'recompra' AND s.farmer_user_id = p_farmer
     AND s.comprador_id = p_comprador AND s.dia_referencia = p_dia;

  SELECT string_agg(x.familia, ', ' ORDER BY x.familia), array_agg(x.id ORDER BY x.familia)
    INTO v_fams, v_fids
    FROM (SELECT s.id, s.familia FROM public.venda_sugestao s
           WHERE s.fase = 'ativa' AND s.tipo = 'complemento' AND s.farmer_user_id = p_farmer
             AND s.comprador_id = p_comprador AND s.dia_referencia = p_dia
           ORDER BY s.familia LIMIT 2) x;

  -- Sistema (R2 · Entrega 4): só par AINDA confirmado; no máx. 2 por cliente.
  SELECT string_agg(x.txt, '; ' ORDER BY x.ord), array_agg(x.id ORDER BY x.ord)
    INTO v_sis, v_sids
    FROM (SELECT s.id, s.omie_codigo_produto AS ord,
                 COALESCE((SELECT o.descricao FROM public.omie_products o
                            WHERE o.omie_codigo_produto = s.omie_codigo_produto AND o.account = s.empresa LIMIT 1),
                          'SKU ' || s.omie_codigo_produto)
                 || ' (' || sp.papel || ' do '
                 || COALESCE((SELECT o.descricao FROM public.omie_products o
                               WHERE o.omie_codigo_produto = sp.base_codigo AND o.account = sp.empresa LIMIT 1),
                             'SKU ' || sp.base_codigo) || ')' AS txt
            FROM public.venda_sugestao s
            JOIN public.venda_sistema_par sp ON sp.id = s.sistema_par_id AND sp.status = 'confirmado'
           WHERE s.fase = 'ativa' AND s.tipo = 'sistema' AND s.farmer_user_id = p_farmer
             AND s.comprador_id = p_comprador AND s.dia_referencia = p_dia
           ORDER BY s.omie_codigo_produto LIMIT 2) x;

  texto := p_posicao || '. ' || v_nome || ' — ' || COALESCE(v_tel, 'sem telefone no cadastro') || E'\n'
        || '   ' || p_motivo || ' · valor esperado ' || COALESCE(private.venda_brl(p_valor), 'sem base de valor')
        || v_itens
        || CASE WHEN v_resto > 0 THEN E'\n' || '   + ' || v_resto
                                      || CASE WHEN v_resto = 1 THEN ' outro item' ELSE ' outros itens' END || ' na ficha'
                ELSE '' END
        || COALESCE(E'\n' || '   Ofereça também: ' || v_fams, '')
        || COALESCE(E'\n' || '   Falta completar o sistema: ' || v_sis, '')
        || E'\n' || '   Abrir a ficha: ' || p_link;
  sugestao_ids := v_ids || COALESCE(v_fids, '{}') || COALESCE(v_sids, '{}');
  RETURN NEXT;
END
$function$;

-- ── PÓS: o estado provado (aborta o apply se não pegou) ──────────────────────────────────────────────────
DO $post$
DECLARE
  r record;
BEGIN
  -- P1 corpos recriados = este
  FOR r IN
    SELECT x.alvo, (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(x.alvo)) AS vivo, x.este
      FROM (VALUES
        ('public.venda_gerar_lista(date,text)',      'fa710709f8a598258460f2971d2ec2fe'),
        ('public.venda_fechar_desfechos(date)',      '18b1768290af7e0ce66601cc389b37da'),
        ('private._venda_sugestoes_json(uuid,date)', 'd2ead2156bf76b6047a591e156148e64'),
        ('private.venda_resumo_bloco(uuid,date,uuid,integer,text,numeric,text)', '3b2c0dd39af68a0a50e4320cb48f6ebb')
      ) AS x(alvo, este)
  LOOP
    IF r.vivo IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'P1 FALHOU: % ficou com md5 % (esperado %)', r.alvo, r.vivo, r.este;
    END IF;
  END LOOP;

  -- P2 tabelas novas com RLS
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.venda_sistema_par'::regclass AND relrowsecurity)
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.venda_sistema_par_decisao'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'P2 FALHOU: venda_sistema_par/_decisao sem RLS';
  END IF;

  -- P3 venda_sugestao aceita 'sistema' e exige o par
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.venda_sugestao'::regclass
                  AND conname = 'venda_sugestao_tipo_check' AND convalidated
                  AND pg_get_constraintdef(oid) LIKE '%sistema%')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.venda_sugestao'::regclass
                     AND conname = 'venda_sugestao_sistema_ck' AND convalidated)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.venda_sugestao'::regclass
                     AND conname = 'venda_sugestao_alvo_ck' AND convalidated
                     AND pg_get_constraintdef(oid) LIKE '%sistema%') THEN
    RAISE EXCEPTION 'P3 FALHOU: venda_sugestao nao aceita o tipo sistema com par obrigatorio';
  END IF;

  -- P4 config completa (sem a janela 'sistema' o fechamento ABORTA todo dia)
  IF NOT EXISTS (SELECT 1 FROM public.venda_config WHERE chave = 'janela_dias' AND jsonb_typeof(valor -> 'sistema') = 'number')
     OR NOT EXISTS (SELECT 1 FROM public.venda_config WHERE chave = 'sistema_regras')
     OR NOT EXISTS (SELECT 1 FROM public.venda_config WHERE chave = 'sistema_familias')
     OR NOT EXISTS (SELECT 1 FROM public.venda_config WHERE chave = 'onda_sistema') THEN
    RAISE EXCEPTION 'P4 FALHOU: venda_config sem as chaves do sistema';
  END IF;

  -- P5 ACL: RPCs fechadas para PUBLIC/anon (gate master dentro); helpers privados fechados para authenticated/anon
  FOR r IN SELECT unnest(ARRAY['public.venda_sistema_fila(text)', 'public.venda_sistema_decidir(bigint,text)',
                               'public.venda_sistema_sensor(date,date)']) AS f
  LOOP
    IF has_function_privilege('anon', r.f, 'EXECUTE') OR has_function_privilege('public', r.f, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', r.f, 'EXECUTE') THEN
      RAISE EXCEPTION 'P5 FALHOU: ACL de % (anon/PUBLIC aberto ou authenticated fechado)', r.f;
    END IF;
  END LOOP;
  FOR r IN SELECT unnest(ARRAY['private.venda_sistema_cita(text,text)', 'private.venda_sistema_candidatos(text,date)',
                               'private.venda_sistema_boletim(text,bigint,bigint,text)', 'private.venda_lista_sistema(date)']) AS f
  LOOP
    IF has_function_privilege('authenticated', r.f, 'EXECUTE') OR has_function_privilege('anon', r.f, 'EXECUTE') THEN
      RAISE EXCEPTION 'P5 FALHOU: helper privado % executavel por authenticated/anon', r.f;
    END IF;
  END LOOP;

  -- P6 a tabela de pares não é gravável por authenticated (só a RPC escreve)
  IF has_table_privilege('authenticated', 'public.venda_sistema_par', 'INSERT')
     OR has_table_privilege('authenticated', 'public.venda_sistema_par', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.venda_sistema_par_decisao', 'INSERT') THEN
    RAISE EXCEPTION 'P6 FALHOU: authenticated escreve direto em venda_sistema_par';
  END IF;

  RAISE NOTICE 'venda-sistema-completo OK';
END
$post$;
