/**
 * Helpers puros para o fluxo de comprovação de tarefas (Fase 2).
 *
 * São espelhos client-side das validações que o RPC `concluir_com_comprovacao`
 * já faz no banco — permitem feedback imediato antes de chamar o servidor.
 * Sem efeitos colaterais; totalmente testáveis.
 */

// ---------------------------------------------------------------------------
// validarLeitura
// ---------------------------------------------------------------------------

export interface ValidacaoLeitura {
  ok: boolean;
  erro: string | null;
}

/**
 * Valida se `valor` está dentro da faixa `[min, max]`.
 *
 * Regras:
 * - `valor === null` → inválido (leitura obrigatória quando chamado)
 * - `min` e/ou `max` ausentes → sem restrição naquele lado
 * - Fora da faixa → retorna mensagem descritiva
 */
export function validarLeitura(
  valor: number | null,
  min: number | null,
  max: number | null,
): ValidacaoLeitura {
  if (valor === null || valor === undefined) {
    return { ok: false, erro: 'Informe o valor da leitura' };
  }
  if (min !== null && valor < min) {
    return {
      ok: false,
      erro: max !== null
        ? `Valor ${valor} abaixo do mínimo ${min} (faixa: ${min}–${max})`
        : `Valor ${valor} abaixo do mínimo ${min}`,
    };
  }
  if (max !== null && valor > max) {
    return {
      ok: false,
      erro: min !== null
        ? `Valor ${valor} acima do máximo ${max} (faixa: ${min}–${max})`
        : `Valor ${valor} acima do máximo ${max}`,
    };
  }
  return { ok: true, erro: null };
}

// ---------------------------------------------------------------------------
// montarPathComprovacao
// ---------------------------------------------------------------------------

/**
 * Monta o path do arquivo no bucket `tarefa-comprovacoes`.
 *
 * Formato: `{uid}/{tarefaId}/{ts}.{ext}`
 *
 * O RPC verifica que a URL contém `{uid}/{tarefaId}` → manter exatamente esse
 * prefixo. O parâmetro `ts` é aceito explicitamente para facilitar testes;
 * o caller passa `Date.now()`.
 *
 * @param uid       UUID do usuário autenticado (auth.uid())
 * @param tarefaId  UUID da tarefa
 * @param ext       Extensão do arquivo sem ponto (ex: 'jpg', 'png')
 * @param ts        Timestamp em ms (use Date.now() na produção)
 */
export function montarPathComprovacao(
  uid: string,
  tarefaId: string,
  ext: string,
  ts: number,
): string {
  return `${uid}/${tarefaId}/${ts}.${ext}`;
}
