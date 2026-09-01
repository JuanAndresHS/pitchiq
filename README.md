<div align="center">

# ⚽ PitchIQ

**Probabilistic football forecasts for Europe's five biggest leagues**

Dixon–Coles models retrained twice a day, an append-only forecast log, and an assistant that queries the data instead of recalling it.

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

1. **Technical friction.** Answering something as simple as *"which league has the strongest home advantage?"* requires writing code, not asking a question.
2. **Static dashboards.** Traditional BI tools answer the questions someone anticipated in advance. Real curiosity is open-ended.

**PitchIQ** removes both. It combines statistical models fit per competition with an AI agent that queries those models directly — so the analysis happens in conversation, not in a notebook.

---

## Coverage

| League | Country | Teams | Model accuracy | Baseline | Home advantage |
|---|---|---|---|---|---|
| Premier League | England | 20 | 47.9% | 42.6% | 1.19× |
| LaLiga | Spain | 20 | 53.2% | 48.9% | 1.29× |
| Serie A | Italy | 20 | 51.1% | 38.9% | 1.14× |
| Bundesliga | Germany | 18 | **54.2%** | 43.8% | 1.20× |
| Ligue 1 | France | 18 | 50.2% | 46.2% | 1.26× |

Weighted accuracy across all five: **51.2%**. Each league is evaluated on its own held-out 2025/26 season, never seen during training. The baseline is always predicting a home win.

---

## What it does

| Capability | Description |
|---|---|
| 🔄 **Automated pipeline** | Fetches results, retrains five models and refreshes forecasts twice daily via GitHub Actions |
| 🎯 **Match forecasting** | Dixon–Coles models producing win/draw/loss probabilities per fixture |
| 📋 **Append-only forecast log** | Every prediction fixed in Git before kick-off, so the track record is verifiable |
| 🤖 **Conversational agent** | Gemini with function calling over 8 data tools, across all five leagues |
| 📊 **Table vs model** | Surfaces where league position and estimated strength disagree |
| 🖥️ **Live dashboard** | Next.js on Vercel, one palette per competition |

---

## Three findings

Expanding from one league to five turned single-league curiosities into patterns.

### The Premier League is the hardest of the five to forecast

It has both the lowest accuracy (47.9%) and the smallest gain over baseline (8.2%). The Bundesliga is the easiest (54.2%, 14.1% gain). That ordering matches how competitive each division is: a league with one dominant side is more predictable than one where anyone beats anyone. English football's reputation for unpredictability holds up under measurement.

### The Dixon–Coles correction runs the other way

Dixon and Coles (1997) found that 0–0 and 1–1 occur more often than a double-Poisson predicts, and set their correction parameter ρ positive on English data from 1992–95. Fitting the same model on 2023–26 data gives a **negative ρ in four of five leagues**, strongest in the Bundesliga.

One league would be noise. Four independent competitions pointing the same way is a pattern worth stating rather than quietly assuming the original sign.

### Home advantage varies more than expected

LaLiga home teams see a 1.29× lift in goal rate; Serie A only 1.14×. Serie A's home-win baseline is 38.9%, the lowest of the five. Home advantage is not a constant of football — it is a property of each competition.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  DATA SOURCE      football-data.org · 5 competitions        │
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
│  MODELLING        src/models/                               │
│  One Dixon-Coles fit per league, ridge penalty tuned        │
│  per competition on held-out seasons                        │
│  → ratings · forecasts · prediction log · model params      │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  AGENT            web/lib/tools.ts                          │
│  Gemini + function calling over 8 tools                     │
│  standings · form · prediction · fixtures · ratings         │
│  head-to-head · accuracy · compare_leagues                  │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  PRESENTATION     web/                                      │
│  Next.js, one route and palette per league  →  Vercel       │
└─────────────────────────────────────────────────────────────┘
```

### Design decisions

- **One model per league, never a global one.** Attack and defense ratings are only comparable within a competition — there are no matches connecting LaLiga to the Bundesliga, so any cross-league rating comparison would be an artifact. The agent refuses those explicitly rather than producing a number that looks like information.

- **Home advantage *is* comparable, and the agent knows the difference.** It describes the competition rather than a squad, so `compare_leagues` exposes it while team ratings stay league-scoped.

- **Append-only prediction log.** Forecasts are recorded before kick-off and never rewritten. Overwriting them each run would erase the evidence needed to score them afterwards, turning a live track record into an unfalsifiable claim. Git history makes every prediction auditable.

- **Function calling over RAG.** The agent runs real queries against real data instead of retrieving text about it. This removes a whole class of hallucination risk — a hard requirement if forecasts are going to be trusted.

- **Model parameters read from disk, not hardcoded.** The training script writes what it estimated; the site reads it. A number copied into a config by hand drifts silently from the model that produced it.

- **Chronological train/test split.** A random split would let a model learn from matches that happened *after* the ones it predicts. The split is enforced with an assertion so the leak cannot slip back in.

- **Per-league regularization, tuned not guessed.** The ridge penalty differs by competition (Serie A 1.0, Premier League 3.0, LaLiga 5.0) because each was selected by sweeping values against a held-out season. Without it, a newly promoted side with two matches played topped the strength ratings.

- **Parameterised, not duplicated.** Adding a sixth league is one entry in `src/leagues.py`. Five copies of the project would mean fixing every bug five times.

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
# Fetch every league for the current season
python src/ingestion/fetch_matches.py

# One league, or a past season
python src/ingestion/fetch_matches.py --league PD --season 2024

# Fit all five models and refresh forecasts
python src/models/train_and_forecast.py

# Evaluate on held-out seasons, sweeping the ridge penalty
python src/models/evaluate.py --sweep

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
│   ├── processed/              # <league>_matches_<season>.csv
│   └── predictions/<league>/   # ratings, forecasts, log, model params
├── notebooks/
│   ├── 01_exploratory_analysis.ipynb
│   └── 02_outcome_model.ipynb
├── src/
│   ├── leagues.py              # Single source of truth for competitions
│   ├── ingestion/fetch_matches.py
│   ├── models/
│   │   ├── train_and_forecast.py
│   │   └── evaluate.py
│   └── agent/                  # CLI agent (Python)
└── web/
    ├── app/
    │   ├── page.tsx            # League index
    │   ├── [league]/page.tsx   # Per-league dashboard
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
- [ ] Live accuracy tracked across a full season
- [ ] Champions League: estimating relative league strength from European fixtures
- [ ] Expected goals (xG) from event-level data
- [ ] Squad availability as a model input

---

## Data sources & attribution

- **[football-data.org](https://www.football-data.org/)** — fixtures, results and standings for all five competitions

This is an independent, non-commercial project built for learning and portfolio purposes. It is not affiliated with any league or club.

---

## About this project

PitchIQ applies business analytics, data engineering and generative AI to something I actually care about. The goal was to build the full path end to end — from raw ingestion to a deployed interface — rather than stopping at a notebook.

**Juan Andrés Hurtado** · [LinkedIn](https://www.linkedin.com/in/juan-andres-hurtado/) · [GitHub](https://github.com/JuanAndresHS)

---

<div align="center">
<sub>Built with curiosity, and a lot of matchday data.</sub>
</div>