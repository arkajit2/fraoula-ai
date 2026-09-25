# Fraoula AI — Fast, Focused AI Chat

> A minimal AI chat workspace with multiple models and prepaid credits.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/arkajit2/fraoula-ai)

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + TanStack Start + TypeScript |
| Styling | Tailwind CSS v4 + shadcn/ui (Radix UI) |
| Routing | TanStack Router (file-based) |
| Auth | Supabase Auth |
| Database | Supabase (PostgreSQL + RLS) |
| Payments | Stripe (one-off credits + subscriptions) |
| Python API | FastAPI (supplementary backend) |
| Hosting | Cloudflare Pages + Workers |
| CI/CD | GitHub Actions |

---

## Features

- 🤖 **Multi-model chat** — Gemini, GPT, Claude, Fable models in one UI
- 💳 **Prepaid credits** — buy credit packs or subscribe for monthly credits
- 🆓 **Free tier** — daily allowance on the Gemini 2.5 Flash Lite model
- 🔐 **Auth** — email/password + social OAuth via Supabase
- 🖼️ **Image generation** — GPT-Image-2 and Gemini Pro Image
- 📊 **Usage dashboard** — per-model token usage and cost breakdown
- 🛡️ **Security** — rate limiting, RLS, CSRF headers, CSP

---

## Getting Started (local)

### Prerequisites

- Node.js 26+ / npm 11+
- Python 3.13+ (for the supplementary backend)
- A [Supabase](https://supabase.com) project
- A [Stripe](https://stripe.com) account

### Frontend

```sh
git clone https://github.com/arkajit2/fraoula-ai
cd fraoula-ai
npm install
cp .env .env.local  # fill in your Supabase keys
npm run dev
```

App runs at `http://localhost:3000`.

### Python backend

```sh
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

API docs available at `http://localhost:8000/docs`.

---

## Environment Variables

| Variable | Where | Description |
|---|---|---|
| `VITE_SUPABASE_URL` | `.env` | Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `.env` | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only | Service-role key for admin ops |
| `OPENAI_API_KEY` | Server only | OpenAI / gateway API key |
| `ANTHROPIC_API_KEY` | Server only | Anthropic API key |
| `GOOGLE_API_KEY` | Server only | Google AI API key |
| `STRIPE_SECRET_KEY` | Server only | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Server only | Stripe webhook signing secret |
| `INTERNAL_API_SECRET` | Server only | Guards `/api/py/admin/*` |

---

## Deployment

### Cloudflare Pages (recommended)

1. Push to GitHub (this repo).
2. In the Cloudflare dashboard → **Pages** → **Create a project** → connect this repo.
3. Set build command: `npm run build`
4. Set output directory: `.output/public`
5. Add all environment variables listed above as **encrypted secrets**.
6. Done — every push to `main` auto-deploys via GitHub Actions.

### GitHub Actions secrets needed

| Secret | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Deploy via wrangler |
| `CLOUDFLARE_ACCOUNT_ID` | Your CF account |
| `VITE_SUPABASE_URL` | Build-time env |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Build-time env |
| `VITE_SUPABASE_PROJECT_ID` | Build-time env |

---

## Project Structure

```
fraoula-ai/
├── backend/                  ← Python FastAPI supplementary API
│   ├── main.py               ← App entry point
│   ├── requirements.txt
│   └── tests/
├── src/
│   ├── components/           ← React UI components
│   │   ├── chat/             ← Chat UI (ChatView, MessageBubble, …)
│   │   └── ui/               ← shadcn/ui primitives
│   ├── hooks/                ← Custom React hooks
│   ├── integrations/
│   │   ├── supabase/         ← Supabase client + auth middleware
│   │   └── lovable/          ← Lovable cloud integration
│   ├── lib/                  ← Shared logic (pricing, chat, billing…)
│   └── routes/               ← File-based routes (TanStack Router)
│       ├── __root.tsx
│       ├── index.tsx
│       ├── auth.tsx
│       ├── _authenticated/   ← Protected routes
│       │   ├── chat.index.tsx
│       │   ├── chat.$conversationId.tsx
│       │   ├── billing.tsx
│       │   ├── usage.tsx
│       │   ├── profile.tsx
│       │   ├── security.tsx
│       │   ├── transactions.tsx
│       │   └── admin.tsx
│       └── api/
│           └── public/payments/webhook.ts
├── supabase/
│   └── migrations/           ← SQL migrations
├── .github/workflows/        ← CI/CD (GitHub Actions)
├── wrangler.toml             ← Cloudflare Workers config
├── _headers                  ← Cloudflare Pages headers
├── _redirects                ← SPA fallback redirect
└── vite.config.ts
```

---

## Pricing Model

- **Free tier**: 25 messages / 24 h on Gemini 2.5 Flash Lite
- **Pay-as-you-go**: top up with credit packs (\$20 / \$50 / \$100)
- **Plus** \$19/mo: \$20 credits/mo + standard premium models
- **Pro** \$49/mo: \$55 credits/mo + all models
- **Business** \$149/mo: \$170 credits/mo + highest limits

---

## License

MIT © Fraoula AI
