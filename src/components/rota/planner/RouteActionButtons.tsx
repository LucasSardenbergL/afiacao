// Botões de ação da rota (abrir no Google Maps / Waze) do planejador de rotas.
// Extraído de src/pages/AdminRoutePlanner.tsx (god-component split).
// Self-contained: a lógica de geolocation/URL vive aqui; recebe só a rota otimizada.
import { Navigation, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import type { RouteStop } from './types';

export function RouteActionButtons({ optimizedRoute }: { optimizedRoute: RouteStop[] }) {
  if (!optimizedRoute.some(s => s.lat && s.lng)) return null;

  const openInGoogleMaps = () => {
    const stopsWithCoords = optimizedRoute.filter(s => s.lat && s.lng).slice(0, 25);
    const tooMany = optimizedRoute.filter(s => s.lat && s.lng).length > 25;

    if (tooMany) {
      toast.success('Google Maps suporta até 25 paradas', { description: 'Mostrando as 25 de maior prioridade.' });
    }

    const waypoints = stopsWithCoords.map(s => `${s.lat},${s.lng}`);

    // Try to get current location as origin
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const origin = `${pos.coords.latitude},${pos.coords.longitude}`;
          const url = `https://www.google.com/maps/dir/${origin}/${waypoints.join('/')}`;
          window.open(url, '_blank');
        },
        () => {
          // Fallback: start from first waypoint
          const url = `https://www.google.com/maps/dir/${waypoints.join('/')}`;
          window.open(url, '_blank');
        },
        { timeout: 5000 }
      );
    } else {
      const url = `https://www.google.com/maps/dir/${waypoints.join('/')}`;
      window.open(url, '_blank');
    }
  };

  const openInWaze = () => {
    const first = optimizedRoute.find(s => s.lat && s.lng);
    if (first) {
      window.open(`https://waze.com/ul?ll=${first.lat},${first.lng}&navigate=yes`, '_blank');
    }
  };

  return (
    <div className="flex gap-2">
      <Button className="flex-1 gap-2" onClick={openInGoogleMaps}>
        <Navigation className="w-4 h-4" />
        Abrir rota no Google Maps
      </Button>
      <Button variant="outline" className="gap-2" onClick={openInWaze}>
        <ExternalLink className="w-4 h-4" />
        Waze
      </Button>
    </div>
  );
}
