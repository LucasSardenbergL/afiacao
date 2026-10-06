import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { enumerar } from './shell-variavel-colada-gate';
import {
  PISOS,
  RAIZES_PADRAO,
  analisar,
  analisarPassos,
  detectar,
  veredito,
  type Analise,
} from './relogio-bash-em-provas-gate';
import { contarPulsos, descreverPulsos, drenarCedendo, type Pulsos } from '@/test/loop-livre';

/**
 * Dente do fiscal do relógio do bash em provas (docs/historico/provas-janela-de-relogio-fora-do-
 * nucleo.md). Roda no CI por `bun run test` — puramente textual, não executa shell. As mutações que
 * provam que cada bloco abaixo tem dente vivem em `scripts/mutcheck.d/relogio-bash-em-provas.mut`.
 *
 * ⚠️ Fonte de teste vai em aspas SIMPLES ou DUPLAS do TS, nunca em template literal: lá `${…}` é
 * interpolação do próprio TS, e a linha testada seria outra.
 */

// `import.meta.dir` é do Bun e não existe no vitest — `import.meta.url` existe nos dois.
const RAIZ = resolve(fileURLToPath(import.meta.url), '../..');
const linhas = (fonte: string) => detectar('db/test-x.sh', fonte).sitios.map((s) => s.linha);

/** O caso de origem, byte a byte como estava na main antes do conserto. */
const N9 = "H_BRT=$(TZ=America/Sao_Paulo date +%H | sed 's/^0//')";
const ARQUIVO_DO_N9 = 'db/test-data-health-estoque-fonte-dado.sh';

describe('controle POSITIVO — se o detector parar de casar, isto fica vermelho', () => {
  it('o caso que abriu a classe: o N9 da prova do estoque', () => {
    expect(detectar(ARQUIVO_DO_N9, N9 + '\n').sitios).toEqual([{ arquivo: ARQUIVO_DO_N9, linha: 1, trecho: N9 }]);
  });

  it.each([
    ['hora', 'H=$(date +%H)'],
    ['UTC e formato entre aspas duplas', 'D=$(date -u "+%d/%m")'],
    ['formato entre aspas simples', "DOW=$(date '+%u')"],
    ['aspas DEPOIS do +', 'H=$(date +"%H")'],
    ['aspas simples depois do +', "H=$(date +'%H')"],
    ['data inteira', 'HOJE=$(date +%F)'],
    ['aritmética de calendário (BSD)', 'ONTEM=$(date -v-1d +%Y-%m-%d)'],
    ['aritmética de calendário (GNU)', 'ONTEM=$(date -d yesterday +%F)'],
    ['campo sem zero à esquerda (GNU)', 'H=$(date +%-H)'],
    ['gdate, o date do coreutils do Homebrew', 'H=$(gdate +%H)'],
    ['sem captura, direto num teste', '[ "$(date +%H)" -ge 8 ] && echo expediente'],
  ])('%s: %s', (_rotulo, linha) => {
    expect(linhas(linha + '\n')).toEqual([1]);
  });
});

describe('o que NÃO é a classe', () => {
  it('epoch (`%s`) é duração, não calendário — em toda forma', () => {
    expect(linhas('T0=$(date +%s)\nDT=$(( $(date -u +%s) - T0 ))\nNS=$(date "+%s%N")\n')).toEqual([]);
  });

  it('`date` sem formato, e `date` que não é o comando (`update`, `data_date`)', () => {
    expect(linhas('echo "rodado em $(date)"\nupdate +%H\ndata_date +%H\n')).toEqual([]);
  });

  it('o `date` do SQL: tipo e cast não levam `+%`', () => {
    expect(linhas('psql -c "SELECT now()::date + interval \'1 day\', current_date"\n')).toEqual([]);
  });

  it('o `+%` de OUTRO comando do pipeline não é do `date`', () => {
    expect(linhas('date | awk \'{print "+%H"}\'\n')).toEqual([]);
  });
});

describe('comentário é a ÚNICA isenção — e quem decide é o stripper COMPARTILHADO', () => {
  it('linha de comentário e comentário de fim de linha não contam', () => {
    expect(linhas('# antes: H=$(date +%H)\necho ok  # e aqui date +%H\n')).toEqual([]);
  });

  it('`#` DENTRO de aspas é dado: a leitura depois dele segue visível (regex local a apagaria)', () => {
    expect(linhas('fail "N9 #2: esperado $(date +%H)"\n')).toEqual([1]);
  });

  it('aspas simples e heredoc CITADO contam — alimentam um bash depois', () => {
    expect(linhas("bash -c 'H=$(date +%H)'\n")).toEqual([1]);
    expect(linhas("cat > fake.sh <<'EOF'\nH=$(date +%H)\nEOF\n")).toEqual([2]);
  });

  it('no corpo de heredoc, `#` é dado — a leitura segue ali', () => {
    expect(linhas('cat <<EOF\n# $(date +%H)\nEOF\n')).toEqual([2]);
  });

  it('a linha reportada é a da FONTE (a limpeza preserva o número de linhas)', () => {
    expect(linhas('# 1\n# 2\n\n' + N9 + '\n')).toEqual([4]);
  });

  it('o denominador conta CÓDIGO: linha em branco e comentário não entram no piso', () => {
    expect(detectar('db/test-x.sh', '#!/usr/bin/env bash\n\n# cabeçalho\n  \necho a\necho b  # fim\n').linhasDeCodigo).toBe(2);
  });
});

