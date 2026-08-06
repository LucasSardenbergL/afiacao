import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Guard money-path (P0-A → P0-B-bis Fatia 5): resolução de código Omie por user_id ──
// `selectCustomerByUserId` (deep-link "Novo pedido" do Customer360) e `handleAICustomerSelect`
// (fluxo de IA) resolvem o código que vira `OmieCustomer.codigo_cliente` — que o submitOrder trata
// como o código da conta OBEN. Resolver pela conta ERRADA manda o pedido ao cliente errado.
//
// O guard MUDOU DE FORMA na Fatia 5, e a mudança é o ponto deste arquivo:
//   ANTES  as duas vias liam `omie_clientes` e o guard exigia `.eq('empresa_omie','oben')` (≥2×),
//          para o código COLACOR não vazar para o campo oben.
//   AGORA  as duas leituras foram REMOVIDAS. Não é migração: eram mortas por construção —
//          `empresa_omie` é `DEFAULT 'colacor' NOT NULL` sem writer que a setasse, então o filtro
//          casava 0 de 6909 linhas (medido em prod por psql-ro, 2026-07-18) e as duas vias já
//          resolviam SEMPRE pelo caminho alternativo (API oben por documento / codigo_cliente=0
//          + preflight fail-closed). O espelho é DROPADO nesta fatia.
//   ⇒ o guard vira o INVERSO: provar que o espelho não voltou. Um `.eq('empresa_omie','oben')`
//     reaparecendo aqui não é mais "proteção", é `42P01` em runtime sobre uma tabela inexistente.
//
// Teste TEXTUAL (o hook é grande demais para um comportamental barato); a prova comportamental
// completa vive no guard da fronteira (edge omie-vendas-sync) + seu helper.
const CWD = resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(resolve(CWD, rel), 'utf8');
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

const SRC = 'src/hooks/useUnifiedOrder.ts';

describe('useUnifiedOrder: resolução de código Omie por user_id é account-correta (anti cross-conta)', () => {
  const src = read(SRC);

  it('sentinela: leu o hook real (as duas vias existem)', () => {
    expect(src).toContain('selectCustomerByUserId');
    expect(src).toContain('handleAICustomerSelect');
    // âncora do fluxo que REALMENTE resolve o código no handleAICustomerSelect
    expect(src).toContain("action: 'buscar_cliente'");
  });

  it('⭐ Fatia 5: o espelho omie_clientes não é mais lido (a tabela foi DROPADA)', () => {
    expect(
      count(src, "from('omie_clientes')"),
      'REGRESSÃO: voltou a ler o espelho omie_clientes — a tabela NÃO EXISTE MAIS (P0-B-bis Fatia 5). ' +
        'Isto não degrada para "sem resultado": o PostgREST devolve erro, e como o caller ignora `error` ' +
        'a falha é SILENCIOSA. Para resolver código por conta, use omie_customer_account_map_fresco ' +
        "+ .eq('account','oben'), como o handleStaffAddTool já faz neste arquivo.",
    ).toBe(0);
    expect(
      count(src, "eq('empresa_omie', 'oben')"),
      'REGRESSÃO: reapareceu filtro por empresa_omie — coluna do espelho dropado (era DEFAULT mentiroso, ' +
        'casava 0 de 6909; o filtro de conta account-correto é .eq("account", ...) na proof)',
    ).toBe(0);
  });

  it('as vias de resolução por user_id sobreviveram (contar 0 não pode significar "sumiu tudo")', () => {
    // Sem isto, apagar o hook inteiro deixaria o teste acima VERDE. Cada via mantém seu caminho:
    // o fluxo de IA resolve por documento na API oben; o deep-link monta o cliente pelo profile e
    // deixa codigo_cliente=0, que o preflight do submit bloqueia (fail-closed).
    expect(
      src,
      'REGRESSÃO: handleAICustomerSelect perdeu o fallback por documento na conta oben',
    ).toMatch(/action: 'buscar_cliente'[\s\S]{0,80}account: 'oben'/);
    expect(
      src,
      'REGRESSÃO: selectCustomerByUserId parou de montar o cliente pelo profile',
    ).toMatch(/buildOmieCustomer\(userId, profile, null\)/);
  });

  // ── #11 (P0-B-bis PR-4): a via INVERSA (codigo->user_id) do handleStaffAddTool ──
  // Resolver o user_id por omie_codigo_cliente (o código da conta OBEN do selectedCustomer) SEM conta
  // pegava o user ERRADO quando o mesmo número colide entre contas no espelho poluído (Codex P2 — anexa a
  // ferramenta ao cliente errado). A view fresca é UNIQUE(omie_codigo_cliente, account) → filtrar
  // account=oben resolve o user certo; miss (ausente/stale) cai no fallback por documento (fail-closed).
  it('handleStaffAddTool resolve codigo->user pela view fresca account=oben (não pelo espelho sem conta)', () => {
    expect(
      src,
      'REGRESSÃO: handleStaffAddTool voltou a resolver codigo->user pelo espelho poluído omie_clientes sem conta',
    ).toMatch(/from\('omie_customer_account_map_fresco'\)\s*\.select\('user_id'\)[\s\S]{0,160}\.eq\('account', 'oben'\)/);
  });
});
