<div align="center">

# ⚽ PitchIQ

**An AI-powered analytics copilot for the Premier League**

Predictive models and a conversational agent that answers football questions in natural language — over live, daily-updated data.

[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Gemini](https://img.shields.io/badge/Gemini-API-4285F4?logo=googlegemini&logoColor=white)](https://ai.google.dev/)
[![Next.js](https://img.shields.io/badge/Next.js-15-000000?logo=next.js&logoColor=white)](https://nextjs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Live](https://img.shields.io/badge/demo-live-00FF85?labelColor=37003C)](https://pitchiq-theta.vercel.app)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-Juan%20Andr%C3%A9s%20Hurtado-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/in/juan-andres-hurtado/)
**[Open the live demo →](https://pitchiq-theta.vercel.app)**

</div>

---

## The problem

Football generates an enormous amount of data, but most of it stays locked behind two barriers:

1. **Technical friction.** Answering something as simple as *"which team has the best form over the last five matches?"* requires writing code, not asking a question.
2. **Static dashboards.** Traditional BI tools answer the questions someone anticipated in advance. Real curiosity is open-ended.

**PitchIQ** removes both. It combines statistical models trained on historical match data with an AI agent that queries those models directly — so the analysis happens in conversation, not in a notebook.

---

## What it does

| Capability | Description | Status |
|---|---|---|
| 🔄 **Automated ingestion** | Daily pipeline pulling fresh results via GitHub Actions | ✅ |
| 📊 **Exploratory analysis** | Home advantage, goal distributions, team strength | ✅ |
| 🎯 **Match forecasting** | Dixon–Coles model producing win/draw/loss probabilities | ✅ |
| 🤖 **Conversational agent** | Gemini with function calling — asks the data, doesn't invent it | ✅ |
| 🖥️ **Live dashboard** | Next.js frontend with embedded chat, deployed on Vercel | ⬜ |
| 📈 **Live accuracy tracking** | Scoring forecasts against real results as the season unfolds | ⬜ |

---

## Results

The model was evaluated on a held-out season it never saw during training.

| Metric | Baseline | Dixon–Coles |
|---|---|---|
| Accuracy | 42.6% | **46.8%** |
| Log-loss | 1.0852 | **1.0300** |
| RPS improvement | — | **7.9%** |

The baseline is "always predict a home win." Accuracy is the least interesting number here: football is genuinely high-variance, and professional bookmakers with far richer data operate in a similar range. The meaningful gain is in **log-loss and ranked probability score**, which measure whether the stated probabilities are honest rather than whether the top pick happened to be right.

One exploratory finding drove the model choice: goal counts in the dataset are statistically consistent with a Poisson distribution (χ² goodness-of-fit, p = 0.31 home / p = 0.46 away). That makes Poisson regression a justified starting point rather than an arbitrary one.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      DATA SOURCE                            │
│              football-data.org  ·  Premier League           │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  INGESTION LAYER          src/ingestion/                    │
│  Scheduled ETL via GitHub Actions (daily cron)              │
│  fetch → normalize → validate → data/processed/             │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  MODELING LAYER           notebooks/                        │
│  Poisson GLM · Dixon-Coles · attack/defense ratings         │
│  → data/predictions/                                        │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  AGENT LAYER              src/agent/                        │
│  Gemini + function calling over 7 data tools                │
│  get_standings · get_team_form · get_match_prediction       │
│  get_upcoming_fixtures · get_team_ratings                   │
│  get_head_to_head · evaluate_model_accuracy                 │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  PRESENTATION LAYER       app/                              │
│  Next.js dashboard + chat interface  →  Vercel              │
└─────────────────────────────────────────────────────────────┘
```

### Design decisions

- **Function calling over RAG.** The agent runs real queries against real data instead of retrieving text about it. This removes a whole class of hallucination risk — a hard requirement if forecasts are going to be trusted.

- **Provider-agnostic tool layer.** Tools are declared once in `tools.py` using a neutral schema. Each agent implementation adapts them to its provider's format, so switching models means writing a thin adapter rather than rewriting the data logic.

- **Chronological train/test split.** A random split would let the model learn from matches that happened *after* the ones it predicts. The split is enforced with an assertion so the leak cannot slip back in silently.

- **Validation inside the pipeline.** Ingestion checks for duplicates, impossible scores and finished matches missing results before anything reaches the models. Bad data fails loudly instead of quietly degrading forecasts.

- **Versioned data artifacts.** Processed data and forecasts are committed by the pipeline, making every prediction reproducible and auditable after the fact.

- **Three recent seasons, not ten.** Training depth is limited by what the free API tier exposes, but the constraint aligns with the domain: squads and managers turn over, so older seasons contribute more noise than signal.

---

## Tech stack

**Data & Modeling** — Python · pandas · NumPy · SciPy · statsmodels · scikit-learn
**AI** — Google Gemini API (function calling via the Interactions API)
**Orchestration** — GitHub Actions
**Frontend** — Next.js · TypeScript · Tailwind CSS
**Deployment** — Vercel

---

## Getting started

### Prerequisites

- Python 3.12+
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
```

### Configuration

Create a `.env` file in the project root:

```env
FOOTBALL_DATA_API_KEY=your_key_here
GEMINI_API_KEY=your_key_here
```

> `.env` is gitignored. Never commit API keys.

### Running it

```bash
# Fetch the current season
python src/ingestion/fetch_matches.py

# Fetch a specific season
python src/ingestion/fetch_matches.py --season 2024

# Talk to the agent
python src/agent/gemini_agent.py

# Or ask a single question
python src/agent/gemini_agent.py "How has Arsenal been playing lately?"
```

Run the notebooks in order to reproduce the analysis and regenerate forecasts:

1. `notebooks/01_exploratory_analysis.ipynb`
2. `notebooks/02_outcome_model.ipynb`

---

## Roadmap

- [x] Project scaffolding and environment setup
- [x] Daily ingestion pipeline (football-data.org)
- [x] Automated scheduling via GitHub Actions
- [x] Exploratory data analysis
- [x] Match outcome model (Poisson GLM + Dixon–Coles)
- [x] Conversational agent with function calling
- [ ] Next.js dashboard
- [ ] Vercel deployment
- [ ] Prediction accuracy tracking over a live season
- [ ] Expected goals (xG) model from event-level data

---

## Project structure

```
pitchiq/
├── .github/workflows/
│   └── ingest.yml         # Daily scheduled pipeline
├── app/                   # Next.js frontend
├── data/
│   ├── raw/               # Source data (gitignored)
│   ├── processed/         # Clean, versioned match data
│   └── predictions/       # Model forecasts and team ratings
├── notebooks/
│   ├── 01_exploratory_analysis.ipynb
│   └── 02_outcome_model.ipynb
├── src/
│   ├── ingestion/
│   │   └── fetch_matches.py
│   ├── models/
│   └── agent/
│       ├── tools.py           # Data tools exposed to the agent
│       └── gemini_agent.py    # Gemini function-calling loop
├── requirements.txt
└── README.md
```

---

## Known limitations

The model knows goals, teams and dates. It does not know about:

- **Squad information** — injuries, suspensions and transfers are invisible to it
- **Newly promoted teams** — they receive replacement-level ratings until they accumulate matches, which makes their early-season forecasts the least reliable in the set
- **Fixture congestion** — teams playing midweek in Europe are systematically disadvantaged, and the model has no way to see it

These are stated rather than buried, because a forecasting system that overstates its own reach is worse than one that is clear about where it stops.

---

## Data sources & attribution

- **[football-data.org](https://www.football-data.org/)** — fixtures, results and standings

This is an independent, non-commercial project built for learning and portfolio purposes. It is not affiliated with the Premier League or any club.

---

## About this project

PitchIQ is a personal project applying business analytics, data engineering and generative AI to something I actually care about. The goal was to build the full path end to end — from raw ingestion to a deployed interface — rather than stopping at a notebook.

**Juan Andrés Hurtado** · [LinkedIn](https://www.linkedin.com/in/juan-andres-hurtado/) · [GitHub](https://github.com/JuanAndresHS)

---

<div align="center">
<sub>Built with curiosity, and a lot of matchday data.</sub>
</div>
