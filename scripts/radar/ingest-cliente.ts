// Cliente HTTP da carga do Radar → edge `radar-ingest`: POST com re-tentativa e o FIM DECLARADO do lote.
//
// Erro de chunk/finalize na edge é RECUPERÁVEL (a edge v1.8 não marca mais `falhou` no catch geral — um 5xx
// transitório num chunk fechava o lote e a 2ª tentativa morria em RCARGA_LOTE_FECHADO). Quem sabe que não vai
// mais tentar é a CARGA: ao esgotar as tentativas com um lote aberto, ela declara `falhar` (best-effort) e
// relança o erro original. Sem a declaração o lote ficaria `recebendo` até o sensor de carga parada apontar.

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export type OpcoesCliente = {
  url: string;
  segredo: string;
  fetch: FetchLike;
  esperar?: (ms: number) => Promise<void>;
  tentativas?: number;
  avisar?: (msg: string) => void;
};

export type ClienteIngest = {
  post: (body: Record<string, unknown>) => Promise<unknown>;
  /** Lote `mes` aberto (begin_lote ok): a partir daqui, desistir de um POST declara `falhar`. */
  abrirLote: (mes: string) => void;
  /** Lote validado pelo finalize: desistir de um POST posterior (concorrentes, sócios) NÃO derruba o lote. */
  fecharLote: () => void;
};

// Rejeição não-Error (objeto plano) vira JSON, nunca "[object Object]" (classe #1642).
const mensagem = (e: unknown) => (e instanceof Error ? e.message : JSON.stringify(e));

export function criarClienteIngest(o: OpcoesCliente): ClienteIngest {
  const tentativas = o.tentativas ?? 4;
  const esperar = o.esperar ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const avisar = o.avisar ?? ((m) => console.warn(m));
  let loteAberto: string | null = null;

  const enviar = (body: Record<string, unknown>) => o.fetch(o.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-cron-secret": o.segredo },
    body: JSON.stringify(body),
  });

  const declararFalha = async (motivo: string) => {
    const mes = loteAberto;
    if (!mes) return;
    loteAberto = null; // uma declaração só, mesmo que o `falhar` também falhe
    try {
      const res = await enviar({ action: "falhar", mes, erro: motivo });
      if (!res.ok) avisar(`⚠️ falhar ${mes}: HTTP ${res.status} — o lote fica \`recebendo\` até o sensor apontar`);
    } catch (e) {
      avisar(`⚠️ falhar ${mes}: rede (${mensagem(e)}) — o lote fica \`recebendo\``);
    }
  };

  const post = async (body: Record<string, unknown>): Promise<unknown> => {
    for (let t = 1; t <= tentativas; t++) {
      // try/catch cobre rejeição do fetch (rede: ECONNRESET/DNS) — review da 1ª carga:
      // só status HTTP no retry deixava ~527 POSTs sequenciais morrerem no 1º transitório.
      let erro: Error;
      try {
        const res = await enviar(body);
        if (res.ok) return res.json();
        const txt = await res.text();
        erro = new Error(`POST ${String(body.action)} falhou (${res.status}): ${txt}`);
        if (t < tentativas) avisar(`tentativa ${t} falhou (${res.status}), retry…`);
      } catch (e) {
        erro = e instanceof Error ? e : new Error(mensagem(e));
        if (t < tentativas) avisar(`tentativa ${t} falhou (rede: ${erro.message}), retry…`);
      }
      if (t === tentativas) {
        await declararFalha(`${erro.message} (após ${tentativas} tentativas)`);
        throw erro;
      }
      await esperar(800 * 2 ** t);
    }
    throw new Error("inalcançável: laço de tentativas sem retorno");
  };

  return {
    post,
    abrirLote: (mes) => { loteAberto = mes; },
    fecharLote: () => { loteAberto = null; },
  };
}
