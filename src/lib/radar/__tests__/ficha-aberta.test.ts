import { describe, expect, it } from 'vitest';
import { escolherFichaAberta } from '../ficha-aberta';

type E = { cnpj: string; v: string };
const e = (cnpj: string, v: string): E => ({ cnpj, v });
const base = { cnpj: 'A', daLista: null, doServidor: undefined, servidorRelendo: false, snapshot: null } as const;

describe('escolherFichaAberta (pacote I, item 1)', () => {
  it('a linha da fila vence tudo', () => {
    expect(escolherFichaAberta<E>({ ...base, daLista: e('A', 'fila'), doServidor: e('A', 'srv'), snapshot: e('A', 'snap') })?.v).toBe('fila');
  });
  it('fora da fila: a leitura do servidor ASSENTADA vence o snapshot (o lead que virou cliente)', () => {
    expect(escolherFichaAberta<E>({ ...base, doServidor: e('A', 'srv'), snapshot: e('A', 'snap') })?.v).toBe('srv');
  });
  it('enquanto o servidor relê, o snapshot segura a ficha (o cache pode ser mais velho que ele)', () => {
    expect(escolherFichaAberta<E>({ ...base, doServidor: e('A', 'srv'), servidorRelendo: true, snapshot: e('A', 'snap') })?.v).toBe('snap');
  });
  it('sem snapshot, o dado do servidor relendo é melhor que nenhuma ficha', () => {
    expect(escolherFichaAberta<E>({ ...base, doServidor: e('A', 'srv'), servidorRelendo: true })?.v).toBe('srv');
  });
  it('lead que não existe mais (null) não apaga o snapshot; sem nada, null', () => {
    expect(escolherFichaAberta<E>({ ...base, doServidor: null, snapshot: e('A', 'snap') })?.v).toBe('snap');
    expect(escolherFichaAberta<E>({ ...base, doServidor: null })).toBeNull();
  });
  it('nada de OUTRO CNPJ vaza para a ficha', () => {
    expect(escolherFichaAberta<E>({ ...base, daLista: e('B', 'fila'), doServidor: e('B', 'srv'), snapshot: e('B', 'snap') })).toBeNull();
  });
});
