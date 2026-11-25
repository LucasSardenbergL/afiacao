/**
 * Contato de CLIENTE (documento, CNPJ, telefone, e-mail, endereço, pessoas de contato) — onda D.
 *
 * Regra (spec 2026-11-24-clientes-pii-por-carteira-design.md): staff vê a IDENTIDADE de qualquer
 * cliente; o CONTATO só na própria carteira/cobertura (gestão e master veem tudo; customer vê o
 * próprio). Duas portas, e só elas:
 *
 *  - TELA de cliente → views mascaradas (`v_perfil_contato`, `v_endereco_contato`,
 *    `v_cliente_contatos`). Fora da carteira a linha vem com `contato_visivel=false` e os campos
 *    NULL: a tela diz "visível só para a carteira" — nunca "sem telefone".
 *  - OPERACIONAL (pedido, expedição, rota, aprovação) → `contato_cliente_operacional`, que recebe o
 *    OBJETO, deriva o cliente no servidor e grava a leitura fora da carteira no ledger.
 *
 * Sempre por `.in('user_id', ids)` em lotes: JOIN/LATERAL contra a view estoura o tempo.
 * Erro LANÇA (nunca vira "cliente sem contato").
 */
import { supabase } from '@/integrations/supabase/client';
import { coletarEmLotesConcorrente, CONCORRENCIA_LOTES } from '@/lib/lotes';

export interface PerfilContato {
  user_id: string;
  contato_visivel: boolean;
  email: string | null;
  phone: string | null;
  document: string | null;
  cnpj: string | null;
  eh_pj: boolean;
}

export interface EnderecoContato {
  id: string;
  user_id: string;
  contato_visivel: boolean;
  label: string | null;
  city: string | null;
  state: string | null;
  is_default: boolean | null;
  is_from_omie: boolean | null;
  created_at: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  neighborhood: string | null;
  zip_code: string | null;
}

export type ObjetoOperacional = 'pedido' | 'ordem_servico' | 'expedicao' | 'rota' | 'aprovacao' | 'novo_pedido';

export interface EnderecoOperacional {
  id: string;
  label: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  is_default: boolean | null;
}

export interface ContatoOperacional {
  objeto_id: string;
  customer_user_id: string;
  via_excecao: boolean;
  email: string | null;
  phone: string | null;
  document: string | null;
  cnpj: string | null;
  enderecos: EnderecoOperacional[];
  /** Snapshot gravado no pedido (só para objeto `pedido`). */
  pedido_documento: string | null;
  pedido_endereco: string | null;
  pedido_telefone: string | null;
}

export const COLUNAS_PERFIL_CONTATO = 'user_id, contato_visivel, email, phone, document, cnpj, eh_pj';
export const COLUNAS_ENDERECO_CONTATO =
  'id, user_id, contato_visivel, label, city, state, is_default, is_from_omie, created_at, street, number, complement, neighborhood, zip_code';

const LOTE_VIEW = 150;
/** Teto estrutural da RPC (o servidor recusa > 200 com 22023). */
export const LOTE_OPERACIONAL = 200;

function unicos(ids: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(ids.filter((i): i is string => !!i))];
}

/** Contato mascarado dos perfis, por id. Id sem linha = cliente fora do alcance (customer alheio). */
export async function lerPerfisContato(ids: ReadonlyArray<string | null | undefined>): Promise<Map<string, PerfilContato>> {
  const alvo = unicos(ids);
  if (alvo.length === 0) return new Map();
  const linhas = await coletarEmLotesConcorrente(alvo, LOTE_VIEW, CONCORRENCIA_LOTES, async (lote) => {
    const { data, error } = await supabase.from('v_perfil_contato').select(COLUNAS_PERFIL_CONTATO).in('user_id', lote);
    if (error) throw error;
    return (data ?? []) as PerfilContato[];
  });
  return new Map(linhas.map((l) => [l.user_id, l]));
}

/** Contato mascarado de UM perfil (null = sem linha). */
export async function lerPerfilContato(userId: string): Promise<PerfilContato | null> {
  const { data, error } = await supabase
    .from('v_perfil_contato').select(COLUNAS_PERFIL_CONTATO).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return (data ?? null) as PerfilContato | null;
}

/** Endereços mascarados (cidade/UF sempre; rua/número/bairro/CEP só onde visível), padrão primeiro. */
export async function lerEnderecosContato(ids: ReadonlyArray<string | null | undefined>): Promise<EnderecoContato[]> {
  const alvo = unicos(ids);
  if (alvo.length === 0) return [];
  const linhas = await coletarEmLotesConcorrente(alvo, LOTE_VIEW, CONCORRENCIA_LOTES, async (lote) => {
    const { data, error } = await supabase
      .from('v_endereco_contato').select(COLUNAS_ENDERECO_CONTATO).in('user_id', lote)
      .order('is_default', { ascending: false }).order('created_at').order('id');
    if (error) throw error;
    return (data ?? []) as EnderecoContato[];
  });
  return ordenarEnderecos(linhas);
}

