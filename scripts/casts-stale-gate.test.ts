import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARQ_TYPES, PISOS, acharCasts, ehVelho, julgar, nomesTipados } from './casts-stale-gate';

const TYPES = `export type Database = {
  public: {
    Tables: {
      pedidos: {
        Row: { id: string }
      }
    }
    Views: {
      v_pedidos: {
        Row: { id: string }
      }
    }
    Functions: {
      calcular: { Args: never; Returns: number }
      sobrecarga:
        | { Args: never; Returns: number }
    }
    Enums: {
      papel: "a" | "b"
    }
  }
}
`;

const MEDIDAS_OK = { relacoes: 999, funcoes: 999, arquivos: 9999, castsLiterais: 999 };

describe('nomesTipados', () => {
  it('lê Tables∪Views como relações e Functions (inclusive sobrecarga) como funções', () => {
    const n = nomesTipados(TYPES);
    expect([...n.relacoes].sort()).toEqual(['pedidos', 'v_pedidos']);
    expect([...n.funcoes].sort()).toEqual(['calcular', 'sobrecarga']);
  });

  it('lê o types.ts REAL acima dos pisos (parser que não casa é gate cego)', () => {
    const n = nomesTipados(readFileSync(join(process.cwd(), ARQ_TYPES), 'utf8'));
    expect(n.relacoes.size).toBeGreaterThanOrEqual(PISOS.relacoes);
    expect(n.funcoes.size).toBeGreaterThanOrEqual(PISOS.funcoes);
    expect(n.relacoes.has('Row')).toBe(false); // entrou um nível fundo demais
  });
});

describe('acharCasts', () => {
  it('acha from/rpc com aspas simples, duplas e crase, com a linha certa', () => {
    const f = `a\n.from('pedidos' as never)\n.rpc("calcular" as never)\n.from(\`v_pedidos\` as   never)`;
    expect(acharCasts(f, 'x.ts').map((c) => `${c.tipo}:${c.nome}:${c.linha}`)).toEqual([
      'from:pedidos:2',
      'rpc:calcular:3',
      'from:v_pedidos:4',
    ]);
  });

  it('ignora o cast dentro de COMENTÁRIO (o caso real de useTarefasFase2.ts)', () => {
    const f = `// .from('pedidos' as never)\n/* .rpc('calcular' as never) */\nconst x = 1;`;
    expect(acharCasts(f, 'x.ts')).toEqual([]);
  });

  it('ignora cast sobre VARIÁVEL e cast que não é as never', () => {
    expect(acharCasts(`.from(nome as never) .from('pedidos' as any)`, 'x.ts')).toEqual([]);
  });
});

describe('ehVelho + julgar', () => {
  const n = nomesTipados(TYPES);
  const c = (tipo: 'from' | 'rpc', nome: string) => ({ tipo, nome, arquivo: 'x.ts', linha: 1 });

  it('velho = nome que o types JÁ tem, no catálogo do tipo certo', () => {
    expect(ehVelho(c('from', 'pedidos'), n)).toBe(true);
    expect(ehVelho(c('from', 'fila_inexistente'), n)).toBe(false); // uso legítimo (ou M-06)
    expect(ehVelho(c('from', 'calcular'), n)).toBe(false); // função não é relação
    expect(ehVelho(c('rpc', 'calcular'), n)).toBe(true);
  });

  it('subiu reprova, desceu reprova (ratchet), igual passa', () => {
    const base = { from: 1, rpc: 0 };
    expect(julgar([c('from', 'a')], base, MEDIDAS_OK).tipo).toBe('ok');
    expect(julgar([c('from', 'a'), c('from', 'b')], base, MEDIDAS_OK).tipo).toBe('subiu');
    expect(julgar([c('from', 'a'), c('rpc', 'b')], base, MEDIDAS_OK).tipo).toBe('subiu');
    expect(julgar([], base, MEDIDAS_OK).tipo).toBe('desceu');
  });

  it('varredura abaixo do piso é CEGO, mesmo com a contagem batendo', () => {
    const v = julgar([], { from: 0, rpc: 0 }, { ...MEDIDAS_OK, castsLiterais: 0 });
    expect(v.tipo).toBe('cego');
  });
});
