/**
 * Suite do MOTOR — o `exclusividade` fora da rodada. Parte da suite dividida de `exclusividade-medir.test.ts` (o cabecalho
 * de la explica o fixture); a divisao tirou o arquivo de ~55 s do caminho critico do vitest
 * (docs/historico/ci-escopo-so-docs.md).
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ExecucaoGate } from './lib/exclusividade';
import { EDGE, MATRIZ, raizes, rodar, sh, commitar, ciYml, montarFixture, medir, matrizGravada, limparRaizes } from './exclusividade-medir.fixture';

afterAll(limparRaizes);

describe('[fora-da-rodada] motor — o `exclusividade` vermelho SO por GATE_NOVO desta rodada sai da rodada, e so ele', () => {
  const BASE = ['g:barato', 'g:pega', 'exclusividade'];
  const DEFS = `
# @origem: fixture
# @suspeito: g:pega
pega | ${EDGE} | s/^original$/SABOTADO/

# O perl nao casa: linha INVALIDA, nenhum gate executa nela.
nao-casa | ${EDGE} | s/^inexistente$/SABOTADO/
`;
  let base = '';
  let celulaDaBase: ExecucaoGate | null = null;

  // O nascimento, como no repo real: sem matriz o `exclusividade` reprova por MATRIZ_AUSENTE, entao
  // o motor mede primeiro sem ele e ele entra DISPENSADO (a historia que `matriz.def` conta). A
  // segunda rodada, ja com ele verde, deixa na linha `pega` a celula dele — a que a fusao herda.
  beforeAll(async () => {
    base = await montarFixture(['g:barato', 'g:pega'], DEFS);
    const r1 = await medir(base, ['--defeitos', 'pega']);
    if (r1.rc !== 0) throw new Error(`bootstrap 1: o motor saiu ${r1.rc}\n${r1.saida.slice(-1500)}`);
    const m = matrizGravada(base);
    m.dispensados = [{ gate: 'exclusividade', desde: 'fixture', motivo: 'nasce dispensado, como no repo real' }];
    writeFileSync(join(base, MATRIZ), `${JSON.stringify(m, null, 2)}\n`);
    writeFileSync(join(base, '.github/workflows/ci.yml'), ciYml(BASE));
    await sh(base, 'git', ['add', '-A']);
    await commitar(base, '-m', 'bootstrap 1');
    const r2 = await medir(base, ['--defeitos', 'pega']);
    if (r2.rc !== 0) throw new Error(`bootstrap 2: o motor saiu ${r2.rc}\n${r2.saida.slice(-1500)}`);
    celulaDaBase = matrizGravada(base).linhas.find((l) => l.defeito === 'pega')?.execucoes.find((e) => e.gate === 'exclusividade') ?? null;
    await sh(base, 'git', ['add', '-A']);
    await commitar(base, '-m', 'bootstrap 2');
  }, 180_000);

  /** Copia do fixture base; `mudar`, se houver, vira commit — o motor exige arvore limpa. */
  async function clonar(mudar?: (raiz: string) => void): Promise<string> {
    const raiz = mkdtempSync(join(tmpdir(), 'excl-motor-'));
    raizes.push(raiz);
    cpSync(base, raiz, { recursive: true });
    if (mudar) {
      mudar(raiz);
      await sh(raiz, 'git', ['add', '-A']);
      await commitar(raiz, '-m', 'cenario');
    }
    return raiz;
  }
  const comGates = (gates: string[]) => (raiz: string) => writeFileSync(join(raiz, '.github/workflows/ci.yml'), ciYml(gates));
  const linhaDe = (raiz: string, id: string) => matrizGravada(raiz).linhas.find((l) => l.defeito === id);

  /** O gate REAL, como o CI o roda — o eixo POR FORA do motor. */
  const gateReal = async (raiz: string) => {
    const r = await rodar('bun', ['run', 'exclusividade'], { cwd: raiz, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    return { rc: r.status, saida: `${r.stdout}${r.stderr}` };
  };

  // O CONTROLE de todo vermelho abaixo: no fixture base o gate real e VERDE e o motor o mede como
  // qualquer outro. Sem este verde, um fixture em que o gate real sempre reprova aprovaria tudo.
  it('CONTROLE: exclusividade verde roda na rodada como qualquer gate — sem aviso, sem recusa, e certifica', async () => {
    expect(celulaDaBase, 'o bootstrap deixou a celula do exclusividade na linha pega').not.toBeNull();
    const raiz = await clonar();
    const antes = await gateReal(raiz);
    expect(antes.rc, antes.saida.slice(-1500)).toBe(0);
    const r = await medir(raiz, ['--defeitos', 'pega']);
    expect(r.rc, r.saida.slice(-1500)).toBe(0);
    expect(r.saida).not.toContain('EXCLUSIVIDADE-FORA-DA-RODADA');
    expect(r.saida).not.toContain('EXCLUSAO-RECUSADA');
    const l = linhaDe(raiz, 'pega');
    expect(l?.execucoes.find((e) => e.gate === 'exclusividade')?.reprovou).toBe(false);
    expect(l?.defasados).toBeUndefined();
    expect(r.saida).toMatch(/\[SO ELE\]\s+g:pega/);
  }, 120_000);

  it('so GATE_NOVO de gate desta rodada: o exclusividade sai, a celula herdada fica DEFASADA, e o ciclo fecha', async () => {
    const raiz = await clonar(comGates([...BASE, 'g:novo']));
    const antes = await gateReal(raiz);
    expect(antes.rc, 'o cenario e mesmo o do gate novo').toBe(1);
    expect(antes.saida).toMatch(/REPROVA\s+g:novo\s+GATE_NOVO_SEM_EXCLUSIVIDADE/);

    const r = await medir(raiz, ['--defeitos', 'pega']);
    expect(r.rc, r.saida.slice(-2000)).toBe(0);
    expect(r.saida).toContain('EXCLUSIVIDADE-FORA-DA-RODADA');
    expect(r.saida).toContain('GATE-NOVO-RESOLVIDO g:novo');
    const m = matrizGravada(raiz);
    const l = m.linhas.find((x) => x.defeito === 'pega');
    // Fora da rodada = nao re-executado: a celula dele e a da base, byte a byte, e fica DEFASADA.
    expect(l?.execucoes.find((e) => e.gate === 'exclusividade')).toEqual(celulaDaBase);
    expect(l?.defasados).toEqual(['exclusividade']);
    expect(l?.execucoes.find((e) => e.gate === 'g:novo')?.reprovou).toBe(false);
    // O furo do parecer Codex: o verde ANTIGO dele fecharia a linha re-medida e certificaria.
    expect(r.saida).toMatch(/\[inconcl\]\s+g:pega/);
    expect(r.saida).not.toMatch(/\[SO ELE\]\s+g:/);
    expect(m.baseline.find((b) => b.gate === 'exclusividade')?.verde, 'o baseline grava a verdade').toBe(false);
    expect(r.status.trim()).toBe(`M ${MATRIZ}`);
    // O laco fecha POR FORA do motor: o mesmo gate, lendo a matriz que a rodada gravou, sai verde.
    const depois = await gateReal(raiz);
    expect(depois.rc, depois.saida.slice(-1500)).toBe(0);

    // E a receita que o aviso prescreve devolve o certificado: re-executar SO o excluido limpa a marca.
    await sh(raiz, 'git', ['add', '-A']);
    await commitar(raiz, '-m', 'matriz da rodada sem o exclusividade');
    const r2 = await medir(raiz, ['--defeitos', 'pega', '--gates', 'exclusividade']);
    expect(r2.rc, r2.saida.slice(-2000)).toBe(0);
    expect(r2.saida).not.toContain('EXCLUSIVIDADE-FORA-DA-RODADA');
    expect(linhaDe(raiz, 'pega')?.defasados).toBeUndefined();
    expect(r2.saida).toMatch(/\[SO ELE\]\s+g:pega/);
  }, 180_000);

  it('gate novo SEM execucao valida na rodada: o aviso diz que o exclusividade segue vermelho', async () => {
    const raiz = await clonar(comGates([...BASE, 'g:novo']));
    const r = await medir(raiz, ['--defeitos', 'nao-casa']);
    expect(r.rc, r.saida.slice(-2000)).toBe(0);
    expect(r.saida).toContain('EXCLUSIVIDADE-FORA-DA-RODADA');
    expect(r.saida).toContain('GATE-NOVO-SEM-EXECUCAO g:novo');
    expect((await gateReal(raiz)).rc, 'e o gate real concorda').toBe(1);
  }, 120_000);

  it('outro gate vermelho junto: ABORTA — a exclusao nunca afrouxa o baseline de outro gate', async () => {
    const raiz = await clonar(comGates([...BASE, 'g:novo', 'g:quebrado']));
    const r = await medir(raiz, ['--defeitos', 'pega']);
    expect(r.rc, r.saida.slice(-2000)).toBe(1);
    expect(r.saida).toContain('ABORTADO: 1 gate(s) ja vermelho(s)');
    expect(r.saida).toContain('  - g:quebrado');
    expect(r.status, 'nada gravado').toBe('');
  }, 120_000);

  it('gate novo FORA da rodada (--gates): ABORTA — a rodada nao grava a execucao que o resolveria', async () => {
    const raiz = await clonar(comGates([...BASE, 'g:novo']));
    const r = await medir(raiz, ['--defeitos', 'pega', '--gates', 'g:barato,g:pega,exclusividade']);
    expect(r.rc, r.saida.slice(-2000)).toBe(1);
    expect(r.saida).toContain('EXCLUSAO-RECUSADA: GATE-NOVO-FORA-DA-RODADA g:novo');
    expect(r.saida).toContain('  - exclusividade');
    expect(r.status).toBe('');
  }, 120_000);

  it('ancora da raiz quebrada junto do gate novo: ABORTA — o vermelho nao e so dele', async () => {
    const raiz = await clonar((x) => {
      comGates([...BASE, 'g:novo'])(x);
      rmSync(join(x, '.github/workflows/auto-merge.yml'));
    });
    expect((await gateReal(raiz)).saida, 'o cenario e mesmo o da ancora').toContain('ANCORA-DA-RAIZ-QUEBRADA');
    const r = await medir(raiz, ['--defeitos', 'pega']);
    expect(r.rc, r.saida.slice(-2000)).toBe(1);
    expect(r.saida).toContain('EXCLUSAO-RECUSADA: ANCORA-QUEBRADA');
    expect(r.status).toBe('');
  }, 120_000);

  // Ela nem chega ao classificador: a guarda 14 recusa a matriz que a rodada FUNDIRIA, antes do
  // baseline. O ramo REPROVA-ALHEIA segue coberto pelo `exclusividade` de mentira logo abaixo.
  it('matriz ilegivel: ABORTA na guarda 14, antes do baseline — nada gravado', async () => {
    const raiz = await clonar((x) => writeFileSync(join(x, MATRIZ), '{ nao e json\n'));
    const r = await medir(raiz, ['--defeitos', 'pega']);
    expect(r.rc, r.saida.slice(-2000)).toBe(1);
    expect(r.saida).toContain('MATRIZ-ANTERIOR-RECUSADA MATRIZ_AUSENTE');
    expect(r.saida).not.toContain('baseline (repo limpo');
    expect(r.status).toBe('');
  }, 120_000);

  /** Troca o `exclusividade` do fixture por um de mentira — o nome e a invocacao do CI continuam os mesmos. */
  const trocarExclusividade = (comando: string) => (raiz: string) => {
    const pkg = JSON.parse(readFileSync(join(raiz, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    pkg.scripts.exclusividade = comando;
    writeFileSync(join(raiz, 'package.json'), JSON.stringify(pkg, null, 2));
  };

  it('REPROVA de LEITURA da matriz no baseline (o que o gate real diz de outro schema): ABORTA — REPROVA-ALHEIA', async () => {
    const raiz = await clonar(trocarExclusividade('bun scripts/g.ts excl-reprova-alheia'));
    const r = await medir(raiz, ['--defeitos', 'pega']);
    expect(r.rc, r.saida.slice(-2000)).toBe(1);
    expect(r.saida).toContain('EXCLUSAO-RECUSADA: REPROVA-ALHEIA MATRIZ_SCHEMA_INCOMPATIVEL');
    expect(r.status).toBe('');
  }, 120_000);

  // A fiacao do exit BRUTO no motor: sem ela o criterio "exit 1 nas duas leituras" seria decorativo —
  // nos dois gates de mentira abaixo o JSON diz exatamente o que a exclusao aceitaria.
  it('baseline que sai 2 (erro do gate) com sonda de GATE_NOVO valida: ABORTA — RC-BASELINE', async () => {
    const raiz = await clonar((x) => {
      comGates([...BASE, 'g:novo'])(x);
      trocarExclusividade('bun scripts/g.ts excl-2-e-json')(x);
    });
    const r = await medir(raiz, ['--defeitos', 'pega']);
    expect(r.rc, r.saida.slice(-2000)).toBe(1);
    expect(r.saida).toContain('EXCLUSAO-RECUSADA: RC-BASELINE');
    expect(r.status).toBe('');
  }, 120_000);

  it('sonda que sai 0 com JSON de GATE_NOVO: ABORTA — RC-SONDA', async () => {
    const raiz = await clonar((x) => {
      comGates([...BASE, 'g:novo'])(x);
      trocarExclusividade('bun scripts/g.ts excl-sonda-0')(x);
    });
    const r = await medir(raiz, ['--defeitos', 'pega']);
    expect(r.rc, r.saida.slice(-2000)).toBe(1);
    expect(r.saida).toContain('EXCLUSAO-RECUSADA: RC-SONDA');
    expect(r.status).toBe('');
  }, 120_000);

  it('sonda que TAMBEM fala no stderr: o JSON do stdout chega limpo e a exclusao vale', async () => {
    const raiz = await clonar((x) => {
      comGates([...BASE, 'g:novo'])(x);
      trocarExclusividade('bun scripts/g.ts excl-sonda-ruidosa')(x);
    });
    const r = await medir(raiz, ['--defeitos', 'pega']);
    expect(r.rc, r.saida.slice(-2000)).toBe(0);
    expect(r.saida).toContain('EXCLUSIVIDADE-FORA-DA-RODADA');
    // UM fd para os dois canais misturaria o ruido no JSON e mataria a exclusao aqui.
    expect(r.saida).not.toContain('SONDA-ILEGIVEL');
    expect(r.saida).not.toContain('EXCLUSAO-RECUSADA');
  }, 120_000);

  it('sonda que ESCREVE na arvore aborta pelo write-guard — a sonda e execucao como qualquer outra', async () => {
    const raiz = await clonar(trocarExclusividade('bun scripts/g.ts sonda-escreve'));
    const r = await medir(raiz, ['--defeitos', 'pega']);
    expect(r.rc, r.saida.slice(-2000)).toBe(1);
    expect(r.saida).toContain('GATE-ESCREVEU');
    expect(r.saida).toContain('a sonda --json do baseline');
    expect(r.status, 'arvore restaurada').toBe('');
    expect(readFileSync(join(raiz, 'escrito.txt'), 'utf8')).toBe('original\n');
  }, 120_000);

  it('--dry nao executa nada — nem baseline, nem sonda', async () => {
    const raiz = await clonar(comGates([...BASE, 'g:novo']));
    const r = await medir(raiz, ['--dry']);
    expect(r.rc, r.saida.slice(-1500)).toBe(0);
    expect(r.saida).toContain('--dry: nada foi executado.');
    expect(r.saida).not.toContain('EXCLUSIVIDADE-FORA-DA-RODADA');
    expect(r.saida).not.toContain('EXCLUSAO-RECUSADA');
    expect(r.status).toBe('');
  }, 60_000);

  // Parecer Codex: com `--ignorar-baseline` outro vermelho seguiria adiante, e "so ele saiu da
  // conta" deixaria de ser verdade. Os dois mecanismos nao se combinam: o manual fica como sempre foi.
  it('--ignorar-baseline NAO combina com a exclusao: o motor avisa e mede como sempre mediu', async () => {
    const raiz = await clonar(comGates([...BASE, 'g:novo']));
    const r = await medir(raiz, ['--defeitos', 'pega', '--ignorar-baseline', '--sem-poda']);
    expect(r.rc, r.saida.slice(-2000)).toBe(0);
    expect(r.saida).toContain('IGNORAR-BASELINE-SEM-EXCLUSAO');
    expect(r.saida).not.toContain('EXCLUSIVIDADE-FORA-DA-RODADA');
    const l = linhaDe(raiz, 'pega');
    expect(l?.execucoes.find((e) => e.gate === 'exclusividade')?.reprovou, 'medido vermelho, como antes').toBe(true);
    expect(l?.defasados).toBeUndefined();
  }, 120_000);

  it('defeito cujo @suspeito e o excluido: podado, o suspeito NAO roda fora da poda', async () => {
    const raiz = await clonar((x) => {
      comGates([...BASE, 'g:novo', 'g:pega2'])(x);
      writeFileSync(join(x, 'scripts/exclusividade.d/x.def'), `${DEFS}\n# @suspeito: exclusividade\npoda-suspeito | ${EDGE} | s/^original$/SABOTADO/\n`);
    });
    const r = await medir(raiz, ['--defeitos', 'poda-suspeito']);
    expect(r.rc, r.saida.slice(-2000)).toBe(0);
    expect(r.saida).toContain('EXCLUSIVIDADE-FORA-DA-RODADA');
    expect(r.saida).toContain('o suspeito de poda-suspeito (exclusividade) saiu da rodada');
    const l = linhaDe(raiz, 'poda-suspeito');
    expect(l?.parouCedo, 'dois vermelhos: a linha foi podada').toBe(true);
    expect(l?.execucoes.map((e) => e.gate)).not.toContain('exclusividade');
  }, 120_000);
});
