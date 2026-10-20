// Helpers PUROS de apresentação da tela /radar. Sem I/O — testáveis.

import { CNPJ_RE } from '@/lib/radar/normalizar';

export type AcaoContato = 'em_conversa' | 'contatado_sem_resposta' | 'virou_cliente' | 'descartado';

export interface AcaoConfig {
  acao: AcaoContato;
  label: string;
  icon: 'message' | 'phone-missed' | 'check' | 'ban';
  confirmar: boolean;     // descartar pede confirmação (AlertDialog)
  destrutivo: boolean;    // estiliza em status-error
}

// Vocabulário operável pela UI (a_contatar é o estado inicial, não uma ação de menu).
export const ACOES_CONTATO: AcaoConfig[] = [
  { acao: 'em_conversa',            label: 'Falei — em conversa', icon: 'message',      confirmar: false, destrutivo: false },
  { acao: 'contatado_sem_resposta', label: 'Não atendeu',         icon: 'phone-missed', confirmar: false, destrutivo: false },
  { acao: 'virou_cliente',          label: 'Virou cliente',       icon: 'check',        confirmar: false, destrutivo: false },
  { acao: 'descartado',             label: 'Descartar',           icon: 'ban',          confirmar: true,  destrutivo: true  },
];

export type PresetRadar = 'score' | 'novas' | 'estabelecidas';

export interface RadarOrderParams {
  orderColumn: 'score' | 'data_abertura' | 'capital_social';
  orderAsc: boolean;
  dataAberturaMax: string | null;  // 'YYYY-MM-DD' (abertura <= isto)
  dataAberturaMin: string | null;  // 'YYYY-MM-DD' (abertura >= isto)
}

// Subtrai N anos de uma data ISO 'YYYY-MM-DD' (string-math, sem fuso).
function menosAnos(hojeISO: string, anos: number): string {
  const [a, m, d] = hojeISO.split('-');
  return `${String(Number(a) - anos).padStart(4, '0')}-${m}-${d}`;
}

export function presetParaParams(preset: PresetRadar, hojeISO: string): RadarOrderParams {
  // 'score' = fila por score DESC (o hook põe NULL por último); sem corte de idade.
  if (preset === 'score') {
    return { orderColumn: 'score', orderAsc: false, dataAberturaMax: null, dataAberturaMin: null };
  }
  if (preset === 'estabelecidas') {
    return { orderColumn: 'capital_social', orderAsc: false, dataAberturaMax: menosAnos(hojeISO, 5), dataAberturaMin: null };
  }
  return { orderColumn: 'data_abertura', orderAsc: false, dataAberturaMax: null, dataAberturaMin: null };
}

export function idadeEmAnos(dataAbertura: string | null | undefined, hojeISO: string): number | null {
  if (!dataAbertura || !/^\d{4}-\d{2}-\d{2}$/.test(dataAbertura)) return null;
  const [ay, am, ad] = dataAbertura.split('-').map(Number);
  const [hy, hm, hd] = hojeISO.split('-').map(Number);
  let anos = hy - ay;
  if (hm < am || (hm === am && hd < ad)) anos -= 1;
  return anos;
}

const PORTE_RFB: Record<string, string> = { '00': 'Não informado', '01': 'ME', '03': 'EPP', '05': 'Demais' };
export function rotuloPorte(porte: string | null | undefined): string {
  if (!porte) return '—';
  return PORTE_RFB[porte] ?? '—';
}

export function formatarCapital(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `R$ ${Math.round(v).toLocaleString('pt-BR')}`;
}

/** Máscara 00.000.000/0000-00 — vale igual para o CNPJ alfanumérico (RFB jul/2026: 12.ABC.345/01DE-35).
 *  Fora do formato (`CNPJ_RE`) devolve cru. */
export function formatarCnpj(cnpj: string): string {
  if (!CNPJ_RE.test(cnpj)) return cnpj;
  return cnpj.replace(/^(.{2})(.{3})(.{3})(.{4})(.{2})$/, '$1.$2.$3/$4-$5');
}

