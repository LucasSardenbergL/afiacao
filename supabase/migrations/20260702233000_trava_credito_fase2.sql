-- ============================================================
-- Trava de crédito FASE 2 — exceção por pedido + log + RPC do gate
-- Spec + veredito Codex: docs/superpowers/specs/trava-credito-fase2.md
-- O gate roda no edge omie-vendas-sync (fronteira comum de TODAS as vias de
-- pedido) via venda_gate_credito(); bloqueia venda a cliente com saldo vencido
-- 60+ dias sem exceção aprovada por gestor PARA AQUELE PEDIDO.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Exceção de crédito — POR PEDIDO (não por cliente: uma aprovação não pode
--    liberar exposição ilimitada até expirar — P1 do challenge Codex).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.venda_excecao_credito (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  -- Conta de PEDIDO: só oben|colacor (colacor_sc não cria pedido de venda).
  company text NOT NULL CHECK (company IN ('oben', 'colacor')),
  omie_codigo_cliente bigint NOT NULL,
  nome_cliente text,
  -- Snapshot do vencido 60+ no momento da aprovação (auditoria do risco aceito).
  vencido_no_momento numeric,
  motivo text NOT NULL CHECK (btrim(motivo) <> ''),
  valido_ate timestamptz NOT NULL,
  aprovado_por uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Teto de validade: 30 dias (janela real de uso é o retry do pedido).
  CONSTRAINT venda_excecao_validade_max CHECK (valido_ate <= created_at + interval '30 days')
);

CREATE INDEX IF NOT EXISTS idx_venda_excecao_pedido
  ON public.venda_excecao_credito(sales_order_id, valido_ate);

-- Autor e created_at FORÇADOS no servidor (P1 Codex: default auth.uid() é
-- forjável — um INSERT pode mandar outro UUID; o trigger sobrescreve).
-- Sob service_role auth.uid() é NULL → mantém o payload (edge não cria exceção).
CREATE OR REPLACE FUNCTION public.venda_excecao_credito_forca_autor()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    NEW.aprovado_por := auth.uid();
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_venda_excecao_forca_autor ON public.venda_excecao_credito;
CREATE TRIGGER trg_venda_excecao_forca_autor
  BEFORE INSERT ON public.venda_excecao_credito
  FOR EACH ROW EXECUTE FUNCTION public.venda_excecao_credito_forca_autor();

ALTER TABLE public.venda_excecao_credito ENABLE ROW LEVEL SECURITY;

-- Staff lê (transparência interna)
DROP POLICY IF EXISTS "venda_excecao_select_staff" ON public.venda_excecao_credito;
CREATE POLICY "venda_excecao_select_staff"
  ON public.venda_excecao_credito FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.user_roles
            WHERE user_id = (SELECT auth.uid())
              AND role IN ('employee'::public.app_role, 'master'::public.app_role))
  );

-- Só GESTOR/MASTER aprova (fail-closed); defesa em profundidade: a linha tem
-- de sair com aprovado_por = quem insere (o trigger já força; a policy segura
-- caso o trigger suma um dia).
DROP POLICY IF EXISTS "venda_excecao_insert_gestor" ON public.venda_excecao_credito;
CREATE POLICY "venda_excecao_insert_gestor"
  ON public.venda_excecao_credito FOR INSERT
  WITH CHECK (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    AND aprovado_por = (SELECT auth.uid())
  );

-- Sem UPDATE/DELETE para usuários: exceção é IMUTÁVEL (errada = expira).
DROP POLICY IF EXISTS "venda_excecao_service_all" ON public.venda_excecao_credito;
CREATE POLICY "venda_excecao_service_all"
  ON public.venda_excecao_credito FOR ALL
  USING ((SELECT auth.role()) = 'service_role');

