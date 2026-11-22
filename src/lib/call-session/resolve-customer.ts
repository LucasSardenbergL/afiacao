import { supabase } from '@/integrations/supabase/client';
import { mensagemDeErro } from '@/lib/erro-mensagem';

export interface ResolvedCustomer {
  /**
   * UUID do profile do cliente; null quando o número não tem dono OU quando tem VÁRIOS donos e
   * nenhum é o único da carteira de quem liga (`reconhecido` distingue os dois casos).
   */
  customerUserId: string | null;
  /** Telefone normalizado (dígitos apenas) — sempre preenchido pra fallback */
  phoneDialed: string;
  /**
   * O número pertence a cliente(s) cadastrado(s) — mesmo sem dono único. É o que decide gravar a
   * ligação: um telefone compartilhado por dois clientes continua sendo telefone de cliente.
   */
  reconhecido: boolean;
  /** Quantos clientes têm este número (0 = desconhecido; >1 com `customerUserId` null = ambíguo). */
  candidatos: number;
  /** Nome do contato (se identificado via customer_contacts) — PR-CONTACTS */
  contactName?: string;
  /** Cargo do contato (dono/gerente/comprador/etc) — PR-CONTACTS */
  contactCargo?: string;
}

interface LinhaResolvida {
  customer_user_id: string | null;
  contato_nome: string | null;
  contato_cargo: string | null;
  fonte: string | null;
  candidatos: number | null;
}

/**
 * Quem é o dono do telefone — pela RPC `resolver_cliente_por_telefone`, que compara só DÍGITOS
 * (sufixo de 8): `customer_contacts` primeiro (traz nome+cargo), depois `profiles.phone` de quem não
 * é staff. Vários donos → o único da carteira de quem liga; senão `customerUserId: null` com
 * `reconhecido: true` (a vendedora associa depois em /farmer/calls/pending-link).
 *
 * ⚠️ Antes isto era `phone ILIKE '%<8 dígitos>%'` sobre o texto CRU: o cadastro guarda `99999-9999`,
 * o hífen quebra a sequência e só 4% das carteiras eram reconhecidas (medido 2026-10-10). Número não
 * reconhecido não grava e não vira `farmer_calls` — a ligação existia e o contato não. E o
 * `.maybeSingle()` do fallback transformava telefone compartilhado em erro engolido.
 *
 * Falha da RPC degrada para "desconhecido" (o comportamento antigo), nunca derruba a ligação — mas
 * agora deixa rastro no console em vez de sumir.
 */
export async function resolveCustomerByPhone(
  rawPhone: string,
  opts?: { clienteOrigemId?: string | null },
): Promise<ResolvedCustomer> {
  const resolvido = await resolverPeloNumero(rawPhone);
  const candidato = opts?.clienteOrigemId ?? null;
  if (!candidato || !resolvido.reconhecido) return resolvido;
  // Só o caso ambíguo precisa de evidência: dono único igual ao candidato já está decidido, e dono
  // único DIFERENTE é divergência (vai para conferência) sem precisar ler nada.
  const precisaEvidencia = resolvido.customerUserId == null;
  const evidencia = precisaEvidencia ? await lerEvidenciaDoCandidato(candidato, resolvido.phoneDialed) : null;
  return decidirDonoComOrigem(resolvido, candidato, evidencia);
}

/** O que se sabe do cliente de origem: o número é dele, e ele está na carteira de quem liga? */
export interface EvidenciaCandidato {
  telefoneDoCandidato: boolean;
  naCarteiraDeQuemLiga: boolean;
}

const sufixo8 = (tel: string | null | undefined) => (tel ?? '').replace(/\D/g, '').slice(-8);

/**
 * Quem fica como dono quando a ligação saiu da ficha de um cliente (o "candidato").
 * - sem candidato ou número desconhecido → o que o número disse;
 * - o número tem dono único e é o candidato → ele;
 * - o número tem dono único e NÃO é o candidato → divergência: sem dono, vai para a conferência
 *   (`/farmer/calls/pending-link`) — a ficha e o cadastro discordam, e não se escolhe no escuro;
 * - número compartilhado (sem dono único) → o candidato SÓ se o número é dele E ele está na carteira
 *   de quem liga; faltou evidência (leitura falhou = `null`) → continua sem dono.
 */
