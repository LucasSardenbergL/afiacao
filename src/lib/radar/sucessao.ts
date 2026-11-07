/**
 * Sucessão/cisão DECLARADA (migration 20261107013000): o gestor/master afirma que o CNPJ novo sucede (a antiga
 * morreu) ou cinde de (a antiga segue) um cliente nosso, a partir de uma data de corte COMERCIAL.
 *
 * É FATO humano, separado das pistas automáticas (`vinculos.ts`, que seguem "pista, nunca veredito"). O selo não
 * marca o lead como já-cliente e continua visível depois do cadastro no Omie. A herança do histórico (entrega 3)
 * só vale quando a declaração está `ativa`: o novo cadastrado, os dois CNPJs inequívocos e o corte já alcançado.
 *
 * Aqui só se LÊ a forma crua das RPCs e se escreve texto. Forma inesperada LANÇA: ausente ≠ "sem sucessão".
 */

export type TipoSucessao = 'cisao' | 'sucessao';
export type EstadoSucessao = 'declarada' | 'ativa' | 'revogada';
export type ImpedimentoSucessao =
  | 'antigo_nao_e_cliente' | 'antigo_ambiguo' | 'novo_ambiguo' | 'novo_sem_cadastro' | 'mesmo_comprador' | 'corte_futuro';

export interface SucessaoDeclarada {
  id: string;
  eventoId: string;
  /** O papel do documento consultado nesta declaração. */
  papel: 'novo' | 'antigo';
  antigoDocumento: string;
  antigoNome: string | null;
  novoDocumento: string;
  novoNome: string | null;
  tipo: TipoSucessao;
  dataCorte: string;
  dataCorteSugerida: string | null;
  observacao: string | null;
  declaradoPorNome: string | null;
  declaradoEm: string;
  revogadoEm: string | null;
  revogadoPorNome: string | null;
  revogadoMotivo: string | null;
  estado: EstadoSucessao;
  impedimento: ImpedimentoSucessao | null;
}

export interface SucessoesDoDocumento {
  /** Versão otimista do grafo: vai de volta ao declarar/revogar (o servidor recusa se alguém gravou antes). */
  versao: number;
  sucessoes: SucessaoDeclarada[];
}

const TIPOS: readonly TipoSucessao[] = ['cisao', 'sucessao'];
const ESTADOS: readonly EstadoSucessao[] = ['declarada', 'ativa', 'revogada'];
const IMPEDIMENTOS: readonly ImpedimentoSucessao[] = [
  'antigo_nao_e_cliente', 'antigo_ambiguo', 'novo_ambiguo', 'novo_sem_cadastro', 'mesmo_comprador', 'corte_futuro',
];

const ehTexto = (v: unknown): v is string => typeof v === 'string';
const textoOuNulo = (v: unknown): v is string | null => v === null || typeof v === 'string';

function lerSucessao(l: unknown, rpc: string): SucessaoDeclarada {
  const r = l as Record<string, unknown> | null;
  if (
    !r || !ehTexto(r.id) || !ehTexto(r.evento_id) || (r.papel !== 'novo' && r.papel !== 'antigo') ||
    !ehTexto(r.antigo_documento) || !textoOuNulo(r.antigo_nome) ||
    !ehTexto(r.novo_documento) || !textoOuNulo(r.novo_nome) ||
    !TIPOS.includes(r.tipo as TipoSucessao) || !ehTexto(r.data_corte) || !textoOuNulo(r.data_corte_sugerida) ||
    !textoOuNulo(r.observacao) || !textoOuNulo(r.declarado_por_nome) || !ehTexto(r.declarado_em) ||
    !textoOuNulo(r.revogado_em) || !textoOuNulo(r.revogado_por_nome) || !textoOuNulo(r.revogado_motivo) ||
    !ESTADOS.includes(r.estado as EstadoSucessao) ||
    (r.impedimento !== null && !IMPEDIMENTOS.includes(r.impedimento as ImpedimentoSucessao))
  ) {
    throw new Error(`${rpc}: declaração fora da forma esperada`);
  }
  return {
    id: r.id, eventoId: r.evento_id, papel: r.papel,
    antigoDocumento: r.antigo_documento, antigoNome: r.antigo_nome,
    novoDocumento: r.novo_documento, novoNome: r.novo_nome,
    tipo: r.tipo as TipoSucessao, dataCorte: r.data_corte, dataCorteSugerida: r.data_corte_sugerida,
    observacao: r.observacao, declaradoPorNome: r.declarado_por_nome, declaradoEm: r.declarado_em,
    revogadoEm: r.revogado_em, revogadoPorNome: r.revogado_por_nome, revogadoMotivo: r.revogado_motivo,
    estado: r.estado as EstadoSucessao, impedimento: (r.impedimento as ImpedimentoSucessao | null) ?? null,
  };
}