describe('o universo — todo shell de db/, e só ele', () => {
  let tmp = '';
  const escrever = (rel: string, conteudo: string) => {
    mkdirSync(dirname(join(tmp, rel)), { recursive: true });
    writeFileSync(join(tmp, rel), conteudo);
  };

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'relogio-bash-em-provas-'));
    escrever('db/test-a.sh', 'echo\n');
    escrever('db/lib/pg-harness.sh', 'hora_brt() { TZ=America/Sao_Paulo date +%H; }\n');
    escrever('db/falsifica-x.sh', 'echo\n');
    escrever('db/notas.md', N9 + '\n');
    escrever('scripts/fora.sh', N9 + '\n');
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('lê as provas E o harness que elas carregam (`db/lib/`) — e nada fora de db/', () => {
    const lidos = enumerar(RAIZES_PADRAO, tmp).map((c) => relative(tmp, c));
    expect(lidos.sort()).toEqual(['db/falsifica-x.sh', 'db/lib/pg-harness.sh', 'db/test-a.sh']);
  });

  it('um helper de relógio em db/lib/ é a mesma leitura: violação', () => {
    const arquivos = enumerar(RAIZES_PADRAO, tmp).map((c) => ({ caminho: relative(tmp, c), fonte: readFileSync(c, 'utf8') }));
    expect(analisar(arquivos).violacoes.map((s) => `${s.arquivo}:${s.linha}`)).toEqual(['db/lib/pg-harness.sh:1']);
  });
});

/**
 * O dente de CADA alarme é provado no irmão (`shell-variavel-colada-gate.test.ts` + `.mut`), dono
 * de `alarmesDoStripper`. Aqui cabe provar que ESTE fiscal os consulta: ponta a ponta, com a
 * máquina real.
 */
describe('os alarmes do stripper — herdados do irmão, e vistos disparar AQUI', () => {
  it('heredoc sem delimitador vira INDETERMINADO, não "limpo" — mesmo escondendo uma violação', () => {
    const r = analisar([{ caminho: 'db/test-x.sh', fonte: 'cat <<EOF\n' + N9 + '\n' }]);
    expect(r.alarmes).toHaveLength(1);
    expect(veredito(r, false).codigo).toBe(2);
  });
});

describe('veredito — 2 nunca é "passou"', () => {
  const limpo: Analise = { caminhos: ['db/test-a.sh'], linhasDeCodigo: 1, violacoes: [], alarmes: [] };
  const provas = Array.from({ length: PISOS.provas }, (_, i) => `db/test-p${i}.sh`);
  const cheio: Analise = { ...limpo, caminhos: [...provas, 'db/lib/pg-harness.sh'], linhasDeCodigo: PISOS.linhasDeCodigo };

  it('limpo, sem pisos → 0', () => {
    expect(veredito(limpo, false).codigo).toBe(0);
  });

  it('com violação → 1, e a saída aponta arquivo:linha E o conserto (relógio controlado)', () => {
    const v = veredito({ ...limpo, violacoes: detectar(ARQUIVO_DO_N9, N9 + '\n').sitios }, false);
    expect(v.codigo).toBe(1);
    const saida = v.linhas.join('\n');
    expect(saida).toContain(`${ARQUIVO_DO_N9}:1`);
    expect(saida).toContain('test.agora');
    expect(saida).toContain('docs/historico/provas-janela-de-relogio-fora-do-nucleo.md');
  });

  it('nenhum arquivo lido → 2 (ausente ≠ zero violações)', () => {
    expect(veredito({ ...limpo, caminhos: [] }, false).codigo).toBe(2);
  });

  it('alarme do stripper → 2, mesmo COM violação (não dá para confiar em nenhuma das duas)', () => {
    const v = veredito({ ...limpo, violacoes: detectar(ARQUIVO_DO_N9, N9).sitios, alarmes: ['x.sh: heredoc aberto'] }, false);
    expect(v.codigo).toBe(2);
  });

  it('com pisos: exatamente nos pisos passa (controle dos casos de baixo)', () => {
    expect(veredito(cheio, true).codigo).toBe(0);
  });

  it('com pisos: uma prova a menos que o piso → 2 — e shell que não é prova não conta para ele', () => {
    const semUma = { ...cheio, caminhos: [...cheio.caminhos.slice(1), 'db/lib/outro.sh', 'db/falsifica-y.sh'] };
    const v = veredito(semUma, true);
    expect(v.codigo).toBe(2);
    expect(v.linhas.join('\n')).toContain('db/test-*.sh');
  });

  it('com pisos: linhas de código abaixo do piso (abriu arquivo, mas não leu código) → 2', () => {
    expect(veredito({ ...cheio, linhasDeCodigo: PISOS.linhasDeCodigo - 1 }, true).codigo).toBe(2);
  });
});

