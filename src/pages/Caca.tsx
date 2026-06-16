/**
 * Página /caca — fila de caça (Frente B).
 *
 * Cabeçalho + container reutilizável `CacaConteudo`. Segue o layout das demais
 * páginas de staff (header `font-display`, densidade B2B). Gateada por staff na
 * rota (`<RequireStaff>` em App.tsx).
 */

import { CacaConteudo } from '@/components/caca/CacaConteudo';

const Caca = () => {
  return (
    <div className="p-4 space-y-4">
      <header>
        <h1 className="font-display text-2xl">Caça</h1>
        <p className="text-sm text-muted-foreground">
          Clientes parecidos com seus melhores que ainda não compram.
        </p>
      </header>

      <CacaConteudo />
    </div>
  );
};

export default Caca;
