/**
 * Radar — contato provável da CONTABILIDADE do cliente (migration 20261109140000_radar_contato_contabil).
 *
 * O servidor classifica telefone1, telefone2 e e-mail um por um, em lote (cron diário), e guarda o MOTIVO. A correção do
 * vendedor ("é / não é da contabilidade") vai para um ledger e prevalece sobre o automático. A RPC
 * `radar_contato_contabil_da_empresa` devolve, por contato ATUAL da empresa, o automático, o veredito e o EFETIVO, mais
 * `visitar` (todo contato utilizável marcado + endereço) — a mesma regra da fila, do card e do e-mail.
 *
 * Leitor estrito: resposta fora da forma LANÇA (a ficha diz "não consegui verificar"), nunca vira "contato direto".
 * `efetivo === null` = ainda não calculado: a ficha não afirma nada (ausente ≠ zero).
 */

export type CampoContato = 'telefone1' | 'telefone2' | 'email';
export type MotivoContabil =
  | 'telefone_compartilhado'
  | 'email_compartilhado'
  | 'email_palavra'
  | 'email_palavra_fraca'
  | 'dominio_servico';

export interface ContatoContabil {
  campo: CampoContato;
  tipo: 'telefone' | 'email';
  /** O que o sinal automático diz: true/false; null = nunca calculado. */
  automatico: boolean | null;
  motivos: MotivoContabil[];
  /** Em quantas empresas sem vínculo detectado o contato aparece (só nos motivos de compartilhamento). */
  grupos: number | null;
  corroborado: boolean | null;
  /** A última correção (a versão que a RPC de correção exige); null = nenhuma. */
  correcaoId: number | null;
  /** O veredito do vendedor: true = é da contabilidade, false = não é, null = sem correção (vale o automático). */
  veredito: boolean | null;
  /** O que vale: o veredito, senão o automático. null = não sei. */
  efetivo: boolean | null;
}

export interface LeituraContatoContabil {
  contatos: Map<CampoContato, ContatoContabil>;
  /** Todo contato utilizável com indício de contabilidade e endereço presente: prefira a visita. */
  visitar: boolean;
  /** Quando o sinal foi calculado pela última vez (null = nunca). */
  calculadoEm: string | null;
}

export const SELO_CONTABIL = 'Contato provável da contabilidade — prefira visita';

const CAMPOS: readonly CampoContato[] = ['telefone1', 'telefone2', 'email'];
const MOTIVOS: readonly MotivoContabil[] = [
  'telefone_compartilhado', 'email_compartilhado', 'email_palavra', 'email_palavra_fraca', 'dominio_servico',
];

const ehObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const boolOuNull = (v: unknown): boolean | null | undefined => (v === null ? null : typeof v === 'boolean' ? v : undefined);
const intOuNull = (v: unknown): number | null | undefined =>
  v === null ? null : typeof v === 'number' && Number.isInteger(v) ? v : undefined;

function falha(oque: string): never {
  throw new Error(`radar_contato_contabil_da_empresa: resposta fora da forma esperada (${oque})`);
}

export function lerContatoContabil(data: unknown): LeituraContatoContabil {
  if (!Array.isArray(data)) falha('lista');
  const contatos = new Map<CampoContato, ContatoContabil>();
  let visitar = false;
  let calculadoEm: string | null = null;
  data.forEach((l: unknown, i) => {
    if (!ehObj(l)) falha(`[${i}]`);
    const campo = l.campo as CampoContato;
    if (!CAMPOS.includes(campo)) falha(`[${i}].campo`);
    const tipo = l.tipo;
    if (tipo !== 'telefone' && tipo !== 'email') falha(`[${i}].tipo`);
    const automatico = boolOuNull(l.automatico);
    const veredito = boolOuNull(l.veredito);
    const efetivo = boolOuNull(l.efetivo);
    const corroborado = boolOuNull(l.corroborado);
    const grupos = intOuNull(l.grupos);
    const correcaoId = intOuNull(l.correcao_id);
    if (automatico === undefined || veredito === undefined || efetivo === undefined || corroborado === undefined
        || grupos === undefined || correcaoId === undefined || typeof l.visitar !== 'boolean') {
      falha(`[${i}]`);
    }
    const motivosBrutos = l.motivos === null ? [] : l.motivos;
    if (!Array.isArray(motivosBrutos)) falha(`[${i}].motivos`);
    // Motivo desconhecido (regra nova no servidor antes do front) não derruba a ficha: só não ganha frase própria.
    const motivos = motivosBrutos.filter((m): m is MotivoContabil => MOTIVOS.includes(m as MotivoContabil));
    visitar = l.visitar;
    if (typeof l.calculado_em === 'string') calculadoEm = l.calculado_em;
    contatos.set(campo, { campo, tipo, automatico, motivos, grupos, corroborado, correcaoId, veredito, efetivo });
  });
  return { contatos, visitar, calculadoEm };
}

/** O porquê do selo, em frases curtas (o vendedor decide se confia). */
export function textoMotivo(c: Pick<ContatoContabil, 'tipo' | 'motivos' | 'grupos' | 'corroborado' | 'veredito'>): string {
  if (c.veredito === true) return 'Um vendedor marcou este contato como da contabilidade.';
  const frases: string[] = [];
  const oque = c.tipo === 'telefone' ? 'Este telefone' : 'Este e-mail';
  for (const m of c.motivos) {
    switch (m) {
      case 'telefone_compartilhado':
      case 'email_compartilhado':
        frases.push(c.grupos != null
          ? `${oque} aparece em ${c.grupos} empresas sem vínculo entre si${m === 'telefone_compartilhado' && c.corroborado && c.grupos === 3 ? ', e uma delas tem e-mail de contabilidade' : ''}.`
          : `${oque} aparece em várias empresas sem vínculo entre si.`);
        break;
      case 'email_palavra': frases.push('O e-mail tem "contab" ou "contador".'); break;
      case 'email_palavra_fraca': frases.push('O e-mail tem "escritório" ou "assessoria".'); break;
      case 'dominio_servico': frases.push('O domínio do e-mail é de um serviço de MEI ou de contabilidade.'); break;
    }
  }
  return frases.length > 0 ? frases.join(' ') : 'Indício de contato da contabilidade.';
}

/** Algum TELEFONE com indício no efetivo: o endereço ganha destaque mesmo que ainda haja outro contato. */
export function algumTelefoneContabil(l: LeituraContatoContabil | null | undefined): boolean {
  if (!l) return false;
  return [...l.contatos.values()].some((c) => c.tipo === 'telefone' && c.efetivo === true);
}

/** O contato do campo, se ele for da contabilidade no efetivo. */
export function contabilDoCampo(l: LeituraContatoContabil | null | undefined, campo: CampoContato): ContatoContabil | null {
  const c = l?.contatos.get(campo);
  return c && c.efetivo === true ? c : null;
}
