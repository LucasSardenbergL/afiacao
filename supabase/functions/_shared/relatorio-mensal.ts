// Núcleo do relatório mensal de ferramentas (edge `monthly-report`).
//
// Mora em `_shared/` — e não dentro de `monthly-report/` — porque é aqui que vive a lógica
// de edge COBERTA POR TESTE no repo (`*_test.ts` ao lado, `bun run test:edges`). O `index.ts`
// da edge fica só com HTTP, auth, template de e-mail e envio.
//
// O banco entra por INJEÇÃO (`BancoPostgrest`), não como `SupabaseClient`: é o que permite
// contar quantas idas ao banco a função faz — o invariante que esta unidade existe para
// proteger (ver `relatorio-mensal_test.ts` → "custo de banco não cresce com a base").
//
// ⚠️ A DIREÇÃO DA CONSULTA É O DESENHO, não detalhe de implementação. Parte-se de
// `user_tools` (4 linhas em prod, 2 donos) e daí para os perfis desses donos. Partir de
// `profiles` (5.276 linhas) custava ~5.280 consultas sequenciais para descobrir que 5.274
// clientes não têm ferramenta alguma: a página `/admin/monthly-reports` ficava em spinner
// indefinido e o cron mensal (`0 9 1 * *`, timeout 150s) corria risco de nunca entregar.
// Medido em prod 2026-07-18. Inverter a direção é o que torna o custo O(ferramentas).
import { fetchAll } from "./paginate.ts";

export interface ResumoFerramenta {
  name: string;
  internal_code: string | null;
  category: string;
  last_sharpened_at: string | null;
  next_sharpening_due: string | null;
  sharpening_count: number;
  anomaly_count: number;
  is_overdue: boolean;
  is_due_soon: boolean;
  days_until_due: number | null;
}

export interface RelatorioCliente {
  user_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  tools: ResumoFerramenta[];
  overdue_count: number;
  due_soon_count: number;
  total_tools: number;
}

// ── Contrato mínimo do PostgREST que este núcleo usa ────────────────────────
// Estrutural de propósito: o `SupabaseClient` real satisfaz sem adaptador, e o teste
// satisfaz com um banco de memória que conta chamadas.

export interface RespostaPostgrest<T> {
  data: T[] | null;
  count?: number | null;
  error: { message: string } | null;
}

export interface QueryPostgrest<T> extends PromiseLike<RespostaPostgrest<T>> {
  select(colunas: string, opts?: { count?: "exact"; head?: boolean }): QueryPostgrest<T>;
  eq(coluna: string, valor: unknown): QueryPostgrest<T>;
  in(coluna: string, valores: readonly unknown[]): QueryPostgrest<T>;
  order(coluna: string, opts?: { ascending?: boolean }): QueryPostgrest<T>;
  range(de: number, ate: number): QueryPostgrest<T>;
}

export interface BancoPostgrest {
  // Genérico (e não `QueryPostgrest<unknown>`) para o call-site declarar a forma da linha
  // que espera de cada tabela — é o que mantém `fetchAll<T>` tipado ponta a ponta.
  from<T>(tabela: string): QueryPostgrest<T>;
}

interface LinhaFerramenta {
  id: string;
  user_id: string;
  internal_code: string | null;
  generated_name: string | null;
  custom_name: string | null;
  last_sharpened_at: string | null;
  next_sharpening_due: string | null;
  tool_categories: { name?: string } | null;
}

interface LinhaPerfil {
  user_id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

// Ordenação de exibição: atrasadas primeiro, depois as que vencem em breve, depois por
// proximidade do vencimento. Preservada verbatim do comportamento original.
function ordenarFerramentas(a: ResumoFerramenta, b: ResumoFerramenta): number {
  if (a.is_overdue && !b.is_overdue) return -1;
  if (!a.is_overdue && b.is_overdue) return 1;
  if (a.is_due_soon && !b.is_due_soon) return -1;
  if (!a.is_due_soon && b.is_due_soon) return 1;
  return (a.days_until_due ?? 999) - (b.days_until_due ?? 999);
}

// Quantos ids cabem num `.in(...)` por requisição. O limite real é o TAMANHO DA URL (o
// PostgREST recebe os ids na query string; o Kong do Supabase corta o request line em ~8 KB):
// 150 uuids ≈ 5,9 KB, com folga. Não é sobre o Postgres — é sobre o transporte.
const LOTE_IDS = 150;

function emLotes<T>(itens: readonly T[], tamanho: number): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) lotes.push(itens.slice(i, i + tamanho));
  return lotes;
}

interface LinhaEvento {
  user_tool_id: string;
  event_type: string;
}

