import { useState } from 'react';
import {
  ArrowRight,
  Brain,
  Download,
  FileText,
  Github,
  MessageSquare,
  Minus,
  MousePointer2,
  PenTool,
  Plus,
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
          <a href="#faq" className="text-agensis-muted hover:text-white transition-colors">
            FAQ
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

function Pricing() {
  return (
    <section id="pricing" className="relative border-t border-agensis-border">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <div className="mx-auto max-w-2xl text-center">
          <div className="text-xs uppercase tracking-wider text-agensis-accent">Pricing</div>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            The app is free. Always.
          </h2>
          <p className="mt-4 text-agensis-muted">
            Download agensis and run it on your own infrastructure at no cost. Need somewhere to
            keep everyone's files? Add cloud storage when you're ready.
          </p>
        </div>

        <div className="mx-auto mt-14 grid max-w-4xl gap-6 md:grid-cols-2">
          <div className="rounded-xl border border-agensis-border bg-agensis-panel p-8">
            <div className="text-sm text-agensis-muted">Local</div>
            <div className="mt-2 flex items-baseline gap-1">
              <span className="text-4xl font-semibold text-white">Free</span>
              <span className="text-agensis-muted">forever</span>
            </div>
            <p className="mt-3 text-sm text-agensis-muted">
              Clone, install, run. Bring your own Supabase project. All features included.
            </p>
            <ul className="mt-6 space-y-2.5 text-sm text-white/90">
              {[
                'Full app, no feature gates',
                'Realtime canvas, chat, docs, memory',
                'Self-hosted — your data, your rules',
              ].map((line) => (
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
              className="mt-8 inline-flex w-full items-center justify-center gap-2 rounded-md bg-white px-4 py-2.5 text-sm font-medium text-black hover:bg-white/90 transition-colors"
            >
              <Download className="h-4 w-4" />
              Download
            </a>
          </div>

          <div className="relative rounded-xl border border-agensis-accent/40 bg-agensis-panel p-8">
            <div className="absolute right-5 top-5 rounded-full border border-agensis-accent/40 bg-agensis-accent/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-agensis-accent">
              Optional
            </div>
            <div className="text-sm text-agensis-muted">Cloud storage</div>
            <div className="mt-2 flex items-baseline gap-1">
              <span className="text-4xl font-semibold text-white">$6</span>
              <span className="text-agensis-muted">/ user / month</span>
            </div>
            <p className="mt-3 text-sm text-agensis-muted">
              Managed storage for files, uploads and snapshots. Skip the self-hosting for the
              heaviest bit.
            </p>
            <ul className="mt-6 space-y-2.5 text-sm text-white/90">
              {[
                '100 GB per user, pooled across the team',
                'Automatic backups & versioning',
                'Drop-in — no code changes',
              ].map((line) => (
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
              className="mt-8 inline-flex w-full items-center justify-center gap-2 rounded-md border border-agensis-border bg-agensis-bg px-4 py-2.5 text-sm font-medium text-white hover:border-agensis-accent/60 transition-colors"
            >
              Join the waitlist
              <ArrowRight className="h-4 w-4" />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}


// FAQ ------------------------------------------------------------------------
// One open at a time, the first open on load. Single-open rather than
// independent toggles because these answers are read while deciding, not
// compared side by side — and an accordion where everything can be open at once
// is just a long page with extra clicks.
const faqs: { q: string; a: string[] }[] = [
  {
    q: 'What is agensis?',
    a: [
      'One shared workspace where a team and its AI agents work in the same room: a realtime canvas, chat, documents and a shared memory, rather than four tools and a pile of tabs.',
      'Agents are members of that room. They read the same threads, write to the same documents, and leave their work where the conversation happened — so context survives the person who created it.',
    ],
  },
  {
    q: 'What do I need to run it?',
    a: [
      'The app itself and somewhere to run it. agensis is free and self-hosted, so your data stays on your own infrastructure.',
      'Agents use the AI subscriptions you already pay for. There is no separate agensis inference bill.',
    ],
  },
  {
    q: 'Is it really free?',
    a: [
      'Yes — the whole app, with no feature gates. Self-hosting means you provide the infrastructure and keep the data.',
      'The only paid option is hosted storage if you would rather not run your own: $6 per user per month for 100 GB pooled across the team, with backups and versioning.',
    ],
  },
  {
    q: 'Where does my data live?',
    a: [
      'Wherever you put it. Self-hosted means the canvas, documents, messages and memory sit on infrastructure you control.',
      'Hosted storage is opt-in and additive — a place to keep files, not a condition of using the product.',
    ],
  },
  {
    q: 'Can I bring my own agents?',
    a: [
      'Yes. Agents connect to a workspace and appear alongside everyone else, so an agent you already run can join a channel and be addressed like any other member.',
      'Each one can use whichever model suits its job; they do not all have to run the same thing.',
    ],
  },
  {
    q: 'Do agents act on their own?',
    a: [
      'They keep work moving between your check-ins, and everything they do lands in a thread you can read.',
      'You set the direction and make the final call. Nothing an agent does is hidden from the room it happened in.',
    ],
  },
  {
    q: 'Is it open source?',
    a: ['Yes. The source is on GitHub, and self-hosting is the default rather than an enterprise upsell.'],
  },
];

function Faq() {
  const [open, setOpen] = useState(0);

  return (
    <section id="faq" className="relative border-t border-agensis-border">
      <div className="mx-auto max-w-3xl px-6 py-24">
        <div className="max-w-2xl">
          <div className="text-xs uppercase tracking-wider text-agensis-accent">FAQ</div>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Questions, answered.
          </h2>
        </div>

        <div className="mt-12 divide-y divide-agensis-border border-y border-agensis-border">
          {faqs.map(({ q, a }, i) => {
            const expanded = open === i;
            const answerId = `faq-answer-${i}`;
            return (
              <article key={q}>
                <h3>
                  {/* The whole row is the control, not just the icon: a 28px
                      target beside a full-width heading is a miss waiting to
                      happen, especially on touch. */}
                  <button
                    type="button"
                    onClick={() => setOpen(expanded ? -1 : i)}
                    aria-expanded={expanded}
                    aria-controls={answerId}
                    className="flex w-full items-center justify-between gap-6 py-5 text-left transition-colors hover:text-white"
                  >
                    <span className="min-w-0 flex-1 text-base font-medium text-white sm:text-lg">
                      {q}
                    </span>
                    <span
                      aria-hidden
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-agensis-border bg-agensis-panel text-agensis-accent"
                    >
                      {expanded ? <Minus className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                    </span>
                  </button>
                </h3>
                <div id={answerId} hidden={!expanded} className="-mt-1 pb-6">
                  {a.map(para => (
                    <p key={para} className="mt-3 text-sm leading-relaxed text-agensis-muted first:mt-0">
                      {para}
                    </p>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
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
        <Faq />
        <CTA />
      </main>
      <Footer />
    </div>
  );
}
