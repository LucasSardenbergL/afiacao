// Interpreta a resposta da edge `cep-geo-resolver` para o worker do roteirizador.
// Money-path (mapa de visita do vendedor): só adota coord se a edge marcou
// resolved=true E lat/lng são números FINITOS — NUNCA fabrica pino a partir de
// resposta ausente/garbage (ausente ≠ zero; sem coerção de string→número). No
// miss devolve null → o worker mantém o pino aproximado do centróide do município.
export interface CoordResolvida {
  lat: number;
  lng: number;
  precisao: string;
}

export function interpretarResolver(data: unknown): CoordResolvida | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.resolved !== true) return null;
  const { lat, lng } = d;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const precisao = typeof d.precision === 'string' && d.precision ? d.precision : 'postcode_centroid';
  return { lat, lng, precisao };
}
