import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// O helper de montagem de custo roda em DOIS runtimes: vitest/Vite (canônico em src/) e
// Deno (espelho no edge). Este teste prova que os dois arquivos são idênticos EXCETO a
// linha de import do helper de escada — que difere só no specifier do módulo:
//   src:  from './costLadder'
//   edge: from './cost-ladder.ts'   (Deno exige extensão; o arquivo usa kebab-case)
// Normalizamos o specifier do edge antes de comparar; qualquer OUTRA divergência =
// CI vermelho (o modo de falha que money-path.md alerta: fix entra num runtime, não no outro).
const ROOT = process.cwd();
const CANONICO = resolve(ROOT, 'src/lib/custo/costCompute.ts');
const ESPELHO = resolve(ROOT, 'supabase/functions/_shared/cost-compute.ts');

describe('paridade: costCompute (src) × cost-compute (edge)', () => {
  it('os dois arquivos são idênticos a menos do specifier de import da escada', () => {
    const canonico = readFileSync(CANONICO, 'utf8');
    const espelhoNormalizado = readFileSync(ESPELHO, 'utf8').replace(
      "} from './cost-ladder.ts';",
      "} from './costLadder';",
    );
    expect(espelhoNormalizado).toBe(canonico);
  });
});