export async function montarRelatorios(
  db: BancoPostgrest,
  opts: { userIdAlvo?: string | null; agora: Date },
): Promise<RelatorioCliente[]> {
  const { userIdAlvo, agora } = opts;

  // (1) Fonte da verdade: as FERRAMENTAS. Quem não tem ferramenta não entra no relatório —
  // então percorrer a base de clientes para descobrir isso é trabalho jogado fora.
  // `fetchAll` + `.order('id')` porque o PostgREST capa em 1000 linhas SEM ERRO.
  const ferramentas = await fetchAll<LinhaFerramenta>((de, ate) => {
    let q = db.from<LinhaFerramenta>("user_tools").select("*, tool_categories(name)");
    if (userIdAlvo) q = q.eq("user_id", userIdAlvo);
    return q.order("id", { ascending: true }).range(de, ate);
  }, "user_tools");

  if (ferramentas.length === 0) return [];

  // Ordem de primeira aparição (as ferramentas vêm ordenadas por id) — saída determinística.
  const idsDonos: string[] = [];
  const vistos = new Set<string>();
  for (const f of ferramentas) {
    if (!vistos.has(f.user_id)) {
      vistos.add(f.user_id);
      idsDonos.push(f.user_id);
    }
  }

  // (2) Só os perfis desses donos.
  const perfis = new Map<string, LinhaPerfil>();
  for (const lote of emLotes(idsDonos, LOTE_IDS)) {
    const linhas = await fetchAll<LinhaPerfil>((de, ate) =>
      db.from<LinhaPerfil>("profiles").select("user_id, name, email, phone")
        .in("user_id", lote).order("user_id", { ascending: true }).range(de, ate), "profiles");
    for (const p of linhas) perfis.set(p.user_id, p);
  }

  // (3) Uma agregação dos eventos, no lugar de 2 counts POR FERRAMENTA.
  // Erro de leitura PROPAGA (fetchAll lança): um relatório que reporta "0 afiações" porque a
  // consulta falhou é pior que um 500 — fabricaria número no lugar de dado ausente.
  const contagens = new Map<string, { afiacoes: number; anomalias: number }>();
  for (const lote of emLotes(ferramentas.map((f) => f.id), LOTE_IDS)) {
    const eventos = await fetchAll<LinhaEvento>((de, ate) =>
      db.from<LinhaEvento>("tool_events").select("user_tool_id, event_type")
        .in("user_tool_id", lote).order("id", { ascending: true }).range(de, ate), "tool_events");
    for (const ev of eventos) {
      const c = contagens.get(ev.user_tool_id) ?? { afiacoes: 0, anomalias: 0 };
      if (ev.event_type === "sharpening") c.afiacoes++;
      else if (ev.event_type === "anomaly") c.anomalias++;
      contagens.set(ev.user_tool_id, c);
    }
  }

  // (4) Montagem em memória.
  const porDono = new Map<string, ResumoFerramenta[]>();
  for (const ferramenta of ferramentas) {
    const vencimento = ferramenta.next_sharpening_due
      ? new Date(ferramenta.next_sharpening_due)
      : null;
    const diasAteVencer = vencimento
      ? Math.ceil((vencimento.getTime() - agora.getTime()) / (1000 * 60 * 60 * 24))
      : null;
    const c = contagens.get(ferramenta.id);

    const resumo: ResumoFerramenta = {
      name: ferramenta.generated_name || ferramenta.custom_name ||
        ferramenta.tool_categories?.name || "Ferramenta",
      internal_code: ferramenta.internal_code,
      category: ferramenta.tool_categories?.name || "",
      last_sharpened_at: ferramenta.last_sharpened_at,
      next_sharpening_due: ferramenta.next_sharpening_due,
      sharpening_count: c?.afiacoes ?? 0,
      anomaly_count: c?.anomalias ?? 0,
      is_overdue: diasAteVencer !== null && diasAteVencer < 0,
      is_due_soon: diasAteVencer !== null && diasAteVencer >= 0 && diasAteVencer <= 7,
      days_until_due: diasAteVencer,
    };

    const lista = porDono.get(ferramenta.user_id);
    if (lista) lista.push(resumo);
    else porDono.set(ferramenta.user_id, [resumo]);
  }

  const relatorios: RelatorioCliente[] = [];
  for (const userId of idsDonos) {
    const perfil = perfis.get(userId);
    if (!perfil) {
      // Dono de ferramenta sem linha em `profiles`. O código anterior (que partia de
      // `profiles`) também o omitia, só que sem deixar rastro. Omitir em silêncio é o que
      // transforma "relatório incompleto" em "relatório aparentemente completo".
      console.warn(`monthly-report: user_id ${userId} tem ferramenta mas não tem profile — omitido`);
      continue;
    }
    const resumos = (porDono.get(userId) ?? []).sort(ordenarFerramentas);
    relatorios.push({
      user_id: perfil.user_id,
      name: perfil.name,
      email: perfil.email,
      phone: perfil.phone,
      tools: resumos,
      overdue_count: resumos.filter((f) => f.is_overdue).length,
      due_soon_count: resumos.filter((f) => f.is_due_soon).length,
      total_tools: resumos.length,
    });
  }

  return relatorios;
}
