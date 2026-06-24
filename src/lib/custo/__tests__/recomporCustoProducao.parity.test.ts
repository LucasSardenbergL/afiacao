import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// O helper de recomposição roda em DOIS runtimes: vitest/Vite (canônico em src/) e Deno (espelho
// no edge omie-analytics-sync). Diferente do costCompute, este helper é PURO (zero imports), então
// os dois arquivos devem ser BYTE-IDÊNTICOS — sem nenhuma linha de import a normalizar. Qualquer
// divergência = CI vermelho (o modo de falha que money-path.md alerta: fix entra num runtime e não
// no outro). Se um dia o helper passar a importar algo, adicione a normalização do specifier aqui.
const ROOT = process.cwd();
const CANONICO = resolve(ROOT, 'src/lib/custo/recomporCustoProducao.ts');
const ESPELHO = resolve(ROOT, 'supabase/functions/_shared/recompor-custo-producao.ts');

describe('paridade: recomporCustoProducao (src) × recompor-custo-producao (edge)', () => {
  it('os dois arquivos são byte-idênticos (helper puro, sem import a normalizar)', () => {
    expect(readFileSync(ESPELHO, 'utf8')).toBe(readFileSync(CANONICO, 'utf8'));
  });
});
