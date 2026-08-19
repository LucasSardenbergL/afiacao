import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Vigia de FORMA: todo `scripts/test-<x>-guard.sh` tem de estar no `for t in ...` do `test:hooks`.
 *
 * Por quê: até 2026-08-19 existiam 7 suítes de guard e o loop rodava 5 — `destructive-bash` e
 * `migration-immutability` eram órfãs. Teste que existe e não roda é AUSÊNCIA DE DADO, não
 * aprovação: o guard podia regredir sem nada ficar vermelho. (Foi assim que o #1770 quebrou o CI —
 * o heavy-guard só passou a rodar no #1778.) Criar o script e esquecer o loop é o erro natural;
 * este teste é o que o torna impossível de passar despercebido.
 */

const RAIZ = join(import.meta.dirname, '..');

/** Extrai os `<x>` do `for t in <x> <y> ...;` do comando `test:hooks`. */
export function alvosDoLoop(cmd: string): string[] {
  const m = /for\s+t\s+in\s+([^;]+);/.exec(cmd);
  if (!m) return [];
  return m[1].trim().split(/\s+/).filter(Boolean);
}

/** Extrai os `<x>` de cada `test-<x>-guard.sh` presente no diretório. */
export function alvosNoDisco(arquivos: string[]): string[] {
  return arquivos
    .map((f) => /^test-(.+)-guard\.sh$/.exec(f)?.[1])
    .filter((x): x is string => Boolean(x))
    .sort();
}

describe('alvosDoLoop — parser', () => {
  it('lê a lista do for', () => {
    expect(alvosDoLoop('for t in a b c; do bash scripts/test-$t-guard.sh || exit 1; done')).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('devolve vazio quando o comando não tem o for (não finge cobertura)', () => {
    expect(alvosDoLoop('bun run algo-outro')).toEqual([]);
  });
});

describe('alvosNoDisco — parser', () => {
  it('pega só os test-*-guard.sh e ignora o resto de scripts/', () => {
    expect(
      alvosNoDisco(['test-heavy-guard.sh', 'pr-watch.sh', 'test-pr-collision-guard.sh', 'x.test.ts']),
    ).toEqual(['heavy', 'pr-collision']);
  });
});

describe('cobertura real: package.json x scripts/', () => {
  const pkg = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const noLoop = alvosDoLoop(pkg.scripts['test:hooks'] ?? '').sort();
  const noDisco = alvosNoDisco(readdirSync(join(RAIZ, 'scripts')));

  it('o loop do test:hooks não está vazio (falsifica um regex que casou com nada)', () => {
    expect(noLoop.length).toBeGreaterThan(0);
  });

  it('nenhuma suíte de guard é ÓRFÃ — todo test-<x>-guard.sh está no loop', () => {
    const orfaos = noDisco.filter((x) => !noLoop.includes(x));
    expect(
      orfaos,
      `Suíte(s) de guard que NINGUÉM roda: ${orfaos.join(', ')}. ` +
        `Acrescente ao \`for t in ...\` do script "test:hooks" no package.json.`,
    ).toEqual([]);
  });

  it('nenhum alvo do loop é FANTASMA — todo <x> do for tem script em disco', () => {
    const fantasmas = noLoop.filter((x) => !noDisco.includes(x));
    expect(
      fantasmas,
      `O loop cita alvo(s) sem scripts/test-<x>-guard.sh: ${fantasmas.join(', ')}. ` +
        `O \`bash\` de um caminho inexistente sai 127 e derruba o CI.`,
    ).toEqual([]);
  });
});