-- ------------------------------------------------------------
-- 2) Log de bloqueio — a medição da fase (escrito pelo edge/service_role).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.venda_bloqueio_credito_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL,
  omie_codigo_cliente bigint,
  sales_order_id uuid,
  acao text NOT NULL CHECK (acao IN ('bloqueado', 'liberado_excecao', 'gate_indisponivel', 'bloqueado_edicao')),
  vencido numeric,
  titulos integer,
  user_id uuid,
  excecao_id uuid,
  detalhe text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_venda_bloqueio_log_criado
  ON public.venda_bloqueio_credito_log(created_at);

ALTER TABLE public.venda_bloqueio_credito_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "venda_bloqueio_log_select_staff" ON public.venda_bloqueio_credito_log;
CREATE POLICY "venda_bloqueio_log_select_staff"
  ON public.venda_bloqueio_credito_log FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.user_roles
            WHERE user_id = (SELECT auth.uid())
              AND role IN ('employee'::public.app_role, 'master'::public.app_role))
  );

DROP POLICY IF EXISTS "venda_bloqueio_log_service_all" ON public.venda_bloqueio_credito_log;
CREATE POLICY "venda_bloqueio_log_service_all"
  ON public.venda_bloqueio_credito_log FOR ALL
  USING ((SELECT auth.role()) = 'service_role');

-- ------------------------------------------------------------
-- 3) RPC do gate — chamada SÓ pelo edge (service_role). Lógica 100% SQL:
--    1 fonte de verdade, provada no PG17 (db/test-trava-credito-fase2.sh).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.venda_gate_credito(
  p_company text,
  p_codigo bigint,
  p_sales_order_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_corte date;
  v_vencido numeric;
  v_titulos integer;
  v_mais_antigo date;
  v_excecao_id uuid;
BEGIN
  -- Sem código não há evidência possível → não bloqueia (precisão > recall).
  IF p_codigo IS NULL OR p_codigo <= 0 OR p_company IS NULL THEN
    RETURN jsonb_build_object('bloqueado', false, 'vencido', null, 'titulos', 0,
                              'vencimento_mais_antigo', null, 'excecao_id', null,
                              'motivo', 'sem_codigo');
  END IF;

  -- Corte em data civil de São Paulo (não UTC da sessão) — P2 Codex.
  v_corte := ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 60);

  -- Vocabulário de status espelha OPEN_TITLE_STATUSES de
  -- src/lib/financeiro/titulo-status.ts (paridade garantida por teste vitest).
  SELECT COALESCE(sum(saldo), 0), count(*), min(data_vencimento)
    INTO v_vencido, v_titulos, v_mais_antigo
    FROM public.fin_contas_receber
   WHERE company = p_company
     AND omie_codigo_cliente = p_codigo
     AND status_titulo IN ('A VENCER', 'ATRASADO', 'VENCE HOJE', 'ABERTO', 'VENCIDO', 'PARCIAL')
     AND saldo > 0
     AND data_vencimento < v_corte;

  IF v_vencido <= 0 THEN
    RETURN jsonb_build_object('bloqueado', false, 'vencido', 0, 'titulos', 0,
                              'vencimento_mais_antigo', null, 'excecao_id', null,
                              'motivo', 'sem_vencido_60d');
  END IF;

  -- Exceção aprovada PARA ESTE PEDIDO, dentro da validade.
  SELECT id INTO v_excecao_id
    FROM public.venda_excecao_credito
   WHERE sales_order_id = p_sales_order_id
     AND valido_ate > now()
   ORDER BY created_at DESC
   LIMIT 1;

  RETURN jsonb_build_object(
    'bloqueado', v_excecao_id IS NULL,
    'vencido', v_vencido,
    'titulos', v_titulos,
    'vencimento_mais_antigo', v_mais_antigo,
    'excecao_id', v_excecao_id,
    'motivo', CASE WHEN v_excecao_id IS NULL THEN 'vencido_60d_sem_excecao' ELSE 'excecao_valida' END
  );
END;
$$;

-- Gate é exclusivo do edge: nem anon nem authenticated executam.
REVOKE EXECUTE ON FUNCTION public.venda_gate_credito(text, bigint, uuid) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.venda_gate_credito(text, bigint, uuid) TO service_role;
