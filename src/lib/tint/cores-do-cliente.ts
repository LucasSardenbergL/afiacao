/**
 * Helpers puros do card "Cores do cliente" do wizard de pedido: a partir do
 * histórico de pedidos do cliente (`sales_orders` + `items` jsonb com
 * `tint_nome_cor`, populado pelo sync/backfill — PR #704), monta a lista de
 * cores já pedidas, agrupada por cor e ordenada por recência, com busca
 * acento-insensitive ("afiacao" acha "AFIAÇÃO").
 *
 * Spec: docs/superpowers/specs/2026-06-09-cores-do-cliente-wizard-design.md
 */

/** Linha mínima de sales_orders que o hook busca (colunas enxutas + items). */
export interface PedidoHistorico {
  id: string;
  omie_pedido_id: number | null;
  omie_numero_pedido: string | null;
  created_at: string;
  account: string | null;
  items: unknown;
}

export interface OcorrenciaCor {
  /** created_at do pedido (ISO) — quando a cor foi pedida. */
  data: string;
  baseDescricao: string;
  quantidade: number;
  /** Nº do PV sem zeros à esquerda ('' quando não há). */
  pv: string;
  account: string;
  /** Código Omie do produto-base — usado pra reabrir a base no catálogo. */
  omieCodigoProduto: number | null;
}

export interface CorDoCliente {
  /** Grafia mais recente da cor (display). */
  nome: string;
  /** Ordenadas da mais recente pra mais antiga. */
  ocorrencias: OcorrenciaCor[];
}

/** minúsculas + sem acento + trim — base do agrupamento e da busca. */
export function normalizarBusca(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

interface ItemJson {
  descricao?: unknown;
  quantidade?: unknown;
  tint_nome_cor?: unknown;
  omie_codigo_produto?: unknown;
}

/**
 * Dedup (wizard×sync podem gravar o MESMO pedido em 2 linhas — chave
 * `omie_pedido_id`, fallback `id`) → extrai itens com cor → agrupa por cor
 * normalizada → ordena ocorrências e cores por recência.
 */
export function extrairCoresDoHistorico(pedidos: PedidoHistorico[]): CorDoCliente[] {
  const vistos = new Set<string>();
  const grupos = new Map<string, { nome: string; nomeData: number; ocorrencias: OcorrenciaCor[] }>();

  for (const p of pedidos) {
    const chave = p.omie_pedido_id != null ? `omie:${p.omie_pedido_id}` : `id:${p.id}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);

    if (!Array.isArray(p.items)) continue;
    const ts = Date.parse(p.created_at) || 0;
    const pv = (p.omie_numero_pedido ?? '').replace(/^0+/, '');

    for (const raw of p.items as ItemJson[]) {
      if (!raw || typeof raw !== 'object') continue;
      const nomeCor = typeof raw.tint_nome_cor === 'string' ? raw.tint_nome_cor.trim() : '';
      if (!nomeCor) continue;

      const key = normalizarBusca(nomeCor);
      let grupo = grupos.get(key);
      if (!grupo) {
        grupo = { nome: nomeCor, nomeData: ts, ocorrencias: [] };
        grupos.set(key, grupo);
      } else if (ts >= grupo.nomeData) {
        // exibe a grafia da ocorrência mais recente
        grupo.nome = nomeCor;
        grupo.nomeData = ts;
      }

      grupo.ocorrencias.push({
        data: p.created_at,
        baseDescricao: typeof raw.descricao === 'string' ? raw.descricao : '',
        quantidade: typeof raw.quantidade === 'number' ? raw.quantidade : 0,
        pv,
        account: p.account ?? '',
        omieCodigoProduto: typeof raw.omie_codigo_produto === 'number' ? raw.omie_codigo_produto : null,
      });
    }
  }

  const cores = [...grupos.values()].map((g) => ({
    nome: g.nome,
    ocorrencias: g.ocorrencias.sort((a, b) => (Date.parse(b.data) || 0) - (Date.parse(a.data) || 0)),
  }));

  return cores.sort(
    (a, b) =>
      (Date.parse(b.ocorrencias[0]?.data ?? '') || 0) - (Date.parse(a.ocorrencias[0]?.data ?? '') || 0),
  );
}

/** Filtro acento/caixa-insensitive sobre o nome da cor. Vazio → tudo. */
export function filtrarCores(cores: CorDoCliente[], termo: string): CorDoCliente[] {
  const q = normalizarBusca(termo);
  if (!q) return cores;
  return cores.filter((c) => normalizarBusca(c.nome).includes(q));
}
