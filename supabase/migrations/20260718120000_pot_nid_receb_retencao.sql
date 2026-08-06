-- Retenção do nIdReceb: sinal do recebimento sai do jsonb multi-writer para coluna dedicada.
--
-- PROBLEMA (assinatura medida no fin_sync_log): o contador
-- `nfes_identificadas_para_backfill` do omie-sync-nfes-recebidas fica TRAVADO no mesmo
-- valor por dias, apesar de dezenas de reparos bem-sucedidos por dia. Trabalho cumulativo
-- que não acumula = trabalho sendo DESFEITO por um escritor concorrente.
--
-- A causa: `purchase_orders_tracking.raw_data` é jsonb MULTI-WRITER.
--   1) omie-sync-pedidos-compra grava o payload do PEDIDO (sem nIdReceb) — e `raw_data`
--      NÃO está no PRESERVE_FIELDS dele, então o upsert apaga o sinal;
--   2) omie-sync-nfes-recebidas resolve de novo via ConsultarRecebimento(cChaveNFe) e
--      regrava o payload do RECEBIMENTO (com nIdReceb);
--   3) omie-sync-sku-items só LÊ o sinal.
-- A cada rodada do cron o passo 1 desfaz o passo 2. O backfill repara eternamente, nunca
-- converge, e queima o orçamento de rate-limit da Omie em linhas que já estavam prontas —
-- enquanto as que de fato precisam ficam por inanição.
--
-- É a armadilha que o CLAUDE.md já documenta, materializada: "sinal money-path nunca em
-- coluna jsonb multi-writer (upsert destrutivo) → coluna dedicada + 1 writer".
--
-- ⚠️ ORDEM DE DEPLOY: esta migration vem ANTES das edges. A edge nova referencia a coluna
-- (`.is('nid_receb', null)` e o select); subir a edge primeiro quebraria o sync. A migration
-- sozinha é inerte para as edges antigas (coluna nullable que ninguém lê).

ALTER TABLE public.purchase_orders_tracking
  ADD COLUMN IF NOT EXISTS nid_receb bigint;

COMMENT ON COLUMN public.purchase_orders_tracking.nid_receb IS
  'Recebimento (Omie nIdReceb) da NFe desta linha. Coluna DEDICADA com UM escritor '
  '(omie-sync-nfes-recebidas): o raw_data é jsonb multi-writer e o sync de pedidos o '
  'sobrescrevia, apagando o sinal a cada rodada e impedindo o backfill de convergir. '
  'NULL = ainda não resolvido (nunca fabricar: ausente ≠ zero).';

-- Backfill barato: o sinal que AINDA está no jsonb entra na coluna SEM chamar a Omie.
-- O regex é a trava de precisão — só numérico vira nid_receb. Qualquer outra coisa
-- (ausente, vazio, texto) permanece NULL: degradar, nunca fabricar.
UPDATE public.purchase_orders_tracking
SET nid_receb = (raw_data->'cabec'->>'nIdReceb')::bigint
WHERE nid_receb IS NULL
  AND raw_data->'cabec'->>'nIdReceb' ~ '^\d+$';

-- Índice do backfill: achar os pendentes sem varrer a tabela. O predicado espelha
-- exatamente o filtro do omie-sync-nfes-recebidas (linhas com NFe e sem sinal).
CREATE INDEX IF NOT EXISTS idx_pot_backfill_nid_receb
  ON public.purchase_orders_tracking (empresa, id)
  WHERE nfe_chave_acesso IS NOT NULL AND nid_receb IS NULL;
