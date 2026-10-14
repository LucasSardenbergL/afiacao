import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Paridade textual money-path: a edge `algorithm-a-audit` NÃO importa de src/ (Deno), então o
// núcleo da auditoria de margem vive espelhado nela. O bloco entre MIRROR-START/END tem de ser
// VERBATIM nos dois arquivos — pega reescrita do Lovable no deploy e drift manual. Antes deste
// teste o "espelho VERBATIM" era só um comentário: a edge tinha o núcleo compactado à mão.
// O comportamento do núcleo se prova em auditoria-margem.test.ts (contra a fonte de src/).

const INICIO = '// MIRROR-START auditoria-margem core';
const FIM = '// MIRROR-END auditoria-margem core';

function bloco(source: string, arquivo: string): string {
  const a = source.indexOf(INICIO);
  const b = source.indexOf(FIM);
  if (a === -1 || b === -1 || b < a) throw new Error(`${arquivo}: bloco MIRROR-START/END ausente ou fora de ordem`);
  if (source.indexOf(INICIO, a + 1) !== -1) throw new Error(`${arquivo}: MIRROR-START duplicado`);
  return source.slice(a, b + FIM.length);
}

// Só comentário de LINHA (`// …`, fora de string) — o núcleo não usa `/* */` nem `//` dentro de literal.
const removerComentarios = (s: string): string => s.replace(/(^|[^:'"])\/\/.*$/gm, '$1');

const normalizar = (s: string): string =>
  s.split('\n').map((l) => l.trimEnd()).join('\n');

describe('paridade edge algorithm-a-audit ↔ src auditoria-margem (núcleo)', () => {
  const root = process.cwd();
  const src = readFileSync(resolve(root, 'src/lib/custos/auditoria-margem.ts'), 'utf8');
  const edge = readFileSync(resolve(root, 'supabase/functions/algorithm-a-audit/index.ts'), 'utf8');

  it('o núcleo é VERBATIM nos dois arquivos', () => {
    expect(normalizar(bloco(edge, 'edge'))).toBe(normalizar(bloco(src, 'src')));
  });

  it('o núcleo espelhado tem a fórmula de R$ da linha e não a percentual legada', () => {
    // Os negativos rodam sobre o CÓDIGO: o comentário do núcleo cita a fórmula antiga de propósito.
    const nucleo = removerComentarios(bloco(src, 'src'));
    expect(nucleo).toContain('const actualPrice = Math.max(0, up - desc / qty);');
    expect(nucleo).toContain('if (Math.round(desc * 100) > Math.round(qty * up * 100)) continue;');
    expect(nucleo).not.toMatch(/\/\s*100\)/);
    expect(nucleo).not.toMatch(/\bo\.discount\b/);
  });

  it('a edge LÊ desconto_valor do banco (sem a coluna no select, todo desconto vira desconhecido)', () => {
    expect(edge).toContain(
      ".select('customer_user_id, product_id, quantity, unit_price, desconto_valor, sales_order_id')",
    );
    expect(removerComentarios(edge)).not.toMatch(/select\([^)]*\bdiscount\b/);
  });
});
