// Leitura em LOTES de ids (plataforma): o `.in()` do PostgREST com milhares de UUIDs estoura o limite
// de URL do proxy, então quem lê por id quebra em lotes. Extraído de lib/carteira/escopo-clientes na
// onda E de clientes (a lista e o último contato, de módulos diferentes, usam os mesmos helpers).

export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk: size deve ser > 0');
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Lotes em voo ao mesmo tempo (onda E): a carteira de ~2.8k clientes são 19 lotes — em série, 19 RTTs
 *  antes da 1ª linha. 4 em voo corta para 5 sem disparar rajada (a ordem e o teto de 1.000 não mudam:
 *  cada lote tem 150 ids e 1 linha por id; `coletarEmLotesConcorrente` remonta na ordem dos lotes). */
export const CONCORRENCIA_LOTES = 4;

/**
 * Quebra ids em lotes de `size`, com até `concorrencia` lotes em voo. Preserva a ORDEM dos lotes no
 * resultado e propaga o erro de qualquer lote (nunca devolve conjunto parcial). O "Meu dia" do gestor
 * lê ~13k clientes por id (85 lotes): sequencial seria um lote por vez.
 */
export async function coletarEmLotesConcorrente<I, O>(
  ids: I[],
  size: number,
  concorrencia: number,
  fetchLote: (lote: I[]) => Promise<O[]>,
): Promise<O[]> {
  if (concorrencia <= 0) throw new Error('coletarEmLotesConcorrente: concorrencia deve ser > 0');
  const lotes = chunk(ids, size);
  const resultados: O[][] = new Array(lotes.length);
  let proximo = 0;
  const trabalhador = async () => {
    while (proximo < lotes.length) {
      const i = proximo++;
      resultados[i] = await fetchLote(lotes[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concorrencia, lotes.length) }, trabalhador));
  return resultados.flat();
}

/** Hash estável e barato dos IDs visíveis. A contagem sozinha não pega reatribuição
 *  que mantém o tamanho (cliente sai/entra, length igual); o hash muda se qualquer id
 *  mudar. Usado na queryKey dos scores p/ não reusar o map do conjunto anterior. */
export function hashIds(ids: string[]): string {
  let h = 0;
  for (const id of ids) {
    for (let i = 0; i < id.length; i++) {
      h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
    }
  }
  return `${ids.length}:${h}`;
}
