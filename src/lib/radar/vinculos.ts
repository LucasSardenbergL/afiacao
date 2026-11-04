/**
 * "Possível vínculo / possível sucessor de cliente X" — a pista que a ficha do lead mostra quando o CNPJ novo
 * parece ser a mesma pessoa (ou o mesmo ponto) de um cliente nosso (RPC `radar_possiveis_vinculos`, migration
 * 20261104201756; viabilidade em docs/historico/radar-sucessor-viabilidade-2026-11-04.md).
 *
 * É PISTA, nunca veredito: o texto diz qual sinal casou e manda conferir. Parentesco não é fato (a Receita não
 * informa) — por isso "mesmo endereço", nunca "parente". O selo de força vem do servidor; aqui só se lê e se escreve.
 */

type SinalVinculo = 'telefone' | 'email' | 'endereco' | 'pessoa';
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

const SINAIS: readonly SinalVinculo[] = ['telefone', 'email', 'endereco', 'pessoa'];
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
};

export function evidenciaVinculo(v: VinculoCliente): string {
  return v.sinais.map((s) => TEXTO_SINAL[s]).join(' · ');
}

/** "Possível sucessor de X (baixada na Receita)" ou "Possível vínculo com X". */
export function tituloVinculo(v: VinculoCliente): string {
  const nome = v.clienteNome ?? 'um cliente da base';
  const fora = v.clienteSituacao ? FORA_DE_OPERACAO[v.clienteSituacao] : undefined;
  return fora ? `Possível sucessor de ${nome} (${fora} na Receita)` : `Possível vínculo com ${nome}`;
}

export function rotuloForca(f: ForcaVinculo): string {
  return f === 'forte' ? 'pista forte' : 'pista média';
}
