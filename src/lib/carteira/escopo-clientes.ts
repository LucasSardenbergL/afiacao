// Escopo de clientes da tela /admin/customers.
// PUROS + HOFs testáveis aqui; a glue Supabase é anexada na 2ª metade (Task 2).
// Spec: docs/superpowers/specs/2026-06-11-clientes-escopo-carteira-design.md
import { supabase } from '@/integrations/supabase/client';
import { coberturaCustoCliente, valorMedido } from '@/lib/scoring/margin';
import { buscarMargensScores } from '@/lib/scoring/margemScores';
import { churnConhecido } from '@/lib/scoring/churn';
import type { Customer, ClientScore } from '@/components/adminCustomers/types';
import { fetchAllPagesComMensagem } from '@/lib/postgrest';

export interface DisplayFlags {
  displayIsMaster: boolean;
  displayIsGestorComercial: boolean;
  displayIsSalesOnly: boolean;
}

/** sales-only é a restrição mais forte (CPF de campo nunca vê a base) → sempre carteira. */
export function resolveModoEscopo(f: DisplayFlags): 'carteira' | 'completa' {
  if (f.displayIsSalesOnly) return 'carteira';
  return f.displayIsMaster || f.displayIsGestorComercial ? 'completa' : 'carteira';
}

export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk: size deve ser > 0');
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function marcarCobertura<T extends { user_id: string }>(
  profiles: T[],
  ownerById: Map<string, string>,
  baseId: string | null,
): (T & { coberto_de: string | null })[] {
  return profiles.map((p) => {
    const owner = ownerById.get(p.user_id) ?? null;
    return { ...p, coberto_de: owner && owner !== baseId ? owner : null };
  });
}

/**
 * Chave de ordenação A–Z de um nome vindo do Omie — gêmea de `private.nome_ordenacao` (migration
 * 20261121132032), que ordena a base completa no servidor. Mesmas regras: sem acento, minúscula,
 * entidade HTML (`&amp;`, `&apos;`) vira espaço, sai o prefixo de MEI "NN.NNN.NNN " (raiz do CNPJ
 * colada no nome), todo não-alfanumérico vira espaço, espaços colapsados. Só-lixo → `null` (fim
 * da lista). O nome EXIBIDO não muda — isto é só a chave.
 */
