// Helper de formatação dos bundles do Farmer.
// Extraído verbatim de src/pages/FarmerBundles.tsx (god-component split).

export const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
