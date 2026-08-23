import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SUITES_FORA_DO_CI } from './hooks-suites-baseline';

/**
 * Vigia de FORMA: toda suíte `scripts/test-*.sh` tem de ser EXECUTADA pelo `test:hooks`.
 *
 * Por quê: até 2026-08-19 existiam 7 suítes de guard e o loop rodava 5 — `destructive-bash` e
 * `migration-immutability` eram órfãs. Teste que existe e não roda é AUSÊNCIA DE DADO, não
 * aprovação: o guard podia regredir sem nada ficar vermelho. (Foi assim que o #1770 quebrou o CI —
 * o heavy-guard só passou a rodar no #1778.) Criar o script e esquecer o loop é o erro natural;
 * este teste é o que o torna impossível de passar despercebido.
 *
 * ⚠️ 2026-08-22: a versão anterior deste vigia tinha o MESMO buraco que denunciava. O `test:hooks`
 * tem DOIS laços (`test-$t-guard.sh` e `test-$t.sh`) e o vigia só lia o PRIMEIRO — a metade sem
 * sufixo `-guard` não era coberta por ninguém. Resultado: 9 suítes órfãs (inclusive
 * `test-lovable-revert-scan.sh`, que PARECIA coberta porque o `lovable-watch.yml` cita o nome
 * dela — num COMENTÁRIO; o workflow roda o script de produção, não a suíte). Daí a forma atual:
 * em vez de extrair `<x>`, o parser expande cada laço para os ARQUIVOS que ele executa e compara
 * conjunto-a-conjunto com o disco. O molde do nome sai do CORPO do laço, então um 3º laço com
 * outro padrão passa a ser coberto sozinho, sem editar este arquivo.
 */

const RAIZ = join(import.meta.dirname, '..');

/**
 * Expande os `for VAR in a b c; do ... scripts/test-$VAR....sh ... done` de um comando de shell
 * para a lista de ARQUIVOS que ele de fato executa. Lê TODOS os laços, e tira o molde do nome do
 * corpo de cada um — não presume sufixo.
 */
export function arquivosExecutados(cmd: string): string[] {
  const encontrados: string[] = [];
  const laco = /for\s+(\w+)\s+in\s+([^;]+);\s*do\b([\s\S]*?)\bdone\b/g;
  for (const [, variavel, lista, corpo] of cmd.matchAll(laco)) {
    const alvos = lista.trim().split(/\s+/).filter(Boolean);
    const cifra = `\\$\\{?${variavel}\\}?`;
    const molde = new RegExp(`scripts/([A-Za-z0-9_.-]*${cifra}[A-Za-z0-9_.-]*\\.sh)`, 'g');
    for (const [, template] of corpo.matchAll(molde)) {
      for (const alvo of alvos) {
        encontrados.push(template.replace(new RegExp(cifra), alvo));
      }
    }
  }
  return [...new Set(encontrados)].sort();
}

/** Toda suíte de shell presente no diretório `scripts/`. */
export function suitesNoDisco(arquivos: string[]): string[] {
  return arquivos.filter((f) => /^test-.+\.sh$/.test(f)).sort();
}

describe('arquivosExecutados — parser', () => {
  it('expande o laço para os arquivos, com o sufixo que estiver no corpo', () => {
    expect(
      arquivosExecutados('for t in a b c; do bash scripts/test-$t-guard.sh || exit 1; done'),
    ).toEqual(['test-a-guard.sh', 'test-b-guard.sh', 'test-c-guard.sh']);
  });

  it('lê os DOIS laços do test:hooks — foi este o buraco (o 2º não era coberto)', () => {
    expect(
      arquivosExecutados(
        'for t in a; do bash scripts/test-$t-guard.sh || exit 1; done; ' +
          'for t in x y; do bash scripts/test-$t.sh || exit 1; done',
      ),
    ).toEqual(['test-a-guard.sh', 'test-x.sh', 'test-y.sh']);
  });

  it('não presume o nome da variável nem o sufixo (um 3º laço se cobre sozinho)', () => {
    expect(
      arquivosExecutados('for suite in k; do bash scripts/test-${suite}-lento.sh; done'),
    ).toEqual(['test-k-lento.sh']);
  });

  it('devolve vazio quando o comando não tem laço (não finge cobertura)', () => {
    expect(arquivosExecutados('bun run algo-outro')).toEqual([]);
  });
});

