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
    // O ponto que mais importa: o signup NÃO pode passar a chamar a RPC. Seria "migrar" um writer que a
    // RLS barra hoje para um caminho que precisaria de SECURITY DEFINER — abrindo escrita ao customer.
    expect(
      src,
      'FALHA ABERTA: o signup passou a chamar register_carteira_member. O writer era morto por RLS; ' +
        'dar-lhe um caminho que funcione deixa um customer anexar-se a um código Omie arbitrário.',
    ).not.toMatch(/register_carteira_member/);
  });

  it('AdminApprovals grava o vínculo pela RPC, na conta colacor_sc', () => {
    const src = read(APPROVALS);
    expect(
      src,
      'REGRESSÃO: a aprovação voltou a inserir no espelho omie_clientes',
    ).not.toMatch(/from\('omie_clientes'\)/);
    expect(
      src,
      'REGRESSÃO: sumiu o writer de vínculo da aprovação (cliente aprovado ficaria sem carteira)',
    ).toMatch(/\.rpc\('register_carteira_member'/);
    // `buscar_por_documento` consulta a conta colacor_sc (credencial default do omie-cliente). Gravar em
    // outra conta anexaria o cliente ao vendedor errado — comissão para quem não vendeu.
    expect(
      src,
      'REGRESSÃO: a aprovação não grava mais na conta colacor_sc (a que buscar_por_documento consulta)',
    ).toMatch(/register_carteira_member'[\s\S]{0,220}p_account:\s*'colacor_sc'/);
  });

  it('o gate `already_linked` consulta a MESMA fonte que o writer grava (par indivisível)', () => {
    const src = read(APPROVALS);
    expect(
      src,
      'REGRESSÃO: o gate already_linked voltou a checar o espelho enquanto o writer grava na proof — ' +
        'a checagem passa a mentir e a aprovação re-registra por cima',
    ).toMatch(/from\('omie_customer_account_map'\)[\s\S]{0,220}\.eq\('account', 'colacor_sc'\)/);
    // Fail-closed: erro na checagem não pode virar "não vinculado" silencioso.
    expect(
      src,
      'REGRESSÃO: o gate voltou a engolir o erro da checagem (erro → segue como se não houvesse vínculo)',
    ).toMatch(/existingError/);
  });
});
