-- sku_items_sync_controle — estado da fila do sync de leadtime por item de NFe.
--
-- POR QUÊ (incidente 2026-07): a fila da edge omie-sync-sku-items era "toda NFe
-- sem linha em sku_leadtime_history". NFe cuja ConsultarRecebimento responde 0
-- itens nunca upserta → nunca sai da fila → é re-consultada em todo run. Sob
-- rate-limit da Omie (a edge roda depois de 3 steps do orquestrador), UMA
-- consulta pode consumir ~55s e estourar o TIMEOUT_GUARD_MS de 50s: runs
-- seguidos gastavam ~60s produzindo zero linhas, e as NFes órfãs mais antigas
-- nunca eram alcançadas — expiram da janela de `dias` sem virar leadtime.
--
-- Este controle registra a TENTATIVA (o que sku_leadtime_history não consegue
-- registrar: ausência de resultado), habilitando backoff 6h/24h/72h e ordem
-- "nunca-tentadas primeiro".
--
-- POR QUE TABELA SEPARADA (e não colunas em purchase_orders_tracking):
-- purchase_orders_tracking tem trigger BEFORE UPDATE set_updated_at(), e o
-- updated_at dela é o PROBE DE EFEITO dos syncs de pedidos/nfes/ctes
-- (docs/agent/sync.md, registry). Gravar controle lá empurraria updated_at a
-- cada tentativa e faria os três syncs irmãos parecerem frescos — quebraria o
-- diagnóstico de "sync parado" justamente na família money-path da reposição.
--
-- Writer único: a edge omie-sync-sku-items (via service-role).

CREATE TABLE IF NOT EXISTS public.sku_items_sync_controle (
  tracking_id uuid PRIMARY KEY
    REFERENCES public.purchase_orders_tracking(id) ON DELETE CASCADE,
  tentativas integer NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  ultima_tentativa timestamptz NOT NULL DEFAULT now(),
  motivo text,
  criado_em timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.sku_items_sync_controle IS
  'Estado da fila do omie-sync-sku-items: tentativas de ConsultarRecebimento por NFe (backoff 6h/24h/72h). Writer único = edge omie-sync-sku-items. Ver docs/agent/sync.md.';
COMMENT ON COLUMN public.sku_items_sync_controle.motivo IS
  'Desfecho da última tentativa: ok_com_itens | ok_0_itens | fault: <faultstring> | consulta_falhou: <erro>. Diagnóstico — não é sinal money-path.';

-- Fila do run: "nunca-tentadas primeiro" lê tentativas/ultima_tentativa dos
-- tracking_ids da janela; o índice serve a varredura por elegibilidade.
CREATE INDEX IF NOT EXISTS idx_sku_items_sync_controle_fila
  ON public.sku_items_sync_controle (tentativas, ultima_tentativa);

-- RLS: tabela de infraestrutura de sync, sem leitor no app. Deny-all para
-- anon/authenticated (service-role da edge bypassa RLS).
ALTER TABLE public.sku_items_sync_controle ENABLE ROW LEVEL SECURITY;

-- REVOKE FROM PUBLIC não tira anon/authenticated (grant explícito do Supabase):
-- revogar POR NOME, senão a tabela fica legível por qualquer JWT. (CLAUDE.md §RLS)
REVOKE ALL ON public.sku_items_sync_controle FROM PUBLIC;
REVOKE ALL ON public.sku_items_sync_controle FROM anon;
REVOKE ALL ON public.sku_items_sync_controle FROM authenticated;
