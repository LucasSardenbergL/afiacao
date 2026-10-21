// O gerador do Supabase declara TODO argumento de RPC como não-nulo (e o que tem DEFAULT, como
// opcional sem `| null`). Só que várias RPCs ACEITAM NULL explícito e o NULL é semântico: "sem
// head visto", "sem motivo", "margem ausente" (ausente ≠ zero, CLAUDE.md). O jeito antigo era
// `args as never`, que desliga a checagem do objeto INTEIRO — chave errada, chave faltando e tipo
// trocado passavam verdes.
//
// `comNulo` reabre `| null` só nas chaves `K` que o call-site nomeia (cada uma conferida em prod,
// `pg_get_function_arguments`/corpo da função) e checa todo o resto contra o `types.ts`. A
// asserção final só estreita a nulidade dessas chaves: não há forma tipada de mandar NULL a
// argumento que o gerador declarou não-nulo. Mesma classe do residual de
// `src/services/picking-confirm.ts` (docs/historico/casts-estoque-recebimento.md).
import type { Database } from '@/integrations/supabase/types';

type Funcoes = Database['public']['Functions'];
type ArgsDe<N extends keyof Funcoes> = Funcoes[N]['Args'];

/** Args de `N` com as chaves `K` aceitando `null` (obrigatórias: o call-site diz o NULL explicitamente). */
type ArgsComNulo<N extends keyof Funcoes, K extends keyof ArgsDe<N>> = Omit<ArgsDe<N>, K> & {
  [P in K]-?: NonNullable<ArgsDe<N>[P]> | null;
};

/** `supabase.rpc('fn', comNulo<'fn', 'p_x'>({ ... }))` — ver o cabeçalho do arquivo. */
export function comNulo<N extends keyof Funcoes, K extends keyof ArgsDe<N>>(args: ArgsComNulo<N, K>): ArgsDe<N> {
  return args as ArgsDe<N>;
}
