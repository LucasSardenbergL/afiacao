/**
 * Fila de cobrança com estado e dona (Frente B do plano Oben PME/PMR, PR2).
 * Fatos vêm das RPCs `cobranca_fila` / `cobranca_regua_hoje` (SECURITY DEFINER, gate staff, visibilidade
 * por dona/gestão); regra de tela aqui, pura e testável. Dinheiro ausente é `null`, nunca 0.
 */

export type EstadoCobranca = 'a_contatar' | 'contatado' | 'promessa' | 'pago_informado' | 'negociado' | 'disputa';
/** Estado derivado da fila: caso cancelado pela gestão e vencido ainda na view (não é `a_contatar`). */
export type EstadoFila = EstadoCobranca | 'cancelado_gestao';
export type FaixaCobranca = '<=45d' | '46-90d' | '>90d';
/** `saldo_caiu`, não "cumprida": sem baixa não se afirma recebimento (pode ser cancelamento/renegociação). */
export type SituacaoPromessa = 'aberta' | 'vencida' | 'saldo_caiu';
export type CanalContato = 'whatsapp' | 'telefone' | 'email' | 'presencial';

const ESTADOS: ReadonlyArray<EstadoCobranca> = ['a_contatar', 'contatado', 'promessa', 'pago_informado', 'negociado', 'disputa'];
export const ROTULO_ESTADO: Record<EstadoFila, string> = {
  a_contatar: 'A contatar', contatado: 'Contatado', promessa: 'Promessa', pago_informado: 'Pago (informado)',
  negociado: 'Negociado', disputa: 'Em disputa', cancelado_gestao: 'Cancelado (gestão)',
};
export const ROTULO_PROMESSA: Record<SituacaoPromessa, string> = { aberta: 'aberta', vencida: 'vencida', saldo_caiu: 'saldo caiu (sem baixa confirmada)' };
export const ROTULO_FAIXA: Record<FaixaCobranca, string> = { '<=45d': 'Até 45 dias', '46-90d': '46 a 90 dias', '>90d': 'Mais de 90 dias' };
const ORDEM_FAIXA: ReadonlyArray<FaixaCobranca> = ['<=45d', '46-90d', '>90d'];
export const CANAIS: ReadonlyArray<{ codigo: CanalContato; rotulo: string }> = [
  { codigo: 'whatsapp', rotulo: 'WhatsApp' }, { codigo: 'telefone', rotulo: 'Telefone' },
  { codigo: 'email', rotulo: 'E-mail' }, { codigo: 'presencial', rotulo: 'Presencial' },
];

export type FilaItem = {
  company: string; omieCodigoCliente: number; nomeCliente: string | null;
  saldoVencido: number | null; nVencidas: number | null; diasVencidoMax: number | null; faixa: FaixaCobranca | null;
  donaUserId: string | null; donaNome: string | null;
  casoId: string | null; estado: EstadoFila; proximoContatoEm: string | null; notaAtual: string | null; atualizadoEm: string | null;
  promessaId: string | null; promessaData: string | null; promessaValor: number | null; promessaSituacao: SituacaoPromessa | null;
  saldoInicialCoorte: number | null; nTitulosCoorte: number | null; saldoAtualCoorte: number | null; coorteCorteEm: string | null;
  ultimoContatoEm: string | null; nContatos: number; podeAgir: boolean; podeQuitar: boolean;
};

export type ReguaItem = {
  marco: 'D-2' | 'D+1' | 'D+7'; company: string; omieCodigoCliente: number; nomeCliente: string | null;
  omieCodigoLancamento: number; numeroDocumento: string | null; dataVencimento: string; saldo: number | null;
  telefone: string | null; donaUserId: string | null; casoId: string | null; estado: EstadoCobranca | null; podeAgir: boolean;
};

