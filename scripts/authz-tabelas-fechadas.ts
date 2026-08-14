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
 * ⚠️ `permitido` é TABLE-LEVEL — é o que as duas guardas medem (`has_table_privilege` no audit de
 * prod, statement `GRANT` no gate estático). GRANT de COLUNA é invisível para ambas. Não se
 * declara aqui "o que a role consegue ler", e sim "que privilégio de TABELA ela pode ter". Em
 * sales_orders os dois divergem por desenho: `has_table_privilege(authenticated,…,'SELECT')` é
 * FALSE e mesmo assim o front lê 25 colunas. Declarar a partir da leitura efetiva inverteria a
 * entrada — permitiria o SELECT table-level (que é justamente o vetor proibido) e proibiria o
 * INSERT/DELETE que as policies exigem.
 *
 * Estado medido em prod via psql-ro (2026-08-13, 20:51 e 22:36 UTC; pg 17.6) — as três DIFEREM:
 *   omie_products → anon AUSENTE do relacl, authenticated=r, 1 policy staff  ⇒ FECHADA (âncora ok)
 *   product_costs → anon=arwdDxtm, authenticated=arwdDxtm                    ⇒ ainda ABERTA
 *   sales_orders  → anon=ad, authenticated=ad + SELECT/UPDATE por COLUNA     ⇒ FECHADA por coluna
 *                   (o `ad` de anon é sobra do default — ver o motivo da entrada)
 *
 * A medição original desta allowlist (2026-07-22) viu as DUAS abertas e nasceu com fechadaPor=null
 * nas duas. No dia seguinte o fecho de omie_products mergeou (PR #1558) e foi aplicado — e a âncora
 * nunca foi declarada, porque este arquivo ficou 3 semanas numa branch órfã. É literalmente o
 * ANCORA_NAO_DECLARADA que o §5.2 do design existe para impedir: tabela fechada em prod, gate
 * inerte, silêncio indistinguível de tudo-em-ordem. A entrada abaixo já entra corrigida.
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
    fechadaPor: '20260725130000_authz_custo_fu4f_fase3_fecha_product_costs.sql',
    permitido: { anon: [], authenticated: ['SELECT'] },
    motivo:
      'custo unitário — fechada pelo PR #1520 (FU4-F fase 3). A âncora entra JUNTO com a migration de ' +
      'fecho: enquanto ela não for aplicada, prod segue ABERTA (anon=arwdDxtm, medido por psql-ro em ' +
      '2026-08-13) e quem protege é só a RLS (2 policies staff) — a divergência que o audit de grants ' +
      'acusar contra prod até o apply é REAL, não ruído do gate. Leitura por private.cap_custo_ler; ' +
      'escrita exclusiva de service_role (sync-reprocess, omie-analytics-sync). ORDEM DE APPLY: o ' +
      'PR #1543 (get_carteira_margem_faixa) vai a produção ANTES — as precondições fail-closed no topo ' +
      'de 20260725130000 abortam sem ele, porque useFarmerScoring ainda leria product_costs direto.',
  },
  'public.omie_products': {
    fechadaPor: '20260727140000_authz_preco_fecha_omie_products.sql',
    permitido: { anon: [], authenticated: ['SELECT'] },
    motivo:
      'preço de tabela (valor_unitario) — fechada pelo PR #1558, APLICADA em prod (conferido por ' +
      'psql-ro 2026-08-13: anon fora do relacl, authenticated=r). Leitura por staff (policy ' +
      'omie_products_select_staff, master OR employee); escrita exclusiva de service_role (edges de sync do Omie). ' +
      'SEM policy de escrita, por desenho — nem employee nem master escrevem via API.',
  },
  'public.sales_orders': {
    fechadaPor: '20260724120000_authz_sales_orders_split_escrita_fu4.sql',
    permitido: { anon: [], authenticated: ['INSERT', 'DELETE'] },
    motivo:
      'pedido de venda (money-path) — fechada por privilégio de COLUNA, modelo distinto das outras duas ' +
      'entradas, em DUAS etapas: (1) 20260709163500 (PR0.0-bis) trocou o SELECT table-level pelo SELECT ' +
      'de 25 colunas, deixando omie_payload/omie_response de fora; (2) 20260724120000 (FU4, a âncora — é ' +
      'ela que estabelece o contrato declarado aqui) trocou o UPDATE table-level pelo UPDATE de 11 colunas ' +
      'e revogou TRUNCATE,REFERENCES,TRIGGER,MAINTAIN. A FU4 usa REVOKE UPDATE e JAMAIS REVOKE ALL, de ' +
      'propósito: REVOKE table-level derruba junto os grants de coluna do PR0.0-bis. ' +
      'INSERT e DELETE table-level são LEGÍTIMOS e exercidos pelo front como authenticated, sob policy ' +
      '(cap_pedido_escrever): insert em orderSubmission/{submitQuote,idempotency} e whatsappProposta/' +
      'enviarProposta; delete de orçamento em SalesQuotes.tsx (a policy exige omie_pedido_id IS NULL). ' +
      'SELECT e UPDATE table-level ficam FORA do permitido por serem o vetor de reabertura, não por ' +
      'ausência de uso: reemitir GRANT SELECT ON public.sales_orders TO authenticated reabre payload/' +
      'response, e GRANT UPDATE table-level contorna a allowlist de coluna (RLS filtra LINHA, não coluna). ' +
      'Medido por psql-ro 2026-08-13 22:36 UTC: relacl anon=ad, authenticated=ad; has_table_privilege ' +
      'confirma SELECT/UPDATE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN=NAO nas duas roles; authenticated com ' +
      'SELECT em 25 colunas e UPDATE em 11 (attacl). ' +
      '⚠️ anon=ad DIVERGE deste contrato e authz:grants:prod acusa DRIFT_PROD por isso — é achado real, ' +
      'não ruído: os REVOKE de anon cobriram SELECT (jul/09) e UPDATE+higiene (jul/24) e nunca alcançaram ' +
      'INSERT/DELETE, que seguem do default arwdDxtm do Supabase. Inócuo HOJE (as 5 policies são TO ' +
      'authenticated ⇒ anon casa 0 linhas), mas é o mesmo hazard F1 que motivou o REVOKE SELECT FROM anon: ' +
      'uma policy anon futura o converte em escrita real. Fecha com REVOKE INSERT, DELETE ON ' +
      'public.sales_orders FROM anon; até lá o alarme fica de pé, por desenho.',
  },
};