/** Padrão primeiro, depois o mais antigo — a ordem da RPC operacional, para as duas portas baterem. */
export function ordenarEnderecos<T extends { is_default: boolean | null; created_at?: string | null; id: string }>(xs: T[]): T[] {
  return [...xs].sort((a, b) =>
    Number(!!b.is_default) - Number(!!a.is_default)
    || (a.created_at ?? '').localeCompare(b.created_at ?? '')
    || a.id.localeCompare(b.id));
}

/**
 * Contato pelo contexto OPERACIONAL: o servidor resolve o cliente a partir do objeto e grava no
 * ledger a leitura fora da carteira. `motivo` é um slug `[a-z_]{3,40}` que diz a TELA/ação
 * (`detalhe_pedido`, `impressao_pedido`, `roteirizar_entrega`, `aprovar_cadastro`…).
 * Só staff: customer recebe 42501 — o customer lê o próprio contato pelas views.
 */
export async function lerContatoOperacional(
  tipo: ObjetoOperacional,
  objetoIds: ReadonlyArray<string | null | undefined>,
  motivo: string,
): Promise<Map<string, ContatoOperacional>> {
  const alvo = unicos(objetoIds);
  if (alvo.length === 0) return new Map();
  const linhas = await coletarEmLotesConcorrente(alvo, LOTE_OPERACIONAL, CONCORRENCIA_LOTES, async (lote) => {
    const { data, error } = await supabase.rpc('contato_cliente_operacional', {
      p_objeto_tipo: tipo, p_objeto_ids: lote, p_motivo: motivo,
    });
    if (error) throw error;
    return (data ?? []) as unknown as ContatoOperacional[];
  });
  return new Map(linhas.map((l) => [l.objeto_id, { ...l, enderecos: Array.isArray(l.enderecos) ? l.enderecos : [] }]));
}

/** Endereço de exibição: o padrão, senão o primeiro. */
export function enderecoPrincipal<T extends { is_default: boolean | null }>(xs: ReadonlyArray<T>): T | null {
  return xs.find((a) => a.is_default) ?? xs[0] ?? null;
}

export interface ContatoNovoPedido {
  document: string | null;
  cnpj: string | null;
  phone: string | null;
  enderecos: EnderecoOperacional[];
}

/**
 * Contato para montar pedido/proposta que AINDA não existe. O próprio cliente (customer pedindo para
 * si) lê pelas views (self é sempre visível); staff pedindo para um cliente lê pelo contexto
 * `novo_pedido` — 1 cliente por chamada, teto diário de clientes fora da carteira no servidor (54000).
 */
export async function lerContatoNovoPedido(
  customerUserId: string,
  ehOProprioCliente: boolean,
  motivo: 'novo_pedido' | 'proposta_recompra',
): Promise<ContatoNovoPedido | null> {
  if (ehOProprioCliente) {
    const [perfil, enderecos] = await Promise.all([
      lerPerfilContato(customerUserId), lerEnderecosContato([customerUserId]),
    ]);
    if (!perfil) return null;
    return {
      document: perfil.document, cnpj: perfil.cnpj, phone: perfil.phone,
      enderecos: enderecos.map(({ id, label, street, number, complement, neighborhood, city, state, zip_code, is_default }) =>
        ({ id, label, street, number, complement, neighborhood, city, state, zip_code, is_default })),
    };
  }
  const c = (await lerContatoOperacional('novo_pedido', [customerUserId], motivo)).get(customerUserId);
  return c ? { document: c.document, cnpj: c.cnpj, phone: c.phone, enderecos: c.enderecos } : null;
}

/**
 * Junta o contato MASCARADO às linhas de identidade (profiles sem PII). Cliente sem linha na view
 * (customer alheio) ou fora da carteira sai com os campos `null` e `contato_visivel: false` — a tela
 * distingue "oculto" de "vazio" por essa flag.
 */
export async function comContatoMascarado<T extends { user_id: string }>(
  linhas: T[],
): Promise<Array<T & Pick<PerfilContato, 'email' | 'phone' | 'document' | 'cnpj' | 'contato_visivel'>>> {
  const contato = await lerPerfisContato(linhas.map((l) => l.user_id));
  return linhas.map((l) => {
    const c = contato.get(l.user_id);
    return {
      ...l,
      email: c?.email ?? null, phone: c?.phone ?? null, document: c?.document ?? null, cnpj: c?.cnpj ?? null,
      contato_visivel: c?.contato_visivel === true,
    };
  });
}
