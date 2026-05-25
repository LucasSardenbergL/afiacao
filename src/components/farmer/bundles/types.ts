// Tipos locais dos bundles do Farmer.
// Extraídos verbatim de src/pages/FarmerBundles.tsx (god-component split).

export interface CustomerCtx {
  name: string;
  healthScore: number;
  avgMonthlySpend: number | null;
  categoryCount: number | null;
  daysSinceLastPurchase: number | null;
  cnae: string | null;
  customerType: string | null;
  recentProducts: string[] | null;
}
