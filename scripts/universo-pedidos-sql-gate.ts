#!/usr/bin/env bun
/**
 * universo-pedidos-sql-gate.ts — fiscal da classe "objeto SQL que lê public.sales_orders com OUTRO
 * universo de pedidos" (docs/historico/universo-pedidos-classe-sql.md). Não executa SQL.
 *
 *   bun scripts/universo-pedidos-sql-gate.ts      # exit 0 limpo · 1 violação · 2 não consegui medir
 *
 * Roda no CI pelo vitest (`universo-pedidos-sql-gate.test.ts`). O núcleo puro mora em
 * scripts/lib/universo-pedidos-sql.ts (o cabeçalho de lá traz a regra e os LIMITES DECLARADOS).
 *
 * A regra, curta: toda função/view/MV cuja ÚLTIMA definição nas migrations lê sales_orders ou aplica,
 * em CADA leitura, o par canônico — `status NOT IN (STATUS_NAO_VENDA)` + `deleted_at IS NULL`, com a
 * lista lida de src/lib/farmer/universo-pedidos.ts — ou está no REGISTRO abaixo, com tipo e motivo.
 * O registro é a lista dos que NÃO são universo de venda de propósito; ele só encolhe (entrada que
 * virou canônica, ou cujo objeto sumiu, reprova).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type EntradaRegistro, julgar, lerAutoridade, modelarPassos } from './lib/universo-pedidos-sql';
import { drenar, type Passos } from '@/lib/gates/passos';

/**
 * Os leitores de sales_orders que NÃO aplicam o universo de VENDA, e por quê. Medido em 2026-10-01
 * (prod e repo: 38 objetos leem a tabela; 17 canônicos, estes 21 fora de propósito).
 *   · lookup — lê o pedido por id/ids (ou pela reserva/item que aponta para ele): a pergunta não é
 *     "isto foi venda?", é "qual é este pedido?";
 *   · escritor — sincronização/edição: escreve o pedido, inclusive o cancelado;
 *   · proposito — mostra ou opera TODO status por desenho (feed, self-service, picking, funil, export);
 *   · canonico_por_parametro — recebe a denylist do chamador e a VALIDA contra a autoridade.
 */
