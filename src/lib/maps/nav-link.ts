/**
 * Monta um link de navegação Waze a partir de coordenadas ou, na falta, de um
 * endereço-texto. Retorna null quando não há nem coords nem endereço utilizável
 * (o call-site esconde o botão "Ir").
 */
export function navLink(
  addressQuery: string | null | undefined,
  lat?: number | null,
  lng?: number | null,
): string | null {
  if (lat != null && lng != null) {
    return `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
  }
  const q = (addressQuery ?? '').trim();
  if (q.length === 0) return null;
  return `https://waze.com/ul?q=${encodeURIComponent(q)}&navigate=yes`;
}
