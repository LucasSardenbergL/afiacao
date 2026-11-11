import { mensagemDoErroEdge } from '@/lib/invoke-function';
import { isValidOmieClientCode } from '@/services/orderSubmission/helpers';

/**
 * Tri-state do auto-cadastro de cliente por conta Omie (spec
 * 2026-06-06-preco-realtime-selectCustomer — Etapas 2b/3).
 *
 * O lookup de cliente por conta tem TRÊS desfechos, não dois:
 *   found  → código preenchido → não criar;
 *   absent → lookup respondeu "não existe" → criar;
 *   error  → o lookup FALHOU → ausência NÃO confirmada → NÃO criar às cegas
 *            (criar em cima de falha de leitura duplicaria no Omie um cliente
 *            que já existe). Nesse caso o preflight fail-closed do submit
 *            bloqueia a conta, se usada — com mensagem acionável.
 *
 * ⚠️ Limite conhecido (Etapa 2b pendente): este guard cobre falha do INVOKE
 * (rede, 5xx, throw). O edge `buscar_cliente` ainda MASCARA erro transitório/
 * rate-limit esgotado como `{ success: true, cliente: null }` — que daqui
 * parece "absent". Fechar esse canal exige o `throwOnTransient` do edge
 * (Etapa 2b do spec, aguardando deploy); até lá o re-check de existência do
 * próprio `criar_cliente` é o mitigante.
 */
export interface EnsureContaInput {
  /** Código do cliente naquela conta (null/undefined = não resolvido). */
  codigoExistente: number | null | undefined;
  /** Cliente tem CNPJ/CPF (sem documento não há como cadastrar). */
  temDocumento: boolean;
  /** O lookup daquela conta FALHOU (erro/reject — ausência não confirmada). */
  lookupFalhou: boolean;
}

export function deveCriarClienteNaConta({
  codigoExistente,
  temDocumento,
  lookupFalhou,
}: EnsureContaInput): boolean {
  if (codigoExistente) return false;
  if (!temDocumento) return false;
  if (lookupFalhou) return false;
  return true;
}

/* ─── Desfecho do auto-cadastro (A1 da revisão do #3803) ───────────────────
 * `supabase.functions.invoke` NÃO rejeita em erro de edge: devolve
 * `{ data: null, error }` (a `omie-vendas-sync` lança → 500 com `{ error }` no
 * corpo) — e a `omie-sync` responde 200 com `{ success: false, error }`. Ler só
 * `res.data?.codigo_cliente` engolia os dois: o vendedor só descobria no submit,
 * com o preflight dizendo "provável falha temporária do Omie" — falso quando o
 * motivo é a razão mascarada (RAZAO_MASCARADA), que retentar não resolve.
 */

export type ContaAutoCadastro = 'colacor' | 'afiacao';

const NOME_CONTA: Record<ContaAutoCadastro, string> = { colacor: 'Colacor', afiacao: 'Afiação' };

/** Marca que `_shared/razao-fiscal.ts` põe no início da mensagem quando a razão chegou com o CPF
 *  mascarado e nenhuma outra conta Omie do grupo tem a razão fiscal do documento. */
export const MARCA_RAZAO_MASCARADA = 'RAZAO_MASCARADA:';

export type DesfechoAutoCadastro =
  | { ok: true; codigoCliente: number; codigoVendedor: number | null }
  | { ok: false; conta: ContaAutoCadastro; motivo: string; razaoMascarada: boolean };

interface RespostaCriarCliente {
  success?: unknown;
  codigo_cliente?: unknown;
  codigo_vendedor?: unknown;
  error?: unknown;
}

function textoNaoVazio(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** Classifica a resposta do `invoke` de `criar_cliente` / `criar_cliente_afiacao`. Só é `ok` com
 *  código Omie VÁLIDO (número > 0, a mesma régua do preflight `missingAccountIdentities`): ausente
 *  ≠ zero, e sucesso sem código é falha com motivo, não silêncio. */
export async function desfechoAutoCadastro(
  conta: ContaAutoCadastro,
  res: { data: unknown; error: unknown },
): Promise<DesfechoAutoCadastro> {
  let motivo: string;
  if (res.error) {
    motivo =
      textoNaoVazio(await mensagemDoErroEdge(res.error)) ??
      textoNaoVazio((res.error as { message?: unknown } | null)?.message) ??
      'a função de cadastro respondeu com erro sem detalhe';
  } else {
    const d = (res.data ?? null) as RespostaCriarCliente | null;
    if (d?.success === false) {
      motivo = textoNaoVazio(d.error) ?? 'o Omie recusou o cadastro sem detalhe';
    } else if (!isValidOmieClientCode(d?.codigo_cliente)) {
      motivo = 'o Omie não devolveu o código do cliente';
    } else {
      return {
        ok: true,
        codigoCliente: d.codigo_cliente,
        codigoVendedor: isValidOmieClientCode(d.codigo_vendedor) ? d.codigo_vendedor : null,
      };
    }
  }
  return { ok: false, conta, motivo, razaoMascarada: motivo.includes(MARCA_RAZAO_MASCARADA) };
}

/** Título e descrição do toast de falha do auto-cadastro numa conta. */
export function avisoFalhaAutoCadastro(
  falha: Extract<DesfechoAutoCadastro, { ok: false }>,
): { titulo: string; descricao: string } {
  const nome = NOME_CONTA[falha.conta];
  if (falha.razaoMascarada) {
    return {
      titulo: `Cliente sem cadastro na ${nome}: razão com CPF mascarado`,
      descricao:
        `O nome deste cliente está gravado com o CPF mascarado e nenhuma conta Omie do grupo tem a razão fiscal dele. ` +
        `Selecione o cliente pela busca (digite o CPF/CNPJ — ela consulta o Omie e traz a razão completa); ` +
        `se ele não aparecer, cadastre-o no Omie com a razão completa antes de lançar itens da ${nome}.`,
    };
  }
  return {
    titulo: `Não foi possível cadastrar o cliente na ${nome}`,
    // "Até confirmar um código", não "até o cadastro existir": no OMIE_LOOKUP_AMBIGUO/DIVERGENTE o cliente JÁ
    // existe no Omie, e mandar cadastrar empurraria o vendedor a duplicá-lo (Codex, revisão do A1).
    descricao: `${falha.motivo}. Pedido com itens da ${nome} fica bloqueado até o app confirmar um código válido do cliente nessa conta.`,
  };
}
