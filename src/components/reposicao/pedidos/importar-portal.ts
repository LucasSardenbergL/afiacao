// Importar pedido digitado direto no portal Sayerlack pelo número (edge `sayerlack-importar-pedido-portal`).
// Interpretação PURA da resposta da edge para a tela — o que vira sucesso, aviso ou erro.

export const PROTOCOLO_PORTAL_RE = /^\d{3,12}$/;

interface ItemImportado {
  sku_portal: string;
  descricao: string;
  qtde_portal: number;
  valor_mercadoria: number;
}

interface RespostaImportacao {
  ok?: boolean;
  etapa?: 'leitura' | 'importacao' | 'omie' | 'concluido';
  mensagem?: string;
  pedido_id?: number;
  protocolo?: string;
  omie_numero?: string | null;
  valor_total?: number | null;
  valor_total_portal?: number | null;
  situacao_portal?: string | null;
  ja_existia?: boolean;
  itens?: ItemImportado[];
  /** Passos do navegador remoto — a edge devolve quando a LEITURA do portal falha. */
  trace?: unknown[] | null;
  /** SQLSTATE da recusa da RPC (IP002 sem de-para, CP006 NCM sem alíquota, IP007 condição…). */
  sqlstate?: string | null;
  /** Condição de pagamento gravada no pedido ("A07 · Para 7 dias"). */
  condicao?: string | null;
}

type TomResultado = 'sucesso' | 'aviso' | 'erro';

export interface ResultadoTela {
  tom: TomResultado;
  titulo: string;
  mensagem: string;
  pedidoId: number | null;
  omieNumero: string | null;
  itens: ItemImportado[];
  situacaoPortal: string | null;
  valorTotal: number | null;
  /** Diagnóstico da leitura do portal (só em falha de leitura): o que o navegador remoto fez, passo a passo. */
  detalheTecnico: string | null;
  /** Condição de pagamento que foi ao Omie. */
  condicao: string | null;
  /** O que o operador faz para destravar (link para a tela certa), quando existe. */
  acao: { rotulo: string; href: string } | null;
}

/** Recusas que têm uma TELA onde se resolve. As demais dizem na mensagem quem resolve. */
const ACAO_POR_SQLSTATE: Readonly<Record<string, { rotulo: string; href: string }>> = {
  IP002: { rotulo: 'Abrir Mapeamento de SKU', href: '/admin/sku-mapeamento' },
  IP003: { rotulo: 'Abrir Mapeamento de SKU', href: '/admin/sku-mapeamento' },
};

/** Link para o pedido no app (Gerir pedidos abre o detalhe por ?id=, em qualquer ciclo). */
export function linkDoPedido(pedidoId: number): string {
  return `/admin/reposicao/pedidos?id=${pedidoId}`;
}

/**
 * Sucesso SÓ com PO no Omie confirmado pelo banco (`ok` + `etapa='concluido'`). Pedido gravado sem PO é AVISO
 * (dá para importar de novo e re-disparar); qualquer outra coisa é erro — inclusive resposta sem `ok`
 * (ausente ≠ sucesso).
 */
export function interpretarRespostaImportacao(data: unknown, protocolo: string): ResultadoTela {
  // 2xx sem corpo legível: a importação pode ter gravado — é "não sei", nunca "não importado" (Codex C1).
  if (!data || typeof data !== 'object' || Array.isArray(data)) return respostaIndeterminada(protocolo, 'resposta vazia ou ilegível');
  const r = data as RespostaImportacao;
  const base = {
    pedidoId: Number.isInteger(r.pedido_id) ? (r.pedido_id as number) : null,
    omieNumero: r.omie_numero ?? null,
    itens: Array.isArray(r.itens) ? r.itens : [],
    situacaoPortal: r.situacao_portal ?? null,
    valorTotal: typeof r.valor_total === 'number' ? r.valor_total : (typeof r.valor_total_portal === 'number' ? r.valor_total_portal : null),
    detalheTecnico: Array.isArray(r.trace) && r.trace.length > 0 ? JSON.stringify(r.trace, null, 1) : null,
    condicao: r.condicao ?? null,
    acao: r.sqlstate ? ACAO_POR_SQLSTATE[r.sqlstate] ?? null : null,
  };
  if (r.ok === true && r.etapa === 'concluido') {
    return {
      ...base,
      tom: 'sucesso',
      titulo: r.ja_existia ? `Pedido ${protocolo} já estava importado` : `Pedido ${protocolo} importado`,
      mensagem: r.mensagem ?? `Pedido de compra ${base.omieNumero ?? ''} no Omie.`,
    };
  }
  if (r.etapa === 'omie' && base.pedidoId != null) {
    return {
      ...base,
      tom: 'aviso',
      titulo: `Pedido ${protocolo} gravado — falta o Omie`,
      mensagem: r.mensagem ?? 'O pedido de compra no Omie ainda não saiu. Importe de novo para re-disparar.',
    };
  }
  // O pedido EXISTE no app (gravado agora ou antes) mas algo travou: nunca "não foi importado" (Codex C1).
  if (base.pedidoId != null) {
    return {
      ...base,
      tom: 'aviso',
      titulo: `Pedido ${protocolo} está no app (#${base.pedidoId}) — falta resolver`,
      mensagem: r.mensagem ?? `O pedido está gravado no app (#${base.pedidoId}) sem pedido de compra no Omie. Abra o pedido para ver o que falta.`,
    };
  }
  const titulo = r.etapa === 'leitura'
    ? `Não consegui ler o pedido ${protocolo} no portal`
    : `Pedido ${protocolo} não foi importado`;
  return { ...base, tom: 'erro', titulo, mensagem: r.mensagem ?? 'Resposta inesperada da importação.' };
}

