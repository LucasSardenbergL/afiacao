-- Conserta o trigger de timestamp da sku_fornecedor_externo. O trigger
-- `sku_fornecedor_externo_set_atualizado_em` (BEFORE UPDATE) estava ligado à função
-- GENÉRICA `update_updated_at_column()`, que faz `NEW.updated_at = now()` — mas a tabela
-- usa a coluna `atualizado_em` (pt-BR), NÃO `updated_at`. Resultado: TODA UPDATE na tabela
-- falhava com `record "new" has no field "updated_at"` — inclusive o "editar mapeamento"
-- do app (que nunca funcionou; o founder só adicionava). O nome do trigger já dizia a
-- intenção certa ("set_atualizado_em"), só estava na função errada.
--
-- Fix: função dedicada que seta `atualizado_em` + repoint do trigger. Escopo confirmado =
-- só esta tabela tem o mismatch (não é sistêmico). A `update_updated_at_column` genérica
-- segue intacta pras tabelas que de fato têm `updated_at`.

CREATE OR REPLACE FUNCTION public.set_atualizado_em_column()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  NEW.atualizado_em = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sku_fornecedor_externo_set_atualizado_em ON public.sku_fornecedor_externo;
CREATE TRIGGER sku_fornecedor_externo_set_atualizado_em
  BEFORE UPDATE ON public.sku_fornecedor_externo
  FOR EACH ROW EXECUTE FUNCTION public.set_atualizado_em_column();
