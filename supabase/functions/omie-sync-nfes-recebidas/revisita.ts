// Revisita da janela LARGA: a NF que o laço de 3 dias nunca mais vê. Testada em revisita_test.ts.
//
// O defeito (OBEN/Sayerlack, provado em prod 2026-10-17): o cron só lista a janela de 3 dias por
// `dtEmissao`, e a NF processada ali nunca é revista. A reconciliação v1.5 (reconciliacao.ts) fechou
// a variante da NF ÓRFÃ; sobram duas que ela não enxerga:
//   (2) NF que casou PARCIALMENTE — parte dos contratos já tinha linha, o resto nasceu depois. Não
//       vira órfã, então a reconciliação não a lê. Ex.: NF 0935816 (08/05) cobre o contrato 2091399,
//       cuja linha nasceu em 15/05; idem 0938767↔2098269 e 0940479↔2102074.
//   (3) NF lançada no recebimento DEPOIS da janela (000936908, 000945865): nunca listada; só entraram
//       com reprocesso manual por janela.
//
// O que torna o conserto barato (medido 2026-10-18, psql-ro): a listagem roda com
// `cExibirDetalhes: "S"` e já traz `itensRecebimento[].itensInfoAdic.nNumPedCompra` — 17 de 17 órfãs
// Sayerlack com pedido. Então a NF que o banco JÁ CONHECE (variante 2) é revista sem nenhum
// `ConsultarRecebimento`: o custo de Omie da janela inteira é 1 chamada por página de 50. Só a NF
// DESCONHECIDA (variante 3) é consultada, para decidir órfã exatamente como o laço principal decide.
//
// Precisão > recall (money-path), as mesmas regras da reconciliação:
//   - só PREENCHE linha sem NF (compare-and-set). Linha com outra NF fica intocada — a revisita nunca
//     piora a sobrescrita de `nfe_chave_acesso` que o laço principal já faz;
//   - exige o fornecedor: contrato é número do FORNECEDOR e colide entre fornecedores;
//   - NF cancelada não vincula; CT-e sai antes de tudo;
//   - ordem por emissão ASCENDENTE: quando duas NFs disputam a linha, vence o 1º faturamento (o t2);
//   - listagem incompleta NÃO escreve: a ordem por emissão só decide sobre a janela inteira.

import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import {
  type ContagemVinculo,
  extrairPedidosDoDetalhe,
  montarPatchVinculo,
  type NFeParaVinculo,
  type PortaReconciliacao,
  vincularContratosSemNF,
} from "./reconciliacao.ts";

/** Um documento da listagem larga, já normalizado pelo index.ts. */
export interface DocumentoRevisita {
  nIdReceb: number;
  /** Chave de 44 dígitos (normalizada); `null` = ilegível. */
  chave: string | null;
  fornecedor: number | null;
  emissaoIso: string | null;
  cte: boolean;
  cancelada: boolean;
  /** O item da listagem (`cExibirDetalhes: "S"`), com `itensRecebimento`. */
  bruto: unknown;
}

export interface PortaRevisita extends Pick<PortaReconciliacao, "linhasDoPedido" | "vincularSeSemNF"> {
  /** nIdReceb que o banco já conhece (por chave, por `nid_receb` ou como órfã `-nIdReceb`). Lança em erro. */
  conhecidas(docs: Array<{ nIdReceb: number; chave: string }>): Promise<Set<number>>;
  /** `ConsultarRecebimento(nIdReceb)`. LANÇA em falha e em faultstring: nada disso prova ausência de pedido. */
  consultar(nIdReceb: number): Promise<unknown>;
  /** A mesma órfã que o laço principal grava (`omie_codigo_pedido = -nIdReceb`). */
  inserirOrfa(doc: DocumentoRevisita): Promise<void>;
}

