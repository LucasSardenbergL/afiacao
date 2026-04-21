/**
 * Helpers para agrupamento de listas por mês/ano (YYYY-MM).
 *
 * Usado nas páginas /admin/reposicao/promocoes e /admin/reposicao/aumentos
 * para apresentar registros agrupados em headers mensais, com mostragem
 * de meses vazios entre o mês mais antigo e o mês atual.
 */

const MESES_PT = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];

/** Extrai a chave YYYY-MM de uma data ISO (YYYY-MM-DD ou ISO completo). */
export function chaveMes(data: string | null | undefined): string | null {
  if (!data) return null;
  const m = data.match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}`;
}

/** "2026-04" -> "Abril 2026". */
export function formatarMesAno(chave: string): string {
  const [ano, mes] = chave.split("-");
  const idx = parseInt(mes, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx > 11) return chave;
  return `${MESES_PT[idx]} ${ano}`;
}

/** Chave YYYY-MM do mês corrente. */
export function chaveMesAtual(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Gera todas as chaves YYYY-MM entre dois meses (inclusive),
 * ordenadas do mais recente para o mais antigo.
 */
export function gerarRangeMeses(
  chaveMaisAntiga: string,
  chaveMaisRecente: string,
): string[] {
  const [ay, am] = chaveMaisAntiga.split("-").map(Number);
  const [ry, rm] = chaveMaisRecente.split("-").map(Number);
  if (!ay || !am || !ry || !rm) return [];

  const out: string[] = [];
  let y = ry;
  let m = rm;
  while (y > ay || (y === ay && m >= am)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
    // safeguard
    if (out.length > 600) break;
  }
  return out;
}

export type GrupoMensal<T> = {
  chave: string; // YYYY-MM
  label: string; // "Abril 2026"
  itens: T[];
  vazio: boolean;
};

/**
 * Agrupa uma lista por mês/ano (a partir de uma data extraída de cada item)
 * e retorna headers para todos os meses entre o mais antigo cadastrado e o
 * mês atual. Meses sem itens recebem `vazio: true`.
 *
 * Headers ordenados do mais recente para o mais antigo.
 */
export function agruparPorMes<T>(
  itens: T[],
  pegarData: (item: T) => string | null | undefined,
): GrupoMensal<T>[] {
  const mapa = new Map<string, T[]>();
  for (const it of itens) {
    const k = chaveMes(pegarData(it));
    if (!k) continue;
    const arr = mapa.get(k) ?? [];
    arr.push(it);
    mapa.set(k, arr);
  }

  const chavesComItens = Array.from(mapa.keys()).sort();
  if (chavesComItens.length === 0) return [];

  const maisAntigo = chavesComItens[0];
  const atual = chaveMesAtual();
  const maisRecente = chavesComItens[chavesComItens.length - 1] > atual
    ? chavesComItens[chavesComItens.length - 1]
    : atual;

  const range = gerarRangeMeses(maisAntigo, maisRecente);
  return range.map((chave) => {
    const lista = mapa.get(chave) ?? [];
    return {
      chave,
      label: formatarMesAno(chave),
      itens: lista,
      vazio: lista.length === 0,
    };
  });
}

/** Retorna o conjunto de chaves dos N meses mais recentes (ex.: últimos 3). */
export function chavesUltimosNMeses(n: number): Set<string> {
  const out = new Set<string>();
  const d = new Date();
  for (let i = 0; i < n; i++) {
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    out.add(`${y}-${String(m).padStart(2, "0")}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}
