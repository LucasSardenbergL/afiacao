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
export async function resolveCustomerByPhone(rawPhone: string): Promise<ResolvedCustomer> {
  const phoneDialed = rawPhone.replace(/\D/g, '');
  const desconhecido: ResolvedCustomer = { customerUserId: null, phoneDialed, reconhecido: false, candidatos: 0 };

  // Sem 8 dígitos não há sufixo para comparar (a RPC devolveria zero linhas) — poupa a ida ao banco.
  if (phoneDialed.length < 8) {
    return desconhecido;
  }

  try {
    const { data, error } = await supabase.rpc('resolver_cliente_por_telefone' as never, {
      p_telefone: phoneDialed,
    } as never);
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
