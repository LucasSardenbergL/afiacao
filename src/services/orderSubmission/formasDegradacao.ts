// Guard money-path da CONDIÇÃO DE PAGAMENTO sob degradação da listagem do Omie.
//
// Contexto (#1597): `listarFormasPagamento` no edge omie-vendas-sync passou a usar
// `throwOnTransient` — rate-limit/transitório ESGOTADO não devolve mais a lista PARCIAL
// como se fosse completa. Em troca, cai num fallback HARDCODED de 8 condições genéricas
// ("A Vista", "30 dias", "30/60 dias"…) e DECLARA a degradação no retorno
// (`source: 'omie'|'fallback'`, `degraded`, `motivo`).
//
// Este módulo é o lar único da leitura desse envelope e da decisão que ele habilita —
// money-path §7: "consertar o helper NÃO conserta a tela; a correção só termina na tela".
// Sem isto o vendedor monta o pedido vendo 8 genéricas sem saber que as condições REAIS
// daquele cliente não carregaram: escolhe uma que o Omie rejeita na gravação, ou — pior —
// uma que o Omie ACEITA com prazo diferente do combinado (DSO errado).
import type { FormaPagamento } from '@/hooks/unifiedOrder/types';

/**
 * Envelope da action `listar_formas_pagamento`. TODOS os campos além de `formas` são
 * opcionais de propósito: edge ANTERIOR ao #1597 (ou ainda não deployada — merge na main
 * ≠ produção) devolve só `{ success, formas }`, e aí `degraded` chega `undefined`.
 */
export interface RespostaFormasPagamento {
  formas?: FormaPagamento[] | null;
  source?: string | null;
  degraded?: boolean | null;
  motivo?: string | null;
}

/** Estado normalizado que a UI consome. `degradado` só é true sob declaração explícita. */
export interface EstadoFormasPagamento {
  formas: FormaPagamento[];
  degradado: boolean;
  /** Mensagem do erro do Omie que causou o fallback (pode faltar mesmo degradado). */
  motivo: string | null;
}

export const ESTADO_FORMAS_VAZIO: EstadoFormasPagamento = {
  formas: [],
  degradado: false,
  motivo: null,
};

/**
 * Recorte que a UI precisa para avisar/bloquear — sem as `formas` (que trafegam por props
 * próprias, já ordenadas pelo histórico do cliente). Um objeto por conta em vez de 4 props
 * soltas: o `CartSummaryBar` já carrega ~25 props.
 */
export interface EstadoFormasUI {
  degradado: boolean;
  motivo: string | null;
  /** A consulta falhou por inteiro (nem a lista genérica chegou). */
  erro: boolean;
  /** Códigos conhecidos deste cliente/pedido que sumiram da lista — prova de bloqueio. */
  condicoesAusentes: string[];
}

export const ESTADO_FORMAS_UI_OK: EstadoFormasUI = {
  degradado: false,
  motivo: null,
  erro: false,
  condicoesAusentes: [],
};

/**
 * Lê o envelope do edge sem NUNCA inferir degradação por ausência.
 *
 * Compatibilidade fail-OPEN deliberada (é o único ponto do módulo onde ausente vira "ok"):
 * `degraded === true` e `source === 'fallback'` são testes ESTRITOS, então uma edge antiga
 * — que não conhece nenhum dos dois campos — é lida como NÃO-degradada e a tela segue como
 * hoje. O inverso (tratar `undefined` como degradado) pintaria de vermelho todo pedido
 * enquanto a edge do #1597 não estiver deployada: aviso falso ensina a ignorar o aviso, e
 * o próximo — o real — vira ruído (money-path, "o VALIDADOR mente").
 *
 * `source` entra como segundo sinal do MESMO contrato (nasceram no mesmo commit): não
 * cobre edge antiga, só um payload que perdesse `degraded` no caminho.
 */
export function lerRespostaFormas(data: unknown): EstadoFormasPagamento {
  if (!data || typeof data !== 'object') return ESTADO_FORMAS_VAZIO;
  const resp = data as RespostaFormasPagamento;
  const formas = Array.isArray(resp.formas) ? resp.formas : [];
  const degradado = resp.degraded === true || resp.source === 'fallback';
  return {
    formas,
    degradado,
    motivo: typeof resp.motivo === 'string' && resp.motivo.length > 0 ? resp.motivo : null,
  };
}

