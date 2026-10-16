// Reconciliação das NF-es ÓRFÃS com o pedido que apareceu DEPOIS. Testada em reconciliacao_test.ts.
//
// O defeito (OBEN/Sayerlack, medido 2026-10-16 via psql-ro): a NF chega ao recebimento ANTES da linha
// do pedido existir em `purchase_orders_tracking` → o laço principal não casa `nNumPedCompra` com
// nenhum `numero_contrato_fornecedor` e grava a NF como órfã (`omie_codigo_pedido = -nIdReceb`). O
// laço só revisita a janela de 3 dias do cron, então quando o pedido aparece (as linhas de mai/2026
// nasceram em 26/06) a órfã NUNCA é revista: o pedido fica sem NF para sempre — 25 vínculos
// recuperáveis em 10 órfãs, e o backtest do orçamento de compra v1 (#3103) com 268/272 ciclos
// indeterminados.
//
// O que torna o conserto barato: a órfã guarda o recebimento INTEIRO em `raw_data` (a listagem roda
// com `cExibirDetalhes: "S"`), `itensRecebimento[].itensInfoAdic.nNumPedCompra` incluso — 78 de 78
// órfãs medidas. Então reconciliar não chama a Omie: relê o que já está no banco.
//
// Precisão > recall (money-path):
//   - só PREENCHE pedido sem NF. Pedido que já tem OUTRA NF fica intocado (entrega parcial: o
//     rastreio guarda 1 NF por linha, e sobrescrever trocaria a NF mais nova pela órfã mais velha);
//     conta em `conflito_outra_nf`, nunca some calado;
//   - a escrita é compare-and-set (`nfe_chave_acesso IS NULL`): dois runs concorrentes, ou o laço
//     principal vinculando no meio, não carimbam duas NFs na mesma linha;
//   - exige o fornecedor da órfã: contrato é número do FORNECEDOR, colide entre fornecedores;
//   - NÃO apaga a órfã: ela tem `sku_leadtime_history` em cascata e o lt_bruto dela é anulado de
//     propósito (#1365). A coexistência órfã+pedido com a mesma NF já existe hoje (8 vínculos) e é
//     o que o laço principal produz quando o pedido já existia; apagar é decisão de produto à parte.

import { mensagemDeErro } from "../_shared/erro-mensagem.ts";

export type StatusNFe = "FATURADO" | "RECEBIDO" | "CANCELADO";

/** O subconjunto do `MappedNFe` (index.ts) que o vínculo grava. */
export interface NFeParaVinculo {
  chave: string | null;
  numero: string | null;
  serie: string | null;
  data_emissao_iso: string | null;
  data_recebimento_iso: string | null;
  recebida: boolean;
  status: StatusNFe;
  transp_cnpj: string | null;
  transp_nome: string | null;
  fornecedor_nome: string | null;
  fornecedor_cnpj: string | null;
}

export interface LinhaPedido {
  id: string;
  status?: string | null;
  t2_data_faturamento?: string | null;
  t4_data_recebimento?: string | null;
  nfe_chave_acesso?: string | null;
}

interface ItemRecebimento {
  itensInfoAdic?: { nNumPedCompra?: string | number | null } | null;
}

/**
 * Lista DEDUPLICADA de `nNumPedCompra` (número do pedido no FORNECEDOR) a partir do detalhe do
 * recebimento — o do `ConsultarRecebimento` ou o `raw_data` de uma órfã, que têm a mesma forma.
 */
export function extrairPedidosDoDetalhe(detalhe: unknown): string[] {
  const itens = (detalhe as { itensRecebimento?: unknown } | null)?.itensRecebimento;
  if (!Array.isArray(itens)) return [];
  const set = new Set<string>();
  for (const it of itens as ItemRecebimento[]) {
    const num = it?.itensInfoAdic?.nNumPedCompra;
    if (num === undefined || num === null) continue;
    const s = String(num).trim();
    if (s !== "" && s !== "0") set.add(s);
  }
  return Array.from(set);
}

/** O UPDATE que vincula a NF a uma linha de pedido. Compartilhado pelo laço principal e pela reconciliação. */
export function montarPatchVinculo(linha: LinhaPedido, m: NFeParaVinculo, agoraIso: string): Record<string, unknown> {
  const statusAtual = String(linha.status ?? "");
  let status: StatusNFe = m.status;
  if (statusAtual === "CANCELADO") status = "CANCELADO";
  else if (statusAtual === "RECEBIDO" && m.status === "FATURADO") status = "RECEBIDO";

  const patch: Record<string, unknown> = {
    t2_data_faturamento: linha.t2_data_faturamento ?? m.data_emissao_iso,
    nfe_chave_acesso: m.chave,
    nfe_numero: m.numero,
    nfe_serie: m.serie,
    status,
    updated_at: agoraIso,
  };
  if (m.recebida && m.data_recebimento_iso) {
    patch.t4_data_recebimento = linha.t4_data_recebimento ?? m.data_recebimento_iso;
  }
  if (m.transp_cnpj) patch.transportadora_cnpj = m.transp_cnpj;
  if (m.transp_nome) patch.transportadora_nome = m.transp_nome;
  if (m.fornecedor_nome) patch.fornecedor_nome = m.fornecedor_nome;
  if (m.fornecedor_cnpj) patch.fornecedor_cnpj = m.fornecedor_cnpj;
  return patch;
}

