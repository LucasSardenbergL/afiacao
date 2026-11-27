import { describe, it, expect } from 'vitest';
import { motivosEnvioBloqueado, envioBloqueado, type EntradaMotivosEnvio } from '../motivos-envio';
import type { ProductCartItem, ServiceCartItem } from '@/hooks/unifiedOrder/types';
import type { EstadoFormasUI } from '@/services/orderSubmission/formasDegradacao';

function prod(account: 'oben' | 'colacor', unit_price = 10): ProductCartItem {
  return {
    type: 'product', account, quantity: 1, unit_price,
    product: { id: `p-${account}`, omie_codigo_produto: 1, codigo: 'C', descricao: 'Lixa', unidade: 'UN' },
  } as unknown as ProductCartItem;
}
const servico = (comTipo: boolean) =>
  ({ type: 'service', quantity: 1, userTool: { id: 't' }, servico: comTipo ? { descricao: 'Afiar' } : null }) as unknown as ServiceCartItem;

const COM_PROVA: EstadoFormasUI = { degradado: true, motivo: 'fallback', erro: false, condicoesAusentes: ['000'] };

function base(over: Partial<EntradaMotivosEnvio> = {}): EntradaMotivosEnvio {
  return {
    temCliente: true, carregandoCliente: false,
    obenProductItems: [prod('oben')], colacorProductItems: [], serviceItems: [],
    vendedorDivergencias: [], estadoVendedor: 'nao_verificado', estadoCadastro: 'confirmado', loadingFormas: false, exigeCondicao: true,
    selectedParcelaOben: '999', selectedParcelaColacor: '999',
    ...over,
  };
}
const codigos = (e: EntradaMotivosEnvio) => motivosEnvioBloqueado(e).map(m => m.codigo);

describe('motivosEnvioBloqueado — o porquê do Enviar cinza', () => {
  it('pedido completo → nenhum motivo e o botão habilita', () => {
    const m = motivosEnvioBloqueado(base());
    expect(m).toEqual([]);
    expect(envioBloqueado(false, m)).toBe(false);
  });

  it('enviando → desabilita sem inventar motivo (o spinner já diz)', () => {
    expect(envioBloqueado(true, motivosEnvioBloqueado(base()))).toBe(true);
  });

  it.each<[string, Partial<EntradaMotivosEnvio>, string, string]>([
    ['sem cliente', { temCliente: false }, 'sem_cliente', 'Escolha o cliente'],
    ['cliente carregando', { carregandoCliente: true }, 'carregando_cliente', 'Carregando dados do cliente…'],
    ['carrinho vazio', { obenProductItems: [] }, 'carrinho_vazio', 'Carrinho vazio'],
    ['serviço sem tipo', { obenProductItems: [], serviceItems: [servico(false)] }, 'servico_sem_tipo', 'Escolha o serviço de cada ferramenta'],
    ['vendedor divergente', { vendedorDivergencias: ['oben'] }, 'vendedor_divergente', 'Vendedor divergente'],
    ['8.1: divergente sem lista', { estadoVendedor: 'divergente' }, 'vendedor_divergente', 'Vendedor divergente'],
    ['8.2: identificando o cliente', { estadoCadastro: 'resolvendo' }, 'identificando_cliente', 'Identificando o cliente no app…'],
    ['8.2: cliente sem cadastro', { estadoCadastro: 'sem_cadastro' }, 'sem_cadastro_cliente', 'Cliente sem cadastro no app — cadastre e use “Trocar”'],
    ['8.2: busca do cadastro falhou', { estadoCadastro: 'indisponivel' }, 'cadastro_indisponivel', 'Não foi possível identificar o cliente no app — use “Trocar”'],
    ['8.2: busca falhou com envio pendente (Codex r4)', { estadoCadastro: 'indisponivel', envioPendente: true }, 'cadastro_indisponivel', 'Não foi possível identificar o cliente no app — envio pendente: recarregue a página'],
    ['8.2: sem cadastro com envio pendente (Codex r4)', { estadoCadastro: 'sem_cadastro', envioPendente: true }, 'sem_cadastro_cliente', 'Cliente sem cadastro no app — envio pendente: recarregue a página'],
    ['8.1: validando vendedor', { estadoVendedor: 'validando' }, 'validando_vendedor', 'Validando vendedor…'],
    ['8.1: validação falhou', { estadoVendedor: 'indisponivel' }, 'vendedor_indisponivel', 'Não foi possível validar o vendedor — use “Trocar”'],
    ['preço zerado', { obenProductItems: [prod('oben', 0)] }, 'preco_invalido', 'Item com preço zerado'],
    ['condição sumiu do Omie', { estadoFormasOben: COM_PROVA }, 'condicoes_indisponiveis', 'Condição de pagamento indisponível'],
    ['condições carregando', { loadingFormas: true }, 'carregando_condicoes', 'Carregando condições…'],
    ['sem condição Oben', { selectedParcelaOben: '' }, 'sem_condicao', 'Escolha a condição de pagamento (Oben)'],
  ])('%s → motivo e botão cinza', (_n, over, codigo, texto) => {
    const m = motivosEnvioBloqueado(base(over));
    expect(m).toEqual([{ codigo, texto }]);
    expect(envioBloqueado(false, m)).toBe(true);
  });

  it('sem condição nas DUAS contas → um motivo citando as duas', () => {
    const m = motivosEnvioBloqueado(base({
      colacorProductItems: [prod('colacor')], selectedParcelaOben: '', selectedParcelaColacor: '',
    }));
    expect(m.map(x => x.texto)).toEqual(['Escolha a condição de pagamento (Oben e Colacor)']);
  });

  it('cliente ausente E carrinho vazio → os dois motivos, na ordem do fluxo', () => {
    expect(codigos(base({ temCliente: false, obenProductItems: [] }))).toEqual(['sem_cliente', 'carrinho_vazio']);
  });

  it('só serviço: condição de pagamento e loading de formas NÃO contam (não há conta de produto)', () => {
    expect(codigos(base({
      obenProductItems: [], serviceItems: [servico(true)], loadingFormas: true, selectedParcelaOben: '',
    }))).toEqual([]);
  });

  it('autoatendimento não escolhe condição → parcela vazia e loading não bloqueiam', () => {
    expect(codigos(base({ exigeCondicao: false, loadingFormas: true, selectedParcelaOben: '' }))).toEqual([]);
  });

  it('degradação SEM prova (lista genérica, condição do cliente presente) não bloqueia', () => {
    const semProva: EstadoFormasUI = { degradado: true, motivo: 'fallback', erro: false, condicoesAusentes: [] };
    expect(codigos(base({ estadoFormasOben: semProva }))).toEqual([]);
  });

  it('condição que sumiu numa conta SEM itens não bloqueia', () => {
    expect(codigos(base({ estadoFormasColacor: COM_PROVA }))).toEqual([]);
  });
});
