-- Migration 1 — tipo_produto como COLUNA dedicada de omie_products
-- ============================================================================
-- Tira o sinal money-path do metadata jsonb COMPARTILHADO (que 4 syncs descritivos
-- — omie-analytics-sync / omie-sync-metadados / sync-reprocess / tint-omie-sync —
-- sobrescreviam inteiro, zerando o tipo_produto). Confirmado em prod 2026-06-04:
-- 0/3651 produtos OBEN tinham a chave 'tipo_produto' no jsonb (a chave nem existia),
-- enquanto 3651/3651 tinham 'cfop'/'inativo_omie' → o último writer foi sempre um
-- descritivo. Coluna dedicada: writer que não a inclui no payload do upsert NÃO a
-- toca; só o writer autoritativo (omie-sync-metadados) escreve.
-- Spec: docs/superpowers/specs/2026-06-04-tipo-produto-coluna-dedicada-design.md
-- Idempotente / re-rodável. Aplicar manual via SQL Editor do Lovable.
-- ============================================================================

ALTER TABLE public.omie_products ADD COLUMN IF NOT EXISTS tipo_produto text;

COMMENT ON COLUMN public.omie_products.tipo_produto IS
  'Tipo fiscal do item no Omie (tipoItem/SPED): 04=Produto Acabado (FABRICADO, nunca comprar), 00=Revenda (comprável), NULL=desconhecido/comprável. Coluna dedicada — só o omie-sync-metadados escreve. NÃO usar metadata->>tipo_produto (legado, sujeito a sobrescrita por syncs concorrentes). Spec 2026-06-04.';

-- Índice das queries da guarda (tipo_produto='04' por account).
CREATE INDEX IF NOT EXISTS idx_omie_products_account_tipo_produto
  ON public.omie_products (account, tipo_produto) WHERE tipo_produto IS NOT NULL;

-- Trigger anti-null-clobber (defesa em profundidade, codex): se um writer mandar a
-- coluna como NULL mas já existia valor, preserva o valor anterior. Reescrita
-- legítima de valor (ex.: '04'->'00' por reclassificação no Omie) passa normalmente;
-- só o APAGAMENTO acidental é bloqueado.
CREATE OR REPLACE FUNCTION public.preserve_tipo_produto()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tipo_produto IS NULL AND OLD.tipo_produto IS NOT NULL THEN
    NEW.tipo_produto := OLD.tipo_produto;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_preserve_tipo_produto ON public.omie_products;
CREATE TRIGGER trg_preserve_tipo_produto
  BEFORE UPDATE ON public.omie_products
  FOR EACH ROW
  EXECUTE FUNCTION public.preserve_tipo_produto();

-- Validação
SELECT 'MIGRATION 1 OK' AS status,
  (SELECT count(*) FROM information_schema.columns
     WHERE table_schema='public' AND table_name='omie_products' AND column_name='tipo_produto') AS coluna,
  (SELECT count(*) FROM pg_trigger WHERE tgname='trg_preserve_tipo_produto') AS trigger,
  (SELECT count(*) FROM pg_indexes WHERE indexname='idx_omie_products_account_tipo_produto') AS indice;