export interface OrfaParaReconciliar {
  id: string;
  fornecedor_codigo_omie: number | null;
  nfe_chave_acesso: string | null;
  raw_data: unknown;
}

/** I/O da reconciliação — o index.ts liga no PostgREST, o teste numa tabela em memória. */
export interface PortaReconciliacao {
  /**
   * Todas as órfãs do escopo (empresa/fornecedor), já paginadas, da emissão MAIS ANTIGA para a mais
   * nova: quando duas NFs reivindicam o mesmo pedido, a 1ª vence pelo CAS e a outra vira conflito.
   */
  listarOrfas(): Promise<OrfaParaReconciliar[]>;
  /** Linhas de pedido REAL (omie_codigo_pedido > 0) daquele contrato E fornecedor. */
  linhasDoPedido(contrato: string, fornecedor: number): Promise<LinhaPedido[]>;
  /** UPDATE compare-and-set: só grava se a linha AINDA não tem NF. Devolve se gravou. */
  vincularSeSemNF(id: string, patch: Record<string, unknown>): Promise<boolean>;
}

export interface ReconciliacaoSummary {
  orfas_lidas: number;
  orfas_com_pedido: number;      // órfãs que casaram com 1+ linha de pedido real (vinculada agora ou antes)
  linhas_vinculadas: number;     // linhas de pedido que GANHARAM a NF neste run
  ja_vinculadas: number;         // linhas que já tinham ESTA NF (nada a fazer)
  conflito_outra_nf: number;     // linhas com OUTRA NF: intocadas (precisão > recall)
  corrida_perdida: number;       // o CAS não gravou: alguém vinculou entre a leitura e a escrita
  orfas_puladas: number;         // sem fornecedor ou sem chave: não dá para casar com segurança
  erros: number;
  interrompido_por_timeout?: boolean;
}

export async function reconciliarOrfas(
  porta: PortaReconciliacao,
  mapear: (raw: unknown) => NFeParaVinculo,
  opcoes: { agoraIso: () => string; temTempo: () => boolean; log?: (msg: string) => void },
): Promise<ReconciliacaoSummary> {
  const out: ReconciliacaoSummary = {
    orfas_lidas: 0,
    orfas_com_pedido: 0,
    linhas_vinculadas: 0,
    ja_vinculadas: 0,
    conflito_outra_nf: 0,
    corrida_perdida: 0,
    orfas_puladas: 0,
    erros: 0,
  };

  const orfas = await porta.listarOrfas();
  for (const orfa of orfas) {
    if (!opcoes.temTempo()) {
      out.interrompido_por_timeout = true;
      break;
    }
    out.orfas_lidas++;
    const pedidos = extrairPedidosDoDetalhe(orfa.raw_data);
    if (pedidos.length === 0) continue;
    if (!orfa.fornecedor_codigo_omie || !orfa.nfe_chave_acesso) {
      out.orfas_puladas++;
      continue;
    }

    try {
      const m = mapear(orfa.raw_data);
      // A chave do raw_data tem de ser a da coluna: se divergem, a órfã foi reescrita por outro
      // writer e o raw_data não é mais desta NF — gravar seria carimbar a NF errada no pedido.
      if (m.chave !== orfa.nfe_chave_acesso) {
        out.orfas_puladas++;
        opcoes.log?.(`[reconcilia] órfã ${orfa.id}: chave do raw_data ≠ coluna — pulada`);
        continue;
      }
      let casou = false;
      for (const contrato of pedidos) {
        const linhas = await porta.linhasDoPedido(contrato, orfa.fornecedor_codigo_omie);
        for (const linha of linhas) {
          casou = true;
          if (linha.nfe_chave_acesso === orfa.nfe_chave_acesso) {
            out.ja_vinculadas++;
          } else if (linha.nfe_chave_acesso) {
            out.conflito_outra_nf++;
          } else if (await porta.vincularSeSemNF(linha.id, montarPatchVinculo(linha, m, opcoes.agoraIso()))) {
            out.linhas_vinculadas++;
          } else {
            out.corrida_perdida++;
          }
        }
      }
      if (casou) out.orfas_com_pedido++;
    } catch (err) {
      out.erros++;
      opcoes.log?.(`[reconcilia] órfã ${orfa.id} erro: ${mensagemDeErro(err) ?? "erro sem mensagem"}`);
    }
  }
  return out;
}