export const REGISTRO_UNIVERSO_PEDIDOS: Readonly<Record<string, EntradaRegistro>> = {
  // ── lookup ──────────────────────────────────────────────────────────────────────────────────
  'private.atp_disponivel': { tipo: 'lookup', motivo: 'ATP: confere se o pedido da RESERVA já existe no Omie (por id)' },
  'private.atp_canonico_da_reserva': { tipo: 'lookup', motivo: 'ATP 3.1: acha a canônica de UMA reserva pelo par próprio (conta, omie_pedido_id) ou pelo vínculo (por id da reserva)' },
  'private.atp_pedido_canonico': { tipo: 'lookup', motivo: 'ATP: acha o gêmeo canônico de um pedido empurrado (por id/omie_pedido_id)' },
  'private.expirar_reservas_vencidas_job': { tipo: 'lookup', motivo: 'ATP: expira reserva cujo pedido não virou Omie (por id)' },
  'public.atp_gate_pedido': { tipo: 'lookup', motivo: 'ATP: gate de UM pedido (por id)' },
  'public.atp_reservas_pendentes': { tipo: 'lookup', motivo: 'ATP: lista reservas ativas com o status do pedido vinculado (por id da reserva)' },
  'public.ensure_picking_task_for_sales_order': { tipo: 'lookup', motivo: 'picking: cria a tarefa de UM pedido (por id), com o gate operacional próprio' },
  'public.order_items_herdar_created_at_omie': { tipo: 'lookup', motivo: 'gatilho: o item herda a data do SEU pedido (por id)' },
  'public.pedido_total_liquido_classificar': { tipo: 'lookup', motivo: 'conversão de total líquido: classifica pedidos Omie por id' },
  'public.pedido_venda_exigir_coerencia': { tipo: 'lookup', motivo: 'coerência itens×payload de UM pedido (por id)' },
  'public.sales_orders_gemeo_app_derivar': {
    tipo: 'lookup',
    motivo: 'gatilho dos gêmeos push/pull (20261001100001): acha a importada do MESMO pedido Omie por (conta, hash canônico), em QUALQUER status — a gêmea cancelada também tira a linha do app do universo',
  },
  'public.staff_get_sales_order_payload': { tipo: 'lookup', motivo: 'payload de pedidos pedidos por ids' },
  'public.tint_gate_revalida': { tipo: 'lookup', motivo: 'tint: revalida o preço de UM pedido no submit (por id)' },
  'public._data_health_compute': {
    tipo: 'lookup',
    aliases: ['t'],
    motivo: 'sensor de gêmeos push/pull (20261001011500): o EXISTS busca o gêmeo IMPORTADO por (conta, omie_pedido_id) — identidade, não venda; a leitura principal (alias a) segue julgada e é canônica',
  },
  // ── escritor ────────────────────────────────────────────────────────────────────────────────
  'public.aplicar_edicao_pedido_omie': { tipo: 'escritor', motivo: 'edição de UM pedido (lê e regrava por id)' },
  'public.criar_pedidos_com_itens': { tipo: 'escritor', motivo: 'importador Omie: insere/deduplica por hash' },
  'public.pedido_total_liquido_converter': { tipo: 'escritor', motivo: 'conversão de total líquido: regrava pedidos por id' },
  'public.reconciliar_pedidos_omie': { tipo: 'escritor', motivo: 'sincronização Omie: reconcilia TODO status, cancelado inclusive' },
  // ── propósito ───────────────────────────────────────────────────────────────────────────────
  'public.order_feed': { tipo: 'proposito', motivo: 'feed de pedidos da equipe: mostra todo status (orçamento, rascunho, cancelado); só esconde o apagado' },
  'public.selfservice_meus_pedidos': { tipo: 'proposito', motivo: 'self-service: o cliente vê os próprios pedidos em todo status (view-gate)' },
  'public.listar_pedidos_a_separar': { tipo: 'proposito', motivo: 'picking: universo OPERACIONAL do que falta separar (não do que foi vendido)' },
  'public.get_whatsapp_funil': { tipo: 'proposito', motivo: 'funil de propostas: conta toda proposta, orçamento inclusive (0 pedidos com conversa em 2026-10-01)' },
  'public.cockpit_itens_snapshot': { tipo: 'proposito', motivo: 'export: devolve status/deleted_at por linha e o universo é do CONSUMIDOR (fin-valor-cockpit — metade TS da classe)' },
  // ── canônico por parâmetro ──────────────────────────────────────────────────────────────────
  'public.apriori_universo_snapshot': { tipo: 'canonico_por_parametro', motivo: 'recebe p_status_nao_venda e o VALIDA contra STATUS_NAO_VENDA antes de ler' },
};

export function lerMigrations(raiz: string): Array<{ nome: string; sql: string }> {
  const dir = join(raiz, 'supabase', 'migrations');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ nome: f, sql: readFileSync(join(dir, f), 'utf8') }));
}

export function rodarGate(raiz: string) {
  return drenar(rodarGatePassos(raiz));
}

/** O gate como gerador: as cessões são as do `modelarPassos`, uma por migration — o teste drena
 *  cedendo o event loop do worker do vitest. */
export function* rodarGatePassos(
  raiz: string,
): Passos<{ migrations: number; objetos: number } & ReturnType<typeof julgar>> {
  const migrations = lerMigrations(raiz);
  const autoridade = lerAutoridade(readFileSync(join(raiz, 'src', 'lib', 'farmer', 'universo-pedidos.ts'), 'utf8'));
  const modelo = yield* modelarPassos(migrations);
  return { migrations: migrations.length, objetos: modelo.size, ...julgar(modelo, REGISTRO_UNIVERSO_PEDIDOS, autoridade) };
}

if (import.meta.main) {
  const raiz = join(import.meta.dir, '..');
  let r: ReturnType<typeof rodarGate>;
  try {
    r = rodarGate(raiz);
  } catch (e) {
    console.error(`universo-pedidos-sql: não consegui medir — ${(e as Error).message}`);
    process.exit(2);
  }
  // denominador: zero migration ou zero leitor é leitura quebrada, nunca "repo limpo"
  if (r.migrations === 0 || r.leitores.length === 0) {
    console.error(`universo-pedidos-sql: não consegui medir — ${r.migrations} migrations, ${r.leitores.length} leitores`);
    process.exit(2);
  }
  for (const v of r.violacoes) console.error(`❌ ${v.objeto} (${v.migration}): ${v.motivo}`);
  console.log(`universo-pedidos-sql: ${r.migrations} migrations · ${r.leitores.length} objetos leem sales_orders · ${Object.keys(REGISTRO_UNIVERSO_PEDIDOS).length} registrados · ${r.violacoes.length} violação(ões)`);
  process.exit(r.violacoes.length ? 1 : 0);
}
