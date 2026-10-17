// Medição do que o Raio-X liberou. Recebe a linha de `raio_x_medicao` (a foto da decisão já vem na linha).
// Ausente ≠ zero: sem venda por NF (Colacor) vendido/liquidado são null; sem permissão de compras
// (compras_apos null) recompra/contradições ficam null/vazias com `compras_visiveis: false`.
import type { Destino, Empresa, LinhaMedicao } from './tipos';

const CONTRADICAO: Destino[] = ['trocar', 'liquidar', 'manter_suspender_recompra'];
const LIMIAR_LIQUIDACAO = 0.9;

interface Contradicao {
  sku_codigo_omie: number;
  destino: Destino;
  pedido_em: string;
}

export interface Medicao {
  vendido: number | null;
  liquidado: number | null;
  margem_sacrificada: number | null;
  trocado: number;
  caixa_liberado: number;
  parado: number;
  recomprado: number | null;
  saiu_sem_nf: number | null;
  reclassificado_nao_caixa: number;
  /** SKUs reclassificados sem custo (foto_valor null): ficam fora da soma, nunca como R$ 0. */
  reclassificado_sem_custo_n: number;
  contradicoes: Contradicao[];
  compras_visiveis: boolean;
  sem_medicao: number[];
  sem_medicao_valor: number;
  /** SKUs sem medição E sem custo (foto_valor null): a soma acima é piso. */
  sem_medicao_sem_custo_n: number;
}

export function medir(linhas: LinhaMedicao[], empresa: Empresa): Medicao {
  const comNf = empresa === 'oben';
  const comprasVisiveis = linhas.every((l) => l.compras_apos !== null);
  let vendido = 0, liquidado = 0, margem = 0, recomprado = 0;
  let trocado = 0, parado = 0, saiuSemNf = 0, reclassificado = 0, semMedicaoValor = 0;
  let reclassificadoSemCustoN = 0, semMedicaoSemCustoN = 0;
  const contradicoes: Contradicao[] = [];
  const semMedicao: number[] = [];

  for (const l of linhas) {
    if (l.foto_categoria === 'nao_mercadoria') {
      if (l.foto_valor === null) reclassificadoSemCustoN += 1; else reclassificado += l.foto_valor;
      continue;
    }
    if (l.foto_categoria === 'uso_consumo') continue;
    // crédito de troca vem da decisão, não do estoque: conta mesmo se o SKU sumiu da medição
    if (l.destino === 'trocar' && typeof l.credito_troca === 'number') trocado += l.credito_troca;

    const { foto_saldo: fs, foto_cmc: fc, saldo_atual: sa } = l;
    if (fs === null || fc === null || sa === null || (comNf && l.qtd_vendida === null)) {
      semMedicao.push(l.sku_codigo_omie);
      if (l.foto_valor === null) semMedicaoSemCustoN += 1; else semMedicaoValor += l.foto_valor;
      continue;
    }
    const saiu = Math.max(0, fs - sa);
    if (comNf) {
      const qv = l.qtd_vendida as number;
      // só conta como saída o que de fato deixou o saldo da foto; venda acima disso foi recomprada
      const vendidoNoPeriodo = Math.max(0, Math.min(qv, fs));
      const qtd = Math.min(vendidoNoPeriodo, saiu);
      recomprado += (vendidoNoPeriodo - qtd) * fc;
      const custo = qtd * fc;
      const precoPeriodo = qv > 0 && l.receita !== null ? l.receita / qv : null;
      if (precoPeriodo !== null && l.preco_medio_12m && precoPeriodo < LIMIAR_LIQUIDACAO * l.preco_medio_12m) {
        liquidado += custo;
        margem += qtd * (l.preco_medio_12m - precoPeriodo);
      } else {
        vendido += custo;
      }
    } else {
      saiuSemNf += saiu * fc; // sem NF: só sabemos que saiu, não por quê nem a que preço
    }
    parado += Math.max(0, Math.min(sa, fs)) * fc;
    if (comprasVisiveis && CONTRADICAO.includes(l.destino) && l.decidido_em) {
      const t0 = Date.parse(l.decidido_em);
      for (const p of l.compras_apos ?? []) {
        if (Date.parse(p) > t0) contradicoes.push({ sku_codigo_omie: l.sku_codigo_omie, destino: l.destino, pedido_em: p });
      }
    }
  }

  // Caixa = só dinheiro real: venda + liquidação + crédito de troca. NUNCA reclassificação nem saída sem NF.
  const caixa = (comNf ? vendido + liquidado : 0) + trocado;
  return {
    vendido: comNf ? vendido : null,
    liquidado: comNf ? liquidado : null,
    margem_sacrificada: comNf ? margem : null,
    trocado,
    caixa_liberado: caixa,
    parado,
    recomprado: comNf && comprasVisiveis ? recomprado : null,
    saiu_sem_nf: comNf ? null : saiuSemNf,
    reclassificado_nao_caixa: reclassificado,
    reclassificado_sem_custo_n: reclassificadoSemCustoN,
    contradicoes,
    compras_visiveis: comprasVisiveis,
    sem_medicao: semMedicao,
    sem_medicao_valor: semMedicaoValor,
    sem_medicao_sem_custo_n: semMedicaoSemCustoN,
  };
}
