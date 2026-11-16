/**
 * Suite do MOTOR — com efeitos, contra o BINARIO real, num repo-fixture descartavel.
 *
 * A suite de `exclusividade-gate.test.ts` prova a logica pura. O que so o motor faz — rodar a
 * invocacao do CI, vigiar a arvore, executar o suspeito fora da poda, aplicar o dever de casa e
 * restaurar tudo — so se prova rodando o processo. O fixture imita o caso que originou tudo isto
 * (2026-09-10): um gate de BYTES que pega qualquer mudanca na edge (`sonda:bump`), um que exige o
 * mapa regenerado (`sonda:fingerprint`) e um gate SEMANTICO lento (`g:lento`, o `sonda:autentica`
 * do fixture) que a poda por custo deixava de fora.
 *
 * Todo cenario que exige vermelho tem o CONTROLE verde na mesma suite: o fixture sem o gate
 * escritor mede limpo; o gate de argumentos reprova quando rodado cru.
 *
 * O ultimo bloco roda o gate `exclusividade` REAL dentro do fixture: a sonda `--json` que o motor
 * interpreta e a do binario de verdade, e o laco fecha POR FORA do motor — o mesmo gate, lendo a
 * matriz que a rodada gravou, volta a verde.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { BINARIOS_DAS_DEPS, SCHEMA_VERSION, type Matriz } from './lib/exclusividade';
import { EDGE, VERSAO, MAPA, MATRIZ, PADRAO, DEFS_PADRAO, ENXUTO, DEFS_ENXUTO, raizes, rodar, sh, commitar, binFalso, instalarDeps, montarFixture, medir, matrizGravada } from './exclusividade-medir.fixture';

describe('motor — a rodada limpa (o CONTROLE de todos os cenarios de aborto abaixo)', () => {
  let raiz = '';
  let r = { rc: null as number | null, saida: '', status: '' };
  let m: Matriz | null = null;
  beforeAll(async () => {
    raiz = await montarFixture(PADRAO, DEFS_PADRAO);
    r = await medir(raiz);
    m = r.rc === 0 ? matrizGravada(raiz) : null;
  }, 180_000);
  const linha = (id: string) => m?.linhas.find((l) => l.defeito === id);
  const execDe = (id: string, gate: string) => linha(id)?.execucoes.find((e) => e.gate === gate);

  it('mede ate o fim (rc 0) e devolve a arvore INTACTA — so a matriz fica nova', () => {
    expect(r.rc, r.saida.slice(-1500)).toBe(0);
    expect(r.status.trim()).toBe('?? scripts/exclusividade-matriz.json');
  });

  // Paridade de invocacao: o CONTROLE e o proprio gate reprovando quando rodado cru — sem ele,
  // "o baseline ficou verde" nao provaria que o motor passou os argumentos.
  it('roda a invocacao do CI: g:args e g:env ficam verdes no baseline, e reprovam quando crus', async () => {
    expect((await rodar('bun', ['run', 'g:args'], { cwd: raiz })).status, 'controle: cru reprova').toBe(3);
    expect((await rodar('bun', ['run', 'g:env'], { cwd: raiz })).status, 'controle: sem env reprova').toBe(4);
    expect(m?.baseline.filter((b) => ['g:args', 'g:env'].includes(b.gate)).every((b) => b.verde)).toBe(true);
    // Na linha diligente, e nao na podada: so ela roda o universo inteiro POR CONSTRUCAO — na
    // podada, quem chega a rodar depende da ordem por custo, que e ruido de milissegundo.
    expect(execDe('diligente', 'g:args')?.invocacao).toBe('bun run g:args -- --modo-ci');
    expect(execDe('diligente', 'g:env')?.invocacao).toBe('env{MODO_FIXTURE=ci} bun run g:env');
  });

  // O defeito (2): a poda parava no 2o vermelho (os gates de BYTES, baratos) e o suspeito, caro,
  // nunca rodava — e mesmo assim contava como "medido".
  it('o suspeito podado RODA fora da poda, e a linha continua podada', () => {
    expect(linha('descuidado')?.parouCedo).toBe(true);
    expect(execDe('descuidado', 'g:lento')?.reprovou, 'o suspeito executou e pegou').toBe(true);
    expect(r.saida).toContain('suspeito, rodado FORA da poda');
  });

  // O defeito (3): com o dever de casa, os gates de bytes ficam verdes e SO o semantico pega — e a
  // linha rodou o universo inteiro, entao isso CERTIFICA, em vez de ficar inconclusivo.
  it('o autor DILIGENTE: bump + mapa regenerado deixam so o gate semantico vermelho', () => {
    const l = linha('diligente')!;
    expect(l.invalido, l.invalido ?? '').toBeNull();
    expect(l.deveres).toEqual(['bump-versao fx', 'regenerar-fingerprints']);
    expect(l.tocados).toEqual([MAPA, VERSAO].sort());
    expect(l.execucoes.filter((e) => e.reprovou).map((e) => e.gate)).toEqual(['g:lento']);
    expect(l.execucoes.map((e) => e.gate).sort()).toEqual([...PADRAO].sort());
    expect(r.saida).toMatch(/\[SO ELE\]\s+g:lento/);
  });

  it('meio dever de casa (so o bump) ainda e pego pelo mapa — o formato distingue os dois fluxos', () => {
    const l = linha('so-bump')!;
    expect(l.tocados).toEqual([VERSAO]);
    expect(execDe('so-bump', 'sonda:bump')?.reprovou).toBe(false);
    expect(execDe('so-bump', 'sonda:fingerprint')?.reprovou).toBe(true);
  });

  it('dever de casa que nao muda nada e INVALIDO — nunca o autor descuidado com nome de diligente', () => {
    expect(linha('dever-sem-efeito')?.invalido).toMatch(/NAO alterou nada/);
    expect(linha('dever-sem-efeito')?.execucoes).toEqual([]);
  });

  it('dever de casa que falha e INVALIDO', () => {
    expect(linha('gerador-quebra')?.invalido).toMatch(/falhou: saiu 7/);
  });
});

describe('motor — guarda 12: vermelho SEM teste falhando nao e reprova, e a repeticao tem orcamento 1', () => {
  /**
   * O contador do `rpc-flaky` vive FORA da arvore — dentro dela o write-guard abortaria a rodada.
   * O diretorio entra em `raizes` como os fixtures: sem isso cada rodada deixava um `excl-rpc-*` no tmp.
   */
  const contador = () => {
    const dir = mkdtempSync(join(tmpdir(), 'excl-rpc-'));
    raizes.push(dir);
    return join(dir, 'n');
  };

  it('BASELINE: RPC na 1a e rc=0 limpo na 2a => VERDE, e a rodada mede ate o fim', async () => {
    const raiz = await montarFixture([...ENXUTO, 'g:rpc-flaky'], DEFS_ENXUTO);
    const r = await medir(raiz, ['--defeitos', 'descuidado'], { RPC_CONTADOR: contador() });
    expect(r.saida).toContain('repetindo UMA vez');
    expect(r.saida).toContain('a repeticao saiu 0 limpo');
    expect(r.rc).toBe(0);
    expect(r.saida).not.toContain('BASELINE-SEM-DADO');
    expect(matrizGravada(raiz).baseline.find((b) => b.gate === 'g:rpc-flaky')?.verde).toBe(true);
  }, 180_000);

  it('BASELINE: RPC nas DUAS execucoes => BASELINE-SEM-DADO, e NAO "ja vermelho" — nada e gravado', async () => {
    const raiz = await montarFixture([...ENXUTO, 'g:rpc-sempre'], DEFS_ENXUTO);
    const r = await medir(raiz);
    expect(r.rc).toBe(1);
    expect(r.saida).toContain('BASELINE-SEM-DADO');
    expect(r.saida).toContain('g:rpc-sempre');
    expect(r.saida).not.toContain('ja vermelho(s) no repo limpo');
    expect(existsSync(join(raiz, MATRIZ))).toBe(false);
    expect(r.status).toBe('');
  }, 120_000);

  it('FALSIFICACAO: um teste falhando JUNTO do RPC continua VERMELHO — a guarda nao engole reprova', async () => {
    const raiz = await montarFixture([...ENXUTO, 'g:rpc-com-falha'], DEFS_ENXUTO);
    const r = await medir(raiz);
    expect(r.rc).toBe(1);
    expect(r.saida).toContain('ja vermelho(s) no repo limpo');
    expect(r.saida).toContain('g:rpc-com-falha');
    expect(r.saida).not.toContain('BASELINE-SEM-DADO');
    expect(r.saida).not.toContain('repetindo UMA vez');
  }, 120_000);

  it('SOB DEFEITO nao se repete: suspeito invalida a LINHA — nunca um verde que apagaria a deteccao', async () => {
    // Defeito que NENHUM outro gate do fixture pega: sem isso a poda por custo (ruidosa entre gates
    // rapidos) decidiria se o gate do RPC chega a rodar, e o teste mediria a ordenacao, nao a guarda.
    const defs = `\n# @origem: fixture\n# @suspeito: g:rpc-sob-defeito\nso-rpc | supabase/functions/fx/outro.ts | s/^nada$/SABOTADO/\n`;
    const raiz = await montarFixture([...ENXUTO, 'g:rpc-sob-defeito'], defs);
    const r = await medir(raiz);
    expect(r.rc).toBe(0);
    // A repeticao e EXCLUSIVA do baseline: sob defeito o motor nao gasta a 2a execucao.
    expect(r.saida).not.toContain('repetindo UMA vez');
    expect(r.saida).toContain('SEM DADO');
    const linha = matrizGravada(raiz).linhas.find((l) => l.defeito === 'so-rpc');
    expect(linha?.invalido).toContain('AUSENCIA DE DADO');
    // E o gate suspeito NAO entra na matriz nem como verde nem como vermelho.
    expect(linha?.execucoes.some((e) => e.gate === 'g:rpc-sob-defeito')).toBe(false);
  }, 120_000);
});

