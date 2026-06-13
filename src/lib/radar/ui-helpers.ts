// Helpers PUROS de apresentação da tela /radar. Sem I/O — testáveis.

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

export type PresetRadar = 'novas' | 'estabelecidas';

export interface RadarOrderParams {
  orderColumn: 'data_abertura' | 'capital_social';
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

export function formatarCnpj(cnpj: string): string {
  if (!/^\d{14}$/.test(cnpj)) return cnpj;
  return cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

/** Extrai só os dígitos de um input de CNAE (até 7). O banco guarda o CNAE como
 *  7 dígitos puros (`3101200`); o usuário costuma digitar o formato oficial
 *  (`3101-2/00`). Normaliza p/ a query casar — prefix match permite parcial. */
export function digitosCnae(input: string | null | undefined): string {
  return (input ?? '').replace(/\D/g, '').slice(0, 7);
}
