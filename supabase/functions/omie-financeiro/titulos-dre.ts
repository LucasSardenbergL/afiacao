// Leitura dos títulos do MÊS que alimentam o `calcularDRE` (CR e CP, competência e caixa).
//
// Por que mora fora do `index.ts`: até aqui as quatro leituras eram um `select` ÚNICO, sem
// `.range()`. O PostgREST capa cada resposta em 1.000 linhas EM SILÊNCIO (CLAUDE.md → PostgREST),
// então um mês acima disso gravava em `fin_dre_snapshots` um DRE/CMV truncado com cara de dado
// real — e desde o #3168 o cron `fin-dre-recalculo-diario` executa esse cálculo TODO DIA. Pior mês
// medido em 2026-10-20 (psql-ro): 655 títulos (CR competência colacor, 2023-08) — margem de ~1,5×,
// não um limite de verdade. O `index.ts` importa `npm:@supabase/supabase-js`, e a suíte de edge
// roda com `--no-remote`; o módulo isolado é o que deixa o teste do 1.001º título dirigir a
// QUERY REAL desta leitura, e não uma cópia dela.
//
// Paginação: `fetchAllKeyset` canônico por `id` (PK uuid — única no recorte), NÃO `fetchAll` por
// offset. Challenge Codex desta entrega (reproduzido no teste "INSERT concorrente"): o EOF do
// helper é a página VAZIA, então até um mês de 655 títulos faz uma 2ª requisição — e um título
// inserido/re-datado pelo sync ENTRE as duas desloca o offset e devolve o último título DUAS
// vezes (competência nem passa por dedupe). O select único antigo não tinha esse risco; trocar
// truncamento por duplicata seria regressão. Keyset (`id > cursor`) não desloca: nenhuma linha
// repete nem some por posição. Não é snapshot transacional — um título que entra/sai do recorte
// durante a leitura pode ou não ser visto, como numa leitura única feita um instante antes/depois.
// A comparação de cursor do helper é de STRING em JS; para uuid em texto (hex minúsculo, hífens
// em posições fixas) ela coincide com a ordem do `uuid` no Postgres.
import { fetchAllKeyset } from "../_shared/paginate.ts";
import { FalhaLeituraCritica, type ErroPostgrest } from "../_shared/leitura-critica.ts";

/**
 * Teto de títulos num ÚNICO mês/empresa/tabela. 20.000 ≈ 30× o pior mês medido (655).
 * Estourar NÃO trunca: lança. Um mês com 20 mil títulos é anomalia (import duplicado, filtro
 * quebrado) e o DRE dele não deve ser gravado — ausente ≠ zero, e muito menos "parcial".
 * Protege também contra laço que não converge (servidor devolvendo página cheia para sempre).
 */
export const TETO_TITULOS_MES = 20_000;

// Contrato estrutural mínimo, local de propósito: o `QueryPostgrest` de `_shared/paginate.ts`
// não tem `neq`/`or`, e alargar aquela interface obrigaria todo fake que a implementa a crescer.
export interface QueryTitulos<T> extends PromiseLike<{ data: T[] | null; error: ErroPostgrest | null }> {
  select(colunas: string): QueryTitulos<T>;
  eq(coluna: string, valor: unknown): QueryTitulos<T>;
  neq(coluna: string, valor: unknown): QueryTitulos<T>;
  in(coluna: string, valores: readonly unknown[]): QueryTitulos<T>;
  gte(coluna: string, valor: unknown): QueryTitulos<T>;
  lt(coluna: string, valor: unknown): QueryTitulos<T>;
  gt(coluna: string, valor: unknown): QueryTitulos<T>;
  or(filtro: string): QueryTitulos<T>;
  order(coluna: string, opts?: { ascending?: boolean }): QueryTitulos<T>;
  limit(n: number): QueryTitulos<T>;
}
export interface BancoTitulos {
  from<T>(tabela: string): QueryTitulos<T>;
}