describe('motor — o harness NAO bloqueia o event loop do worker (o RPC do vitest estoura com >60s de bloqueio)', () => {
  // A prova e por COMPORTAMENTO, nao por texto: um pulso de 10ms tem de bater DURANTE o `medir()`.
  // Com `spawnSync` o loop fica parado a rodada inteira, o pulso bate ZERO, e isto fica vermelho —
  // sem precisar reproduzir os 60s nem a carga que fazem o RPC estourar de verdade.
  it('o pulso do loop bate enquanto o motor roda', async () => {
    const raiz = await montarFixture(PADRAO, DEFS_PADRAO);
    let batidas = 0;
    const pulso = setInterval(() => batidas++, 10);
    try {
      const r = await medir(raiz, ['--dry']);
      expect(r.rc, r.saida.slice(-600)).toBe(0);
    } finally {
      clearInterval(pulso);
    }
    expect(batidas).toBeGreaterThan(0);
  }, 60_000);
});

describe('motor — WRITE-GUARD: gate que escreve na arvore versionada aborta a rodada', () => {
  it('no BASELINE: aborta nomeando o gate e o arquivo, restaura, e NAO grava matriz', async () => {
    const raiz = await montarFixture([...ENXUTO, 'g:escritor'], DEFS_ENXUTO);
    const r = await medir(raiz);
    expect(r.rc, r.saida.slice(-1500)).toBe(1);
    expect(r.saida).toContain('GATE-ESCREVEU');
    expect(r.saida).toContain('g:escritor');
    expect(r.saida).toContain('escrito.txt');
    expect(r.status, 'arvore restaurada e sem matriz').toBe('');
    expect(readFileSync(join(raiz, 'escrito.txt'), 'utf8')).toBe('original\n');
  }, 120_000);

  // `--sem-poda`: sob a poda, o 2o vermelho barato poderia parar a linha ANTES do escritor, e o
  // teste passaria a depender de ruido de milissegundo na ordem por custo.
  it('na MEDICAO: gate que so escreve sob o defeito tambem aborta, e o alvo sabotado volta', async () => {
    const raiz = await montarFixture([...ENXUTO, 'g:escritor-sob-defeito'], DEFS_ENXUTO);
    const r = await medir(raiz, ['--defeitos', 'descuidado', '--sem-poda']);
    expect(r.rc, r.saida.slice(-1500)).toBe(1);
    expect(r.saida).toContain('GATE-ESCREVEU');
    expect(r.saida).toContain('o defeito descuidado');
    expect(r.status, 'arvore restaurada e sem matriz').toBe('');
    expect(readFileSync(join(raiz, EDGE), 'utf8')).toBe('linha 1\noriginal\nlinha 3\n');
  }, 120_000);

  // `sonda:fingerprint` volta ao conjunto nas duas receitas abaixo: e o gate que PRESCREVE o
  // `regenerar-fingerprints`, e dever de casa sem o gate que o prescreve e fixture sem par no repo.
  it('receita que escreve FORA das saidas declaradas aborta (o gerador "vazou")', async () => {
    const defs = `# @origem: f\n# @suspeito: g:pega\n# @dever-de-casa: regenerar-fingerprints\nvaza | ${EDGE} | s/^original$/VAZA/\n`;
    const raiz = await montarFixture([...ENXUTO, 'sonda:fingerprint'], defs);
    const r = await medir(raiz);
    expect(r.rc, r.saida.slice(-1500)).toBe(1);
    expect(r.saida).toContain('DEVER-DE-CASA-ESCREVEU-FORA');
    expect(r.status, 'arvore restaurada e sem matriz').toBe('');
  }, 120_000);

  // O parecer do Codex: presenca textual da sabotagem nao prova persistencia — ela pode virar
  // codigo morto sem sair do arquivo. Por isso o ALVO inteiro e intocavel pela receita.
  it('receita que mexe no ALVO aborta — o defeito medido tem de ser o declarado, byte a byte', async () => {
    const defs = `# @origem: f\n# @suspeito: g:pega\n# @dever-de-casa: regenerar-fingerprints\nmexe | ${EDGE} | s/^original$/MEXE-NO-ALVO/\n`;
    const raiz = await montarFixture([...ENXUTO, 'sonda:fingerprint'], defs);
    const r = await medir(raiz);
    expect(r.rc, r.saida.slice(-1500)).toBe(1);
    expect(r.saida).toContain('DEVER-DE-CASA-ESCREVEU-FORA');
    expect(r.saida).toContain(EDGE);
    expect(r.status, 'arvore restaurada e sem matriz').toBe('');
  }, 120_000);
});

