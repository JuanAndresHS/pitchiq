<div align="center">

# ⚽ PitchIQ

**Probabilistic football forecasts for Europe's five biggest leagues — and the Champions League that connects them**

Dixon–Coles models retrained twice a day, a cross-league calibration fit on European fixtures, an append-only forecast log, and an assistant that queries the data instead of recalling it.

[![Live demo](https://img.shields.io/badge/demo-live-00FF85?labelColor=37003C)](https://pitchiq-football.vercel.app)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Gemini](https://img.shields.io/badge/Gemini-API-4285F4?logo=googlegemini&logoColor=white)](https://ai.google.dev/)
[![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=next.js&logoColor=white)](https://nextjs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-Juan%20Andr%C3%A9s%20Hurtado-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/in/juan-andres-hurtado/)

**[Open the live demo →](https://pitchiq-football.vercel.app)**

</div>

---

## The problem

Football generates an enormous amount of data, but most of it stays locked behind two barriers:

1. **Technical friction.** Answering something as simple as *"which league is actually strongest?"* requires writing code, not asking a question.
2. **Static dashboards.** Traditional BI tools answer the questions someone anticipated in advance. Real curiosity is open-ended.

**PitchIQ** removes both. It combines statistical models fit per competition with an AI agent that queries those models directly — so the analysis happens in conversation, not in a notebook.

---

## Coverage

| Competition | Country | Accuracy | Baseline | RPS gain | Home advantage |
|---|---|---|---|---|---|
| Premier League | England | 47.9% | 42.6% | 8.2% | 1.19× |
| LaLiga | Spain | 53.2% | 48.9% | 9.7% | 1.29× |
| Serie A | Italy | 51.1% | 38.9% | 10.5% | 1.14× |
| Bundesliga | Germany | **54.2%** | 43.8% | **14.1%** | 1.20× |
| Ligue 1 | France | 50.2% | 46.2% | 8.4% | 1.26× |
| Champions League | Europe | 57.1% | 50.3% | 9.3% | **1.49×** |

Each competition is evaluated on its own held-out season, never seen during training. The baseline is always predicting a home win.

Two more leagues — Portugal's Primeira Liga and the Dutch Eredivisie — are modelled but not shown. Their clubs appear in the Champions League often enough that ignoring them would discard more than half the matches that connect the league scales.

---

## What it does

| Capability | Description |
|---|---|
| 🔄 **Automated pipeline** | Fetches eight competitions, retrains seven domestic models and the cross-league fit, twice daily via GitHub Actions |
| 🎯 **Match forecasting** | Dixon–Coles models producing win/draw/loss probabilities per fixture |
| 🌍 **Cross-league calibration** | League strength estimated from European fixtures, with bootstrap confidence intervals |
| 📋 **Append-only forecast log** | Every prediction fixed in Git before kick-off, so the track record is verifiable |
| 🤖 **Conversational agent** | Gemini with function calling over 10 tools, and enough statistical discipline to say when two leagues cannot be separated |
| 📊 **Table vs model** | Surfaces where league position and estimated strength disagree |
| 🖥️ **Live dashboard** | Next.js on Vercel, one palette per competition |

---

## Four findings

### The Premier League is the hardest of the five to forecast

It has both the lowest accuracy (47.9%) and the smallest gain over baseline (8.2%). The Bundesliga is the easiest (54.2%, 14.1%). That ordering matches how competitive each division is: a league with one dominant side is more predictable than one where anyone beats anyone. English football's reputation for unpredictability holds up under measurement.

### The Dixon–Coles correction runs the other way

Dixon and Coles (1997) found that 0–0 and 1–1 occur more often than a double-Poisson predicts, and set their correction parameter ρ positive on English data from 1992–95. Fitting the same model on 2023–26 data gives a **negative ρ in four of five leagues**, strongest in the Bundesliga.

One league would be noise. Four independent competitions pointing the same way is a pattern worth stating rather than quietly assuming the original sign. Interestingly, European fixtures go the other way again — ρ is positive in the Champions League, where knockout caution produces more low-scoring draws.

### Home advantage varies more than expected — and travel makes it worse

LaLiga home teams see a 1.29× lift in goal rate; Serie A only 1.14×. Serie A's home-win baseline is 38.9%, the lowest of the five. Home advantage is not a constant of football — it is a property of each competition.

In European fixtures it jumps to **1.49×**, larger than any domestic league. International travel, hostile crowds and unfamiliar conditions all plausibly contribute, and the size of the gap was not something I expected going in.

### Some leagues cannot be told apart, and saying so is the finding

The cross-league model ranks the Premier League above LaLiga, Ligue 1, the Bundesliga and Serie A — but the bootstrap intervals for the first three overlap heavily. Refitting behind a different cutoff swaps LaLiga and Ligue 1 in the order.

That instability is the point. With a few hundred European matches spread across eight groups, the model can separate the Premier League from Serie A and cannot separate it from Ligue 1. The site reports both facts, and the assistant refuses to rank leagues whose intervals overlap.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  DATA SOURCE      football-data.org · 8 competitions        │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  INGESTION        src/ingestion/                            │
│  GitHub Actions, twice daily, rate-limit aware              │
│  fetch → normalize → validate → data/processed/             │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  DOMESTIC MODELS  src/models/train_and_forecast.py          │
│  One Dixon-Coles fit per league, ridge penalty tuned        │
│  per competition on held-out seasons                        │
│  → ratings · forecasts · prediction log · model params      │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  CROSS-LEAGUE     src/models/european_model.py              │
│  Team ratings held fixed; one strength offset per league     │
│  estimated from European fixtures, with bootstrap CIs       │
│  → league strengths · Champions League forecasts            │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  AGENT            web/lib/tools.ts                          │
│  Gemini + function calling over 10 tools                    │
│  standings · form · prediction · fixtures · ratings         │
│  head-to-head · accuracy · compare_leagues                  │
│  league_strength · european_fixtures                        │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  PRESENTATION     web/                                      │
│  Next.js, one route and palette per competition  →  Vercel  │
└─────────────────────────────────────────────────────────────┘
```

### The cross-league problem

Domestic ratings live on separate scales. A +0.5 attack rating in the Bundesliga and a +0.5 in LaLiga each mean "half a unit above that league's average", and nothing in domestic data says whether those averages match. Every team in a league plays only teams from the same league.

European fixtures are the only matches that connect them, and there are not many: 477 usable meetings across four seasons, some pairs of leagues meeting barely ten times.

The model adds one strength offset per league to the domestic fit:

```
log(λ_home) = attack_i − defense_j + home_adv_eu + (strength_i − strength_j)
              └──── fixed, from the domestic fits ────┘   └── estimated here ──┘
```

Three decisions shaped it:

- **Two stages, not one joint fit.** Team ratings stay fixed at what the domestic models produced. With eight parameters and a few hundred matches the estimate is already well determined, and keeping the stages separate means a team's rating still means what it meant — something measured over a full domestic season, not bent to fit six European nights.

- **Ratings are re-centred before use.** The domestic fit only constrains attack to sum to zero, so a league's mean defense carries part of its overall scoring level — exactly the quantity the strength parameter is meant to hold. Leaving it in would make the two unidentifiable.

- **Clubs from unmodelled leagues share one pooled group.** Each appears once or twice in four seasons, which cannot support a Norwegian or Cypriot league factor. Pooling them recovers 178 matches that would otherwise be discarded. Inside that group Celtic and Kairat are identical, which is the model's coarsest assumption — and it costs **+0.0161 RPS**, measured rather than asserted.

---

### Design decisions

- **One model per league, never a global one.** Attack and defense ratings are only comparable within a competition. The cross-league model is what connects them, and it is the only place the site makes that comparison.

- **Append-only prediction log.** Forecasts are recorded before kick-off and never rewritten. Overwriting them each run would erase the evidence needed to score them afterwards, turning a live track record into an unfalsifiable claim. Git history makes every prediction auditable.

- **The European evaluation refits everything behind a cutoff.** Reusing today's ratings to score a past European season would hand the model domestic results that had not happened yet. Slower, and the only version worth reporting.

- **Function calling over RAG.** The agent runs real queries against real data instead of retrieving text about it. This removes a whole class of hallucination risk — a hard requirement if forecasts are going to be trusted.

- **The agent respects confidence intervals.** `get_league_strength` returns a per-league flag for whether the estimate is distinguishable from the reference, and the system prompt requires saying so rather than producing an order the data does not support.

- **Model parameters read from disk, not hardcoded.** The training scripts write what they estimated; the site reads it. A number copied into a config by hand drifts silently from the model that produced it.

- **Chronological train/test split**, enforced with an assertion so the leak cannot slip back in.

- **Per-league regularization, tuned not guessed.** The ridge penalty differs by competition (Serie A 1.0, Premier League 3.0, LaLiga 5.0), each selected by sweeping values against a held-out season. Without it, a newly promoted side with two matches played topped the strength ratings.

- **Modelled and visible are different questions.** Portugal and the Netherlands are fit but hidden: their clubs are needed for European calibration, but a Eredivisie dashboard is not something this site's readers asked for.

---

## Tech stack

**Data & Modelling** — Python · pandas · NumPy · SciPy · statsmodels · scikit-learn
**AI** — Google Gemini API (function calling via the Interactions API)
**Orchestration** — GitHub Actions
**Frontend** — Next.js 16 · React 19 · TypeScript · Tailwind CSS 4
**Deployment** — Vercel

---

## Getting started

### Prerequisites

- Python 3.12+ and Node.js 20+
- A [football-data.org](https://www.football-data.org/) API key (free tier)
- A [Google AI Studio](https://aistudio.google.com/apikey) API key (free tier)

### Installation

```bash
git clone https://github.com/JuanAndresHS/pitchiq.git
cd pitchiq

python -m venv venv
venv\Scripts\activate        # Windows
# source venv/bin/activate   # macOS / Linux

pip install -r requirements.txt

cd web && npm install && cd ..
```

### Configuration

`.env` in the project root, for the Python pipeline:

```env
FOOTBALL_DATA_API_KEY=your_key_here
```

`web/.env.local`, for the Next.js app:

```env
GEMINI_API_KEY=your_key_here
```

> Both are gitignored. Never commit API keys.

### Running it

```bash
# Fetch every competition for the current season
python src/ingestion/fetch_matches.py

# One competition, or a past season
python src/ingestion/fetch_matches.py --league PD --season 2024

# Fit the seven domestic models and refresh forecasts
python src/models/train_and_forecast.py

# Fit the cross-league model and forecast European fixtures
python src/models/european_model.py --bootstrap 500

# Evaluate: domestic (with a ridge sweep) and European
python src/models/evaluate.py --sweep
python src/models/evaluate_european.py

# Check how well European fixtures connect the leagues
python src/models/analyse_european.py

# Run the site
cd web && npm run dev
```

Reproduce the analysis from scratch with the notebooks, in order:

1. `notebooks/01_exploratory_analysis.ipynb`
2. `notebooks/02_outcome_model.ipynb`

---

## Project structure

```
pitchiq/
├── .github/workflows/
│   └── ingest.yml              # Twice-daily pipeline
├── data/
│   ├── processed/              # <competition>_matches_<season>.csv
│   └── predictions/<slug>/     # ratings, forecasts, log, params
├── notebooks/
├── src/
│   ├── leagues.py              # Single source of truth for competitions
│   ├── ingestion/fetch_matches.py
│   ├── models/
│   │   ├── train_and_forecast.py    # Domestic Dixon-Coles fits
│   │   ├── evaluate.py              # Domestic evaluation + ridge sweep
│   │   ├── european_model.py        # Cross-league calibration
│   │   ├── evaluate_european.py     # European evaluation with cutoff refit
│   │   └── analyse_european.py      # Connectivity report
│   └── agent/                  # CLI agent (Python)
└── web/
    ├── app/
    │   ├── page.tsx                 # Competition index
    │   ├── [league]/page.tsx        # Per-league dashboard
    │   ├── champions-league/page.tsx
    │   └── api/chat/route.ts
    ├── components/
    ├── lib/
    │   ├── leagues.ts
    │   ├── data.ts             # CSV access layer
    │   └── tools.ts            # Agent tools
    └── scripts/sync-data.mjs   # Pulls data into the build
```

---

## Known limitations

The models know goals, teams and dates. They do not know about:

- **Squad information** — injuries, suspensions and transfers are invisible
- **Managerial changes** — a rating built on four seasons assumes continuity
- **Fixture congestion** — midweek European matches are a systematic disadvantage the model cannot see
- **Newly promoted teams** — they carry the least reliable ratings until matches accumulate

Two limitations are specific to the cross-league model:

- **League strength means the strength of the clubs that qualified**, not of the division as a whole. Entry quotas differ — England sends five, the Netherlands one or two — so a league's figure reflects who it sends as much as how good it is.
- **Clubs outside the seven modelled leagues share one set of parameters.** Celtic and Kairat look identical to the model, and fixtures involving them score measurably worse.

The team ratings measure accumulated squad strength, not recent form. With a decay half-life of roughly a year, a side that changed substantially will keep an outdated rating for weeks. That is the models' blind spot.

These are stated rather than buried, because a forecasting system that overstates its reach is worse than one that is clear about where it stops.

---

## Roadmap

- [x] Automated ingestion and scheduling
- [x] Exploratory analysis and Poisson validation
- [x] Dixon–Coles model with tuned regularization
- [x] Conversational agent with function calling
- [x] Dashboard deployed on Vercel
- [x] Append-only prediction log
- [x] Expansion to five leagues
- [x] Cross-league calibration and Champions League forecasts
- [ ] Live accuracy tracked across a full season
- [ ] Europa League and Conference League as further calibration data
- [ ] Expected goals (xG) from event-level data
- [ ] Squad availability as a model input

---

## Data sources & attribution

- **[football-data.org](https://www.football-data.org/)** — fixtures, results and standings for all eight competitions

This is an independent, non-commercial project built for learning and portfolio purposes. It is not affiliated with UEFA, any league or any club.

---

## About this project

PitchIQ applies business analytics, data engineering and generative AI to something I actually care about. The goal was to build the full path end to end — from raw ingestion to a deployed interface — rather than stopping at a notebook.

**Juan Andrés Hurtado** · [LinkedIn](https://www.linkedin.com/in/juan-andres-hurtado/) · [GitHub](https://github.com/JuanAndresHS)

---

<div align="center">
<sub>Built with curiosity, and a lot of matchday data.</sub>
</div>