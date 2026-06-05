-- Reposição — auto-aplicação de parâmetros: fundação (tabelas + RLS + seeds + CHECK)
-- ============================================================================
-- Spec: docs/superpowers/specs/2026-06-05-reposicao-param-auto-aplicacao-design.md §5/§13.
-- O auto-apply de parâmetros (atualizar_parametros_numericos_skus) JÁ roda em prod (cron
-- omie-cron-diario + 3 telas). Esta migration adiciona o REGISTRO/visibilidade/reversibilidade:
--   • reposicao_param_auto_run  — cabeçalho do run diário (idempotência 1 run/empresa/dia)
--   • reposicao_param_auto_log  — antes→depois por SKU (fonte do resumo, do undo e da auditoria)
--   • reposicao_param_pin       — trava de reversão (não re-aplicar valor recusado até a sugestão mudar)
-- RLS: leitura staff-gestor (pode_ver_carteira_completa); escrita só service_role / RPC SECURITY DEFINER.
-- Seeds de limiares do fusível em company_config (ajustáveis sem deploy).
-- CHECK de fornecedor_alerta estendido com 'param_auto_resumo' (preservando os 10 vivos).
-- Validado em PostgreSQL 17 local (db/test-param-auto.sh).
BEGIN;

-- ── Cabeçalho do run diário ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reposicao_param_auto_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa text NOT NULL,
  data_negocio_brt date NOT NULL,                 -- (now() AT TIME ZONE 'America/Sao_Paulo')::date
  status text NOT NULL DEFAULT 'rodando' CHECK (status IN ('rodando','completo','erro')),
  total_avaliados int,
  total_aplicados int,
  total_segurados int,                            -- fusível
  total_pinados int,                              -- trava de reversão
  impacto_total_rs numeric,                       -- soma do impacto simulado (conhecido)
  impacto_desconhecido_n int,                     -- SKUs sem custo → impacto não somado
  resumo_enviado_em timestamptz,                  -- idempotência do e-mail
  criado_em timestamptz NOT NULL DEFAULT now(),
  concluido_em timestamptz
);
-- Idempotência: no máximo 1 run "completo" por empresa/dia (o wrapper checa antes de inserir).
CREATE UNIQUE INDEX IF NOT EXISTS uq_param_auto_run_dia
  ON public.reposicao_param_auto_run (empresa, data_negocio_brt) WHERE status = 'completo';

-- ── Log canônico: 1 linha por SKU relevante avaliado no run ─────────────────
CREATE TABLE IF NOT EXISTS public.reposicao_param_auto_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.reposicao_param_auto_run(id),
  empresa text NOT NULL,
  sku_codigo_omie text NOT NULL,
  sku_descricao text,
  status text NOT NULL CHECK (status IN ('aplicado','segurado','pinado','bloqueado_validacao')),
  -- antes → depois dos 5 campos de config
  ponto_pedido_antes numeric, ponto_pedido_depois numeric,
  estoque_minimo_antes numeric, estoque_minimo_depois numeric,
  estoque_maximo_antes numeric, estoque_maximo_depois numeric,
  estoque_seguranca_antes numeric, estoque_seguranca_depois numeric,
  cobertura_antes numeric, cobertura_depois numeric,
  -- impacto da compra simulada (best-effort/display-only; NULL = desconhecido, nunca zero)
  impacto_rs numeric, qtde_compra_antes numeric, qtde_compra_depois numeric,
  custo_unitario numeric, custo_fonte text,       -- cmc | preco_medio | null
  -- contexto p/ explicabilidade
  demanda_media_diaria numeric, lt_medio_dias_uteis numeric,
  classe_consolidada text, z_score numeric,
  -- revert
  revertido_em timestamptz, revertido_por uuid,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_param_auto_log_run ON public.reposicao_param_auto_log (run_id);
CREATE INDEX IF NOT EXISTS idx_param_auto_log_sku ON public.reposicao_param_auto_log (empresa, sku_codigo_omie);

-- ── Pin (trava de reversão) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reposicao_param_pin (
  empresa text NOT NULL,
  sku_codigo_omie text NOT NULL,
  ponto_pedido_rejeitado numeric NOT NULL,        -- o "depois" que ele recusou (arredondado)
  estoque_maximo_rejeitado numeric NOT NULL,
  pinado_em timestamptz NOT NULL DEFAULT now(),
  pinado_por uuid,
  PRIMARY KEY (empresa, sku_codigo_omie)
);

-- ── RLS: leitura staff-gestor; escrita só service_role / SECURITY DEFINER ───
ALTER TABLE public.reposicao_param_auto_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reposicao_param_auto_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reposicao_param_pin ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS param_auto_run_sel ON public.reposicao_param_auto_run;
DROP POLICY IF EXISTS param_auto_log_sel ON public.reposicao_param_auto_log;
DROP POLICY IF EXISTS param_auto_pin_sel ON public.reposicao_param_pin;

CREATE POLICY param_auto_run_sel ON public.reposicao_param_auto_run FOR SELECT TO authenticated
  USING (public.pode_ver_carteira_completa(auth.uid()));
CREATE POLICY param_auto_log_sel ON public.reposicao_param_auto_log FOR SELECT TO authenticated
  USING (public.pode_ver_carteira_completa(auth.uid()));
CREATE POLICY param_auto_pin_sel ON public.reposicao_param_pin FOR SELECT TO authenticated
  USING (public.pode_ver_carteira_completa(auth.uid()));
-- Sem policy de INSERT/UPDATE/DELETE para authenticated: service_role bypassa RLS (motor),
-- e as RPCs revert/pin são SECURITY DEFINER (escrevem como owner).

-- ── Seeds dos limiares do fusível (ajustáveis pelo founder sem deploy) ──────
INSERT INTO public.company_config (key, value) VALUES
  ('param_auto_fusivel_mult', '3'),
  ('param_auto_fusivel_cobertura_dias', '120'),
  ('param_auto_resumo_hora_brt', '18')
ON CONFLICT (key) DO NOTHING;

-- ── Estender o CHECK de tipo de fornecedor_alerta com 'param_auto_resumo' ───
-- Lista VIVA de prod (10 valores) + o novo. NÃO usar a lista do schema-snapshot (stale: 7 valores).
-- dispatch-notifications consome status='pendente_notificacao' e manda titulo+mensagem SEM filtrar
-- por tipo → o tipo novo funciona sem editar o edge.
ALTER TABLE public.fornecedor_alerta DROP CONSTRAINT IF EXISTS fornecedor_alerta_tipo_check;
ALTER TABLE public.fornecedor_alerta ADD CONSTRAINT fornecedor_alerta_tipo_check
  CHECK (tipo IN ('promocao_suspensa','aumento_anunciado','promocao_nova','polling_erro',
    'mapeamento_pendente','oportunidade_calculada','tarefa_atrasada','whatsapp_sla',
    'erro_app','outro','param_auto_resumo'));

COMMIT;

SELECT 'BLOCO A OK' AS status,
  (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN
    ('reposicao_param_auto_run','reposicao_param_auto_log','reposicao_param_pin')) AS tabelas,
  (SELECT count(*) FROM public.company_config WHERE key LIKE 'param_auto_%') AS seeds;
