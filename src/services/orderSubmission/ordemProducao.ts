// PR 8.4 (rodada 3 do Novo Pedido): desfecho HONESTO da ordem de produção no envio.
//
// A edge `omie-vendas-sync` (v1.48) responde `criar_ordem_producao` com `{ success, falhas, desfecho[] }`,
// um desfecho por produto (`criada` · `falhou` + tipo + motivo). Antes o envio ignorava a resposta e o
// vendedor via "OP criada" para uma OP que o Omie recusou.
//
// NÚCLEO (corte após 4 rodadas do Codex): a mensagem diz o que NÃO se sabe e nunca manda criar à mão nem
// cita quantidade a procurar. Toda instrução do tipo "confira e crie" virou P0 numa borda nova — timeout que
// grava depois, OP agregada vs. linhas, edge antiga vs. nova, envio ainda em curso. O que é seguro dizer:
//   • `sem_registro_local`: a OP EXISTE no Omie — não crie outra, peça a conferência do vínculo;
//   • qualquer outra falha (inválida, indeterminada, tipo ausente, erro de transporte): a OP não foi confirmada —
//     NÃO crie à mão; peça a quem cuida da produção para conferir no Omie.

interface DesfechoOpResposta {
  status?: unknown;
  tipo?: unknown;
  motivo?: unknown;
  descricao?: unknown;
}

interface OpLegada {
  omie_ordem_id?: unknown;
  descricao?: unknown;
}

const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const idPositivo = (v: unknown): boolean => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0;
};

function mensagemNaoConfirmada(produto: string | null, motivo: string | null): string {
  return `Ordem de produção de ${produto ?? 'produto'} não confirmada no Omie: ${motivo ?? 'sem detalhe do Omie'}. `
    + 'Não crie à mão — peça a quem cuida da produção para conferir no Omie.';
}

function mensagem(tipo: string | null, produto: string | null, motivo: string | null): string {
  if (tipo === 'sem_registro_local') {
    return `Ordem de produção de ${produto ?? 'produto'}: ${motivo ?? 'a OP existe no Omie, mas o app não confirmou o registro local'}. `
      + 'Não crie outra — peça a conferência do vínculo no app.';
  }
  return mensagemNaoConfirmada(produto, motivo);
}

/** Mensagens de falha para o resumo do envio, uma por produto que ficou sem OP confirmada. */
export function falhasDaOrdemProducao(data: unknown): string[] {
  // Corpo ausente/ilegível sem `error` do invoke = OP NÃO confirmada (a chamada só sai com itens a produzir).
  if (!data || typeof data !== 'object') return [mensagemNaoConfirmada(null, null)];
  const r = data as { success?: unknown; desfecho?: unknown; production_orders?: unknown };
  if (Array.isArray(r.desfecho)) {
    const falhas = (r.desfecho as DesfechoOpResposta[])
      .filter((d) => d && d.status === 'falhou')
      .map((d) => mensagem(texto(d.tipo), texto(d.descricao), texto(d.motivo)));
    // `success: false` sem falha detalhada (5ª rodada do Codex, P1): não fica calado.
    return falhas.length === 0 && r.success === false ? [mensagemNaoConfirmada(null, null)] : falhas;
  }
  // Edge antiga (≤ v1.47): `success` sempre true; a recusa só aparece como OP sem id remoto na lista
  // (o id remoto pode vir em texto: a v1.47 repassa o `nCodOP` sem converter).
  if (Array.isArray(r.production_orders)) {
    const semId = (r.production_orders as OpLegada[]).filter((o) => !idPositivo(o?.omie_ordem_id));
    if (semId.length) return semId.map((o) => mensagemNaoConfirmada(texto(o?.descricao), null));
  }
  return r.success === false ? [mensagemNaoConfirmada(null, null)] : [];
}

/** Erro de TRANSPORTE (o invoke falhou ou estourou o tempo): a edge pode ter criado parte das OPs ou ainda
 *  estar criando. Um aviso por produto (nome repetido conta uma vez), sem quantidade e sem mandar criar. */
export function falhasDeTransporteOp(produtos: (string | null | undefined)[], motivo: string): string[] {
  const nomes = [...new Set(produtos.map((p) => texto(p)))];
  return (nomes.length ? nomes : [null]).map((p) => mensagemNaoConfirmada(p, motivo));
}
