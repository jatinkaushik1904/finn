# FINN — a financial investment agent that knows who you know

FINN is a mobile-first web app with one point of view: **an investor needs a brief, not a feed.**
It reads every exchange filing across your portfolio, ranks it, folds away the routine,
and puts **the person in your network who can explain it** on the same card.
On demand it researches any NSE stock from primary sources only. It doesn't stop at summarising
management: it **audits them**, checking what they promised against what they delivered.

| Layer | What works today |
|---|---|
| **Push** (Brief tab) | Live NSE filings for an 18-stock portfolio over 24h / 3d / 7d / 30d. Filings are classified into the reference categories and priority-scored; routine ones are folded away. **Results** cards show Revenue / EBITDA / PBT / PAT with QoQ and YoY. **Management change** cards show the appointee's profile, read from the filing's own SEBI-mandated "brief profile" annexure, plus who in your network worked or studied with them. **M&A / capex / litigation** cards show the best person to call and why. Configurable **alerts** cover volume (× 20-day average) and price (±% per day), plus the filing types you always want surfaced. "Natural reasons to reconnect" nudges you when a contact you haven't spoken to recently has an (ex-)employer in the news. |
| **Pull** (Ask tab) | Works on **any** NSE symbol: business, headline ratios, an 8-quarter strip, a 6-year trajectory with CAGR, balance sheet (D/E, cash-conversion cycle, ROCE), cash quality (CFO ÷ PAT per year), and **promised vs delivered** across the last earnings-call transcripts. Company-level promises are judged against reported numbers. Segment and KPI promises are judged against what management itself reported on *later* calls, cited by call month. Unfinished horizons show progress so far ("behind so far"). Also bull vs bear, and who in your network can help. |
| **Network** (People tab) | "Who should I call about…", an expertise map, warmth (tie × recency), second-degree intros, and a career/education sheet per person. The network is woven into every Push card and every research page. |

> **The network is 100% synthetic.** The people are fictional; their employers are real so they overlap the portfolio. The market data, filings, financials and transcripts are real and live.

## Run it

```bash
npm install
cp .env.example .env.local   # add GEMINI_API_KEY (free: aistudio.google.com/apikey) or ANTHROPIC_API_KEY
npm run dev                  # open the "Network:" URL it prints on your phone (same Wi-Fi)
```
Without an LLM key everything still runs. Classification, results numbers, alerts, research and network matching are all deterministic; only bios and promised-vs-delivered need a model.

**Deploy:** push to GitHub → import in Vercel (or run `npx vercel`) → set the env vars. NSE sometimes blocks cloud IPs. The brief then falls back to the committed snapshots in `data/snapshot/`; refresh them by saving `/api/brief?hours=N` from a machine NSE allows.

## Architecture

```
 NSE filings API ─┐   NSE EOD prices ─┐   screener.in (financials + doc links) ─┐   filing / transcript PDFs ─┐
                  ▼                   ▼                                         ▼                             ▼
            ┌──────────────── ingestion (lib/nse.ts, lib/screener.ts) · timeouts · retries · polite pool(4) ─────────────┐
            │                         content-hash cache (memory + disk)  →  snapshot fallback                          │
            └──────────────────────────────────────────────┬─────────────────────────────────────────────────────────────┘
                                                           ▼
   rules first (free):  classify.ts → category + priority   ·   alerts (vol ×, ±%)   ·   QoQ / YoY from reported tables
   fast LLM (cheap):    appointee profile from filing PDF   ·   guidance sentences from transcripts (keyword pre-filtered)
   smart LLM (once):    judge promises vs reported numbers  ·   bull / bear grounded in the same numbers
                                                           ▼
   network join (server-side, deterministic, never sent to an LLM): entity resolution → inside / alumni / peer / theme / 2nd-degree
                                                           ▼
                         /api/brief · /api/research/[sym] · /api/narrative/[sym] · /api/network  →  mobile UI
```

