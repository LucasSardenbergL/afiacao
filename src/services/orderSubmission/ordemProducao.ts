// PR 8.4 (rodada 3 do Novo Pedido): desfecho HONESTO da ordem de produção no envio.
//
// A edge `omie-vendas-sync` (v1.48) responde `criar_ordem_producao` com `{ success, falhas, desfecho[] }`,
// um desfecho por produto (`criada` · `falhou` + tipo + motivo + quantidade + chave `cCodIntOP`). Antes o envio
// ignorava a resposta e o vendedor via "OP criada" para uma OP que o Omie recusou.
//
// A mensagem segue o TIPO da falha (rodadas 2 e 3 do Codex):
//   • `invalido`: uma linha não pôde ir ao Omie — mas outras linhas do MESMO item podem ter virado OP, então
//     nunca diz "o produto não foi enviado": manda conferir antes de criar à mão;
//   • `sem_registro_local`: a OP EXISTE no Omie — NÃO criar outra, pedir a conferência do vínculo;
//   • `indeterminado` (ou tipo ausente/desconhecido, e erro de transporte): pode ser recusa OU timeout depois
//     de o Omie gravar — conferir no Omie as OPs do produto pelo TOTAL (a edge junta as linhas do mesmo código
//     numa OP só) antes de criar outra. A chave `cCodIntOP` não aparece na tela do Omie: nunca é a instrução.

interface DesfechoOpResposta {
  status?: unknown;
  tipo?: unknown;
  motivo?: unknown;
  descricao?: unknown;
  quantidade?: unknown;
}

interface OpLegada {
  id?: unknown;
  omie_ordem_id?: unknown;
  descricao?: unknown;
}

/** Item enviado à OP, para o aviso de transporte (o invoke falhou: não há desfecho da edge). */
export interface ItemEnviadoOp {
  descricao?: string | null;
  omie_codigo_produto?: number | null;
  quantidade?: number | null;
}

const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const qtd = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const idPositivo = (v: unknown): boolean => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0;
};

function mensagemIndeterminada(produto: string | null, motivo: string | null, total: number | null): string {
  const nome = produto ?? 'produto';
  const quanto = total !== null ? ` (${total} no total, numa OP só)` : '';
  return `Ordem de produção de ${nome}${quanto} não foi confirmada no Omie: ${motivo ?? 'sem detalhe do Omie'}. `
    + `Ela pode já existir: antes de criar outra à mão, confira no Omie as ordens de produção de ${nome} (produto e quantidade).`;
}

function mensagem(tipo: string | null, produto: string | null, motivo: string | null, total: number | null): string {
  const nome = produto ?? 'produto';
  if (tipo === 'invalido') {
    return `Uma linha de ${nome} não pôde ir ao Omie: ${motivo ?? 'item inválido'}. `
      + `Outras linhas de ${nome} podem ter virado OP: confira no Omie as ordens de produção de ${nome} antes de criar à mão.`;
  }
  if (tipo === 'sem_registro_local') {
    return `Ordem de produção de ${nome}: ${motivo ?? 'a OP existe no Omie, mas o app não confirmou o registro local'}. `
      + 'Não crie outra — peça a conferência do vínculo no app.';
  }
  return mensagemIndeterminada(produto, motivo, total);
}

/** Mensagens de falha para o resumo do envio, uma por produto que ficou sem OP confirmada. */
export function falhasDaOrdemProducao(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const r = data as { success?: unknown; desfecho?: unknown; production_orders?: unknown };
  if (Array.isArray(r.desfecho)) {
    return (r.desfecho as DesfechoOpResposta[])
      .filter((d) => d && d.status === 'falhou')
      .map((d) => mensagem(texto(d.tipo), texto(d.descricao), texto(d.motivo), qtd(d.quantidade)));
  }
  // Edge antiga (≤ v1.47): `success` sempre true; a recusa só aparece como OP sem id remoto na lista
  // (o id remoto pode vir em texto: a v1.47 repassa o `nCodOP` sem converter).
  if (Array.isArray(r.production_orders)) {
    const semId = (r.production_orders as OpLegada[]).filter((o) => !idPositivo(o?.omie_ordem_id));
    if (semId.length) return semId.map((o) => mensagemIndeterminada(texto(o?.descricao), null, null));
  }
  return r.success === false ? [mensagemIndeterminada(null, null, null)] : [];
}

/** Erro de TRANSPORTE (o invoke falhou ou estourou o tempo): a edge pode ter criado parte das OPs. Um aviso por
 *  CÓDIGO Omie com a quantidade SOMADA — a edge cria uma OP só por código, então a conferência é pelo total. */
export function falhasDeTransporteOp(itens: ItemEnviadoOp[], motivo: string): string[] {
  const grupos = new Map<string, { nome: string | null; total: number | null }>();
  itens.forEach((it, i) => {
    const chave = typeof it.omie_codigo_produto === 'number' && it.omie_codigo_produto > 0
      ? `c:${it.omie_codigo_produto}` : `l:${i}`;
    const q = qtd(it.quantidade);
    const g = grupos.get(chave);
    if (!g) { grupos.set(chave, { nome: texto(it.descricao), total: q }); return; }
    g.total = g.total !== null && q !== null ? g.total + q : null;
  });
  const lista = [...grupos.values()];
  return (lista.length ? lista : [{ nome: null, total: null }]).map((g) => mensagemIndeterminada(g.nome, motivo, g.total));
}
