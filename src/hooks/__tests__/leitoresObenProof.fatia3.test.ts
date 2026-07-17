import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Guard (P0-B-bis épico-drop do espelho, Fatia 3): leitores OBEN resolvem código->user pela PROOF ──
// Os 6 sítios resolviam omie_codigo_cliente (o slot OBEN vindo da busca) -> user_id no espelho poluído
// omie_clientes filtrando .eq('empresa_omie','oben'). Como o espelho é 100% 'colacor' (rótulo fabricado),
// esse filtro era VAZIO → sempre caía no fallback por documento. A proof fresca
// (omie_customer_account_map_fresco, UNIQUE(omie_codigo_cliente,account), document-first, TTL 7d) tem o
// vínculo OBEN real → resolve certo E recupera cobertura, mantendo o fail-closed (miss → fallback por doc).
// Teste TEXTUAL (anti-regressão de fonte). Ver design 2026-07-12-carteira-membership-ledger-drop-espelho §4.
const CWD = resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(resolve(CWD, rel), 'utf8');
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

const ARQUIVOS = [
  { rel: 'src/hooks/useBuscaClienteOmie.ts', sitios: 2 },
  { rel: 'src/hooks/unifiedOrder/useCustomerSelection.ts', sitios: 2 },
  { rel: 'src/pages/FarmerCalls.tsx', sitios: 2 },
];

describe('Fatia 3: leitores OBEN resolvem pela proof fresca, não pelo espelho omie_clientes', () => {
  for (const { rel, sitios } of ARQUIVOS) {
    const src = read(rel);

    it(`${rel}: não lê mais o espelho omie_clientes`, () => {
      expect(
        src,
        `REGRESSÃO: ${rel} voltou a resolver código->user pelo espelho poluído omie_clientes`,
      ).not.toMatch(/from\(['"]omie_clientes['"]\)/);
    });

    it(`${rel}: resolve os ${sitios} sítios pela view fresca account=oben`, () => {
      expect(
        count(src, "from('omie_customer_account_map_fresco')"),
        `${rel} deve resolver os ${sitios} sítios OBEN pela proof fresca`,
      ).toBe(sitios);
      expect(
        count(src, "eq('account', 'oben')"),
        `cada sítio OBEN deve filtrar account=oben (fail-closed por-conta)`,
      ).toBeGreaterThanOrEqual(sitios);
    });
  }
});
