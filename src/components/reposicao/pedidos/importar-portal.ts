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
interface SemPoPortal {
  pedidoId: number; protocolo: string; status: string | null; importadoEm: string | null;
  /** Desde quando está sem pedido de compra (importação ou envio ao portal). */
  desde: string | null; origem: 'importado' | 'app';
  /** A falha da varredura do MESMO protocolo vem dentro da linha (6.4 — conta uma vez). */
  pendenciaMensagem: string | null; pendenciaTentativas: number | null;
}
interface CanceladoPortal { pedidoId: number; protocolo: string; omieNumero: string | null; situacaoEm: string | null }
interface ImportadoPortal {
  pedidoId: number; protocolo: string; omieNumero: string | null; valorTotal: number | null;
  importadoEm: string | null; origem: 'cron' | 'botao';
}
interface RodadaEfetiva {
  em: string; lidos: number | null; importados: number | null; falhas: number | null;
  /** `null` = a rodada não informou (ausente ≠ zero). */
  adiados: number | null; indeterminados: number | null; carencia: number | null; carenciaPresa: number | null;
}
interface RodadaUltima { em: string; status: 'sucesso' | 'erro'; pulado: string | null; erro: string | null; causa: string | null }
export interface PainelPortal {
  consultadoEm: string;
  rodada: { emDia: boolean; exigidaDesde: string | null; efetiva: RodadaEfetiva | null; ultima: RodadaUltima | null };
  pendencias: PendenciaPortal[]; totalPendencias: number;
  semPo: SemPoPortal[]; totalSemPo: number;
  aguardando: { total: number; maisAntigoEm: string | null };
  canceladoSemPo: CanceladoPortal[]; totalCanceladoSemPo: number;
  canceladoComPo: CanceladoPortal[]; totalCanceladoComPo: number;
  pendentesUnicos: number;
  importados: ImportadoPortal[]; totalImportados: number;
  semAliquota: { skus: number; ncms: string[] };
}

const lista = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
const inteiro = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const objeto = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Erro de CONTRATO: a tela diz "não consegui ler", nunca "nada pendente" (6.2). */
class ContratoPainelInvalido extends Error {
  constructor(o_que: string) { super(`Resposta do painel do portal ilegível (${o_que})`); }
}
/** Total obrigatório: inteiro ≥ 0. Ausente LANÇA — um total que some não pode virar 0. */
function total(d: Record<string, unknown>, chave: string): number {
  const n = inteiro(d[chave]);
  if (n == null || n < 0) throw new ContratoPainelInvalido(chave);
  return n;
}
function listaObrigatoria(d: Record<string, unknown>, chave: string): Record<string, unknown>[] {
  if (!Array.isArray(d[chave])) throw new ContratoPainelInvalido(chave);
  return lista(d[chave]);
}
const cancelado = (p: Record<string, unknown>): CanceladoPortal[] => {
  const pedidoId = inteiro(p.pedido_id); const protocolo = texto(p.protocolo);
  return pedidoId != null && protocolo ? [{ pedidoId, protocolo, omieNumero: texto(p.omie_numero), situacaoEm: texto(p.situacao_em) }] : [];
};

/**
 * Normaliza o JSON do painel (contrato v2 da RPC, migration 20261109100000). Contrato RÍGIDO (6.2): `{}`, versão
 * antiga, lista ou total ausente → LANÇA, e o card mostra "não consegui ler" — nunca três listas vazias. Linha sem
 * identidade (protocolo/pedido) é descartada, não inventada.
 */
export function normalizarPainel(data: unknown): PainelPortal {
  const d = objeto(data);
  if (!d) throw new ContratoPainelInvalido('não é objeto');
  if (d.versao !== 2) throw new ContratoPainelInvalido('versão');
  const consultadoEm = texto(d.consultado_em);
  const rodada = objeto(d.rodada);
  if (!consultadoEm || !rodada || typeof rodada.em_dia !== 'boolean') throw new ContratoPainelInvalido('rodada');
  const ef = objeto(rodada.ultima_efetiva);
  const ul = objeto(rodada.ultima);
  const aguardando = objeto(d.aguardando_disparo);
  const aliq = objeto(d.sem_aliquota);
  if (!aguardando || !aliq) throw new ContratoPainelInvalido('espera/alíquota');
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    consultadoEm,
    rodada: {
      emDia: rodada.em_dia,
      exigidaDesde: texto(rodada.exigida_desde),
      efetiva: ef && texto(ef.em) ? {
        em: texto(ef.em) as string, lidos: num(ef.lidos), importados: num(ef.importados), falhas: num(ef.falhas),
        adiados: num(ef.adiados), indeterminados: num(ef.indeterminados), carencia: num(ef.carencia), carenciaPresa: num(ef.carencia_presa),
      } : null,
      ultima: ul && texto(ul.em) && (ul.status === 'sucesso' || ul.status === 'erro') ? {
        em: texto(ul.em) as string, status: ul.status, pulado: texto(ul.pulado), erro: texto(ul.erro), causa: texto(ul.causa),
      } : null,
    },
    pendencias: listaObrigatoria(d, 'pendencias').flatMap((p) => {
      const protocolo = texto(p.protocolo);
      return protocolo ? [{ protocolo, mensagem: texto(p.mensagem) ?? '(sem motivo registrado)', tentativas: inteiro(p.tentativas) ?? 1, ultimaEm: texto(p.ultima_em) }] : [];
    }),
    totalPendencias: total(d, 'total_pendencias'),
    semPo: listaObrigatoria(d, 'sem_po').flatMap((p) => {
      const pedidoId = inteiro(p.pedido_id); const protocolo = texto(p.protocolo);
      return pedidoId != null && protocolo ? [{
        pedidoId, protocolo, status: texto(p.status), importadoEm: texto(p.importado_em), desde: texto(p.desde),
        origem: p.origem === 'app' ? 'app' as const : 'importado' as const,
        pendenciaMensagem: texto(p.pendencia_mensagem), pendenciaTentativas: inteiro(p.pendencia_tentativas),
      }] : [];
    }),
    totalSemPo: total(d, 'total_sem_po'),
    aguardando: { total: total(aguardando, 'total'), maisAntigoEm: texto(aguardando.mais_antigo_em) },
    canceladoSemPo: listaObrigatoria(d, 'cancelado_sem_po').flatMap(cancelado),
    totalCanceladoSemPo: total(d, 'total_cancelado_sem_po'),
    canceladoComPo: listaObrigatoria(d, 'cancelado_com_po').flatMap(cancelado),
    totalCanceladoComPo: total(d, 'total_cancelado_com_po'),
    pendentesUnicos: total(d, 'pendentes_unicos'),
    importados: listaObrigatoria(d, 'importados').flatMap((p) => {
      const pedidoId = inteiro(p.pedido_id); const protocolo = texto(p.protocolo);
      return pedidoId != null && protocolo ? [{
        pedidoId, protocolo, omieNumero: texto(p.omie_numero),
        valorTotal: typeof p.valor_total === 'number' && Number.isFinite(p.valor_total) ? p.valor_total : null,
        importadoEm: texto(p.importado_em), origem: p.origem === 'cron' ? 'cron' as const : 'botao' as const,
      }] : [];
    }),
    totalImportados: total(d, 'total_importados'),
    semAliquota: { skus: total(aliq, 'skus'), ncms: Array.isArray(aliq.ncms) ? aliq.ncms.filter((x): x is string => typeof x === 'string') : [] },
  };
}

