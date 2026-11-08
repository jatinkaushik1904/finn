**To:** assessment@enam.com
**Subject:** IIT Delhi – Founding AI Engineer - 2027

Hello,

Here is my submission for the FINN build challenge.

- Prototype (open on a phone): [Prototype link]
- Repository: [GitHub repo]
- AI build history: [AI build history]

**What I built**

FINN is a mobile web app with three tabs: Brief, Ask and People.

- **Brief (Push).** Brief reads every NSE filing across an 18-stock portfolio for the time window you choose. It ranks the filings and folds away the routine ones, so you see "3 things worth your time" rather than 48 rows. Each type of card does something specific:
  - **Results:** Revenue, EBITDA, PBT and PAT, compared with last quarter and the same quarter last year.
  - **Management change:** the appointee's profile, taken from the filing's own SEBI-mandated profile annexure, plus who in your network worked or studied with them.
  - **M&A, capex and litigation:** the person to call and why.

  Volume and price alerts use thresholds you set. FINN also nudges you to reconnect with a contact whose employer just made news.
- **Ask (Pull).** Ask researches any NSE symbol from primary sources only: trajectory, balance sheet, cash conversion, and a **promised-vs-delivered** check of management's guidance against reported numbers.
- **People (Network).** People answers "who should I call about X?" and maps expertise. It is also built into every card in the other two tabs, rather than living only in its own tab.

**Key decisions and trade-offs**

- **Rules first, models only where judgment is needed.** Classification, priority, alerts and the QoQ/YoY numbers are rules: free, instant and auditable. A cheap model (Gemini 3.1 Flash-Lite) extracts bios and guidance. A stronger model (Gemini 3 Flash) runs once per company to judge promises against numbers. A keyword filter means only guidance-bearing sentences from a transcript reach the model. Every answer is cached by content, so a transcript is never paid for twice.
- **The bio comes from the filing, not LinkedIn.** Indian rules require a profile of every new director or key manager in the filing itself. That source is primary, legally clean and immediate. It avoids scraping that would break LinkedIn's terms.
- **The network is synthetic.** The people are fictional and their employers are real, so they overlap the portfolio. In production, investors would import their own contacts (including their own LinkedIn data export) with recorded consent.
- **A demo that runs.** Every external call has a timeout. If NSE blocks the server, the brief falls back to saved copies.

**Architecture** (details and a diagram are in the README)

- **Data pipelines:** NSE for filings and daily prices; screener.in for financials and links to annual reports and transcripts; NSE/BSE for the PDFs. A name in a filing is matched to a person in the network by resolving employers and schools, then comparing the years they overlap.
- **Security and privacy:** the network stays on the server and is never sent to an AI model. Models see only public filings and numbers. In production, each investor's data would be isolated in its own access-controlled database rows and encrypted. Data about people outside the network would be kept for a limited time, every access would be logged, and any person could be deleted in one step.
- **LLMs and agents:** two model tiers today. Next would be a nightly ingestion agent and a research agent that calls tools to answer follow-up questions.
- **Cloud:** Next.js on Vercel serverless functions. In production: a scheduled job for ingestion, Postgres (Supabase), object storage for PDFs and a queue for enrichment.

**Left out on purpose**

- Native push notifications and logins.
- Live LinkedIn enrichment.
- Saved fallback copies for research. Only the brief has them, so research needs screener.in to be reachable.
- BSE's data API, which blocks scripts; NSE covers the same filings.

**Next**

- Real-time notifications and a morning digest.
- Voice: "what changed since yesterday?"
- Network import with consent.
- A follow-up chat with a research agent on each company.
- A management credibility score tracked across quarters.

Thank you for your time.

[Your name]
