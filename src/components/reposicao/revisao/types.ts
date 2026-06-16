// Tipos + constantes da tela de revisão de parâmetros de reposição.
// Extraídos verbatim de src/pages/AdminReposicaoRevisao.tsx (god-component split).
import type { Database } from "@/integrations/supabase/types";
import type { VariantProps } from "class-variance-authority";
import type { badgeVariants } from "@/components/ui/badge";

// Colunas da trilha CANDIDATO_PRIMEIRA_COMPRA (cold-start). Declaradas como opcionais aqui porque os
// types gerados do Supabase só as conhecem após a migration A1 ser aplicada + regenerada pelo Lovable.
// Quando isso acontecer, o `&` vira redundante (mesmos tipos) — inócuo.
type PrimeiraCompraCols = {
  tipo_sugestao?: string | null;
  recorrencia_meses_180d?: number | null;
  recorrencia_nfs_180d?: number | null;
  recorrencia_clientes_180d?: number | null;
  dias_desde_ultima_venda?: number | null;
  primeira_compra_qtde?: number | null;
  primeira_compra_ponto_pedido?: number | null;
  primeira_compra_estoque_maximo?: number | null;
  primeira_compra_cap_dias?: number | null;
  ja_habilitado?: boolean | null;
};
export type SkuSugeridoView = Database["public"]["Views"]["v_sku_parametros_sugeridos"]["Row"] &
  PrimeiraCompraCols;
export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

export const PAGE_SIZE = 25;

export const CLASSE_OPTIONS = ["AX", "AY", "AZ", "BX", "BY", "BZ", "CX", "CY", "CZ"];
