// Janela em que o portal Sayerlack está FORA DO AR: de sábado 12:00 até segunda 06:00, hora de SP
// (palavra do founder, 2026-10-10). Mandar pedido nessa faixa só abre o navegador contra um portal
// desligado e gasta as tentativas do pedido (MAX_TENTATIVAS=3 → erro_nao_retentavel).
//
// Hora de SP pelo Intl (America/Sao_Paulo), não por UTC−3 fixo — mesmo padrão de _shared/hoje-sp.ts.

const FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Sao_Paulo",
  weekday: "short",
  hour: "2-digit",
  hourCycle: "h23",
});

/** true ⇔ `agora` cai entre sábado 12:00 e segunda 06:00 (hora de SP). */
export function portalSayerlackFechado(agora: Date): boolean {
  const partes = FMT.formatToParts(agora);
  const dia = partes.find((p) => p.type === "weekday")?.value;
  const hora = Number(partes.find((p) => p.type === "hour")?.value);
  if (!dia || !Number.isFinite(hora)) return false; // sem leitura do relógio: não bloqueia
  if (dia === "Sun") return true;
  if (dia === "Sat") return hora >= 12;
  if (dia === "Mon") return hora < 6;
  return false;
}

export const MENSAGEM_PORTAL_FECHADO =
  "Portal Sayerlack fora do ar (sábado 12h → segunda 6h). O pedido segue aprovado e nada foi enviado.";

/**
 * O pedido ABRIRIA um envio novo ao portal? Espelha a ordem de `iniciarEnvioPortalSayerlack`:
 * já enviado com protocolo (só falta o Omie), aceito sem protocolo / indeterminado (conciliação) e
 * em voo (`enviando_portal`) NÃO abrem envio — esses seguem mesmo com o portal fora do ar.
 */
export function abririaEnvioNovoAoPortal(
  statusEnvioPortal: string | null | undefined,
  portalProtocolo: string | null | undefined,
): boolean {
  const st = statusEnvioPortal ?? "";
  if ((st === "enviado_portal" || st === "sucesso_portal") && portalProtocolo) return false;
  if (st === "aceito_portal_sem_protocolo" || st === "indeterminado_requer_conciliacao") return false;
  if (st === "enviando_portal") return false;
  return true;
}
