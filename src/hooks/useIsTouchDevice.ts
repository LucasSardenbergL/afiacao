import { useState, useEffect } from 'react';

// Dispositivo touch-PRIMÁRIO (celular/tablet): sem hover e ponteiro grosso (dedo).
// Notebook — mesmo com janela estreita OU tela touch — tem ponteiro primário fino
// (trackpad/mouse) + hover → NÃO casa. É o sinal certo pra decidir "posso discar
// pela operadora via tel:?". Largura de tela é proxy errado (notebook em janela
// estreita viraria falsamente "mobile" e abriria o app Telefone do SO).
const QUERY = '(hover: none) and (pointer: coarse)';

export function useIsTouchDevice(): boolean {
  const [isTouch, setIsTouch] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(QUERY);
    setIsTouch(mql.matches);
    const onChange = () => setIsTouch(mql.matches);
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, []);

  return isTouch;
}
