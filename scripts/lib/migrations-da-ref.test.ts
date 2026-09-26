/**
 * migrations-da-ref.test.ts — a leitura de TODAS as migrations de um commit, compartilhada pelo
 * gate do pacote (`pendencias-pacote.ts`) e pelo sensor `deriva:corpo:prod`.
 */
import { describe, expect, it } from 'vitest';

import type { ExecutorGitBytes } from '../pendencias-prompt';
import { migrationsDaRef } from './migrations-da-ref';

/** Um git falso que fala o protocolo do `ls-tree` e do `cat-file --batch` para os arquivos dados. */
function gitCom(arquivos: Record<string, string>, opcoes: { perderUm?: boolean } = {}): ExecutorGitBytes {
  const oids = Object.keys(arquivos).map((_, i) => `${String(i).padStart(40, '0')}`);
  return (args, entrada) => {
    if (args[0] === 'ls-tree') {
      const linhas = Object.keys(arquivos).map((c, i) => `100644 blob ${oids[i]}\tsupabase/migrations/${c}`);
      return { ok: true, bytes: Buffer.from(linhas.join('\n') + '\n'), erro: '' };
    }
    if (args[0] === 'cat-file') {
      const pedidos = (entrada ?? '').trim().split('\n');
      const partes = pedidos.slice(0, opcoes.perderUm ? -1 : undefined).map((oid) => {
        const conteudo = Buffer.from(Object.values(arquivos)[oids.indexOf(oid)], 'utf8');
        return Buffer.concat([Buffer.from(`${oid} blob ${conteudo.length}\n`), conteudo, Buffer.from('\n')]);
      });
      return { ok: true, bytes: Buffer.concat(partes), erro: '' };
    }
    return { ok: false, bytes: Buffer.alloc(0), erro: `inesperado: ${args.join(' ')}` };
  };
}

describe('migrationsDaRef', () => {
  it('lê TODAS, em ordem lexical do nome (a ordem de apply), com o SQL cru — acento incluído', () => {
    const git = gitCom({ '20260102_b.sql': 'SELECT 2; -- ação', '20260101_a.sql': 'SELECT 1;', 'LEIAME.md': 'x' });
    expect(migrationsDaRef(git, 'abc')).toEqual([
      { nome: '20260101_a.sql', sql: 'SELECT 1;' },
      { nome: '20260102_b.sql', sql: 'SELECT 2; -- ação' },
    ]);
  });

  it('inventário vazio LANÇA — é leitura quebrada, não repo sem DDL', () => {
    expect(() => migrationsDaRef(gitCom({}), 'abc')).toThrow(/nenhuma migration/);
  });

  it('cat-file que devolve MENOS do que se pediu LANÇA — histórico curto se leria como "sem DDL"', () => {
    const git = gitCom({ '20260101_a.sql': 'SELECT 1;', '20260102_b.sql': 'SELECT 2;' }, { perderUm: true });
    expect(() => migrationsDaRef(git, 'abc')).toThrow(/1 de 2/);
  });
});
