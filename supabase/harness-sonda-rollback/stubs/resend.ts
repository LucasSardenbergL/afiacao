// Stub do SDK do Resend. `monthly-report@ef08dddd2` envia e-mail por aqui — é o efeito mais caro
// da história deste repo (5.276 destinatários), e é justamente o que o controle positivo mede.
import { proxy } from "./contador.ts";
export class Resend {
  constructor(..._a: unknown[]) {
    return proxy("resend") as unknown as Resend;
  }
}
export default Resend;
