// Mantém a tela acesa durante a separação (Wake Lock API). Sem suporte ou recusado → silencioso:
// é conforto, não correção. O navegador solta o lock quando a aba some; religa ao voltar.
import { useEffect } from "react";

type Sentinela = { release(): Promise<void> };

export function useWakeLock(ativo: boolean): void {
  useEffect(() => {
    if (!ativo || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let sentinela: Sentinela | null = null;
    let vivo = true;
    const pedir = () => {
      (navigator as unknown as { wakeLock: { request(t: "screen"): Promise<Sentinela> } }).wakeLock
        .request("screen")
        .then((s) => {
          if (vivo) sentinela = s;
          else void s.release();
        })
        .catch(() => {});
    };
    const aoVoltar = () => {
      if (document.visibilityState === "visible") pedir();
    };
    pedir();
    document.addEventListener("visibilitychange", aoVoltar);
    return () => {
      vivo = false;
      document.removeEventListener("visibilitychange", aoVoltar);
      void sentinela?.release();
    };
  }, [ativo]);
}
