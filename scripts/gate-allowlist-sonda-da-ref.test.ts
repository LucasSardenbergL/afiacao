/**
 * GATE da classe "sensor que julga contra a ref mas lê DADO do disco"
 * (`docs/historico/sonda-le-worktree-defasado.md`).
 *
 * A classe reincidiu duas vezes em 2026-09-10, nos dois sensores que decidem pela allowlist do cron
 * de sonda: o `pendencias:deploy` imprimia `UPDATE … SET ativo = false` para edge que a main
 * aprovara (#2464) e o `sonda:sql` liberava o POST legado para edge que já tem o relé. A frase que
 * o doc tirou dali é o que este gate executa:
 *
 *   > Num sensor que julga contra a ref, todo IMPORT de dado do repo é uma segunda fonte de verdade.
 *   > `git show` tem cara de I/O; um `import { CONST }` tem cara de código — e por isso a varredura
 *   > por "leitura do repo" não o enxerga.
 *
 * Então o gate não mede prosa nem intenção: mede quem IMPORTA `_shared/sonda-cron-alvos` (o dado) ou
 * o lê do disco em shell. Quem precisa da allowlist para DECIDIR usa `scripts/lib/sonda-cron-allowlist.ts`,
 * que a lê na ref. A lista abaixo é fechada e cada entrada carrega o PORQUÊ; arquivo novo nela só
 * entra com a justificativa escrita, que é o momento em que alguém reencontra esta lição.
 *
 * LIMITE CONHECIDO, nomeado em vez de escondido: o gate cobre a allowlist do cron, não todo dado
 * versionado. Um sensor novo que importe OUTRA constante do repo para julgar contra a ref continua
 * passando — para esse eixo o que existe é a varredura do `/matar-classe` e o registro no doc.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { removerComentarios } from '@/lib/gates/limpeza-fonte';
import { removerComentariosShell } from '@/lib/gates/limpeza-shell';

const RAIZ = join(import.meta.dirname, '..');

/** Superfícies onde vive script que pode julgar contra a ref. */
const SUPERFICIES = ['scripts', 'db', '.claude'];

/**
 * Quem pode importar a allowlist do DISCO, e por quê. Fechada de propósito.
 *
 * Teste é livre: `*.test.ts` compara o parser com o import de propósito (é o contrato que prende o
 * parser ao formato real), e teste não serve veredito a ninguém.
 */
const IMPORTADORES_PERMITIDOS: Record<string, string> = {
  'scripts/pendencias-deploy.ts':
    'só alimenta `disco`, que NOMEIA a defasagem e VETA o UPDATE; quem julga é `allowlists.ref`',
  'scripts/sonda-cron-prova.ts':
    'julga o disco contra a história do próprio HEAD (disco × disco) — não tem ref como autoridade',
};

