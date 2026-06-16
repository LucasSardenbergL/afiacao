// Card mini de gamificação do CustomerDashboard.
// Extraído verbatim de src/components/CustomerDashboard.tsx (god-component split).
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Award, ChevronRight } from 'lucide-react';
import { useGamificationScore, getLevelInfo } from '@/hooks/useGamificationScore';

interface GamificationMiniProps {
  gamScore: NonNullable<ReturnType<typeof useGamificationScore>['data']>;
  levelInfo: ReturnType<typeof getLevelInfo>;
  navigate: ReturnType<typeof useNavigate>;
}

export function GamificationMini({ gamScore, levelInfo, navigate }: GamificationMiniProps) {
  return (
    <Card
      className="shadow-medium border-0 overflow-hidden cursor-pointer hover:shadow-strong transition-shadow"
      onClick={() => navigate('/gamification')}
    >
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-status-warning-bg flex items-center justify-center flex-shrink-0">
            <Award className="w-6 h-6 text-status-warning" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-1">
              <span className="font-semibold text-sm text-foreground">
                Nível {gamScore.level} — {gamScore.level_name}
              </span>
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            </div>
            <Progress value={gamScore.total_score} className="h-1.5" />
            <div className="flex justify-between mt-1">
              <span className="text-[10px] text-muted-foreground">{gamScore.total_score}/100 pts</span>
              {levelInfo.nextLevel && (
                <span className="text-[10px] text-muted-foreground">
                  Faltam {Math.ceil(levelInfo.nextLevel.min - gamScore.total_score)} para {levelInfo.nextLevel.name}
                </span>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
