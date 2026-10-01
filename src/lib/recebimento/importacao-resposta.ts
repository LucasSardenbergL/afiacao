/**
 * Veredito da importação de UMA NF-e pela chave (`omie-nfe-recebimento-sync` com
 * `{ chave_acesso, warehouse_id }`), para o botão "Importar NF-e" de /recebimento.
 *
 * O botão chamava `omie-nfe-webhook`, que exige o segredo do webhook do Omie: 401 sempre, e o
 * toast mostrava a frase genérica do transporte. Mesmas regras de `efetivacao-resposta.ts`: só
 * `status` da allowlist com o número de itens é sucesso, qualquer ausência de sinal é FALHA, e o
 * corpo do ≠2xx é lido de `error.context` para o operador ver o motivo real (chave errada, NF-e já
 * recebida no Omie, Omie pedindo para aguardar).
 */
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { corpoDoErro, type RespostaInvoke } from './efetivacao-resposta';

export type VereditoImportacao =
  | { tipo: 'sucesso' | 'info'; mensagem: string; fecharDialogo: true }
  | { tipo: 'aviso' | 'falha'; mensagem: string; fecharDialogo: boolean };

const MSG_FALLBACK = 'a importação não respondeu — tente de novo ou avise a equipe';

function comoRegistro(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function itens(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

function rotuloItens(n: number): string {
  return `${n} ${n === 1 ? 'item' : 'itens'}`;
}

export async function interpretarImportacaoPorChave(res: RespostaInvoke): Promise<VereditoImportacao> {
  if (res.error) {
    const corpo = await corpoDoErro(res.error);
    const motivo = typeof corpo?.error === 'string' && corpo.error.trim() ? corpo.error : null;
    if (corpo?.status === 'omie_ocupado') {
      return { tipo: 'aviso', mensagem: motivo ?? 'o Omie pediu para aguardar — tente de novo em instantes', fecharDialogo: false };
    }
    return { tipo: 'falha', mensagem: motivo ?? mensagemDeErro(res.error) ?? MSG_FALLBACK, fecharDialogo: false };
  }

  const data = comoRegistro(res.data);
  const n = itens(data?.itens);
  if (data?.status === 'importada' && n !== null) {
    if (n === 0) {
      return { tipo: 'aviso', mensagem: 'NF-e importada, mas o Omie não devolveu itens — confira a nota no Omie', fecharDialogo: true };
    }
    return { tipo: 'sucesso', mensagem: `NF-e importada — ${rotuloItens(n)}`, fecharDialogo: true };
  }
  if (data?.status === 'ja_importada' && n !== null) {
    if (n === 0) {
      return {
        tipo: 'aviso',
        mensagem: 'Esta NF-e já está no app, mas SEM itens (uma importação antiga falhou) — avise a equipe',
        fecharDialogo: true,
      };
    }
    return { tipo: 'info', mensagem: `Esta NF-e já foi importada (${rotuloItens(n)})`, fecharDialogo: true };
  }
  return { tipo: 'falha', mensagem: MSG_FALLBACK, fecharDialogo: false };
}
