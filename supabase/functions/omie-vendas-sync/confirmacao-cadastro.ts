// Confirmação PRODUZIDA PELO SERVIDOR de que o Omie tem o cliente <código> para o <CNPJ> (ledger
// `omie_cliente_confirmacoes`, migration 20261021120000). Esta action (`criar_cliente`) é o ÚNICO escritor;
// a RPC `radar_registrar_cadastro_omie` só marca o lead como cliente se achar a linha — o código que o
// front manda deixou de bastar (Codex ALTO preexistente, 2026-10-20 · diário docs/historico/radar-cnpj-alfanumerico.md).
//
// Escopo = o do Radar: só conta Oben e só CNPJ (numérico de 14 ou alfanumérico RFB). CPF e Colacor não
// entram (o ledger não guarda dado pessoal e a Colacor não lê dele).

/** Mesmo formato do CHECK de `radar_empresas.cnpj` e de `omie_cliente_confirmacoes.documento`. */
const CNPJ_RE = /^[0-9A-Z]{12}[0-9]{2}$/;
/** Mesmo formato do CHECK de `omie_cliente_confirmacoes.codigo_cliente`. */
const CODIGO_RE = /^[1-9][0-9]{0,18}$/;
/** Prazo do INSERT: o cliente JÁ existe no Omie quando gravamos; um banco lento não pode estourar a action. */
export const PRAZO_CONFIRMACAO_MS = 5000;

export type OrigemConfirmacao = "incluir" | "lookup";

export interface LinhaConfirmacao {
  account: "oben";
  documento: string;
  codigo_cliente: string;
  origem: OrigemConfirmacao;
  confirmado_por: string | null;
}

/**
 * A linha a gravar, ou `null` quando não há o que confirmar (outra conta, CPF, código ausente/indeterminado —
 * o `codigo_cliente_omie ?? nCodCli ?? null` do IncluirCliente pode vir null após rate-limit).
 * `documento` é a saída de `documentoParaCadastro` (já normalizada: dígitos, ou 14 chars maiúsculos).
 */
export function linhaConfirmacao(
  account: string,
  documento: string,
  codigo: unknown,
  origem: OrigemConfirmacao,
  confirmadoPor: string | null,
): LinhaConfirmacao | null {
  if (account !== "oben" || !CNPJ_RE.test(documento)) return null;
  const c = typeof codigo === "number" && Number.isSafeInteger(codigo)
    ? String(codigo)
    : typeof codigo === "string"
      ? codigo.trim()
      : "";
  if (!CODIGO_RE.test(c)) return null;
  return { account: "oben", documento, codigo_cliente: c, origem, confirmado_por: confirmadoPor };
}

/** O mínimo do supabase-js que a gravação usa (injetável no teste). */
export interface BancoConfirmacao {
  from(tabela: "omie_cliente_confirmacoes"): {
    insert(linha: LinhaConfirmacao): {
      abortSignal(sinal: AbortSignal): PromiseLike<{ error: { message: string } | null }>;
    };
  };
}

/**
 * Grava a confirmação com prazo. `true` só com sucesso CONFIRMADO; erro, exceção ou prazo estourado → `false`
 * ("não consegui confirmar a gravação" — o INSERT pode ter commitado depois do aborto). Nunca lança: o cliente
 * já existe no Omie, e a falha aqui só deixa o lead na fila (a RPC recusa sem a linha; o "Tentar de novo" volta
 * por esta action, cujo lookup grava de novo).
 */
export async function gravarConfirmacao(
  db: BancoConfirmacao,
  linha: LinhaConfirmacao,
  prazoMs: number = PRAZO_CONFIRMACAO_MS,
): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), prazoMs);
  try {
    const { error } = await db.from("omie_cliente_confirmacoes").insert(linha).abortSignal(ac.signal);
    if (error) {
      console.error(`[Omie Vendas][${linha.account}] confirmação de cadastro NÃO gravada: ${error.message}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[Omie Vendas][${linha.account}] confirmação de cadastro NÃO gravada: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
