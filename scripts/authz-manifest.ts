/**
 * authz-manifest.ts — contrato de autorização das RPCs SECURITY DEFINER sensíveis.
 * ============================================================================================
 *
 * Fonte de verdade CURADA do check anti-regressão de gate (scripts/authz-gate-check.ts).
 * Cada função SECDEF que toca custo/preço/estoque e é EXECUTÁVEL por `authenticated` DEVE estar
 * aqui, com o gate de bloqueio esperado. O check garante que nenhuma migration recrie a função
 * sem esse gate (Parte A) e que nenhuma SECDEF sensível nova fique sem classificação (Parte B).
 *
 * Ao adicionar/gatear uma função SECDEF sensível: classifique-a aqui (o CI falha até você fazê-lo).
 * Ao MUDAR o gate de uma função (decisão de política): atualize o requiredGate aqui — é o ponto
 * de revisão consciente. Chave = `schema.name` (sem assinatura: overloads compartilham o gate).
 *
 * Semeado 2026-07-09 a partir do inventário PROD (psql-ro) — todas gateadas na criação do check.
 */
import type { RequiredGate } from './lib/authz-contract';

export interface AuthzEntry {
  sensitive: true;
  requiredGate: RequiredGate;
  motivo: string;
}

export const AUTHZ_MANIFEST: Record<string, AuthzEntry> = {
  // E2/FU4 (2026-07-18): estas duas leem CUSTO, e o gate único `pode_ver_carteira_completa`
  // as concedia ao papel gerencial operacional junto com preço e crédito. Passaram a exigir
  // `private.cap_custo_ler` — master + estrategico + super_admin. Mudança de POLÍTICA revisada
  // conscientemente aqui, como manda o cabeçalho deste arquivo.
  'public.fin_estimar_estoque_omie': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'cap_custo_ler' }] },
    motivo: 'capital imobilizado em estoque a custo (Σ saldo×cmc) — PR #1264; E2/FU4 estreitou p/ estrategico+',
  },
  'public.medir_abaixo_piso_tier': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'cap_custo_ler' }] },
    motivo: 'folga negativa de margem vs piso de markup — cockpit financeiro; E2/FU4 estreitou p/ estrategico+',
  },
  'public.get_preco_cockpit': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'has_role', roles: ['employee', 'master'] }, { call: 'pode_ver_carteira_completa' }] },
    motivo: 'cockpit de preços — bloqueia staff; pode_ver_carteira_completa afina o detalhe',
  },
  'public.get_defasagem_cliente': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'has_role', roles: ['employee', 'master'] }, { call: 'pode_ver_carteira_completa' }] },
    motivo: 'defasagem de preço por cliente vs custo',
  },
  // FU4-F fase 2 (2026-07-20): as duas continuam com gate de ENTRADA `has_role(employee|master)`
  // DE PROPÓSITO — a vendedora precisa do SINAL ("abaixo do piso"). O que mudou é interno: elas
  // pararam de emitir `cmc`/`aliquota_venda` e passaram a mascarar `piso_mc`/`piso_gap_pct` atrás
  // de `v_pode_num := private.cap_custo_ler(...)`, no padrão do get_preco_cockpit.
  //
  // ⚠️ LIMITE DESTE CHECK, declarado para quem vier depois: `requiredGate` só sabe verificar gate
  // em FORMA DE BLOQUEIO (`IF NOT gate() THEN RAISE`). Mascaramento de CAMPO não é expressável
  // aqui — pôr cap_custo_ler no requiredGate exigiria um RAISE e bloquearia a vendedora inteira,
  // matando a régua. A anti-regressão do mascaramento é o assert estrutural A4 da migration
  // 20260723150000 + db/test-authz-custo-fu4f-fase2-regua.sh (A10-A14). Mesma situação do
  // get_preco_cockpit, cujo `v_pode_num` também não aparece aqui.
  'public.get_regua_preco': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'has_role', roles: ['employee', 'master'] }] },
    motivo: 'régua de preço a partir do cmc; desde FU4-F/2 devolve SINAL (abaixo_piso) e mascara piso_mc por cap_custo_ler',
  },
  'public.get_regua_preco_customer360': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'has_role', roles: ['employee', 'master'] }] },
    motivo: 'régua de preço no customer 360 — repassa o pacote já mascarado da get_regua_preco',
  },
  // Writer do closed-loop da régua. Gate de ESCRITA próprio (`private.cap_regua_log_escrever`,
  // employee|master) — NUNCA cap_custo_ler: o §4.2 do spec de 2026-07-18 proíbe reusar a função de
  // leitura em escrita, e reusá-la deixaria estrategico/super_admin registrar em nome de outro
  // vendedor (bloqueador P1 do Codex na fase 1). Toca inventory_position.cmc porque apura o custo
  // do log NO SERVIDOR — o cliente não o recebe mais e não teria como informá-lo.
  'public.registrar_exibicao_regua': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'cap_regua_log_escrever' }] },
    motivo: 'grava exibição da régua com piso_mc/cmc_usado apurados server-side; salesperson_id fixado em auth.uid()',
  },
  // Fecha o loop do log. Não toca custo (por isso a Parte B do check não a exigia), mas é SECDEF
  // que ESCREVE no log de custo — classificar torna o par writer/updater visível na auditoria em
  // vez de deixar metade dele fora do inventário. Gate de escrita + predicado de ownership
  // (`salesperson_id = auth.uid()` no UPDATE), para staff não fechar o outcome alheio.
  'public.registrar_aplicacao_regua': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'cap_regua_log_escrever' }] },
    motivo: 'fecha o outcome da régua; só o vendedor DONO do registro (UPDATE filtra por auth.uid())',
  },
  'public.get_ultimos_precos_cliente': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'has_role', roles: ['employee', 'master'] }] },
    motivo: 'últimos preços praticados por cliente',
  },
  'public.melhoria_clientes_por_produto': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'has_role', roles: ['employee', 'master'] }] },
    motivo: 'clientes por produto (preço/volume 12m)',
  },
};

