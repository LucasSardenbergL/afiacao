// Liga a captura do leitor Zebra (keystroke DataWedge) enquanto a tela de separação está ativa.
// A captura vive fora do React (window, fase de captura); o hook só a liga/desliga e entrega cada
// saída do protocolo ao callback mais recente (ref — trocar o callback não religa o listener).
import { useEffect, useRef } from "react";
import { iniciarCaptura } from "@/lib/picking/scanner/captura";
import type { Saida } from "@/lib/picking/scanner/protocolo";

export function useScanner(ativo: boolean, aoSaida: (s: Saida) => void): void {
  const ref = useRef(aoSaida);
  ref.current = aoSaida;
  useEffect(() => {
    if (!ativo) return;
    return iniciarCaptura({ aoSaida: (s) => ref.current(s) });
  }, [ativo]);
}
