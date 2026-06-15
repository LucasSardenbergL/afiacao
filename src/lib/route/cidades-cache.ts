// Cache local (localStorage) da lista de cidades do Radar para o seletor do
// Roteirizador. A lista muda pouco (dump RFB ~mensal + status de leads 1×/vez) e
// staleness de horas é aceitável pra "onde caçar" → vale exibir do cache na hora
// (stale-while-revalidate). Estes helpers são PUROS (parse/serialize + checagem
// de TTL recebendo o relógio por parâmetro) pra serem testáveis; o hook injeta
// Date.now() e o localStorage.
import type { CityOption } from '@/components/reposicao/routePlanner/types';

export interface CidadesCacheEntry {
  data: CityOption[];
  ts: number; // epoch ms de quando foi gravado
}

/** Lê o cache cru do localStorage: retorna a entrada se válida E dentro do TTL; senão null. */
export function parseCidadesCache(
  raw: string | null,
  agoraMs: number,
  ttlMs: number,
): CidadesCacheEntry | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== 'object') return null;
    const obj = p as { data?: unknown; ts?: unknown };
    if (!Array.isArray(obj.data) || typeof obj.ts !== 'number') return null;
    if (agoraMs - obj.ts > ttlMs) return null; // expirado
    return { data: obj.data as CityOption[], ts: obj.ts };
  } catch {
    return null;
  }
}

/** Serializa a lista + timestamp para gravar no localStorage. */
export function serializeCidadesCache(data: CityOption[], ts: number): string {
  return JSON.stringify({ data, ts });
}