export interface RevisitaSummary extends ContagemVinculo {
  /** "dd/mm/aaaa→dd/mm/aaaa" por `dtEmissao`. */
  janela: string;
  documentos_listados: number;
  ctes_ignorados: number;
  canceladas_puladas: number;
  /** Consultadas pelo laço principal NESTE run: repetir a consulta seria REDUNDANT na Omie. */
  ja_processadas_no_run: number;
  /** Sem chave legível ou sem fornecedor: não dá para casar com segurança. */
  puladas_invalidas: number;
  conhecidas: number;
  conhecidas_sem_contrato: number;
  desconhecidas: number;
  /** `ConsultarRecebimento` que responderam (só NF desconhecida consulta). */
  consultadas: number;
  orfas_inseridas: number;
  puladas_por_tempo: number;
  erros: number;
  listagem_incompleta?: boolean;
  interrompido_por_timeout?: boolean;
}

export function novaRevisitaSummary(janela: string): RevisitaSummary {
  return {
    janela,
    documentos_listados: 0,
    ctes_ignorados: 0,
    canceladas_puladas: 0,
    ja_processadas_no_run: 0,
    puladas_invalidas: 0,
    conhecidas: 0,
    conhecidas_sem_contrato: 0,
    desconhecidas: 0,
    consultadas: 0,
    orfas_inseridas: 0,
    linhas_vinculadas: 0,
    ja_vinculadas: 0,
    conflito_outra_nf: 0,
    corrida_perdida: 0,
    puladas_por_tempo: 0,
    erros: 0,
  };
}

/** Teto de dias da janela: além disso a listagem pesa e a NF já saiu do horizonte do leadtime. */
const REVISITA_DIAS_MAX = 60;

/** `revisita_dias` do body → dias válidos, ou `null` (sem revisita). Nunca adivinha um valor. */
export function lerRevisitaDias(valor: unknown): number | null {
  if (typeof valor !== "number" || !Number.isInteger(valor)) return null;
  if (valor < 1 || valor > REVISITA_DIAS_MAX) return null;
  return valor;
}

const DATA_BR = /^(\d{2})\/(\d{2})\/(\d{4})$/;

function isoDeBR(d: string): string | null {
  const m = d.match(DATA_BR);
  if (!m) return null;
  const [dia, mes, ano] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(ano, mes - 1, dia));
  // Rejeita data inexistente (31/02 rola para março no Date): a volta tem de bater.
  if (t.getUTCFullYear() !== ano || t.getUTCMonth() !== mes - 1 || t.getUTCDate() !== dia) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Janela EXPLÍCITA da revisita (`revisita_de`/`revisita_ate`, dd/mm/aaaa) — o catch-up do histórico que a
 * janela diária não alcança, sem passar o laço principal (que sobrescreve a NF da linha) pelo período.
 * Exige as duas, válidas, em ordem e com no máximo 120 dias; senão `null` (sem revisita explícita).
 */