export function decidirDonoComOrigem(
  resolvido: ResolvedCustomer,
  candidato: string | null,
  evidencia: EvidenciaCandidato | null,
): ResolvedCustomer {
  if (!candidato || !resolvido.reconhecido) return resolvido;
  if (resolvido.customerUserId === candidato) return resolvido;
  if (resolvido.customerUserId != null) {
    return { ...resolvido, customerUserId: null, contactName: undefined, contactCargo: undefined };
  }
  if (evidencia?.telefoneDoCandidato && evidencia.naCarteiraDeQuemLiga) {
    return { ...resolvido, customerUserId: candidato };
  }
  return resolvido;
}

/**
 * Evidência do vínculo cliente × telefone × carteira, lida com a RLS de quem liga (o usuário REAL —
 * a lente "Ver como" nem chega aqui: o makeCall recusa na fonte). Qualquer falha → `null` (sem
 * evidência = sem vínculo; a ligação segue para a conferência, nunca para o cliente errado).
 */
async function lerEvidenciaDoCandidato(candidato: string, phoneDialed: string): Promise<EvidenciaCandidato | null> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    const [contatos, perfil, carteira] = await Promise.all([
      supabase.from('customer_contacts').select('phone').eq('customer_user_id', candidato),
      supabase.from('profiles').select('phone').eq('user_id', candidato).maybeSingle(),
      supabase.from('carteira_assignments').select('customer_user_id')
        .eq('customer_user_id', candidato).eq('owner_user_id', user.id).eq('eligible', true).limit(1),
    ]);
    if (contatos.error || perfil.error || carteira.error) {
      console.error('[resolveCustomerByPhone] evidência do cliente de origem falhou:',
        mensagemDeErro(contatos.error ?? perfil.error ?? carteira.error));
      return null;
    }
    const alvo = sufixo8(phoneDialed);
    const telefones = [...(contatos.data ?? []).map((c) => c.phone), perfil.data?.phone];
    return {
      telefoneDoCandidato: alvo.length === 8 && telefones.some((t) => sufixo8(t) === alvo),
      naCarteiraDeQuemLiga: (carteira.data ?? []).length > 0,
    };
  } catch (e) {
    console.error('[resolveCustomerByPhone] evidência do cliente de origem falhou:', mensagemDeErro(e));
    return null;
  }
}

async function resolverPeloNumero(rawPhone: string): Promise<ResolvedCustomer> {
  const phoneDialed = rawPhone.replace(/\D/g, '');
  const desconhecido: ResolvedCustomer = { customerUserId: null, phoneDialed, reconhecido: false, candidatos: 0 };

  // Sem 8 dígitos não há sufixo para comparar (a RPC devolveria zero linhas) — poupa a ida ao banco.
  if (phoneDialed.length < 8) {
    return desconhecido;
  }

  try {
    const { data, error } = await supabase.rpc('resolver_cliente_por_telefone', {
      p_telefone: phoneDialed,
    });
    if (error) {
      console.error('[resolveCustomerByPhone] resolver_cliente_por_telefone falhou:', mensagemDeErro(error));
      return desconhecido;
    }
    const linha = ((data ?? []) as LinhaResolvida[])[0];
    if (!linha) {
      return desconhecido;
    }
    return {
      customerUserId: linha.customer_user_id ?? null,
      phoneDialed,
      reconhecido: true,
      candidatos: linha.candidatos ?? 1,
      contactName: linha.contato_nome ?? undefined,
      contactCargo: linha.contato_cargo ?? undefined,
    };
  } catch (e) {
    console.error('[resolveCustomerByPhone] erro ao resolver telefone:', mensagemDeErro(e));
    return desconhecido;
  }
}