export function lerSucessoesDoDocumento(data: unknown): SucessoesDoDocumento {
  const rpc = 'cliente_sucessoes_do_documento';
  const r = data as Record<string, unknown> | null;
  if (!r || typeof r.versao !== 'number' || !Number.isInteger(r.versao) || !Array.isArray(r.sucessoes)) {
    throw new Error(`${rpc}: resposta fora da forma esperada`);
  }
  return { versao: r.versao, sucessoes: r.sucessoes.map((s) => lerSucessao(s, rpc)) };
}

export type ResultadoEscritaSucessao =
  | { ok: true; versao: number; antigoNome: string | null; novoCadastrado: boolean | null }
  | { ok: false; motivo: string; tipo: TipoSucessao | null; dataCorte: string | null };

/** Resultado de declarar/revogar. Recusa de domínio vem como `ok:false` com motivo; erro de verdade LANÇA. */
export function lerResultadoEscritaSucessao(data: unknown, rpc: string): ResultadoEscritaSucessao {
  const r = data as Record<string, unknown> | null;
  if (!r || typeof r.ok !== 'boolean') throw new Error(`${rpc}: resposta fora da forma esperada`);
  if (r.ok) {
    if (typeof r.versao !== 'number') throw new Error(`${rpc}: resposta sem a versão nova`);
    return {
      ok: true, versao: r.versao,
      antigoNome: ehTexto(r.antigo_nome) ? r.antigo_nome : null,
      novoCadastrado: typeof r.novo_cadastrado === 'boolean' ? r.novo_cadastrado : null,
    };
  }
  if (!ehTexto(r.motivo)) throw new Error(`${rpc}: recusa sem motivo`);
  return {
    ok: false, motivo: r.motivo,
    tipo: TIPOS.includes(r.tipo as TipoSucessao) ? (r.tipo as TipoSucessao) : null,
    dataCorte: ehTexto(r.data_corte) ? r.data_corte : null,
  };
}

/** dd/mm/aaaa de uma data ISO (só a parte do dia; sem fuso — é data civil). */
export function dataBr(iso: string | null): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

export const ROTULO_TIPO: Record<TipoSucessao, string> = { cisao: 'Cisão', sucessao: 'Sucessão' };

/** "Cisão confirmada de DIVIMOVEIS" (papel novo) / "Cindiu para MARQUES" (papel antigo). */
export function tituloSucessao(s: Pick<SucessaoDeclarada, 'papel' | 'tipo' | 'antigoNome' | 'novoNome' | 'estado'>): string {
  const antigo = s.antigoNome ?? 'um cliente da base';
  const novo = s.novoNome ?? 'um CNPJ novo';
  const revogada = s.estado === 'revogada' ? ' (revogada)' : '';
  if (s.papel === 'novo') return `${ROTULO_TIPO[s.tipo]} confirmada de ${antigo}${revogada}`;
  return `${s.tipo === 'cisao' ? 'Cindiu para' : 'Sucedido por'} ${novo}${revogada}`;
}

const TEXTO_IMPEDIMENTO: Record<ImpedimentoSucessao, string> = {
  novo_sem_cadastro: 'O histórico só passa a valer depois do cadastro no Omie',
  corte_futuro: 'A data de corte ainda não chegou',
  antigo_nao_e_cliente: 'O CNPJ antigo não está mais no cadastro de clientes',
  antigo_ambiguo: 'O CNPJ antigo aponta para mais de um cliente: confira o cadastro',
  novo_ambiguo: 'O CNPJ novo aponta para mais de um cliente: confira o cadastro',
  mesmo_comprador: 'Os dois CNPJs são o mesmo cliente no cadastro',
};

/** O estado em uma linha: ativa / o impedimento concreto / revogada. */
export function textoEstadoSucessao(s: Pick<SucessaoDeclarada, 'estado' | 'impedimento' | 'dataCorte'>): string {
  if (s.estado === 'revogada') return 'Revogada';
  if (s.estado === 'ativa') return `Vale a partir de ${dataBr(s.dataCorte)}`;
  return s.impedimento ? TEXTO_IMPEDIMENTO[s.impedimento] : 'Declarada';
}

const TEXTO_RECUSA: Record<string, string> = {
  versao_mudou: 'Outra pessoa alterou as sucessões agora há pouco. Recarreguei: confira e tente de novo.',
  mesmo_documento: 'O CNPJ antigo e o novo são o mesmo.',
  antigo_nao_e_cliente: 'O CNPJ antigo não é cliente no nosso cadastro.',
  antigo_ambiguo: 'O CNPJ antigo aponta para mais de um cliente no cadastro: resolva o cadastro antes.',
  novo_ambiguo: 'O CNPJ novo aponta para mais de um cliente no cadastro: resolva o cadastro antes.',
  mesmo_comprador: 'Os dois CNPJs já são o mesmo cliente no cadastro.',
  ja_declarada: 'Essa sucessão já está declarada.',
  cadeia: 'Não dá para encadear sucessões (A→B→C): um dos CNPJs já está em outra sucessão ativa.',
  ja_revogada: 'Essa declaração já tinha sido revogada.',
};

