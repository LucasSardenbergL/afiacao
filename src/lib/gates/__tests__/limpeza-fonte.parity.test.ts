import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// O stripper de comentários é a lente de TODO gate textual do repo — os de `src/` (vitest) e os
// das edges (Deno). Um gate mede a FONTE depois de passar por ele; se as duas cópias divergirem,
// a mesma forma proibida passa num runtime e reprova no outro, e o fiscal fica verde por
// CEGUEIRA num dos lados (a classe medida em docs/historico/gates-textuais-cegos.md).
//
// A duplicação é OBRIGATÓRIA, não preguiça: `bun run test:edges` roda `deno test --no-remote`, e
// sob esse flag um teste de edge NÃO pode importar de `src/`. Então o jeito de não ter duas
// verdades é provar que os bytes são os mesmos. Divergência = CI vermelho.
//
// Mesmo padrão de sayerlack-sku.parity.test.ts / costLadder.parity.test.ts.
const ROOT = process.cwd();
const CANONICO = resolve(ROOT, 'src/lib/gates/limpeza-fonte.ts');
const ESPELHO = resolve(ROOT, 'supabase/functions/_shared/limpeza-fonte.ts');

describe('paridade: limpeza-fonte (src) × limpeza-fonte (edge)', () => {
  it('os dois arquivos são byte-idênticos', () => {
    const canonico = readFileSync(CANONICO, 'utf8');
    const espelho = readFileSync(ESPELHO, 'utf8');
    expect(espelho).toBe(canonico);
  });

  // Controle positivo: sem isto, um `resolve` errado deixaria os dois lados lendo o MESMO arquivo
  // (ou dois vazios) e o teste acima passaria sem comparar nada.
  it('CALIBRAÇÃO: os dois caminhos são distintos e não-vazios', () => {
    expect(CANONICO).not.toBe(ESPELHO);
    expect(readFileSync(CANONICO, 'utf8').length).toBeGreaterThan(1000);
    expect(readFileSync(ESPELHO, 'utf8').includes('export function removerComentarios')).toBe(true);
  });
});
