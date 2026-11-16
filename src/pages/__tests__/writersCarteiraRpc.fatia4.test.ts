import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Guard (P0-B-bis Fatia 4): os writers de vínculo do FRONTEND saíram do espelho omie_clientes ──
// A Fatia 4 corta a última escrita pontual no espelho poluído. Os dois sítios de frontend tiveram
// destinos DIFERENTES, e a diferença é de segurança, não de estilo:
//
//   • Auth.tsx (signup)  → REMOVIDO. O writer era MORTO: a RLS de omie_clientes concede ALL só a staff
//     (has_role master|employee) e quem roda o signup é o cliente recém-criado; o insert não checava
//     `error`, então falhava em silêncio desde março. Medido por psql-ro em 18/07: 0 de 6909 linhas têm
//     a assinatura `APP_%` que só ele produzia. Migrá-lo para a RPC exigiria SECURITY DEFINER e ABRIRIA
//     uma escrita que a RLS hoje fecha — um customer poderia anexar-se a um código Omie arbitrário.
//     Falha ABERTA: muda autorização e não comportamento, e o CI não vê. Por isso: remover, não migrar.
//
//   • AdminApprovals (aprovação) → MIGRADO p/ register_carteira_member. Roda como staff, que a RLS já
//     autoriza. Gate-leitor e writer são PAR INDIVISÍVEL: se a checagem `already_linked` consultar uma
//     fonte diferente de onde o vínculo é gravado, ela mente e a aprovação re-registra por cima.
//
// Teste TEXTUAL (o valor aqui é anti-regressão de fonte e anti-reversão do deploy do Lovable, que já
// mordeu no #1272 — o Publish serve o build anterior e o código no repo parece certo). Ver design §4/§9.
const CWD = resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(resolve(CWD, rel), 'utf8');

const AUTH = 'src/pages/Auth.tsx';
const APPROVALS = 'src/pages/AdminApprovals.tsx';

describe('Fatia 4: writers de vínculo do frontend saíram do espelho omie_clientes', () => {
  it('sentinela: leu os arquivos reais', () => {
    expect(read(AUTH)).toContain('signUpData');
    expect(read(APPROVALS)).toContain('tryLinkOmie');
  });

  it('Auth.tsx não escreve mais no espelho — e NÃO ganhou a RPC no lugar', () => {
    const src = read(AUTH);
    expect(
      src,
      'REGRESSÃO: o writer morto do signup voltou a inserir no espelho omie_clientes',
    ).not.toMatch(/from\('omie_clientes'\)/);
    // O ponto que mais importa: o signup NÃO pode passar a CHAMAR a RPC. Seria "migrar" um writer que a
    // RLS barra hoje para um caminho que precisaria de SECURITY DEFINER — abrindo escrita ao customer.
    // Ancorado em `.rpc(` de propósito: um `not.toMatch(/register_carteira_member/)` cru casaria o
    // comentário-tombstone acima, que MENCIONA a RPC para explicar por que ela não é usada aqui — o
    // assert reprovaria a própria documentação da decisão que ele existe para proteger.
    expect(
      src,
      'FALHA ABERTA: o signup passou a chamar register_carteira_member. O writer era morto por RLS; ' +
        'dar-lhe um caminho que funcione deixa um customer anexar-se a um código Omie arbitrário.',
    ).not.toMatch(/\.rpc\(\s*['"]register_carteira_member/);
  });

  // b339bb5b (residual, migration 20261116180000): a aprovação não grava mais o vínculo do browser. A RPC
  // recusa vínculo novo do employee (42501); quem admite é a edge, com o código conferido na Omie. O gate
  // `already_linked` e o writer vivem juntos na edge (par indivisível) — ver edge-money-path-invariants.
  it('AdminApprovals delega o vínculo à edge (vincular_aprovado) e não manda código', () => {
    const src = read(APPROVALS);
    expect(
      src,
      'REGRESSÃO: a aprovação voltou a inserir no espelho omie_clientes',
    ).not.toMatch(/from\('omie_clientes'\)/);
    expect(
      src,
      'FALHA ABERTA: a aprovação voltou a chamar a RPC de carteira do browser — o código volta a vir do ' +
        'browser e um código de OUTRO cliente derruba a dona dele para Hunter',
    ).not.toMatch(/\.rpc\(\s*['"]register_carteira_member/);
    expect(
      src,
      'REGRESSÃO: sumiu o writer de vínculo da aprovação (cliente aprovado ficaria sem carteira)',
    ).toMatch(/action: 'vincular_aprovado', user_id: profileUserId \}/);
    expect(
      src,
      'FALHA ABERTA: a aprovação voltou a escrever direto no mapa de vínculos',
    ).not.toMatch(/from\('omie_customer_account_map'\)\s*\.(insert|upsert|update)/);
  });
});