/**
 * Estouro do teto. Subclasse de `FalhaLeituraCritica` por dois motivos: `fetchAllKeyset` re-envelopa
 * em `REJEITADA` qualquer outra rejeição do `build` (apagando o modo), e o domínio fechado de
 * códigos de `_shared/leitura-critica.ts` não tem `TETO_EXCEDIDO` — alargá-lo mudaria o
 * fingerprint de toda edge que importa o módulo (fan-out de deploy) por um caso desta só.
 * A MARCA é a classe; a mensagem continua em domínio fechado (fonte = constante + mês).
 */
export class TetoTitulosExcedido extends FalhaLeituraCritica {
  constructor(fonte: string) {
    super(fonte, null);
    this.name = "TetoTitulosExcedido";
    this.message = `Leitura de ${fonte} passou de ${TETO_TITULOS_MES} títulos no mês — anomalia; DRE não é gravado parcial.`;
  }
}

export type TabelaTitulos = "fin_contas_receber" | "fin_contas_pagar";
type Linha = Record<string, unknown>;

/**
 * Keyset por `id` + teto. `filtrar` aplica os filtros de NEGÓCIO sobre a query; o cursor, a ordem,
 * o limite e o `id` no select são daqui — o call-site não tem como esquecer nenhum deles.
 * O `id` volta nas linhas (o keyset precisa lê-lo); quem consome ignora a coluna.
 */
async function paginarComTeto(
  db: BancoTitulos,
  tabela: TabelaTitulos,
  select: string,
  filtrar: (q: QueryTitulos<Linha>) => QueryTitulos<Linha>,
  label: string,
): Promise<Linha[]> {
  let lidas = 0;
  return await fetchAllKeyset<Linha, string>(
    (cursor, limite) => {
      // Checado ANTES de pedir a próxima página, sobre o que de fato VEIO até aqui.
      if (lidas >= TETO_TITULOS_MES) throw new TetoTitulosExcedido(label);
      let q = filtrar(db.from<Linha>(tabela).select(`${select}, id`));
      if (cursor !== null) q = q.gt("id", cursor);
      return q.order("id", { ascending: true }).limit(limite).then((r) => {
        if (Array.isArray(r.data)) lidas += r.data.length;
        return r;
      });
    },
    (l) => l.id as string,
    label,
  );
}

/** Competência: títulos EMITIDOS no mês, exceto cancelados. */
export function buscarTitulosCompetencia(
  db: BancoTitulos,
  p: { tabela: TabelaTitulos; select: string; company: string; inicioMes: string; fimMes: string },
): Promise<Linha[]> {
  return paginarComTeto(
    db, p.tabela, p.select,
    (q) =>
      q.eq("company", p.company).neq("status_titulo", "CANCELADO")
        .gte("data_emissao", p.inicioMes).lt("data_emissao", p.fimMes),
    `${p.tabela} competência ${p.company} ${p.inicioMes}`,
  );
}

/**
 * Caixa: baixado no mês pela data de baixa do Omie, OU sem baixa e vencido no mês. O ramo
 * "baixa derivada no mês" (v_titulo_baixas) continua no call-site, via `fetchTitulosPorCodigos`.
 * `inicioMes`/`fimMes` saem de `validateAno`/`validateMes` no call-site — o `.or()` não recebe
 * input livre.
 */
export function buscarTitulosCaixa(
  db: BancoTitulos,
  p: {
    tabela: TabelaTitulos;
    select: string;
    company: string;
    statuses: readonly string[];
    colunaBaixa: "data_recebimento" | "data_pagamento";
    inicioMes: string;
    fimMes: string;
  },
): Promise<Linha[]> {
  const c = p.colunaBaixa;
  return paginarComTeto(
    db, p.tabela, p.select,
    (q) =>
      q.eq("company", p.company).in("status_titulo", p.statuses)
        .or(`and(${c}.gte.${p.inicioMes},${c}.lt.${p.fimMes}),and(${c}.is.null,data_vencimento.gte.${p.inicioMes},data_vencimento.lt.${p.fimMes})`),
    `${p.tabela} caixa ${p.company} ${p.inicioMes}`,
  );
}
