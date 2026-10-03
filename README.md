# NeverMissLeadsNow — AI Voice Receptionist & Lead Automation

Live SaaS product for home-service contractors: an AI phone receptionist that answers every missed call, qualifies the lead, books the job, and follows up automatically — so a plumber or electrician running a two-truck operation never loses a lead to voicemail again.

## What this is

Four Cloudflare Workers that sit between a contractor's phone number and their CRM, orchestrating a live voice agent, lead storage, and billing:

- **`nmln-automation-worker.js`** — the core orchestrator. Handles Stripe checkout/subscriptions, onboarding retry/dunning (recalls + texts a client who missed their setup call, up to 4 attempts over 2 days before alerting a human), and a cron-driven rate-limited demo-call endpoint that guards against telephony-cost abuse.
- **`nmln-lead-lookup-worker-v2.js`** — fires when a call comes in; looks up the caller in Airtable and routes to the right AI assistant (receptionist vs. sales-callback) based on whether they're a known lead.
- **`nmln-client-lookup-worker-v4.js`** — same pattern for existing clients, with SMS fallback via Telnyx when the voice assistant can't resolve the caller.
- **`nmln-demo-lookup-worker.js`** — powers the live "try the demo" flow on the landing page.

`website/index.html` is the landing page — a 7-step builder (pick a voice → business name → website → trade → hear a live demo call → call forwarding setup → pricing) that gets a contractor from "never heard of this" to "phone forwarded" in one sitting.

## Stack

Cloudflare Workers + KV (rate limiting, retry state) · Vapi (voice AI) · Telnyx (SMS/telephony) · Airtable (lead/client store) · Stripe (billing) · Make.com (cross-system automation)

## Why it's built this way

Everything runs as Workers rather than a traditional backend because the actual job — route a phone call to the right AI assistant in under a second, globally, for cents per month — is exactly what edge compute is for. The KV-backed rate limiter on the public demo endpoint exists because an open "call me now" button on a marketing page is a direct line to real telephony cost if left unguarded (1 call per number / 10 min, 5 per IP / hour).

## What's not in this repo

This is an extract of the parts safe to show — the worker code and the landing page. The full project also includes Make.com automation scenarios, internal pricing/ops docs, and account credentials, which stay in a private repo.
