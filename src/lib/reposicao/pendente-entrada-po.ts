// Reposição — "a caminho" (estoque_pendente_entrada) via FONTE ÚNICA: pedidos de compra do Omie.
// ============================================================================================
// DESENHO (Codex design consult 2026-06-11, "Opção A endurecida"): a QUANTIDADE de "a caminho" tem
// fonte ÚNICA = saldo (nQtde − nQtdeRec) somado por SKU sobre as POs abertas APROVADAS do Omie
// (app + manual). O em_transito da RPC é REMOVIDO (era qtde_final cheia, inclusive já-recebido →
// inconsistente com o saldo → overcount → ruptura; o adversarial do Codex bloqueou o "keep-both").
//
// Este helper é PURO e FAIL-CLOSED: classifica cada item e devolve, além do mapa por SKU, a lista de
// `problemas`. Se `problemas` não for vazio, a edge NÃO aplica o snapshot (mantém o anterior) — nunca
// grava valor parcial/duvidoso no money-path. Overcount é o pior caso, então número inválido
// (não-finito ou negativo) e etapa ABERTA desconhecida com saldo>0 abortam o apply.
//
// SEM de-dup (fonte única — não há em_transito pra colidir). A latência do recém-disparado é coberta
// FORA daqui, pela barreira fail-closed da RPC + bump only_pending no disparo (ver spec).

export interface PoItemOmie {
  /** sku_codigo_omie (nCodProd do Omie), como string. */
  sku: string;
  /** Número do pedido de compra no Omie (cNumero) — só p/ diagnóstico nas mensagens de problema. */
  poNumero: string;
  /** cEtapa do pedido (códigos CUSTOMIZÁVEIS por conta — OBEN: 15=Aprovado, 10=Em Aprovação). */
  etapa: string;
  /** nQtde do item. */
  qtde: number;
  /** nQtdeRec do item (recebido). */
  recebido: number;
}

export interface ComputeOnOrderOpts {
  /** Etapas que CONTAM (aprovado-e-aberto). OBEN: {"15"}. */
  etapasAprovadas: ReadonlySet<string>;
  /** Etapas não-comprometidas que se IGNORA sem alarme (em aprovação). OBEN: {"10"}. */
  etapasIgnoradas: ReadonlySet<string>;
}

export interface ComputeOnOrderResult {
  /** "a caminho" por SKU (saldo a receber somado). Só é aplicado se `problemas` for vazio. */
  porSku: Map<string, number>;
  /** Razões pra ABORTAR o apply (fail-closed). Vazio = seguro aplicar. */
  problemas: string[];
}

/** Item tem número de quantidade válido? (não-finito ou negativo = dado torto → fail-closed). */
export function quantidadesValidas(qtde: number, recebido: number): boolean {
  return Number.isFinite(qtde) && Number.isFinite(recebido) && qtde >= 0 && recebido >= 0;
}

/** Saldo a receber de um item válido (nunca negativo). Pré-condição: quantidadesValidas === true. */
export function saldoAReceber(qtde: number, recebido: number): number {
  return Math.max(0, qtde - recebido);
}

/**
 * Soma o "a caminho" (saldo a receber) por SKU sobre as POs abertas APROVADAS do Omie.
 * FAIL-CLOSED: número inválido ou etapa aberta desconhecida com saldo>0 entram em `problemas`
 * (a edge aborta o apply e mantém o snapshot anterior).
 */
export function computeOnOrder(
  items: readonly PoItemOmie[],
  opts: ComputeOnOrderOpts,
): ComputeOnOrderResult {
  const porSku = new Map<string, number>();
  const problemas: string[] = [];

  for (const item of items) {
    if (!quantidadesValidas(item.qtde, item.recebido)) {
      problemas.push(
        `quantidade inválida (sku=${item.sku} po=${item.poNumero} qtde=${item.qtde} recebido=${item.recebido})`,
      );
      continue;
    }
    const saldo = saldoAReceber(item.qtde, item.recebido);
    if (saldo <= 0) continue; // nada a receber (recebido total / pedido zerado)

    if (opts.etapasAprovadas.has(item.etapa)) {
      porSku.set(item.sku, (porSku.get(item.sku) ?? 0) + saldo);
    } else if (opts.etapasIgnoradas.has(item.etapa)) {
      continue; // em aprovação / não-comprometido: não conta, sem alarme
    } else {
      // etapa ABERTA desconhecida COM saldo: não classificável → fail-closed (não chutar no money-path)
      problemas.push(`etapa aberta desconhecida com saldo (etapa=${item.etapa} sku=${item.sku} po=${item.poNumero})`);
    }
  }

  return { porSku, problemas };
}
