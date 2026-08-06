// Agregação da visão de calendário (/sales/programados?view=calendario).
// PURO e sem imports: datas viajam como STRING 'YYYY-MM-DD' — nunca new Date('YYYY-MM-DD'),
// que interpreta UTC e desloca o dia no fuso local. Money-path: valor ausente propaga
// null (ausente ≠ zero — CLAUDE.md); soma de estado anômalo não vira 0 fabricado.

export type StatusEnvio = 'agendado' | 'enviado' | 'erro' | 'cancelado';
type AccountPP = 'oben' | 'colacor';

export interface ItemEnvioCalendario {
  quantidade: number;
  preco_final: number | null;
  account: AccountPP | null; // null = item sem mapeamento (não derruba a agregação)
}

export interface EnvioCalendario {
  id: string;
  pedido_programado_id: string;
  numero_pedido_compra: string | null;
  data_envio: string; // 'YYYY-MM-DD' direto do banco
  status: StatusEnvio;
  erro_motivo: string | null;
  itens: ItemEnvioCalendario[];
}

interface EnvioDia extends EnvioCalendario {
  valor: number | null;
  empresas: AccountPP[];
  semItens: boolean;
}

export interface DiaAgregado {
  envios: EnvioDia[]; // todos, inclusive cancelados (painel)
  ativos: number; // status !== 'cancelado'
  totalValor: number | null; // soma dos ativos; null se algum ativo tiver valor null
  temErro: boolean;
  statusPresentes: StatusEnvio[]; // sem 'cancelado', ordem fixa p/ os dots
}

export function valorDoEnvio(itens: ItemEnvioCalendario[]): number | null {
  if (itens.length === 0) return null;
  let total = 0;
  for (const it of itens) {
    if (!(Number.isFinite(it.preco_final as number) && (it.preco_final as number) > 0)) return null;
    if (!(Number.isFinite(it.quantidade) && it.quantidade > 0)) return null;
    total += (it.preco_final as number) * it.quantidade;
  }
  return total;
}

const ORDEM_STATUS: StatusEnvio[] = ['agendado', 'enviado', 'erro'];

export function agruparEnviosPorDia(envios: EnvioCalendario[]): Map<string, DiaAgregado> {
  const porDia = new Map<string, DiaAgregado>();
  for (const envio of envios) {
    const dia: DiaAgregado = porDia.get(envio.data_envio) ?? {
      envios: [],
      ativos: 0,
      totalValor: 0,
      temErro: false,
      statusPresentes: [],
    };
    const valor = valorDoEnvio(envio.itens);
    const empresas = [...new Set(
      envio.itens.map((i) => i.account).filter((a): a is AccountPP => a !== null),
    )];
    dia.envios.push({ ...envio, valor, empresas, semItens: envio.itens.length === 0 });
    if (envio.status !== 'cancelado') {
      dia.ativos += 1;
      dia.totalValor = dia.totalValor === null || valor === null ? null : dia.totalValor + valor;
      if (envio.status === 'erro') dia.temErro = true;
    }
    porDia.set(envio.data_envio, dia);
  }
  for (const dia of porDia.values()) {
    if (dia.ativos === 0) dia.totalValor = null; // só cancelados: não existe "R$ 0 a faturar"
    dia.statusPresentes = ORDEM_STATUS.filter((s) => dia.envios.some((e) => e.status === s));
  }
  return porDia;
}

export function dataLocalISO(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export interface DiaGrade {
  data: string; // 'YYYY-MM-DD'
  diaDoMes: number;
  foraDoMes: boolean;
}

// Grade fixa de 6 semanas (42 células), domingo→sábado. Date com construtor
// NUMÉRICO é local-time (seguro); o overflow de dia rola mês/ano sozinho.
export function gerarDiasDaGrade(mes: string): DiaGrade[] {
  const [ano, m] = mes.split('-').map(Number);
  const primeiro = new Date(ano, m - 1, 1);
  const offsetDomingo = primeiro.getDay();
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(ano, m - 1, 1 - offsetDomingo + i);
    return { data: dataLocalISO(d), diaDoMes: d.getDate(), foraDoMes: d.getMonth() !== m - 1 };
  });
}
