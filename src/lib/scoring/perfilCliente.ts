// Perfil comercial do cliente — rótulo categórico que entra no prompt da IA
// (`generate-bundle-argument`, `generate-tactical-plan`) e molda a abordagem que a
// vendedora leva para a rua. Perfil fabricado = conversa fabricada.
//
// ESPELHO de `supabase/functions/_shared/tactical-margem.ts:classifyProfile` (Deno não
// importa de `src/`) — mudou a regra aqui, mude lá.
//
// Este módulo UNIFICA as duas cópias que viviam no front:
//   · useTacticalPlan.ts:187  (classifyProfile, privado do hook)
//   · useBundleArguments.ts:18 (classifyCustomerProfile, exportado)
// Eram a mesma regra escrita duas vezes; blindar só uma deixaria a outra fabricando.

import { margemConhecida } from '@/lib/margem';

export type PerfilCliente =
  | 'sensivel_preco'
  | 'orientado_qualidade'
  | 'orientado_produtividade'
  | 'misto';

/** Perfil comercial a partir dos sinais do score. Regras em ORDEM: a primeira que casa vence.
 *
 *  ⚠️ Os dois primeiros ramos dependem da margem e só disparam com margem CONHECIDA. Sem o
 *  guard, `null < 20` é `true` (null coage a 0) e todo cliente de gasto baixo com margem não
 *  apurada — ~84% da base pós-#1495 — sairia rotulado "sensível a preço", empurrando a
 *  vendedora para uma abordagem de desconto por causa de um dado que ninguém mediu.
 *
 *  `marginPct` em PERCENTUAL 0-100. `0` é margem nula CONHECIDA e decide normalmente. */
export function classificarPerfilCliente(
  healthScore: number,
  avgSpend: number,
  marginPct: number | null,
  categoryCount: number,
): PerfilCliente {
  const margem = margemConhecida(marginPct);
  if (margem != null && avgSpend < 500 && margem < 20) return 'sensivel_preco';
  if (margem != null && margem > 35 && categoryCount <= 3) return 'orientado_qualidade';
  if (avgSpend > 2000 && categoryCount >= 4 && healthScore > 60) return 'orientado_produtividade';
  return 'misto';
}
