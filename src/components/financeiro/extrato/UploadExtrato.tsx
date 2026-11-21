import { useRef } from 'react';
import { Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { UltimaExecucao } from '@/components/execucoes/UltimaExecucao';

export const ACAO_IMPORTAR_EXTRATO = 'banco.extrato_importar';

interface Props {
  desabilitado: boolean;
  enviando: boolean;
  onArquivo: (file: File) => void;
}

export function UploadExtrato({ desabilitado, enviando, onArquivo }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <input
        ref={ref}
        type="file"
        accept=".ofx,.ret,.rem,.txt,.cnab"
        className="hidden"
        data-testid="extrato-arquivo"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onArquivo(f);
        }}
      />
      <Button disabled={desabilitado || enviando} onClick={() => ref.current?.click()}>
        <Upload className="mr-2 h-4 w-4" />
        {enviando ? 'Importando…' : 'Importar extrato'}
      </Button>
      <UltimaExecucao acao={ACAO_IMPORTAR_EXTRATO} />
    </div>
  );
}