/** Espera da última rodada efetiva que ainda vai virar pedido de compra (ou pendência) nas próximas rodadas. */
export function esperaDaRodada(p: PainelPortal): { total: number | null; partes: string[] } {
  const ef = p.rodada.efetiva;
  if (!ef) return { total: null, partes: [] };
  const itens: [number | null, string][] = [
    [ef.carencia, 'em carência (esperando o espelho do Omie)'], [ef.adiados, 'adiado(s) por tempo'],
    [ef.indeterminados, 'sem resposta da importação'], [ef.carenciaPresa, 'com carência presa'],
  ];
  if (itens.some(([n]) => n == null)) return { total: null, partes: itens.filter(([n]) => (n ?? 0) > 0).map(([n, r]) => `${n} ${r}`) };
  return { total: itens.reduce((a, [n]) => a + (n ?? 0), 0), partes: itens.filter(([n]) => (n ?? 0) > 0).map(([n, r]) => `${n} ${r}`) };
}

/**
 * 6.1: o veredito do card. "Nada pendente" (tom `ok`) SÓ com: zero pendência, zero espera conhecida, nenhum pedido
 * aguardando o disparo, rodada efetiva dentro do dia exigido, e a última rodada decidida não falhou depois dela.
 * Faltou prova → `sem_prova` (nunca verde). Há o que fazer → `atencao`.
 */
export function vereditoPainel(p: PainelPortal): { tom: 'ok' | 'atencao' | 'sem_prova'; motivo: string | null } {
  const ef = p.rodada.efetiva;
  const ul = p.rodada.ultima;
  const falhouDepois = ul?.status === 'erro' && (!ef || Date.parse(ul.em) > Date.parse(ef.em));
  if (p.pendentesUnicos > 0) return { tom: 'atencao', motivo: null };
  if (!ef) return { tom: 'sem_prova', motivo: 'Nenhuma rodada automática leu o portal com prova até agora.' };
  if (falhouDepois) return { tom: 'sem_prova', motivo: 'A última rodada automática falhou — pode haver pedido que eu ainda não vi.' };
  if (!p.rodada.emDia) return { tom: 'sem_prova', motivo: 'Sem rodada automática com prova desde o último dia útil.' };
  const espera = esperaDaRodada(p);
  if (espera.total == null) return { tom: 'sem_prova', motivo: 'A última rodada não informou o que ficou em espera.' };
  if (espera.total > 0 || p.aguardando.total > 0) return { tom: 'atencao', motivo: null };
  return { tom: 'ok', motivo: null };
}

/** Horários do cron em SP (12:30 · 17:30 · 22:30). Uma rodada leva até ~3 min; reler 7 min depois. */
const HORARIOS_CRON_SP = [[12, 30], [17, 30], [22, 30]] as const;
const FOLGA_POS_CRON_MS = 7 * 60_000;
/** ms até reler o painel depois da próxima rodada do cron (6.7). Puro: recebe o "agora". */
export function msAteReleituraPosCron(agora: Date): number {
  // Hora de SP pelo deslocamento FIXO -03:00 (sem horário de verão desde 2019).
  const spMs = agora.getTime() - 3 * 3600_000;
  const sp = new Date(spMs);
  const inicioDiaSp = Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate());
  for (let dia = 0; dia < 2; dia++) {
    for (const [h, m] of HORARIOS_CRON_SP) {
      const alvoSp = inicioDiaSp + dia * 86_400_000 + (h * 60 + m) * 60_000 + FOLGA_POS_CRON_MS;
      if (alvoSp > spMs) return alvoSp - spMs;
    }
  }
  return 86_400_000;
}
