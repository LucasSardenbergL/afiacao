// Cliente da Anthropic com coleira de relógio — o ÚNICO lugar das edges que faz `new Anthropic(`
// (gate: src/__tests__/anthropic-cliente-gate.test.ts). Por que a coleira: `anthropic.ts`,
// bloco "Coleira do cliente". Separado de `anthropic.ts` porque importa o SDK, e aquele roda sob
// `deno test --no-remote`.
import Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";
import { opcoesClienteAnthropic } from "./anthropic.ts";

export function criarClienteAnthropic(
  apiKey: string,
  ajuste?: { timeoutMs?: number; maxRetries?: number },
): Anthropic {
  return new Anthropic(opcoesClienteAnthropic(apiKey, ajuste));
}