describe('motor — o que aborta ANTES de gastar o baseline', () => {
  it('@suspeito que nao e gate bloqueante (typo) aborta', async () => {
    const raiz = await montarFixture(PADRAO, `# @origem: f\n# @suspeito: g:lentoo\nd | ${EDGE} | s/^original$/SABOTADO/\n`);
    const r = await medir(raiz);
    expect(r.rc).toBe(1);
    expect(r.saida).toContain('SUSPEITO-DESCONHECIDO');
  }, 60_000);

  it('step composto no ci.yml aborta com INVOCACAO-NAO-REPRODUZIVEL', async () => {
    const raiz = await montarFixture(PADRAO, DEFS_PADRAO);
    const ci = join(raiz, '.github/workflows/ci.yml');
    writeFileSync(ci, readFileSync(ci, 'utf8').replace('run: bun run g:barato', "run: 'bun run g:barato || true'"));
    await commitar(raiz, '-am', 'composto');
    const r = await medir(raiz);
    expect(r.rc).toBe(1);
    expect(r.saida).toContain('INVOCACAO-NAO-REPRODUZIVEL');
  }, 60_000);
});

describe('[deps-instaladas] motor — guarda 13: sem as deps o motor ABORTA antes de gastar, e so resposta POSITIVA passa', () => {
  /**
   * Os MESMOS binarios num diretorio do PATH, respondendo versao — o estado medido em 2026-09-25:
   * `bun run tsc --version` com o `node_modules` VAZIO saiu 0 com a versao de um `tsc` do PATH. Uma
   * sonda por NOME aprovaria todo cenario de aborto abaixo; so a sonda pelo caminho LOCAL aborta.
   * O CONTROLE roda com o MESMO PATH: a unica variavel entre ele e os abortos e o `node_modules`.
   */
  let path = '';
  beforeAll(() => {
    const globais = mkdtempSync(join(tmpdir(), 'excl-path-'));
    raizes.push(globais);
    for (const b of BINARIOS_DAS_DEPS) binFalso(globais, b, `echo "${b} 9.9.9 GLOBAL"`);
    path = `${globais}:${process.env.PATH ?? ''}`;
  });
  const medirComPath = (raiz: string, argv: string[] = []) => medir(raiz, argv, { PATH: path });
  const trocarTsc = (corpo: string, modo?: number) => (raiz: string) => {
    instalarDeps(raiz);
    binFalso(join(raiz, 'node_modules/.bin'), 'tsc', corpo, modo);
  };

  it('CONTROLE: com as deps respondendo, o motor segue ate o fim — baseline, defeito e matriz', async () => {
    const raiz = await montarFixture(ENXUTO, DEFS_ENXUTO);
    const r = await medirComPath(raiz);
    expect(r.rc, r.saida.slice(-1500)).toBe(0);
    expect(r.saida).not.toContain('DEPS-NAO-INSTALADAS');
    expect(r.saida).toContain('baseline (repo limpo');
    expect(existsSync(join(raiz, MATRIZ))).toBe(true);
  }, 120_000);

  it('node_modules EXISTENTE e VAZIO (o incidente): aborta com a marca ASCII, nomeia os 4, e nem planeja', async () => {
    const raiz = await montarFixture(ENXUTO, DEFS_ENXUTO, (x) => mkdirSync(join(x, 'node_modules')));
    const r = await medirComPath(raiz);
    expect(r.rc, r.saida.slice(-1500)).toBe(1);
    expect(r.saida).toContain('ABORTADO: DEPS-NAO-INSTALADAS');
    expect(r.saida).toContain('rode bun install');
    for (const b of BINARIOS_DAS_DEPS) expect(r.saida).toContain(`node_modules/.bin/${b} --version: ENOENT`);
    // Casavel por `grep` sem `-i` e sem locale: o bloco inteiro e ASCII imprimivel.
    const bloco = r.saida.slice(r.saida.indexOf('ABORTADO: DEPS-NAO-INSTALADAS'));
    expect(bloco).toMatch(/^[\n\x20-\x7e]*$/);
    expect(r.saida, 'abortou antes do plano').not.toContain('plano:');
    expect(r.saida, 'e antes do baseline').not.toContain('baseline (repo limpo');
    expect(existsSync(join(raiz, MATRIZ))).toBe(false);
    expect(r.status).toBe('');
  }, 120_000);

  // `--dry` nos abortos abaixo e de proposito: a guarda roda ANTES do plano (o `--dry` e o pre-voo),
  // e com ela sabotada o motor sai 0 no `--dry` em vez de pagar uma rodada — o vermelho chega barato.
  it('presente mas CALADO: rc 0 sem versao no stdout ABORTA — existencia nao e resposta', async () => {
    const raiz = await montarFixture(ENXUTO, DEFS_ENXUTO, trocarTsc('exit 0'));
    const r = await medirComPath(raiz, ['--dry']);
    expect(r.rc, r.saida.slice(-1500)).toBe(1);
    expect(r.saida).toContain('ABORTADO: DEPS-NAO-INSTALADAS');
    expect(r.saida).toContain('node_modules/.bin/tsc --version: saiu 0 SEM versao');
    expect(r.saida, 'so o quebrado e acusado').not.toContain('node_modules/.bin/vite');
  }, 60_000);

  it('versao no stdout com rc != 0 ABORTA — a resposta so vale com o exit 0', async () => {
    const raiz = await montarFixture(ENXUTO, DEFS_ENXUTO, trocarTsc('echo "Version 5.8.3"; exit 1'));
    const r = await medirComPath(raiz, ['--dry']);
    expect(r.rc, r.saida.slice(-1500)).toBe(1);
    expect(r.saida).toContain('ABORTADO: DEPS-NAO-INSTALADAS');
    expect(r.saida).toContain('node_modules/.bin/tsc --version: saiu 1');
  }, 60_000);

  it('presente SEM bit de execucao ABORTA — presente nao e executavel', async () => {
    const raiz = await montarFixture(ENXUTO, DEFS_ENXUTO, trocarTsc('echo "tsc/1.0.0 fixture"', 0o644));
    const r = await medirComPath(raiz, ['--dry']);
    expect(r.rc, r.saida.slice(-1500)).toBe(1);
    expect(r.saida).toContain('ABORTADO: DEPS-NAO-INSTALADAS');
    expect(r.saida).toContain('node_modules/.bin/tsc --version: EACCES');
  }, 60_000);

  // A lista e FIXA porque a fonte que a derivaria — o proprio `node_modules` — e o que pode faltar.
  // Ela nao apodrece calada: e, por construcao, o que os scripts do `package.json` REAL chamam como
  // comando E o `.bin` REAL fornece. Binario a mais faria a guarda exigir o que o `bun install` nao
  // instala (e o conselho da mensagem viraria mentira); a menos, uma dep que ninguem sonda.
  it('a lista e EXATAMENTE o que os scripts do package.json REAL chamam do node_modules/.bin', () => {
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    const noBin = new Set(readdirSync('node_modules/.bin'));
    const comandos = Object.values(scripts).flatMap((s) =>
      s.split(/&&|\|\||[;|()\n]/).map((seg) => seg.trim().replace(/^(?:\w+=\S*\s+)+/, '').split(/\s+/)[0]),
    );
    expect([...new Set(comandos.filter((c) => noBin.has(c)))].sort()).toEqual([...BINARIOS_DAS_DEPS].sort());
  });
});

