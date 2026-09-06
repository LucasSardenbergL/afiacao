// Stub do `web-push`. `setVapidDetails` é configuração e não conta; enviar conta.
import { proxy } from "./contador.ts";
export const sendNotification = proxy("webpush.sendNotification");
export function setVapidDetails(..._a: unknown[]): void {}
export default { sendNotification, setVapidDetails };
