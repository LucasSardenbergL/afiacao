import { useEffect, useRef, useState } from 'react';

/**
 * Wrapper da BarcodeDetector API nativa do browser.
 *
 * **Compatibilidade:**
 * - ✅ Chrome / Edge (desktop + Android) desde 2020
 * - ❌ Safari / Firefox — não suportam (precisam fallback)
 *
 * Latência típica: <50ms entre frame e detect (CLAUDE.md §6.2 "<100ms percebido em scan").
 *
 * Padrão de uso:
 *   const { supported, scan } = useBarcodeDetector();
 *   if (!supported) return <FallbackScanner />;
 *   const result = await scan(videoElement);
 *   if (result) onDetected(result.rawValue);
 *
 * Pra streaming contínuo (loop de animation frames), ver `useBarcodeDetectorStream`
 * em iteração futura — este hook é one-shot.
 */

export interface BarcodeDetectorResult {
  rawValue: string;
  format: string;
  boundingBox?: DOMRectReadOnly;
}

interface BarcodeDetectorAPI {
  new (options?: { formats?: string[] }): {
    detect(source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | ImageBitmap): Promise<
      Array<{
        rawValue: string;
        format: string;
        boundingBox?: DOMRectReadOnly;
      }>
    >;
  };
  getSupportedFormats?(): Promise<string[]>;
}

function getBarcodeDetectorClass(): BarcodeDetectorAPI | null {
  if (typeof window === 'undefined') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctor = (window as any).BarcodeDetector as BarcodeDetectorAPI | undefined;
  return ctor ?? null;
}

/**
 * Hook one-shot — escaneia um único frame quando `scan()` é chamado.
 *
 * Formats default: todos suportados pelo browser. Pra restringir
 * (ex: só EAN-13 + CODE-128), passar `formats: ['ean_13', 'code_128']`.
 */
export function useBarcodeDetector(formats?: string[]) {
  const [supported, setSupported] = useState<boolean | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const detectorRef = useRef<any>(null);

  useEffect(() => {
    const Ctor = getBarcodeDetectorClass();
    if (!Ctor) {
      setSupported(false);
      return;
    }
    try {
      detectorRef.current = new Ctor(formats ? { formats } : undefined);
      setSupported(true);
    } catch {
      // Construtor pode falhar se nenhum format suportado intersecta com solicitados
      setSupported(false);
    }
  }, [formats]);

  const scan = async (
    source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | ImageBitmap,
  ): Promise<BarcodeDetectorResult | null> => {
    if (!detectorRef.current) return null;
    try {
      const results = await detectorRef.current.detect(source);
      if (results.length === 0) return null;
      // Retorna o primeiro (BarcodeDetector pode retornar múltiplos se vários códigos visíveis)
      return results[0];
    } catch {
      return null;
    }
  };

  return { supported, scan };
}

/**
 * Helper estático pra checar suporte sem montar hook (útil em conditional render).
 */
export function isBarcodeDetectorSupported(): boolean {
  return getBarcodeDetectorClass() !== null;
}
