import { useEffect, useRef, useState } from 'react';
import { Camera, CameraOff, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  useBarcodeDetector,
  isBarcodeDetectorSupported,
  type BarcodeDetectorResult,
} from '@/hooks/useBarcodeDetector';

/**
 * Scanner de código de barras via câmera (BarcodeDetector API + getUserMedia).
 *
 * Apenas pra browsers com suporte (Chrome/Edge/Android). Em Safari/Firefox/iOS,
 * renderiza fallback com mensagem explicativa — o caller deve oferecer outra
 * forma de input (manual, OCR Tesseract via LoteScannerOCR, ou wedge scanner).
 *
 * Loop de scan: roda BarcodeDetector em requestAnimationFrame, debounce 500ms
 * pra não disparar 10× o mesmo código. Stream da câmera é fechado em unmount.
 *
 * Latência alvo: <100ms entre frame e onScan (CLAUDE.md §6.2).
 */

interface Props {
  /** Callback quando código é detectado (rawValue + format). */
  onScan: (result: BarcodeDetectorResult) => void;
  /** Formats permitidos. Default: todos. Ex: ['ean_13', 'code_128']. */
  formats?: string[];
  /** Câmera preferida. Default: traseira ('environment'). */
  facingMode?: 'user' | 'environment';
  /** Após detectar, pausa o loop por N ms pra evitar fire 10× (default 500). */
  cooldownMs?: number;
  className?: string;
}

export function CameraBarcodeScanner({
  onScan,
  formats,
  facingMode = 'environment',
  cooldownMs = 500,
  className,
}: Props) {
  const { supported, scan } = useBarcodeDetector(formats);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastScanAt = useRef<number>(0);
  const [status, setStatus] = useState<'idle' | 'starting' | 'streaming' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Detecção de suporte é assíncrona (useBarcodeDetector seta supported em useEffect).
  // Pra render imediato em caller, exportamos isBarcodeDetectorSupported() helper.

  useEffect(() => {
    if (supported !== true) return;

    let cancelled = false;

    const start = async () => {
      setStatus('starting');
      setErrorMsg(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setStatus('streaming');
        loop();
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : 'Erro desconhecido ao acessar câmera';
        setErrorMsg(msg);
        setStatus('error');
      }
    };

    const loop = async () => {
      if (cancelled || !videoRef.current || videoRef.current.readyState < 2) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }
      const now = Date.now();
      if (now - lastScanAt.current >= cooldownMs) {
        const result = await scan(videoRef.current);
        if (result && !cancelled) {
          lastScanAt.current = now;
          onScan(result);
        }
      }
      if (!cancelled) {
        rafRef.current = requestAnimationFrame(loop);
      }
    };

    start();

    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [supported, facingMode, cooldownMs, onScan, scan]);

  if (supported === null) {
    // ainda checando suporte
    return (
      <div className={cn('flex items-center justify-center py-6', className)}>
        <Camera className="w-5 h-5 text-muted-foreground animate-pulse" />
      </div>
    );
  }

  if (supported === false) {
    return (
      <div className={cn('flex flex-col items-center gap-2 py-6 px-4 text-center', className)}>
        <CameraOff className="w-6 h-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Câmera não suporta detecção automática neste navegador.
        </p>
        <p className="text-xs text-muted-foreground">
          Use Chrome/Edge no desktop ou Android. Em Safari/iOS, digite o código manualmente.
        </p>
      </div>
    );
  }

  return (
    <div className={cn('relative w-full overflow-hidden rounded-md bg-black', className)}>
      <video
        ref={videoRef}
        className="w-full h-full object-cover"
        playsInline
        muted
      />
      {status === 'starting' && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40">
          <Camera className="w-6 h-6 text-white animate-pulse" />
        </div>
      )}
      {status === 'error' && errorMsg && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 p-4 text-center">
          <AlertCircle className="w-6 h-6 text-status-error" />
          <p className="text-sm text-white">{errorMsg}</p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              // Re-monta o useEffect setando outra key — simples: força reload da página
              window.location.reload();
            }}
          >
            Tentar novamente
          </Button>
        </div>
      )}
      {status === 'streaming' && (
        <div className="absolute inset-x-0 bottom-2 flex justify-center">
          <span className="bg-black/50 text-white text-xs px-2 py-0.5 rounded">
            Aponte pra um código
          </span>
        </div>
      )}
    </div>
  );
}

export { isBarcodeDetectorSupported };
