// Testa o CÓDIGO REAL do gate de radar-ingest/gate.ts no runtime real (Deno).
// Revisão 2026-11-11 (item 22): a edge tinha um gate próprio (cron OU master lido à mão em `user_roles`). Agora compõe
// os dois gates compartilhados de `_shared/auth.ts` — `authorizeCron` e `authorizeMaster` —, injetados aqui para o
// teste não depender de rede nem de env.
import { autorizarIngest } from "./gate.ts";

const req = () => new Request("https://x/radar-ingest", { method: "POST" });
const nao = { ok: false as const, response: new Response(null, { status: 401 }) };

Deno.test("cron válido: passa SEM consultar o master (nenhum fetch de auth no caminho do cron)", async () => {
  let consultouMaster = 0;
  const ok = await autorizarIngest(req(), {
    cron: () => ({ ok: true, via: "cron" }),
    master: () => { consultouMaster++; return Promise.resolve(nao); },
  });
  if (!ok) throw new Error("cron válido deveria passar");
  if (consultouMaster !== 0) throw new Error(`o master foi consultado ${consultouMaster}× no caminho do cron`);
});

Deno.test("sem cron: decide o authorizeMaster (master JWT ou service role passam)", async () => {
  const ok = await autorizarIngest(req(), { cron: () => nao, master: () => Promise.resolve({ ok: true, via: "staff" }) });
  if (!ok) throw new Error("master deveria passar");
});

Deno.test("nem cron nem master: recusa", async () => {
  const ok = await autorizarIngest(req(), { cron: () => nao, master: () => Promise.resolve(nao) });
  if (ok) throw new Error("deveria recusar");
});

Deno.test("o index usa o gate compartilhado, não um gate próprio (sem consulta crua a user_roles)", async () => {
  const fonte = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  if (!/autorizarIngest\(req, \{ cron: \(r\) => authorizeCron\(r\), master: \(r\) => authorizeMaster\(r\) \}\)/.test(fonte)) {
    throw new Error("index.ts não compõe authorizeCron + authorizeMaster via autorizarIngest");
  }
  if (/from\("user_roles"\)/.test(fonte)) throw new Error("index.ts ainda lê user_roles à mão");
});
