/**
 * Suite do MOTOR — o TETO de grupo (1/2): o surdo e o TERM antes do KILL. Parte da suite dividida de `exclusividade-medir.test.ts` (o cabecalho
 * de la explica o fixture); a divisao tirou o arquivo de ~55 s do caminho critico do vitest
 * (docs/historico/ci-escopo-so-docs.md).
 */
import { describe, expect, it } from 'vitest';
import { montarFixture, medir, contextoTeto } from './exclusividade-medir.fixture';

describe('motor — o TETO vincula: o gate cortado nao sobrevive ao motor, nem a arvore dele', () => {
  /**
   * O incidente (2026-09-25): com `EXCL_TIMEOUT_MS=2400000`, o `sonda:cron-prova` levou 4.774.853 ms. O
   * `spawnSync` manda o TERM SO ao filho direto — o `bun run` —, que o repassa ao script e ESPERA o que
   * for preciso. O teto passa a ser do GRUPO: TERM no prazo, a carencia para quem trata o sinal, KILL no
   * que sobrar. docs/historico/exclusividade-media-outra-coisa.md
   */
  const { TETO, CARENCIA, FOLGA, arquivoDePids, lerPids, sobreviventes, msDe, ambiente, defsDe } = contextoTeto();

  it('gate SURDO ao TERM, e o neto tambem: cortado em teto + carencia — o teto VINCULA', async () => {
    const pids = arquivoDePids();
    const raiz = await montarFixture(['g:surdo'], defsDe('g:surdo'));
    const r = await medir(raiz, [], ambiente(pids));
    const vistos = lerPids(pids);
    expect(vistos.map((p) => p.papel), `o gate armou (o surdo e o neto):\n${r.saida.slice(-1500)}`).toEqual(['surdo', 'surdo']);
    // O estouro no baseline segue ausencia de dado: a rodada aborta e nada e gravado.
    expect(r.rc, r.saida.slice(-1500)).toBe(1);
    const ms = msDe(r.saida, 'g:surdo');
    expect(ms, r.saida.slice(-1500)).not.toBeNull();
    expect(ms, `teto ${TETO} + carencia ${CARENCIA}`).toBeLessThanOrEqual(TETO + CARENCIA + FOLGA);
    expect(await sobreviventes(vistos.map((p) => p.pid)), 'processos do gate VIVOS depois do motor').toEqual([]);
    expect(r.status).toBe('');
  }, 120_000);

  it('o TERM vem ANTES do KILL e vai ao GRUPO: o obediente limpa no prazo, e o neto surdo nao vira orfao', async () => {
    const pids = arquivoDePids();
    const raiz = await montarFixture(['g:obediente', 'g:neto-surdo'], defsDe('g:obediente'));
    const r = await medir(raiz, [], ambiente(pids));
    const vistos = lerPids(pids);
    expect(r.rc, r.saida.slice(-1500)).toBe(1);
    // A carencia existe: o obediente recebeu o TERM, limpou e saiu — e por isso nao pagou a carencia.
    expect(vistos.filter((p) => p.papel === 'limpou'), 'o obediente limpou no TERM').toHaveLength(1);
    const obediente = msDe(r.saida, 'g:obediente');
    expect(obediente, r.saida.slice(-1500)).not.toBeNull();
    expect(obediente, 'quem sai no TERM nao paga a carencia').toBeLessThan(TETO + CARENCIA);
    const neto = msDe(r.saida, 'g:neto-surdo');
    expect(neto, r.saida.slice(-1500)).not.toBeNull();
    expect(neto, `teto ${TETO} + carencia ${CARENCIA}`).toBeLessThanOrEqual(TETO + CARENCIA + FOLGA);
    expect(vistos.filter((p) => p.papel === 'neto-surdo'), 'o filho e o neto armaram').toHaveLength(2);
    expect(await sobreviventes(vistos.map((p) => p.pid)), 'processos do gate VIVOS depois do motor').toEqual([]);
    expect(r.status).toBe('');
  }, 120_000);
});
