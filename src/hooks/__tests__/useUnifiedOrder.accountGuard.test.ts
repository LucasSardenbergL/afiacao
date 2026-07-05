import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Guard money-path (P0-A): resolução de código Omie por user_id NÃO pode vazar entre contas ──
// `selectCustomerByUserId` (deep-link "Novo pedido" do Customer360) e `handleAICustomerSelect`
// (fluxo de IA) resolvem o código do cliente na tabela `omie_clientes` por user_id e o colocam em
// `OmieCustomer.codigo_cliente` — que o submitOrder trata como o código da conta OBEN. `omie_clientes`
// tem UNIQUE (user_id, empresa_omie) e hoje é um espelho parcial (só colacor); sem filtrar
// `empresa_omie='oben'`, o código COLACOR entra no campo oben e o pedido vai ao cliente errado
// (mesma classe do bug do SalesQuotes, achado no challenge do Codex). Este teste é TEXTUAL (o hook
// é grande demais para um teste comportamental barato) e pega a regressão de remover o filtro; a
// prova comportamental completa vive no guard da fronteira (edge omie-vendas-sync) + seu helper.
const CWD = resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(resolve(CWD, rel), 'utf8');
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

const SRC = 'src/hooks/useUnifiedOrder.ts';

describe('useUnifiedOrder: resolução de código Omie por user_id filtra empresa_omie (anti cross-conta)', () => {
  const src = read(SRC);

  it('sentinela: leu o hook real (as duas vias existem)', () => {
    expect(src).toContain('selectCustomerByUserId');
    expect(src).toContain('handleAICustomerSelect');
    expect(src).toContain("from('omie_clientes')");
  });

  it('as duas vias que resolvem codigo_cliente (oben) por user_id filtram empresa_omie=oben', () => {
    expect(
      count(src, "eq('empresa_omie', 'oben')"),
      'REGRESSÃO: lookup de omie_clientes por user_id sem filtro de conta — o código de OUTRA conta ' +
        '(colacor) vaza para OmieCustomer.codigo_cliente (oben) e o pedido vai ao cliente errado (P0-A)',
    ).toBeGreaterThanOrEqual(2);
  });
});
