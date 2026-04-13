import React, { useRef, useState, useCallback, useEffect } from 'react';
import { createWorker } from 'tesseract.js';
import { Camera, X, Loader2, ScanLine, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

interface LoteDados {
  numero_lote: string;
  data_fabricacao: string | null;
  data_validade: string | null;
  metodo_leitura: 'ocr' | 'manual';
}

interface LoteScannerOCRProps {
  onLoteCapturado: (dados: LoteDados) => void;
  onCancelar: () => void;
}

const MONTH_MAP: Record<string, string> = {
  JAN: '01', FEV: '02', MAR: '03', ABR: '04',
  MAI: '05', JUN: '06', JUL: '07', AGO: '08',
  SET: '09', OUT: '10', NOV: '11', DEZ: '12',
};

function parseDate(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toUpperCase();

  // DD/MM/YYYY
  const full = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (full) return `${full[3]}-${full[2]}-${full[1]}`;

  // MMM/YYYY  (e.g. AGO/2025)
  const abbr = trimmed.match(/^([A-Z]{3})\/(\d{4})$/);
  if (abbr) {
    const mm = MONTH_MAP[abbr[1]];
    if (mm) return `${abbr[2]}-${mm}-01`;
  }

  return null;
}

export default function LoteScannerOCR({ onLoteCapturado, onCancelar }: LoteScannerOCRProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [cameraReady, setCameraReady] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [ocrResult, setOcrResult] = useState<'success' | 'fail' | null>(null);

  // Form fields
  const [lote, setLote] = useState('');
  const [fabricacao, setFabricacao] = useState('');
  const [validade, setValidade] = useState('');
  const [metodo, setMetodo] = useState<'ocr' | 'manual'>('manual');

  // Start camera
  useEffect(() => {
    let cancelled = false;

    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setCameraReady(true);
        }
      } catch {
        console.error('Não foi possível acessar a câmera');
      }
    }

    startCamera();

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  const capture = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current) return;
    setProcessing(true);
    setOcrResult(null);

    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);

    try {
      const worker = await createWorker('por');
      const { data: { text } } = await worker.recognize(canvas);
      await worker.terminate();

      const loteMatch = text.match(/LOTE[:\s]*(\d{6,10})/i);
      const fabrMatch = text.match(/FABR[.:\s]*([\d/A-Z]+)/i);
      const validMatch = text.match(/VALID[.:\s]*([\d/A-Z]+)/i);

      if (loteMatch) {
        setLote(loteMatch[1]);
        setMetodo('ocr');

        const fab = fabrMatch ? parseDate(fabrMatch[1]) : null;
        const val = validMatch ? parseDate(validMatch[1]) : null;
        if (fab) setFabricacao(fab);
        if (val) setValidade(val);

        setOcrResult('success');
      } else {
        setOcrResult('fail');
        setMetodo('manual');
      }
    } catch (err) {
      console.error('OCR error:', err);
      setOcrResult('fail');
      setMetodo('manual');
    } finally {
      setProcessing(false);
    }
  }, []);

  const handleConfirmar = () => {
    if (!lote.trim()) return;
    onLoteCapturado({
      numero_lote: lote.trim(),
      data_fabricacao: fabricacao || null,
      data_validade: validade || null,
      metodo_leitura: metodo,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-card border-b border-border">
        <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
          <ScanLine className="h-5 w-5 text-primary" />
          Scanner de Lote
        </h2>
        <Button variant="ghost" size="icon" onClick={onCancelar}>
          <X className="h-5 w-5" />
        </Button>
      </div>

      {/* Camera preview */}
      <div className="relative flex-shrink-0 bg-black" style={{ height: '45vh' }}>
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          playsInline
          muted
          autoPlay
        />
        <canvas ref={canvasRef} className="hidden" />

        {!cameraReady && !processing && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-white/70" />
          </div>
        )}

        {processing && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 gap-3">
            <Loader2 className="h-10 w-10 animate-spin text-primary" />
            <span className="text-sm font-medium text-white">Lendo etiqueta...</span>
          </div>
        )}

        {/* Scan frame overlay */}
        {cameraReady && !processing && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-[80%] h-[40%] border-2 border-dashed border-primary/70 rounded-lg" />
          </div>
        )}
      </div>

      {/* Capture button */}
      <div className="flex justify-center py-3 bg-card border-b border-border">
        <Button
          onClick={capture}
          disabled={!cameraReady || processing}
          className="gap-2"
          size="lg"
        >
          <Camera className="h-5 w-5" />
          Capturar
        </Button>
      </div>

      {/* OCR result feedback */}
      {ocrResult && (
        <div className={cn(
          'mx-4 mt-3 p-3 rounded-lg flex items-center gap-2 text-sm',
          ocrResult === 'success'
            ? 'bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-300'
            : 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
        )}>
          {ocrResult === 'success' ? (
            <>
              <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
              Lote lido com sucesso! Confira os dados abaixo.
            </>
          ) : (
            <>
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />
              Não foi possível ler automaticamente. Preencha manualmente.
            </>
          )}
        </div>
      )}

      {/* Manual / confirmation form */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        <div className="space-y-2">
          <Label htmlFor="lote" className="text-sm font-medium">Número do Lote *</Label>
          <Input
            id="lote"
            value={lote}
            onChange={e => { setLote(e.target.value); setMetodo('manual'); }}
            placeholder="Ex: 04540624"
            className="text-base"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="fabricacao" className="text-sm font-medium">Fabricação</Label>
            <Input
              id="fabricacao"
              type="date"
              value={fabricacao}
              onChange={e => { setFabricacao(e.target.value); if (lote) setMetodo('manual'); }}
              className="text-base"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="validade" className="text-sm font-medium">Validade</Label>
            <Input
              id="validade"
              type="date"
              value={validade}
              onChange={e => { setValidade(e.target.value); if (lote) setMetodo('manual'); }}
              className="text-base"
            />
          </div>
        </div>
      </div>

      {/* Footer actions */}
      <div className="flex gap-3 px-4 py-4 bg-card border-t border-border">
        <Button variant="outline" className="flex-1" onClick={onCancelar}>
          Cancelar
        </Button>
        <Button className="flex-1" disabled={!lote.trim()} onClick={handleConfirmar}>
          Confirmar Lote
        </Button>
      </div>
    </div>
  );
}
