/**
 * Suite do MOTOR — o TETO de grupo (2/2): Ctrl-C, a receita e o teto invalido. Parte da suite dividida de `exclusividade-medir.test.ts` (o cabecalho
 * de la explica o fixture); a divisao tirou o arquivo de ~55 s do caminho critico do vitest
 * (docs/historico/ci-escopo-so-docs.md).
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MOTOR, EDGE, ENXUTO, DEFS_ENXUTO, rodar, montarFixture, medir, matrizGravada, contextoTeto, limparRaizes } from './exclusividade-medir.fixture';

afterAll(limparRaizes);

describe('motor — o TETO vincula: o gate cortado nao sobrevive ao motor, nem a arvore dele', () => {
  /**
   * O incidente (2026-09-25): com `EXCL_TIMEOUT_MS=2400000`, o `sonda:cron-prova` levou 4.774.853 ms. O
   * `spawnSync` manda o TERM SO ao filho direto — o `bun run` —, que o repassa ao script e ESPERA o que
   * for preciso. O teto passa a ser do GRUPO: TERM no prazo, a carencia para quem trata o sinal, KILL no
   * que sobrar. docs/historico/exclusividade-media-outra-coisa.md
   */
  const { matarOrfaos, CARENCIA, FOLGA, arquivoDePids, lerPids, sobreviventes, ambiente, defsDe } = contextoTeto();
  afterAll(matarOrfaos);

  it('Ctrl-C com um gate em voo: o motor sai 130 na hora, mata a arvore do gate e desfaz a sabotagem', async () => {
    const pids = arquivoDePids();
    const raiz = await montarFixture(['g:barato', 'g:surdo-sob-defeito'], defsDe('g:surdo-sob-defeito'));
    // Teto LONGO: quem tem de cortar aqui e o sinal no motor, nao o teto.
    const env = { ...process.env, EXCL_TIMEOUT_MS: '60000', EXCL_CARENCIA_MS: String(CARENCIA), PIDS_TETO: pids };
    const motor = spawn('bun', [MOTOR], { cwd: raiz, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let saida = '';
    motor.stdout.setEncoding('utf8').on('data', (d: string) => (saida += d));
    motor.stderr.setEncoding('utf8').on('data', (d: string) => (saida += d));
    const fim = new Promise<number | null>((ok) => motor.on('close', (status) => ok(status)));
    // Espera COM teto e com o ramo que desiste: o gate armou (2 pids) sob o defeito, ou o teste diz por que nao.
    const armou = () => lerPids(pids).filter((p) => p.papel === 'surdo-sob-defeito').length === 2;
    for (let i = 0; i < 300 && !armou(); i++) await new Promise((ok) => setTimeout(ok, 100));
    if (!armou()) {
      motor.kill('SIGKILL');
      throw new Error(`o gate nao armou em 30s:\n${saida.slice(-1500)}`);
    }
    const t0 = Date.now();
    motor.kill('SIGINT');
    const rc = await fim;
    const ms = Date.now() - t0;
    expect(rc, saida.slice(-1500)).toBe(130);
    expect(ms, 'o motor saiu na hora, nao depois do gate').toBeLessThan(FOLGA);
    expect(await sobreviventes(lerPids(pids).map((p) => p.pid)), 'processos do gate VIVOS depois do Ctrl-C').toEqual([]);
    expect(readFileSync(join(raiz, EDGE), 'utf8'), 'a sabotagem foi desfeita').toBe('linha 1\noriginal\nlinha 3\n');
    expect((await rodar('git', ['status', '--porcelain'], { cwd: raiz })).stdout).toBe('');
  }, 120_000);

  // A receita e a mesma cadeia de um gate (`bun run` -> script) sob o mesmo teto: sem este caso, voltar
  // ela ao `spawnSync` ficaria verde em todo o resto.
  it('a RECEITA roda sob o mesmo teto de grupo: o gerador que trava numa arvore surda e cortado, e a linha fica INVALIDA', async () => {
    const pids = arquivoDePids();
    const defs = `# @origem: f\n# @suspeito: g:pega\n# @dever-de-casa: regenerar-fingerprints\nsurdo-gerador | ${EDGE} | s/^original$/SURDO-GERADOR/\n`;
    const raiz = await montarFixture([...ENXUTO, 'sonda:fingerprint'], defs);
    // Teto maior que o dos outros casos: aqui os gates do baseline tem de passar VERDES dentro dele.
    const r = await medir(raiz, [], { ...ambiente(pids), EXCL_TIMEOUT_MS: '8000' });
    expect(r.rc, r.saida.slice(-1500)).toBe(0);
    const linha = matrizGravada(raiz).linhas.find((l) => l.defeito === 'surdo-gerador');
    expect(linha?.invalido, r.saida.slice(-1500)).toContain('estourou o teto de 8000ms; corte por SIGKILL');
    const vistos = lerPids(pids);
    expect(vistos.map((p) => p.papel), 'o gerador armou a arvore surda').toEqual(['surdo', 'surdo']);
    expect(await sobreviventes(vistos.map((p) => p.pid)), 'processos da receita VIVOS depois do motor').toEqual([]);
    expect(r.status.trim()).toBe('?? scripts/exclusividade-matriz.json');
  }, 120_000);

  // `setTimeout(NaN)` dispara na hora: um typo viraria "todo gate estourou" (ou carencia nenhuma), calado.
  it('teto que nao e ms inteiro positivo ABORTA antes de tudo — o --dry o acusa; o CONTROLE com ms passa', async () => {
    const raiz = await montarFixture(ENXUTO, DEFS_ENXUTO);
    const ok = await medir(raiz, ['--dry'], { EXCL_TIMEOUT_MS: '2400000', EXCL_CARENCIA_MS: '30000' });
    expect(ok.rc, ok.saida.slice(-800)).toBe(0);
    expect(ok.saida).toContain('teto: 2400000ms por execucao, do GRUPO de processos (+30000ms de carencia');
    for (const [nome, valor] of [['EXCL_TIMEOUT_MS', '40min'], ['EXCL_CARENCIA_MS', '0']]) {
      const r = await medir(raiz, ['--dry'], { [nome]: valor });
      expect(r.rc, r.saida.slice(-800)).toBe(1);
      expect(r.saida).toContain(`ABORTADO: ${nome}=${valor} nao e um teto em ms`);
      expect(r.saida, 'abortou antes do plano').not.toContain('plano:');
    }
  }, 60_000);
});
