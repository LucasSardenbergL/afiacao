// Leituras COMPLETAS que viram mapa/conjunto de lookup, compartilhadas entre edges.
//
// Por que existe (docs/agent/money-path.md §6/§7): estas três leituras estavam escritas à
// mão em 6 lugares, todas com o MESMO defeito — `const { data } = await ...range(...)`
// descartando `error`, e `data:null`/lista vazia tratados como fim da tabela. Página que
// falha (timeout 57014, RLS, 500) virava "acabou", e o acumulado PARCIAL seguia como se
// fosse a tabela inteira. Paginar cura a CAPA de 1.000 do PostgREST, não a FALHA NO MEIO.
//
// O dano não é "menos linhas": é TROCA DE ESCOPO silenciosa, diferente em cada caller —
// ver o comentário de cada função. Por isso a leitura mora aqui, com `fetchAll` (que
// LANÇA em página com erro) e `.order()` estável, em vez de repetida em cada index.ts.
//
// `BancoPostgrest` (contrato estrutural) e não `SupabaseClient`: `test:edges` roda com
// `--no-remote`, então um módulo testável não pode importar `npm:` nem para tipo. O
// call-site passa `supabase as unknown as BancoPostgrest` (padrão do monthly-report).
import { fetchAll, type BancoPostgrest } from "./paginate.ts";

export interface LinhaAssignment {
  customer_user_id: string;
  owner_user_id: string;
  eligible: boolean;
}

// Carteira inteira. `.order('customer_user_id')` é estável porque a coluna é UNIQUE em
// prod (`carteira_assignments_customer_user_id_key`) — conferido, não suposto: ordenar
// por coluna não-única deixa a paginação instável do mesmo jeito.
export async function carregarCarteiraComElegibilidade(
  db: BancoPostgrest,
): Promise<LinhaAssignment[]> {
  return await fetchAll<LinhaAssignment>(
    (de, ate) =>
      db.from<LinhaAssignment>("carteira_assignments")
        .select("customer_user_id, owner_user_id, eligible")
        .order("customer_user_id", { ascending: true })
        .range(de, ate),
    "carteira_assignments",
  );
}

// customer_user_id → owner_user_id (dono da carteira).
//
// ANTI-DRIFT: quem consome usa `ownerMap.get(cliente) ?? farmer_id_da_atividade`. Com o
// mapa PARCIAL o `??` assume o volante e o score vai para QUEM LIGOU em vez do DONO —
// exatamente o que o comentário do caller proíbe ("nunca do farmer_id da ligação"). A
// falha de transporte reescrevia a regra de atribuição sem deixar rastro.
export async function carregarOwnerMap(db: BancoPostgrest): Promise<Map<string, string>> {
  const linhas = await carregarCarteiraComElegibilidade(db);
  const mapa = new Map<string, string>();
  for (const l of linhas) mapa.set(l.customer_user_id, l.owner_user_id);
  return mapa;
}

export interface LinhaPedidoMes {
  customer_user_id: string;
  total: number | null;
  order_date_kpi: string;
}

// Pedidos VÁLIDOS de um mês fechado, para o snapshot de positivação.
//
// É o caller mais perigoso dos seis: o resultado não é exibido, é GRAVADO congelado.
// Uma página perdida não some da tela — vira `had_order_in_month:false` e
// `revenue_month:0` para um cliente que comprou de verdade, num mês que ninguém vai
// recalcular. "Não consegui ler" carimbado como "não comprou" (§2, ausente ≠ zero).
export async function carregarPedidosDoMes(
  db: BancoPostgrest,
  mesIso: string,
  fimIso: string,
): Promise<LinhaPedidoMes[]> {
  return await fetchAll<LinhaPedidoMes>(
    (de, ate) =>
      db.from<LinhaPedidoMes>("sales_orders")
        .select("customer_user_id, total, order_date_kpi")
        .not("status", "in", "(cancelado,rascunho,pendente)")
        .gte("order_date_kpi", mesIso)
        .lt("order_date_kpi", fimIso)
        .order("id", { ascending: true })
        .range(de, ate),
    "sales_orders",
  );
}

// user_ids marcados para NÃO entrar na carteira (fornecedores etc.).
//
// É um filtro NEGATIVO: conjunto parcial não "mostra menos", faz entrar quem devia ficar
// de fora — o excluído volta ao fan-out do decay e ganha score.
export async function carregarExcluidosDaCarteira(db: BancoPostgrest): Promise<Set<string>> {
  const linhas = await fetchAll<{ user_id: string }>(
    (de, ate) =>
      db.from<{ user_id: string }>("cliente_classificacao")
        .select("user_id")
        .eq("excluir_da_carteira", true)
        .order("user_id", { ascending: true })
        .range(de, ate),
    "cliente_classificacao",
  );
  return new Set(linhas.map((l) => l.user_id));
}

interface LinhaProduto {
  id: string | null;
  omie_codigo_produto: number | string | null;
}

// omie_codigo_produto → product_id, SEMPRE por empresa.
//
// Mapa parcial faz produto legítimo resolver `product_id: null` no item do pedido — e o
// sync GRAVA esse null. Não é fabricar número (§2), mas é perda de vínculo persistida:
// o item some dos joins de custo/margem e o pedido fica órfão de produto.
//
// O `.eq('account', ...)` é money-path: `omie_products` é UNIQUE (omie_codigo_produto,
// account) e o MESMO código existe em mais de uma empresa — resolver account-blind grava
// o custo de uma no product_id da outra (ver `product-idmap.ts`). Aqui vale last-wins
// (o filtro por account já torna o código único); a nulificação por ambiguidade de
// `buildProductIdMap` é para o caminho account-blind do inventário, e mudá-la aqui seria
// mudança de comportamento fora do escopo desta correção.
export async function carregarProductMap(
  db: BancoPostgrest,
  account: string,
): Promise<Map<number, string>> {
  const linhas = await fetchAll<LinhaProduto>(
    (de, ate) =>
      db.from<LinhaProduto>("omie_products")
        .select("id, omie_codigo_produto")
        .eq("account", account)
        .order("id", { ascending: true })
        .range(de, ate),
    "omie_products",
  );
  const mapa = new Map<number, string>();
  for (const l of linhas) {
    if (l.id == null || l.omie_codigo_produto == null) continue;
    // Number(null) === 0 fabricaria a chave 0 e daria match em produto inexistente; e o
    // lookup a jusante usa o NÚMERO vindo da API Omie, então chave string erraria sempre.
    const cod = Number(l.omie_codigo_produto);
    if (!Number.isSafeInteger(cod) || cod <= 0) continue;
    mapa.set(cod, String(l.id));
  }
  return mapa;
}
