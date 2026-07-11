import { describe, it, expect } from 'vitest';
import { buildDocUserMapFailClosed } from './omie-doc-user-map';

// P1 (Codex xhigh 2026-07-10, money-path fail-closed): no syncPedidos do omie-vendas-sync o docToUserMap
// (doc normalizado -> user_id de profiles) alimenta o fallback resolveClientUserId (ConsultarCliente -> doc
// -> user). Com last-write-wins, se 2 profiles compartilham o mesmo CPF/CNPJ o ÚLTIMO da paginação vencia e
// o pedido money-path era atribuído ao user ARBITRÁRIO. Este helper puro (espelhado verbatim no edge) é o
// análogo VENDAS do fetchProfileDocUserMap (P1b lado profile): doc ambíguo (2+ users distintos) fica FORA do
// mapa — precisão > recall. FALSIFICAÇÃO no rodapé (sabote o helper e exija vermelho).
describe('buildDocUserMapFailClosed (P1 fail-closed money-path — resolver de identidade do syncPedidos)', () => {
  it('doc com 1 user distinto entra no mapa', () => {
    const m = buildDocUserMapFailClosed([{ doc: '11111111111', userId: 'u1' }]);
    expect(m.get('11111111111')).toBe('u1');
    expect(m.size).toBe(1);
  });

  it('FAIL-CLOSED: doc compartilhado por 2 users DISTINTOS não entra (não chuta o arbitrário)', () => {
    const m = buildDocUserMapFailClosed([
      { doc: '99999999999999', userId: 'u1' },
      { doc: '99999999999999', userId: 'u2' },
    ]);
    expect(
      m.has('99999999999999'),
      'doc ambíguo jamais deve mapear — last-write-wins reintroduzido?',
    ).toBe(false);
  });

  it('mesmo user repetido no doc (duplicata de paginação) NÃO é ambiguidade — mapeia', () => {
    const m = buildDocUserMapFailClosed([
      { doc: '11111111111', userId: 'u1' },
      { doc: '11111111111', userId: 'u1' },
    ]);
    expect(m.get('11111111111')).toBe('u1');
  });

  it('3+ users no mesmo doc → fora do mapa', () => {
    const m = buildDocUserMapFailClosed([
      { doc: 'd', userId: 'u1' },
      { doc: 'd', userId: 'u2' },
      { doc: 'd', userId: 'u3' },
    ]);
    expect(m.has('d')).toBe(false);
  });

  it('ambiguidade é STICKY: uma 3ª ocorrência do 1º user não ressuscita o doc', () => {
    const m = buildDocUserMapFailClosed([
      { doc: 'd', userId: 'u1' },
      { doc: 'd', userId: 'u2' },
      { doc: 'd', userId: 'u1' },
    ]);
    expect(
      m.has('d'),
      'doc já marcado ambíguo voltou ao mapa — fail-closed não é sticky',
    ).toBe(false);
  });

  it('doc ambíguo não contamina doc limpo (isolamento por chave)', () => {
    const m = buildDocUserMapFailClosed([
      { doc: 'ambig', userId: 'u1' },
      { doc: 'ambig', userId: 'u2' },
      { doc: 'limpo', userId: 'u3' },
    ]);
    expect(m.has('ambig')).toBe(false);
    expect(m.get('limpo')).toBe('u3');
  });

  it('ordem de aparição não altera o resultado (comutativo no fail-closed)', () => {
    const a = buildDocUserMapFailClosed([
      { doc: 'd', userId: 'u2' },
      { doc: 'd', userId: 'u1' },
    ]);
    expect(a.has('d')).toBe(false);
  });

  it('doc vazio não vira chave (o boundary do edge já filtra doc<11)', () => {
    const m = buildDocUserMapFailClosed([{ doc: '', userId: 'u1' }]);
    expect(m.size).toBe(0);
  });

  it('userId vazio não vira vínculo (sem user não há identidade)', () => {
    const m = buildDocUserMapFailClosed([{ doc: '11111111111', userId: '' }]);
    expect(m.has('11111111111')).toBe(false);
  });

  it('array vazio → mapa vazio', () => {
    expect(buildDocUserMapFailClosed([]).size).toBe(0);
  });
});
