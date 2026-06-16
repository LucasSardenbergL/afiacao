-- ============================================================
-- fin_sync_cursor.backfill_desde — janela de backfill persistida no cursor
-- Objetivo: backfill histórico de movimentações Omie sem footgun de deploy.
-- Spec: docs/superpowers/specs/2026-05-27-omie-baixa-date-root-fix-design.md
-- ============================================================
-- A janela de data das movimentações é aplicada CLIENT-SIDE no sync (não vai
-- pro Omie), então o cursor de paginação é consistente independentemente dela.
-- Persistir a janela de backfill no cursor faz a continuação `*/10` (que invoca
-- só {action, company}) herdar a janela ampla durante o backfill, sem precisar
-- mudar o default da main nem reverter deploy. NULL = modo incremental normal.
-- Coluna NEUTRA pra CR/CP (eles não usam — seus endpoints não filtram por data).

ALTER TABLE public.fin_sync_cursor
  ADD COLUMN IF NOT EXISTS backfill_desde date;