function num(x: unknown): number | null {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'string' && x.trim() !== '') { const n = Number(x); return Number.isFinite(n) ? n : null; }
  return null;
}
const str = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null);
const ehEstado = (x: unknown): x is EstadoCobranca => typeof x === 'string' && (ESTADOS as readonly string[]).includes(x);
const ehEstadoFila = (x: unknown): x is EstadoFila => ehEstado(x) || x === 'cancelado_gestao';
const ehFaixa = (x: unknown): x is FaixaCobranca => x === '<=45d' || x === '46-90d' || x === '>90d';

/** Linha da RPC `cobranca_fila` → item de tela. Linha sem cliente é descartada (sem chave não há fila). */
export function normalizarFila(row: Record<string, unknown>): FilaItem | null {
  const codigo = num(row.omie_codigo_cliente);
  const company = str(row.company);
  if (codigo === null || !company) return null;
  const sit = row.promessa_situacao;
  return {
    company, omieCodigoCliente: codigo, nomeCliente: str(row.nome_cliente),
    saldoVencido: num(row.saldo_vencido), nVencidas: num(row.n_vencidas), diasVencidoMax: num(row.dias_vencido_max),
    faixa: ehFaixa(row.faixa) ? row.faixa : null,
    donaUserId: str(row.dona_user_id), donaNome: str(row.dona_nome),
    casoId: str(row.caso_id), estado: ehEstadoFila(row.estado) ? row.estado : 'a_contatar',
    proximoContatoEm: str(row.proximo_contato_em), notaAtual: str(row.nota_atual), atualizadoEm: str(row.atualizado_em),
    promessaId: str(row.promessa_id), promessaData: str(row.promessa_data), promessaValor: num(row.promessa_valor),
    promessaSituacao: sit === 'aberta' || sit === 'vencida' || sit === 'saldo_caiu' ? sit : null,
    saldoInicialCoorte: num(row.saldo_inicial_coorte), nTitulosCoorte: num(row.n_titulos_coorte),
    saldoAtualCoorte: num(row.saldo_atual_coorte), coorteCorteEm: str(row.coorte_corte_em),
    ultimoContatoEm: str(row.ultimo_contato_em), nContatos: num(row.n_contatos) ?? 0, podeAgir: row.pode_agir === true,
    podeQuitar: row.pode_quitar === true,
  };
}

export function normalizarRegua(row: Record<string, unknown>): ReguaItem | null {
  const codigo = num(row.omie_codigo_cliente);
  const lanc = num(row.omie_codigo_lancamento);
  const company = str(row.company);
  const marco = row.marco;
  const venc = str(row.data_vencimento);
  if (codigo === null || lanc === null || !company || !venc || (marco !== 'D-2' && marco !== 'D+1' && marco !== 'D+7')) return null;
  return {
    marco, company, omieCodigoCliente: codigo, nomeCliente: str(row.nome_cliente), omieCodigoLancamento: lanc,
    numeroDocumento: str(row.numero_documento), dataVencimento: venc, saldo: num(row.saldo), telefone: str(row.telefone),
    donaUserId: str(row.dona_user_id), casoId: str(row.caso_id), estado: ehEstado(row.estado) ? row.estado : null, podeAgir: row.pode_agir === true,
  };
}

/** Estados que a tela oferece a partir do atual. `promessa` só pela ação própria (data + valor); fechar é ação à parte. */
export function proximosEstados(atual: EstadoCobranca): EstadoCobranca[] {
  const todos: EstadoCobranca[] = ['a_contatar', 'contatado', 'pago_informado', 'negociado', 'disputa'];
  return todos.filter((e) => e !== atual);
}

/** Agrupa por faixa na ordem de ataque (recentes antes de envelhecer); dentro, saldo DESC (a RPC já ordena). */
export function agruparPorFaixa(itens: FilaItem[]): Array<{ faixa: FaixaCobranca | 'sem_vencido'; itens: FilaItem[]; saldo: number | null }> {
  const grupos = new Map<FaixaCobranca | 'sem_vencido', FilaItem[]>();
  for (const it of itens) {
    const k = it.faixa ?? 'sem_vencido';
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k)!.push(it);
  }
  const ordem: Array<FaixaCobranca | 'sem_vencido'> = [...ORDEM_FAIXA, 'sem_vencido'];
  return ordem.filter((k) => grupos.has(k)).map((k) => {
    const lista = grupos.get(k)!;
    const comSaldo = lista.filter((i) => i.saldoVencido !== null);
    return { faixa: k, itens: lista, saldo: comSaldo.length === lista.length ? comSaldo.reduce((a, i) => a + (i.saldoVencido ?? 0), 0) : null };
  });
}

