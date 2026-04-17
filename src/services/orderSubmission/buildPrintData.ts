import type { PrintOrderData } from '@/components/OrderPrintLayout';
import { DELIVERY_FEES } from '@/types';
import type {
  CompanyProfile,
  FormaPagamento,
  OmieCustomer,
  ProductCartItem,
  ServiceCartItem,
} from '@/hooks/unifiedOrder/types';
import type { DeliveryOption } from '@/types';
import { findParcelaDesc, getToolName } from './helpers';

interface BuildPrintDataParams {
  customer: OmieCustomer;
  customerAddress: string | undefined;
  customerPhone: string;
  obenProductItems: ProductCartItem[];
  colacorProductItems: ProductCartItem[];
  serviceItems: ServiceCartItem[];
  obenSubtotal: number;
  colacorSubtotal: number;
  serviceSubtotal: number;
  parcelaOben: string;
  parcelaColacor: string;
  formasPagamentoOben: FormaPagamento[];
  formasPagamentoColacor: FormaPagamento[];
  afiacaoMethod: string;
  deliveryOption: DeliveryOption;
  notes: string;
  results: string[];
  companyProfiles: Record<string, CompanyProfile>;
  getServicePrice: (item: ServiceCartItem) => number | null;
}

export function buildPrintData(params: BuildPrintDataParams): PrintOrderData[] {
  const {
    customer, customerAddress, customerPhone,
    obenProductItems, colacorProductItems, serviceItems,
    obenSubtotal, colacorSubtotal, serviceSubtotal,
    parcelaOben, parcelaColacor,
    formasPagamentoOben, formasPagamentoColacor,
    afiacaoMethod, deliveryOption, notes, results, companyProfiles,
    getServicePrice,
  } = params;

  const dateShort = new Date().toLocaleDateString('pt-BR');
  const printDataList: PrintOrderData[] = [];

  if (obenProductItems.length > 0) {
    const obenOrderNum = results.find(r => r.startsWith('PV Oben'))?.replace('PV Oben ', '') || '';
    const obenProfile = companyProfiles.oben;
    printDataList.push({
      companyName: obenProfile?.legal_name || 'OBEN COMÉRCIO LTDA',
      companyCnpj: obenProfile?.cnpj || '51.027.034/0001-00',
      companyPhone: obenProfile?.phone || '(37) 9987-8190',
      companyAddress: obenProfile?.address || 'Av. Primeiro de Junho, 70 – Centro, Divinópolis/MG – CEP: 35.500-002',
      orderNumber: obenOrderNum,
      date: dateShort,
      customerName: customer.razao_social,
      customerDocument: customer.cnpj_cpf || '',
      customerAddress,
      customerPhone,
      condPagamento: findParcelaDesc(parcelaOben, formasPagamentoOben),
      parcelaCode: parcelaOben,
      items: obenProductItems.map(c => ({
        codigo: c.product.codigo,
        descricao: c.product.descricao,
        quantidade: c.quantity,
        unidade: c.product.unidade,
        valorUnitario: c.unit_price,
        valorTotal: c.quantity * c.unit_price,
        tintCorId: c.tint_cor_id,
        tintNomeCor: c.tint_nome_cor,
      })),
      subtotal: obenSubtotal,
      desconto: 0,
      frete: 0,
      total: obenSubtotal,
      observacoes: notes || undefined,
      isOben: true,
    });
  }

  if (colacorProductItems.length > 0) {
    const colacorOrderNum = results.find(r => r.startsWith('PV Colacor'))?.replace('PV Colacor ', '') || '';
    const colacorProfile = companyProfiles.colacor;
    printDataList.push({
      companyName: colacorProfile?.legal_name || 'COLACOR COMERCIAL LTDA',
      companyCnpj: colacorProfile?.cnpj || '15.422.799/0001-81',
      companyPhone: colacorProfile?.phone || '(37) 3222-1035',
      companyAddress: colacorProfile?.address || 'Av. Primeiro de Junho, 48 – Centro, Divinópolis/MG – CEP: 35.500-002',
      orderNumber: colacorOrderNum,
      date: dateShort,
      customerName: customer.razao_social,
      customerDocument: customer.cnpj_cpf || '',
      customerAddress,
      customerPhone,
      condPagamento: findParcelaDesc(parcelaColacor, formasPagamentoColacor),
      parcelaCode: parcelaColacor,
      items: colacorProductItems.map(c => ({
        codigo: c.product.codigo,
        descricao: c.product.descricao,
        quantidade: c.quantity,
        unidade: c.product.unidade,
        valorUnitario: c.unit_price,
        valorTotal: c.quantity * c.unit_price,
      })),
      subtotal: colacorSubtotal,
      desconto: 0,
      frete: 0,
      total: colacorSubtotal,
      isOben: false,
    });
  }

  if (serviceItems.length > 0) {
    const afiacaoOrderNum = results.find(r => r.startsWith('OS'))?.replace('OS ', '') || '';
    const afiacaoProfile = companyProfiles.afiacao;
    printDataList.push({
      companyName: afiacaoProfile?.legal_name || 'COLACOR S.C LTDA',
      companyCnpj: afiacaoProfile?.cnpj || '55.555.305/0001-51',
      companyPhone: afiacaoProfile?.phone || '(37) 9987-8190',
      companyAddress: afiacaoProfile?.address || 'Av. Primeiro de Junho, 50 – Centro, Divinópolis/MG – CEP: 35.500-002',
      orderNumber: afiacaoOrderNum,
      date: dateShort,
      customerName: customer.razao_social,
      customerDocument: customer.cnpj_cpf || '',
      customerAddress,
      customerPhone,
      condPagamento: afiacaoMethod === 'a_vista' ? 'À Vista' : afiacaoMethod,
      items: serviceItems.map(c => {
        const price = getServicePrice(c) || 0;
        return {
          codigo: c.servico?.omie_codigo_servico?.toString() || '-',
          descricao: c.servico?.descricao || getToolName(c.userTool),
          quantidade: c.quantity,
          unidade: 'SV',
          valorUnitario: price,
          valorTotal: price * c.quantity,
        };
      }),
      subtotal: serviceSubtotal,
      desconto: 0,
      frete: DELIVERY_FEES[deliveryOption],
      total: serviceSubtotal + DELIVERY_FEES[deliveryOption],
      isOben: false,
    });
  }

  return printDataList;
}