/**
 * Códigos que sabidamente pertencem a ESTE cliente/pedido e sumiram da lista exibida —
 * a prova positiva de que a degradação removeu uma condição que importa aqui.
 *
 * Fontes de `codigosConhecidos` (ambas independentes desta action, logo não degradam junto):
 * o `parcela_ranking`/`ultima_parcela` do cliente (action `buscar_ultima_parcela`, histórico
 * REAL de pedidos no Omie) e o `codigo_parcela` já gravado no pedido em edição.
 *
 * ⚠️ Só vale sob degradação declarada. No caminho BOM, código do histórico ausente da lista
 * é legítimo — `listarFormasPagamento` filtra `cInativo === 'S'`, então parcela desativada no
 * Omie some da lista e continua no histórico. Chamar isto sem checar `degradado` bloquearia
 * venda por um estado normal; por isso o predicado de bloqueio abaixo exige as duas coisas.
 */
export function condicoesConhecidasAusentes(
  formas: ReadonlyArray<FormaPagamento>,
  codigosConhecidos: ReadonlyArray<string>,
): string[] {
  const disponiveis = new Set(formas.map((f) => f.codigo));
  const vistos = new Set<string>();
  const ausentes: string[] = [];
  for (const codigo of codigosConhecidos) {
    // Código vazio/nulo não é prova de nada (money-path: ausente ≠ fato).
    if (!codigo || disponiveis.has(codigo) || vistos.has(codigo)) continue;
    vistos.add(codigo);
    ausentes.push(codigo);
  }
  return ausentes;
}

/**
 * Prova positiva de que a lista degradada não serve para este cliente/pedido.
 * Precisão > recall: exige degradação DECLARADA **e** um código conhecido ausente.
 * Degradação sem código conhecido (cliente novo, histórico não carregado) → só aviso.
 */
export function condicoesDoClienteIndisponiveis(
  estado: EstadoFormasPagamento,
  codigosConhecidos: ReadonlyArray<string>,
): string[] {
  if (!estado.degradado) return [];
  return condicoesConhecidasAusentes(estado.formas, codigosConhecidos);
}

/**
 * Códigos que impedem o ENVIO do carrinho — lar único da decisão de bloqueio, consumido
 * tanto pelo `disabled` do botão quanto pelo guard imperativo do submit (money-path §5: a
 * UI é defense-in-depth, o guard no caminho de envio é a proteção; as duas re-decidindo
 * separadamente esconderiam qual vale).
 *
 * Só conta a conta que REALMENTE tem item no carrinho: pedido só-Oben não pode ser barrado
 * porque a listagem da Colacor degradou — a condição da Colacor não vai a lugar nenhum.
 */
export function condicoesBloqueantesDoCarrinho(
  contas: ReadonlyArray<{ temItens: boolean; estado: EstadoFormasUI }>,
): string[] {
  const codigos: string[] = [];
  for (const { temItens, estado } of contas) {
    if (!temItens) continue;
    for (const codigo of estado.condicoesAusentes) {
      if (!codigos.includes(codigo)) codigos.push(codigo);
    }
  }
  return codigos;
}

/** Aviso de degradação (lista genérica no lugar das condições reais do Omie). */
export const AVISO_FORMAS_DEGRADADAS =
  'Condições do Omie indisponíveis; mostrando opções padrão.';

/** Aviso de falha total da consulta (nem a lista genérica chegou). */
export const AVISO_FORMAS_INDISPONIVEIS =
  'Não foi possível carregar as condições de pagamento do Omie.';

/**
 * Mensagem de bloqueio, citando os códigos que o cliente usa e que sumiram — o vendedor
 * precisa saber QUAL condição não está na tela para decidir se espera ou salva orçamento.
 */
export function mensagemCondicoesIndisponiveis(codigos: ReadonlyArray<string>): string {
  const lista = codigos.join(', ');
  return `Este cliente usa condição de pagamento que não está na lista (${lista}). `
    + 'As condições do Omie não carregaram — enviar agora gravaria um prazo diferente do combinado.';
}
