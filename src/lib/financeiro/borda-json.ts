// Leitores de jsonb POR FORMA para a borda do financeiro. O types.ts gerado só sabe dizer `Json`; o jeito
// antigo era `as unknown as Tipo`, que aceitava chave ausente, tipo trocado e string no lugar de número.
// Contrato (CLAUDE.md, ausente ≠ zero): chave obrigatória ausente LANÇA; tipo trocado LANÇA; NULL só passa
// onde o tipo de destino declara `| null`; chave opcional ausente continua AUSENTE (nunca vira `undefined`
// explícito, que sobrescreveria default num spread). Chave extra é ignorada. Puro — testável sem cliente.
import type { Json } from '@/integrations/supabase/types';

export type ObjetoJson = { [k: string]: Json | undefined };
export type Leitor<T> = (v: Json | undefined, onde: string) => T;

const descrever = (v: Json | undefined) =>
  v === undefined ? 'ausente' : v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

function falha(onde: string, esperado: string, v: Json | undefined): never {
  throw new Error(`${onde}: esperava ${esperado}, veio ${descrever(v)}`);
}

export const objeto: Leitor<ObjetoJson> = (v, onde) =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? v : falha(onde, 'objeto', v);

/** Número FINITO de verdade — string numérica, NULL e NaN lançam (nada de `Number(v)`). */
export const numero: Leitor<number> = (v, onde) =>
  typeof v === 'number' && Number.isFinite(v) ? v : falha(onde, 'número', v);

export const texto: Leitor<string> = (v, onde) => (typeof v === 'string' ? v : falha(onde, 'texto', v));

export const booleano: Leitor<boolean> = (v, onde) => (typeof v === 'boolean' ? v : falha(onde, 'booleano', v));

export function anulavel<T>(ler: Leitor<T>): Leitor<T | null> {
  return (v, onde) => (v === null ? null : ler(v, onde));
}

export function lista<T>(ler: Leitor<T>): Leitor<T[]> {
  return (v, onde) => (Array.isArray(v) ? v.map((e, i) => ler(e, `${onde}[${i}]`)) : falha(onde, 'array', v));
}

export function registro<T>(ler: Leitor<T>): Leitor<Record<string, T>> {
  return (v, onde) => {
    const o = objeto(v, onde);
    const out: Record<string, T> = {};
    for (const [k, x] of Object.entries(o)) if (x !== undefined) out[k] = ler(x, `${onde}.${k}`);
    return out;
  };
}

export function uniao<const T extends readonly string[]>(permitidos: T): Leitor<T[number]> {
  const ok = (s: string): s is T[number] => permitidos.includes(s);
  return (v, onde) => {
    const s = texto(v, onde);
    if (!ok(s)) throw new Error(`${onde}: valor fora do vocabulário "${s}" (aceitos: ${permitidos.join('|')})`);
    return s;
  };
}

/** Chave obrigatória. */
export function campo<T>(o: ObjetoJson, chave: string, ler: Leitor<T>, onde: string): T {
  return ler(o[chave], `${onde}.${chave}`);
}

/**
 * Chave opcional: ausente → nada é escrito em `destino` (a chave continua ausente); presente → lida por `ler`.
 * Devolve `destino` para encadear.
 */
export function opcional<D extends object, K extends keyof D & string>(
  destino: D,
  o: ObjetoJson,
  chave: K,
  ler: Leitor<D[K]>,
  onde: string,
): D {
  const v = o[chave];
  if (v !== undefined) destino[chave] = ler(v, `${onde}.${chave}`);
  return destino;
}