/**
 * A rodada FUNDE a matriz em disco e a regrava com `schemaVersion: SCHEMA_VERSION` — lida com cast,
 * uma matriz de outro schema saia "migrada" em silencio, carimbada como a de hoje. Na rodada FATIADA
 * (`--gates` sem o `exclusividade`, a que o README manda na M2) o classificador nem roda: esta guarda
 * e a unica leitura que confere. E ela vem ANTES do baseline — a rodada inteira custa uma hora.
 */
describe('motor — guarda 14: a matriz que a rodada vai FUNDIR tem de ser legivel no schema de hoje', () => {
  /** A marca da anterior: se a rodada a LEU e fundiu, o dispensado dela sobrevive na matriz gravada. */
  const anterior = (over: Record<string, unknown> = {}) =>
    `${JSON.stringify(
      {
        schemaVersion: SCHEMA_VERSION,
        medidoEm: '2026-09-01T00:00:00.000Z',
        sourceHead: 'fixture',
        dispensados: [{ gate: 'g:marca-da-anterior', desde: 'fixture', motivo: 'prova que a rodada leu a anterior' }],
        baseline: [],
        linhas: [],
        ...over,
      },
      null,
      2,
    )}\n`;
  async function comAnterior(conteudo: string): Promise<string> {
    const raiz = await montarFixture(ENXUTO, DEFS_ENXUTO);
    writeFileSync(join(raiz, MATRIZ), conteudo);
    await sh(raiz, 'git', ['add', '-A']);
    await commitar(raiz, '-m', 'matriz anterior');
    return raiz;
  }

  // O CONTROLE: uma guarda que recusasse TODA matriz existente passaria em todos os vermelhos abaixo.
  it('CONTROLE: anterior valida e LIDA e fundida — o dispensado dela sobrevive na matriz gravada', async () => {
    const raiz = await comAnterior(anterior());
    const r = await medir(raiz);
    expect(r.rc, r.saida.slice(-1500)).toBe(0);
    expect(r.saida).not.toContain('MATRIZ-ANTERIOR-RECUSADA');
    expect(matrizGravada(raiz).dispensados.map((d) => d.gate)).toEqual(['g:marca-da-anterior']);
  }, 120_000);

  it('schema FUTURO: ABORTA antes do baseline, e a anterior fica byte a byte — nunca regravada como a de hoje', async () => {
    const conteudo = anterior({ schemaVersion: SCHEMA_VERSION + 1 });
    const raiz = await comAnterior(conteudo);
    const r = await medir(raiz);
    expect(r.rc, r.saida.slice(-1500)).toBe(1);
    expect(r.saida).toContain('MATRIZ-ANTERIOR-RECUSADA MATRIZ_SCHEMA_INCOMPATIVEL');
    expect(r.saida).not.toContain('baseline (repo limpo');
    expect(r.status).toBe('');
    expect(readFileSync(join(raiz, MATRIZ), 'utf8')).toBe(conteudo);
  }, 120_000);

  // Com cast, a linha sem `execucoes` era HERDADA calada (defeito que a rodada nao re-mediu) — e
  // o gate do CI e que tropecava nela depois.
  it('forma invalida (linha sem `execucoes`): ABORTA com MATRIZ_MALFORMADA', async () => {
    const velha = { defeito: 'velho', defeitoFingerprint: 'ff', alvo: 'a.md', suspeito: null, origem: null, parouCedo: false, invalido: null };
    const raiz = await comAnterior(anterior({ linhas: [velha] }));
    const r = await medir(raiz);
    expect(r.rc, r.saida.slice(-1500)).toBe(1);
    expect(r.saida).toContain('MATRIZ-ANTERIOR-RECUSADA MATRIZ_MALFORMADA');
    expect(r.status).toBe('');
  }, 120_000);
});