/**
 * Variação do saldo da coorte pelos MESMOS títulos congelados (rótulo honesto: NÃO é "recuperado" — cancelamento e
 * renegociação também baixam). Atual desconhecido (título sumiu da fonte) ⇒ `null`, nunca 0.
 */
export function variacaoCoorte(it: FilaItem): { inicial: number; atual: number; variacao: number } | null {
  if (it.saldoInicialCoorte === null || it.saldoAtualCoorte === null) return null;
  return { inicial: it.saldoInicialCoorte, atual: it.saldoAtualCoorte, variacao: it.saldoInicialCoorte - it.saldoAtualCoorte };
}

/**
 * Valor em R$ digitado: aceita `1234`, `1234,50`, `1.234,50` (pt-BR) e `1234.50` (ponto decimal). Rejeita grupos de
 * milhar inválidos (`1.2.3`, `1250.50` com vírgula ausente mas 2 casas após ponto é DECIMAL, não milhar) — nunca
 * multiplica por 100 em silêncio (achado Codex: `1250.50 → 125050`).
 */
export function parseValorBR(texto: string): number | null {
  const t = texto.trim();
  if (t === '') return null;
  let n: number;
  if (/^\d{1,3}(\.\d{3})*(,\d{1,2})?$/.test(t)) n = Number(t.replace(/\./g, '').replace(',', '.'));
  else if (/^\d+(,\d{1,2})?$/.test(t)) n = Number(t.replace(',', '.'));
  else if (/^\d+(\.\d{1,2})?$/.test(t)) n = Number(t);
  else return null;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Telefone BR para `wa.me`: só dígitos; 10–11 dígitos = DDD+número (prefixa 55); 12–13 começando por 55 = já com DDI.
 * Fora disso ⇒ `null` (sem botão) — texto não vazio não é destino válido (achado Codex: `(55) 99999-0010` virava DDI).
 */
export function telefoneWa(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = raw.replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) return `55${d}`;
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return d;
  return null;
}

export function urlWa(telefone: string, mensagem: string): string {
  return `https://wa.me/${telefone}?text=${encodeURIComponent(mensagem)}`;
}

/** Formatadores do módulo (não se importa `@/lib/reposicao`: fronteira entre módulos). */
export const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const dataBr = (iso: string) => { const [a, m, d] = iso.slice(0, 10).split('-'); return `${d}/${m}/${a}`; };

/** Mensagem da régua para o WhatsApp (abre o app; o envio é do humano — nunca automático). */
export function mensagemRegua(it: ReguaItem, empresa: string): string {
  const nome = it.nomeCliente ? `, ${it.nomeCliente}` : '';
  const doc = it.numeroDocumento ? ` (NF ${it.numeroDocumento})` : '';
  const valor = it.saldo !== null ? ` de ${brl(it.saldo)}` : '';
  const venc = dataBr(it.dataVencimento);
  if (it.marco === 'D-2') return `Olá${nome}! Aqui é da ${empresa}. Passando para lembrar que o boleto${doc}${valor} vence em ${venc}. Qualquer dúvida, estamos à disposição.`;
  if (it.marco === 'D+1') return `Olá${nome}! Aqui é da ${empresa}. Não identificamos o pagamento do boleto${doc}${valor} com vencimento em ${venc}. Pode confirmar se já foi pago ou se precisa da 2ª via?`;
  return `Olá${nome}! Aqui é da ${empresa}. O boleto${doc}${valor} venceu em ${venc} e segue em aberto há 7 dias. Podemos combinar o pagamento? Se preferir, enviamos a 2ª via atualizada.`;
}
