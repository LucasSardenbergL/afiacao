import { supabase } from '@/integrations/supabase/client';
import { mensagemDoErroEdge } from '@/lib/invoke-function';
import type { OmieCustomer } from './types';

type Invocar = (body: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;

const invocarVendas: Invocar = (body) => supabase.functions.invoke('omie-vendas-sync', { body });

/**
 * Onda D 4b-3: a busca do Novo Pedido devolve o cliente FORA da carteira sem documento, telefone, endereço
 * e contato (`contato_visivel === false`). Ao selecioná-lo, o cadastro inteiro vem da `revelar_cliente`,
 * que grava o ledger `novo_pedido` no servidor. Na carteira (ou edge antiga, sem o campo) devolve o mesmo
 * objeto. Falha LANÇA — a seleção para, nunca segue com o cadastro mascarado (validar vendedor e
 * autocadastro dependem do documento).
 */
export async function revelarClienteSelecionado(
  cust: OmieCustomer,
  invocar: Invocar = invocarVendas,
): Promise<OmieCustomer> {
  if (cust.contato_visivel !== false) return cust;
  const { data, error } = await invocar({ action: 'revelar_cliente', codigo_cliente: cust.codigo_cliente });
  if (error) {
    throw new Error((await mensagemDoErroEdge(error)) ?? 'Não consegui abrir o cadastro deste cliente.');
  }
  const cliente = (data as { cliente?: Partial<OmieCustomer> } | null)?.cliente;
  if (!cliente || cliente.codigo_cliente !== cust.codigo_cliente || cliente.contato_visivel !== true) {
    throw new Error('Não consegui abrir o cadastro deste cliente.');
  }
  return { ...cust, ...cliente, local_user_id: cust.local_user_id ?? null };
}