/** Extrai só os dígitos de um input de CNAE (até 7). O banco guarda o CNAE como
 *  7 dígitos puros (`3101200`); o usuário costuma digitar o formato oficial
 *  (`3101-2/00`). Normaliza p/ a query casar — prefix match permite parcial. */
export function digitosCnae(input: string | null | undefined): string {
  return (input ?? '').replace(/\D/g, '').slice(0, 7);
}

// ── Status de prospecção: rótulo + tom (cor semântica, nunca cor crua) ──────────────────
export type TomStatus = 'neutro' | 'info' | 'warning' | 'success' | 'muted';
const STATUS_UI: Record<string, { label: string; tom: TomStatus }> = {
  a_contatar:             { label: 'A contatar',    tom: 'neutro' },
  em_conversa:            { label: 'Em conversa',   tom: 'info' },
  contatado_sem_resposta: { label: 'Não atendeu',   tom: 'warning' },
  virou_cliente:          { label: 'Virou cliente', tom: 'success' },
  descartado:             { label: 'Descartado',    tom: 'muted' },
};
export function rotuloStatus(status: string | null | undefined): string {
  return (status && STATUS_UI[status]?.label) || status || '—';
}
export function tomStatus(status: string | null | undefined): TomStatus {
  return (status && STATUS_UI[status]?.tom) || 'neutro';
}
export const CLASSE_TOM: Record<TomStatus, string> = {
  neutro: 'border-border text-foreground',
  info: 'border-status-info/40 text-status-info bg-status-info/10',
  warning: 'border-status-warning/40 text-status-warning bg-status-warning/10',
  success: 'border-status-success/40 text-status-success bg-status-success/10',
  muted: 'border-border text-muted-foreground',
};

// ── Score de lead (radar_score_recalcular, 1×/dia): número + motivos, ou "sem score" honesto ───────
export interface ScoreUI {
  texto: string;    // '72' ou 'sem score'
  tom: TomStatus;   // ≥60 success · ≥40 info · <40 neutro · NULL muted
  detalhe: string;  // motivos que pontuaram, ou o motivo do NULL ('fora da foto vigente'), ou 'ainda não calculado'
}
/** NULL nunca vira 0: score ausente é um ESTADO ("sem score") com o motivo que o banco escreveu. */
export function scoreUI(score: number | null | undefined, motivos: string[] | null | undefined): ScoreUI {
  if (score == null || !Number.isFinite(score)) {
    return { texto: 'sem score', tom: 'muted', detalhe: motivos?.[0] || 'ainda não calculado' };
  }
  const tom: TomStatus = score >= 60 ? 'success' : score >= 40 ? 'info' : 'neutro';
  return { texto: String(score), tom, detalhe: motivos && motivos.length > 0 ? motivos.join(' · ') : 'sem fatores pontuados' };
}

/** Primeiro telefone utilizável (telefone1, senão telefone2) — o botão Ligar da linha. */
export function telefonePrincipal(e: { telefone1: string | null; telefone2: string | null }): string | null {
  return e.telefone1 || e.telefone2 || null;
}

/** Todas as 27 UFs do Brasil (o filtro antes trazia 11 hardcoded). */
export const UFS_BR = [
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI',
  'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
] as const;

/** `0111301` → `0111-3/01` (formato oficial; pontuado vira TEXTO no Excel, zero à esquerda fica). */
export function formatarCnae(cnae: string | null | undefined): string {
  if (!cnae || !/^\d{7}$/.test(cnae)) return cnae ?? '';
  return cnae.replace(/^(\d{4})(\d)(\d{2})$/, '$1-$2/$3');
}
/** `01001000` → `01001-000`. */
export function formatarCep(cep: string | null | undefined): string {
  const d = (cep ?? '').replace(/\D/g, '');
  if (d.length !== 8) return cep ?? '';
  return `${d.slice(0, 5)}-${d.slice(5)}`;
}
