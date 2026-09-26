/**
 * migrations-da-ref.ts — TODAS as migrations de um commit, lidas da árvore do git (nunca do disco).
 *
 * Extraído de `scripts/pendencias-pacote.ts` (#2428) sem mudança de comportamento, para servir
 * também ao sensor `deriva:corpo:prod` — duas cópias do leitor divergiriam calmamente, e a
 * divergência apareceria como "esta função não tem DDL commitada".
 */
import type { MigrationLida } from './corpo-esperado';
import type { ExecutorGitBytes } from '../pendencias-prompt';

/** Onde as migrations vivem na árvore. Uma constante porque o `git grep` e o `ls-tree` a repetem. */
const DIR_MIGRATIONS = 'supabase/migrations';

/**
 * TODAS as migrations da ref, lidas do commit `sha`.
 *
 * 🔴 Do commit, não do `working tree`, e não da REF pelo NOME. Ler do disco reencena o #2427 (o
 * gate media um `index.ts` que ninguém ia deployar); ler por `origin/main` reencena o mesmo defeito
 * um andar acima — a ref é MUTÁVEL, outra worktree pode movê-la no meio desta execução, e aí as
 * edges saem de um commit e as migrations de outro. O `sha` já foi resolvido uma vez pelo
 * `sincronizarRef`; é ele que manda em tudo (achado do Codex).
 *
 * 🔴 TODAS, e não as que um filtro escolher. A primeira versão filtrava candidatos com
 * `git grep -l -E "\\b(nome1|nome2)\\b"` — e `\b` **não é word-boundary em POSIX ERE**, então o
 * grep casou ZERO arquivos, saiu 1 sem escrever em stderr, e o código leu isso como "nenhum
 * candidato". O gate rodou contra prod inteiro, encontrou o histórico VAZIO e liberou a leva:
 * fail-open silencioso, a mesma classe que este PR existe para fechar, reencenada dentro dele.
 * Foi pego rodando contra prod, não pelos testes — que passavam todos.
 *
 * O conserto não foi tirar o `\b`: foi tirar o FILTRO. `git cat-file --batch` lê os 721 arquivos
 * (6,4 MB) num spawn só em **0,05s** — mais rápido que o `git grep` que o filtro economizava. Um
 * otimizador com um modo de falha silencioso não estava pagando por si.
 *
 * O controle positivo é a CONTAGEM: cada blob pedido tem de voltar. Um `--batch` que devolva menos
 * do que se pediu é árvore mudando sob os pés, e lança — nunca vira um histórico curto que se leria
 * como "esta função não tem DDL commitada".
 */
export function migrationsDaRef(git: ExecutorGitBytes, sha: string): MigrationLida[] {
  const inv = git(['ls-tree', '-r', sha, '--', `${DIR_MIGRATIONS}/`]);
  if (!inv.ok) throw new Error(`git ls-tree em ${sha} falhou: ${inv.erro.trim() || 'sem stderr'}`);

  // `<mode> SP <type> SP <oid> TAB <path>` — a ordem lexical do path é a ordem de apply.
  const entradas = inv.bytes
    .toString('utf8')
    .split('\n')
    .flatMap((linha) => {
      const [meta, caminho] = linha.split('\t');
      const oid = meta?.split(' ')[2];
      if (oid === undefined || caminho === undefined || !caminho.endsWith('.sql')) return [];
      return [{ oid, nome: caminho.slice(`${DIR_MIGRATIONS}/`.length) }];
    })
    .sort((a, b) => a.nome.localeCompare(b.nome, 'en'));

  if (entradas.length === 0) {
    throw new Error(
      `nenhuma migration em ${sha}:${DIR_MIGRATIONS}/ — é o inventário quebrado, não um repo sem ` +
        'DDL; sem histórico o eixo de corpo não teria com o que comparar e liberaria a leva',
    );
  }

  const lote = git(['cat-file', '--batch'], `${entradas.map((e) => e.oid).join('\n')}\n`);
  if (!lote.ok) throw new Error(`git cat-file em ${sha} falhou: ${lote.erro.trim() || 'sem stderr'}`);

  const lidas = lerLoteDeBlobs(lote.bytes, entradas);
  if (lidas.length !== entradas.length) {
    throw new Error(
      `git cat-file devolveu ${lidas.length} de ${entradas.length} migrations — leitura PARCIAL; ` +
        'um histórico curto se leria como "esta função não tem DDL commitada"',
    );
  }
  return lidas;
}

/**
 * Desempacota a saída do `git cat-file --batch`: por objeto, `<oid> SP <type> SP <size> LF`, os
 * `size` bytes do conteúdo, e um LF. Fatiar por TAMANHO (e não procurar o próximo cabeçalho) é o
 * que torna o parser imune a um `.sql` que contenha algo parecido com um cabeçalho.
 *
 * Para no primeiro registro malformado em vez de pular: quem chama compara a contagem, e uma
 * varredura que "se recupera" devolveria uma lista curta com cara de completa.
 */
function lerLoteDeBlobs(
  saida: Buffer,
  entradas: readonly { oid: string; nome: string }[],
): MigrationLida[] {
  const fora: MigrationLida[] = [];
  let pos = 0;
  for (const entrada of entradas) {
    const fimCabecalho = saida.indexOf(0x0a, pos);
    if (fimCabecalho < 0) return fora;
    const partes = saida.toString('utf8', pos, fimCabecalho).split(' ');
    // `<oid> missing` tem 2 campos; um blob tem 3. Qualquer outra coisa é formato que não conheço.
    if (partes.length !== 3 || partes[1] !== 'blob') return fora;
    const tamanho = Number.parseInt(partes[2], 10);
    if (!Number.isFinite(tamanho) || tamanho < 0) return fora;
    const ini = fimCabecalho + 1;
    if (ini + tamanho > saida.length) return fora;
    fora.push({ nome: entrada.nome, sql: saida.toString('utf8', ini, ini + tamanho) });
    pos = ini + tamanho + 1; // +1 pelo LF que o git põe depois do conteúdo
  }
  return fora;
}
