// Testa o ADAPTADOR (porta.ts): como a resposta do PostgREST vira a leitura que importacao.ts
// consome. É a camada onde "ausente vira zero" e "campo faltando vira NULL" nasceriam — e onde o
// banco falso de importacao_test.ts não enxerga nada, porque recebe a leitura já interpretada.
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-nfe-webhook/
import { contagemComprovada, emUso, interpretarCabecalho, portaSupabase, SELECT_CABECALHO } from "./porta.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

const LINHA_LIMPA = {
  id: "cab-1",
  status: "pendente",
  conferente_id: null,
  conferido_at: null,
  efetivado_at: null,
  efetivacao_lock_at: null,
  nfe_recebimento_itens: [{ count: 0 }],
};

Deno.test("contagemComprovada: só inteiro ≥ 0; ausente, NULL, string, negativo, fração e NaN são ilegíveis", () => {
  assertEquals(contagemComprovada(0), 0);
  assertEquals(contagemComprovada(7), 7);
  for (const ruim of [undefined, null, "3", -1, 1.5, NaN, Infinity, true, {}, []]) {
    assertEquals(contagemComprovada(ruim), null, JSON.stringify(ruim));
  }
});

Deno.test("interpretarCabecalho: linha limpa → existe, zero comprovado, sem uso", () => {
  assertEquals(interpretarCabecalho(LINHA_LIMPA), {
    tipo: "existe",
    id: "cab-1",
    status: "pendente",
    itens: 0,
    emUso: false,
  });
  assertEquals(interpretarCabecalho(null), { tipo: "nenhuma" });
});

Deno.test("interpretarCabecalho: contagem ilegível em QUALQUER forma é erro, nunca zero nem 'existe'", () => {
  const formas: unknown[] = [
    undefined, // embed ausente
    [], // embed vazio
    [{}], // sem count
    [{ count: null }],
    [{ count: "0" }],
    [{ count: -1 }],
    [{ count: 1.5 }],
    [{ count: NaN }],
    [{ count: 0 }, { count: 0 }], // dois agregados: não sei qual é
    { count: 0 }, // não-array
  ];
  for (const nfe_recebimento_itens of formas) {
    const r = interpretarCabecalho({ ...LINHA_LIMPA, nfe_recebimento_itens });
    assertEquals(r.tipo, "erro", `forma ${JSON.stringify(nfe_recebimento_itens)} → ${JSON.stringify(r)}`);
  }
});

Deno.test("emUso: qualquer sinal preenchido OU AUSENTE da resposta conta como uso (NULL não comprovado)", () => {
  assertEquals(emUso(LINHA_LIMPA), false);
  for (const sinal of ["conferente_id", "conferido_at", "efetivado_at", "efetivacao_lock_at"]) {
    assertEquals(emUso({ ...LINHA_LIMPA, [sinal]: "x" }), true, `${sinal} preenchido`);
    const semSinal: Record<string, unknown> = { ...LINHA_LIMPA };
    delete semSinal[sinal];
    assertEquals(emUso(semSinal), true, `${sinal} ausente da resposta`);
  }
  assertEquals(SELECT_CABECALHO.includes("efetivacao_lock_at"), true, "o SELECT pede os sinais — senão vêm ausentes e nada é reparável");
});

Deno.test("interpretarCabecalho: id/status ilegíveis são erro", () => {
  assertEquals(interpretarCabecalho({ ...LINHA_LIMPA, id: 5 }).tipo, "erro");
  assertEquals(interpretarCabecalho({ ...LINHA_LIMPA, status: null }).tipo, "erro");
  assertEquals(interpretarCabecalho([LINHA_LIMPA]).tipo, "erro");
});

/** Cliente supabase-js falso: grava a chamada e responde o que o teste mandar. */
function clienteFalso(resposta: { data?: unknown; error?: unknown }) {
  const chamadas: { tabela: string; op: string; arg: unknown; select?: string }[] = [];
  const builder = (tabela: string) => {
    const reg: { tabela: string; op: string; arg: unknown; select?: string } = { tabela, op: "", arg: undefined };
    chamadas.push(reg);
    const b = {
      select(s: string) {
        if (!reg.op) reg.op = "select";
        reg.select = s;
        return b;
      },
      insert(arg: unknown) {
        reg.op = "insert";
        reg.arg = arg;
        return b;
      },
      eq(_c: string, v: unknown) {
        reg.arg = v;
        return b;
      },
      maybeSingle: () => Promise.resolve(resposta),
      single: () => Promise.resolve(resposta),
      then: (ok: (v: unknown) => unknown) => Promise.resolve(resposta).then(ok),
    };
    return b;
  };
  return { cliente: { from: builder }, chamadas };
}

Deno.test("portaSupabase.buscarPorChave: pede o SELECT com contagem e sinais; erro do transporte vira erro, não 'nenhuma'", async () => {
  const ok = clienteFalso({ data: LINHA_LIMPA, error: null });
  const r = await portaSupabase(ok.cliente).buscarPorChave("chave");
  assertEquals(r.tipo, "existe");
  assertEquals(ok.chamadas[0], { tabela: "nfe_recebimentos", op: "select", arg: "chave", select: SELECT_CABECALHO });

  const falha = clienteFalso({ data: null, error: { message: "timeout", code: "57014" } });
  assertEquals((await portaSupabase(falha.cliente).buscarPorChave("chave")).tipo, "erro");
});

Deno.test("portaSupabase.inserirCabecalho/inserirItens: devolvem a SQLSTATE do PostgREST (23505 chega inteira) e nunca lançam", async () => {
  const dup = clienteFalso({ data: null, error: { message: "duplicate key", code: "23505" } });
  const porta = portaSupabase(dup.cliente);
  assertEquals(await porta.inserirCabecalho({ chave_acesso: "c" }), { erro: "duplicate key", code: "23505" });
  assertEquals(await porta.inserirItens([{ id: "i" }]), { erro: "duplicate key", code: "23505" });

  const semId = clienteFalso({ data: {}, error: null });
  assertEquals("erro" in (await portaSupabase(semId.cliente).inserirCabecalho({})), true, "insert sem id devolvido é erro");

  const ok = clienteFalso({ data: { id: "cab-9" }, error: null });
  assertEquals(await portaSupabase(ok.cliente).inserirCabecalho({ chave_acesso: "c" }), { id: "cab-9" });
  assertEquals(await portaSupabase(ok.cliente).inserirItens([{ id: "i" }]), null);
});
