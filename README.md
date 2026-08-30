<div align="center">

# ⚽ PitchIQ

**An AI-powered analytics copilot for the Premier League**

Predictive models, expected goals (xG), and a conversational agent that answers football questions in natural language — over live, daily-updated data.

[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Claude API](https://img.shields.io/badge/Claude-API-D97757?logo=anthropic&logoColor=white)](https://www.anthropic.com/api)
[![Next.js](https://img.shields.io/badge/Next.js-15-000000?logo=next.js&logoColor=white)](https://nextjs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Status](https://img.shields.io/badge/status-in%20development-blue)]()
[![LinkedIn](https://img.shields.io/badge/LinkedIn-Juan%20Andr%C3%A9s%20Hurtado-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/in/juan-andres-hurtado/)

</div>

---

## The problem

Football generates an enormous amount of data, but most of it stays locked behind two barriers:

1. **Technical friction.** Answering something as simple as *"which team has the best form over the last five matches, adjusted for opponent strength?"* requires writing code, not asking a question.
2. **Static dashboards.** Traditional BI tools answer the questions someone anticipated in advance. Real curiosity is open-ended.

**PitchIQ** removes both. It combines statistical models trained on historical match data with an AI agent that queries those models directly — so the analysis happens in conversation, not in a notebook.

---

## What it does

| Capability | Description |
|---|---|
| 📊 **Match outcome prediction** | Poisson / gradient boosting models estimating win–draw–loss probabilities |
| 🎯 **Expected goals (xG)** | Shot-quality model built from event-level data |
| 📈 **Dynamic team ratings** | Elo-style ratings updated after every matchweek |
| 🤖 **Conversational agent** | Claude with tool-calling — asks the data, doesn't hallucinate it |
| 🔄 **Automated ingestion** | Daily pipeline pulling fresh results via GitHub Actions |
| 🖥️ **Live dashboard** | Next.js frontend with embedded chat, deployed on Vercel |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      DATA SOURCES                           │
│  football-data.org (live)  ·  StatsBomb / FBref (historic)  │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  INGESTION LAYER          src/ingestion/                    │
│  Scheduled ETL via GitHub Actions (daily cron)              │
│  → validation → normalization → data/processed/             │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  MODELING LAYER           src/models/                       │
│  xG model · outcome prediction · Elo ratings                │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  AGENT LAYER              src/agent/                        │
│  Claude API + tool-calling                                  │
│  get_standings() · get_team_form() · predict_match()         │
│  compare_prediction_vs_actual()                             │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  PRESENTATION LAYER       app/                              │
│  Next.js dashboard + chat interface  →  Vercel              │
└─────────────────────────────────────────────────────────────┘
```

### Design decisions

- **Hybrid data strategy.** Models train on rich historical event data; the live layer keeps predictions current. Detailed event data (passes, shot locations) is commercial and not available as a real-time free feed, so the architecture separates *what needs to be fresh* from *what needs to be deep*.
- **Tool-calling over RAG.** The agent runs real queries against real data instead of retrieving text about it. This removes a whole class of hallucination risk — a hard requirement if predictions are going to be trusted.
- **Versioned data artifacts.** Processed data is committed by the pipeline, making every prediction reproducible and auditable after the fact.

---

## Tech stack

**Data & Modeling** — Python · pandas · scikit-learn · XGBoost · statsmodels
**AI** — Anthropic Claude API (tool use)
**Orchestration** — GitHub Actions
**Frontend** — Next.js · TypeScript · Tailwind CSS
**Deployment** — Vercel

---

## Getting started

### Prerequisites

- Python 3.12+
- Node.js 20+
- A [football-data.org](https://www.football-data.org/) API key (free tier)
- An [Anthropic API key](https://console.anthropic.com/)

### Installation

```bash
# Clone the repository
git clone https://github.com/JuanAndresHS/pitchiq.git
cd pitchiq

# Create and activate a virtual environment
python -m venv venv
venv\Scripts\activate        # Windows
# source venv/bin/activate   # macOS / Linux

# Install dependencies
pip install -r requirements.txt
```

### Configuration

Create a `.env` file in the project root:

```env
FOOTBALL_DATA_API_KEY=your_key_here
ANTHROPIC_API_KEY=your_key_here
```

> `.env` is gitignored. Never commit API keys.

### Running the pipeline

```bash
python src/ingestion/fetch_matches.py
```

---

## Roadmap

- [x] Project scaffolding and environment setup
- [x] Daily ingestion pipeline (football-data.org)
- [x] Automated scheduling via GitHub Actions
- [ ] Exploratory data analysis
- [ ] Match outcome prediction model
- [ ] Expected goals (xG) model
- [ ] Elo rating system
- [ ] Claude agent with tool-calling
- [ ] Next.js dashboard
- [ ] Vercel deployment
- [ ] Prediction accuracy tracking over a live season

---

## Project structure

```
pitchiq/
├── .github/workflows/     # Scheduled pipeline automation
├── app/                   # Next.js frontend
├── data/
│   ├── raw/               # Source data (gitignored)
│   └── processed/         # Clean, versioned datasets
├── notebooks/             # Exploratory analysis
├── src/
│   ├── ingestion/         # ETL scripts
│   ├── models/            # Predictive models
│   └── agent/             # Claude tool definitions
├── requirements.txt
└── README.md
```

---

## Data sources & attribution

- **[football-data.org](https://www.football-data.org/)** — live fixtures, results and standings
- **[StatsBomb Open Data](https://github.com/statsbomb/open-data)** — event-level match data, released publicly for the research community
- **[FBref](https://fbref.com/)** — historical season statistics

This is an independent, non-commercial project built for learning and portfolio purposes. It is not affiliated with the Premier League or any club.

---

## About this project

PitchIQ is a personal project applying business analytics, data engineering and generative AI to something I actually care about. The goal was to build the full path end to end — from raw ingestion to a deployed interface — rather than stopping at a notebook.

**Juan Andrés Hurtado** · [LinkedIn](https://www.linkedin.com/in/juan-andres-hurtado/) · [GitHub](https://github.com/JuanAndresHS)

---

<div align="center">
<sub>Built with curiosity, and a lot of matchday data.</sub>
</div>