export function chaveOrdenacaoNome(nome: string | null | undefined): string | null {
  if (nome == null) return null;
  const chave = nome
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[øØ]/g, 'o')
    .toLowerCase()
    .replace(/&(#[0-9]+|#x[0-9a-f]+|[a-z]+);/g, ' ')
    .replace(/^[^a-z0-9]*[0-9]{2}\.[0-9]{3}\.[0-9]{3}\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return chave === '' ? null : chave;
}

/** A–Z pela chave normalizada (só-lixo no fim); desempate estável pelo nome cru e pelo user_id. */
export function ordenarPorNome<T extends { name: string; user_id?: string }>(items: T[]): T[] {
  const comChave = items.map((item) => ({ item, chave: chaveOrdenacaoNome(item.name) }));
  comChave.sort((a, b) => {
    if (a.chave !== b.chave) {
      if (a.chave === null) return 1;
      if (b.chave === null) return -1;
      const c = a.chave.localeCompare(b.chave, 'pt-BR');
      if (c !== 0) return c;
    }
    const n = (a.item.name ?? '').localeCompare(b.item.name ?? '', 'pt-BR');
    if (n !== 0) return n;
    return (a.item.user_id ?? '').localeCompare(b.item.user_id ?? '');
  });
  return comChave.map((x) => x.item);
}

/**
 * Chave de prioridade da ordenação — gêmea do `prio` da RPC `listar_clientes_base`: quem nunca
 * comprou (`sem_historico`) tem prioridade sentinela da edge, não medida → `null`. Sem score, ou
 * valor não finito, também `null`. Nunca 0: 0 é uma prioridade medida (a mais baixa), ausente não é.
 */
export function chavePrioridade(
  score: Pick<ClientScore, 'priority_score' | 'sales_history_status'> | undefined,
): number | null {
  if (!score || score.sales_history_status === 'sem_historico') return null;
  const p = score.priority_score;
  return typeof p === 'number' && Number.isFinite(p) ? p : null;
}

/**
 * Ordem da CARTEIRA (lida inteira em memória), espelho da ordem da base completa no servidor:
 * `prioridade` = prioridade DESC com ausente no FIM, desempate pela mesma chave do A–Z (nome
 * normalizado → nome cru → user_id), então a ordem é total e estável; `nome` = A–Z.
 * Não muta a entrada.
 */
export function ordenarCarteira<T extends { name: string; user_id: string }>(
  items: T[],
  scores: Map<string, Pick<ClientScore, 'priority_score' | 'sales_history_status'>>,
  ordem: 'prioridade' | 'nome',
): T[] {
  const porNome = ordenarPorNome(items);
  if (ordem === 'nome') return porNome;
  // Posição no A–Z = desempate (sort é estável, mas a posição explícita não depende disso).
  const indexado = porNome.map((item, pos) => ({ item, pos, prio: chavePrioridade(scores.get(item.user_id)) }));
  indexado.sort((a, b) => {
    if (a.prio !== b.prio) {
      if (a.prio === null) return 1;
      if (b.prio === null) return -1;
      if (b.prio !== a.prio) return b.prio - a.prio;
    }
    return a.pos - b.pos;
  });
  return indexado.map((x) => x.item);
}

/** Quebra ids em lotes e concatena os resultados, em ordem. Propaga erro de qualquer lote. */
export async function coletarEmLotes<I, O>(
  ids: I[],
  size: number,
  fetchLote: (lote: I[]) => Promise<O[]>,
): Promise<O[]> {
  const out: O[] = [];
  for (const lote of chunk(ids, size)) {
    out.push(...(await fetchLote(lote)));
  }
  return out;
}

/** Hash estável e barato dos IDs visíveis. A contagem sozinha não pega reatribuição
 *  que mantém o tamanho (cliente sai/entra, length igual); o hash muda se qualquer id
 *  mudar. Usado na queryKey dos scores p/ não reusar o map do conjunto anterior. */
export function hashIds(ids: string[]): string {
  let h = 0;
  for (const id of ids) {
    for (let i = 0; i < id.length; i++) {
      h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
    }
  }
  return `${ids.length}:${h}`;
}

/** Owners do escopo do ALVO na lente: posse direta + carteiras que ele cobre (ativas e
 *  dentro da validade). `coverageRows` vêm de carteira_coverage já filtradas por active.
 *  Reproduz, com a sessão do master, o que a RLS carteira_visivel_para daria ao alvo. */
export function ownersAtivosDoAlvo(
  coverageRows: { covered_user_id: string; valid_until: string | null }[],
  alvoId: string,
  nowIso: string,
): string[] {
  const cobertos = coverageRows
    .filter((c) => !c.valid_until || c.valid_until > nowIso)
    .map((c) => c.covered_user_id);
  return [alvoId, ...cobertos];
}

export const LOTE_IN = 150; // 1000 UUIDs estouram o limite de URL do proxy (≠ cap de linhas do PostgREST)

/**
 * Como `coletarEmLotes`, mas com até `concorrencia` lotes em voo. Preserva a ORDEM dos lotes no
 * resultado e propaga o erro de qualquer lote (nunca devolve conjunto parcial). O "Meu dia" do gestor
 * lê ~13k clientes por id (85 lotes): sequencial seria um lote por vez.
 */
export async function coletarEmLotesConcorrente<I, O>(
  ids: I[],
  size: number,
  concorrencia: number,
  fetchLote: (lote: I[]) => Promise<O[]>,
): Promise<O[]> {
  if (concorrencia <= 0) throw new Error('coletarEmLotesConcorrente: concorrencia deve ser > 0');
  const lotes = chunk(ids, size);
  const resultados: O[][] = new Array(lotes.length);
  let proximo = 0;
  const trabalhador = async () => {
    while (proximo < lotes.length) {
      const i = proximo++;
      resultados[i] = await fetchLote(lotes[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concorrencia, lotes.length) }, trabalhador));
  return resultados.flat();
}

/** Na lente a sessão é a do MASTER (RLS vê tudo), então REPRODUZIMOS o escopo do alvo:
 *  posse direta + carteiras que o alvo cobre (ativas e dentro da validade). */
export async function ownersDoAlvoNaLente(alvoId: string): Promise<string[]> {
  const { data: cov, error: covErr } = await supabase
    .from('carteira_coverage')
    .select('covered_user_id, valid_until')
    .eq('covering_user_id', alvoId)
    .eq('active', true);
  if (covErr) throw covErr;
  return ownersAtivosDoAlvo(cov ?? [], alvoId, new Date().toISOString());
}

/**
 * Fonte ÚNICA do escopo de carteira (lista de clientes E "Meu dia"): `carteira_assignments` com
 * `eligible = true`, paginado com `.range()` + ordem TOTAL (`customer_user_id` é UNIQUE) — o select
 * puro capa em 1000. `ownerFilter` null = confia na RLS (`carteira_visivel_para`: carteira própria +
 * cobertura); com lista, recorta pelos donos. Página com erro LANÇA (carteira parcial trocaria o escopo).
 */
export async function fetchAssignmentsElegiveis(
  ownerFilter: string[] | null,
  rotulo: string,
): Promise<{ customer_user_id: string; owner_user_id: string }[]> {
  return fetchAllPagesComMensagem<{ customer_user_id: string; owner_user_id: string }>(
    (de, ate) => {
      let q = supabase
        .from('carteira_assignments')
        .select('customer_user_id, owner_user_id')
        .eq('eligible', true);
      if (ownerFilter) {
        q = q.in('owner_user_id', ownerFilter);
      }
      return q.order('customer_user_id').range(de, ate);
    },
    rotulo,
    'carteira_assignments',
  );
}

/**
 * Clientes da carteira. Fonte = carteira_assignments (eligible=true), paginado
 * (select puro capa em 1000). Fora da lente a RLS já escopa pra carteira+cobertura;
 * na lente (sessão é o master → RLS vê tudo) filtra pelo owner do alvo.
 */
export async function fetchCarteiraClientes(opts: {
  isImpersonating: boolean;
  effectiveUserId: string | null;
  baseId: string | null;
}): Promise<{ customers: Customer[]; ids: string[] }> {
  // Fora da lente, a RLS carteira_visivel_para já entrega carteira própria + cobertura — sem filtro.
  const ownerFilter = opts.isImpersonating && opts.effectiveUserId
    ? await ownersDoAlvoNaLente(opts.effectiveUserId)
    : null;

  // Pelo canônico: página com error ou `data: null` sem error LANÇA (a carteira PARCIAL trocaria o
  // escopo do cálculo) e a página perdida é medida pela fonte. `customer_user_id` é a chave.
  const assignments = await fetchAssignmentsElegiveis(ownerFilter, 'carteira_assignments/escopo-clientes');

  const ownerById = new Map(
    assignments.map((a) => [a.customer_user_id, a.owner_user_id] as [string, string]),
  );
  const ids = [...ownerById.keys()];
  if (ids.length === 0) return { customers: [], ids };

  const profiles = await coletarEmLotes(ids, LOTE_IN, async (lote) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('user_id, name, email, phone, document, customer_type, created_at, requires_po')
      .in('user_id', lote)
      .eq('is_employee', false);
    if (error) throw error;
    return (data ?? []) as Customer[];
  });

  const customers = ordenarPorNome(marcarCobertura(profiles, ownerById, opts.baseId));
  return { customers, ids };
}

/**
 * Scores por customer_user_id (não por farmer_id): UNIQUE(customer_user_id) garante
 * 1 linha/cliente, conserta scores stale pós-reatribuição e vazios pro gestor/master.
 * A RLS de farmer_client_scores reforça (pode_ver_carteira_completa OR carteira_visivel_para).
 */
export async function fetchScoresPorCustomer(ids: string[]): Promise<Map<string, ClientScore>> {
  const map = new Map<string, ClientScore>();
  if (ids.length === 0) return map;
  const rows = await coletarEmLotes(ids, LOTE_IN, async (lote) => {
    const { data, error } = await supabase
      .from('farmer_client_scores')
      .select('customer_user_id, health_score, health_class, churn_risk, expansion_score, priority_score, avg_monthly_spend_180d, days_since_last_purchase, category_count, itens_com_custo, itens_sem_custo, avg_repurchase_interval, sales_history_status')
      .in('customer_user_id', lote);
    if (error) throw error;
    return data ?? [];
  });
  // A margem NÃO vem da tabela (coluna fechada para authenticated, FU4-F): sai pela RPC com gate de
  // projeção. Falha da RPC LANÇA — "não consegui ler" não pode virar "margem não apurada".
  const margens = await buscarMargensScores({ customerIds: ids });
  for (const s of rows) {
    const margem = margens.get(s.customer_user_id);
    const cobertura = coberturaCustoCliente(s);
    map.set(s.customer_user_id, {
      customer_user_id: s.customer_user_id,
      // Sem `?? 0` (onda B): score ausente é "não avaliado", não saúde zero.
      health_score: s.health_score ?? null,
      // Sem `?? 'critico'`: classe ausente é "não avaliado", não um veredito.
      health_class: s.health_class ?? null,
      // Sem `?? 0`: risco ausente chega como null ao consumidor (mesma razão do gross_margin_pct
      // abaixo). Coagir para 0 afirmaria "sem risco de churn" — o melhor resultado — sobre quem
      // não foi medido. churn_risk é 0–100 e 0 é conhecido.
      churn_risk: churnConhecido(s.churn_risk),
      // O #1565 corrigiu `churn_risk` NESTE mesmo map.set e deixou a linha abaixo. Coagir na
      // fronteira torna inertes os guards de quem lê o mapa (#1498) — mesma razão, mesmo helper.
      expansion_score: valorMedido(s.expansion_score),
      // Sem `?? 0` (mesma razão do churn_risk acima): `days ?? 0` afirmava "comprou hoje" e
      // `spend ?? 0` afirmava "R$ 0,00 medido" sobre quem não foi medido.
      priority_score: s.priority_score ?? null,
      avg_monthly_spend_180d: s.avg_monthly_spend_180d ?? null,
      days_since_last_purchase: s.days_since_last_purchase ?? null,
      category_count: s.category_count ?? null,
      // Sem `?? 0`: margem ausente tem de chegar como null ao consumidor. Coagir aqui tornaria
      // inertes os guards de quem lê este mapa (a armadilha da "correção só no consumidor").
      gross_margin_pct: margem?.margem ?? null,
      // Sem cap_custo_ler (ou sem linha na RPC) o número não foi concedido — a tela não fala de margem.
      margem_oculta: margem ? !margem.visivel : true,
      // Cobertura de custo (#1567): mesma disciplina — contagem não computada chega como null.
      itens_com_custo: cobertura.itensComCusto,
      itens_sem_custo: cobertura.itensSemCusto,
      // Já vinha no select mas não era mapeado: o 360 lia avg_monthly_spend_180d no lugar dele.
      avg_repurchase_interval: s.avg_repurchase_interval ?? null,
      sales_history_status: s.sales_history_status ?? null,
    });
  }
  return map;
}