const REVISITA_EXPLICITA_DIAS_MAX = 120;
export function lerJanelaExplicita(de: unknown, ate: unknown): { de: string; ate: string } | null {
  if (typeof de !== "string" || typeof ate !== "string") return null;
  const a = isoDeBR(de), b = isoDeBR(ate);
  if (!a || !b || a > b) return null;
  const dias = (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
  return dias <= REVISITA_EXPLICITA_DIAS_MAX ? { de, ate } : null;
}

interface Elegivel {
  doc: DocumentoRevisita & { chave: string; fornecedor: number };
}

function porEmissaoAsc(a: Elegivel, b: Elegivel): number {
  const ea = a.doc.emissaoIso ?? "";
  const eb = b.doc.emissaoIso ?? "";
  if (ea !== eb) return ea < eb ? -1 : 1;
  return a.doc.nIdReceb - b.doc.nIdReceb;
}

export async function revisitarJanela(
  docs: DocumentoRevisita[],
  jaProcessadas: ReadonlySet<number>,
  porta: PortaRevisita,
  mapear: (raw: unknown) => NFeParaVinculo,
  opcoes: { agoraIso: () => string; temTempo: () => boolean; log?: (msg: string) => void; listagemIncompleta?: boolean },
  out: RevisitaSummary,
): Promise<RevisitaSummary> {
  const vistos = new Set<number>();
  const elegiveis: Elegivel[] = [];
  for (const doc of docs) {
    if (!(doc.nIdReceb > 0) || vistos.has(doc.nIdReceb)) continue;
    vistos.add(doc.nIdReceb);
    out.documentos_listados++;
    if (doc.cte) { out.ctes_ignorados++; continue; }
    if (doc.cancelada) { out.canceladas_puladas++; continue; }
    if (jaProcessadas.has(doc.nIdReceb)) { out.ja_processadas_no_run++; continue; }
    if (!doc.chave || !doc.fornecedor) { out.puladas_invalidas++; continue; }
    elegiveis.push({ doc: doc as Elegivel["doc"] });
  }
  if (opcoes.listagemIncompleta) {
    // Listagem parcial NÃO escreve (Codex 2026-10-18, P1): a ordem por emissão só vale sobre a janela INTEIRA —
    // com uma página faltando, a NF mais nova poderia ganhar a linha pelo CAS e fixar o t2 errado para sempre.
    out.listagem_incompleta = true;
    out.erros++;
    return out;
  }
  if (elegiveis.length === 0) return out;
  if (!opcoes.temTempo()) {
    out.puladas_por_tempo = elegiveis.length;
    out.interrompido_por_timeout = true;
    return out;
  }

  let conhecidas: Set<number>;
  try {
    conhecidas = await porta.conhecidas(elegiveis.map((e) => ({ nIdReceb: e.doc.nIdReceb, chave: e.doc.chave })));
  } catch (err) {
    // Sem saber quem é conhecida não dá para decidir órfã nem poupar a consulta: não revisita.
    out.erros++;
    opcoes.log?.(`[revisita] conhecidas erro: ${mensagemDeErro(err) ?? "erro sem mensagem"}`);
    return out;
  }

  elegiveis.sort(porEmissaoAsc);
  for (let i = 0; i < elegiveis.length; i++) {
    if (!opcoes.temTempo()) {
      out.puladas_por_tempo = elegiveis.length - i;
      out.interrompido_por_timeout = true;
      break;
    }
    const { doc } = elegiveis[i];
    const conhecida = conhecidas.has(doc.nIdReceb);
    if (conhecida) out.conhecidas++;
    else out.desconhecidas++;
    try {
      // Conhecida: os contratos vêm da própria listagem. Desconhecida: do detalhe, como no laço principal.
      let fonte: unknown = doc.bruto;
      if (!conhecida) {
        fonte = await porta.consultar(doc.nIdReceb);
        out.consultadas++;
      }
      const m = mapear(fonte);
      // A chave do documento lido tem de ser a da listagem: se diverge, não é esta NF.
      if (m.chave !== doc.chave) {
        out.erros++;
        opcoes.log?.(`[revisita] nIdReceb=${doc.nIdReceb}: chave do detalhe ≠ listagem — pulada`);
        continue;
      }
      if (m.status === "CANCELADO") { out.canceladas_puladas++; continue; }
      const contratos = extrairPedidosDoDetalhe(fonte);
      if (conhecida && contratos.length === 0) { out.conhecidas_sem_contrato++; continue; }

      const casou = await vincularContratosSemNF(
        porta, contratos, doc.fornecedor, doc.chave,
        // O nIdReceb é o desta mesma NF: a linha ganha chave e sinal juntos, e o backfill não a reconsulta.
        (linha) => ({ ...montarPatchVinculo(linha, m, opcoes.agoraIso()), nid_receb: doc.nIdReceb }),
        out,
      );
      if (!casou && !conhecida) {
        await porta.inserirOrfa(doc);
        out.orfas_inseridas++;
      }
    } catch (err) {
      out.erros++;
      opcoes.log?.(`[revisita] nIdReceb=${doc.nIdReceb} erro: ${mensagemDeErro(err) ?? "erro sem mensagem"}`);
    }
  }
  return out;
}
