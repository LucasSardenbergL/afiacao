// Medição do que o Raio-X liberou. Recebe a linha de `raio_x_medicao` (a foto da decisão já vem na linha).
// A janela de venda começa na FOTO (imutável), não em decidido_em: trocar o destino não apaga venda já feita.
// NADA aqui é "caixa": estoque reduzido é saída valorizada ao CMC da foto, receita é o faturado dessas
// unidades, crédito de troca é o que o operador informou. São parcelas separadas — nunca somadas como caixa.
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
  /** crédito de troca INFORMADO pelo operador (não conferido com o fornecedor); contrapartida 'encalhe' fica FORA. */
  trocado: number;
  /** crédito de troca cuja contrapartida é outro encalhe: nada foi liberado — fora do critério. */
  trocado_encalhe: number;
  /** parcela de `trocado` sem contrapartida informada (conta como hoje, mas é incerteza declarada). */
  trocado_sem_contrapartida: number;
  /** vendido + liquidado, a custo (CMC da foto). Sem NF (Colacor) → null. */
  estoque_reduzido: number | null;
  /** faturado pelas unidades contadas em `estoque_reduzido` (preço médio do período). Sem NF → null. */
  receita_vendas: number | null;
  /**
   * Critério da meta (≥ R$ 60k), INALTERADO desde a fase B: estoque reduzido a custo + crédito informado.
   * É um critério de acompanhamento, não caixa — a tela mostra as parcelas, nunca "caixa liberado".
   */
  meta_liberado: number;
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
  let vendido = 0, liquidado = 0, margem = 0, recomprado = 0, receita = 0;
  let trocado = 0, trocadoEncalhe = 0, trocadoSemContrapartida = 0, parado = 0, saiuSemNf = 0, reclassificado = 0, semMedicaoValor = 0;
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
    if (l.destino === 'trocar' && typeof l.credito_troca === 'number') {
      // troca por outro ENCALHE não libera nada (Codex P0-5): sai do crédito que conta; sem contrapartida segue contando como hoje
      if (l.troca_contrapartida === 'encalhe') trocadoEncalhe += l.credito_troca;
      else {
        trocado += l.credito_troca;
        if (l.troca_contrapartida === null) trocadoSemContrapartida += l.credito_troca;
      }
    }

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
      if (precoPeriodo !== null) receita += qtd * precoPeriodo;
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
    // Contradição segue por decidido_em do destino VIGENTE (de propósito): comprar antes de decidir tirar do
    // estoque não contradiz a decisão; comprar depois, sim. A janela de venda (acima) é a da foto.
    if (comprasVisiveis && CONTRADICAO.includes(l.destino) && l.decidido_em) {
      const t0 = Date.parse(l.decidido_em);
      for (const p of l.compras_apos ?? []) {
        if (Date.parse(p) > t0) contradicoes.push({ sku_codigo_omie: l.sku_codigo_omie, destino: l.destino, pedido_em: p });
      }
    }
  }

  // Critério da meta: estoque reduzido a custo + crédito informado. NUNCA reclassificação nem saída sem NF.
  const estoqueReduzido = comNf ? vendido + liquidado : null;
  return {
    vendido: comNf ? vendido : null,
    liquidado: comNf ? liquidado : null,
    margem_sacrificada: comNf ? margem : null,
    trocado,
    trocado_encalhe: trocadoEncalhe,
    trocado_sem_contrapartida: trocadoSemContrapartida,
    estoque_reduzido: estoqueReduzido,
    receita_vendas: comNf ? receita : null,
    meta_liberado: (estoqueReduzido ?? 0) + trocado,
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
