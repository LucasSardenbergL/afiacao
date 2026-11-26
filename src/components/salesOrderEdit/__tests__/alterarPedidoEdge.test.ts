// Fiação da action `alterar_pedido` (edge omie-vendas-sync v1.48). As REGRAS estão provadas em Deno
// (`edicao-omie_test.ts`); isto prova que a edge AINDA as chama, e na ordem certa: toda trava antes da
// 1ª mutação no ERP, o cabeçalho antes do delete+add, e nenhum cabeçalho fabricado.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fonte = readFileSync(resolve(process.cwd(), 'supabase/functions/omie-vendas-sync/index.ts'), 'utf8');
const inicio = fonte.indexOf('case "alterar_pedido": {');
const fim = fonte.indexOf('case "excluir_pedido": {', inicio);
const bloco = fonte.slice(inicio, fim);

function posicao(trecho: string): number {
  const i = bloco.indexOf(trecho);
  expect(i, `trecho ausente no alterar_pedido: ${trecho}`).toBeGreaterThan(-1);
  return i;
}

describe('alterar_pedido — travas antes de mutar o Omie', () => {
  it('o bloco da action foi encontrado', () => {
    expect(inicio).toBeGreaterThan(-1);
    expect(fim).toBeGreaterThan(inicio);
  });

  it('pedido local e gêmeo são conferidos antes de qualquer escrita (trilha ATP, revisão, Omie)', () => {
    const local = posicao('vereditoPedidoLocalEdicao(');
    const gemeo = posicao('vereditoGemeoEdicao(');
    expect(local).toBeLessThan(gemeo);
    expect(gemeo).toBeLessThan(posicao('from("atp_decisoes").insert'));
    expect(gemeo).toBeLessThan(posicao('registrarRevisao(supabaseAdmin'));
  });

  it('etapa e cliente vivos são conferidos antes do cabeçalho e do delete+add', () => {
    const etapa = posicao('vereditoEtapaEdicao(lidoEdit)');
    const cliente = posicao('vereditoClienteEdicao({');
    const cabecalho = posicao('"AlterarPedidoVenda"');
    const exclusao = posicao('"ExcluirItemPedido"');
    expect(etapa).toBeLessThan(cliente);
    expect(cliente).toBeLessThan(cabecalho);
    expect(cabecalho).toBeLessThan(exclusao);
  });

  it('cabeçalho/frete/classificação vêm da LEITURA — nada de etapa "10", previsão de hoje ou frete do zero', () => {
    expect(bloco).not.toContain('etapa: "10"');
    expect(bloco).not.toMatch(/data_previsao:\s*paraDataOmie\(hojeSP\(\)\)/);
    expect(bloco).not.toContain('modalidade: "0"');
    posicao('cabecalhoDaEdicao({');
    posicao('freteDaEdicao({');
    posicao('informacoesAdicionaisDaEdicao({');
  });

  it('o payload regravado guarda a âncora do cliente para a próxima edição', () => {
    posicao('codigo_cliente: omieCodigoClienteEdit }');
  });
});
