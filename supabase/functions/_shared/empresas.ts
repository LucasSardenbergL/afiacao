// Empresas operacionais suportadas pelos syncs do Omie.
// "ALL" (usado pelos crons baseline — ver migration 20260527230000_cron_baseline.sql)
// expande para todas. Centralizado aqui para que toda edge resolva o parâmetro
// `empresa` do mesmo jeito (o cron de status-produtos quebrou em silêncio por meses
// mandando empresa=ALL para uma edge que só aceitava OBEN/COLACOR → 400 pré-handler).
export const EMPRESAS_VALIDAS = ["OBEN", "COLACOR"] as const;
export type Empresa = (typeof EMPRESAS_VALIDAS)[number];

// Resolve o parâmetro `empresa` (query/body) para a lista de empresas a processar:
//  - vazio/ausente → ["OBEN"]  (default seguro; o invoke do front manda empresa explícita)
//  - "ALL"         → todas as empresas suportadas (o cron baseline manda ALL)
//  - empresa válida→ [ela]
//  - inválido      → null      (o chamador responde 400)
export function resolverEmpresas(input: string | null | undefined): Empresa[] | null {
  if (!input) return ["OBEN"];
  const up = input.toUpperCase();
  if (up === "ALL") return [...EMPRESAS_VALIDAS];
  if ((EMPRESAS_VALIDAS as readonly string[]).includes(up)) return [up as Empresa];
  return null;
}
