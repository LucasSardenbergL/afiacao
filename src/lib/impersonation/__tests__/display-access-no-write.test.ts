import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(p, acc);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      acc.push(p);
    }
  }
  return acc;
}

const MUTATION = /\.(insert|update|upsert|delete)\s*\(/;

describe('guardrail: useDisplayAccess nunca convive com mutação', () => {
  it('nenhum arquivo que importa useDisplayAccess contém .insert/.update/.upsert/.delete', () => {
    const offenders = walk('src').filter((f) => {
      const src = readFileSync(f, 'utf8');
      return /useDisplayAccess/.test(src) && MUTATION.test(src);
    });
    expect(offenders).toEqual([]);
  });
});
