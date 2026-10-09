import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SONDA_CRON_ALVOS } from '../../supabase/functions/_shared/sonda-cron-alvos';
import {
  ARQ_ALLOWLIST,
  descreverDivergencia,
  diagnosticoWorktree,
  extrairAlvosDaAllowlist,
  parsearEstadoWorktree,
} from './sonda-cron-allowlist';

/**
 * A allowlist do cron de sonda lida como TEXTO, pelos dois sensores que julgam contra a ref
 * (`pendencias:deploy` e `sonda:sql`). Os testes moram com o parser: mudou a lib, é esta suíte que
 * responde — e é ela que o contrato `scripts/mutcheck.d/sonda-cron-allowlist.mut` roda.
 */

const ALLOWLIST_FIXTURE = (corpo: string): string => `
type Alvo = { edge: string; desde: string | null; nota?: string };
// { edge: "fantasma-no-topo" }
export const SONDA_CRON_ALVOS: readonly Alvo[] = [
${corpo}
];
export function slugs(): ReadonlySet<string> {
  return new Set(SONDA_CRON_ALVOS.map((a) => a.edge));
}
`;

/** A mensagem do erro lançado por `fn` — vazio se não lançou. Para casar o RAMO, não só "lançou". */
function msgDoErro(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

describe('extrairAlvosDaAllowlist — lê a allowlist da ref pela AST, e só a forma que sabe ler', () => {
  it('o arquivo REAL: o parser concorda com o import (contrato pinado ao formato de verdade)', () => {
    const texto = readFileSync(join(import.meta.dirname, '..', '..', ARQ_ALLOWLIST), 'utf8');
    const lidos = extrairAlvosDaAllowlist(texto);
    expect(lidos).toEqual(SONDA_CRON_ALVOS.map((a) => a.edge));
    expect(lidos).toContain('omie-desconto-backfill');
    expect(lidos.length).toBeGreaterThanOrEqual(10);
  });

  it('comentário e string que CITAM um slug não aprovam ninguém', () => {
    const texto = ALLOWLIST_FIXTURE(
      [
        '  { edge: "edge-a", desde: null },',
        '  // { edge: "fantasma-comentario", desde: null },',
        '  { edge: "edge-b", desde: null, nota: \'{ edge: "fantasma-string" }\' },',
      ].join('\n'),
    );
    expect(extrairAlvosDaAllowlist(texto)).toEqual(['edge-a', 'edge-b']);
  });

  it('entrada multi-linha é lida como a de uma linha só', () => {
    const texto = ALLOWLIST_FIXTURE('  {\n    edge: "edge-a",\n    desde: null,\n  },\n  { edge: "edge-b", desde: null },');
    expect(extrairAlvosDaAllowlist(texto)).toEqual(['edge-a', 'edge-b']);
  });

  // Cada forma ruim vem DEPOIS de uma entrada válida: sozinha, ela também cairia no "array vazio" e
  // o teste ficaria verde por outra camada. E cada caso casa a marca do SEU ramo (ASCII): `toThrow`
  // da classe inteira aprovaria um ramo que lançasse pelo motivo de outro.
  const VALIDA = '  { edge: "edge-valida", desde: null },\n';
  it.each([
    ['edge vinda de identificador (com cara de slug)', `${VALIDA}  { edge: omie, desde: null },`, 'string literal'],
    ['elemento espalhado', `${VALIDA}  ...OUTRA_LISTA,`, 'objeto literal'],
    ['objeto com spread', `${VALIDA}  { ...BASE, edge: "edge-a", desde: null },`, 'entrada com spread'],
    ['elemento que não é objeto', `${VALIDA}  "edge-a",`, 'objeto literal'],
    ['objeto sem edge', `${VALIDA}  { desde: null },`, 'entrada sem `edge`'],
    ['slug fora do formato de edge', `${VALIDA}  { edge: "Edge A", desde: null },`, 'slug fora do formato'],
    ['array vazio (ausente ≠ zero)', '', 'array vazio'],
  ])('%s → ALLOWLIST_ILEGIVEL (fail-closed, nunca uma lista menor)', (_nome, corpo, ramo) => {
    const msg = msgDoErro(() => extrairAlvosDaAllowlist(ALLOWLIST_FIXTURE(corpo)));
    expect(msg).toContain('ALLOWLIST_ILEGIVEL');
    expect(msg).toContain(ramo);
  });

  it('texto TRUNCADO → ALLOWLIST_ILEGIVEL: a lista parcial se passaria pela inteira', () => {
    const inteiro = ALLOWLIST_FIXTURE('  { edge: "edge-a", desde: null },\n  { edge: "edge-b", desde: null },');
    const truncado = inteiro.slice(0, inteiro.indexOf('"edge-b"') + 3);
    const msg = msgDoErro(() => extrairAlvosDaAllowlist(truncado));
    expect(msg).toContain('ALLOWLIST_ILEGIVEL');
    expect(msg).toContain('parseia');
  });

  it('sem o export (ou só um const local) → ALLOWLIST_ILEGIVEL', () => {
    for (const texto of ['export const OUTRA = [];', 'const SONDA_CRON_ALVOS = [{ edge: "edge-a" }];']) {
      const msg = msgDoErro(() => extrairAlvosDaAllowlist(texto));
      expect(msg).toContain('ALLOWLIST_ILEGIVEL');
      expect(msg).toContain('sem `export const SONDA_CRON_ALVOS`');
    }
  });
});

describe('parsearEstadoWorktree — a contagem do `rev-list --left-right --count HEAD...<ref>`', () => {
  it('esquerda = à frente (só no HEAD), direita = atrás (só na ref)', () => {
    expect(parsearEstadoWorktree('3\t10')).toEqual({ aFrente: 3, atras: 10 });
    expect(parsearEstadoWorktree('  0 4\n')).toEqual({ aFrente: 0, atras: 4 });
  });

  it('saída fora do formato → null (ausente ≠ zero: nunca "0 atrás")', () => {
    expect(parsearEstadoWorktree('')).toBeNull();
    expect(parsearEstadoWorktree('lixo')).toBeNull();
    expect(parsearEstadoWorktree('3')).toBeNull();
  });
});

describe('diagnosticoWorktree — a causa provável, nomeando a ref que o chamador julga', () => {
  const REF = 'origin/main';

  it('atrás → quantos commits, e manda sincronizar', () => {
    const d = diagnosticoWorktree({ aFrente: 0, atras: 10 }, REF);
    expect(d).toContain('10 commit(s)');
    expect(d).toContain(REF);
    expect(d).toContain('sincronize antes de medir');
    expect(d).not.toContain('frente');
  });

  it('atrás E à frente → as duas contagens, e o atraso decide o remédio', () => {
    const d = diagnosticoWorktree({ aFrente: 2, atras: 5 }, REF);
    expect(d).toContain('5 commit(s)');
    expect(d).toContain('(e 2 ');
    expect(d).toContain('sincronize antes de medir');
  });

  it('só à frente → entrega ainda não mergeada, sem mandar sincronizar', () => {
    const d = diagnosticoWorktree({ aFrente: 3, atras: 0 }, REF);
    expect(d).toContain('3 commit(s)');
    expect(d).toContain('entrega ainda n');
    expect(d).not.toContain('sincronize');
  });

  it('sem commit de diferença → a divergência é edição NÃO commitada', () => {
    expect(diagnosticoWorktree({ aFrente: 0, atras: 0 }, REF)).toContain('commitada');
  });

  it('git que não contou → diz que não contou (nunca "0 atrás")', () => {
    const d = diagnosticoWorktree(null, REF);
    expect(d).toContain('consegui contar');
    expect(d).toContain(REF);
  });
});

describe('descreverDivergencia — o que difere entre a allowlist da ref e a do disco', () => {
  it('iguais como CONJUNTO (ordem trocada inclusive) → null: silêncio é o certo', () => {
    expect(descreverDivergencia(['a', 'b'], ['a', 'b'])).toBeNull();
    expect(descreverDivergencia(['a', 'b'], ['b', 'a'])).toBeNull();
  });

  it('só na main → nomeia a que o worktree ainda não tem', () => {
    expect(descreverDivergencia(['a', 'nova-na-main'], ['a'])).toBe('só na main: nova-na-main');
  });

  it('só no worktree → nomeia a que a main ainda não aprovou', () => {
    expect(descreverDivergencia(['a'], ['a', 'em-voo'])).toBe('só no seu worktree: em-voo');
  });

  it('as duas direções, ordenadas — a mesma leitura dá o mesmo texto', () => {
    expect(descreverDivergencia(['z-main', 'a', 'b-main'], ['a', 'y-disco', 'c-disco'])).toBe(
      'só na main: b-main, z-main; só no seu worktree: c-disco, y-disco',
    );
  });
});