describe('o corpo REAL do repo', () => {
  let arquivos: { caminho: string; fonte: string }[];
  let r: Analise;
  // A varredura do repo CEDE o event loop entre os arquivos (`analisarPassos` + `drenarCedendo`):
  // de uma vez, ela era UM bloqueio síncrono no `beforeAll` (3,5s sob carga em 2026-10-05), e acima
  // de 60s o RPC do vitest estoura — `test` rc=1 sem teste falhando (src/test/loop-livre.ts).
  let pulsos: Pulsos<Analise>;
  beforeAll(async () => {
    arquivos = enumerar(RAIZES_PADRAO, RAIZ).map((c) => ({ caminho: relative(RAIZ, c), fonte: readFileSync(c, 'utf8') }));
    pulsos = await contarPulsos(() => drenarCedendo(analisarPassos(arquivos)));
    r = pulsos.resultado;
  }, 30_000);

  it('a varredura do repo cede o event loop do worker — o pulso bate entre os arquivos', () => {
    expect(pulsos.batidas, descreverPulsos(pulsos)).toBeGreaterThanOrEqual(2);
  });

  it('nenhuma prova tira o esperado do relógio do bash', () => {
    expect(r.violacoes.map((s) => `${s.arquivo}:${s.linha}  ${s.trecho}`)).toEqual([]);
  });

  it('o fiscal MEDIU e o stripper não desabou: com pisos, o veredito é 0 — não 2', () => {
    expect(veredito(r, true)).toEqual({ codigo: 0, linhas: [expect.stringContaining('✅')] });
  });

  /**
   * A falsificação, com CONTROLE verde na MESMA invocação: o mesmo corpo, com o N9 devolvido ao
   * arquivo de onde saiu, tem de acusar exatamente aquele sítio — e nada além dele. No arquivo
   * REAL, e não num fixture: é ali que o stripper precisa chegar ao fim sem perder o fio.
   */
  it('falsificação: devolver o N9 ao arquivo real acusa exatamente ele (e o corpo intocado, não)', async () => {
    const alvo = arquivos.find((a) => a.caminho === ARQUIVO_DO_N9);
    expect(alvo, `${ARQUIVO_DO_N9} sumiu do universo — a falsificação perdeu o alvo`).toBeDefined();
    expect(veredito(r, true).codigo).toBe(0); // controle, antes de sabotar
    const fonte = alvo!.fonte.endsWith('\n') ? alvo!.fonte : alvo!.fonte + '\n';
    const sabotado = arquivos.map((a) => (a === alvo ? { ...a, fonte: fonte + N9 + '\n' } : a));
    const ps = await contarPulsos(() => drenarCedendo(analisarPassos(sabotado)));
    expect(ps.batidas, descreverPulsos(ps)).toBeGreaterThanOrEqual(2);
    const rs = ps.resultado;
    expect(rs.violacoes).toEqual([{ arquivo: ARQUIVO_DO_N9, linha: fonte.split('\n').length, trecho: N9 }]);
    expect(veredito(rs, true).codigo).toBe(1);
  });

  /**
   * O universo medido POR FORA do walker: o `git ls-files` não consulta nem o walker nem as raízes.
   * Shell novo em `db/` — numa pasta nova, sem extensão com shebang — fica vermelho aqui, em vez de
   * invisível ao fiscal.
   */
  it('todo .sh/.bash RASTREADO sob db/ está no universo do fiscal', () => {
    const git = spawnSync('git', ['ls-files', '-z', '--', 'db/*.sh', 'db/**/*.sh', 'db/*.bash', 'db/**/*.bash'], {
      cwd: RAIZ,
      encoding: 'utf8',
    });
    expect(git.status).toBe(0); // git ausente ou quebrado não vira "nada fora do universo"
    const rastreados = [...new Set(git.stdout.split('\0').filter(Boolean))];
    expect(rastreados.length).toBeGreaterThanOrEqual(PISOS.provas);
    const lidos = new Set(r.caminhos);
    expect(rastreados.filter((c) => !lidos.has(c))).toEqual([]);
  });
});
