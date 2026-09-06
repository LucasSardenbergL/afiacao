// Stub do SDK da Anthropic (edges que pagam token por chamada).
import { proxy } from "./contador.ts";
export default class Anthropic {
  constructor(..._a: unknown[]) {
    return proxy("anthropic") as unknown as Anthropic;
  }
}
export { Anthropic };
