// Linha de `profiles` do usuário Auth PLACEHOLDER que esta edge cria a partir de um cliente Omie
// (`omie_<codigo>@placeholder.local`, `is_placeholder: true`). Os dois escritores, `sync_all_clients`
// (import no servidor) e `criar_perfil_local` (fluxo de vendas OBEN), montam a linha AQUI.
//
// POR QUE a origem é obrigatória (C7 do plano v7, APROV-FANTASMA): a fila de aprovações
// (`AdminApprovals.tsx`) e o KPI da home (`useSistemaZone.ts`) excluem o fantasma por
// `prospect_source = 'omie_import'`. O import no servidor (#3496/#3501/#3511) inseria o profile SEM
// a origem, e 16.070 clientes importados apareciam como cadastro pendente: o pedido real de conta
// sumia entre 1.000 fantasmas na fila.
//
// Só o profile que NASCE aqui recebe a origem. O profile real reaproveitado por documento
// (`profileByDoc` no import, `matchedUserId` no `criar_perfil_local`) não passa por esta função
// e mantém a origem que tem: marcá-lo esconderia da fila um cadastro que pediu acesso.
//
// `is_approved` fica de fora de propósito: vale o default `false` da coluna. O que barra o login
// do placeholder é o e-mail inalcançável, não a aprovação; a origem só tira o perfil da fila.

export const ORIGEM_PERFIL_PLACEHOLDER = "omie_import" as const;

export interface DadosPerfilPlaceholder {
  userId: string;
  nomeFantasia?: string | null;
  razaoSocial?: string | null;
  email?: string | null;
  phone: string | null;
  document: string | null;
}

export interface LinhaPerfilPlaceholder {
  user_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  document: string | null;
  prospect_source: typeof ORIGEM_PERFIL_PLACEHOLDER;
}

export function linhaPerfilPlaceholder(d: DadosPerfilPlaceholder): LinhaPerfilPlaceholder {
  return {
    user_id: d.userId,
    name: d.nomeFantasia || d.razaoSocial || "Cliente",
    email: d.email || null,
    phone: d.phone,
    document: d.document,
    prospect_source: ORIGEM_PERFIL_PLACEHOLDER,
  };
}
