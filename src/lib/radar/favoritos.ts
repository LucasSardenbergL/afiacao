// Favoritos de filtro do Radar: lógica pura (o componente é `RadarFavoritos`).

/** Os filtros da URL (`useUrlState`), sem a vista: o que um favorito guarda e reaplica. */
export type FiltrosSalvos = Record<string, string | boolean>;
export interface FavoritoRadar { nome: string; filtros: FiltrosSalvos }

export const MAX_FAVORITOS = 20;
export const chaveFavoritos = (userId: string) => `radar.favoritos.v1:${userId}`;

/** Só as chaves que a tela conhece, com o MESMO tipo do default; o resto volta ao default. Um favorito
 *  salvo numa versão antiga da tela (chave que sumiu, tipo que mudou) aplica o que ainda faz sentido. */
export function sanitizarFiltros(bruto: unknown, padrao: FiltrosSalvos): FiltrosSalvos {
  const out: FiltrosSalvos = { ...padrao };
  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) return out;
  const r = bruto as Record<string, unknown>;
  for (const k of Object.keys(padrao)) {
    const v = r[k];
    if (typeof v === typeof padrao[k]) out[k] = v as string | boolean;
  }
  return out;
}

/** Lê os favoritos do usuário. Storage bloqueado, JSON quebrado ou forma estranha = lista vazia
 *  (preferência local; perder é chato, não é dano). */
export function lerFavoritos(storage: Pick<Storage, 'getItem'> | null, userId: string, padrao: FiltrosSalvos): FavoritoRadar[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(chaveFavoritos(userId));
    if (!raw) return [];
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((f): f is { nome: string; filtros: unknown } =>
        typeof f === 'object' && f !== null && typeof (f as { nome?: unknown }).nome === 'string' && (f as { nome: string }).nome.trim() !== '')
      .slice(0, MAX_FAVORITOS)
      .map((f) => ({ nome: f.nome.trim(), filtros: sanitizarFiltros(f.filtros, padrao) }));
  } catch {
    return [];
  }
}

/** Grava; devolve false se o storage recusou (cheio, bloqueado) — a tela avisa. */
export function gravarFavoritos(storage: Pick<Storage, 'setItem'> | null, userId: string, lista: FavoritoRadar[]): boolean {
  if (!storage) return false;
  try {
    storage.setItem(chaveFavoritos(userId), JSON.stringify(lista));
    return true;
  } catch {
    return false;
  }
}

/** Acrescenta (ou substitui o de mesmo nome, sem caixa) no topo; corta no teto. */
export function comFavorito(lista: FavoritoRadar[], nome: string, filtros: FiltrosSalvos): FavoritoRadar[] {
  const n = nome.trim();
  const resto = lista.filter((f) => f.nome.toLowerCase() !== n.toLowerCase());
  return [{ nome: n, filtros }, ...resto].slice(0, MAX_FAVORITOS);
}

export function mesmosFiltros(a: FiltrosSalvos, b: FiltrosSalvos): boolean {
  const ks = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of ks) if (a[k] !== b[k]) return false;
  return true;
}
