// Tipos + constantes da tela de revisão de parâmetros de reposição.
// Extraídos verbatim de src/pages/AdminReposicaoRevisao.tsx (god-component split).
import type { Database } from "@/integrations/supabase/types";
import type { VariantProps } from "class-variance-authority";
import type { badgeVariants } from "@/components/ui/badge";

export type SkuSugeridoView = Database["public"]["Views"]["v_sku_parametros_sugeridos"]["Row"];
export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

export const PAGE_SIZE = 25;

export const CLASSE_OPTIONS = ["AX", "AY", "AZ", "BX", "BY", "BZ", "CX", "CY", "CZ"];
