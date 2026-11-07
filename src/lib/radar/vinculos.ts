/**
 * "Possível vínculo / possível sucessor de cliente X" — a pista que a ficha do lead mostra quando o CNPJ novo
 * parece ser a mesma pessoa (ou o mesmo ponto) de um cliente nosso (RPC `radar_possiveis_vinculos`, migration
 * 20261104201756; viabilidade em docs/historico/radar-sucessor-viabilidade-2026-11-04.md).
 *
 * É PISTA, nunca veredito: o texto diz qual sinal casou e manda conferir. Parentesco não é fato (a Receita não
 * informa) — por isso "mesmo endereço", nunca "parente". O selo de força vem do servidor; aqui só se lê e se escreve.
 */

type SinalVinculo = 'telefone' | 'email' | 'endereco' | 'pessoa' | 'socio_cpf';
export type ForcaVinculo = 'forte' | 'media';

export interface VinculoCliente {
  clienteCnpj: string;
  /** null = cliente só no cadastro (fora do Radar) para quem não lê a carteira — a RPC não devolve esse caso, mas a borda tolera. */
  clienteNome: string | null;
  /** Situação cadastral RFB do cliente ('02' ativa, '04' inapta, '08' baixada…); null = não sabemos. */
  clienteSituacao: string | null;
  forca: ForcaVinculo;
  sinais: SinalVinculo[];
}

const SINAIS: readonly SinalVinculo[] = ['telefone', 'email', 'endereco', 'pessoa', 'socio_cpf'];
const FORCAS: readonly ForcaVinculo[] = ['forte', 'media'];

/** Valida a linha crua da RPC. Forma inesperada LANÇA: ausente ≠ "sem vínculo" (a ficha diz que não conseguiu verificar). */
export function lerVinculo(l: unknown): VinculoCliente {
  const r = l as Record<string, unknown> | null;
  const sinais = r?.sinais;
  if (
    !r ||
    typeof r.cliente_cnpj !== 'string' ||
    (r.cliente_nome !== null && typeof r.cliente_nome !== 'string') ||
    (r.cliente_situacao !== null && typeof r.cliente_situacao !== 'string') ||
    !FORCAS.includes(r.forca as ForcaVinculo) ||
    !Array.isArray(sinais) || sinais.length === 0 ||
    !sinais.every((s) => SINAIS.includes(s as SinalVinculo))
  ) {
    throw new Error('radar_possiveis_vinculos: resposta fora da forma esperada');
  }
  return {
    clienteCnpj: r.cliente_cnpj,
    clienteNome: (r.cliente_nome as string | null) ?? null,
    clienteSituacao: (r.cliente_situacao as string | null) ?? null,
    forca: r.forca as ForcaVinculo,
    sinais: sinais as SinalVinculo[],
  };
}

/** Situações RFB em que o cliente deixou de operar: o lead novo, então, provavelmente o SUCEDE. */
const FORA_DE_OPERACAO: Record<string, string> = { '01': 'nula', '03': 'suspensa', '04': 'inapta', '08': 'baixada' };

const TEXTO_SINAL: Record<SinalVinculo, string> = {
  telefone: 'mesmo telefone',
  email: 'mesmo e-mail',
  endereco: 'mesmo endereço completo',
  pessoa: 'mesmo sócio ou titular, no mesmo município',
  // Nome + CPF parcial (o que a Receita publica) iguais: a MESMA pessoa provável, nunca parente nem sucessão de fato.
  socio_cpf: 'mesmo sócio (CPF parcial igual)',
};

export function evidenciaVinculo(v: VinculoCliente): string {
  return v.sinais.map((s) => TEXTO_SINAL[s]).join(' · ');
}

/** "Possível sucessor de X (baixada na Receita)" ou "Possível vínculo com X". */
export function tituloVinculo(v: Pick<VinculoCliente, 'clienteNome' | 'clienteSituacao'>): string {
  const nome = v.clienteNome ?? 'um cliente da base';
  const fora = v.clienteSituacao ? FORA_DE_OPERACAO[v.clienteSituacao] : undefined;
  return fora ? `Possível sucessor de ${nome} (${fora} na Receita)` : `Possível vínculo com ${nome}`;
}

