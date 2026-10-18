// Testa o CÓDIGO REAL de manter-vivo.ts no runtime real (Deno).
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-sync-pedidos-compra/manter-vivo_test.ts
import { segurarWorker } from "./manter-vivo.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("registra o trabalho no waitUntil do runtime ANTES de ele terminar", async () => {
  const registrados: Promise<unknown>[] = [];
  let soltar!: () => void;
  const trabalho = new Promise<void>((r) => (soltar = r));
  const ok = segurarWorker(trabalho, { waitUntil: (p) => void registrados.push(p) });
  assert(ok === true, "devia devolver true com runtime presente");
  assert(registrados.length === 1, `esperado 1 registro síncrono, veio ${registrados.length}`);
  soltar();
  await registrados[0];
});

Deno.test("trabalho que REJEITA não vira rejeição no waitUntil (quem reporta é o await do handler)", async () => {
  let registrado: Promise<unknown> | null = null;
  const trabalho = Promise.reject(new Error("boom"));
  trabalho.catch(() => {}); // o handler aguarda e trata; aqui só evita unhandled no próprio teste
  segurarWorker(trabalho, { waitUntil: (p) => void (registrado = p) });
  assert(registrado !== null, "devia registrar");
  await registrado; // resolve, não lança
});

Deno.test("sem EdgeRuntime (teste local/Deno puro) não registra e devolve false", () => {
  assert(segurarWorker(Promise.resolve(), undefined) === false, "sem runtime devia devolver false");
  assert(segurarWorker(Promise.resolve(), {} as never) === false, "runtime sem waitUntil devia devolver false");
});

// O handler é síncrono de propósito (responde só no fim). A correção de 2026-10-18 depende de o MESMO promise
// ir para o waitUntil ANTES do await da resposta — sem isso o gateway derruba a request aos 150s (504
// IDLE_TIMEOUT) e o runtime faz EarlyDrop do worker no meio da passada de encerrados.
Deno.test("index.ts segura o worker com o trabalho antes de responder", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const m = src.match(/const (\w+) = processarTudo\(\);\s*\n\s*segurarWorker\(\1\);\s*\n\s*return await responderSincrono\(\1\);/);
  assert(m !== null, "index.ts precisa de: const t = processarTudo(); segurarWorker(t); return await responderSincrono(t);");
  assert(!/responderSincrono\(processarTudo\(\)\)/.test(src), "a chamada antiga sem segurarWorker ainda está no index.ts");
});
