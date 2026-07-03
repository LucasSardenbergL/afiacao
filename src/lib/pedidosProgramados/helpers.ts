// Helpers PUROS dos pedidos programados (Lider). Sem imports de runtime — as edges
// pedido-programado-* ESPELHAM estas funções (Deno não importa de src/; padrão do repo,
// ver omie-vendas-sync/index.ts:1488). Qualquer mudança aqui → replicar no espelho.

export type AccountPP = 'oben' | 'colacor';

export interface ConfigConta {
  account: AccountPP;
  codigo_cliente_omie: number | null;
  customer_user_id: string | null;
  obs_venda: string | null;
  dados_adicionais_nf: string | null;
  codigo_parcela: string | null;
}

// Item do envio já resolvido via de-para (JOIN cliente_item_mapa → omie_products)
export interface ItemResolvido {
  id: string;
  codigo_item_cliente: string;
  descricao_cliente: string;
  // quantidade/preco_final: number JÁ convertido pelo caller (numeric do PostgREST pode
  // vir como string — quem monta ItemResolvido converte com Number(...); aqui typeof
  // 'number' é a borda: string crua = item inválido, bloqueia por segurança).
  quantidade: number;
  preco_final: number | null;
  account: AccountPP | null;          // null = sem mapeamento
  omie_codigo_produto: number | null; // null = sem mapeamento
  produto_codigo: string | null;
  produto_descricao: string | null;
}

// nº do PC primeiro (exigência da Lider: "FAVOR INFORMAR O NUMERO DO PEDIDO DA LIDER
// NA NOTA FISCAL"), mensagem fixa depois. Sem mensagem → só o nº (nunca fabricar texto).
export function montarDadosAdicionaisNf(mensagemFixa: string | null, numeroPc: string): string {
  if (!numeroPc || !numeroPc.trim()) {
    throw new Error('numeroPc obrigatório para montar os dados adicionais da NF.');
  }
  const cabeca = `PEDIDO DE COMPRA Nº: ${numeroPc.trim()}`;
  const msg = (mensagemFixa ?? '').trim();
  return msg ? `${cabeca}\n\n${msg}` : cabeca;
}

export function agruparItensPorAccount(itens: ItemResolvido[]): Partial<Record<AccountPP, ItemResolvido[]>> {
  const grupos: Partial<Record<AccountPP, ItemResolvido[]>> = {};
  for (const item of itens) {
    if (!item.account) continue; // sem mapeamento — validarEnvioResolvido já barrou antes
    (grupos[item.account] ??= []).push(item);
  }
  return grupos;
}

// Precisão > recall: retorna a lista de PROBLEMAS (vazia = pode enviar).
// Ausente ≠ zero: preco_final NULL bloqueia, nunca vira 0.
export function validarEnvioResolvido(
  numeroPc: string | null,
  itens: ItemResolvido[],
  configs: Record<AccountPP, ConfigConta>,
): string[] {
  const problemas: string[] = [];
  if (!numeroPc || !numeroPc.trim()) {
    problemas.push('Pedido sem número de pedido de compra — re-extraia o PDF antes de enviar.');
  }
  if (itens.length === 0) problemas.push('Envio sem itens.');
  const accountsEnvolvidas = new Set<AccountPP>();
  for (const it of itens) {
    const rotulo = `${it.codigo_item_cliente} (${it.descricao_cliente})`;
    if (!it.account || !it.omie_codigo_produto) {
      problemas.push(`Item ${rotulo} sem mapeamento para produto interno.`);
      continue;
    }
    accountsEnvolvidas.add(it.account);
    if (typeof it.preco_final !== 'number' || !Number.isFinite(it.preco_final) || it.preco_final <= 0) {
      problemas.push(`Item ${rotulo} sem preço final válido (> 0).`);
    }
    if (typeof it.quantidade !== 'number' || !Number.isFinite(it.quantidade) || it.quantidade <= 0) {
      problemas.push(`Item ${rotulo} com quantidade inválida.`);
    }
  }
  for (const acc of accountsEnvolvidas) {
    const cfg = configs[acc];
    if (!cfg || !cfg.codigo_cliente_omie) {
      problemas.push(`Config da ${acc} incompleta: cliente não cadastrado/sem código Omie.`);
    } else {
      if (!cfg.customer_user_id) problemas.push(`Config da ${acc} incompleta: customer_user_id ausente.`);
      if (!(cfg.dados_adicionais_nf ?? '').trim()) problemas.push(`Config da ${acc} incompleta: mensagem de Dados Adicionais da NF vazia.`);
      if (!(cfg.obs_venda ?? '').trim()) problemas.push(`Config da ${acc} incompleta: mensagem de Observações vazia.`);
    }
  }
  return problemas;
}

// ── Validação da extração do LLM (espelhada na edge pedido-programado-extrair) ──
export interface ItemExtraido {
  codigo_item_cliente: string;
  num_ordem_cliente: string | null;
  descricao_cliente: string;
  quantidade: number;
  unidade: string | null;
  preco_unitario: number | null;  // referência; sempre "vem errado" (founder ajusta)
  data_entrega: string | null;    // YYYY-MM-DD
  cod_forn: string | null;        // NOSSO código impresso no PDF (semente de sugestão)
}
export interface ExtracaoValidada {
  numero_pedido_compra: string;
  data_emissao: string | null;    // YYYY-MM-DD
  versao: string | null;
  itens: ItemExtraido[];
}
export type ResultadoValidacao = { ok: true; dados: ExtracaoValidada } | { ok: false; erro: string };

const RE_ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function isoOuNull(v: unknown): string | null {
  return typeof v === 'string' && RE_ISO_DATE.test(v) ? v : null;
}
function numeroPositivoOuNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}
function textoOuNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function validarExtracao(bruto: unknown): ResultadoValidacao {
  const b = bruto as Record<string, unknown> | null;
  const numeroPc = textoOuNull(b?.numero_pedido_compra);
  if (!numeroPc) return { ok: false, erro: 'Extração sem numero_pedido_compra — PDF ilegível ou fora do layout.' };
  const itensBrutos = Array.isArray(b?.itens) ? (b.itens as Array<Record<string, unknown>>) : [];
  if (itensBrutos.length === 0) return { ok: false, erro: 'Extração sem itens.' };
  const itens: ItemExtraido[] = [];
  for (const [i, it] of itensBrutos.entries()) {
    const codigo = textoOuNull(it?.codigo_item_cliente);
    const descricao = textoOuNull(it?.descricao_cliente);
    const quantidade = numeroPositivoOuNull(it?.quantidade);
    if (!codigo || !descricao || quantidade === null) {
      return { ok: false, erro: `Item ${i + 1} sem código/descrição/quantidade válidos — revisar PDF.` };
    }
    itens.push({
      codigo_item_cliente: codigo,
      num_ordem_cliente: textoOuNull(it?.num_ordem_cliente),
      descricao_cliente: descricao,
      quantidade,
      unidade: textoOuNull(it?.unidade),
      preco_unitario: numeroPositivoOuNull(it?.preco_unitario),
      data_entrega: isoOuNull(it?.data_entrega),
      cod_forn: textoOuNull(it?.cod_forn),
    });
  }
  return {
    ok: true,
    dados: {
      numero_pedido_compra: numeroPc,
      data_emissao: isoOuNull(b?.data_emissao),
      versao: textoOuNull(b?.versao),
      itens,
    },
  };
}
