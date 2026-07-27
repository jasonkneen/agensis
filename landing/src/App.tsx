import {
  ArrowRight,
  Brain,
  Download,
  FileText,
  Github,
  MessageSquare,
  MousePointer2,
  PenTool,
  Users,
} from 'lucide-react';

const REPO_URL = 'https://github.com/jasonkneen/agensis';
const APP_URL = 'https://agensis.io';

function Logo() {
  return (
    <div className="flex items-center gap-2">
      <img src="/icon.svg" alt="" className="h-7 w-7" />
      <span className="text-base font-semibold tracking-tight">agensis</span>
    </div>
  );
}

function Nav() {
  return (
    <header className="relative z-20">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Logo />
        <nav className="flex items-center gap-6 text-sm">
          <a href="#features" className="text-agensis-muted hover:text-white transition-colors">
            Features
          </a>
          <a href="#teams" className="text-agensis-muted hover:text-white transition-colors">
            For teams
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-agensis-border bg-agensis-panel px-3 py-1.5 text-white hover:border-agensis-accent/60 hover:bg-agensis-panel/80 transition-colors"
          >
            <Github className="h-4 w-4" />
            GitHub
          </a>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-0 grid-bg radial-fade opacity-60" />
      <div
        className="absolute inset-x-0 top-0 h-[520px] opacity-40"
        style={{
          background:
            'radial-gradient(ellipse 60% 50% at 50% 0%, rgba(79,156,249,0.25), transparent 70%)',
        }}
      />
      <div className="relative mx-auto max-w-6xl px-6 pt-20 pb-28 text-center">
        <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-agensis-border bg-agensis-panel/70 px-3 py-1 text-xs text-agensis-muted backdrop-blur">
          <span className="h-1.5 w-1.5 rounded-full bg-agensis-accent" />
          Free to download. Run it locally.
        </div>
        <h1 className="mx-auto mt-6 max-w-3xl text-5xl font-semibold tracking-tight sm:text-6xl">
          A collaborative workspace
          <br />
          <span className="text-agensis-muted">built for teams.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-lg text-agensis-muted">
          Chat, documents, memory, files and a shared realtime canvas — all in one workspace your
          team actually wants to use.
        </p>
        <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a
            href={APP_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-md bg-white px-5 py-3 text-sm font-medium text-black hover:bg-white/90 transition-colors"
          >
            <Download className="h-4 w-4" />
            Open agensis.io
          </a>
          <a
            href="#features"
            className="inline-flex items-center gap-1.5 rounded-md border border-agensis-border bg-agensis-panel px-5 py-3 text-sm font-medium text-white hover:border-agensis-accent/60 transition-colors"
          >
            See what's inside
            <ArrowRight className="h-4 w-4" />
          </a>
        </div>
      </div>

      <div className="relative mx-auto max-w-5xl px-6 pb-24">
        <div className="overflow-hidden rounded-xl border border-agensis-border bg-agensis-panel shadow-2xl shadow-black/60">
          <div className="flex items-center gap-1.5 border-b border-agensis-border px-4 py-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-[#3a3a3a]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#3a3a3a]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#3a3a3a]" />
            <span className="ml-3 text-xs text-agensis-muted">workspace — team canvas</span>
          </div>
          <div className="relative aspect-[16/9] w-full overflow-hidden bg-[#0f0f0f]">
            <div className="absolute inset-0 grid-bg opacity-70" />
            <div className="absolute left-[8%] top-[18%] w-56 rounded-md border border-agensis-border bg-[#181818] p-3 text-left shadow-lg">
              <div className="flex items-center gap-2 text-xs text-agensis-muted">
                <MessageSquare className="h-3.5 w-3.5" />
                AI chat
              </div>
              <div className="mt-2 text-xs text-white/80">Summarise the roadmap notes →</div>
              <div className="mt-2 h-1.5 w-28 rounded-full bg-white/10" />
              <div className="mt-1 h-1.5 w-20 rounded-full bg-white/10" />
            </div>
            <div className="absolute right-[10%] top-[14%] w-52 rounded-md border border-agensis-border bg-[#181818] p-3 text-left shadow-lg">
              <div className="flex items-center gap-2 text-xs text-agensis-muted">
                <FileText className="h-3.5 w-3.5" />
                Q2 plan
              </div>
              <div className="mt-2 h-1.5 w-36 rounded-full bg-white/10" />
              <div className="mt-1 h-1.5 w-24 rounded-full bg-white/10" />
              <div className="mt-1 h-1.5 w-32 rounded-full bg-white/10" />
            </div>
            <div className="absolute bottom-[14%] left-[22%] w-40 rounded-md border border-agensis-border bg-[#1a1610] p-3 text-left shadow-lg">
              <div className="text-xs text-amber-300/90">sticky note</div>
              <div className="mt-1 text-xs text-white/80">ship beta → Friday</div>
            </div>
            <div className="absolute bottom-[22%] right-[18%] flex items-center gap-2">
              <MousePointer2
                className="h-4 w-4 -rotate-12 text-agensis-accent"
                fill="currentColor"
              />
              <span className="rounded bg-agensis-accent px-1.5 py-0.5 text-[10px] font-medium text-white">
                alex
              </span>
            </div>
            <div className="absolute right-[40%] top-[40%] flex items-center gap-2">
              <MousePointer2 className="h-4 w-4 -rotate-12 text-pink-400" fill="currentColor" />
              <span className="rounded bg-pink-500 px-1.5 py-0.5 text-[10px] font-medium text-white">
                sam
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const features = [
  {
    icon: PenTool,
    title: 'Shared realtime canvas',
    body: 'Draw, drop shapes, sticky notes, arrows and strokes that everyone sees instantly.',
  },
  {
    icon: MessageSquare,
    title: 'AI chat, inline',
    body: 'Ask, summarise and brainstorm without leaving the workspace.',
  },
  {
    icon: FileText,
    title: 'Documents with autosave',
    body: 'Write alongside the canvas. Changes save as you type.',
  },
  {
    icon: Brain,
    title: 'Team memory',
    body: 'Keep facts, snippets and context your whole team can build on.',
  },
  {
    icon: Users,
    title: 'Live presence & cursors',
    body: 'See who is where. Follow along, or break off and explore.',
  },
  {
    icon: Download,
    title: 'Local-first, free',
    body: 'Clone, install, run. Bring your own Supabase project and go.',
  },
] as const;

function Features() {
  return (
    <section id="features" className="relative border-t border-agensis-border">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <div className="max-w-2xl">
          <div className="text-xs uppercase tracking-wider text-agensis-accent">Features</div>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            One workspace. Everything your team needs.
          </h2>
          <p className="mt-4 text-agensis-muted">
            agensis brings the tools teams already reach for into a single shared room — without
            the tab-juggling.
          </p>
        </div>

        <div className="mt-14 grid gap-px overflow-hidden rounded-xl border border-agensis-border bg-agensis-border sm:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, body }) => (
            <div key={title} className="bg-agensis-bg p-6">
              <div className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-agensis-border bg-agensis-panel text-agensis-accent">
                <Icon className="h-4 w-4" />
              </div>
              <h3 className="mt-4 text-base font-medium text-white">{title}</h3>
              <p className="mt-1.5 text-sm text-agensis-muted">{body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Teams() {
  return (
    <section id="teams" className="relative border-t border-agensis-border">
      <div className="mx-auto grid max-w-6xl gap-16 px-6 py-24 lg:grid-cols-2 lg:items-center">
        <div>
          <div className="text-xs uppercase tracking-wider text-agensis-accent">For teams</div>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Think together, in the same room.
          </h2>
          <p className="mt-4 text-agensis-muted">
            Workspaces are the unit of collaboration. Invite members, assign roles, and work side
            by side on the same canvas — with local windows that don't get in anyone's way.
          </p>
          <ul className="mt-8 space-y-4 text-sm">
            {[
              'Workspace-first sharing with members and roles',
              'Local windows, shared content — no one gets dragged around',
              'Realtime cursors and presence so context stays alive',
              'Drop files, images and notes anywhere on the canvas',
            ].map((line) => (
              <li key={line} className="flex items-start gap-3 text-white/90">
                <span className="mt-1.5 h-1.5 w-1.5 flex-none rounded-full bg-agensis-accent" />
                {line}
              </li>
            ))}
          </ul>
        </div>

        <div className="relative">
          <div
            className="absolute -inset-10 opacity-40"
            style={{
              background:
                'radial-gradient(circle at 50% 50%, rgba(79,156,249,0.25), transparent 60%)',
            }}
          />
          <div className="relative overflow-hidden rounded-xl border border-agensis-border bg-agensis-panel">
            <div className="grid grid-cols-2 gap-px bg-agensis-border">
              {[
                { name: 'Product', count: 6 },
                { name: 'Design', count: 4 },
                { name: 'Research', count: 3 },
                { name: 'Launch', count: 8 },
              ].map((w) => (
                <div key={w.name} className="bg-agensis-bg p-5">
                  <div className="flex items-center justify-between text-xs text-agensis-muted">
                    <span>workspace</span>
                    <span>{w.count} members</span>
                  </div>
                  <div className="mt-2 text-base font-medium text-white">{w.name}</div>
                  <div className="mt-4 flex -space-x-1.5">
                    {Array.from({ length: Math.min(w.count, 5) }).map((_, i) => (
                      <div
                        key={i}
                        className="h-6 w-6 rounded-full border-2 border-agensis-bg"
                        style={{
                          background: ['#4f9cf9', '#f472b6', '#34d399', '#fbbf24', '#a78bfa'][i],
                        }}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// The three plans from docs/pricing — Free, Pro, Team. Prices are the ANNUAL
// per-seat rate with the month-to-month figure alongside, because quoting only
// the lower number and burying the real one is the thing that makes pricing
// pages feel dishonest. Numbers live in one array so a change is one edit.
const PLANS = [
  {
    name: 'Free',
    price: '$0',
    cadence: 'forever',
    note: 'Everything you need to try it properly.',
    features: [
      '1 workspace, 1 seat',
      '2 connected daemons — your key, unlimited inference',
      'Managed inference: auto-interject only (~200 calls/mo)',
      '7-day history · 100 MB uploads',
      'Community support',
    ],
    cta: 'Download',
    highlighted: false,
  },
  {
    name: 'Pro',
    price: '$20',
    cadence: 'per month, billed annually',
    aside: '$24 month-to-month',
    note: 'For one person running a lot of agents.',
    features: [
      'Unlimited workspaces',
      'Unlimited connected daemons — your key',
      'Managed inference: $5/mo token allowance, then bring your key',
      'Full history · 5 GB uploads',
      'Split / merge, thread widgets, memory palace',
      'Email support',
    ],
    cta: 'Start with Pro',
    highlighted: true,
  },
  {
    name: 'Team',
    price: '$50',
    cadence: 'per seat / month, billed annually',
    aside: '$60 month-to-month · min 3 seats',
    note: 'Shared agents, shared memory, one bill.',
    features: [
      'Everything in Pro',
      'Pooled inference allowance across the team, plus your own key',
      'SSO, roles and audit log',
      '50 GB uploads · durable object storage',
      'Priority support and onboarding',
    ],
    cta: 'Talk to us',
    highlighted: false,
  },
];

function Pricing() {
  return (
    <section id="pricing" className="relative border-t border-agensis-border">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <div className="mx-auto max-w-2xl text-center">
          <div className="text-xs uppercase tracking-wider text-agensis-accent">Pricing</div>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Your inference stays free.
          </h2>
          <p className="mt-4 text-agensis-muted">
            Connect your own key and the model calls are yours, on every plan including the free
            one. You are paying for the workspace around them, not for the tokens.
          </p>
        </div>

        <div className="mx-auto mt-14 grid max-w-5xl items-start gap-6 md:grid-cols-3">
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className={
                plan.highlighted
                  ? 'relative rounded-xl border border-agensis-accent/40 bg-agensis-panel p-8'
                  : 'rounded-xl border border-agensis-border bg-agensis-panel p-8'
              }
            >
              {plan.highlighted && (
                <div className="absolute right-5 top-5 rounded-full border border-agensis-accent/40 bg-agensis-accent/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-agensis-accent">
                  Most picked
                </div>
              )}
              <div className="text-sm text-agensis-muted">{plan.name}</div>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="text-4xl font-semibold text-white">{plan.price}</span>
              </div>
              <div className="mt-1 text-sm text-agensis-muted">{plan.cadence}</div>
              {plan.aside && (
                <div className="mt-0.5 text-xs text-agensis-muted/80">{plan.aside}</div>
              )}
              <p className="mt-3 text-sm text-agensis-muted">{plan.note}</p>
              <ul className="mt-6 space-y-2.5 text-sm text-white/90">
                {plan.features.map((line) => (
                  <li key={line} className="flex items-start gap-2.5">
                    <span className="mt-1.5 h-1.5 w-1.5 flex-none rounded-full bg-agensis-accent" />
                    {line}
                  </li>
                ))}
              </ul>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                className={
                  plan.highlighted
                    ? 'mt-8 inline-flex w-full items-center justify-center gap-2 rounded-md bg-white px-4 py-2.5 text-sm font-medium text-black hover:bg-white/90 transition-colors'
                    : 'mt-8 inline-flex w-full items-center justify-center gap-2 rounded-md border border-agensis-border bg-agensis-bg px-4 py-2.5 text-sm font-medium text-white hover:border-agensis-accent/60 transition-colors'
                }
              >
                {plan.cta}
                <ArrowRight className="h-4 w-4" />
              </a>
            </div>
          ))}
        </div>

        <p className="mx-auto mt-10 max-w-2xl text-center text-sm text-agensis-muted">
          Self-hosting stays free and ungated — clone it, bring your own database, and every
          feature is there. Paid plans are the hosted version.
        </p>
      </div>
    </section>
  );
}

function CTA() {
  return (
    <section className="relative border-t border-agensis-border">
      <div className="mx-auto max-w-4xl px-6 py-24 text-center">
        <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Start with agensis. Bring your team in.
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-agensis-muted">
          Free forever, local-first, and built for the way teams actually think together.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-md bg-white px-5 py-3 text-sm font-medium text-black hover:bg-white/90 transition-colors"
          >
            <Github className="h-4 w-4" />
            Get it on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-agensis-border">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 text-sm text-agensis-muted sm:flex-row">
        <Logo />
        <div>© {new Date().getFullYear()} agensis. MIT licensed.</div>
      </div>
    </footer>
  );
}

export default function App() {
  return (
    <div className="min-h-screen bg-agensis-bg">
      <Nav />
      <main>
        <Hero />
        <Features />
        <Teams />
        <Pricing />
        <CTA />
      </main>
      <Footer />
    </div>
  );
}
