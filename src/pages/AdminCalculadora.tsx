import { RendimentoCalculator } from '@/components/knowledge-base/RendimentoCalculator';

export default function AdminCalculadora() {
  return (
    <div className="container mx-auto p-4 space-y-3 max-w-2xl">
      <div>
        <h1 className="text-xl font-semibold">Calculadora de rendimento</h1>
        <p className="text-xs text-muted-foreground">
          Calcula consumo de tinta baseado em área a pintar + boletim técnico aprovado.
          Use durante chamadas pra dar números precisos pro cliente.
        </p>
      </div>
      <RendimentoCalculator />
    </div>
  );
}
