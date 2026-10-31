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

/** Versão da FILA paginada: no preset 'score' é a rodada do score (id do ledger); nos outros, null (a ordem
 *  não depende do score). Entra na queryKey: rodada nova ⇒ chave nova ⇒ paginação recomeça da página 0 —
 *  offset sobre um ranking que mudou entre páginas pula ou repete lead (Codex MÉDIO 4 no #3214). */
export function versaoDaFila(preset: PresetRadar, rodadaScore: string | null | undefined): string | null {
  if (preset !== 'score') return null;
  return rodadaScore ?? 'sem-rodada';
}

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

// ── Selo de FILIAL: outros estabelecimentos da mesma raiz de CNPJ (radar_irmaos_por_raiz) ──────────
export interface IrmaosRaiz {
  irmaos_na_fila: number;       // outros leads da mesma raiz (não-cliente, não-descartado)
  irmaos_clientes: number;      // clientes da mesma raiz (profiles · Omie · radar.ja_cliente), sem o próprio
  cliente_nome: string | null;  // um nome de cliente da raiz
}
export interface SeloFilial { texto: string; tom: TomStatus; titulo: string; chave: 'cliente' | 'fila' }
export type EstadoIrmaos = 'carregando' | 'falhou' | 'ok';

const plural = (n: number, s: string, p: string) => (n === 1 ? s : p);

/** Selos da linha. Sem dado (carregando/falhou) não há selo: a FICHA é quem diz "não consegui verificar".
 *  Só SINALIZA — não esconde lead nem mexe em score/ordem (decisão do founder, 2026-10-21). */
export function selosFilial(i: IrmaosRaiz | null | undefined): SeloFilial[] {
  if (!i) return [];
  const selos: SeloFilial[] = [];
  if (i.irmaos_clientes > 0) {
    selos.push({
      chave: 'cliente', texto: 'filial de cliente', tom: 'warning',
      titulo: `Mesma raiz de CNPJ de ${i.irmaos_clientes} ${plural(i.irmaos_clientes, 'cliente', 'clientes')}`
        + (i.cliente_nome ? `: ${i.cliente_nome}` : ''),
    });
  }
  if (i.irmaos_na_fila > 0) {
    selos.push({
      chave: 'fila', texto: `+${i.irmaos_na_fila} da mesma empresa`, tom: 'neutro',
      titulo: `${i.irmaos_na_fila} ${plural(i.irmaos_na_fila, 'outro estabelecimento', 'outros estabelecimentos')} desta empresa na fila`,
    });
  }
  return selos;
}

