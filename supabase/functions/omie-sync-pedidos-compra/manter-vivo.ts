// Mantém o worker vivo enquanto o trabalho SÍNCRONO da edge roda — sem responder mais cedo.
//
// Por quê (medido em prod 2026-10-18, execution 9fd480ba): o gateway do Supabase derruba a request aos 150s
// (504 IDLE_TIMEOUT, execution_time_ms=150146) MESMO com o cliente já desconectado aos 25s (pg_net do
// omie-cron-diario). Sem request ativa e sem tarefa de background registrada, o edge-runtime faz o shutdown
// `EarlyDrop` do worker pouco depois (21:20:07, ~50s após o 504; cpu_time_used=127ms, 14MB — não é CPU,
// memória nem wall-clock). O completo cabia nessa sobra (112–179s); a passada de encerrados (R59), que roda
// DEPOIS dele, morria no meio com o registro em 'coletando' — 3 de 3 runs medidos.
//
// O `waitUntil` registra o MESMO promise que o handler aguarda: o worker vive até o trabalho acabar (teto:
// wall-clock do worker, ~400s; DEADLINE_ENCERRADOS_MS fica abaixo dele) e a resposta continua saindo só no
// fim — o "NÃO usar waitUntil/202" do index.ts é sobre RESPONDER cedo, que segue proibido.

interface RuntimeComWaitUntil {
  waitUntil?: (p: Promise<unknown>) => void;
}

/**
 * Registra `trabalho` no `EdgeRuntime.waitUntil` (quando existe). A rejeição é engolida SÓ na cópia entregue
 * ao runtime — quem trata o erro é o `await` do handler sobre o promise original.
 * Devolve true se registrou; false fora do edge-runtime (Deno puro/testes), onde não há o que segurar.
 */
export function segurarWorker(
  trabalho: Promise<unknown>,
  runtime: RuntimeComWaitUntil | undefined = (globalThis as { EdgeRuntime?: RuntimeComWaitUntil }).EdgeRuntime,
): boolean {
  if (typeof runtime?.waitUntil !== "function") return false;
  runtime.waitUntil(trabalho.then(() => undefined, () => undefined));
  return true;
}
