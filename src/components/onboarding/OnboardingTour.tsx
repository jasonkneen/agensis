import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Sparkles, X } from 'lucide-react';
import { ONBOARDING_STEPS } from '../../types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

interface OnboardingTourProps {
  onComplete: () => void;
}

export function OnboardingTour({ onComplete }: OnboardingTourProps) {
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);
  const dismissedRef = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 600);
    return () => clearTimeout(timer);
  }, []);

  const totalSteps = ONBOARDING_STEPS.length;
  const currentStep = ONBOARDING_STEPS[Math.min(step, totalSteps - 1)];
  const isLast = step >= totalSteps - 1;

  const handleDismiss = () => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    setVisible(false);
    setTimeout(onComplete, 300);
  };

  const handleNext = () => {
    if (isLast) {
      handleDismiss();
    } else {
      setStep(s => Math.min(s + 1, totalSteps - 1));
    }
  };

  if (!currentStep) return null;

  return (
    <Dialog
      open={visible}
      onOpenChange={nextOpen => {
        if (!nextOpen) handleDismiss();
      }}
    >
      <DialogContent className="w-[calc(100vw-2rem)] max-w-sm overflow-hidden p-0" showCloseButton={false}>
        <Progress value={((step + 1) / totalSteps) * 100} className="rounded-none" />

        <div className="p-6">
          <header className="mb-4 flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                <Sparkles data-icon="inline-start" className="size-4" />
              </div>
              <div>
                <Badge variant="secondary" className="mb-1 text-[10px] uppercase tracking-normal">
                  Step {step + 1} of {totalSteps}
                </Badge>
                <h3 className="text-base font-semibold leading-tight text-foreground">{currentStep.title}</h3>
              </div>
            </div>
            <Button type="button" variant="ghost" size="icon-sm" onClick={handleDismiss} title="Close tour">
              <X data-icon="inline-start" className="size-4" />
            </Button>
          </header>

          <p className="mb-5 text-sm leading-relaxed text-muted-foreground">{currentStep.body}</p>

          <div className="mb-4 flex gap-1.5">
            {ONBOARDING_STEPS.map((_, i) => (
              <Button
                key={i}
                type="button"
                variant={i === step ? 'default' : 'secondary'}
                size="icon-xs"
                onClick={() => setStep(i)}
                aria-label={`Step ${i + 1}`}
                className={cn('h-1.5 rounded-full p-0', i === step ? 'w-5' : 'w-1.5')}
              />
            ))}
          </div>

          <footer className="flex items-center justify-between gap-3">
            <Button type="button" variant="ghost" size="sm" onClick={handleDismiss}>
              Skip tour
            </Button>
            <div className="flex items-center gap-2">
              {step > 0 && (
                <Button type="button" variant="outline" size="sm" onClick={() => setStep(s => s - 1)}>
                  <ChevronLeft data-icon="inline-start" className="size-4" />
                  Back
                </Button>
              )}
              <Button type="button" size="sm" onClick={handleNext}>
                {isLast ? 'Get Started' : 'Next'}
                <ChevronRight data-icon="inline-end" className="size-4" />
              </Button>
            </div>
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  );
}
