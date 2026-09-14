import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { diagnosticarShell } from '@/lib/gates/limpeza-shell';
import {
  PISOS,
  RAIZES_PADRAO,
  alarmesDoStripper,
  analisar,
  detectar,
  enumerar,
  veredito,
  type Analise,
} from './shell-variavel-colada-gate';

/**
 * Dente do fiscal de `$NOME…` colado em não-ASCII (docs/historico/shell-variavel-colada-em-nao-
 * ascii.md). Roda no CI por `bun run test` — puramente textual, não executa shell. As mutações que
 * provam que cada bloco abaixo tem dente vivem em `scripts/mutcheck.d/shell-variavel-colada.mut`.
 *
 * ⚠️ Fonte de teste vai em aspas SIMPLES ou DUPLAS do TS, nunca em template literal: lá `${…}` é
 * interpolação do próprio TS, e o caso "com chaves passa" testaria outra string.
 */

// `import.meta.dir` é do Bun e não existe no vitest — `import.meta.url` existe nos dois.
const RAIZ = resolve(fileURLToPath(import.meta.url), '../..');
const nomes = (fonte: string) => detectar('x.sh', fonte).sitios.map((s) => s.nome);

describe('controle POSITIVO — se o detector parar de casar, isto fica vermelho', () => {
  it("o caso que abriu a classe (canária, #2472): '$marca…' dentro de aspas duplas", () => {
    const linha = 'bad "$desc — esperava \'$marca…\', veio x"';
    expect(detectar('db/test-canaria-veredito.sh', linha + '\n').sitios).toEqual([
      { arquivo: 'db/test-canaria-veredito.sh', linha: 1, nome: 'marca', colado: '…', trecho: linha },
    ]);
  });

  it('os 3 sítios erradicados em 2026-09-14, na forma de ANTES (`»` e `≠`)', () => {
    expect(nomes('veredito="${veredito/ok/} sem a marca «$marca»"')).toEqual(['marca']);
    expect(nomes('ok "F1 view #1014 (sem fallback) descarta cmc de E/F → lucro $FBUGVAL≠250 (fallback tem dente)"')).toEqual([
      'FBUGVAL',
    ]);
    expect(nomes('bad "F5 sabotei o heartbeat e o next_page seguiu $NPS≠1 → P6 fraco"')).toEqual(['NPS']);
  });

  it('e na forma de DEPOIS, com chaves, os mesmos 3 passam', () => {
    expect(nomes('veredito="${veredito/ok/} sem a marca «${marca}»"')).toEqual([]);
    expect(nomes('ok "F1 view #1014 (sem fallback) descarta cmc de E/F → lucro ${FBUGVAL}≠250 (fallback tem dente)"')).toEqual([]);
    expect(nomes('bad "F5 sabotei o heartbeat e o next_page seguiu ${NPS}≠1 → P6 fraco"')).toEqual([]);
  });
});

describe('o que NÃO é a classe', () => {
  it('ASCII colado ao nome é fronteira legítima (`.`, `/`, `-`, `:`)', () => {
    expect(nomes('cp "$arq.txt" "$dir/x" "$a-b" "$h:1"')).toEqual([]);
  });

  it('posicional e parâmetro especial não têm NOME: `$1…` `$@…` `$?…` `$#…` `$!…`', () => {
    expect(nomes('echo "$1… $@… $?… $#… $!…"')).toEqual([]);
  });

  it('`$$NOME…` é o PID seguido de texto — e `$$$NOME…` volta a ser expansão de NOME', () => {
    expect(nomes('echo "$$x…"')).toEqual([]);
    expect(nomes('echo "$$$x…"')).toEqual(['x']);
  });
});

