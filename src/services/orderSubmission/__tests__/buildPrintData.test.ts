import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../helpers', () => ({
  findParcelaDesc: vi.fn((codigo: string) => `desc:${codigo}`),
  getToolName: vi.fn(() => 'FerramentaMock'),
}));

import { buildPrintData } from '../buildPrintData';
import { DELIVERY_FEES } from '@/types';
import type { DeliveryOption } from '@/types';
import type {
  CompanyProfile,
  FormaPagamento,
  OmieCustomer,
  ProductCartItem,
  ServiceCartItem,
} from '@/hooks/unifiedOrder/types';

type Params = Parameters<typeof buildPrintData>[0];

const customer = {
  razao_social: 'ACME LTDA',
  cnpj_cpf: '12345678000199',
} as OmieCustomer;

function obenItem(over: Partial<ProductCartItem> = {}): ProductCartItem {
  return {
    type: 'product', account: 'oben', quantity: 2, unit_price: 10,
    tint_cor_id: 'cor-1', tint_nome_cor: 'Azul',
    product: { id: 'p1', codigo: 'C1', descricao: 'Lixa', unidade: 'UN', omie_codigo_produto: 'OBEN1' },
    ...over,
  } as unknown as ProductCartItem;
}
function colacorItem(): ProductCartItem {
  return {
    type: 'product', account: 'colacor', quantity: 1, unit_price: 50,
    product: { id: 'p2', codigo: 'C2', descricao: 'Disco', unidade: 'UN', omie_codigo_produto: 'COL1' },
  } as unknown as ProductCartItem;
}
function svcItem(): ServiceCartItem {
  return {
    type: 'service', quantity: 3,
    servico: { omie_codigo_servico: 999, descricao: 'Afiação' },
    userTool: {},
  } as unknown as ServiceCartItem;
}

