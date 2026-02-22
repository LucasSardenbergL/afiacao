import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Download, Award, Star, Trophy, Shield } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface CertificateProps {
  userName: string;
  levelName: string;
  level: number;
  totalScore: number;
  date?: string;
}

const LEVEL_ICONS: Record<number, typeof Award> = {
  1: Shield,
  2: Shield,
  3: Award,
  4: Star,
  5: Trophy,
};

export function GamificationCertificate({ userName, levelName, level, totalScore, date }: CertificateProps) {
  const certRef = useRef<HTMLDivElement>(null);

  const generatePDF = () => {
    if (!certRef.current) return;

    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    const certDate = date || format(new Date(), "dd 'de' MMMM 'de' yyyy", { locale: ptBR });

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Certificado - ${userName}</title>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            @page { size: landscape; margin: 0; }
            body {
              display: flex; align-items: center; justify-content: center;
              min-height: 100vh; font-family: 'Georgia', serif;
              background: white;
            }
            .cert {
              width: 900px; height: 620px; position: relative;
              border: 3px solid #1a1a1a; padding: 50px;
              display: flex; flex-direction: column; align-items: center;
              justify-content: center; text-align: center;
            }
            .cert::before {
              content: ''; position: absolute; inset: 8px;
              border: 1px solid #ccc;
            }
            .corner { position: absolute; width: 60px; height: 60px; }
            .corner-tl { top: 15px; left: 15px; border-top: 3px solid #b8860b; border-left: 3px solid #b8860b; }
            .corner-tr { top: 15px; right: 15px; border-top: 3px solid #b8860b; border-right: 3px solid #b8860b; }
            .corner-bl { bottom: 15px; left: 15px; border-bottom: 3px solid #b8860b; border-left: 3px solid #b8860b; }
            .corner-br { bottom: 15px; right: 15px; border-bottom: 3px solid #b8860b; border-right: 3px solid #b8860b; }
            .title { font-size: 14px; letter-spacing: 6px; text-transform: uppercase; color: #666; margin-bottom: 10px; }
            .main-title { font-size: 36px; color: #1a1a1a; margin-bottom: 25px; font-weight: bold; }
            .recipient { font-size: 28px; color: #b8860b; margin-bottom: 15px; font-style: italic; }
            .level-badge {
              display: inline-block; padding: 8px 30px; border: 2px solid #1a1a1a;
              font-size: 18px; font-weight: bold; letter-spacing: 3px;
              text-transform: uppercase; margin-bottom: 15px;
            }
            .score { font-size: 14px; color: #666; margin-bottom: 25px; }
            .description { font-size: 13px; color: #555; max-width: 500px; line-height: 1.6; margin-bottom: 30px; }
            .footer { display: flex; justify-content: space-between; width: 100%; padding: 0 40px; }
            .footer-item { text-align: center; }
            .footer-line { width: 180px; border-top: 1px solid #333; margin-bottom: 5px; }
            .footer-label { font-size: 11px; color: #666; }
            .date { font-size: 12px; color: #888; margin-top: auto; }
          </style>
        </head>
        <body>
          <div class="cert">
            <div class="corner corner-tl"></div>
            <div class="corner corner-tr"></div>
            <div class="corner corner-bl"></div>
            <div class="corner corner-br"></div>
            
            <p class="title">Certificado de Mérito</p>
            <h1 class="main-title">COLACOR</h1>
            <p style="font-size: 14px; color: #666; margin-bottom: 20px;">Certifica que</p>
            <p class="recipient">${userName}</p>
            <div class="level-badge">Nível ${level} — ${levelName}</div>
            <p class="score">Pontuação: ${totalScore}/100</p>
            <p class="description">
              Alcançou o nível <strong>${levelName}</strong> no Sistema de Gamificação Meritocrática,
              demonstrando excelência em manutenção preventiva, organização, educação técnica e eficiência operacional.
            </p>
            
            <div class="footer">
              <div class="footer-item">
                <div class="footer-line"></div>
                <p class="footer-label">Colacor Afiações</p>
              </div>
              <div class="footer-item">
                <div class="footer-line"></div>
                <p class="footer-label">${certDate}</p>
              </div>
            </div>
          </div>
          <script>
            setTimeout(() => { window.print(); }, 300);
          </script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  if (level < 3) return null; // Only show for Profissional+

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" className="w-full gap-2">
          <Download className="w-4 h-4" />
          Baixar Certificado de Nível
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Certificado — {levelName}</DialogTitle>
        </DialogHeader>

        <div ref={certRef} className="border-2 border-foreground rounded-lg p-6 text-center space-y-3 bg-card">
          <p className="text-[10px] tracking-[4px] uppercase text-muted-foreground">Certificado de Mérito</p>
          <h2 className="text-xl font-display font-bold text-foreground">COLACOR</h2>
          <p className="text-xs text-muted-foreground">Certifica que</p>
          <p className="text-lg font-semibold text-primary italic">{userName}</p>
          <div className="inline-block border border-foreground px-4 py-1 text-sm font-bold tracking-wider uppercase">
            Nível {level} — {levelName}
          </div>
          <p className="text-xs text-muted-foreground">Pontuação: {totalScore}/100</p>
          <p className="text-[11px] text-muted-foreground max-w-xs mx-auto">
            Alcançou o nível {levelName} no Sistema de Gamificação Meritocrática.
          </p>
        </div>

        <Button className="w-full" onClick={generatePDF}>
          <Download className="w-4 h-4 mr-2" />
          Gerar PDF para Impressão
        </Button>
      </DialogContent>
    </Dialog>
  );
}