/**
 * A chamada não trouxe resposta legível (prazo do gateway, rede). A importação PODE ter gravado e criado o PO depois:
 * não é "não importado" — é "não sei". Reimportar é seguro (não duplica) e é o que se pede; lançar à mão no Omie não.
 */
export function respostaIndeterminada(protocolo: string, detalhe: string | null): ResultadoTela {
  return {
    tom: 'aviso',
    titulo: `Não sei se o pedido ${protocolo} entrou`,
    mensagem: `A resposta do servidor não chegou${detalhe ? ` (${detalhe})` : ''}. Espere 1 minuto e clique em Importar de novo — ` +
      'não duplica: se já entrou, eu mostro o pedido de compra. Não lance à mão no Omie.',
    pedidoId: null, omieNumero: null, itens: [], situacaoPortal: null, valorTotal: null,
    detalheTecnico: null, condicao: null, acao: null,
  };
}

/**
 * Corpo JSON de um erro não-2xx do `supabase.functions.invoke` (fica em `error.context`, um Response). A edge manda o
 * mesmo contrato em 500 — inclusive `pedido_id` de pedido JÁ gravado; reconstruir só com a mensagem apagava o #id e a
 * tela dizia "não foi importado" (Codex P2, 2026-11-07). `null` = sem corpo legível.
 */
export async function corpoDoErroEdge(err: unknown): Promise<Record<string, unknown> | null> {
  const ctx = (err as { context?: unknown } | null)?.context;
  if (!ctx || typeof (ctx as Response).clone !== 'function') return null;
  try {
    const parsed: unknown = await (ctx as Response).clone().json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---- Painel "Pedidos do portal Sayerlack" (RPC sayerlack_painel_portal) ----

interface PendenciaPortal { protocolo: string; mensagem: string; tentativas: number; ultimaEm: string | null }
interface SemPoPortal { pedidoId: number; protocolo: string; status: string | null; importadoEm: string | null }
interface ImportadoPortal {
  pedidoId: number; protocolo: string; omieNumero: string | null; valorTotal: number | null;
  importadoEm: string | null; origem: 'cron' | 'botao';
}
export interface PainelPortal { pendencias: PendenciaPortal[]; semPo: SemPoPortal[]; importados: ImportadoPortal[] }

const lista = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const inteiro = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

/**
 * Normaliza o JSON do painel. Linha sem identidade (protocolo/pedido) é DESCARTADA, não inventada; resposta que não é
 * objeto LANÇA — o card mostra "não consegui ler", nunca "nada pendente" (ausente ≠ vazio).
 */
export function normalizarPainel(data: unknown): PainelPortal {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Resposta do painel do portal ilegível');
  const d = data as Record<string, unknown>;
  return {
    pendencias: lista(d.pendencias).flatMap((p) => {
      const protocolo = texto(p.protocolo);
      return protocolo ? [{ protocolo, mensagem: texto(p.mensagem) ?? '(sem motivo registrado)', tentativas: inteiro(p.tentativas) ?? 1, ultimaEm: texto(p.ultima_em) }] : [];
    }),
    semPo: lista(d.sem_po).flatMap((p) => {
      const pedidoId = inteiro(p.pedido_id); const protocolo = texto(p.protocolo);
      return pedidoId != null && protocolo ? [{ pedidoId, protocolo, status: texto(p.status), importadoEm: texto(p.importado_em) }] : [];
    }),
    importados: lista(d.importados).flatMap((p) => {
      const pedidoId = inteiro(p.pedido_id); const protocolo = texto(p.protocolo);
      return pedidoId != null && protocolo ? [{
        pedidoId, protocolo, omieNumero: texto(p.omie_numero),
        valorTotal: typeof p.valor_total === 'number' && Number.isFinite(p.valor_total) ? p.valor_total : null,
        importadoEm: texto(p.importado_em), origem: p.origem === 'cron' ? 'cron' as const : 'botao' as const,
      }] : [];
    }),
  };
}
