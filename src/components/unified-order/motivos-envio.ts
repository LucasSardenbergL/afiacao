import type { ProductCartItem, ServiceCartItem } from '@/hooks/unifiedOrder/types';
import { findInvalidPricedProductItems } from '@/services/orderSubmission/priceGuard';
import {
  condicoesBloqueantesDoCarrinho,
  ESTADO_FORMAS_UI_OK,
  type EstadoFormasUI,
} from '@/services/orderSubmission/formasDegradacao';
import type { EstadoVendedor } from '@/hooks/unifiedOrder/validacao-vendedor';
import type { EstadoCadastro } from '@/hooks/unifiedOrder/cadastro-cliente';

/**
 * C5 (rodada 2): POR QUE o "Enviar pedido" está cinza. A lista sai da MESMA função que desabilita
 * o botão (`envioBloqueado`), então o motivo mostrado e o `disabled` nunca divergem — um botão
 * cinza sem motivo, ou um motivo com o botão aceso, seria mentira de um dos dois.
 *
 * `submitting` não é motivo: o próprio botão mostra o spinner.
 */
type CodigoMotivoEnvio =
  | 'sem_cliente'
  | 'carregando_cliente'
  | 'carrinho_vazio'
  | 'servico_sem_tipo'
  | 'vendedor_divergente'
  | 'validando_vendedor'
  | 'vendedor_indisponivel'
  | 'identificando_cliente'
  | 'sem_cadastro_cliente'
  | 'cadastro_indisponivel'
  | 'preco_invalido'
  | 'condicoes_indisponiveis'
  | 'carregando_condicoes'
  | 'sem_condicao';

export interface MotivoEnvio {
  codigo: CodigoMotivoEnvio;
  texto: string;
}

export interface EntradaMotivosEnvio {
  temCliente: boolean;
  carregandoCliente: boolean;
  obenProductItems: ProductCartItem[];
  colacorProductItems: ProductCartItem[];
  serviceItems: ServiceCartItem[];
  vendedorDivergencias: string[];
  /** 8.1: falha da validação bloqueia (ausente ≠ consistente). Obrigatório de propósito. */
  estadoVendedor: EstadoVendedor;
  /** 8.2: staff só envia com o cadastro do cliente confirmado (o autoatendimento passa `confirmado`).
   *  Obrigatório de propósito. */
  estadoCadastro: EstadoCadastro;
  estadoFormasOben?: EstadoFormasUI;
  estadoFormasColacor?: EstadoFormasUI;
  loadingFormas: boolean;
  /** Staff escolhe a condição de pagamento; o autoatendimento não (a RPC exige staff). */
  exigeCondicao: boolean;
  selectedParcelaOben: string;
  selectedParcelaColacor: string;
}

export function motivosEnvioBloqueado(e: EntradaMotivosEnvio): MotivoEnvio[] {
  const motivos: MotivoEnvio[] = [];
  const temOben = e.obenProductItems.length > 0;
  const temColacor = e.colacorProductItems.length > 0;
  const itens = e.obenProductItems.length + e.colacorProductItems.length + e.serviceItems.length;

  if (!e.temCliente) motivos.push({ codigo: 'sem_cliente', texto: 'Escolha o cliente' });
  else if (e.carregandoCliente) motivos.push({ codigo: 'carregando_cliente', texto: 'Carregando dados do cliente…' });

  if (itens === 0) motivos.push({ codigo: 'carrinho_vazio', texto: 'Carrinho vazio' });

  if (e.serviceItems.some(s => !s.servico)) {
    motivos.push({ codigo: 'servico_sem_tipo', texto: 'Escolha o serviço de cada ferramenta' });
  }
  if (e.vendedorDivergencias.length > 0 || e.estadoVendedor === 'divergente') {
    motivos.push({ codigo: 'vendedor_divergente', texto: 'Vendedor divergente' });
  } else if (e.estadoVendedor === 'validando') {
    motivos.push({ codigo: 'validando_vendedor', texto: 'Validando vendedor…' });
  } else if (e.estadoVendedor === 'indisponivel') {
    motivos.push({ codigo: 'vendedor_indisponivel', texto: 'Não foi possível validar o vendedor — use “Trocar”' });
  }
  if (e.temCliente && !e.carregandoCliente) {
    if (e.estadoCadastro === 'resolvendo') {
      motivos.push({ codigo: 'identificando_cliente', texto: 'Identificando o cliente no app…' });
    } else if (e.estadoCadastro === 'sem_cadastro') {
      motivos.push({ codigo: 'sem_cadastro_cliente', texto: 'Cliente sem cadastro no app — use “Criar cadastro no app”' });
    } else if (e.estadoCadastro === 'indisponivel') {
      motivos.push({ codigo: 'cadastro_indisponivel', texto: 'Não foi possível identificar o cliente no app — use “Revalidar cadastro”' });
    }
  }
  if (findInvalidPricedProductItems([...e.obenProductItems, ...e.colacorProductItems]).length > 0) {
    motivos.push({ codigo: 'preco_invalido', texto: 'Item com preço zerado' });
  }
  if (condicoesBloqueantesDoCarrinho([
    { temItens: temOben, estado: e.estadoFormasOben ?? ESTADO_FORMAS_UI_OK },
    { temItens: temColacor, estado: e.estadoFormasColacor ?? ESTADO_FORMAS_UI_OK },
  ]).length > 0) {
    motivos.push({ codigo: 'condicoes_indisponiveis', texto: 'Condição de pagamento indisponível' });
  }

  if (e.exigeCondicao && (temOben || temColacor)) {
    if (e.loadingFormas) {
      motivos.push({ codigo: 'carregando_condicoes', texto: 'Carregando condições…' });
    } else {
      const semCondicao = [
        temOben && !e.selectedParcelaOben ? 'Oben' : null,
        temColacor && !e.selectedParcelaColacor ? 'Colacor' : null,
      ].filter((c): c is string => c !== null);
      if (semCondicao.length > 0) {
        motivos.push({ codigo: 'sem_condicao', texto: `Escolha a condição de pagamento (${semCondicao.join(' e ')})` });
      }
    }
  }
  return motivos;
}

/** O `disabled` do Enviar. Única fonte: os motivos acima + o envio em voo. */
export function envioBloqueado(submitting: boolean, motivos: readonly MotivoEnvio[]): boolean {
  return submitting || motivos.length > 0;
}
