// Fila de crédito (crédito-IA PR 6a) — núcleo puro da tela /credito/fila.
// Banco: supabase/migrations/20261125230000_credito_fila_enforcement_dormente.sql (view credito_fila_v).
// Ausente ≠ zero: número que o banco não mediu chega como null e é exibido como "—", nunca "R$ 0".

type OrigemFila = 'efetivo' | 'sombra';
type StatusFila = 'aberta' | 'congelada' | 'superada' | 'simulada' | 'autorizada' | 'recusada' | 'cancelada';
export type Empresa = 'oben' | 'colacor' | 'colacor_sc';

export interface ItemFila {
  origem: OrigemFila;
  item_id: string;
  solicitacao_id: string | null;
  decisao_id: string;
  sales_order_id: string;
  company: Empresa;
  revisao: string;
  valor_brl: number;
  prazo_dias: number | null;
  motivo: string;
  faixa: string;
  limite_brl: number | null;
  prazo_max_dias: number | null;
  exposicao_titulos_brl: number | null;
  exposicao_reservas_brl: number | null;
  status: StatusFila;
  criado_em: string;
  decidida_em: string | null;
  customer_user_id: string | null;
  omie_numero_pedido: string | null;
  pedido_status: string | null;
  vendedor_user_id: string | null;
  origem_pedido: 'app' | 'omie';
  recomendacao_status: 'em_andamento' | 'ok' | 'erro' | 'esgotada' | null;
  recomendacao: 'aprovar' | 'recusar' | 'sem_recomendacao' | null;
  prazo_sugerido_dias: number | null;
  recomendacao_confianca: number | null;
  recomendacao_codigos: string[] | null;
}

export const EMPRESA_ROTULO: Record<Empresa, string> = {
  oben: 'Oben',
  colacor: 'Colacor',
  colacor_sc: 'Colacor SC',
};

const MOTIVO_ROTULO: Record<string, string> = {
  estoura_limite: 'Estoura o limite do grupo',
  prazo_acima: 'Prazo acima do máximo do grupo',
  prazo_ilegivel: 'Prazo da condição de pagamento ilegível',
  sem_limite: 'Grupo sem limite aprovado',
  limite_desatualizado: 'Limite desatualizado (ficha > 14 d)',
  risco_alto: 'Risco alto',
  risco_sem_evidencia: 'Risco sem evidência',
  exposicao_indeterminada: 'Exposição indeterminada (título sem saldo)',
};

export function rotuloMotivo(motivo: string): string {
  return MOTIVO_ROTULO[motivo] ?? motivo.replace(/_/g, ' ');
}

const CODIGO_ROTULO: Record<string, string> = {
  dentro_historico: 'dentro do histórico',
  estouro_pequeno: 'estouro pequeno',
  estouro_grande: 'estouro grande',
  prazo_acima_historico: 'prazo acima do histórico',
  prazo_desconhecido: 'prazo desconhecido',
  risco_alto: 'risco alto',
  sem_historico: 'sem histórico',
  exposicao_alta: 'exposição alta',
  pagador_pontual: 'pagador pontual',
  atraso_recente: 'atraso recente',
  limite_desatualizado: 'limite desatualizado',
  sem_limite: 'sem limite',
  limite_mudou: 'limite mudou',
};

export function rotuloCodigo(c: string): string {
  return CODIGO_ROTULO[c] ?? c.replace(/_/g, ' ');
}

/** "R$ 5.000,00" ou "—" quando o banco não mediu (null). Nunca fabrica zero. */
export function brl(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function dias(v: number | null | undefined): string {
  return v === null || v === undefined ? 'desconhecido' : `${v} d`;
}

/** Uso do limite APÓS o pedido; null se qualquer parcela não foi medida. */
export function usoPosPedido(i: Pick<ItemFila, 'limite_brl' | 'exposicao_titulos_brl' | 'exposicao_reservas_brl' | 'valor_brl'>): number | null {
  if (i.limite_brl === null || i.limite_brl <= 0) return null;
  if (i.exposicao_titulos_brl === null || i.exposicao_reservas_brl === null) return null;
  return (i.exposicao_titulos_brl + i.exposicao_reservas_brl + i.valor_brl) / i.limite_brl;
}

const SLA_HORAS = 2;

/** Horas na fila (inteiras para baixo). */
export function horasNaFila(criadoEm: string, agora: Date = new Date()): number {
  return Math.max(0, Math.floor((agora.getTime() - new Date(criadoEm).getTime()) / 3_600_000));
}

export function passouDoSla(i: Pick<ItemFila, 'origem' | 'status' | 'criado_em'>, agora: Date = new Date()): boolean {
  if (i.origem !== 'efetivo' || i.status !== 'aberta') return false;
  return agora.getTime() - new Date(i.criado_em).getTime() >= SLA_HORAS * 3_600_000;
}

export type FaceRecomendacao =
  | { tipo: 'chegando' }
  | { tipo: 'falhou' }
  | { tipo: 'abstencao' }
  | { tipo: 'pronta'; recomendacao: 'aprovar' | 'recusar'; confianca: number | null; prazo: number | null; codigos: string[] };

export function faceRecomendacao(i: Pick<ItemFila, 'recomendacao_status' | 'recomendacao' | 'recomendacao_confianca' | 'prazo_sugerido_dias' | 'recomendacao_codigos'>): FaceRecomendacao {
  if (i.recomendacao_status === 'esgotada') return { tipo: 'falhou' };
  if (i.recomendacao_status !== 'ok' || !i.recomendacao) return { tipo: 'chegando' };
  if (i.recomendacao === 'sem_recomendacao') return { tipo: 'abstencao' };
  return {
    tipo: 'pronta',
    recomendacao: i.recomendacao,
    confianca: i.recomendacao_confianca,
    prazo: i.prazo_sugerido_dias,
    codigos: i.recomendacao_codigos ?? [],
  };
}

/**
 * Decidir contra a recomendação da IA exige motivo explícito (spec §5.7). Autorizar libera o prazo
 * DA REVISÃO (a fila não troca parcela): IA "aprovar" com prazo sugerido menor que o pedido — ou com
 * prazo pedido desconhecido — e o Lucas autorizando = discordância.
 */
export function discordaDaIa(face: FaceRecomendacao, autorizar: boolean, prazoRevisao: number | null): boolean {
  if (face.tipo !== 'pronta') return false;
  if ((face.recomendacao === 'aprovar') !== autorizar) return true;
  if (autorizar && face.prazo !== null && (prazoRevisao === null || face.prazo < prazoRevisao)) return true;
  return false;
}

export function motivoValido(m: string): boolean {
  return m.trim().length >= 3;
}

interface CondicaoProntidao {
  chave: string;
  ok: boolean;
  criterio: string;
  valor: Record<string, unknown>;
}

export interface Prontidao {
  company: Empresa;
  pronto: boolean;
  medido_em: string;
  condicoes: CondicaoProntidao[];
}

/** Ordena: efetivo aberto mais velho primeiro; depois o resto do efetivo; sombra por data. */
export function ordenarFila(itens: ItemFila[]): ItemFila[] {
  const peso = (i: ItemFila) => (i.origem === 'efetivo' ? (i.status === 'aberta' ? 0 : 1) : 2);
  return [...itens].sort((a, b) => peso(a) - peso(b) || a.criado_em.localeCompare(b.criado_em));
}
