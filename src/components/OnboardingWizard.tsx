import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wrench, ChevronRight, Sparkles, Package, CalendarClock, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

const ONBOARDING_DISMISSED_KEY = 'onboarding-dismissed';

const steps = [
  {
    icon: Wrench,
    title: 'Cadastre suas ferramentas',
    description: 'Adicione as ferramentas que você usa no dia a dia. Assim podemos rastrear cada uma individualmente.',
    action: 'Cadastrar agora',
    route: '/tools',
  },
  {
    icon: CalendarClock,
    title: 'Agende sua primeira afiação',
    description: 'Com suas ferramentas cadastradas, agende um pedido de afiação com coleta ou retirada.',
    action: 'Criar pedido',
    route: '/new-order',
  },
  {
    icon: Package,
    title: 'Acompanhe em tempo real',
    description: 'Receba atualizações do status do seu pedido e notificações quando estiver pronto.',
    action: 'Ver pedidos',
    route: '/orders',
  },
];

interface OnboardingWizardProps {
  hasTools: boolean;
  hasOrders: boolean;
}

export function OnboardingWizard({ hasTools, hasOrders }: OnboardingWizardProps) {
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);

  useEffect(() => {
    const wasDismissed = localStorage.getItem(ONBOARDING_DISMISSED_KEY);
    if (wasDismissed) setDismissed(true);
  }, []);

  // Auto-advance based on completed steps
  useEffect(() => {
    if (hasTools && currentStep === 0) setCurrentStep(1);
    if (hasOrders && currentStep <= 1) setCurrentStep(2);
  }, [hasTools, hasOrders, currentStep]);

  const handleDismiss = () => {
    setDismissed(true);
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, 'true');
  };

  if (dismissed) return null;

  const completedSteps = [hasTools, hasOrders, false]; // Step 3 is always "explore"
  const progressPercent = completedSteps.filter(Boolean).length / steps.length * 100;

  return (
    <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent shadow-strong mb-4 overflow-hidden animate-fade-in relative">
      <button
        onClick={handleDismiss}
        className="absolute top-3 right-3 p-1 text-muted-foreground hover:text-foreground z-10 rounded-full hover:bg-muted/50 transition-colors"
        aria-label="Dispensar"
      >
        <X className="w-4 h-4" />
      </button>

      <CardContent className="p-5">
        {/* Header */}
        <div className="flex items-center gap-2 mb-4">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h3 className="font-display font-bold text-foreground text-sm">
              Primeiros passos
            </h3>
            <p className="text-[10px] text-muted-foreground">
              {completedSteps.filter(Boolean).length}/{steps.length} concluídos
            </p>
          </div>
        </div>

        {/* Progress */}
        <Progress value={progressPercent} className="h-1.5 mb-5" />

        {/* Steps */}
        <div className="space-y-3">
          {steps.map((step, index) => {
            const isCompleted = completedSteps[index];
            const isCurrent = index === currentStep;
            const StepIcon = step.icon;

            return (
              <div
                key={index}
                className={cn(
                  'flex items-center gap-3 p-3 rounded-xl transition-all',
                  isCurrent && 'bg-card border border-border shadow-medium',
                  isCompleted && 'opacity-60',
                  !isCurrent && !isCompleted && 'opacity-40'
                )}
              >
                <div className={cn(
                  'w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors',
                  isCompleted ? 'bg-emerald-100 text-emerald-600' : isCurrent ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                )}>
                  {isCompleted ? (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <StepIcon className="w-5 h-5" />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <p className={cn(
                    'font-semibold text-sm',
                    isCompleted ? 'line-through text-muted-foreground' : 'text-foreground'
                  )}>
                    {step.title}
                  </p>
                  {isCurrent && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {step.description}
                    </p>
                  )}
                </div>

                {isCurrent && !isCompleted && (
                  <Button
                    size="sm"
                    className="flex-shrink-0"
                    onClick={() => navigate(step.route)}
                  >
                    {step.action}
                    <ChevronRight className="w-3 h-3 ml-1" />
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