describe('suitesNoDisco — parser', () => {
  it('pega TODO test-*.sh e ignora o resto de scripts/', () => {
    expect(
      suitesNoDisco(['test-heavy-guard.sh', 'pr-watch.sh', 'test-wt-reap.sh', 'x.test.ts']),
    ).toEqual(['test-heavy-guard.sh', 'test-wt-reap.sh']);
  });
});

describe('cobertura real: package.json x scripts/', () => {
  const pkg = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const executados = arquivosExecutados(pkg.scripts['test:hooks'] ?? '');
  const noDisco = suitesNoDisco(readdirSync(join(RAIZ, 'scripts')));
  const baseline = SUITES_FORA_DO_CI.map((s) => s.arquivo);

  it('os laços do test:hooks não estão vazios (falsifica um regex que casou com nada)', () => {
    expect(executados.length).toBeGreaterThan(0);
  });

  it('o parser enxerga os DOIS laços (um regex só do 1º passaria sem ver metade)', () => {
    expect(executados.some((f) => f.endsWith('-guard.sh'))).toBe(true);
    expect(executados.some((f) => !f.endsWith('-guard.sh'))).toBe(true);
  });

  it('nenhuma suíte é ÓRFÃ — todo scripts/test-*.sh roda, ou está na baseline com motivo', () => {
    const orfas = noDisco.filter((f) => !executados.includes(f) && !baseline.includes(f));
    expect(
      orfas,
      `Suíte(s) que NINGUÉM roda: ${orfas.join(', ')}. ` +
        `Acrescente ao \`for t in ...\` do script "test:hooks" no package.json — ou, se de fato ` +
        `não puder rodar no runner ubuntu, a scripts/hooks-suites-baseline.ts COM o motivo.`,
    ).toEqual([]);
  });

  it('nenhum alvo dos laços é FANTASMA — todo arquivo citado existe em disco', () => {
    const fantasmas = executados.filter((f) => !noDisco.includes(f));
    expect(
      fantasmas,
      `Os laços citam arquivo(s) inexistente(s): ${fantasmas.join(', ')}. ` +
        `O \`bash\` de um caminho inexistente sai 127 e derruba o CI.`,
    ).toEqual([]);
  });

  it('burn-down: entrada da baseline que voltou a rodar sai da baseline', () => {
    const redundantes = baseline.filter((f) => executados.includes(f));
    expect(
      redundantes,
      `Estas já rodam no test:hooks e não são mais exceção: ${redundantes.join(', ')}. ` +
        `Remova de scripts/hooks-suites-baseline.ts — baseline que não encolhe vira álibi.`,
    ).toEqual([]);
  });

  it('burn-down: entrada da baseline que sumiu do disco sai da baseline', () => {
    const podres = baseline.filter((f) => !noDisco.includes(f));
    expect(
      podres,
      `A baseline isenta suíte(s) que não existem mais: ${podres.join(', ')}. ` +
        `Remova de scripts/hooks-suites-baseline.ts.`,
    ).toEqual([]);
  });

  it('toda isenção da baseline tem motivo de verdade (não "TODO")', () => {
    const semMotivo = SUITES_FORA_DO_CI.filter((s) => s.motivo.trim().length < 40).map(
      (s) => s.arquivo,
    );
    expect(
      semMotivo,
      `Isenção sem motivo explicado: ${semMotivo.join(', ')}.`,
    ).toEqual([]);
  });
});
