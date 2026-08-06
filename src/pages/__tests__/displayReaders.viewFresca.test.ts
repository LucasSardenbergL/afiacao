import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Guard (P0-B-bis PR-4 #9/#12): leitores de DISPLAY saíram do espelho poluído omie_clientes ──
// O espelho é 1 linha/user com rótulo empresa_omie=100% 'colacor' (mentira uniforme) e código
// colacor_sc-dominante — ler dele sem conta traz o código/rótulo de OUTRA conta. A fonte account-correta
// é a view fresca omie_customer_account_map_fresco (document-first, UNIQUE(user_id,account), TTL 7d).
// Teste TEXTUAL (comportamental é caro e o valor aqui é anti-regressão de fonte). Ver design §4/§5.
const CWD = resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(resolve(CWD, rel), 'utf8');

describe('leitores de display migraram do espelho omie_clientes p/ a view fresca (P0-B-bis PR-4)', () => {
  // #12 SalesPrintDashboard: o código é usado p/ buscar endereço via omie-cliente (conta colacor_sc) →
  // o código correto é o da conta colacor_sc. O filtro antigo .eq('empresa_omie','colacor') NÃO filtrava
  // nada (o espelho é 100% 'colacor'); a fresca account=colacor_sc traz o código document-first correto.
  it('#12 SalesPrintDashboard lê o código pela view fresca account=colacor_sc', () => {
    const src = read('src/pages/SalesPrintDashboard.tsx');
    expect(
      src,
      'REVERSÃO: SalesPrintDashboard não lê o código pela view fresca colacor_sc',
    ).toMatch(/from\('omie_customer_account_map_fresco'\)[\s\S]{0,200}\.eq\('account', 'colacor_sc'\)/);
    expect(
      src,
      'REGRESSÃO: SalesPrintDashboard voltou a ler o espelho poluído omie_clientes',
    ).not.toMatch(/from\('omie_clientes'\)/);
  });

  // #9 Customer360: lia empresa_omie do espelho (sempre 'colacor' fabricado) p/ derivar a empresa da tarefa
  // por voz. Dependência REMOVIDA — a tarefa usa o default explícito empresa="oben" da tela (Oben-cêntrica);
  // derivar da view seria ambíguo p/ cliente multi-conta (precisão>recall: não fabricar a conta).
  it('#9 Customer360 não lê mais o espelho omie_clientes (empresa fabricada removida)', () => {
    const src = read('src/pages/Customer360.tsx');
    expect(
      src,
      'REGRESSÃO: Customer360 voltou a ler empresa_omie do espelho poluído omie_clientes',
    ).not.toMatch(/from\('omie_clientes'\)/);
  });
});
