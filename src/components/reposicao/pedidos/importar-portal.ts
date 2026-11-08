// Importar pedido digitado direto no portal Sayerlack pelo número (edge `sayerlack-importar-pedido-portal`).
// Interpretação PURA da resposta da edge para a tela — o que vira sucesso, aviso ou erro.

export const PROTOCOLO_PORTAL_RE = /^\d{3,12}$/;

const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

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
  /** Desfecho da gravação da situação lida (escritor único): `erro` = leu e o banco não gravou (B8). */
  situacao_gravada?: 'aceita' | 'nao_aceita' | 'ilegivel' | 'erro' | null;
  /** Contrato antigo de erro de edge. */
  error?: string;
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
  /** A situação lida no portal não foi gravada (B8) — aviso à parte, vale para qualquer tom. */
  avisoSituacao: string | null;
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

const ETAPAS = new Set(['leitura', 'importacao', 'omie', 'concluido']);

/**
 * B8 (revisão 2): a importadora leu a situação no portal mas o banco NÃO a gravou. Se for um cancelamento, o disparador
 * pode ainda não saber — o operador precisa ver isso, não só o log.
 */
function avisoDaSituacao(r: RespostaImportacao): string | null {
  if (r.situacao_gravada !== 'erro') return null;
  const lida = r.situacao_portal ? ` ("${r.situacao_portal}")` : '';
  return `A situação lida no portal${lida} não foi gravada no app. Se o pedido foi cancelado na Sayerlack, o app ainda ` +
    'não sabe: confira no portal antes de criar ou manter o pedido de compra.';
}

/**
 * Sucesso SÓ com PO no Omie confirmado pelo banco (`ok` + `etapa='concluido'`). Pedido gravado sem PO é AVISO
 * (dá para importar de novo e re-disparar). Erro ("não foi importado") SÓ com desfecho RECONHECIDO de que nada foi
 * gravado: falha de leitura (antes de qualquer escrita), recusa da RPC com SQLSTATE (a transação voltou) ou recusa de
 * entrada 4xx. Qualquer outra coisa — `{}`, `{ok:false}`, 500 sem contrato, `etapa` desconhecida — é "não sei se
 * entrou" (revisão 2, B7/Codex A6: mensagem de infraestrutura não prova rollback). `http` = status quando veio de erro.
 */