function makeParams(over: Partial<Params> = {}): Params {
  return {
    customer,
    customerAddress: 'Rua X, 1',
    customerPhone: '11999999999',
    obenProductItems: [],
    colacorProductItems: [],
    serviceItems: [],
    obenSubtotal: 0,
    colacorSubtotal: 0,
    serviceSubtotal: 0,
    parcelaOben: '000',
    parcelaColacor: '000',
    formasPagamentoOben: [] as FormaPagamento[],
    formasPagamentoColacor: [] as FormaPagamento[],
    afiacaoMethod: 'a_vista',
    deliveryOption: 'balcao' as DeliveryOption,
    notes: '',
    results: [],
    companyProfiles: {} as Record<string, CompanyProfile>,
    getServicePrice: () => 25,
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('buildPrintData', () => {
  it('carrinho vazio → array vazio', () => {
    expect(buildPrintData(makeParams())).toEqual([]);
  });

  it('só Oben → 1 bloco isOben, valorTotal = qtd × preço, tinta mapeada', () => {
    const [bloco, ...rest] = buildPrintData(makeParams({
      obenProductItems: [obenItem()],
      obenSubtotal: 20,
      results: ['PV Oben 12345'],
      notes: 'entregar amanhã',
    }));
    expect(rest).toHaveLength(0);
    expect(bloco.isOben).toBe(true);
    expect(bloco.orderNumber).toBe('12345');
    expect(bloco.subtotal).toBe(20);
    expect(bloco.total).toBe(20);
    expect(bloco.frete).toBe(0);
    expect(bloco.desconto).toBe(0);
    expect(bloco.observacoes).toBe('entregar amanhã');
    expect(bloco.condPagamento).toBe('desc:000'); // findParcelaDesc mockado
    expect(bloco.companyName).toBe('OBEN COMÉRCIO LTDA'); // fallback sem perfil
    expect(bloco.items).toHaveLength(1);
    expect(bloco.items[0]).toMatchObject({
      codigo: 'C1', descricao: 'Lixa', quantidade: 2, unidade: 'UN',
      valorUnitario: 10, valorTotal: 20, tintCorId: 'cor-1', tintNomeCor: 'Azul',
    });
  });

  it('só Colacor → 1 bloco não-Oben, orderNumber de "PV Colacor", sem campos de tinta', () => {
    const [bloco] = buildPrintData(makeParams({
      colacorProductItems: [colacorItem()],
      colacorSubtotal: 50,
      results: ['PV Colacor 67890'],
    }));
    expect(bloco.isOben).toBe(false);
    expect(bloco.orderNumber).toBe('67890');
    expect(bloco.total).toBe(50);
    expect(bloco.companyName).toBe('COLACOR COMERCIAL LTDA');
    expect(bloco.items[0]).toMatchObject({ codigo: 'C2', valorTotal: 50 });
    expect('tintCorId' in bloco.items[0]).toBe(false);
  });

  it('só Serviço → frete = DELIVERY_FEES[opção], total = subtotal + frete, preço via callback', () => {
    const opt: DeliveryOption = 'somente_entrega';
    const [bloco] = buildPrintData(makeParams({
      serviceItems: [svcItem()],
      serviceSubtotal: 75,
      results: ['OS 555'],
      deliveryOption: opt,
      getServicePrice: () => 25,
    }));
    expect(bloco.isOben).toBe(false);
    expect(bloco.orderNumber).toBe('555');
    expect(bloco.frete).toBe(DELIVERY_FEES[opt]);
    expect(bloco.total).toBe(75 + DELIVERY_FEES[opt]);
    expect(bloco.condPagamento).toBe('À Vista'); // afiacaoMethod a_vista
    expect(bloco.companyName).toBe('COLACOR S.C LTDA');
    expect(bloco.items[0]).toMatchObject({
      codigo: '999', descricao: 'Afiação', quantidade: 3, unidade: 'SV',
      valorUnitario: 25, valorTotal: 75,
    });
  });

  it('os três → 3 blocos na ordem Oben, Colacor, Serviço', () => {
    const blocos = buildPrintData(makeParams({
      obenProductItems: [obenItem()], obenSubtotal: 20,
      colacorProductItems: [colacorItem()], colacorSubtotal: 50,
      serviceItems: [svcItem()], serviceSubtotal: 75,
      results: ['PV Oben 1', 'PV Colacor 2', 'OS 3'],
    }));
    expect(blocos).toHaveLength(3);
    expect(blocos[0].isOben).toBe(true);
    expect(blocos[0].orderNumber).toBe('1');
    expect(blocos[1].orderNumber).toBe('2');
    expect(blocos[2].orderNumber).toBe('3');
  });

  it('perfis presentes sobrescrevem o fallback hardcoded', () => {
    const companyProfiles = {
      oben: { legal_name: 'OBEN CUSTOM', cnpj: '00.000.000/0001-00', phone: '(00) 0000', address: 'Rua Custom' },
    } as unknown as Record<string, CompanyProfile>;
    const [bloco] = buildPrintData(makeParams({
      obenProductItems: [obenItem()], obenSubtotal: 20,
      companyProfiles,
    }));
    expect(bloco.companyName).toBe('OBEN CUSTOM');
    expect(bloco.companyCnpj).toBe('00.000.000/0001-00');
    expect(bloco.companyPhone).toBe('(00) 0000');
    expect(bloco.companyAddress).toBe('Rua Custom');
  });

  it('results sem o prefixo correspondente → orderNumber vazio', () => {
    const [bloco] = buildPrintData(makeParams({
      obenProductItems: [obenItem()], obenSubtotal: 20,
      results: ['OS 999'], // nada de "PV Oben"
    }));
    expect(bloco.orderNumber).toBe('');
  });

  it('notes vazio → observacoes undefined; cnpj_cpf null → customerDocument vazio', () => {
    const [bloco] = buildPrintData(makeParams({
      customer: { razao_social: 'SEM DOC', cnpj_cpf: null } as unknown as OmieCustomer,
      obenProductItems: [obenItem()], obenSubtotal: 20,
      notes: '',
    }));
    expect(bloco.observacoes).toBeUndefined();
    expect(bloco.customerDocument).toBe('');
  });

  it('condPagamento de serviço faz passthrough quando não é a_vista', () => {
    const [bloco] = buildPrintData(makeParams({
      serviceItems: [svcItem()], serviceSubtotal: 75,
      afiacaoMethod: 'parcelado_3x',
    }));
    expect(bloco.condPagamento).toBe('parcelado_3x');
  });

  it('descricao de serviço cai pra getToolName quando servico.descricao ausente', () => {
    const semDesc = { type: 'service', quantity: 1, servico: { omie_codigo_servico: 7 }, userTool: {} } as unknown as ServiceCartItem;
    const [bloco] = buildPrintData(makeParams({
      serviceItems: [semDesc], serviceSubtotal: 10,
    }));
    expect(bloco.items[0].descricao).toBe('FerramentaMock');
    expect(bloco.items[0].codigo).toBe('7');
  });
});
