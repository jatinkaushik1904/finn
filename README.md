# FINN — a financial investment agent that knows who you know

FINN is a mobile-first web app with one point of view: **an investor needs a brief, not a feed.**

- **Push.** It reads every exchange filing across your portfolio, ranks it, folds away the routine, and puts **the person in your network who can explain it** on the same card. It pushes to your phone even when the app is closed.
- **Pull.** On demand it researches any NSE stock from primary sources only, and it doesn't stop at summarising management: it **audits them**, checking what they promised on earnings calls against what they then reported.
- **Network.** Your contacts are matched to filings and companies by rules, on your device. Your own network never reaches FINN's server or a model.

**Try it:** https://finn-psi-one.vercel.app (open on a phone; "Add to Home Screen" makes it an app).

## What works

| Layer | What it does today |
|---|---|
| **Push** (Brief tab) | Live NSE filings for an 18-stock portfolio over 24h / 3d / 7d / 30d (a quiet 24h widens by itself). Every filing is classified and scored by rules; routine ones are folded into one line. Duplicate paperwork is folded into one card per event and per person. |
| · Results | Revenue / EBITDA / PBT / PAT with QoQ and YoY **read from the results filing itself**, including scanned PDFs. The model only copies cells; code converts units, computes EBITDA and growth, and refuses any figure that isn't printed on the page or doesn't close the statement's own arithmetic. Revenue is cross-checked against screener.in. The card says where every number came from. |
| · Management change | Who is joining, leaving or staying on, with the appointee's profile from the filing's own mandatory "brief profile", and who in your network worked or studied with them (with the warmer route when the direct contact is cold). |
| · Everything else | M&A, capex, litigation, fund raises, orders: the best person to call, why them, and the one question worth asking. |
| · Alerts | Volume (× 20-day average) and price (±% at close) thresholds you set, plus the filing types you track. With alerts on, **Web Push reaches the device with FINN closed**; the server watches with *your* thresholds. Optional Telegram / Slack digest. |
| **Pull** (Ask tab) | Any NSE symbol: business, headline ratios, latest quarter, 8-quarter strip, 6-year trajectory, segment mix (from the filings), balance sheet, cash quality, bull vs bear. |
| · Promised vs delivered | Guidance from the last four earnings-call transcripts, each judged against what the company then filed. Numeric promises on reported lines (revenue, margins, capex, segment results) are **graded by code**, not by a model. Unfinished horizons show the run-rate ("behind so far"). What can't be checked is said to be unverifiable, with the reason. Every promise carries its verbatim quote and transcript link. |
| · Before you meet management | The management team from the company's own appointment filings and the cast of its latest call: career path, education, overlaps with your network, and what to ask (missed guidance, senior exits, regulatory filings). |
| **Network** (People tab) | Who to call about a company or a theme; expertise map; warmth (tie × recency); who-probably-knows-whom computed from shared employers and schools in overlapping years; "what FINN noticed" (your only line into a holding has gone cold, and who is the warmer way in). **Import your own network** (LinkedIn's `Connections.csv` export, or the FINN sheet): parsed and matched in the browser, stored only on the device, emails dropped, one tap to forget. |

> **The demo network is 100% synthetic.** The people are fictional; their employers are real, so they overlap the portfolio. Market data, filings, financials and transcripts are real and live.

## Run it

```bash
npm install
cp .env.example .env.local   # add GEMINI_API_KEY (free: aistudio.google.com/apikey) or ANTHROPIC_API_KEY
npm run dev                  # open the "Network:" URL it prints on your phone (same Wi-Fi)
```

Without an LLM key everything still runs: classification, alerts, research tables and network matching are deterministic. A model is needed only to copy numbers out of a results PDF, copy a profile out of an appointment letter, and extract and judge guidance.

**Deploy:** `npx vercel deploy --prod`, then set the env vars from `.env.example`. For closed-app alerts run `scripts/setup-push.sh` once (push keys + a private Blob store for subscriptions). `GET /api/health?llm=1` shows which upstreams the deployment can reach, from which region.

**Refresh the shipped cache** (optional, before a deploy): `FINN_SEED_RECORD=data/seed npm run dev`, then `node scripts/warm.mjs http://localhost:3000`.

## Architecture

```
 NSE filings + EOD prices        screener.in (tables, links to       filing / results / transcript PDFs
 (JSON API, nseindia.in)         annual reports and transcripts)     (NSE archives, BSE)
          │                                  │                                   │
          └────────── ingestion: timeouts · retry · ≤4 at a time · whole-file check on every PDF ──────────┘
                                             │
        cache, keyed by content:  memory → /tmp → SEED shipped with the deploy (data/seed)
        (a filing's text, a model's answer to an exact prompt and a results filing's checked
         numbers never change, so they are computed once and travel with the code)
                                             │
   RULES (free, instant)        classify + score every filing · fold duplicates · price/volume alerts ·
                                network matching · grade numeric promises against filed numbers
   FAST MODEL (bulk copy)       results table cells from a PDF page · profile from an appointment letter ·
                                guidance sentences from a transcript (pre-filtered to under 2% of the text)
   SMART MODEL (one call)       judge the promises code can't measure · bull vs bear from the same figures
   CHECKS (code, after a model) every figure printed on the page or closing the statement's sums ·
                                every quote verbatim · no verdict before the horizon is reported
                                             │
   /api/brief  /api/research/[sym]  /api/narrative/[sym]  /api/people/[sym]  /api/push  /api/cron  /api/health
                                             │   public data only
                                             ▼
   BROWSER: joins that public data with the active network (demo, or your own import held in
   localStorage) using the same lib/network.ts the server uses → cards, who-to-call, overlaps
```

**Data pipelines.**
- *Filings and prices:* NSE's JSON API (filings list per symbol, end-of-day bars). NSE moved hosts from `nseindia.com` to `nseindia.in` during the build week; the origin is one constant (`NSE_ORIGIN`) and `/api/health` probes it.
- *Fundamentals:* screener.in tables plus its links to concall transcripts and annual reports. Segment results, capex and (for lenders) advances/deposits come from the results filings themselves.
- *Refresh and storage:* filings list 2h, prices 6h, screener 12h, an assembled brief 10 min. Anything immutable (PDF text, model answers, checked results) is cached for good and shipped as a gzipped seed (871 entries, 6.7 MB), so a filing is never read or paid for twice. Measured on a production build with an empty cache: the brief in 1–3 s, a warmed company's research, verdicts and management sheet in under a second, and no model calls at all.
- *Linking a name in a filing to a person in the network:* (1) the profile's employers and schools are copied from the filing; (2) each is resolved to a canonical company through an alias table (`data/universe.ts`), unknown ones by normalised name; (3) each is compared with every contact's career and education by **overlapping years**: same employer, same years = "worked with"; same employer, different years = "knows the team they came from"; same school and years = "studied with". (4) If the contact who overlaps is cold, the graph of who-probably-knows-whom names a warmer route. In production I'd add an identifier per person (DIN for directors) and a one-tap human confirmation before a match is shown as fact.

**Data security and privacy.**
- *The investor's network stays theirs.* An imported network lives only in that browser's storage and is matched there; no API route accepts contact data, and **no contact data is ever put in a model prompt** (models see filings, transcript sentences and reported numbers). Email addresses are dropped while the file is parsed. "Forget my network" deletes it.
- *What the server stores about a user:* only if they turn alerts on, a push endpoint, its two public keys, their thresholds and the ids already sent, in a private Blob store; deleted on "Turn off". No account, name or email. Push text carries public filing facts only; the "call X" hint is added on the device.
- *People in filings:* profiles come only from the company's own exchange filings and call transcripts (public, mandatory disclosures), never from scraping. Cached profiles are public-source text.
- *Real deployment:* sign-in with SSO and per-investor tenancy; if the network is synced across devices, it is encrypted on the device with a key the server never holds; consent recorded at import (the investor's own data export or CRM, not scraped profiles); only professional facts stored; 90-day retention for enrichment of non-contacts; audit log of every access; one-click delete per person; a model provider with zero-retention terms.

**LLMs and agents.** Rules first, a model only where reading is needed, code checks after.
- *Fast tier* (`gemini-3.1-flash-lite`): copying. Results cells, a profile, guidance statements. Cheap, and wrong answers are caught by arithmetic and verbatim checks.
- *Smart tier* (`gemini-3-flash-preview`): one judgement call per company, and a second look at a scanned page the fast model couldn't close.
- *Routing and cost control:* a per-model rate limiter sized to the free tier (measured: 15 requests a minute per model, and 20 a day for the smart model) that spills to the next model in a chain and honours each quota's own retry time; answers cached by prompt hash and shipped in the seed; transcripts pre-filtered so under 2% of the text reaches a model; an answer is cached only if it is valid JSON in the shape asked for. Swap providers by setting `ANTHROPIC_API_KEY` instead.
- *Where it acts on its own:* the results reader is a small agent loop: locate the table page in code, read the text layer; if the sums don't close, read the scanned page image; if that fails, hand the PDF to the model; escalate fast → smart; accept only what verifies, else fall back to reported tables and say so. The cron watches each subscriber's thresholds and pushes unprompted. Next: a research agent with tools (`fetch_filing`, `search_transcript`, `who_knows`) for follow-up questions.

**Cloud.** One Next.js app on Vercel (functions pinned to Mumbai, `bom1`, close to the exchanges). Vercel Cron calls `/api/cron` daily after the close. For alerts within minutes, the repo ships a GitHub Actions workflow (`pulse`) that calls it every 15 minutes in market hours once its `FINN_URL` variable and `CRON_SECRET` secret are set. Push subscriptions go to a private Vercel Blob store (`scripts/setup-push.sh`). No database: the seed and snapshots ship with the code. At production scale: a queue worker for ingestion, Postgres with row-level security for filings, prices and matches, object storage for PDFs.

**Cost.** Nothing was spent: Gemini free tier, Vercel Hobby. A normal day is a handful of new filings, so a few fast calls; one smart call per company researched, then cached.

## Deliberately left out
- **Live LinkedIn enrichment.** Scraping profiles is against LinkedIn's terms. Bios come from the filing (a primary source); the investor's own network comes from their own data export.
- **Accounts and sync.** One investor, one device. Sync would need sign-in and an encrypted store.
- **Intraday prices.** The brief asks for end-of-day; alerts fire on the latest close.
- **BSE's JSON API** (blocks scripts). NSE covers the same filings; BSE is used for transcript PDFs.
- **Annual-report text.** Annual reports are linked, and the multi-year numbers come from the reported tables; the narrative check reads the calls and results filings, which is where guidance lives.

## Known limits
- NSE and screener.in can rate-limit or block a cloud IP. Then the brief serves the snapshot in `data/snapshot/` and labels it ("Snapshot · NSE unreachable"); research falls back to stored copies for the companies warmed before deploy.
- On the free Gemini tier the smart model answers 20 requests a day. After that FINN judges with the next model in its chain, and the footer under the verdicts names the model that judged. Companies warmed before deploy need no model at all.
- A company with no transcripts on screener.in gets no promised-vs-delivered. Guidance on things companies don't report (credit cost, commodity impact) is shown as unverifiable rather than guessed.
- A LinkedIn export carries only current company and title, so imported contacts start as acquaintances with inferred expertise until the investor adds the FINN sheet or edits a person.
- iPhone delivers web push only to installed web apps (Share → Add to Home Screen).

## Next
- A follow-up chat on each research page, run by a tool-using agent.
- A management credibility score per company, tracked across quarters.
- Voice: "what changed since yesterday?"
- Annual-report reading (related-party notes, auditor remarks) as a fourth evidence source.
- Calendar-aware nudges: "you meet Dixon on Thursday; here is the sheet."

## Repo map
- `lib/` pipelines and logic: `nse` `screener` `pdf` (ingestion) · `classify` `brief` `results` `person` `push` (Push) · `research` `people` (Pull) · `network` (matching, shared by server and browser) · `llm` `cache` (routing, limits, caching)
- `components/` + `app/page.tsx` the UI · `components/net*.ts` the on-device network
- `data/` portfolio, synthetic network, `snapshot/` fallbacks, `seed/` pre-read cache
- `app/api/` routes · `scripts/` warm-up and push setup · `.github/workflows/pulse.yml` the 15-minute heartbeat