export function rotuloForca(f: ForcaVinculo): string {
  return f === 'forte' ? 'pista forte' : 'pista média';
}

// ── Selo na LISTA (RPC em lote `radar_vinculos_por_cnpjs`, migration 20261106083754) ─────────────────────────────
// O servidor devolve, por lead COM vínculo, o resumo do que a ficha mostraria (mesmo núcleo de regras): a força do
// 1º vínculo (o mais forte), quantos, e nomes/situações na ordem da ficha. "Sucessor" é decidido AQUI, com o mesmo
// mapa FORA_DE_OPERACAO da ficha — uma regra, um lugar.

export interface ResumoVinculoLista {
  forca: ForcaVinculo;
  clientes: number;
  nomes: (string | null)[];
  situacoes: (string | null)[];
}

const textoOuNulo = (x: unknown) => x === null || typeof x === 'string';

/** Valida a linha crua da RPC em lote. Forma inesperada LANÇA: a página vira "não consegui verificar", nunca "sem vínculo". */
export function lerResumoVinculo(l: unknown): { cnpj: string; resumo: ResumoVinculoLista } {
  const r = l as Record<string, unknown> | null;
  const nomes = r?.clientes_nomes;
  const situacoes = r?.clientes_situacoes;
  if (
    !r ||
    typeof r.cnpj !== 'string' ||
    !FORCAS.includes(r.forca as ForcaVinculo) ||
    typeof r.clientes !== 'number' || !Number.isInteger(r.clientes) || r.clientes < 1 ||
    !Array.isArray(nomes) || nomes.length !== r.clientes || !nomes.every(textoOuNulo) ||
    !Array.isArray(situacoes) || situacoes.length !== r.clientes || !situacoes.every(textoOuNulo)
  ) {
    throw new Error('radar_vinculos_por_cnpjs: resposta fora da forma esperada');
  }
  return {
    cnpj: r.cnpj,
    resumo: {
      forca: r.forca as ForcaVinculo,
      clientes: r.clientes,
      nomes: nomes as (string | null)[],
      situacoes: situacoes as (string | null)[],
    },
  };
}

export type EstadoVinculos = 'carregando' | 'falhou' | 'ok';
export interface SeloVinculo {
  chave: 'sucessor' | 'vinculo' | 'nao-verificado';
  texto: string;
  tom: 'warning' | 'info' | 'muted';
  titulo: string;
}

/**
 * Chip da linha. Pista, nunca veredito: o detalhe (a evidência) fica na ficha.
 *   ok + vínculo  → "possível sucessor" (algum cliente do vínculo está fora de operação na Receita) ou "possível vínculo"
 *   ok sem linha  → nenhum chip (a RPC respondeu e não há vínculo)
 *   falhou        → "vínculo?" (não consegui verificar — ausente ≠ "cliente novo")
 *   carregando    → nenhum chip ainda
 */
export function seloVinculo(estado: EstadoVinculos, r: ResumoVinculoLista | null | undefined): SeloVinculo | null {
  if (estado === 'falhou') {
    return {
      chave: 'nao-verificado', texto: 'vínculo?', tom: 'muted',
      titulo: 'Não consegui verificar se este CNPJ tem vínculo com um cliente. Abra a ficha para tentar de novo.',
    };
  }
  if (estado !== 'ok' || !r) return null;
  const iSucessor = r.situacoes.findIndex((s) => s != null && Object.prototype.hasOwnProperty.call(FORA_DE_OPERACAO, s));
  const i = iSucessor >= 0 ? iSucessor : 0;
  const outros = r.clientes - 1;
  return {
    chave: iSucessor >= 0 ? 'sucessor' : 'vinculo',
    texto: iSucessor >= 0 ? 'possível sucessor' : 'possível vínculo',
    tom: r.forca === 'forte' ? 'warning' : 'info',
    titulo: tituloVinculo({ clienteNome: r.nomes[i] ?? null, clienteSituacao: r.situacoes[i] ?? null })
      + (outros > 0 ? ` (+${outros} ${outros === 1 ? 'outro cliente' : 'outros clientes'})` : '')
      + ` · ${r.forca === 'forte' ? 'há pista forte' : 'pista média'}. Veja a evidência na ficha e confira antes de tratar como cliente novo.`,
  };
}