/** Texto da ficha — distingue "não tem" de "não consegui ler" (ausente ≠ zero). */
export function textoFilialFicha(estado: EstadoIrmaos, i: IrmaosRaiz | null | undefined): string {
  if (estado === 'carregando') return 'verificando…';
  if (estado === 'falhou' || !i) return 'não consegui verificar';
  const selos = selosFilial(i);
  if (selos.length === 0) return 'nenhum outro estabelecimento na fila nem cliente com a mesma raiz';
  return selos.map((s) => s.titulo).join(' · ');
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

// ── Situação cadastral RFB (selo na linha e na ficha) ─────────────────────────────────────────────
// Códigos da Receita: 01 nula · 02 ativa · 03 suspensa · 04 inapta · 08 baixada. Só as irregulares viram
// selo; 02/01 ou ausência (ausente ≠ ativa: a empresa pode não ter entrado no lote) não mostram nada.
const SELO_RFB: Record<string, { rotulo: string; tom: TomStatus }> = {
  '03': { rotulo: 'Suspenso', tom: 'warning' },
  '04': { rotulo: 'Inapto',   tom: 'warning' },
  '08': { rotulo: 'Baixado',  tom: 'muted' },
};
export interface SeloRfb { texto: string; tom: TomStatus; titulo: string }
/** Selo "Baixado/Inapto/Suspenso pela RFB em dd/mm/aaaa", ou null quando não há irregularidade. */
export function seloRfb(e: { rfb_situacao: string | null; rfb_situacao_data: string | null; rfb_situacao_lote: string | null }): SeloRfb | null {
  const s = e.rfb_situacao ? SELO_RFB[e.rfb_situacao] : undefined;
  if (!s) return null;
  const data = e.rfb_situacao_data ? formatarDataIso(e.rfb_situacao_data) : null;
  return {
    texto: `${s.rotulo} pela RFB${data ? ` em ${data}` : ''}`,
    tom: s.tom,
    titulo: `Situação cadastral na Receita Federal (dump ${e.rfb_situacao_lote ?? '?'}): ${s.rotulo.toLowerCase()}${data ? ` desde ${data}` : ''}. Confira o cartão CNPJ antes de agir.`,
  };
}
/** YYYY-MM-DD → dd/mm/aaaa sem passar por Date (fuso não entra). */
export function formatarDataIso(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

// ── Lista: rótulos dos modos, região de atuação e catálogo de CNAEs-alvo ───────────────────────────
/** Rótulo HONESTO de cada modo: diz a ordem que a fila tem, não promete o que o modo não mede.
 *  'novas' só ordena por data de abertura (não filtra "do lote"); 'score' é o score, não "o melhor". */
export const ROTULO_PRESET: Record<PresetRadar, string> = {
  score: 'Maior score',
  novas: 'Abertura mais recente',
  estabelecidas: 'Estabelecidas',
};

/** Região de atuação = MG e as UFs que fazem divisa com ela. Medido em prod (psql-ro, 2026-10-29): dos
 *  3.013 leads `ja_cliente` do Radar, 3.003 são de MG (99,7%) e os outros 10 se espalham em 8 UFs, 3
 *  delas vizinhas. A carteira é MG; os vizinhos são onde a rota alcança. Brasil fica a 1 clique. */
export const UFS_ATUACAO = ['MG', 'SP', 'RJ', 'ES', 'BA', 'GO', 'DF', 'MS'] as const;
export type RegiaoRadar = 'atuacao' | 'brasil';

/** Recorte de UF da fila: a UF escolhida vence a região; sem UF, a região decide. */
export function recorteDeUf(f: { uf: string; regiao?: RegiaoRadar }):
  | { tipo: 'uf'; uf: string }
  | { tipo: 'lista'; ufs: readonly string[] }
  | { tipo: 'todas' } {
  if (f.uf) return { tipo: 'uf', uf: f.uf };
  if (f.regiao === 'atuacao') return { tipo: 'lista', ufs: UFS_ATUACAO };
  return { tipo: 'todas' };
}

export interface CnaeAlvo { codigo: string; nome: string; grupo: string }
/** Cópia estática de `scripts/radar/cnaes-alvo.txt` (a curadoria que a carga usa). O teste de
 *  `ui-helpers` compara as duas listas: editar o .txt sem editar aqui fica vermelho no CI. */
export const CNAES_ALVO: readonly CnaeAlvo[] = [
  { codigo: '3101200', nome: 'Fabricação de móveis com predominância de madeira', grupo: 'Moveleiro' },
  { codigo: '3102100', nome: 'Fabricação de móveis com predominância de metal', grupo: 'Moveleiro' },
  { codigo: '3103900', nome: 'Fabricação de móveis de outros materiais (exceto madeira e metal)', grupo: 'Moveleiro' },
  { codigo: '1621800', nome: 'Fabricação de madeira laminada e chapas (compensado/aglomerado/MDF)', grupo: 'Moveleiro' },
  { codigo: '1622601', nome: 'Fabricação de casas de madeira pré-fabricadas', grupo: 'Moveleiro' },
  { codigo: '1622602', nome: 'Fabricação de esquadrias de madeira p/ instalações industriais e comerciais', grupo: 'Moveleiro' },
  { codigo: '1622699', nome: 'Fabricação de outros artigos de carpintaria para construção', grupo: 'Moveleiro' },
  { codigo: '1623400', nome: 'Fabricação de artefatos de tanoaria e embalagens de madeira', grupo: 'Moveleiro' },
  { codigo: '1629301', nome: 'Fabricação de artefatos diversos de madeira (exceto móveis)', grupo: 'Moveleiro' },
  { codigo: '9529105', nome: 'Reparação de artigos do mobiliário (restauradores/estofadores)', grupo: 'Moveleiro' },
  { codigo: '1610203', nome: 'Serrarias com desdobramento de madeira em bruto', grupo: 'Madeira bruta' },
  { codigo: '1610204', nome: 'Serrarias sem desdobramento (resserragem)', grupo: 'Madeira bruta' },
  { codigo: '1610205', nome: 'Serviço de tratamento de madeira sob contrato', grupo: 'Madeira bruta' },
  { codigo: '2542000', nome: 'Fabricação de artigos de serralheria (exceto esquadrias)', grupo: 'Metal' },
  { codigo: '2512800', nome: 'Fabricação de esquadrias de metal', grupo: 'Metal' },
  { codigo: '2511000', nome: 'Fabricação de estruturas metálicas', grupo: 'Metal' },
  { codigo: '2539001', nome: 'Serviços de usinagem, tornearia e solda', grupo: 'Metal' },
  { codigo: '2539002', nome: 'Serviços de tratamento e revestimento em metais (polimento)', grupo: 'Metal' },
  { codigo: '2391503', nome: 'Aparelhamento de placas e trabalhos em mármore/granito (marmorarias)', grupo: 'Pedra e vidro' },
  { codigo: '2319200', nome: 'Fabricação de artigos de vidro', grupo: 'Pedra e vidro' },
  { codigo: '4743100', nome: 'Comércio varejista de vidros (vidraçarias — corte/lapidação)', grupo: 'Pedra e vidro' },
];

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** CNAEs-alvo cujo NOME contém todas as palavras digitadas (sem acento/caixa), ou cujo código começa
 *  pelos dígitos digitados. Termo vazio = catálogo inteiro. */
export function buscarCnaesAlvo(termo: string): CnaeAlvo[] {
  const t = semAcento(termo.trim());
  if (!t) return [...CNAES_ALVO];
  const dig = t.replace(/\D/g, '');
  const soCodigo = /^[\d\s./-]+$/.test(t);
  if (soCodigo) return CNAES_ALVO.filter((c) => dig.length > 0 && c.codigo.startsWith(dig));
  const palavras = t.split(/\s+/);
  return CNAES_ALVO.filter((c) => {
    const alvo = semAcento(`${c.nome} ${c.grupo}`);
    return palavras.every((p) => alvo.includes(p));
  });
}

/** Nome da atividade de um CNAE do catálogo (pelo código em qualquer formato), ou null. */
export function nomeCnaeAlvo(cnae: string): string | null {
  const d = digitosCnae(cnae);
  return CNAES_ALVO.find((c) => c.codigo === d)?.nome ?? null;
}