describe('comentário é a ÚNICA isenção — e quem decide é o stripper COMPARTILHADO', () => {
  it('linha de comentário e comentário de fim de linha não contam', () => {
    expect(nomes('# o $marca… morria aqui\necho ok  # e aqui $marca…\n')).toEqual([]);
  });

  it('`#` DENTRO de aspas é dado: a forma depois dele segue visível (regex local a apagaria)', () => {
    expect(nomes('echo "passo #2 de $marca…"\n')).toEqual(['marca']);
  });

  it("aspas simples, `$'…'` e heredoc CITADO contam — alimentam um bash depois", () => {
    expect(nomes("trap 'echo \"$marca…\"' EXIT\n")).toEqual(['marca']);
    expect(nomes("printf %s $'$marca…'\n")).toEqual(['marca']);
    expect(nomes("cat > fake.sh <<'EOF'\necho \"$marca…\"\nEOF\n")).toEqual(['marca']);
  });

  it('no corpo de heredoc, `#` é dado — o bash expande ali mesmo', () => {
    expect(nomes('cat <<EOF\n# $marca…\nEOF\n')).toEqual(['marca']);
  });

  it('a linha reportada é a da FONTE (a limpeza preserva o número de linhas)', () => {
    expect(detectar('x.sh', '# 1\n# 2\n\necho "$marca…"\n').sitios.map((s) => s.linha)).toEqual([4]);
  });

  it('byte que não forma UTF-8 válido (lido como U+FFFD) também é a classe', () => {
    const fonte = Buffer.concat([Buffer.from('echo "$marca'), Buffer.from([0xe2, 0x22, 0x0a])]).toString('utf8');
    expect(nomes(fonte)).toEqual(['marca']);
  });
});

describe('o universo — o que o walker lê', () => {
  let tmp = '';
  const escrever = (rel: string, conteudo: string) => {
    mkdirSync(dirname(join(tmp, rel)), { recursive: true });
    writeFileSync(join(tmp, rel), conteudo);
  };

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shell-variavel-colada-'));
    escrever('db/x.sh', 'echo\n');
    escrever('db/y.bash', 'echo\n');
    escrever('db/notas.md', 'echo "$marca…"\n');
    escrever('db/node_modules/dep/z.sh', 'echo\n');
    escrever('scripts/worktrees/legitimo.sh', 'echo\n');
    escrever('.claude/hooks/sem-extensao', '#!/usr/bin/env bash\necho\n');
    escrever('.claude/hooks/posix', '#!/bin/sh\necho\n');
    escrever('.claude/hooks/em-bun', '#!/usr/bin/env bun\nconsole.log(1)\n');
    escrever('.claude/hooks/em-zsh', '#!/bin/zsh\necho\n');
    escrever('.claude/hooks/sem-shebang', 'echo\n');
    escrever('.claude/worktrees/outra-sessao/db/w.sh', 'echo\n');
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('lê .sh, .bash e, sem extensão, só shebang de sh/bash — descendo em diretório OCULTO', () => {
    const lidos = enumerar(['db', 'scripts', '.claude'], tmp).map((c) => relative(tmp, c));
    expect(lidos.sort()).toEqual([
      '.claude/hooks/posix',
      '.claude/hooks/sem-extensao',
      'db/x.sh',
      'db/y.bash',
      'scripts/worktrees/legitimo.sh',
    ]);
  });
});

describe('os alarmes do stripper — herdados, e cada um visto DISPARAR', () => {
  const saudavel = diagnosticarShell('echo ok\n');

  it('diagnóstico saudável não alarma', () => {
    expect(alarmesDoStripper('x.sh', saudavel)).toEqual([]);
  });

  it.each([
    { rotulo: 'sobre-limpeza por fração', desvio: { linhasOriginais: 40, fracaoPreservada: 0.1 }, marca: 'sobre-limpeza' },
    { rotulo: 'sobre-limpeza por bloco contíguo', desvio: { maiorBlocoDescartado: 10_000 }, marca: 'sobre-limpeza' },
    { rotulo: 'sub-limpeza', desvio: { comentariosSobreviventes: 1 }, marca: 'sub-limpeza' },
    { rotulo: 'heredoc aberto até o EOF', desvio: { heredocsAbertos: 1 }, marca: 'perdeu o fio' },
  ])('$rotulo', ({ desvio, marca }) => {
    const alarmes = alarmesDoStripper('x.sh', { ...saudavel, ...desvio });
    expect(alarmes).toHaveLength(1);
    expect(alarmes[0]).toContain(marca);
  });

  it('script CURTO não alarma por fração — cabeçalho honesto não é desabamento', () => {
    expect(alarmesDoStripper('x.sh', { ...saudavel, linhasOriginais: 19, fracaoPreservada: 0.1 })).toEqual([]);
  });

  it('ponta a ponta, com a máquina real: heredoc sem delimitador vira INDETERMINADO, não "limpo"', () => {
    const r = analisar([{ caminho: 'x.sh', fonte: 'cat <<EOF\necho "$marca…"\n' }]);
    expect(r.alarmes).toHaveLength(1);
    expect(veredito(r, false).codigo).toBe(2);
  });
});