/** Import (estático ou dinâmico) do MÓDULO da allowlist — não a menção ao caminho num literal. */
const IMPORTA_ALLOWLIST = /(?:from|import\s*\()\s*['"][^'"]*sonda-cron-alvos(?:\.ts)?['"]/;

function arquivos(dir: string, extensoes: string[]): string[] {
  const achados: string[] = [];
  const pilha = [dir];
  while (pilha.length > 0) {
    const atual = pilha.pop() as string;
    for (const nome of readdirSync(atual)) {
      if (nome === 'node_modules' || nome === '.git' || nome === 'dist' || nome === 'worktrees') continue;
      const caminho = join(atual, nome);
      if (statSync(caminho).isDirectory()) pilha.push(caminho);
      else if (extensoes.some((e) => nome.endsWith(e))) achados.push(caminho);
    }
  }
  return achados;
}

describe('a allowlist do cron de sonda só é lida do DISCO por quem tem licença escrita', () => {
  const ts = SUPERFICIES.flatMap((s) => arquivos(join(RAIZ, s), ['.ts', '.mts', '.mjs'])).filter(
    (f) => !f.endsWith('.test.ts') && !f.endsWith('_test.ts'),
  );
  // Harness de teste e de eval fica de FORA, pela mesma razão que `*.test.ts`: ele FABRICA uma
  // allowlist de mentira num repo temporário para sabotar outro script. Não serve veredito a
  // ninguém — e `test-fecho-edges-pendentes.sh` escreve justamente o arquivo com este nome.
  const shell = SUPERFICIES.flatMap((s) => arquivos(join(RAIZ, s), ['.sh'])).filter((f) => {
    const nome = f.slice(f.lastIndexOf('/') + 1);
    return !nome.startsWith('test-') && !nome.endsWith('-eval.sh');
  });

  it('a varredura tem população — gate que não achou arquivo nenhum é gate cego', () => {
    expect(ts.length).toBeGreaterThan(50);
    expect(shell.length).toBeGreaterThan(10);
    // e o harness que FABRICA a allowlist de mentira ficou de fora de propósito (seria falso-positivo)
    expect(shell.map((f) => relative(RAIZ, f))).not.toContain('scripts/test-fecho-edges-pendentes.sh');
    // e enxerga os dois sensores desta lição, que são o controle da própria varredura
    const rel = ts.map((f) => relative(RAIZ, f));
    expect(rel).toContain('scripts/pendencias-deploy.ts');
    expect(rel).toContain('scripts/sonda-versao-sql.ts');
  });

  it('o detector DISCRIMINA — controle do próprio gate, versionado', () => {
    // Sem isto, "não achei nada" não se distingue de "não sei procurar": a varredura mais verde do
    // mundo é a que não casa nada. Aqui o padrão prova as DUAS pontas sobre texto fabricado.
    const pega = [
      "import { SONDA_CRON_ALVOS } from '../supabase/functions/_shared/sonda-cron-alvos';",
      "const { SONDA_CRON_ALVOS } = await import('../supabase/functions/_shared/sonda-cron-alvos');",
      'import { SONDA_CRON_ALVOS } from "../../supabase/functions/_shared/sonda-cron-alvos.ts";',
    ];
    for (const linha of pega) expect(IMPORTA_ALLOWLIST.test(linha), linha).toBe(true);

    const deixaPassar = [
      // o caminho como DADO (é o que a lib faz, e o que o `git show` recebe) não é import
      "export const ARQ_ALLOWLIST = 'supabase/functions/_shared/sonda-cron-alvos.ts';",
      'const r = git([\'show\', `${REF}:${ARQ_ALLOWLIST}`]);',
      "import { extrairAlvosDaAllowlist } from './lib/sonda-cron-allowlist';",
    ];
    for (const linha of deixaPassar) expect(IMPORTA_ALLOWLIST.test(linha), linha).toBe(false);

    // e o import em COMENTÁRIO não reprova: quem mede é o código, pelo stripper compartilhado
    const comentado = removerComentarios("// import { X } from '../supabase/functions/_shared/sonda-cron-alvos';\nconst a = 1;\n");
    expect(IMPORTA_ALLOWLIST.test(comentado)).toBe(false);
  });

  it('nenhum importador novo do dado do disco — quem decide lê a ref pela lib', () => {
    const intrusos: string[] = [];
    for (const arquivo of ts) {
      const cru = readFileSync(arquivo, 'utf8');
      if (!cru.includes('sonda-cron-alvos')) continue;
      // Stripper COMPARTILHADO, nunca regex local: o arquivo cita o módulo em comentário (a própria
      // lição está escrita lá dentro) e medir o texto cru ficaria vermelho pela PROSA.
      const codigo = removerComentarios(cru);
      expect(codigo.length, `stripper esvaziou ${arquivo}`).toBeGreaterThan(cru.length * 0.2);
      if (!IMPORTA_ALLOWLIST.test(codigo)) continue;
      const rel = relative(RAIZ, arquivo);
      if (IMPORTADORES_PERMITIDOS[rel] === undefined) intrusos.push(rel);
    }
    expect(
      intrusos,
      'importa `_shared/sonda-cron-alvos` (o DISCO). Se este arquivo decide algo contra `origin/main`, ' +
        'a allowlist tem de vir da REF: use `scripts/lib/sonda-cron-allowlist.ts` ' +
        '(`extrairAlvosDaAllowlist` sobre o `git show origin/main:<arquivo>`). Se for leitura disco × ' +
        'disco, acrescente o arquivo a IMPORTADORES_PERMITIDOS com o porquê escrito. Lição: ' +
        'docs/historico/sonda-le-worktree-defasado.md',
    ).toEqual([]);
  });

  it('os permitidos continuam existindo — lista fechada não vira lista morta', () => {
    const rel = new Set(ts.map((f) => relative(RAIZ, f)));
    for (const [arquivo, porque] of Object.entries(IMPORTADORES_PERMITIDOS)) {
      expect(rel, `${arquivo} saiu do repo: tire-o da lista`).toContain(arquivo);
      expect(porque.length, `${arquivo} sem justificativa`).toBeGreaterThan(20);
      expect(readFileSync(join(RAIZ, arquivo), 'utf8')).toMatch(IMPORTA_ALLOWLIST);
    }
  });

  it('nenhum shell lê a allowlist do working tree — em shell a ref é `git show`', () => {
    const intrusos: string[] = [];
    for (const arquivo of shell) {
      const cru = readFileSync(arquivo, 'utf8');
      if (!cru.includes('sonda-cron-alvos')) continue;
      const codigo = removerComentariosShell(cru);
      expect(codigo.length, `stripper esvaziou ${arquivo}`).toBeGreaterThan(cru.length * 0.2);
      const linhas = codigo
        .split('\n')
        .filter((l) => l.includes('sonda-cron-alvos') && !l.includes('git show'));
      if (linhas.length > 0) intrusos.push(`${relative(RAIZ, arquivo)}: ${linhas[0].trim().slice(0, 80)}`);
    }
    expect(
      intrusos,
      'lê `_shared/sonda-cron-alvos` do working tree em shell. Contra a ref lê-se com ' +
        '`git show "$REF:supabase/functions/_shared/sonda-cron-alvos.ts"` — ver ' +
        'docs/historico/sonda-le-worktree-defasado.md',
    ).toEqual([]);
  });
});
