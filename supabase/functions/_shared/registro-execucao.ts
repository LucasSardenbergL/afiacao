// Registro server-side de execuções de ações globais (tabela acoes_execucoes) — o par
// edge do useMutationComRegistro do frontend. Usar em action SINGLE-SHOT que roda por
// clique (staff) E por cron: um único ponto grava as duas origens.
// FAIL-OPEN: registro é observabilidade — NUNCA derruba a ação real.
// Regra (CLAUDE.md §Design System): cada slug de acao tem UM escritor (edge OU frontend).

export interface DbRegistro {
  // Estrutural mínimo do supabase-js client (service_role) — só o que o registro usa.
  from(tabela: string): {
    insert(linha: Record<string, unknown>): {
      select(colunas: "id"): {
        single(): Promise<{ data: { id: string } | null; error: { message: string } | null }>;
      };
    };
    update(patch: Record<string, unknown>): {
      eq(coluna: "id", valor: string): Promise<{ error: { message: string } | null }>;
    };
    select(colunas: "name"): {
      eq(coluna: "user_id", valor: string): {
        maybeSingle(): Promise<{ data: { name?: string } | null; error: { message: string } | null }>;
      };
    };
  };
}

type AuthOrigem = { via: "cron" | "service_role" | "staff"; userId?: string };

async function iniciar(db: DbRegistro, acao: string, auth: AuthOrigem): Promise<string | null> {
  try {
    const manual = auth.via === "staff";
    let nome: string | null = null;
    if (manual && auth.userId) {
      const { data } = await db.from("profiles").select("name").eq("user_id", auth.userId).maybeSingle();
      nome = data?.name ?? null;
    }
    const { data, error } = await db
      .from("acoes_execucoes")
      .insert({
        acao,
        origem: manual ? "manual" : "automatica",
        executado_por: manual ? (auth.userId ?? null) : null,
        executado_por_nome: nome,
      })
      .select("id")
      .single();
    if (error || !data) {
      console.warn(`[registro-execucao] não abriu (fail-open): ${acao}`, error?.message);
      return null;
    }
    return data.id;
  } catch (e) {
    console.warn(`[registro-execucao] não abriu (fail-open): ${acao}`, e instanceof Error ? e.message : e);
    return null;
  }
}

async function fechar(
  db: DbRegistro,
  registroId: string | null,
  status: "sucesso" | "erro",
  detalhes: Record<string, unknown> | null,
): Promise<void> {
  if (!registroId) return;
  try {
    const { error } = await db
      .from("acoes_execucoes")
      .update({ status, finalizado_em: new Date().toISOString(), detalhes })
      .eq("id", registroId);
    if (error) console.warn(`[registro-execucao] não fechou (fail-open): ${registroId}`, error.message);
  } catch (e) {
    console.warn(`[registro-execucao] não fechou (fail-open): ${registroId}`, e instanceof Error ? e.message : e);
  }
}

/** Envolve uma ação single-shot com o registro início→fim (sucesso/erro re-lança). */
export async function comRegistro<T>(
  db: DbRegistro,
  acao: string,
  auth: AuthOrigem,
  fn: () => Promise<T>,
  detalhes?: (r: T) => Record<string, unknown>,
): Promise<T> {
  const registroId = await iniciar(db, acao, auth);
  try {
    const resultado = await fn();
    await fechar(db, registroId, "sucesso", detalhes ? detalhes(resultado) : null);
    return resultado;
  } catch (e) {
    await fechar(db, registroId, "erro", { erro: String(e).slice(0, 300) });
    throw e;
  }
}
