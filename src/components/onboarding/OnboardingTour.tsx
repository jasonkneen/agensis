import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Bot, Rocket, Sparkles, Users, X, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

interface OnboardingTourProps {
  onComplete: () => void;
  /** Open the AI Agents window (connect an existing agent or create a new one). */
  onCreateAgent?: () => void;
  /** Open the Users window (invite a teammate). */
  onInvite?: () => void;
}

interface WelcomeStep {
  icon: LucideIcon;
  /** tinted accent circle behind the icon — fixed hues so it reads in light + dark */
  accent: string;
  eyebrow: string;
  title: string;
  body: string;
  /** optional primary action; running it finishes the tour and hands off */
  actionKey?: 'agent' | 'invite';
  actionLabel?: string;
}

const WELCOME_STEPS: WelcomeStep[] = [
  {
    icon: Sparkles,
    accent: 'from-primary/25 to-primary/5 text-primary ring-primary/20',
    eyebrow: 'Welcome to Agensis',
    title: 'One workspace for your agents and your team.',
    body: 'Agensis is the shared hub where the AI agents you rely on and the people you work with collaborate side by side — same rooms, same context, same memory.',
  },
  {
    icon: Bot,
    accent: 'from-sky-500/25 to-sky-500/5 text-sky-500 ring-sky-500/20',
    eyebrow: 'Step 1',
    title: 'Bring in an agent.',
    body: 'Start with an agent. Connect one you already use, or spin up a new one — it lives in your workspace and works alongside you in every room.',
    actionKey: 'agent',
    actionLabel: 'Add an agent',
  },
  {
    icon: Users,
    accent: 'from-emerald-500/25 to-emerald-500/5 text-emerald-500 ring-emerald-500/20',
    eyebrow: 'Step 2',
    title: 'Invite your people.',
    body: 'Agents are better with a team around them. Invite the humans you work with so everyone shares the same rooms, history, and agents.',
    actionKey: 'invite',
    actionLabel: 'Invite people',
  },
  {
    icon: Rocket,
    accent: 'from-amber-500/25 to-amber-500/5 text-amber-500 ring-amber-500/20',
    eyebrow: "You're set",
    title: 'Start collaborating.',
    body: "That's the loop — agents and people in one place. The checklist in the corner tracks your first steps whenever you're ready.",
  },
];

export function OnboardingTour({ onComplete, onCreateAgent, onInvite }: OnboardingTourProps) {
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);
  const dismissedRef = useRef(false);

  // Mount closed, then open on the next tick so Radix plays the zoom/fade-in.
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 120);
    return () => clearTimeout(timer);
  }, []);

  const total = WELCOME_STEPS.length;
  const current = WELCOME_STEPS[Math.min(step, total - 1)];
  const isLast = step >= total - 1;

  const handleDismiss = () => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    setVisible(false);
    setTimeout(onComplete, 200);
  };

  const handleNext = () => {
    if (isLast) handleDismiss();
    else setStep(s => Math.min(s + 1, total - 1));
  };

  // Fire the pane's CTA, then finish the tour so the target window is unobstructed.
  const runAction = () => {
    if (current.actionKey === 'agent') onCreateAgent?.();
    else if (current.actionKey === 'invite') onInvite?.();
    handleDismiss();
  };

  if (!current) return null;

  const Icon = current.icon;

  return (
    <Dialog
      open={visible}
      onOpenChange={nextOpen => {
        if (!nextOpen) handleDismiss();
      }}
    >
      <DialogContent
        className="w-[calc(100vw-2rem)] gap-0 overflow-hidden p-0 sm:max-w-lg"
        showCloseButton={false}
      >
        <Progress value={((step + 1) / total) * 100} className="rounded-none" />

        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={handleDismiss}
          title="Skip"
          className="absolute right-2 top-3 text-muted-foreground"
        >
          <X className="size-4" />
          <span className="sr-only">Skip onboarding</span>
        </Button>

        <div className="flex flex-col items-center px-8 pb-6 pt-10 text-center">
          <div
            className={cn(
              'mb-5 grid size-16 place-items-center rounded-2xl bg-gradient-to-br ring-1',
              current.accent,
            )}
          >
            <Icon className="size-7" />
          </div>

          <span className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {current.eyebrow}
          </span>
          <DialogTitle className="text-balance text-xl font-semibold leading-snug text-foreground">
            {current.title}
          </DialogTitle>
          <DialogDescription className="mt-3 max-w-md text-pretty text-sm leading-relaxed text-muted-foreground">
            {current.body}
          </DialogDescription>

          {current.actionLabel && (
            <Button type="button" onClick={runAction} className="mt-6">
              {current.actionLabel}
              <ArrowRight data-icon="inline-end" className="size-4" />
            </Button>
          )}

          <div className="mt-7 flex gap-1.5">
            {WELCOME_STEPS.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setStep(i)}
                aria-label={`Go to step ${i + 1}`}
                className={cn(
                  'h-1.5 rounded-full transition-all',
                  i === step ? 'w-5 bg-primary' : 'w-1.5 bg-muted-foreground/30 hover:bg-muted-foreground/50',
                )}
              />
            ))}
          </div>
        </div>

        <footer className="flex items-center justify-between gap-3 border-t bg-muted/40 px-5 py-3">
          <Button type="button" variant="ghost" size="sm" onClick={handleDismiss} className="text-muted-foreground">
            Skip
          </Button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <Button type="button" variant="outline" size="sm" onClick={() => setStep(s => s - 1)}>
                <ArrowLeft data-icon="inline-start" className="size-4" />
                Back
              </Button>
            )}
            <Button type="button" size="sm" onClick={handleNext}>
              {isLast ? 'Get started' : 'Next'}
              {!isLast && <ArrowRight data-icon="inline-end" className="size-4" />}
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