export function mensagemRecusaSucessao(r: Extract<ResultadoEscritaSucessao, { ok: false }>): string {
  if (r.motivo === 'evento_divergente') {
    return `Esse cliente antigo já tem uma ${r.tipo ? ROTULO_TIPO[r.tipo].toLowerCase() : 'sucessão'} declarada `
      + `com corte em ${dataBr(r.dataCorte)}. A nova empresa entra no mesmo evento: use o mesmo tipo e a mesma data.`;
  }
  return TEXTO_RECUSA[r.motivo] ?? `Não foi possível gravar (${r.motivo}).`;
}

// ── Prévia do corte ───────────────────────────────────────────────────────────────────────────────────────────

export interface PreviaLado {
  documento: string;
  nome: string | null;
  cadastrado: boolean;
  candidatos: number;
  /** null = sem cadastro (não há histórico para contar) — nunca 0 fabricado. */
  pedidosAntes: number | null;
  pedidosAPartir: number | null;
  primeiroPedido: string | null;
  ultimoPedido: string | null;
  datasEstimadas: number | null;
  recentes: { dia: string; empresa: string; estimada: boolean; antesDoCorte: boolean }[];
}

export interface PreviaSucessao {
  dataCorte: string;
  aberturaNovo: string | null;
  antigo: PreviaLado;
  novo: PreviaLado;
}

const numOuNulo = (v: unknown): v is number | null => v === null || typeof v === 'number';

function lerLado(l: unknown): PreviaLado {
  const r = l as Record<string, unknown> | null;
  if (
    !r || !ehTexto(r.documento) || !textoOuNulo(r.nome) || typeof r.cadastrado !== 'boolean' ||
    typeof r.candidatos !== 'number' || !numOuNulo(r.pedidos_antes) || !numOuNulo(r.pedidos_a_partir) ||
    !textoOuNulo(r.primeiro_pedido) || !textoOuNulo(r.ultimo_pedido) || !numOuNulo(r.datas_estimadas) ||
    !Array.isArray(r.recentes)
  ) {
    throw new Error('cliente_sucessao_previa: lado fora da forma esperada');
  }
  return {
    documento: r.documento, nome: r.nome, cadastrado: r.cadastrado, candidatos: r.candidatos,
    pedidosAntes: r.pedidos_antes, pedidosAPartir: r.pedidos_a_partir,
    primeiroPedido: r.primeiro_pedido, ultimoPedido: r.ultimo_pedido, datasEstimadas: r.datas_estimadas,
    recentes: r.recentes.map((x) => {
      const p = x as Record<string, unknown> | null;
      if (!p || !ehTexto(p.dia) || !ehTexto(p.empresa) || typeof p.estimada !== 'boolean' || typeof p.antes_do_corte !== 'boolean') {
        throw new Error('cliente_sucessao_previa: pedido fora da forma esperada');
      }
      return { dia: p.dia, empresa: p.empresa, estimada: p.estimada, antesDoCorte: p.antes_do_corte };
    }),
  };
}

export function lerPreviaSucessao(data: unknown): PreviaSucessao {
  const r = data as Record<string, unknown> | null;
  if (!r || !ehTexto(r.data_corte) || !textoOuNulo(r.abertura_novo)) {
    throw new Error('cliente_sucessao_previa: resposta fora da forma esperada');
  }
  return { dataCorte: r.data_corte, aberturaNovo: r.abertura_novo, antigo: lerLado(r.antigo), novo: lerLado(r.novo) };
}

/** "12 pedidos antes do corte · 3 a partir dele (1 com data estimada)" / "sem cadastro". */
export function resumoLado(l: PreviaLado): string {
  if (!l.cadastrado || l.pedidosAntes === null || l.pedidosAPartir === null) {
    return l.candidatos > 1 ? 'aponta para mais de um cliente no cadastro' : 'ainda sem cadastro de cliente';
  }
  const est = l.datasEstimadas ? ` (${l.datasEstimadas} com data estimada)` : '';
  return `${l.pedidosAntes} pedido(s) antes do corte · ${l.pedidosAPartir} a partir dele${est}`;
}

/** Só dígitos/letras, maiúsculo — o mesmo que o banco faz antes de validar o CNPJ. */
export function normalizarDocumento(v: string): string {
  return v.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function documentoCompleto(v: string): boolean {
  return /^[0-9A-Z]{12}[0-9]{2}$/.test(normalizarDocumento(v));
}
