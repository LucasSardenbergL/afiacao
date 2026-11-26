/**
 * 8.1 (rodada 3): a validação do vendedor nos Omies falha FECHADO.
 *
 * Antes, qualquer falha (rede, 4xx/5xx, resposta sem `consistente`) caía em "sem divergência" e o
 * envio seguia — ausente ≠ consistente. Agora só `consistente === true` libera; o resto vira
 * `divergente` (o Omie disse que não bate) ou `indisponivel` (não sabemos), e os dois bloqueiam.
 *
 * `nao_verificado` = não houve validação para esta seleção: sem cliente, autoatendimento (a ação
 * `validar_vendedor` é staff-only) ou cliente sem CPF/CNPJ. Não bloqueia — é o comportamento de antes
 * para esses casos, e o documento ausente já tem as próprias travas no envio.
 */
export type EstadoVendedor = 'nao_verificado' | 'validando' | 'consistente' | 'divergente' | 'indisponivel';

export interface ResultadoValidacaoVendedor {
  estado: 'consistente' | 'divergente' | 'indisponivel';
  divergencias: string[];
}

const DIVERGENCIA_SEM_DETALHE = 'O Omie apontou vendedores diferentes entre as contas (sem detalhe).';

/** Interpreta a resposta de `omie-cliente` → `validar_vendedor`. Puro (testável sem rede). */
export function interpretarValidacaoVendedor(data: unknown, error: unknown): ResultadoValidacaoVendedor {
  if (error || !data || typeof data !== 'object') return { estado: 'indisponivel', divergencias: [] };
  const d = data as { consistente?: unknown; divergencias?: unknown; error?: unknown };
  if (d.error) return { estado: 'indisponivel', divergencias: [] };
  if (d.consistente === true) return { estado: 'consistente', divergencias: [] };
  if (d.consistente === false) {
    const lista = Array.isArray(d.divergencias)
      ? d.divergencias.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      : [];
    // Divergente sem lista ainda é divergente: a lista vazia NÃO pode reabrir o envio.
    return { estado: 'divergente', divergencias: lista.length > 0 ? lista : [DIVERGENCIA_SEM_DETALHE] };
  }
  return { estado: 'indisponivel', divergencias: [] };
}

/** Guard do caminho de envio: mensagem = bloqueia; `null` = libera (só `consistente` e `nao_verificado`). */
export function mensagemBloqueioVendedor(estado: EstadoVendedor): string | null {
  switch (estado) {
    case 'validando': return 'Aguarde — ainda validando o vendedor nos Omies.';
    case 'divergente': return 'Vendedor divergente entre as contas Omie. Corrija no Omie antes de enviar.';
    case 'indisponivel': return 'Não foi possível validar o vendedor. Use “Trocar” e selecione o cliente de novo antes de enviar.';
    default: return null;
  }
}

/** Prazo máximo da validação (Codex r1): uma chamada pendurada deixava o estado em `validando` — o envio
 *  travado sem saída. Estourou → rejeita, e quem chama trata como `indisponivel` (saída: "Trocar"). */
export const PRAZO_VALIDACAO_VENDEDOR_MS = 30_000;

export function comPrazo<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const estouro = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`validação do vendedor sem resposta em ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([p, estouro]).finally(() => clearTimeout(timer));
}