describe('veredito — 2 nunca é "passou"', () => {
  const limpo: Analise = { caminhos: ['db/a.sh'], expansoes: 1, formaCerta: 1, violacoes: [], alarmes: [] };
  const muitos = (raiz: string, n: number) => Array.from({ length: n }, (_, i) => `${raiz}/s${i}.sh`);
  const cheio: Analise = {
    ...limpo,
    caminhos: Object.entries(PISOS.arquivosPorRaiz).flatMap(([raiz, piso]) => muitos(raiz, piso)),
    expansoes: PISOS.expansoes,
    formaCerta: PISOS.formaCerta,
  };

  it('limpo, sem pisos → 0', () => {
    expect(veredito(limpo, false).codigo).toBe(0);
  });

  it('com violação → 1, e a saída aponta arquivo:linha e o conserto', () => {
    const v = veredito({ ...limpo, violacoes: detectar('db/a.sh', 'echo "$marca…"\n').sitios }, false);
    expect(v.codigo).toBe(1);
    expect(v.linhas.join('\n')).toContain('db/a.sh:1');
    expect(v.linhas.join('\n')).toContain('${marca}');
  });

  it('nenhum arquivo lido → 2 (ausente ≠ zero violações)', () => {
    expect(veredito({ ...limpo, caminhos: [] }, false).codigo).toBe(2);
  });

  it('alarme do stripper → 2, mesmo sem violação', () => {
    expect(veredito({ ...limpo, alarmes: ['x.sh: 1 heredoc(s) aberto(s)'] }, false).codigo).toBe(2);
  });

  it('com pisos: exatamente nos pisos passa (controle dos casos de baixo)', () => {
    expect(veredito(cheio, true).codigo).toBe(0);
  });

  it('com pisos: perder UMA raiz fura o piso dela, mesmo com o total folgado', () => {
    const semHooks = { ...cheio, caminhos: [...cheio.caminhos.filter((c) => !c.startsWith('.claude/hooks/')), ...muitos('db', 100)] };
    const v = veredito(semHooks, true);
    expect(v.codigo).toBe(2);
    expect(v.linhas.join('\n')).toContain('.claude/hooks/');
  });

  it('com pisos: a forma certa que some (a leitura perdeu o não-ASCII) → 2', () => {
    expect(veredito({ ...cheio, formaCerta: PISOS.formaCerta - 1 }, true).codigo).toBe(2);
  });

  it('com pisos: expansões abaixo do piso (abriu arquivo, mas não leu código) → 2', () => {
    expect(veredito({ ...cheio, expansoes: PISOS.expansoes - 1 }, true).codigo).toBe(2);
  });
});

describe('o corpo REAL do repo', () => {
  let r: Analise;
  beforeAll(() => {
    r = analisar(
      enumerar(RAIZES_PADRAO, RAIZ).map((c) => ({ caminho: relative(RAIZ, c), fonte: readFileSync(c, 'utf8') })),
    );
  }, 30_000);

  it('nenhuma expansão $NOME sem chaves colada em não-ASCII', () => {
    expect(r.violacoes.map((s) => `${s.arquivo}:${s.linha} $${s.nome}${s.colado}`)).toEqual([]);
  });

  it('o fiscal MEDIU e o stripper não desabou: com pisos, o veredito é 0 — não 2', () => {
    expect(veredito(r, true)).toEqual({ codigo: 0, linhas: [expect.stringContaining('✅')] });
  });

  /**
   * O universo medido POR FORA do walker: o `git ls-files` não consulta nem o walker nem as raízes.
   * Raiz nova com `.sh` (um `tools/x.sh` amanhã) fica vermelha aqui, em vez de invisível ao fiscal —
   * a lição do #2484, em que o "sem ocorrência" falava de um universo menor que o repo.
   */
  it('todo .sh/.bash RASTREADO do repo está no universo do fiscal', () => {
    const git = spawnSync('git', ['ls-files', '-z', '--', '*.sh', '*.bash'], { cwd: RAIZ, encoding: 'utf8' });
    expect(git.status).toBe(0); // git ausente ou quebrado não vira "nada fora do universo"
    const rastreados = git.stdout.split('\0').filter(Boolean);
    expect(rastreados.length).toBeGreaterThanOrEqual(400);
    const lidos = new Set(r.caminhos);
    expect(rastreados.filter((c) => !lidos.has(c))).toEqual([]);
  });
});
