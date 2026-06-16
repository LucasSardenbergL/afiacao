-- ════════════════════════════════════════════════════════════════════════════
-- Recebimento closed-loop honesto — Fase A0: LEDGER de efetivação (por passo)
-- ════════════════════════════════════════════════════════════════════════════
-- Frente do programa autônomo (pós Picking #567). A efetivação de NF-e mente
-- sobre conclusão (marca status='efetivado' incondicional mesmo se a escrita no
-- Omie falha) e está incompleta (não envia quantidade, não conclui o recebimento).
--
-- Esta migration é 100% ADITIVA (zero risco): cria o LEDGER de efeitos externos
-- que torna o retry seguro (não duplica estoque/conclusão). O fluxo de escrita
-- completo entra no PR2 (A1), depois do diagnóstico do Omie real.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / DROP+CREATE
-- POLICY. Pode rerodar. Status novos ('falha_efetivacao'/'efetivacao_parcial')
-- NÃO precisam de DDL — nfe_recebimentos.status é varchar(20) livre.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. nfe_recebimentos: flags de idempotência por passo + estado de tela + lock ──
ALTER TABLE public.nfe_recebimentos
  ADD COLUMN IF NOT EXISTS alterar_recebimento_ok  boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS alterar_etapa_ok        boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS concluir_recebimento_ok boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cte_ok                  boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS efetivacao_erro         text,
  ADD COLUMN IF NOT EXISTS efetivacao_tentativas   integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS efetivacao_lock_at      timestamptz;

-- ── 2. nfe_recebimento_itens: idempotência do IncluirAjusteEstoque (NÃO-idempotente) ──
ALTER TABLE public.nfe_recebimento_itens
  ADD COLUMN IF NOT EXISTS ajuste_estoque_ok      boolean      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ajuste_estoque_omie_id text,
  ADD COLUMN IF NOT EXISTS ajuste_estoque_at      timestamptz;

-- ── 3. nfe_efetivacao_tentativas: ledger append-only (auditoria por operação) ──
CREATE TABLE IF NOT EXISTS public.nfe_efetivacao_tentativas (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  nfe_recebimento_id uuid        NOT NULL REFERENCES public.nfe_recebimentos(id) ON DELETE CASCADE,
  tentativa          integer     NOT NULL DEFAULT 1,
  operacao           text        NOT NULL,  -- diagnostico|alterar_recebimento|alterar_etapa|concluir_recebimento|ajuste_estoque|importar_cte
  item_id            uuid        REFERENCES public.nfe_recebimento_itens(id) ON DELETE SET NULL,
  sucesso            boolean     NOT NULL,
  erro               text,
  omie_status        text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nfe_efetivacao_tentativas_receb
  ON public.nfe_efetivacao_tentativas (nfe_recebimento_id, created_at DESC);

-- RLS: SELECT só staff (employee/master). Escrita = service_role (o edge), que
-- bypassa RLS — nenhuma policy de INSERT/UPDATE pra authenticated (append-only do server).
ALTER TABLE public.nfe_efetivacao_tentativas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_select_nfe_efetivacao_tentativas" ON public.nfe_efetivacao_tentativas;
CREATE POLICY "staff_select_nfe_efetivacao_tentativas"
  ON public.nfe_efetivacao_tentativas
  FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'employee'::app_role) OR has_role(auth.uid(), 'master'::app_role));

-- ── 4. Validação (cole no SQL Editor e confira o resultado) ──
SELECT
  'BLOCO RECEBIMENTO LEDGER OK' AS status,
  (SELECT count(*) FROM information_schema.columns
     WHERE table_schema='public' AND table_name='nfe_recebimentos'
       AND column_name IN ('alterar_recebimento_ok','alterar_etapa_ok','concluir_recebimento_ok','cte_ok','efetivacao_erro','efetivacao_tentativas','efetivacao_lock_at')) AS cols_recebimentos_esperado_7,
  (SELECT count(*) FROM information_schema.columns
     WHERE table_schema='public' AND table_name='nfe_recebimento_itens'
       AND column_name IN ('ajuste_estoque_ok','ajuste_estoque_omie_id','ajuste_estoque_at')) AS cols_itens_esperado_3,
  (SELECT count(*) FROM information_schema.tables
     WHERE table_schema='public' AND table_name='nfe_efetivacao_tentativas') AS tabela_esperado_1,
  (SELECT count(*) FROM pg_policies
     WHERE schemaname='public' AND tablename='nfe_efetivacao_tentativas') AS policies_esperado_1;
