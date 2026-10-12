// Captura do leitor no DOM: escuta `keydown` no WINDOW em fase de CAPTURA (fora do React), passa
// cada tecla pelo protocolo puro e engole as que pertencem a uma leitura — o código nunca cai no
// campo focado, e a leitura chega com qualquer foco (toast, diálogo, nada focado).
import { ESTADO_INICIAL, type OpcoesProtocolo, PADRAO_PROTOCOLO, passo, proximoVencimento, type Saida } from "./protocolo";

export interface OpcoesCaptura {
  aoSaida: (s: Saida) => void;
  protocolo?: OpcoesProtocolo;
  alvo?: Pick<Window, "addEventListener" | "removeEventListener">;
  agora?: () => number;
}

function ehCampoDeTexto(alvo: EventTarget | null): boolean {
  const el = alvo as { tagName?: string; isContentEditable?: boolean } | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true);
}

/** Liga a captura; devolve a função que desliga. */
export function iniciarCaptura({ aoSaida, protocolo = PADRAO_PROTOCOLO, alvo = window, agora = () => performance.now() }: OpcoesCaptura): () => void {
  let estado = ESTADO_INICIAL;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const agendar = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const vence = proximoVencimento(estado, protocolo);
    if (vence === null) return;
    timer = setTimeout(() => {
      timer = null;
      const p = passo(estado, { tipo: "tempo", t: agora() }, protocolo);
      estado = p.estado;
      p.saidas.forEach(aoSaida);
      agendar();
    }, Math.max(0, vence - agora()));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    const p = passo(estado, { tipo: "tecla", key: e.key, t: agora() }, protocolo);
    estado = p.estado;
    if (p.engolir) {
      e.preventDefault();
      e.stopPropagation();
    } else if (e.key === "Enter" && !ehCampoDeTexto(e.target)) {
      // ENTER de um quadro cortado pode chegar DEPOIS da janela de descarte; com a captura ligada
      // ele nunca aciona o botão focado ("Falta", "Concluir") — botão é toque (Codex Fase 1 r2).
      e.preventDefault();
    }
    p.saidas.forEach(aoSaida);
    agendar();
  };

  alvo.addEventListener("keydown", onKeyDown as EventListener, { capture: true });
  return () => {
    alvo.removeEventListener("keydown", onKeyDown as EventListener, { capture: true });
    if (timer !== null) clearTimeout(timer);
  };
}
