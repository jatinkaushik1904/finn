**To:** assessment@enam.com
**Subject:** IIT Delhi – Founding AI Engineer - 2027

Hello,

Here is my submission for the FINN build challenge.

- **Prototype** (open on a phone): https://finn-psi-one.vercel.app
- **Repository:** https://github.com/jatinkaushik1904/finn
- **AI build history:** attached (`AI_BUILD_HISTORY.html`), the full Claude Code session: every prompt I gave, every reply, and each action it took.

**What I built**

FINN is a phone-first web app with one idea: an investor needs a brief, not a feed. It has three tabs.

- **Brief (Push).** Every NSE filing across an 18-stock portfolio, for the window you choose, ranked so you see "6 things worth your time" and the routine filings folded into one line.
  - *Results:* Revenue, EBITDA, PBT and PAT against last quarter and last year, read from the results filing itself, scanned PDFs included. The model only copies figures. Code does the arithmetic and rejects any figure that isn't on the page or doesn't add up within the statement.
  - *Management change:* who is joining or leaving, their profile from the filing, and who in your network worked or studied with them.
  - *Other material events:* the person to call, why them, and the question to ask.
  - *Alerts:* price and volume thresholds you set. They reach your phone as push notifications even when FINN is closed.
- **Ask (Pull).** Any NSE ticker, from primary sources only. The centre of it is **promised vs delivered**: guidance from the last four earnings calls, each checked against what the company later filed. Numeric promises are graded by code, with the quote and transcript link beside each verdict. A "before you meet management" sheet lists the team, their career paths, overlaps with your network and what to ask.
- **People (Network).** Who to call about a company or theme, who probably knows whom, and what the network notices that you wouldn't: for example, that your only contact inside a holding has gone cold and who the warmer route is. It appears on every card in the other two tabs.

**Key decisions and trade-offs**

- **Rules first, a model only to read, code to check.** Classification, ranking, alerts and network matching are rules: free, instant and auditable. Models copy numbers and profiles out of PDFs and judge the promises code can't measure. Every model output is verified before it is shown, and when it can't be verified FINN says so.
- **Profiles come from filings, not LinkedIn.** Indian rules require a profile of each new director or senior manager in the filing. That is a primary source and breaks no platform's terms.
- **Which network data I used.** The demo network is synthetic: fictional people at real companies, so it overlaps the portfolio. For real use, the investor imports their own LinkedIn data export (or a simple sheet) in the People tab. That works today.
- **A demo that runs.** Every external call has a timeout and a stored fallback, and the app labels stored data as such. NSE changed its web address during the build week; `/api/health` caught it.

**Architecture** (diagram and detail in the README)

- **Data pipelines:** NSE for filings and end-of-day prices; screener.in for financial tables and links to transcripts; NSE and BSE for PDFs. Anything that can't change (a filing's text, a model's answer to an exact prompt) is computed once and shipped with the code, so pages load in seconds and nothing is paid for twice. A name in a filing is linked to a contact by resolving employers and schools, then comparing the years they overlap.
- **Security and privacy:** an imported network stays in the investor's browser and is matched there. It never reaches my server or a model. The server stores only a push address and alert thresholds, and deletes them when alerts are turned off. With accounts, I'd add sign-in, per-investor isolation, device-side encryption for any sync, recorded consent, retention limits and an access log.
- **LLMs and agents:** a cheap model (Gemini 3.1 Flash-Lite) for bulk copying and a stronger one (Gemini 3 Flash) for one judgement per company, behind a rate limiter sized to the free tier. Reading a results filing is a small agent loop: it tries the text, then the scanned page, then the whole PDF, and accepts only what verifies. Total spend: zero.
- **Cloud:** one Next.js app on Vercel, pinned to Mumbai. A scheduled job checks each subscriber's thresholds and sends the pushes.

**Left out on purpose**

- LinkedIn scraping, for the reason above.
- Accounts and cross-device sync.
- Intraday prices; the brief asked for end-of-day.
- Reading the text of annual reports. They are linked, and the numbers come from reported tables; guidance lives in the calls and results filings.

**Where I'd take it next**

- A follow-up chat on each company, run by an agent with tools.
- A management credibility score tracked across quarters.
- Voice: "what changed since yesterday?"
- Annual-report notes (related parties, auditor remarks) as another evidence source.

Thank you for your time.

[Your name]
