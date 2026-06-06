// Tri-state de lookup de cliente no Omie: found / absent / error.
//
// ⚠️ ESPELHADO VERBATIM nos edges supabase/functions/omie-vendas-sync e omie-sync
// (Deno não importa de src/). Qualquer mudança aqui reflete lá e vice-versa.
//
// Motivação (Etapa 2b): hoje um ERRO de lookup (ex.: falha transitória do Omie
// esgotada após retries → `callOmieVendasApi` retorna null; ou exceção engolida
// no catch do `buscar_cliente_por_documento` → 200/codigo_cliente:null) é
// indistinguível de "cliente não existe". Tratar erro como ausência faz o
// auto-cadastro CRIAR um cliente DUPLICADO. O tri-state separa:
//   - found:  cliente existe (código por-conta resolvido)
//   - absent: o Omie respondeu com lista VAZIA → não existe (criação permitida)
//   - error:  não sabemos (exceção/transitório/malformado/ambíguo) → NÃO criar, NÃO enviar
//
// ⚠️ Codex (design 2b): SÓ um array vazio de verdade é `absent`. null/undefined,
// linha sem código, ou >1 resultado (documento duplicado) são `error` — nunca
// `absent`. O edge converte "sem registros" do Omie em `clientes: []`.

/** Linha de cliente como o Omie devolve em ListarClientes (campos relevantes). */
export interface OmieClienteRow {
  codigo_cliente_omie?: number | null;
  codigo_cliente?: number | null;
  codigo_vendedor?: number | null;
  recomendacoes?: { codigo_vendedor?: number | null } | null;
  razao_social?: string | null;
}

export interface ClienteLookupInput {
  /** True se a chamada ao Omie lançou (exceção/transitório-esgotado). */
  threw: boolean;
  /** `clientes_cadastro` da resposta. O edge passa `[]` para "sem registros"
   *  (absent) e o array real quando há resposta; null/undefined = malformado. */
  clientes?: OmieClienteRow[] | null;
}

export type ClienteLookupResult =
  | { status: 'found'; codigo_cliente: number; codigo_vendedor: number | null }
  | { status: 'absent' }
  | { status: 'error'; reason: 'threw' | 'malformed' | 'ambiguous' };

/**
 * Classifica o resultado de um lookup de cliente em found/absent/error.
 * `threw` sempre vence. null/undefined = malformado = error (NÃO absent).
 * >1 resultado = documento duplicado = ambiguous = error (não escolher o 1º).
 * Linha única com código <= 0/ausente = malformado = error.
 */
export function classifyClienteLookup(input: ClienteLookupInput): ClienteLookupResult {
  if (input.threw) return { status: 'error', reason: 'threw' };
  const { clientes } = input;
  if (clientes == null) return { status: 'error', reason: 'malformed' };
  if (clientes.length === 0) return { status: 'absent' };
  if (clientes.length > 1) return { status: 'error', reason: 'ambiguous' };
  const c = clientes[0];
  const code = c?.codigo_cliente_omie ?? c?.codigo_cliente ?? null;
  if (typeof code === 'number' && code > 0) {
    const codigo_vendedor = c.recomendacoes?.codigo_vendedor ?? c.codigo_vendedor ?? null;
    return { status: 'found', codigo_cliente: code, codigo_vendedor };
  }
  return { status: 'error', reason: 'malformed' };
}

/** CPF (11) ou CNPJ (14) dígitos. */
export function isDocumentoValido(documento: string): boolean {
  const d = String(documento).replace(/\D/g, '');
  return d.length === 11 || d.length === 14;
}

/**
 * Código de integração DETERMINÍSTICO para IncluirCliente (`B2B_CLI_<doc-limpo>`).
 * Sem `Date.now()`: dois `IncluirCliente` concorrentes do mesmo documento usam o
 * mesmo código → o Omie tende a rejeitar o 2º como integração duplicada
 * (idempotência de criação; ao ver "duplicado", reconciliar = reconsultar por
 * código e confirmar o documento). O dedup PRIMÁRIO continua por documento.
 * Documento inválido (≠ 11/14 dígitos) → null (não criar com doc ruim).
 */
export function deterministicIntegrationCode(documento: string): string | null {
  const d = String(documento).replace(/\D/g, '');
  if (d.length !== 11 && d.length !== 14) return null;
  return `B2B_CLI_${d}`;
}
