/**
 * authz-tabelas-fechadas.ts — allowlist CURADA de tabelas fechadas por PRIVILÉGIO.
 * ============================================================================================
 *
 * Fonte de verdade única do gate estático (scripts/lib/authz-grants.ts → Parte C do authz:check)
 * e do audit de prod (db/audit-grants-tabelas-fechadas.ts). Vigia SÓ as tabelas listadas aqui.
 *
 * NÃO é varredura em massa: o grant DML amplo do Supabase (arwdDxtm a anon/authenticated em toda
 * relação nova) é o MODELO da plataforma — inócuo sob RLS + security_invoker (database.md §7).
 * Só entra aqui a tabela que foi DELIBERADAMENTE fechada por REVOKE + GRANT SELECT + policy.
 *
 * Como adicionar uma tabela: (1) confirme que ela foi fechada por privilégio; (2) declare o
 * `permitido` por role — o que NÃO estiver na lista é proibido (allowlist, fail-closed); (3)
 * quando a migration de fecho estiver no repo, aponte `fechadaPor` para o arquivo dela. Enquanto
 * o fecho não mergeou, deixe `fechadaPor: null` (o gate avisa; ver GrantCodigo FECHO_PENDENTE).
 *
 * Estado medido em prod via psql-ro (2026-07-22): as DUAS abaixo ainda estão ABERTAS
 * (anon=arwdDxtm, authenticated=arwdDxtm) — os fechos são PRs draft nunca aplicados. Por isso
 * ambas nascem com fechadaPor=null: a sentinela sabe que o fecho está pendente.
 */

export type Priv =
  | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'
  | 'TRUNCATE' | 'REFERENCES' | 'TRIGGER' | 'MAINTAIN'; // MAINTAIN: Postgres 17+

export interface TabelaFechada {
  /** Migration que FECHOU a tabela (âncora, nome do arquivo em supabase/migrations/).
   *  null = fecho declarado PENDENTE (ainda não mergeado). */
  fechadaPor: string | null;
  /** Privilégios PERMITIDOS por role. Ausente da lista = proibido (allowlist de privilégio). */
  permitido: { anon: Priv[]; authenticated: Priv[] };
  motivo: string;
}

export const AUTHZ_TABELAS_FECHADAS: Record<string, TabelaFechada> = {
  'public.product_costs': {
    fechadaPor: null,
    permitido: { anon: [], authenticated: ['SELECT'] },
    motivo:
      'custo unitário — fechada pelo PR #1520 (FU4-F fase 3), draft. Leitura por private.cap_custo_ler; ' +
      'escrita exclusiva de service_role (sync-reprocess, omie-analytics-sync).',
  },
  'public.omie_products': {
    fechadaPor: null,
    permitido: { anon: [], authenticated: ['SELECT'] },
    motivo:
      'preço de tabela (valor_unitario) — fechada pela branch authz-preco-fecha-omie-products, draft. ' +
      'Leitura por staff (master OR employee); escrita exclusiva de service_role (6 edges de sync do Omie).',
  },
};