**Data pipelines.** Filings and EOD bars come from NSE's JSON endpoints. Fundamentals and document links (annual reports, concall transcripts) come from screener.in, and the PDFs from NSE/BSE. Everything goes through one content-keyed cache: filings for 2h, prices for 6h, financials for 12h, PDFs and LLM answers for 30 days. That means a filing or transcript is never parsed or paid for twice. A **filing name is linked to a person in the network** in three steps:
1. The model extracts the appointee's employers and schools from the filing annexure (regex fallback when there's no key).
2. These are resolved against an alias table of companies (`data/universe.ts`).
3. Each match is compared with each contact's career and education by **overlapping years**. Same employer and same years means "worked with"; the same employer at different times means "knows the team they came from".

In production I'd add fuzzy name matching, an identifier per person (DIN for directors), and a one-tap human confirmation before a match is shown as fact.

**Security & privacy.** The network lives only on the server. API responses carry only what a card renders, and **network data never goes to an LLM**: models see filings, transcript sentences and reported numbers only (`lib/brief.ts`, `lib/research.ts`). In a real deployment:
- **Tenancy and storage:** each investor is a separate tenant in Postgres with row-level security, encrypted at rest. Contacts are imported by the investor themself (address book, the LinkedIn data export they own, CRM) with recorded consent.
- **What is stored:** only professional facts (employer, role, years, school) and relationship metadata. There are no free-text notes about people unless the investor writes them.
- **Retention and access:** enrichment of non-contacts (e.g. a new CFO) is cached at most 90 days. Every access is audit-logged, there's one-click delete per person, and SSO plus device-bound sessions control access.
- **LLM provider:** zero-retention settings. Free tiers may train on prompts; acceptable here only because prompts hold public filings.

**LLMs & agents.** Rules come first: the classifier, priority, alerts and QoQ/YoY cost nothing, are instant and are auditable. Models are routed by need:
- **Fast tier** (`gemini-3.1-flash-lite`): bulk extraction, i.e. bios from filings and guidance from transcripts. A keyword pre-filter means only guidance-bearing sentences are sent, a small fraction of each transcript.
- **Smart tier** (`gemini-3-flash-preview`): one call per company, for the judgement step (promised vs delivered, bull/bear).
- **Anthropic option:** swap in by setting `ANTHROPIC_API_KEY` (Haiku for the fast tier, Sonnet for the smart one).

Answers are cached by prompt hash, and only valid JSON is cached. Quotes are checked word-for-word against the source sentence. In production, a nightly **ingestion agent** would watch the filing feed and decide which PDFs deserve reading, and an on-demand **research agent** would get tools (`fetch_filing`, `get_financials`, `search_transcript`, `who_knows`) to answer follow-up questions.

**Cloud.**
- **Now:** a single Next.js app on Vercel serverless functions, plus committed snapshots.
- **Production:** a Vercel cron or queue worker for ingestion; Postgres (Supabase, row-level security) for filings, prices, people and matches; object storage for PDFs; a queue for enrichment; secrets in the platform vault.

**Cost (estimate).** An 18-stock portfolio produces about 5–15 material filings a day. Only management changes and research calls touch a model, so a normal day is a few dozen fast-tier calls and a handful of smart calls. That is well inside the free tier, and cents a day on paid tiers.

## Deliberately left out
- Push notifications. Native push needs an app shell; the "alerts" here are computed on each load.
- Live LinkedIn enrichment, which would be against LinkedIn's terms. Bios come from the filing itself, which is a primary source and legally clean.
- Live fallback for *every* ticker: snapshots cover the brief and the five demo research picks. Any other ticker needs screener.in to be reachable.
- Logins and accounts.
- BSE's JSON API, which blocks scripts; NSE covers the same filings.

## Next
- Real notifications plus a daily 8am digest.
- Voice: "what changed since yesterday?"
- Network import with consent.
- A follow-up chat on the research page, run by an agent with tools.
- Track management's credibility score across quarters.
- Peer comparisons ("who else in my network sees this customer?").

## Repo map
`lib/` pipelines and logic · `data/` portfolio, synthetic network, snapshots · `app/api/` four routes · `app/page.tsx` + `components/` UI.
