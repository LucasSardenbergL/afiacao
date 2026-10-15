// Helpers PUROS da importação de pedidos via cursor server-side (vendas_sync_cursor).
// O clique arma a janela pela RPC vendas_sync_semear_janela; o cron
// vendas-sync-continuacao-6min + edge omie-vendas-sync importam no servidor
// (lease + heartbeat + retomada) — a aba pode fechar. Provado em
// db/test-vendas_sync_semear_janela.sh (PG17 + falsificação).

export const CONTAS_PEDIDOS = ["oben", "colacor"] as const;
export type ContaPedidos = (typeof CONTAS_PEDIDOS)[number];

/**
 * Época do "Importar Todos" = o próprio piso da RPC (p_date_from >= 2015-01-01).
 * O min de sales_orders (colacor 2020-04-08, oben 2023-09-25) não prova o min do OMIE
 * (a tabela nasceu de backfills — prova circular, apontado pelo Codex); 2015 dá margem
 * e período vazio não custa páginas (o filtro de data só inclui). Pedido anterior a
 * 2015 no Omie exigiria mudar o piso da RPC junto.
 */
export const EPOCA_IMPORTAR_TODOS = "2015-01-01";

/** Data LOCAL como YYYY-MM-DD. Não usar toISOString(): à noite no BRT ela vira o dia UTC seguinte. */
export function isoDataLocal(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export interface JanelaImportacao {
  de: string;
  ate: string;
}

export function janelaRecentes(hoje: Date = new Date()): JanelaImportacao {
  const de = new Date(hoje);
  de.setDate(de.getDate() - 180);
  return { de: isoDataLocal(de), ate: isoDataLocal(hoje) };
}

export function janelaTodos(hoje: Date = new Date()): JanelaImportacao {
  return { de: EPOCA_IMPORTAR_TODOS, ate: isoDataLocal(hoje) };
}

/** Linha de vendas_sync_cursor que o polling lê (staff tem SELECT via RLS). */
export interface JanelaCursorRow {
  account: string;
  date_from: string;
  date_to: string;
  next_page: number | null;
  completed_at: string | null;
  last_error_kind: string | null;
  running_since: string | null;
  heartbeat_at: string | null;
  updated_at: string;
  /** Falha honesta (20261015221700): pedidos que a RPC não gravou nesta varredura. */
  pedidos_falhos: unknown;
  tentativas_falha: number;
  /** Estado TERMINAL — o cron pula a janela; só sai por "Re-tentar" (staff). */
  falhou_em: string | null;
  motivo_falha: string | null;
}

export interface StatusJanelaConta {
  account: string;
  dateFrom: string;
  dateTo: string;
  janela: string;
  estado: "rodando" | "aguardando" | "falhando" | "falhou" | "concluida";
  descricao: string;
  /** Terminal e sem lease vivo — o staff pode re-armar a janela. */
  podeRearmar: boolean;
}

/** Mesmo limiar de lease-morto do vendas_sync_lease_acquire (heartbeat > 3 min = livre). */
const LEASE_MORTO_MS = 3 * 60_000;

/** Concluída há mais que isto sai do card (feedback de fim sem ressuscitar o histórico). */
const CONCLUIDA_VISIVEL_MS = 30 * 60_000;


/** `pedidos_falhos` é jsonb vindo do banco — lê o que dá, sem confiar no formato. */
function listaFalhos(v: unknown): Array<{ codigo_pedido?: unknown; sqlstate?: unknown }> {
  return Array.isArray(v) ? (v.filter((x) => x !== null && typeof x === "object") as Array<Record<string, unknown>>) : [];
}

function plural(n: number, um: string, varios: string): string {
  return `${n} ${n === 1 ? um : varios}`;
}

function fmtDataBR(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export function statusJanelas(rows: JanelaCursorRow[], agora: Date = new Date()): StatusJanelaConta[] {
  return rows.map((r) => {
    const base = { account: r.account, dateFrom: r.date_from, dateTo: r.date_to, podeRearmar: false };
    const janela = `${fmtDataBR(r.date_from)} → ${fmtDataBR(r.date_to)}`;
    if (r.completed_at) {
      const quando = new Date(r.completed_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
      return { ...base, janela, estado: "concluida" as const, descricao: `concluída ${quando}` };
    }
    const heartbeatVivo =
      r.heartbeat_at !== null && agora.getTime() - new Date(r.heartbeat_at).getTime() < LEASE_MORTO_MS;
    const pagina = r.next_page ?? 1;
    const falhos = listaFalhos(r.pedidos_falhos);
    // TERMINAL: a janela NÃO está completa — fica explícito o que faltou e por quê.
    if (r.falhou_em) {
      const exemplo = falhos[0];
      const detalhe =
        r.motivo_falha === "pedidos_falhos"
          ? `${plural(falhos.length, "pedido sem prova no banco", "pedidos sem prova no banco")} após 2 varreduras` +
            (exemplo ? ` — ex.: pedido ${String(exemplo.codigo_pedido ?? "?")} (${String(exemplo.sqlstate ?? "?")})` : "")
          : `erro persistente na página ${pagina} (${r.last_error_kind ?? "?"})`;
      return {
        ...base,
        janela,
        estado: "falhou" as const,
        descricao: `importação INCOMPLETA — ${detalhe}`,
        podeRearmar: r.running_since === null,
      };
    }
    // Varredura em curso: só é FALHA a entrada com SQLSTATE (a RPC recusou o pedido). A pendência sem
    // SQLSTATE é o pré-registro de um lote em trânsito — não é falha (3º challenge Codex, P6).
    const falharam = falhos.filter((f) => typeof f.sqlstate === "string").length;
    const sufixo =
      (falharam > 0 ? ` · ${plural(falharam, "pedido falhou", "pedidos falharam")} até aqui` : "") +
      (r.tentativas_falha > 0 ? " · 2ª varredura (a 1ª teve pedidos não gravados)" : "");
    if (r.running_since && heartbeatVivo) {
      return { ...base, janela, estado: "rodando" as const, descricao: `importando — página ${pagina}${sufixo}` };
    }
    // Honestidade sobre falha persistente (achado Codex): last_error_kind aberto não é
    // "aguardando" normal — o motor re-tenta a cada 6 min, mas o usuário precisa VER a falha.
    if (r.last_error_kind) {
      return {
        ...base,
        janela,
        estado: "falhando" as const,
        descricao: `página ${pagina} — última tentativa falhou (${r.last_error_kind}); o motor re-tenta a cada 6 min${sufixo}`,
      };
    }
    return {
      ...base,
      janela,
      estado: "aguardando" as const,
      descricao: `página ${pagina} — aguardando o motor (ciclo a cada 6 min)${sufixo}`,
    };
  });
}

/**
 * Janelas que o card mostra: as EM ANDAMENTO, TODAS as que falharam (até alguém re-armar — é a única via
 * de "Re-tentar", então não expira) e as concluídas há < 30 min.
 */
export function janelasRelevantes(rows: JanelaCursorRow[], agora: Date = new Date()): JanelaCursorRow[] {
  return rows.filter(
    (r) => r.completed_at === null || agora.getTime() - new Date(r.completed_at).getTime() < CONCLUIDA_VISIVEL_MS,
  );
}

/** Em andamento = aberta e NÃO terminal. A terminal o servidor não toca — não pode prender botões/polling. */
export function haJanelaAberta(rows: JanelaCursorRow[]): boolean {
  return rows.some((r) => r.completed_at === null && r.falhou_em === null);
}

/** Desfecho por conta da RPC de semeadura (ver semearJanelaNasContas no useAnalyticsSync). */
export type DesfechoSemeadura = "semeada" | "ja_pendente" | "ja_concluida" | "ja_pendente_outra" | "ja_falhou";

export function rotuloSemeadura(desfecho: DesfechoSemeadura | undefined): string {
  switch (desfecho) {
    case "semeada":
      return "armada";
    case "ja_pendente":
      return "já estava armada";
    case "ja_concluida":
      return "já concluída nesta janela";
    case "ja_pendente_outra":
      return "outra importação em andamento";
    case "ja_falhou":
      return "esta janela falhou — use Re-tentar";
    default:
      return "—";
  }
}