const DEFS_CANAL = `
# @origem: fixture
# @suspeito: g:pega
canal | ${EDGE} | s/^original$/SABOTADO/
`;

describe('motor — CAPTURA: o gate roda com a saida em ARQUIVO, nunca em pipe', () => {
  // O que este teste afirma — e o que ele NAO afirma. Ele prova o CANAL: o gate recebe arquivo
  // regular, nao FIFO. Ele NAO prova nada sobre o `test` vermelho do baseline: a hipotese de que o
  // pipe fabricava aquele vermelho foi falsificada (a mesma invocacao com saida em arquivo tambem
  // sai 1 com `onTaskUpdate` quando a maquina satura). O canal vale pelo merito proprio — arquivo
  // nao tem teto de maxBuffer nem contrapressao de leitor lento.
  // docs/historico/exclusividade-media-outra-coisa.md
  it('o gate ve fd 1 e fd 2 como arquivo regular — com pipe o baseline dele fica VERMELHO', async () => {
    const raiz = await montarFixture(['g:barato', 'g:pega', 'g:canal'], DEFS_CANAL);
    const r = await medir(raiz, ['--defeitos', 'canal']);
    expect(r.rc, r.saida.slice(-2000)).toBe(0);
    expect(r.saida).toMatch(/verde\s+g:canal/);
    expect(r.saida, 'nenhuma das duas pontas da captura pode ser pipe').not.toContain('FIFO');
  }, 120_000);
});