export function interpretarRespostaImportacao(data: unknown, protocolo: string, http: number | null = null): ResultadoTela {
  // Sem corpo legível: a importação pode ter gravado — é "não sei", nunca "não importado" (Codex C1).
  if (!data || typeof data !== 'object' || Array.isArray(data)) return respostaIndeterminada(protocolo, 'resposta vazia ou ilegível');
  const r = data as RespostaImportacao;
  const base = {
    pedidoId: Number.isInteger(r.pedido_id) ? (r.pedido_id as number) : null,
    omieNumero: texto(r.omie_numero),
    itens: Array.isArray(r.itens) ? r.itens : [],
    situacaoPortal: texto(r.situacao_portal),
    valorTotal: typeof r.valor_total === 'number' ? r.valor_total : (typeof r.valor_total_portal === 'number' ? r.valor_total_portal : null),
    detalheTecnico: Array.isArray(r.trace) && r.trace.length > 0 ? JSON.stringify(r.trace, null, 1) : null,
    condicao: texto(r.condicao),
    acao: r.sqlstate ? ACAO_POR_SQLSTATE[r.sqlstate] ?? null : null,
    avisoSituacao: avisoDaSituacao(r),
  };
  const etapa = typeof r.etapa === 'string' && ETAPAS.has(r.etapa) ? r.etapa : null;
  if (r.ok === true && etapa === 'concluido') {
    return {
      ...base,
      tom: 'sucesso',
      titulo: r.ja_existia ? `Pedido ${protocolo} já estava importado` : `Pedido ${protocolo} importado`,
      mensagem: r.mensagem ?? `Pedido de compra ${base.omieNumero ?? ''} no Omie.`,
    };
  }
  if (etapa === 'omie' && base.pedidoId != null) {
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
  const mensagem = texto(r.mensagem) ?? texto(r.error);
  if (r.ok === false && etapa === 'leitura') {
    return { ...base, tom: 'erro', titulo: `Não consegui ler o pedido ${protocolo} no portal`, mensagem: mensagem ?? 'A leitura do portal falhou.' };
  }
  const recusaDaRpc = r.ok === false && etapa === 'importacao' && !!texto(r.sqlstate);
  const recusaDeEntrada = r.ok === false && http != null && http >= 400 && http < 500 && mensagem != null;
  if (recusaDaRpc || recusaDeEntrada) {
    return { ...base, tom: 'erro', titulo: `Pedido ${protocolo} não foi importado`, mensagem: mensagem ?? 'A importação recusou o pedido.' };
  }
  return { ...respostaIndeterminada(protocolo, mensagem ?? 'resposta sem desfecho reconhecido'), avisoSituacao: base.avisoSituacao };
}

/**
 * Erro não-2xx do `supabase.functions.invoke`: o corpo estruturado (quando há) passa pela MESMA interpretação, sem
 * inventar `etapa` (inventar `importacao` era o que transformava 500 sem contrato em "não foi importado" — Codex A6).
 * Sem corpo: 4xx com mensagem é recusa de entrada (o gateway/edge recusou antes de tudo); o resto é "não sei".
 */
export function interpretarErroEdge(
  corpo: Record<string, unknown> | null, http: number | null, mensagem: string | null, protocolo: string, detalhe: string | null,
): ResultadoTela {
  if (corpo) return interpretarRespostaImportacao({ ok: false, ...corpo }, protocolo, http);
  if (http != null && http >= 400 && http < 500 && mensagem) {
    return interpretarRespostaImportacao({ ok: false, mensagem }, protocolo, http);
  }
  return respostaIndeterminada(protocolo, mensagem ?? detalhe);
}

/** Status HTTP de um erro do `functions.invoke` (o Response fica em `error.context`). */
export function statusDoErroEdge(err: unknown): number | null {
  const st = ((err as { context?: unknown } | null)?.context as { status?: unknown } | undefined)?.status;
  return typeof st === 'number' && Number.isInteger(st) ? st : null;
}

/** Quantos números o diálogo aceita de uma vez (sequencial: cada um abre uma sessão do Browserless). */
export const MAX_NUMEROS_POR_VEZ = 20;

/**
 * 8.5 / D-3: vários números de uma vez (separados por espaço, vírgula, ponto e vírgula ou linha). Repetidos contam uma
 * vez, na ordem em que apareceram; o que não é número do portal volta em `invalidos` (o operador vê, nada é chamado).
 */
export function lerNumerosPortal(entrada: string): { validos: string[]; invalidos: string[]; excedentes: string[] } {
  const vistos = new Set<string>();
  const validos: string[] = [];
  const invalidos: string[] = [];
  for (const t of entrada.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)) {
    if (!PROTOCOLO_PORTAL_RE.test(t)) { invalidos.push(t); continue; }
    if (vistos.has(t)) continue;
    vistos.add(t);
    validos.push(t);
  }
  return { validos: validos.slice(0, MAX_NUMEROS_POR_VEZ), invalidos, excedentes: validos.slice(MAX_NUMEROS_POR_VEZ) };
}

/**
 * A chamada não trouxe resposta legível (prazo do gateway, rede). A importação PODE ter gravado e criado o PO depois:
 * não é "não importado" — é "não sei". Reimportar é seguro (não duplica) e é o que se pede; lançar à mão no Omie não.
 */
export function respostaIndeterminada(protocolo: string, detalhe: string | null): ResultadoTela {
  return {
    tom: 'aviso',
    titulo: `Não sei se o pedido ${protocolo} entrou`,
    mensagem: `Não recebi do servidor um desfecho claro${detalhe ? ` (${detalhe})` : ''}. Espere 1 minuto e clique em Importar de novo — ` +
      'não duplica: se já entrou, eu mostro o pedido de compra. Não lance à mão no Omie.',
    pedidoId: null, omieNumero: null, itens: [], situacaoPortal: null, valorTotal: null,
    detalheTecnico: null, condicao: null, acao: null, avisoSituacao: null,
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

/** Chave do painel: sob `pedidos-ciclo` (6.7), então o realtime e toda ação de Gerir pedidos o atualizam junto. */
export const CHAVE_PAINEL_PORTAL = ['pedidos-ciclo', 'portal-sayerlack-painel'] as const;

interface PendenciaPortal { protocolo: string; mensagem: string; tentativas: number; ultimaEm: string | null }
interface SemPoPortal { pedidoId: number; protocolo: string; status: string | null; importadoEm: string | null }
interface ImportadoPortal {
  pedidoId: number; protocolo: string; omieNumero: string | null; valorTotal: number | null;
  importadoEm: string | null; origem: 'cron' | 'botao';
}
export interface PainelPortal { pendencias: PendenciaPortal[]; semPo: SemPoPortal[]; importados: ImportadoPortal[] }

const lista = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
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