/**
 * SECDEF que tocam dado sensível mas NÃO precisam de gate customer-facing — baseline 2026-07-09.
 * Cada entrada é uma decisão consciente: a função não é executável por `authenticated` (só
 * service_role/cron/staff-internal) OU o "toque" é falso-positivo do parser (menção em string
 * já mascarada / coluna homônima). Justificativa por linha. Semeado a partir do inventário PROD
 * (psql-ro: 20 SECDEF tocam sensível, 8 expostas a authenticated = o AUTHZ_MANIFEST acima).
 * v2: auditar cada uma individualmente e cruzar com os grants reais.
 */
export const ACKNOWLEDGED_SENSITIVE = new Set<string>([
  // Baseline 2026-07-09: as 7 SECDEF abaixo tocam custo/preço/estoque mas NÃO são executáveis por
  // authenticated nem anon (confirmado psql-ro: auth_exec=f, anon_exec=f) — service_role/cron/
  // trigger/interno, não customer-facing. Vazamento customer-facing exige EXECUTE p/ authenticated.
  'public._data_health_compute', // cômputo de saúde de dados (cron/service_role)
  'public.tint_promote_sync_run', // sync tintométrico → promoção (service_role)
  'public.tint_calc_preco_final', // cálculo de preço tint, chamado pelo sync (interno)
  'public.tint_recalc_preco_oficial', // recálculo de preço oficial tint (interno)
  'public.aplicar_snapshot_pendente', // aplica snapshot de reposição (cron/service_role)
  'public.cmc_ledger_capture', // captura no ledger de cmc (trigger/service_role)
  'public.reposicao_cold_start_parametros', // parâmetros cold-start da reposição (interno)
  // 2026-07-21 (#1495): margem bruta por cliente p/ o health score do farmer. Lê product_costs, mas
  // a própria migration a fecha por PRIVILÉGIO — REVOKE ALL de PUBLIC/anon/authenticated + GRANT
  // EXECUTE só a service_role (a edge calculate-scores, via cron). Só a margem AGREGADA por cliente
  // atravessa; o custo unitário não sai do banco. Mesmo perfil da irmã get_customer_sales_summary
  // (confirmado psql-ro: auth_exec=f, anon_exec=f, svc_exec=t). Reconfirmar após o apply em prod.
  'public.get_customer_margin_summary',

  // 2026-07-21 — helper COMPARTILHADO de margem por cliente (PR #1519). Fecha por PRIVILÉGIO,
  // não por gate no corpo, e é por isso que entra aqui e não no AUTHZ_MANIFEST:
  //   · o REVOKE é o que fecha: de PUBLIC + anon + authenticated (função nova nasce com
  //     proacl NULL = EXECUTE implícito a PUBLIC, e o default privilege do Supabase concede às
  //     roles nomeadas — revogar dos dois jeitos), GRANT só a service_role;
  //   · `private` fecha a rota HTTP (o PostgREST só publica os schemas configurados), mas
  //     ⚠️ NÃO é barreira de EXECUTE: medido em prod, `private` concede USAGE a authenticated E
  //     anon (`nspacl = {…,authenticated=U/postgres,anon=U/postgres,…}`). Quem depender do schema
  //     como se fosse trava está enganado — é o REVOKE, e só ele;
  //   · os consumidores é que carregam o gate: `get_carteira_margem_faixa` (FU4-F fase 3) aplica
  //     cap_custo_ler na PROJEÇÃO do número e cap_carteira_ler/carteira_visivel_para no ESCOPO;
  //     `get_customer_margin_summary` (#1495, acima) passa a DERIVAR deste helper em vez de ter
  //     cálculo próprio — as duas discordavam em 28,5% dos clientes na faixa.
  // Provado em db/test-margem-cliente-helper-compartilhado.sh (L1-L5): anon/authenticated/PUBLIC
  // com has_function_privilege=f, service_role=t, e a função residindo em `private`.
  'private.margem_cliente_agregada',
]);

/** chave de lookup a partir de schema+name (case-insensitive, sem assinatura) */
export function manifestKey(schema: string, name: string): string {
  return `${schema}.${name}`.toLowerCase();
}
