// nmln-automation-worker.js
// NeverMissLeadsNow — Automation Worker
// Replaces Make.com S1 (new client onboarding) and S14 (knowledge capture)
// Also handles /leads/create for the get-started landing page
//
// Routes:
//   POST /stripe/checkout          — Stripe webhook: checkout.session.completed (signup → Jordan Call 1)
//                                    and invoice.payment_succeeded (Day-7 charge → Jordan Call 2)
//   POST /vapi/onboarding-complete — Jordan's onboarding call ended
//   POST /jordan/send-calendar-link— Jordan's sendCalendarLink tool: text the one-tap calendar connect link
//   POST /leads/create             — SEO/PPC visitor submitted get-started form
//   POST /leads/enrich             — generate Business Knowledge for one lead record
//   POST /leads/enrich-batch       — generate Business Knowledge for all leads missing it
//   POST /leads/send-demo-sms      — send demo SMS via Telnyx, mark Demo Sent in Leads
//   GET  /leads/send-demo-sms      — Alex's sendDemoLink tool (GET): ?phone=&name=, text personalized demo link
//   POST /leads/send-demo-link     — Alex's sendDemoLink tool: text personalized demo link, mark Demo Sent
//   POST /leads/send-sms           — Sales assistant sms_tool: send arbitrary SMS via Telnyx
//   GET  /leads/filter-mobile      — Telnyx carrier lookup: keep mobile leads, delete non-mobile
//                                    ?test=true → dry-run 5 records (no mutations), returns line types
//   GET  /leads/delete-voip        — Telnyx lookup on Is Mobile=true leads, delete any that are VoIP
//                                    ?test=true → dry-run 5 records, returns line types, no deletes
//   GET  /calendar/connect         — start Google Calendar OAuth (redirect to Google)
//   GET  /calendar/callback        — OAuth redirect target; stores tokens on the client
//   POST /calendar/availability    — return up to 6 open 1-hour slots (8am-6pm ET)
//   POST /calendar/book            — book a confirmed appointment on the client's calendar
//
// Environment variables required (set in Cloudflare dashboard):
//   STRIPE_WEBHOOK_SECRET   — whsec_... from Stripe webhook settings
//   STRIPE_SECRET_KEY       — rk_live_... or sk_live_... for Stripe API calls (cancellations)
//   VAPI_API_KEY            — Vapi bearer token
//   AIRTABLE_TOKEN          — Airtable personal access token (full access)
//   TELNYX_API_KEY          — Telnyx API key
//   ANTHROPIC_API_KEY       — Anthropic API key for knowledge capture
//   GOOGLE_CLIENT_ID        — Google OAuth client id (calendar access)
//   GOOGLE_CLIENT_SECRET    — Google OAuth client secret (the GOCSPX-... string)
//   ADMIN_KEY               — shared secret for GET /admin/* maintenance routes

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const AIRTABLE_CLIENTS     = "Clients";
const AIRTABLE_LEADS       = "Leads";
const JORDAN_ASSISTANT_ID  = "39aca192-a5e8-4a61-b7a0-de2ea93b85a6";
const JORDAN_PHONE_ID      = "38bda00d-ff23-428b-b9e4-af62f72d6584"; // Twilio +18045714007 (outbound-reliable; replaced Telnyx a5d77094 which lacked a voice transport, and free vapi 8eb0b27c)
const JORDAN_CALLBACK_NUMBER = "+18045714007"; // the human-dialable digits behind JORDAN_PHONE_ID — texted to customers who miss Jordan's onboarding call so they can call in (inbound assistant on this number must be Jordan; set via GET /admin/set-jordan-inbound)
const ONBOARDING_MAX_ATTEMPTS = 4;   // recall attempts before giving up (2/day × 2 days)
const ONBOARDING_SLOTS_UTC = [15, 21]; // daily recall hours in UTC (~11am & ~5pm ET)
const DEMO_ASSISTANT_ID    = "95af8a19-87f7-4a03-8a20-ee386fbdb099"; // NeverMissLeads Demo Receptionist (Alex) — used by the landing-page "call me live" demo
// Mirrors DEMO_ASSISTANT_ID's own model.{model,provider,toolIds,emotionRecognitionEnabled}
// (fetched live via GET /assistant/:id, 2026-07-11) — only `messages` actually changes per
// call. Included explicitly here (not just `{messages:[...]}`) because it's unconfirmed
// whether Vapi deep-merges assistantOverrides.model or replaces it wholesale; omitting
// toolIds would silently break the "knowledge base attached" instruction the system
// prompt depends on.
const DEMO_ASSISTANT_MODEL = {
  provider: "groq",
  model: "meta-llama/llama-4-maverick-17b-128e-instruct",
  toolIds: ["63a84158-23b1-451a-b5c4-ecbeb40d48ea"],
  emotionRecognitionEnabled: true
};
const DEMO_INTL_PHONE_ID   = "d904101c-cd8c-45b7-8056-ded366b63373"; // Telnyx +15402157422 — re-registered 2026-07-10 with fresh credential; outbound voice profile NMLN Outbound (global, IL+18 countries); 251d13c7 had stale credential causing error-get-transport
const TELNYX_FROM          = "+15402157422";
const ERIC_MOBILE          = "+18042535119";
const CLOUDFLARE_WORKER_URL = "https://nmln-client-lookup.eric-04b.workers.dev";
const LP_URL               = "https://nevermissleadsnow.com/lp";

// Trial pricing tiers — source of truth for both /stripe/create-checkout-session
// (builds the Stripe line item) and handleStripeCheckout (reads back via metadata.tier
// to know what was actually purchased). Mirror these dollar amounts in the lp.html
// wizard's pricing step if they ever change.
// annual = monthly * 12 * 0.9 (10% off), rounded down to a whole dollar.
const TIERS = {
  starter: { name: "Starter", monthly: 44,  annual: 475  }, // 44*12*0.9  = 475.2
  growth:  { name: "Growth",  monthly: 144, annual: 1555 }, // 144*12*0.9 = 1555.2
  pro:     { name: "Pro",     monthly: 294, annual: 3175 }, // 294*12*0.9 = 3175.2
};

// Voice options offered in the wizard's voice-picker step. Deepgram Aura voices
// already in use elsewhere in this account (see vapi-configs/vapi-complete-
// configuration.txt) — asteria is the existing Demo Receptionist's voice ("Alex"),
// luna/athena/orion are documented as available on this Vapi account but unused
// in production, chosen here for genuinely distinct character (warm-Southern,
// energetic, calm, professional-male) rather than four similar-sounding options.
// Mirror in lp.html's wizard if these ever change.
// NOTE: voiceId is Vapi's short deepgram voice name (asteria/luna/athena/orion),
// NOT Deepgram's own "aura-asteria-en" model id — Vapi's assistantOverrides.voice.voiceId
// validation rejects the "aura-*-en" form (confirmed live 2026-07-11: 400 Bad Request,
// "voiceId must be one of the following values: asteria, luna, ... athena, ... orion, ...").
const VOICES = {
  asteria: { name: "Alex",   gender: "female", provider: "deepgram", voiceId: "asteria", desc: "Warm & Friendly" },
  luna:    { name: "Luna",   gender: "female", provider: "deepgram", voiceId: "luna",    desc: "Upbeat & Energetic" },
  athena:  { name: "Athena", gender: "female", provider: "deepgram", voiceId: "athena",  desc: "Calm & Reassuring" },
  orion:   { name: "Orion",  gender: "male",   provider: "deepgram", voiceId: "orion",   desc: "Warm & Professional" },
};

// ─── MAIN FETCH HANDLER ───────────────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    const result = await handleLeadEnrichBatch({}, env);
    console.log("Cron enrich:", JSON.stringify(result));
    try {
      const retries = await processOnboardingRetries(env);
      console.log("Onboarding retries:", JSON.stringify(retries));
    } catch (err) {
      console.error("processOnboardingRetries failed:", err.message);
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers for browser requests (get-started form)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "https://nevermissleadsnow.com",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      // /leads/send-demo-sms (Kixie webhook) and /leads/send-demo-link (Vapi tool) allow any origin
      const origin = (path === "/leads/send-demo-sms" || path === "/leads/send-demo-link" || path === "/leads/send-sms" || path === "/vapi/cancel-subscription")
        ? "*"
        : "https://nevermissleadsnow.com";
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        }
      });
    }

    // ── Google Calendar OAuth — browser GET flows (handled before POST guard) ─
    if (request.method === "GET" && path === "/calendar/connect") {
      return handleCalendarConnect(request, env);
    }
    if (request.method === "GET" && path === "/calendar/callback") {
      return await handleCalendarCallback(request, env);
    }

    // ── Admin: clean up phone-less trial test clients ────────────────────────
    if (request.method === "GET" && path === "/admin/cleanup-test-clients") {
      return await handleCleanupTestClients(request, env);
    }

    // ── Admin: one-off — deactivate the stale static Stripe Payment Link
    // (buy.stripe.com/dRm7sN4DS0I2bisaNQ57W01) still referenced in the Sales
    // Callback assistant's knowledge base. It charges a flat $197/mo,
    // completely bypassing the tiered wizard/checkout. Safe to remove this
    // route after running it once. ──
    if (request.method === "GET" && path === "/admin/deactivate-stale-link") {
      const adminKey = url.searchParams.get("key") || "";
      if (adminKey !== env.ADMIN_KEY) return new Response("Unauthorized", { status: 401 });
      return await handleDeactivateStaleLink(env);
    }

    // ── Admin: test international phone provisioning + Vapi account/number audit ──
    if (request.method === "GET" && path === "/admin/test-intl-provision") {
      const adminKey = url.searchParams.get("key") || "";
      if (adminKey !== env.ADMIN_KEY) return new Response("Unauthorized", { status: 401 });
      const phone = url.searchParams.get("phone") || "";
      if (!phone) return new Response(JSON.stringify({ error: "?phone= required" }), { status: 400, headers: { "Content-Type": "application/json" } });
      const country = getPhoneCountry(phone);
      const result = { phone, country, isUS: country === "US" };
      // Telnyx number search (no purchase) + KYC requirements check
      if (country !== "US") {
        result.autoProvisionable = await isTelnyxAutoProvisionable(country, env);
        const searchRes = await fetch(
          `https://api.telnyx.com/v2/available_phone_numbers?filter[country_code]=${country}&filter[features][]=voice&filter[limit]=5`,
          { headers: { "Authorization": `Bearer ${env.TELNYX_API_KEY}` } }
        );
        const searchData = await searchRes.json();
        result.telnyxSearch = { status: searchRes.status, count: searchData?.data?.length ?? 0, numbers: (searchData?.data || []).map(n => n.phone_number) };
      }
      // Vapi account + phone number list
      const [vapiAcct, vapiPhones] = await Promise.all([
        vapiRequest(env, "GET", "/account"),
        vapiRequest(env, "GET", "/phone-number?limit=20")
      ]);
      result.vapiAccount = vapiAcct;
      result.vapiPhoneNumbers = Array.isArray(vapiPhones) ? vapiPhones.map(p => ({ id: p.id, number: p.number, provider: p.provider, name: p.name })) : vapiPhones;
      return new Response(JSON.stringify(result, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    // ── Admin: route inbound calls on the Jordan number to the Jordan assistant ─
    // One-time setup so customers who miss Jordan's outbound onboarding call can
    // call the same number back and reach Jordan (not the demo receptionist).
    if (request.method === "GET" && path === "/admin/set-jordan-inbound") {
      return await handleSetJordanInbound(request, env);
    }

    // ── Alex sendDemoLink tool — GET variant with ?phone=&name= ──────────────
    if (request.method === "GET" && path === "/leads/send-demo-sms") {
      return await handleGetSendDemoSms(request, env, ctx);
    }

    // ── Mobile number filter via Telnyx carrier lookup ────────────────────────
    if (request.method === "GET" && path === "/leads/filter-mobile") {
      if (!checkAdminKey(request, env)) {
        return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
      }
      return await handleFilterMobile(request, env);
    }

    // ── Delete Is Mobile=true leads that Telnyx identifies as VoIP ───────────
    if (request.method === "GET" && path === "/leads/delete-voip") {
      if (!checkAdminKey(request, env)) {
        return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
      }
      try {
        return await handleDeleteVoip(request, env);
      } catch (err) {
        console.error("handleDeleteVoip error:", err.message, err.stack);
        return Response.json({ success: false, error: err.message }, { status: 500 });
      }
    }

    // ── Stripe success-page polling: is this client's forwarding number ready yet? ──
    // Vapi number provisioning happens async (ctx.waitUntil) inside the checkout
    // webhook, so the browser lands back on the success page before it necessarily
    // exists — this lets the success page poll until it does.
    if (request.method === "GET" && path === "/activation-status") {
      try {
        return await handleActivationStatus(request, env);
      } catch (err) {
        console.error("handleActivationStatus error:", err.message, err.stack);
        return Response.json({ ready: false, error: err.message }, {
          status: 500,
          headers: { "Access-Control-Allow-Origin": "https://nevermissleadsnow.com" }
        });
      }
    }

    // ── Demo: Generate personalized greeting audio for landing page ──────────
    if (request.method === "OPTIONS" && path === "/demo/generate-audio") {
      const origin = request.headers.get("origin") || "";
      const allowedOrigins = ["https://nevermissleadsnow.com", "http://localhost:8766", "http://127.0.0.1:8766"];
      const corsOrigin = allowedOrigins.includes(origin) ? origin : "https://nevermissleadsnow.com";
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": corsOrigin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }
    if (request.method === "POST" && path === "/demo/generate-audio") {
      try {
        const body = await request.json();
        const { voice, businessName, trade } = body;
        if (!voice || !businessName) {
          return Response.json({ error: "voice and businessName required" }, { status: 400 });
        }
        // Was OpenAI TTS with a hand-picked "closest sounding" voice — an approximation
        // that could never truly match what the customer's live assistant actually
        // sounds like (Vapi uses Deepgram Aura directly). Fixed 2026-07-15: call
        // Deepgram's Aura API with the EXACT SAME model Vapi uses per voiceId
        // (asteria/luna/athena/orion -> aura-*-en), so the demo is byte-for-byte the
        // same voice, not a different engine's guess at it.
        //
        // Uses NMLN's own DEEPGRAM_API_KEY (Cloudflare secret, added 2026-07-15 —
        // the key already existed as a Vapi provider credential for the Demo
        // Receptionist assistant). Calls Deepgram directly, server-side only — the
        // key never reaches the browser, same trust boundary as STRIPE_SECRET_KEY
        // elsewhere in this file. No cross-project dependency.
        const AURA_MODEL_MAP = { asteria: "aura-asteria-en", luna: "aura-luna-en", athena: "aura-athena-en", orion: "aura-orion-en" };
        const auraModel = AURA_MODEL_MAP[voice] || "aura-asteria-en";
        const script = `Thank you for calling ${businessName}${trade ? `, we do ${trade},` : ','} this is ${voice === "asteria" ? "Alex" : voice === "luna" ? "Luna" : voice === "athena" ? "Athena" : "Orion"}. How can I help you today?`;

        const ttsRes = await fetch(`https://api.deepgram.com/v1/speak?model=${auraModel}`, {
          method: "POST",
          headers: {
            "Authorization": `Token ${env.DEEPGRAM_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ text: script })
        });
        if (!ttsRes.ok) {
          const err = await ttsRes.text();
          console.error("Deepgram Aura TTS error:", err);
          return Response.json({ error: "Audio generation failed" }, { status: 500 });
        }
        const audioBuffer = await ttsRes.arrayBuffer();
        const origin = request.headers.get("origin") || "";
        const allowedOrigins = ["https://nevermissleadsnow.com", "http://localhost:8766", "http://127.0.0.1:8766"];
        const corsOrigin = allowedOrigins.includes(origin) ? origin : "https://nevermissleadsnow.com";
        return new Response(audioBuffer, {
          headers: {
            "Content-Type": "audio/mpeg",
            "Cache-Control": "no-cache",
            "Access-Control-Allow-Origin": corsOrigin,
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
          }
        });
      } catch (err) {
        console.error("demo/generate-audio error:", err.message);
        const origin = request.headers.get("origin") || "";
        const allowedOrigins = ["https://nevermissleadsnow.com", "http://localhost:8766", "http://127.0.0.1:8766"];
        const corsOrigin = allowedOrigins.includes(origin) ? origin : "https://nevermissleadsnow.com";
        return Response.json({ error: err.message }, { status: 500, headers: { "Access-Control-Allow-Origin": corsOrigin } });
      }
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      // ── ROUTE 1: Stripe checkout completed ──────────────────────────────────
      if (path === "/stripe/checkout") {
        return await handleStripeCheckout(request, env, ctx);
      }

      // ── ROUTE 2: Vapi onboarding call ended ─────────────────────────────────
      if (path === "/vapi/onboarding-complete") {
        return await handleOnboardingComplete(request, env, ctx);
      }

      // ── ROUTE 15: Cancellation assistant cancelSubscription tool ────────────────
      if (path === "/vapi/cancel-subscription") {
        const body = await request.json();
        const result = await handleCancelSubscription(body, env, ctx);
        return new Response(JSON.stringify(result), {
          headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }
        });
      }

      // ── ROUTE 7: Production receptionist end-of-call → owner notification SMS ─
      if (path === "/vapi/call-complete") {
        return await handleVapiCallComplete(request, env, ctx);
      }

      // ── ROUTE 11: Jordan sendSetupLink tool — text the one-tap forwarding link ─
      if (path === "/jordan/send-setup-link") {
        return await handleSendSetupLink(request, env, ctx);
      }

      // ── ROUTE 13: Jordan sendCalendarLink tool — text the one-tap calendar link ─
      if (path === "/jordan/send-calendar-link") {
        return await handleSendCalendarLink(request, env, ctx);
      }

      // ── ROUTE 3: SEO/PPC lead form submission ────────────────────────────────
      if (path === "/leads/create") {
        const body = await request.json();
        const result = await handleLeadCreate(body, env);
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // ── ROUTE 4: Enrich one lead record with AI-generated Business Knowledge ──
      if (path === "/leads/enrich") {
        if (!checkAdminKey(request, env)) return new Response("Forbidden", { status: 403 });
        const body = await request.json();
        const result = await handleLeadEnrich(body, env);
        return Response.json(result);
      }

      // ── ROUTE 5: Batch-enrich all leads missing Business Knowledge ────────────
      if (path === "/leads/enrich-batch") {
        if (!checkAdminKey(request, env)) return new Response("Forbidden", { status: 403 });
        const body = await request.json();
        const result = await handleLeadEnrichBatch(body, env);
        return Response.json(result);
      }

      // ── ROUTE 8: Re-enrich leads that have BOTH Business + Website Knowledge ───
      if (path === "/leads/reenrich-batch") {
        if (!checkAdminKey(request, env)) return new Response("Forbidden", { status: 403 });
        const body = await request.json();
        const result = await handleLeadReenrichBatch(body, env);
        return Response.json(result);
      }

      // ── ROUTE 9: Google Calendar — return open appointment slots ─────────────
      if (path === "/calendar/availability") {
        const body = await request.json();
        const result = await handleCalendarAvailability(body, env);
        return Response.json(result);
      }

      // ── ROUTE 10: Google Calendar — book a confirmed appointment ─────────────
      if (path === "/calendar/book") {
        const body = await request.json();
        const result = await handleCalendarBook(body, env);
        return Response.json(result);
      }

      // ── ROUTE 6: Send demo SMS via Telnyx, mark Demo Sent in Leads ───────────
      if (path === "/leads/send-demo-sms") {
        const demoCorsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        };
        const body = await request.json();
        // Vapi tool-call format — route through the Vapi-aware sendDemoLink handler
        const vapiCalls = body?.message?.toolCalls || body?.message?.toolCallList;
        const result = (vapiCalls?.length)
          ? await handleSendDemoLink(body, env, ctx)
          : await handleSendDemoSms(body, env, ctx);
        return new Response(JSON.stringify(result), {
          status: result.success ? 200 : 400,
          headers: { ...demoCorsHeaders, "Content-Type": "application/json" }
        });
      }

      // ── ROUTE 14: Sales assistant sms_tool — send arbitrary SMS via Telnyx ───
      if (path === "/leads/send-sms") {
        const smsCorsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        };
        const body = await request.json();
        const result = await handleSendSms(body, env, ctx);
        return new Response(JSON.stringify(result), {
          status: result.success !== false ? 200 : 400,
          headers: { ...smsCorsHeaders, "Content-Type": "application/json" }
        });
      }

      // ── ROUTE 12: Alex's sendDemoLink tool — text personalized demo link ─────
      if (path === "/leads/send-demo-link") {
        const demoLinkCorsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        };
        const body = await request.json();
        const result = await handleSendDemoLink(body, env, ctx);
        return new Response(JSON.stringify(result), {
          // Vapi tool calls expect 200 with a `results` array; only fail hard on bad input
          status: result.success ? 200 : 400,
          headers: { ...demoLinkCorsHeaders, "Content-Type": "application/json" }
        });
      }

      // ── ROUTE 16: Landing-page "call me" live demo — Alex calls the visitor ──
      if (path === "/demo/call") {
        const demoCorsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        };
        const body = await request.json();
        const result = await handleDemoCall(body, request, env, ctx);
        return new Response(JSON.stringify(result), {
          status: result.status || (result.success ? 200 : 400),
          headers: { ...demoCorsHeaders, "Content-Type": "application/json" }
        });
      }

      // ── ROUTE 17: Wizard's final step — create a Stripe Checkout Session for the
      //             selected tier and redirect the browser there to enter a card ──
      if (path === "/stripe/create-checkout-session") {
        const wizardCorsHeaders = {
          "Access-Control-Allow-Origin": "https://nevermissleadsnow.com",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        };
        const body = await request.json();
        const result = await handleCreateCheckoutSession(body, env);
        return new Response(JSON.stringify(result), {
          status: result.error ? 400 : 200,
          headers: { ...wizardCorsHeaders, "Content-Type": "application/json" }
        });
      }

      return new Response("Not found", { status: 404 });

    } catch (err) {
      console.error("Worker error:", err.message, err.stack);
      // Alert Eric about unexpected errors
      ctx.waitUntil(sendSMS(env,
        ERIC_MOBILE,
        `NMLN WORKER ERROR: ${err.message} — Path: ${path}`
      ));
      return new Response("Internal error", { status: 500 });
    }
  }
};

// Anti-abuse cooldown for the unauthenticated demo-SMS senders below. These
// routes accept any caller-supplied phone number with no auth (Vapi calls them
// as tools, so they can't require a key without a matching Vapi-side change).
// Per-number-only (no per-IP) because Vapi calls these from its own server IPs
// on behalf of many different customers — an IP cap would risk blocking
// legitimate demo texts across unrelated customers. This just stops one
// target number from being repeatedly texted/SMS-bombed.
async function checkSmsDemoCooldown(env, phone) {
  if (!env.DEMO_RATELIMIT) return { blocked: false };
  const numKey = `smsdemo:num:${phone}`;
  const hit = await env.DEMO_RATELIMIT.get(numKey);
  if (hit) return { blocked: true, numKey };
  return { blocked: false, numKey };
}
async function recordSmsDemoSend(env, numKey) {
  if (!env.DEMO_RATELIMIT || !numKey) return;
  await env.DEMO_RATELIMIT.put(numKey, "1", { expirationTtl: 600 }); // 10 min
}

// ─── GET /leads/send-demo-sms (Alex's sendDemoLink tool — GET variant) ────────
// Vapi calls this via GET ?phone=&name=. URL-decodes the name (URLSearchParams
// handles this), builds the personalized demo URL, and sends via Telnyx.
async function handleGetSendDemoSms(request, env, ctx) {
  const url = new URL(request.url);
  const phone = url.searchParams.get("phone") || "";
  const name  = url.searchParams.get("name")  || "";

  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }
  });

  if (!phone || !name) {
    return json({ success: false, error: "phone and name are required" }, 400);
  }

  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    return json({ success: false, error: `Invalid phone number: ${phone}` }, 400);
  }

  const cooldown = await checkSmsDemoCooldown(env, normalizedPhone);
  if (cooldown.blocked) {
    return json({ success: false, error: "That number was just sent a demo link — try again in a few minutes." }, 429);
  }

  const demoUrl = `https://nevermissleadsnow.com/?name=${encodeURIComponent(name)}`;
  const text = `Hi! Here's the live demo link for your AI receptionist — tap it to test it out: ${demoUrl}`;

  const smsData = await sendSMS(env, normalizedPhone, text);

  if (smsData?.errors) {
    console.error("GET sendDemoSms Telnyx failed:", JSON.stringify(smsData));
    return json({ success: false, error: smsData.errors[0]?.detail || "SMS send failed" }, 400);
  }

  console.log("GET demo SMS sent to:", normalizedPhone, "for:", name);

  ctx.waitUntil((async () => {
    await recordSmsDemoSend(env, cooldown.numKey);
    const lead = await airtableLookup(env, AIRTABLE_LEADS, "Phone", normalizedPhone);
    if (lead) {
      await airtableUpdate(env, AIRTABLE_LEADS, lead.id, { "Demo Sent": true });
      console.log("Demo Sent marked for lead:", normalizedPhone);
    }
  })());

  return json({ success: true });
}

// ─── ROUTE 6: SEND DEMO SMS ───────────────────────────────────────────────────
const DEMO_LINE = "+18042868082";

async function handleSendDemoSms(body, env, ctx) {
  const { phone_number, business_name } = body;

  if (!phone_number || !business_name) {
    return { success: false, error: "phone_number and business_name are required" };
  }

  const cooldown = await checkSmsDemoCooldown(env, phone_number);
  if (cooldown.blocked) {
    return { success: false, error: "That number was just sent a demo link — try again in a few minutes." };
  }

  const encodedName = encodeURIComponent(business_name);
  const demoUrl = `https://nevermissleadsnow.com/?name=${encodedName}`;
  const text = `NeverMissLeads: ${demoUrl}`;

  const smsRes = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.TELNYX_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ from: TELNYX_FROM, to: phone_number, text })
  });

  const smsData = await smsRes.json();

  if (!smsRes.ok) {
    console.error("Telnyx SMS failed:", JSON.stringify(smsData));
    return { success: false, error: smsData?.errors?.[0]?.detail || "Telnyx send failed" };
  }

  // Fire-and-forget: mark Demo Sent = true if lead record exists
  ctx.waitUntil((async () => {
    await recordSmsDemoSend(env, cooldown.numKey);
    const lead = await airtableLookup(env, AIRTABLE_LEADS, "Phone", phone_number);
    if (lead) {
      await airtableUpdate(env, AIRTABLE_LEADS, lead.id, { "Demo Sent": true });
      console.log("Demo Sent marked for lead:", phone_number);
    } else {
      console.log("No lead record found for:", phone_number, "— SMS sent anyway");
    }
  })());

  console.log("Demo SMS sent to:", phone_number);
  return { success: true, to: phone_number };
}

// ─── ROUTE 12: SEND DEMO LINK (Alex's sendDemoLink tool) ─────────────────────
// Accepts either a flat body { phone, businessName } (smoke tests / direct calls)
// or a Vapi tool-call payload (message.toolCalls[].function.arguments). Sends the
// personalized demo link, marks Demo Sent on the matching lead, and returns a
// Vapi-compatible { results: [...] } shape when invoked as a tool.
function extractDemoLinkArgs(body) {
  // Flat shape — direct call / smoke test
  if (body && (body.phone || body.businessName)) {
    return { phone: body.phone, businessName: body.businessName, toolCallId: null };
  }
  // Vapi tool-call shape (toolCalls or the newer toolCallList)
  const calls = body?.message?.toolCalls || body?.message?.toolCallList || [];
  const call = calls.find(c => (c.function?.name || c.name) === "sendDemoLink") || calls[0];
  if (call) {
    let args = call.function?.arguments ?? call.arguments ?? {};
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { args = {}; }
    }
    return {
      phone: args.phone || args.phone_number,
      businessName: args.name || args.businessName || args.business_name,
      toolCallId: call.id || null
    };
  }
  return { phone: undefined, businessName: undefined, toolCallId: null };
}

async function handleSendDemoLink(body, env, ctx) {
  const { phone, businessName, toolCallId } = extractDemoLinkArgs(body);

  if (!phone || !businessName) {
    return { success: false, error: "phone and businessName are required" };
  }

  const cooldown = await checkSmsDemoCooldown(env, phone);
  if (cooldown.blocked) {
    return { success: false, error: "That number was just sent a demo link — try again in a few minutes." };
  }

  const demoUrl = `https://nevermissleadsnow.com/?name=${encodeURIComponent(businessName)}`;
  const text = `Here's your personalized demo — hear your AI receptionist answer as ${businessName}: ${demoUrl}`;

  const smsRes = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.TELNYX_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ from: TELNYX_FROM, to: phone, text })
  });
  const smsData = await smsRes.json();

  if (!smsRes.ok) {
    console.error("Telnyx demo-link SMS failed:", JSON.stringify(smsData));
    return { success: false, error: smsData?.errors?.[0]?.detail || "Telnyx send failed" };
  }

  // Fire-and-forget: mark Demo Sent = true if the lead exists
  ctx.waitUntil((async () => {
    await recordSmsDemoSend(env, cooldown.numKey);
    const lead = await airtableLookup(env, AIRTABLE_LEADS, "Phone", phone);
    if (lead) {
      await airtableUpdate(env, AIRTABLE_LEADS, lead.id, { "Demo Sent": true });
      console.log("Demo Sent marked for lead:", phone);
    } else {
      console.log("No lead record found for:", phone, "— demo link sent anyway");
    }
  })());

  console.log("Demo link sent to:", phone);
  const resultMsg = `Demo link sent to ${phone}.`;
  // Vapi reads `results`; direct callers read `success`/`to`.
  return toolCallId
    ? { results: [{ toolCallId, result: resultMsg }], success: true, to: phone }
    : { success: true, to: phone };
}

// ─── ROUTE 14: SALES ASSISTANT sms_tool — SEND ARBITRARY SMS VIA TELNYX ─────
// Accepts a Vapi tool-call envelope (message.toolCalls) or a direct { to, message }
// JSON body. Sends from TELNYX_FROM via the shared sendSMS helper.
async function handleSendSms(body, env, ctx) {
  const calls = body?.message?.toolCalls || body?.message?.toolCallList || [];
  const call = calls.find(c => (c.function?.name || c.name) === "sms_tool") || calls[0];

  let to, message, toolCallId;
  if (call) {
    let args = call.function?.arguments ?? call.arguments ?? {};
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { args = {}; }
    }
    to = args.to;
    message = args.message;
    toolCallId = call.id || null;
  } else {
    to = body?.to;
    message = body?.message;
    toolCallId = null;
  }

  const ok = (resultText) => toolCallId
    ? { results: [{ toolCallId, result: resultText }], success: true }
    : { success: true };
  const fail = (errText) => toolCallId
    ? { results: [{ toolCallId, result: errText }], success: false, error: errText }
    : { success: false, error: errText };

  if (!to || !message) return fail("to and message are required");

  const normalizedTo = normalizePhone(to) || to;
  const smsData = await sendSMS(env, normalizedTo, message);

  if (smsData?.errors) {
    console.error("sms_tool Telnyx failed:", JSON.stringify(smsData));
    return fail(smsData.errors[0]?.detail || "SMS send failed");
  }

  console.log("sms_tool sent to:", normalizedTo);
  return ok(`Message sent to ${normalizedTo}.`);
}

// ─── ROUTE 4: ENRICH ONE LEAD ────────────────────────────────────────────────
async function handleLeadEnrich(body, env) {
  const { recordId, forceReenrich } = body;
  if (!recordId) return { success: false, error: "recordId is required" };

  // Fetch the lead record directly by ID
  const res = await fetch(
    `https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${AIRTABLE_LEADS}/${recordId}`,
    { headers: { "Authorization": `Bearer ${env.AIRTABLE_TOKEN}` } }
  );
  const data = await res.json();
  if (!res.ok) return { success: false, error: `Airtable fetch failed: ${JSON.stringify(data)}` };

  const fields = data.fields || {};

  const getString = (val) => val?.name || val || "";
  const websiteKnowledge     = getString(fields["Website Knowledge"]).trim();
  const hasBusinessKnowledge = !!getString(fields["Business Knowledge"]).trim();
  const hasWebsiteKnowledge  = !!websiteKnowledge;

  // Preserve existing Business Knowledge unless there is new Website Knowledge to fold in.
  // Skip when Business Knowledge already exists AND Website Knowledge is empty — this keeps
  // hand-captured knowledge intact for leads without scraped website content.
  // Re-enrichment happens only when BOTH are populated. forceReenrich overrides for testing.
  if (!forceReenrich && hasBusinessKnowledge && !hasWebsiteKnowledge) {
    return { success: true, skipped: true, reason: "Business Knowledge exists and no Website Knowledge to add" };
  }

  const businessName = getString(fields["Business Name"]) || "Unknown Business";
  const trade        = getString(fields["Trade"])         || "home services";
  const city         = getString(fields["City"])          || "";
  const state        = getString(fields["State"])         || "";
  const address      = getString(fields["Address"])       || "";
  const rating       = fields["Rating"]       != null ? String(fields["Rating"])       : "";
  const reviewCount  = fields["Review Count"] != null ? String(fields["Review Count"]) : "";

  const knowledge = await generateLeadKnowledge(env, { businessName, trade, city, state, address, rating, reviewCount, websiteKnowledge });
  if (!knowledge) return { success: false, error: "Claude returned no content" };

  // Note: "Demo Link" is a computed field in Airtable — do NOT write to it here
  // (it throws INVALID_VALUE_FOR_COLUMN). Airtable derives it from Business Name.
  await airtableUpdate(env, AIRTABLE_LEADS, recordId, {
    "Business Knowledge": knowledge,
  });

  console.log("Business Knowledge saved for lead:", recordId);
  return { success: true, recordId, knowledge };
}

// ─── ROUTE 5: BATCH-ENRICH LEADS ─────────────────────────────────────────────
async function handleLeadEnrichBatch(body, env) {
  // Cap at 15 leads per invocation to stay under Cloudflare's subrequest limit,
  // regardless of the limit passed in.
  const limit = Math.min(body?.limit ?? 15, 15);

  // Fetch Priority 1 (High quality) leads where Business Knowledge is blank
  const formula = encodeURIComponent(`AND({Business Knowledge}="", {Lead Quality (AI)}="High")`);
  const res = await fetch(
    `https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${AIRTABLE_LEADS}?filterByFormula=${formula}&maxRecords=${limit}&fields[]=Business+Name&fields[]=Business+Knowledge&fields[]=Trade&fields[]=City&fields[]=State&fields[]=Address&fields[]=Rating&fields[]=Review+Count`,
    { headers: { "Authorization": `Bearer ${env.AIRTABLE_TOKEN}` } }
  );
  const data = await res.json();
  if (!res.ok) return { success: false, error: `Airtable fetch failed: ${JSON.stringify(data)}` };

  const records = data.records || [];
  console.log(`Batch enrich: ${records.length} leads to process`);

  const results = { success: true, total: records.length, enriched: 0, failed: 0, errors: [] };

  for (const record of records) {
    try {
      const result = await handleLeadEnrich({ recordId: record.id }, env);
      if (result.success && !result.skipped) results.enriched++;
    } catch (err) {
      results.failed++;
      results.errors.push({ recordId: record.id, error: err.message });
      console.error("Enrich failed for", record.id, err.message);
    }
  }

  return results;
}

// ─── ROUTE 8: RE-ENRICH LEADS (Business Knowledge + Website Knowledge) ───────
async function handleLeadReenrichBatch(body, env) {
  // Cap at 15 per invocation to stay under Cloudflare's subrequest limit.
  const limit = Math.min(body?.limit ?? 15, 15);

  // Only leads that have BOTH knowledge fields populated and haven't been
  // re-enriched yet — the "Website Enriched" flag lets successive batches
  // advance through the full set instead of reprocessing the same records.
  const formula = encodeURIComponent(`AND({Business Knowledge}!="",{Website Knowledge}!="",{Website Enriched}!=1)`);
  const res = await fetch(
    `https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${AIRTABLE_LEADS}?filterByFormula=${formula}&maxRecords=${limit}&fields[]=Business+Name`,
    { headers: { "Authorization": `Bearer ${env.AIRTABLE_TOKEN}` } }
  );
  const data = await res.json();
  if (!res.ok) return { success: false, error: `Airtable fetch failed: ${JSON.stringify(data)}` };

  const records = data.records || [];
  console.log(`Re-enrich batch: ${records.length} leads to process`);

  let processed = 0, failed = 0;
  for (const record of records) {
    try {
      const result = await handleLeadEnrich({ recordId: record.id, forceReenrich: true }, env);
      if (result.success && !result.skipped) {
        // Mark as re-enriched so the next batch moves on to fresh records.
        await airtableUpdate(env, AIRTABLE_LEADS, record.id, { "Website Enriched": true });
        processed++;
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
      console.error("Re-enrich failed for", record.id, err.message);
    }
    await sleep(500);
  }

  return { success: true, processed, failed };
}

// ─── HELPER: CLAUDE — GENERATE LEAD BUSINESS KNOWLEDGE ───────────────────────
async function generateLeadKnowledge(env, { businessName, trade, city, state, address, rating, reviewCount, websiteKnowledge }) {
  const ratingLine = rating ? `${rating} stars (${reviewCount || "unknown"} reviews)` : "not available";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{
        role: "user",
        content: `You are building a business knowledge paragraph for an AI receptionist. Using the structured data AND website content provided, write a single paragraph of plain prose under 200 words. Include: trade, services offered, service area, hours if mentioned, pricing approach if mentioned, quality indicators, address. Write it so the AI receptionist can reference it naturally. No bullets, no headers, no newlines. Return ONLY the paragraph.\n\nStructured Data:\nBusiness Name: ${businessName}\nTrade: ${trade}\nCity: ${city}\nState: ${state}\nAddress: ${address}\nGoogle Rating: ${ratingLine}\n\nWebsite Content:\n${websiteKnowledge || ""}\n\nIf website content is empty, use structured data only. If website content contradicts structured data, prefer structured data.`
      }]
    })
  });

  const claudeData = await res.json();
  return claudeData?.content?.[0]?.text?.trim() || null;
}

// ─── ROUTE 15: CANCEL SUBSCRIPTION (cancellation assistant tool) ─────────────
// Called by the cancelSubscription Vapi tool when the customer confirms cancel.
// Cancels their Stripe subscription at period end, sends confirmation SMS,
// and updates Airtable status to Cancelled.
async function handleCancelSubscription(body, env, ctx) {
  const toolCall = body?.message?.toolCalls?.[0];
  const call     = body?.message?.call;
  let args = toolCall?.function?.arguments ?? body;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { args = {}; }
  }

  const phone  = args.phone || call?.customer?.number || "";
  const reason = args.reason || "Not provided";
  const toolCallId = toolCall?.id || null;

  const ok   = (msg) => toolCallId
    ? { results: [{ toolCallId, result: msg }] }
    : { success: true, message: msg };
  const fail = (msg) => toolCallId
    ? { results: [{ toolCallId, result: msg }] }
    : { success: false, error: msg };

  if (!phone) return fail("Could not identify caller phone number.");

  const normalizedPhone = normalizePhone(phone) || phone;

  // Look up client in Airtable
  const client = await airtableLookup(env, AIRTABLE_CLIENTS, "Phone", normalizedPhone);
  if (!client) return fail("Account not found for this phone number.");

  const stripeCustomerId = client.fields["Stripe Customer ID"];
  if (!stripeCustomerId) return fail("No billing account found for this customer.");

  // Find the active/trialing subscription
  const subsRes = await fetch(
    `https://api.stripe.com/v1/subscriptions?customer=${encodeURIComponent(stripeCustomerId)}&limit=5`,
    { headers: { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}` } }
  );
  const subsData = await subsRes.json();

  if (!subsRes.ok) {
    console.error("Stripe list subscriptions failed:", JSON.stringify(subsData));
    return fail("Could not retrieve subscription. Please contact support.");
  }

  const activeSub = (subsData.data || []).find(s =>
    s.status === "active" || s.status === "trialing"
  );
  if (!activeSub) return fail("No active subscription found for this account.");

  const subId     = activeSub.id;
  const periodEnd = new Date(activeSub.current_period_end * 1000);
  const periodEndStr = periodEnd.toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric"
  });

  // Cancel at period end — no more charges, service stays on until period ends
  const cancelRes = await fetch(
    `https://api.stripe.com/v1/subscriptions/${subId}`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "cancel_at_period_end=true"
    }
  );
  const cancelData = await cancelRes.json();

  if (!cancelRes.ok) {
    console.error("Stripe cancel failed:", JSON.stringify(cancelData));
    return fail("Could not process cancellation. Please contact support.");
  }

  const businessName = client.fields["Business Name"] || "your business";

  // Update Airtable — fire and forget so we don't block the response
  ctx.waitUntil(Promise.all([
    airtableUpdate(env, AIRTABLE_CLIENTS, client.id, {
      "Status": "Cancelled",
      "Cancellation Reason": reason
    }),
    sendSMS(env, normalizedPhone,
      `Your NeverMissLeads subscription has been cancelled. Your service remains active through ${periodEndStr} — no further charges will be made. If you ever want to come back, just give us a call. Thank you for being a customer.`
    )
  ]));

  // Alert Eric
  ctx.waitUntil(sendSMS(env, ERIC_MOBILE,
    `⚠️ Cancellation processed: ${businessName} (${normalizedPhone}). Reason: ${reason}. Active through ${periodEndStr}.`
  ));

  console.log("Subscription cancelled at period end:", subId, "for:", normalizedPhone);
  return ok(`Cancellation confirmed. Service active through ${periodEndStr}. Confirmation text sent to customer.`);
}

// ─── ROUTE 17: CREATE CHECKOUT SESSION (wizard → Stripe hosted card entry) ───
// Builds the subscription price inline from TIERS at request time (no pre-created
// Stripe Dashboard prices needed), bakes in a 7-day trial, and carries the wizard's
// collected answers through as metadata + client_reference_id so handleStripeCheckout
// (the webhook below) can read them back once the customer finishes payment.
async function handleCreateCheckoutSession(body, env) {
  const { tier, billing, businessName, websiteUrl, trade, phone, voice, carrier } = body || {};

  const tierInfo = TIERS[tier];
  if (!tierInfo) {
    return { error: `Unknown tier "${tier}". Must be one of: ${Object.keys(TIERS).join(", ")}` };
  }
  const period = billing === "annual" ? "annual" : "monthly"; // default to monthly on anything else
  const interval = period === "annual" ? "year" : "month";
  const amount = period === "annual" ? tierInfo.annual : tierInfo.monthly;

  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("line_items[0][price_data][currency]", "usd");
  // Stripe auto-generates the checkout header as "Try {this name}" whenever a
  // trial is set — keeping it to just "AI Receptionist" (no brand prefix, no
  // tier/period suffix) matches the cleaner "Try AI Receptionist" style asked
  // for, since the actual tier is already fully conveyed by the price itself.
  params.set("line_items[0][price_data][product_data][name]", "AI Receptionist");
  params.set("line_items[0][price_data][recurring][interval]", interval);
  params.set("line_items[0][price_data][unit_amount]", String(amount * 100));
  params.set("line_items[0][quantity]", "1");
  params.set("subscription_data[trial_period_days]", "7");
  params.set("metadata[tier]", tier);
  params.set("metadata[billing]", period);
  if (businessName) params.set("metadata[business_name]", businessName);
  if (websiteUrl) params.set("metadata[website_url]", websiteUrl);
  if (trade) params.set("metadata[trade]", trade);
  if (VOICES[voice]) params.set("metadata[voice]", voice);
  if (carrier) params.set("metadata[carrier]", carrier);
  if (phone) params.set("client_reference_id", phone);
  params.set("success_url", `${LP_URL}?activated=1&session_id={CHECKOUT_SESSION_ID}`);
  params.set("cancel_url", `${LP_URL}?step=pricing`);

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });
  const data = await res.json();

  if (!res.ok || !data.url) {
    console.error("Stripe create checkout session failed:", JSON.stringify(data));
    return { error: "Could not start checkout. Please try again." };
  }

  return { url: data.url };
}

// ─── Success-page polling: has the checkout webhook finished provisioning a
// forwarding number for this session yet? Looks the session up on Stripe (to
// recover the phone/carrier without needing our own session-id storage), then
// the client record on Airtable by that phone (already indexed there).
async function handleActivationStatus(request, env) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session_id") || "";
  const corsHeaders = { "Access-Control-Allow-Origin": "https://nevermissleadsnow.com", "Content-Type": "application/json" };

  if (!sessionId) {
    return new Response(JSON.stringify({ ready: false, error: "session_id required" }), { status: 400, headers: corsHeaders });
  }

  const sessRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    headers: { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}` }
  });
  const session = await sessRes.json();
  if (!sessRes.ok) {
    return new Response(JSON.stringify({ ready: false, error: "Unknown checkout session" }), { status: 404, headers: corsHeaders });
  }

  const phone = session.client_reference_id || session.customer_details?.phone || "";
  const carrier = session.metadata?.carrier || "";
  // amount_total is in cents (Stripe convention); divide down for the Purchase
  // pixel event fired client-side once this endpoint confirms payment succeeded.
  const amountTotal = typeof session.amount_total === "number" ? session.amount_total / 100 : null;
  const currency = (session.currency || "usd").toUpperCase();
  if (!phone) {
    return new Response(JSON.stringify({ ready: false, carrier, amountTotal, currency }), { headers: corsHeaders });
  }

  const client = await airtableLookup(env, AIRTABLE_CLIENTS, "Phone", phone);
  const forwardingNumber = client?.fields?.["forwarding_number"] || "";

  return new Response(JSON.stringify({
    ready: !!forwardingNumber,
    forwardingNumber,
    carrier,
    found: !!client,
    amountTotal,
    currency
  }), { headers: corsHeaders });
}

// ─── ROUTE 1: STRIPE CHECKOUT ────────────────────────────────────────────────
async function handleStripeCheckout(request, env, ctx) {
  const rawBody = await request.text();

  // Verify Stripe webhook signature
  const signature = request.headers.get("stripe-signature");
  const isValid = await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!isValid) {
    console.error("Invalid Stripe signature — rejecting request");
    return new Response("Unauthorized", { status: 401 });
  }

  const event = JSON.parse(rawBody);

  // Day-7 first real charge → Jordan Call 2 (Google Calendar connect).
  // Stripe delivers invoice.payment_succeeded to this same endpoint; make sure the
  // event is enabled on the Stripe webhook alongside checkout.session.completed.
  if (event.type === "invoice.payment_succeeded") {
    return await handleStripeInvoicePayment(event, env, ctx);
  }

  if (event.type === "customer.subscription.deleted") {
    return await handleStripeSubscriptionDeleted(event, env, ctx);
  }

  // Only process checkout.session.completed
  if (event.type !== "checkout.session.completed") {
    return new Response("OK", { status: 200 });
  }

  const session = event.data.object;
  console.log("Stripe session:", JSON.stringify(session));

  const contractorPhone = session.customer_details?.phone || session.client_reference_id || "";
  const ownerName = session.customer_details?.name || "";
  const ownerEmail = session.customer_details?.email || "";
  const stripeCustomerId = session.customer || "";

  // Extract business name from Stripe custom fields (key: "business_name" or "businessname")
  // Falls back to ownerName if no custom field is present.
  const customFields = session.custom_fields || [];
  const bizField = customFields.find(f =>
    f.key === "business_name" || f.key === "businessname" || f.key === "company"
  );
  const stripeBusinessName = bizField?.text?.value || bizField?.dropdown?.value || "";

  // Wizard-collected data, passed through as Checkout Session metadata by
  // /stripe/create-checkout-session. Older/legacy checkout links have none of this,
  // so everything here is optional and falls back to the pre-wizard behavior below.
  const meta = session.metadata || {};
  const tierInfo = TIERS[meta.tier];
  const tierPrice = tierInfo ? (meta.billing === "annual" ? tierInfo.annual : tierInfo.monthly) : 97;
  const websiteUrl = meta.website_url || "";
  const voiceInfo = VOICES[meta.voice] || null;

  console.log("Contractor phone:", contractorPhone);
  console.log("Owner name:", ownerName);
  console.log("Business name from Stripe custom field:", stripeBusinessName);
  console.log("Tier from wizard metadata:", meta.tier || "(none — legacy link)", "billing:", meta.billing || "n/a", "price:", tierPrice);

  // Idempotency guard — Stripe may retry/redeliver this webhook. If we've already
  // created a Clients record for this Stripe customer, skip before provisioning a
  // (real, billable) Vapi number or creating a duplicate row.
  if (stripeCustomerId) {
    const existing = await airtableLookup(env, AIRTABLE_CLIENTS, "Stripe Customer ID", stripeCustomerId);
    if (existing) {
      console.log("duplicate webhook ignored — client already exists for Stripe customer:", stripeCustomerId, "record:", existing.id);
      return new Response("OK", { status: 200 });
    }
  }

  // Look up existing lead record to get business name, trade, address
  let businessName = "";
  let trade = "";
  let address = "";
  let city = "";
  let state = "";
  let leadRecordId = null;

  if (contractorPhone) {
    const leadLookup = await airtableLookup(env, AIRTABLE_LEADS, "Phone", contractorPhone);
    if (leadLookup) {
      businessName = meta.business_name || leadLookup.fields["Business Name"] || "";
      trade = meta.trade || leadLookup.fields["Trade"] || "";
      address = leadLookup.fields["Address"] || "";
      city = leadLookup.fields["City"] || "";
      state = leadLookup.fields["State"] || "";
      leadRecordId = leadLookup.id;
      console.log("Lead found:", businessName, trade);
    } else {
      console.log("No lead found for phone:", contractorPhone, "— creating lead from Stripe data");
      businessName = meta.business_name || stripeBusinessName || ownerName; // Jordan will confirm on call
      trade = meta.trade || "";
      // Create a Leads record so this web-originated customer is in Airtable
      const newLead = await airtableCreate(env, AIRTABLE_LEADS, {
        "Business Name": businessName,
        "Phone": contractorPhone,
        "Email": ownerEmail,
        "Status": "New",
        "Source": "PPC",
        "Is Mobile": true,
        "Signed Up": true
      });
      leadRecordId = newLead?.id || null;
      console.log("Lead created from Stripe:", contractorPhone, leadRecordId);
    }
  } else {
    businessName = meta.business_name || stripeBusinessName || ownerName;
    trade = meta.trade || "";
    console.log("No phone from Stripe — using name only:", ownerName);
  }

  // Step 1: Provision a Vapi phone number for this client.
  // US/Canada → Vapi's own pool with area-code fallback.
  // International, zero Telnyx KYC requirements → purchase + register automatically.
  // International, KYC required (e.g. IL, GB, AU, IE all require document upload —
  // confirmed live against Telnyx's /v2/requirements) → provisionVapiNumber returns
  // { pending: true } instead of throwing, since retrying via Stripe's webhook retry
  // would never succeed without a human submitting the documents.
  console.log("Provisioning Vapi number for:", contractorPhone);
  const vapiProvision = await provisionVapiNumber(contractorPhone, businessName, ownerName, env);
  const numberPending = !!vapiProvision.pending;
  let vapiNumberId = null;
  let forwardingNumber = "";

  if (!numberPending) {
    vapiNumberId = vapiProvision.id;
    console.log("Vapi number provisioned, ID:", vapiNumberId);

    // Step 2: GET the Vapi number to retrieve actual phone digits
    // Vapi doesn't return the number in the create response — must fetch it
    // Add small delay to ensure number is ready
    await sleep(2000);
    const vapiNumberDetails = await vapiRequest(env, "GET", `/phone-number/${vapiNumberId}`);
    forwardingNumber = vapiNumberDetails.number || "";
    console.log("Vapi number details:", forwardingNumber);
  } else if (vapiProvision.reason === "us_pool_unavailable") {
    console.log("Vapi US free-pool unavailable right now — client record created without a forwarding number.");
  } else {
    console.log(`Number provisioning pending manual KYC for ${vapiProvision.country} — client record created without a forwarding number.`);
  }

  // Step 3: Create Airtable Clients record
  console.log("Creating Airtable client record...");
  const clientFields = {
    "Business Name": businessName,
    "Owner Name": ownerName,
    "Email": ownerEmail,
    "Phone": contractorPhone,
    "Status": "Trial",
    "Subscription Price": tierPrice,
    "Stripe Customer ID": stripeCustomerId,
    "Onboarding Complete": false,
    "Welcome SMS Sent": false,
    "Day5 SMS Sent": false,
    "Address": address
  };
  if (forwardingNumber) clientFields["forwarding_number"] = forwardingNumber;
  if (vapiNumberId) clientFields["Vapi_number_id"] = vapiNumberId;
  const normalizedTrade = normalizeClientsTrade(trade);
  if (normalizedTrade) clientFields["Trade"] = normalizedTrade;
  if (websiteUrl) clientFields["Website"] = websiteUrl;
  // "Subscription Tier" pre-existed with Basic/Standard/Premium options from the old
  // flat-price era; typecast:true lets Airtable add Starter/Growth/Pro as new options
  // instead of rejecting the whole record for an unrecognized single-select value.
  // (No "Billing Period"/"Plan" field exists in this base — verified against the live
  // schema before writing this — so billing period isn't duplicated into Airtable;
  // it's still visible on the Stripe subscription itself via metadata.billing.)
  if (tierInfo) clientFields["Subscription Tier"] = tierInfo.name;
  if (voiceInfo) clientFields["Voice"] = meta.voice; // asteria/luna/athena/orion — used by client-lookup worker to apply voice override on inbound calls

  // The "Voice" field write above assumes it exists in the live Airtable schema.
  // If it doesn't (UNKNOWN_FIELD_NAME), Airtable rejects the ENTIRE record — not
  // just that field — which was silently blocking every signup's client record
  // from being created at all. Retry once without it so the critical path (client
  // record → SMS, onboarding call, phone provisioning) never depends on an optional
  // field that may or may not exist. Alerts Eric so the field gets added properly
  // instead of this fallback silently masking it forever.
  let clientRecord;
  try {
    clientRecord = await airtableCreate(env, AIRTABLE_CLIENTS, clientFields, { typecast: true });
  } catch (err) {
    if (voiceInfo && /UNKNOWN_FIELD_NAME/.test(err.message) && /"Voice"/.test(err.message)) {
      console.error("Airtable 'Voice' field missing — retrying without it:", err.message);
      const { Voice, ...fieldsWithoutVoice } = clientFields;
      clientRecord = await airtableCreate(env, AIRTABLE_CLIENTS, fieldsWithoutVoice, { typecast: true });
      ctx.waitUntil(sendSMS(env, ERIC_MOBILE,
        `⚠️ Airtable is missing the "Voice" field on the Clients table — client record for ${businessName || ownerEmail} was created WITHOUT voice override support. Add a "Voice" single-line-text field to Clients to fix this permanently.`
      ));
    } else {
      throw err;
    }
  }
  console.log("Client record created:", clientRecord.id);

  // Step 4a: Fire Meta Conversions API Purchase event. event_id = Stripe session.id
  // so it matches the client-side pixel Purchase event fired on the ?activated=1
  // success page (same session_id passed there) — Meta dedupes on matching
  // event_id + event_name, so this must be identical on both sides or the same
  // sale gets double-counted (once from CAPI, once from the browser pixel).
  ctx.waitUntil(sendMetaPurchaseEvent(env, contractorPhone, ownerEmail, tierPrice, session.id));

  // Step 4: Update lead record to mark as Signed Up (if we found one)
  if (leadRecordId) {
    ctx.waitUntil(airtableUpdate(env, AIRTABLE_LEADS, leadRecordId, {
      "Signed Up": true
    }));
  }

  // Step 5: Trigger Jordan outbound onboarding call — skipped when the number is
  // still pending manual KYC, since Jordan's whole job is walking the customer
  // through forwarding calls to a number that doesn't exist yet. Eric follows up
  // personally once the number is ready instead.
  if (!numberPending && contractorPhone) {
    console.log("Triggering Jordan call to:", contractorPhone);
    ctx.waitUntil(vapiRequest(env, "POST", "/call/phone", {
      assistantId: JORDAN_ASSISTANT_ID,
      phoneNumberId: JORDAN_PHONE_ID,
      customer: { number: contractorPhone },
      assistantOverrides: {
        variableValues: {
          ownerName: ownerName,
          businessName: businessName,
          trade: trade,
          address: address,
          forwardingNumber: forwardingNumber,
          websiteUrl: websiteUrl,
          voiceName: voiceInfo ? voiceInfo.name : ""
        }
      }
    }));
  }

  // Notify Eric about new signup
  const tierLabel = tierInfo ? `${tierInfo.name} (${meta.billing === "annual" ? "Annual" : "Monthly"}, $${tierPrice})` : `$${tierPrice}/mo`;
  const ericMessage = !numberPending
    ? `🎉 New signup! ${businessName || ownerEmail} - ${trade} in ${city}, ${state}. Plan: ${tierLabel}. Phone: ${contractorPhone}. Jordan is calling them now.`
    : vapiProvision.reason === "us_pool_unavailable"
      ? `⚠️ MANUAL SETUP NEEDED: ${businessName || ownerEmail} - ${trade} signed up, paid, and is waiting. Vapi's free US number pool is unavailable right now (checked live, not code bug) — swept dozens of area codes, all failed. Plan: ${tierLabel}. Phone: ${contractorPhone}. Assign a number manually in Vapi's dashboard once the pool frees up, or via Telnyx import, then call them yourself — Jordan's call was skipped.`
      : `⚠️ MANUAL SETUP NEEDED: ${businessName || ownerEmail} - ${trade} signed up from ${vapiProvision.country}. Telnyx requires KYC documents for this country — can't auto-provision a number. Plan: ${tierLabel}. Phone: ${contractorPhone}. Handle in Telnyx/Vapi, then call them yourself — Jordan's call was skipped.`;
  ctx.waitUntil(sendSMS(env, ERIC_MOBILE, ericMessage));

  // Step 6: Send welcome SMS, then a second SMS with the setup link
  console.log("Sending welcome SMS to:", contractorPhone);
  if (contractorPhone) {
    // 6a: Welcome message — different wording when the number needs manual setup
    const welcomeMessage = !numberPending
      ? "Welcome to NeverMissLeads! Your AI receptionist is being set up now. Jordan will call you shortly to get everything configured. (Check spam if you don't see Jordan's setup text in a few seconds.) Questions? Reply or email eric@nevermissleadsnow.com"
      : vapiProvision.reason === "us_pool_unavailable"
        ? "Welcome to NeverMissLeads! We're putting the finishing touches on your dedicated phone number right now — Eric will personally reach out within 1 business day to get you live. Questions? Reply or email eric@nevermissleadsnow.com"
        : "Welcome to NeverMissLeads! Your business is in a country that requires extra verification for local phone numbers, so we're finishing that setup by hand — Eric will personally reach out within 1-2 business days to get you live. Questions? Reply or email eric@nevermissleadsnow.com";
    ctx.waitUntil(sendSMS(env, contractorPhone,
      welcomeMessage
    ));

    // 6b: Call-forwarding activation link — carrier comes from the wizard's
    // Call Forwarding step (metadata.carrier) when the customer picked one there;
    // the /setup page falls back to a carrier picker if it's missing.
    if (forwardingNumber) {
      const n = forwardingNumber.replace("+", "");
      const carrierParam = meta.carrier ? `&c=${encodeURIComponent(meta.carrier)}` : "";
      ctx.waitUntil(sendSMS(env, contractorPhone,
        `Your AI receptionist is ready! Tap this link to activate call forwarding: https://nevermissleadsnow.com/setup?n=${n}${carrierParam}`
      ));
    } else {
      console.warn("No forwardingNumber — skipping setup link SMS for:", contractorPhone);
    }
  }

  console.log("S1 onboarding complete for:", businessName);
  return new Response("OK", { status: 200 });
}

// ─── STRIPE invoice.payment_succeeded → JORDAN CALL 2 (Day-7 calendar connect) ─
// Fires on the first real charge after the 7-day trial. If the client hasn't yet
// connected their Google Calendar, Jordan calls them to send a one-tap connect link.
async function handleStripeInvoicePayment(event, env, ctx) {
  const invoice = event.data.object;
  console.log("Stripe invoice.payment_succeeded:", invoice.id, "amount_paid:", invoice.amount_paid);

  // Skip the $0 trial-start invoice — only act on the first real charge.
  if (!(invoice.amount_paid > 0)) {
    console.log("amount_paid is 0 (trial start) — no Call 2.");
    return new Response("OK", { status: 200 });
  }

  // Find the client by Stripe customer id (stored at checkout); fall back to email
  // for clients created before that field existed.
  const stripeCustomerId = invoice.customer || "";
  let client = null;
  if (stripeCustomerId) {
    client = await airtableLookup(env, AIRTABLE_CLIENTS, "Stripe Customer ID", stripeCustomerId);
  }
  if (!client && invoice.customer_email) {
    client = await airtableLookup(env, AIRTABLE_CLIENTS, "Email", invoice.customer_email);
  }
  if (!client) {
    console.warn("No client found for Stripe customer:", stripeCustomerId, invoice.customer_email);
    return new Response("OK", { status: 200 });
  }

  // Already connected? Nothing to do.
  if (client.fields["Calendar Connected"] === true) {
    console.log("Calendar already connected for client:", client.id, "— skipping Call 2.");
    return new Response("OK", { status: 200 });
  }

  const ownerName    = client.fields["Owner Name"] || "";
  const businessName = client.fields["Business Name"] || "";
  const phone        = client.fields["Phone"] || "";

  // Notify Eric about new payment
  ctx.waitUntil(sendSMS(env, ERIC_MOBILE,
    `💰 New payment! ${businessName || invoice.customer_email || stripeCustomerId} charged $197. Jordan is calling to connect their Google Calendar.`
  ));

  if (!phone) {
    console.warn("Client has no phone — cannot place Call 2:", client.id);
    return new Response("OK", { status: 200 });
  }

  const calendarConnectLink =
    `https://nmln-automation.eric-04b.workers.dev/calendar/connect?clientRecordId=${client.id}`;

  console.log("Triggering Jordan Call 2 to:", phone, "client:", client.id);
  ctx.waitUntil(vapiRequest(env, "POST", "/call/phone", {
    assistantId: JORDAN_ASSISTANT_ID,
    phoneNumberId: JORDAN_PHONE_ID,
    customer: { number: phone },
    assistantOverrides: {
      firstMessage: `Hey ${ownerName || "there"}! It's Jordan from NeverMissLeadsNow — great news, your trial's complete and your card was charged, so you're officially a full member. I've got one quick thing that'll make your receptionist even more powerful — got about thirty seconds?`,
      variableValues: {
        ownerName: ownerName,
        businessName: businessName,
        calendarConnectLink: calendarConnectLink
      }
    }
  }));

  return new Response("OK", { status: 200 });
}

// ─── STRIPE customer.subscription.deleted → ERIC CANCELLATION ALERT ──────────
async function handleStripeSubscriptionDeleted(event, env, ctx) {
  const subscription = event.data.object;
  const stripeCustomerId = subscription.customer || "";
  console.log("customer.subscription.deleted:", stripeCustomerId);

  let businessName = "";
  let customerEmail = "";

  if (stripeCustomerId) {
    const client = await airtableLookup(env, AIRTABLE_CLIENTS, "Stripe Customer ID", stripeCustomerId);
    if (client) {
      businessName = client.fields["Business Name"] || "";
      customerEmail = client.fields["Email"] || "";
    }
  }

  const displayName = businessName || customerEmail || stripeCustomerId;
  ctx.waitUntil(sendSMS(env, ERIC_MOBILE,
    `⚠️ Cancellation: ${displayName} just cancelled their subscription.`
  ));

  return new Response("OK", { status: 200 });
}

// ─── ROUTE 2: VAPI ONBOARDING COMPLETE ───────────────────────────────────────
async function handleOnboardingComplete(request, env, ctx) {
  const body = await request.json();

  const messageType = body?.message?.type;
  if (messageType !== "end-of-call-report") {
    return new Response("OK", { status: 200 });
  }

  const transcript = body?.message?.artifact?.transcript;
  const callerNumber = body?.message?.call?.customer?.number;
  const endedReason = body?.message?.call?.endedReason || "";

  console.log("Onboarding call ended for:", callerNumber, "endedReason:", endedReason);
  console.log("Transcript length:", transcript?.length);

  // If Jordan's onboarding call went unanswered / to voicemail, text the customer
  // a callback number so they can call in and finish setup on their own time.
  // (Inbound on JORDAN_CALLBACK_NUMBER must be routed to the Jordan assistant —
  // see GET /admin/set-jordan-inbound.)
  const NO_ANSWER_REASONS = [
    "customer-did-not-answer",
    "customer-busy",
    "voicemail",
    "twilio-failed-to-connect-call",
    "phone-call-provider-closed-websocket",
    "silence-timed-out"
  ];
  if (callerNumber && (NO_ANSWER_REASONS.includes(endedReason) || !transcript)) {
    // Only text the customer on the FIRST missed call. Subsequent retries are placed
    // by the cron; the customer already has the callback number from the first text.
    const alreadyEnrolled = env.ONBOARDING_RETRY
      ? !!(await env.ONBOARDING_RETRY.get(`retry:${callerNumber}`))
      : false;
    if (!alreadyEnrolled) {
      console.log("First no-answer — texting callback link to:", callerNumber);
      const prettyNumber = JORDAN_CALLBACK_NUMBER.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3");
      ctx.waitUntil(sendSMS(env, callerNumber,
        `Hi! This is NeverMissLeads — sorry we missed you just now. When you have ~5 min, call ${prettyNumber} and Jordan will finish setting up your AI receptionist. Or reply here with a good time and we'll call you back.`
      ));
    } else {
      console.log("Retry no-answer — callback SMS already sent, skipping duplicate for:", callerNumber);
    }
    // Enroll the client in the recall schedule (2×/day for 2 days) if not already.
    // The cron (processOnboardingRetries) owns subsequent call scheduling & give-up.
    const client = await airtableLookup(env, AIRTABLE_CLIENTS, "Phone", callerNumber);
    if (client) {
      ctx.waitUntil(enrollOnboardingRetry(env, client));
    } else {
      console.log("No client record to enroll for onboarding retry:", callerNumber);
    }
    return new Response("OK", { status: 200 });
  }

  if (!transcript || !callerNumber) {
    console.log("Missing transcript or caller number — skipping knowledge capture");
    return new Response("OK", { status: 200 });
  }

  // Process knowledge capture in background — don't hold up the response
  ctx.waitUntil(captureBusinessKnowledge(transcript, callerNumber, env));

  return new Response("OK", { status: 200 });
}

async function captureBusinessKnowledge(transcript, callerNumber, env) {
  try {
    console.log("Capturing business knowledge for:", callerNumber);

    // Call Claude API to extract business knowledge from transcript
    const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system: "Extract all business information from this onboarding call transcript and write it as a single flowing paragraph a receptionist can use. Include trade, services, hours, service area, pricing, selling points, specials, what they do not do, and any other instructions. Plain prose only, no bullets, no headers, no newlines, no line breaks. Return only the paragraph, nothing else.",
        messages: [{
          role: "user",
          content: `Extract business knowledge from this transcript:\n\n${transcript}`
        }]
      })
    });

    const claudeData = await claudeResponse.json();
    const knowledge = claudeData?.content?.[0]?.text;

    if (!knowledge) {
      console.error("Claude returned no knowledge:", JSON.stringify(claudeData));
      return;
    }

    console.log("Knowledge extracted, length:", knowledge.length);

    // Find the client record by phone number
    const clientRecord = await airtableLookup(env, AIRTABLE_CLIENTS, "Phone", callerNumber);
    if (!clientRecord) {
      console.error("No client record found for:", callerNumber);
      return;
    }

    // Update client record with business knowledge
    await airtableUpdate(env, AIRTABLE_CLIENTS, clientRecord.id, {
      "Business Knowledge": knowledge,
      "Onboarding Complete": true
    });

    console.log("Business knowledge saved for:", callerNumber);

    // Onboarding done — cancel any pending recall schedule for this client.
    if (env.ONBOARDING_RETRY) {
      await env.ONBOARDING_RETRY.delete(`retry:${callerNumber}`);
    }

    // Post-onboarding confirmation SMS — sent only after Onboarding Complete is set.
    await sendSMS(env, callerNumber,
      "🎉 Your AI receptionist is now live! Test it by calling your business number and not picking up — your AI will answer. You'll get a text after every missed call with the caller's info. Questions? Email eric@nevermissleadsnow.com — welcome to NeverMissLeads!"
    );
    console.log("Post-onboarding confirmation SMS sent to:", callerNumber);

  } catch (err) {
    console.error("Knowledge capture error:", err.message);
  }
}

// ─── ONBOARDING RECALL / DUNNING ──────────────────────────────────────────────
// When a client misses Jordan's onboarding call they're enrolled here; the 2-min
// cron then re-calls them at the next daily slot (ONBOARDING_SLOTS_UTC), up to
// ONBOARDING_MAX_ATTEMPTS times over 2 days. The text-on-no-answer is sent by
// handleOnboardingComplete; this owns the call cadence and the give-up alert.

// Next daily attempt slot strictly after `from` (UTC hours in ONBOARDING_SLOTS_UTC).
function nextOnboardingSlot(from) {
  for (let dayOffset = 0; dayOffset <= 4; dayOffset++) {
    for (const hour of ONBOARDING_SLOTS_UTC) {
      const slot = new Date(Date.UTC(
        from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + dayOffset, hour, 0, 0, 0
      ));
      if (slot.getTime() > from.getTime()) return slot;
    }
  }
  return new Date(from.getTime() + 12 * 3600 * 1000); // unreachable fallback
}

// Enroll a client in the recall schedule (idempotent — cron owns the entry once created).
async function enrollOnboardingRetry(env, client) {
  if (!env.ONBOARDING_RETRY) return;
  const phone = client.fields["Phone"] || "";
  if (!phone) return;
  const key = `retry:${phone}`;
  if (await env.ONBOARDING_RETRY.get(key)) return; // already scheduled — don't reset attempts
  const now = new Date();
  const entry = {
    phone,
    clientRecordId: client.id,
    businessName: client.fields["Business Name"] || "",
    ownerName: client.fields["Owner Name"] || "",
    trade: client.fields["Trade"] || "",
    address: client.fields["Address"] || "",
    forwardingNumber: client.fields["forwarding_number"] || "",
    attempts: 0,
    nextAttemptAt: nextOnboardingSlot(now).toISOString(),
    createdAt: now.toISOString()
  };
  await env.ONBOARDING_RETRY.put(key, JSON.stringify(entry), { expirationTtl: 3 * 24 * 3600 });
  console.log("Enrolled in onboarding recall:", phone, "first retry:", entry.nextAttemptAt);
}

// Cron-driven: place due recall calls, alert Eric when a client exhausts all attempts.
async function processOnboardingRetries(env) {
  if (!env.ONBOARDING_RETRY) return { skipped: "no KV binding" };
  const now = new Date();
  const list = await env.ONBOARDING_RETRY.list({ prefix: "retry:" });
  let placed = 0, gaveUp = 0, done = 0, pending = 0;

  for (const k of list.keys) {
    const raw = await env.ONBOARDING_RETRY.get(k.name);
    if (!raw) continue;
    let e;
    try { e = JSON.parse(raw); } catch { await env.ONBOARDING_RETRY.delete(k.name); continue; }

    if (new Date(e.nextAttemptAt).getTime() > now.getTime()) { pending++; continue; }

    // Source-of-truth re-check: stop if they've onboarded or cancelled since enrolling.
    const client = await airtableLookup(env, AIRTABLE_CLIENTS, "Phone", e.phone);
    if (!client) { await env.ONBOARDING_RETRY.delete(k.name); continue; }
    const complete  = client.fields["Onboarding Complete"] === true;
    const cancelled = String(client.fields["Status"] || "").toLowerCase() === "cancelled";
    if (complete || cancelled) { await env.ONBOARDING_RETRY.delete(k.name); done++; continue; }

    // All attempts used and still not onboarded → alert Eric and give up.
    if (e.attempts >= ONBOARDING_MAX_ATTEMPTS) {
      await sendSMS(env, ERIC_MOBILE,
        `⚠️ Onboarding FAILED: ${e.businessName || e.phone} (${e.phone}) did not complete onboarding after ${ONBOARDING_MAX_ATTEMPTS} recall attempts over 2 days. Manual follow-up needed.`
      );
      await env.ONBOARDING_RETRY.delete(k.name);
      gaveUp++;
      continue;
    }

    // Place the next Jordan onboarding call (text-on-no-answer handled by webhook).
    // Build call variables from the fresh Airtable record so they're always current
    // (and so seeding a retry only requires the client's phone).
    e.attempts += 1;
    await vapiRequest(env, "POST", "/call/phone", {
      assistantId: JORDAN_ASSISTANT_ID,
      phoneNumberId: JORDAN_PHONE_ID,
      customer: { number: e.phone },
      assistantOverrides: {
        variableValues: {
          ownerName: client.fields["Owner Name"] || "",
          businessName: client.fields["Business Name"] || "",
          trade: client.fields["Trade"] || "",
          address: client.fields["Address"] || "",
          forwardingNumber: client.fields["forwarding_number"] || ""
        }
      }
    });
    e.nextAttemptAt = nextOnboardingSlot(now).toISOString();
    await env.ONBOARDING_RETRY.put(k.name, JSON.stringify(e), { expirationTtl: 3 * 24 * 3600 });
    placed++;
    console.log(`Onboarding recall ${e.attempts}/${ONBOARDING_MAX_ATTEMPTS} placed for ${e.phone}; next ${e.nextAttemptAt}`);
  }

  return { total: list.keys.length, placed, gaveUp, done, pending };
}

// ─── ROUTE 11: JORDAN sendSetupLink TOOL ──────────────────────────────────────
// Called mid-call by Jordan (Vapi function tool) the moment the contractor names
// their carrier. Texts them the one-tap call-forwarding setup link via Telnyx.
// Accepts either a Vapi tool-call envelope or a direct { phone, forwardingNumber,
// carrier } JSON body (for testing). Returns the Vapi tool-result shape when
// invoked as a tool, or a plain JSON result when called directly.
async function handleSendSetupLink(request, env, ctx) {
  const body = await request.json();

  // Vapi wraps tool calls in message.toolCalls; pull args + call context from there.
  const toolCall = body?.message?.toolCalls?.[0];
  const call     = body?.message?.call;
  let args = toolCall?.function?.arguments ?? body;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { args = {}; }
  }

  // Prefer model-supplied args; fall back to the live call context when missing.
  const phone =
    args.phone ||
    call?.customer?.number ||
    "";
  const forwardingNumber =
    args.forwardingNumber ||
    call?.assistantOverrides?.variableValues?.forwardingNumber ||
    "";
  const carrier = (args.carrier || "").toString().trim();

  const ok = (resultText) => {
    if (toolCall) {
      // Vapi tool-result shape
      return Response.json({ results: [{ toolCallId: toolCall.id, result: resultText }] });
    }
    return Response.json({ success: true, to: phone, message: resultText });
  };
  const fail = (errText) => {
    if (toolCall) {
      return Response.json({ results: [{ toolCallId: toolCall.id, result: errText }] });
    }
    return new Response(JSON.stringify({ success: false, error: errText }), {
      status: 400, headers: { "Content-Type": "application/json" }
    });
  };

  if (!phone || !forwardingNumber) {
    return fail("phone and forwardingNumber are required");
  }

  const n = String(forwardingNumber).replace("+", "");
  const c = encodeURIComponent(carrier);
  const link = `https://nevermissleadsnow.com/setup?n=${n}&c=${c}`;
  const text = `Tap your carrier button to activate call forwarding in one tap: ${link}`;

  const smsData = await sendSMS(env, phone, text);
  if (smsData?.errors) {
    console.error("sendSetupLink SMS failed:", JSON.stringify(smsData));
    return fail("Could not send the setup link text — support will follow up.");
  }

  console.log("Setup link texted to:", phone, "carrier:", carrier);
  return ok(`Setup link texted to ${phone}. Have them tap it, then tap their carrier button.`);
}

// ─── ROUTE 13: JORDAN sendCalendarLink TOOL ───────────────────────────────────
// Called mid-call by Jordan (Vapi function tool) on the Day-7 Call 2. Texts the
// contractor their one-tap Google Calendar connect link via Telnyx. Accepts either
// a Vapi tool-call envelope or a direct { phone, calendarConnectLink } JSON body.
async function handleSendCalendarLink(request, env, ctx) {
  const body = await request.json();

  // Vapi wraps tool calls in message.toolCalls; pull args + call context from there.
  const toolCall = body?.message?.toolCalls?.[0];
  const call     = body?.message?.call;
  let args = toolCall?.function?.arguments ?? body;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { args = {}; }
  }

  // Prefer model-supplied args; fall back to the live call context when missing.
  const phone =
    args.phone ||
    call?.customer?.number ||
    "";
  const calendarConnectLink =
    args.calendarConnectLink ||
    call?.assistantOverrides?.variableValues?.calendarConnectLink ||
    "";

  const ok = (resultText) => {
    if (toolCall) {
      return Response.json({ results: [{ toolCallId: toolCall.id, result: resultText }] });
    }
    return Response.json({ success: true, to: phone, message: resultText });
  };
  const fail = (errText) => {
    if (toolCall) {
      return Response.json({ results: [{ toolCallId: toolCall.id, result: errText }] });
    }
    return new Response(JSON.stringify({ success: false, error: errText }), {
      status: 400, headers: { "Content-Type": "application/json" }
    });
  };

  if (!phone || !calendarConnectLink) {
    return fail("phone and calendarConnectLink are required");
  }

  const text = `Tap here to connect your Google Calendar to your AI receptionist — takes 10 seconds: ${calendarConnectLink}`;

  const smsData = await sendSMS(env, phone, text);
  if (smsData?.errors) {
    console.error("sendCalendarLink SMS failed:", JSON.stringify(smsData));
    return fail("Could not send the calendar link text — support will follow up.");
  }

  console.log("Calendar link texted to:", phone);
  return ok(`Calendar connect link texted to ${phone}. Have them tap it and sign in with Google.`);
}

// ─── ROUTE 7: VAPI CALL COMPLETE (production receptionist → owner SMS) ────────
async function handleVapiCallComplete(request, env, ctx) {
  const body = await request.json();
  const message = body?.message || {};

  // Only act on the end-of-call report; ack everything else immediately.
  if (message.type !== "end-of-call-report") {
    return new Response("OK", { status: 200 });
  }

  const callerPhone     = message?.call?.customer?.number || "";
  const receivingNumber = message?.call?.phoneNumber?.number || "";
  const transcript      = message?.artifact?.transcript || "";
  const endedReason     = message?.call?.endedReason || "";
  // Vapi may surface a successful calendar booking flag on the payload.
  const calendarBooked  = message?.calendarBooked === true || body?.calendarBooked === true;

  console.log("Call complete:", JSON.stringify({ receivingNumber, callerPhone, endedReason }));

  // Look up the client by their forwarding (receptionist) number.
  const client = await airtableLookup(env, AIRTABLE_CLIENTS, "forwarding_number", receivingNumber);
  if (!client) {
    console.log("Unknown number:", receivingNumber);
    return new Response("OK", { status: 200 });
  }

  const ownerMobile       = client.fields["Owner Mobile"] || client.fields["Phone"] || "";
  const businessName      = client.fields["Business Name"] || "your business";
  const recordId          = client.id;
  const calendarConnected = client.fields["Calendar Connected"] === true;

  // Extract structured call details from the transcript via Claude.
  const details = await extractCallDetails(env, transcript);

  // Build the owner SMS based on calendar/booking status.
  const smsText = buildCallSummarySms({ businessName, details, calendarConnected, calendarBooked });

  // Fire-and-forget — return 200 immediately, don't block on SMS or Airtable.
  if (ownerMobile) {
    ctx.waitUntil(sendSMS(env, ownerMobile, smsText));
  } else {
    console.log("No owner mobile on client:", recordId, "— skipping SMS");
  }

  ctx.waitUntil(airtableUpdate(env, AIRTABLE_CLIENTS, recordId, {
    "Last Call Date": new Date().toISOString().split("T")[0],
    "Last Caller Name": details.callerName,
    "Last Service Request": details.serviceNeeded
  }));

  return new Response("OK", { status: 200 });
}

// ─── HELPER: CLAUDE — EXTRACT CALL DETAILS FROM TRANSCRIPT ───────────────────
async function extractCallDetails(env, transcript) {
  const fallback = {
    callerName: "Unknown",
    callerPhone: "Unknown",
    serviceAddress: "Not provided",
    serviceNeeded: "See transcript",
    urgency: "Normal",
    appointmentTime: "Flexible",
    notes: ""
  };
  if (!transcript) return fallback;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{
          role: "user",
          content: `Extract caller details from this receptionist call transcript. Return ONLY valid JSON with exactly these fields:\n{\n  callerName: full name or Unknown,\n  callerPhone: phone number they gave or Unknown,\n  serviceAddress: address mentioned or Not provided,\n  serviceNeeded: what they need done in plain language,\n  urgency: Emergency or Urgent or Normal,\n  appointmentTime: requested time or Flexible,\n  notes: any other important details or empty string\n}\nNo preamble. No explanation. JSON only.\nTranscript: ${transcript}`
        }]
      })
    });

    const data = await res.json();
    const text = (data?.content?.[0]?.text || "").trim();
    // Strip any code fences, then grab the first JSON object.
    const stripped = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const match = stripped.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : stripped);
    return { ...fallback, ...parsed };
  } catch (err) {
    console.error("extractCallDetails parse failed:", err.message);
    return fallback;
  }
}

// ─── HELPER: BUILD OWNER CALL-SUMMARY SMS ────────────────────────────────────
function buildCallSummarySms({ businessName, details, calendarConnected, calendarBooked }) {
  const { callerName, callerPhone, serviceAddress, serviceNeeded, urgency, appointmentTime, notes } = details;

  if (calendarConnected && calendarBooked) {
    return `📞 Appointment confirmed for ${businessName}!\n` +
      `Client: ${callerName}\n` +
      `Phone: ${callerPhone}\n` +
      `Address: ${serviceAddress}\n` +
      `Service: ${serviceNeeded}\n` +
      `Time: ${appointmentTime}\n` +
      `Notes: ${notes}\n` +
      `✅ Added to your calendar.`;
  }

  if (calendarConnected && !calendarBooked) {
    return `📞 New lead for ${businessName}!\n` +
      `Client: ${callerName}\n` +
      `Phone: ${callerPhone}\n` +
      `Address: ${serviceAddress}\n` +
      `Service: ${serviceNeeded}\n` +
      `Time: ${appointmentTime}\n` +
      `Notes: ${notes}\n` +
      `⚠️ Appointment failed to sync to calendar — add manually.`;
  }

  // Standard — no calendar connected.
  return `📞 New lead for ${businessName}!\n` +
    `Client: ${callerName}\n` +
    `Phone: ${callerPhone}\n` +
    `Address: ${serviceAddress}\n` +
    `Service: ${serviceNeeded}\n` +
    `Urgency: ${urgency}\n` +
    `Requested time: ${appointmentTime}\n` +
    `Notes: ${notes}\n` +
    `⚠️ Please call to confirm appointment.`;
}

// ─── ROUTE 3: LEAD CREATE (SEO/PPC form) ─────────────────────────────────────
async function handleLeadCreate(body, env) {
  const { businessName, phone, trade } = body;

  if (!businessName || !phone) {
    return { success: false, error: "Business name and phone are required" };
  }

  // Normalize phone to E.164
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    return { success: false, error: "Invalid phone number" };
  }

  // Check if lead already exists
  const existing = await airtableLookup(env, AIRTABLE_LEADS, "Phone", normalizedPhone);
  if (existing) {
    console.log("Lead already exists:", normalizedPhone);
    return { success: true, existing: true };
  }

  // Create new lead record — normalize trade to match Airtable Leads select options
  const sourceValue = (body.source || "").toLowerCase() === "ppc" ? "PPC" : "Website";
  const fields = {
    "Business Name": businessName,
    "Phone": normalizedPhone,
    "Status": "New",
    "Source": sourceValue,
    "Is Mobile": true
  };
  const normalizedTrade = normalizeLeadsTrade(trade);
  if (normalizedTrade) fields["Trade"] = normalizedTrade;

  await airtableCreate(env, AIRTABLE_LEADS, fields);

  console.log("Lead created:", businessName, normalizedPhone);
  return { success: true };
}

// ─── HELPER: STRIPE SIGNATURE VERIFICATION ───────────────────────────────────
async function verifyStripeSignature(payload, signature, secret) {
  try {
    if (!signature || !secret) return false;

    const parts = signature.split(",");
    const timestamp = parts.find(p => p.startsWith("t="))?.split("=")[1];
    const v1 = parts.find(p => p.startsWith("v1="))?.split("=")[1];

    if (!timestamp || !v1) return false;

    // Reject webhooks older than 300 seconds to prevent replay attacks
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

    const signedPayload = `${timestamp}.${payload}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));
    const computed = Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    // Constant-time comparison to prevent timing attacks
    if (computed.length !== v1.length) return false;
    let diff = 0;
    for (let i = 0; i < computed.length; i++) {
      diff |= computed.charCodeAt(i) ^ v1.charCodeAt(i);
    }
    return diff === 0;

  } catch (err) {
    console.error("Signature verification error:", err.message);
    return false;
  }
}

// ─── HELPER: lightweight live website scrape for demo-call personalization ────
// Separate from the Apify/Airtable "Website Knowledge" batch-enrichment pipeline
// (generateLeadKnowledge/websiteKnowledge above) — that one assumes content was
// already scraped ahead of time for imported leads. This one has to run inline,
// in the couple of seconds before the demo call is placed, for whatever URL a
// visitor just typed into the wizard. Uses HTMLRewriter (built into Workers) to
// pull title/meta description/headings/paragraph text — deliberately skips a
// broad "grab everything in body" selector so script/style/nav noise never
// makes it into what Alex is told about the business.
async function scrapeWebsite(rawUrl) {
  let url;
  try {
    const withScheme = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    url = new URL(withScheme);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "0.0.0.0" || /^(10|127)\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) || /^192\.168\./.test(host)) {
    return null; // not a real public business site
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; NeverMissLeadsBot/1.0)" }
    });
    clearTimeout(timeout);
    if (!res.ok) return null;

    let title = "";
    let description = "";
    let bodyText = "";
    const rewriter = new HTMLRewriter()
      .on("title", { text(t) { title += t.text; } })
      .on('meta[name="description"]', { element(el) { description = el.getAttribute("content") || ""; } })
      .on('meta[property="og:description"]', { element(el) { if (!description) description = el.getAttribute("content") || ""; } })
      .on("h1, h2, h3, p", { text(t) { if (bodyText.length < 1500) bodyText += t.text + " "; } });

    await rewriter.transform(res).text(); // drives the streaming parse to completion

    title = title.trim();
    description = description.trim();
    bodyText = bodyText.replace(/\s+/g, " ").trim().slice(0, 1200);

    if (!title && !description && !bodyText) return null;
    return { title, description, bodyText };
  } catch (err) {
    console.warn("scrapeWebsite failed for", rawUrl, "-", err.message);
    return null;
  }
}

// Builds the demo call's system prompt: the base assistant (Vapi id
// DEMO_ASSISTANT_ID) ships with a generic version of this same text baked in
// ("There is NO business name available...") for callers who skip straight to
// the demo without going through the wizard. When we DO have a business name
// (and optionally scraped site content), this override replaces that one
// clause so Alex naturally references the real business instead — everything
// else (persona, goal, guardrails) stays identical to the base assistant.
function buildDemoSystemPrompt({ businessName, trade, siteInfo }) {
  const base = "Your name is Alex. You are a real person. You have a knowledge base attached — use it as your complete reference for this conversation. ";
  let context;
  if (businessName) {
    const tradeClause = trade ? ` in the ${trade} trade` : "";
    context = `This is a live demo for "${businessName}"${tradeClause}, started when the owner tapped a button on our landing page. Naturally reference their business by name ("${businessName}") once or twice early in the call, the way a real receptionist answering for them would — don't overuse it or sound like you're reading a form. `;
    if (siteInfo && (siteInfo.title || siteInfo.description || siteInfo.bodyText)) {
      const summary = [siteInfo.title, siteInfo.description, siteInfo.bodyText].filter(Boolean).join(" — ").slice(0, 900);
      context += `Here's what we found on their website — use it naturally if it's relevant (e.g. services they offer), but don't recite it or sound scripted: ${summary} `;
    }
  } else {
    context = "This is a live demo a contractor started by tapping a button on our landing page. There is NO business name available, so never reference a specific business name and never use the placeholder {{businessName}} — speak generically about 'your business' and 'your customers'. ";
  }
  const tail = "Open by introducing yourself as their AI receptionist and explain that what they're hearing is exactly what their own customers will experience when they can't pick up. Have a real, warm, confident conversation — no script. Your only goal is to get them to click the Activate button on their screen to start the free 7-day trial. Never say you are an AI. If asked your name, say Alex. If asked who you work for, say 'I'm with the service you just tried.' Pull from the knowledge base for every objection, question, and selling point.";
  return base + context + tail;
}

// ─── HELPER: VAPI API ─────────────────────────────────────────────────────────
// ─── ROUTE 16: LANDING-PAGE "CALL ME" LIVE DEMO ───────────────────────────────
// A visitor taps "Test the AI assistant" on lp.html and enters their mobile
// number; Alex (the Demo Receptionist) places an outbound call to them live.
// Caller ID is JORDAN_PHONE_ID (Twilio) — it is outbound-reliable; the free
// vapi-provider numbers lack a voice transport for outbound calls.
//
// ABUSE GUARD: this endpoint places real phone calls, so it MUST be rate-limited
// before it goes live behind a public ad, or it becomes a call-harassment / cost
// vector. Rate-limiting activates automatically once a KV namespace is bound as
// `DEMO_RATELIMIT` (see wrangler.toml). Until then it fails open so you can test.
async function handleDemoCall(body, request, env, ctx) {
  const raw = (body?.phone || body?.phone_number || "").toString();
  const number = normalizePhone(raw);
  if (!number) {
    return { success: false, error: "Please enter a valid mobile number." };
  }

  // Anti-abuse rate limit. Read-check BEFORE calling, but only WRITE the cooldown
  // AFTER a call is actually placed — so a failed/blocked attempt never locks the
  // number. Short per-number cooldown (90s) stops call-bombing but still lets a
  // real prospect who missed the ring retry quickly; bulk abuse caught per IP/hr.
  let rl = null;
  if (env.DEMO_RATELIMIT) {
    const ip = request.headers.get("CF-Connecting-IP") || "noip";
    const numKey = `demo:num:${number}`;
    const ipKey  = `demo:ip:${ip}`;
    const [numHit, ipCountRaw] = await Promise.all([
      env.DEMO_RATELIMIT.get(numKey),
      env.DEMO_RATELIMIT.get(ipKey),
    ]);
    const ipCount = parseInt(ipCountRaw || "0", 10);
    if (numHit)       return { success: false, status: 429, error: "Alex just called that number — give it a few seconds to ring 📞" };
    if (ipCount >= 8) return { success: false, status: 429, error: "Too many demo calls from this device. Try again later." };
    rl = { numKey, ipKey, ipCount };
  }

  // The visitor's chosen voice from the wizard's voice-picker step (defaults to
  // Alex/asteria — the existing demo voice — if missing or unrecognized, so the
  // demo still works exactly as before for any caller that skips that step).
  const voiceKey = VOICES[body?.voice] ? body.voice : "asteria";
  const voice = VOICES[voiceKey];

  // Business name/trade/website come from the wizard steps that run before this
  // one; all optional (a caller can reach /demo/call directly without them, in
  // which case the base assistant's own generic no-business-name prompt is used
  // unmodified). Scraping is best-effort and never blocks the call — a failed
  // or slow fetch just means Alex talks generically about services instead.
  const businessName = (body?.businessName || "").toString().trim().slice(0, 120);
  const trade = (body?.trade || "").toString().trim().slice(0, 60);
  const websiteUrl = (body?.websiteUrl || "").toString().trim();
  const siteInfo = websiteUrl ? await scrapeWebsite(websiteUrl) : null;

  const firstMessage = businessName
    ? `Hey there! This is ${voice.name}, calling live from ${businessName}. This is exactly what your customers hear when you can't pick up. Go ahead, ask me anything.`
    : `Hey there! This is ${voice.name} — your AI receptionist, calling you live. This is exactly what your customers hear when you can't pick up. Go ahead, ask me anything.`;

  // Twilio (JORDAN_PHONE_ID) works for all countries including international.
  // The earlier E.164 validation failure was only for fake/sequential test numbers —
  // real phone numbers pass Twilio's libphonenumber validation regardless of country.
  const call = await vapiRequest(env, "POST", "/call/phone", {
    assistantId: DEMO_ASSISTANT_ID,
    phoneNumberId: JORDAN_PHONE_ID,
    customer: { number },
    assistantOverrides: {
      firstMessage,
      voice: { provider: voice.provider, voiceId: voice.voiceId },
      model: { ...DEMO_ASSISTANT_MODEL, messages: [{ role: "system", content: buildDemoSystemPrompt({ businessName, trade, siteInfo }) }] },
      variableValues: { businessName, phoneNumber: "" }
    }
  });

  if (!call?.id) {
    return { success: false, error: "Couldn't start the call right now. Please try again." };
  }

  // Call placed — now (and only now) apply the cooldown.
  if (rl) {
    ctx.waitUntil(Promise.all([
      env.DEMO_RATELIMIT.put(rl.numKey, "1", { expirationTtl: 90 }),
      env.DEMO_RATELIMIT.put(rl.ipKey, String(rl.ipCount + 1), { expirationTtl: 3600 }),
    ]));
  }
  console.log("Demo call started:", call.id, "→", number, "| status:", call.status);
  return { success: true, callId: call.id };
}

async function vapiRequest(env, method, path, body = null) {
  const options = {
    method,
    headers: {
      "Authorization": `Bearer ${env.VAPI_API_KEY}`,
      "Content-Type": "application/json"
    }
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`https://api.vapi.ai${path}`, options);
  const data = await res.json();

  if (!res.ok) {
    console.error(`Vapi ${method} ${path} failed:`, JSON.stringify(data));
  }
  return data;
}

// ─── HELPER: AIRTABLE LOOKUP ──────────────────────────────────────────────────
async function airtableLookup(env, table, field, value) {
  const formula = encodeURIComponent(`({${field}}="${value}")`);
  const res = await fetch(
    `https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${table}?filterByFormula=${formula}&maxRecords=1`,
    {
      headers: {
        "Authorization": `Bearer ${env.AIRTABLE_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
  const data = await res.json();
  return data?.records?.[0] || null;
}

// ─── HELPER: AIRTABLE CREATE ──────────────────────────────────────────────────
async function airtableCreate(env, table, fields, options = {}) {
  const res = await fetch(
    `https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${table}`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.AIRTABLE_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fields, typecast: !!options.typecast })
    }
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Airtable create failed: ${JSON.stringify(data)}`);
  }
  return data;
}

// ─── HELPER: AIRTABLE UPDATE ──────────────────────────────────────────────────
async function airtableUpdate(env, table, recordId, fields) {
  const res = await fetch(
    `https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${table}/${recordId}`,
    {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${env.AIRTABLE_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fields })
    }
  );
  const data = await res.json();
  if (!res.ok) {
    console.error(`Airtable update failed: ${JSON.stringify(data)}`);
  }
  return data;
}

// ─── HELPER: AIRTABLE LIST BY FORMULA ─────────────────────────────────────────
async function airtableListByFormula(env, table, formula, maxRecords = 100) {
  const qs = encodeURIComponent(formula);
  const res = await fetch(
    `https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${table}?filterByFormula=${qs}&maxRecords=${maxRecords}`,
    {
      headers: {
        "Authorization": `Bearer ${env.AIRTABLE_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Airtable list failed: ${JSON.stringify(data)}`);
  }
  return data?.records || [];
}

// ─── HELPER: AIRTABLE DELETE ──────────────────────────────────────────────────
async function airtableDelete(env, table, recordId) {
  const res = await fetch(
    `https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${table}/${recordId}`,
    {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${env.AIRTABLE_TOKEN}` }
    }
  );
  const data = await res.json();
  if (!res.ok) {
    console.error(`Airtable delete failed: ${JSON.stringify(data)}`);
  }
  return res.ok;
}

// ─── HELPER: ADMIN KEY CHECK ─────────────────────────────────────────────────
// Accepts the key as Authorization: Bearer <key> header or ?key= query param.
function checkAdminKey(request, env) {
  if (!env.ADMIN_KEY) return false;
  const authHeader = request.headers.get("Authorization") || "";
  if (authHeader.startsWith("Bearer ") && authHeader.slice(7) === env.ADMIN_KEY) return true;
  const key = new URL(request.url).searchParams.get("key") || "";
  return key === env.ADMIN_KEY;
}

// ─── ADMIN: CLEAN UP TEST CLIENTS ─────────────────────────────────────────────
// GET /admin/cleanup-test-clients?key=ADMIN_KEY
// Deletes Clients rows where Phone is empty AND Status is "Trial" (the residue
// left by test/duplicate checkouts), and releases each row's Vapi phone number.
async function handleCleanupTestClients(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "";
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return new Response("Forbidden", { status: 403 });
  }

  // Phone-less trial rows only — never touch real (phone-bearing) clients.
  const records = await airtableListByFormula(
    env, AIRTABLE_CLIENTS, `AND({Phone} = "", {Status} = "Trial")`
  );

  const results = [];
  for (const rec of records) {
    const vapiNumberId = rec.fields["Vapi_number_id"] || "";
    let vapiReleased = false;
    if (vapiNumberId) {
      const resp = await vapiRequest(env, "DELETE", `/phone-number/${vapiNumberId}`);
      // Vapi returns the deleted object (with id) on success, or an error body.
      vapiReleased = !!(resp && (resp.id || resp.deleted)) && !resp.message;
    }
    const deleted = await airtableDelete(env, AIRTABLE_CLIENTS, rec.id);
    results.push({
      recordId: rec.id,
      businessName: rec.fields["Business Name"] || "",
      vapiNumberId,
      vapiReleased,
      airtableDeleted: deleted
    });
  }

  console.log(`Cleanup: removed ${results.length} phone-less trial client(s).`);
  return Response.json({ cleaned: results.length, results });
}

// GET /admin/set-jordan-inbound?key=ADMIN_KEY
// Assigns the Jordan onboarding assistant as the INBOUND assistant on the Twilio
// number (JORDAN_PHONE_ID). Outbound calls still pass assistantId per-call, so this
// only affects who answers when someone dials the number. Run once.
async function handleDeactivateStaleLink(env) {
  const res = await fetch("https://api.stripe.com/v1/payment_links?limit=100", {
    headers: { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}` }
  });
  const data = await res.json();
  if (!res.ok) return Response.json({ success: false, error: data }, { status: 500 });

  const stale = (data.data || []).find(pl => pl.url.includes("dRm7sN4DS0I2bisaNQ57W01"));
  if (!stale) return Response.json({ success: false, error: "Payment Link not found — may already be deactivated or ID changed." }, { status: 404 });
  if (!stale.active) return Response.json({ success: true, message: "Already inactive.", id: stale.id });

  const deactivateRes = await fetch(`https://api.stripe.com/v1/payment_links/${stale.id}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "active=false"
  });
  const deactivateData = await deactivateRes.json();
  if (!deactivateRes.ok) return Response.json({ success: false, error: deactivateData }, { status: 500 });

  console.log("Deactivated stale payment link:", stale.id);
  return Response.json({ success: true, id: stale.id, active: deactivateData.active });
}

async function handleSetJordanInbound(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "";
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return new Response("Forbidden", { status: 403 });
  }

  const resp = await vapiRequest(env, "PATCH", `/phone-number/${JORDAN_PHONE_ID}`, {
    assistantId: JORDAN_ASSISTANT_ID
  });

  if (resp?.message || !resp?.id) {
    console.error("set-jordan-inbound failed:", JSON.stringify(resp));
    return Response.json({ success: false, error: resp }, { status: 400 });
  }
  console.log("Inbound assistant on", resp.number, "set to Jordan:", JORDAN_ASSISTANT_ID);
  return Response.json({ success: true, number: resp.number, inboundAssistantId: resp.assistantId });
}

// ─── HELPER: SEND SMS VIA TELNYX ──────────────────────────────────────────────
async function sendSMS(env, to, text) {
  const res = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.TELNYX_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ from: TELNYX_FROM, to, text })
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("SMS send failed:", JSON.stringify(data));
  }
  return data;
}

// ─── HELPER: NORMALIZE PHONE TO E.164 ────────────────────────────────────────
function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length > 10) return `+${digits}`;
  return null;
}

// ─── HELPER: DETECT COUNTRY FROM E.164 PHONE NUMBER ──────────────────────────
// Returns ISO 3166-1 alpha-2 country code, or 'US' as fallback.
// 3-digit calling-code prefixes are checked BEFORE 2-digit ones to prevent
// partial-match errors (e.g. +33/France must not swallow +353/Ireland).
function getPhoneCountry(phone) {
  if (!phone || !phone.startsWith('+')) return 'US';
  if (phone.startsWith('+1')) return 'US'; // US, Canada, and NANP territories

  const P3 = [ // 3-digit calling codes (4-char prefix strings)
    ['+353','IE'],['+354','IS'],['+356','MT'],['+357','CY'],['+358','FI'],
    ['+359','BG'],['+370','LT'],['+371','LV'],['+372','EE'],['+373','MD'],
    ['+374','AM'],['+375','BY'],['+376','AD'],['+377','MC'],['+378','SM'],
    ['+380','UA'],['+381','RS'],['+382','ME'],['+385','HR'],['+386','SI'],
    ['+387','BA'],['+389','MK'],['+420','CZ'],['+421','SK'],['+423','LI'],
    ['+212','MA'],['+213','DZ'],['+216','TN'],['+218','LY'],['+220','GM'],
    ['+221','SN'],['+222','MR'],['+223','ML'],['+224','GN'],['+225','CI'],
    ['+226','BF'],['+227','NE'],['+228','TG'],['+229','BJ'],['+230','MU'],
    ['+231','LR'],['+232','SL'],['+233','GH'],['+234','NG'],['+235','TD'],
    ['+236','CF'],['+237','CM'],['+238','CV'],['+239','ST'],['+240','GQ'],
    ['+241','GA'],['+242','CG'],['+243','CD'],['+244','AO'],['+245','GW'],
    ['+248','SC'],['+249','SD'],['+250','RW'],['+251','ET'],['+252','SO'],
    ['+253','DJ'],['+254','KE'],['+255','TZ'],['+256','UG'],['+257','BI'],
    ['+258','MZ'],['+260','ZM'],['+261','MG'],['+263','ZW'],['+264','NA'],
    ['+265','MW'],['+266','LS'],['+267','BW'],['+268','SZ'],['+269','KM'],
    ['+290','SH'],['+291','ER'],['+297','AW'],['+298','FO'],['+299','GL'],
    ['+350','GI'],['+351','PT'],['+352','LU'],['+355','AL'],['+373','MD'],
    ['+500','FK'],['+501','BZ'],['+502','GT'],['+503','SV'],['+504','HN'],
    ['+505','NI'],['+506','CR'],['+507','PA'],['+509','HT'],['+590','GP'],
    ['+591','BO'],['+592','GY'],['+593','EC'],['+595','PY'],['+596','MQ'],
    ['+597','SR'],['+598','UY'],['+599','AN'],['+670','TL'],['+672','NF'],
    ['+673','BN'],['+674','NR'],['+675','PG'],['+676','TO'],['+677','SB'],
    ['+678','VU'],['+679','FJ'],['+680','PW'],['+681','WF'],['+682','CK'],
    ['+683','NU'],['+685','WS'],['+686','KI'],['+687','NC'],['+688','TV'],
    ['+689','PF'],['+690','TK'],['+691','FM'],['+692','MH'],['+850','KP'],
    ['+852','HK'],['+853','MO'],['+855','KH'],['+856','LA'],['+880','BD'],
    ['+886','TW'],['+960','MV'],['+961','LB'],['+962','JO'],['+963','SY'],
    ['+964','IQ'],['+965','KW'],['+966','SA'],['+967','YE'],['+968','OM'],
    ['+970','PS'],['+971','AE'],['+972','IL'],['+973','BH'],['+974','QA'],
    ['+975','BT'],['+976','MN'],['+977','NP'],['+992','TJ'],['+993','TM'],
    ['+994','AZ'],['+995','GE'],['+996','KG'],['+998','UZ'],
  ];
  for (const [p, c] of P3) { if (phone.startsWith(p)) return c; }

  const P2 = [ // 2-digit calling codes (3-char prefix strings)
    ['+20','EG'],['+27','ZA'],['+30','GR'],['+31','NL'],['+32','BE'],
    ['+33','FR'],['+34','ES'],['+36','HU'],['+39','IT'],['+40','RO'],
    ['+41','CH'],['+43','AT'],['+44','GB'],['+45','DK'],['+46','SE'],
    ['+47','NO'],['+48','PL'],['+49','DE'],['+51','PE'],['+52','MX'],
    ['+53','CU'],['+54','AR'],['+55','BR'],['+56','CL'],['+57','CO'],
    ['+58','VE'],['+60','MY'],['+61','AU'],['+62','ID'],['+63','PH'],
    ['+64','NZ'],['+65','SG'],['+66','TH'],['+7', 'RU'],['+81','JP'],
    ['+82','KR'],['+84','VN'],['+86','CN'],['+90','TR'],['+91','IN'],
    ['+92','PK'],['+93','AF'],['+94','LK'],['+95','MM'],['+98','IR'],
  ];
  for (const [p, c] of P2) { if (phone.startsWith(p)) return c; }

  return 'US'; // unknown — fall back to US provisioning
}

// ─── HELPER: CHECK TELNYX REGULATORY REQUIREMENTS ────────────────────────────
// Many countries require KYC documents (proof of address, business registration,
// government ID) before Telnyx will issue a local number — this can't be filled
// in automatically during a Stripe webhook, so we check first and skip straight
// to a manual-fallback path rather than attempting (and failing) a purchase.
// Returns true only when the country/type genuinely has zero requirements —
// confirmed live against Telnyx's own /v2/requirements endpoint: e.g. CA returns
// zero requirement records (instant), while IL/GB/AU/IE all require at least one
// document upload (proof of address, ID, or company registration).
async function isTelnyxAutoProvisionable(country, env) {
  const url = new URL("https://api.telnyx.com/v2/requirements");
  url.searchParams.set("filter[country_code]", country);
  url.searchParams.set("filter[phone_number_type]", "local");
  url.searchParams.set("filter[action]", "ordering");
  const res = await fetch(url, { headers: { "Authorization": `Bearer ${env.TELNYX_API_KEY}` } });
  if (!res.ok) {
    console.error(`Telnyx requirements check failed for ${country}: ${res.status}`);
    return false; // fail closed — if we can't confirm it's simple, treat as needing manual handling
  }
  const data = await res.json();
  return (data?.data || []).length === 0;
}

// ─── HELPER: PROVISION VAPI PHONE NUMBER (US or international) ───────────────
// For US/CA (+1) uses Vapi's own number pool with area-code fallback.
// For other countries with zero Telnyx regulatory requirements, purchases a
// Telnyx voice number and registers it in Vapi via provider:"telnyx", returning
// the Vapi phone-number object. For countries that DO require KYC documents,
// returns { pending: true, country } instead of throwing — Telnyx can't be
// satisfied automatically, so handleStripeCheckout proceeds without a number and
// flags Eric to finish setup manually rather than retrying a doomed purchase.
async function provisionVapiNumber(contractorPhone, businessName, ownerName, env) {
  const country = getPhoneCountry(contractorPhone || '');

  if (country === 'US') {
    // ── US / Canada / NANP — area-code waterfall, then live-hint fallback ──
    // CORRECTED 2026-07-15: the previous version of this fallback omitted
    // numberDesiredAreaCode entirely to request "any available number" — that
    // was never valid. Vapi's API hard-requires numberDesiredAreaCode (or
    // sipUri); omitting it always returns 400 "At least one of
    // numberDesiredAreaCode, sipUri must be provided", regardless of actual
    // number availability or account/billing status. Confirmed directly
    // against the live API, not assumed from docs.
    //
    // The real fix: Vapi's "area code unavailable" error includes a live hint
    // of what IS actually available right now, e.g. "This area code is
    // currently not available. Hint: Try one of 978, 276, 319." — those
    // specific codes change over time as Vapi's inventory shifts, so a static
    // fallback list (this AREA_CODES array) can go stale and all fail
    // simultaneously even with plenty of numbers actually available elsewhere.
    // If every entry in the curated list fails, parse the hint from the last
    // failure and retry with those Vapi-suggested codes instead of giving up.
    // CORRECTED 2026-07-17: confirmed live (not assumed) that Vapi's free pool
    // can go broadly unavailable across dozens of diverse area codes at once —
    // this isn't a stale-list problem, their hint text is also gone from the
    // error response now (used to include "Try one of X, Y, Z", doesn't
    // anymore), so the live-suggestion fallback below has nothing to parse
    // most of the time. Widened the curated list substantially as a first
    // line of defense, but the real fix is what happens when even this fails:
    // instead of throwing and leaving a paying customer stuck with nothing,
    // fall through to the same graceful "pending manual setup" path already
    // used for KYC-blocked countries below — the client record still gets
    // created, Eric gets an actionable SMS, the customer gets a reassuring
    // one, and nothing is silently lost.
    const AREA_CODES = [
      "804","502","302","267","614","216","469","312","703","757","540","571","434","276",
      "213","305","404","415","512","617","646","718","773","858","917","202","410","901",
      "615","206","503","480","602","702","303","612","414","401","802"
    ];
    let lastFailure = null;
    for (const code of AREA_CODES) {
      const attempt = await vapiRequest(env, "POST", "/phone-number", {
        provider: "vapi",
        numberDesiredAreaCode: code,
        name: `${businessName || ownerName} Receptionist`,
        assistantId: null,
        serverUrl: CLOUDFLARE_WORKER_URL
      });
      if (attempt?.id) {
        console.log("Vapi US number provisioned, area code:", code);
        return attempt;
      }
      console.log(`Area code ${code} unavailable:`, JSON.stringify(attempt));
      lastFailure = attempt;
    }

    const hintMatch = /Try one of ([\d, ]+)\./.exec(lastFailure?.message || "");
    const hintedCodes = hintMatch ? hintMatch[1].split(",").map(s => s.trim()).filter(Boolean) : [];
    if (hintedCodes.length) {
      console.log("Curated area codes exhausted — trying Vapi's live-suggested codes:", hintedCodes);
      for (const code of hintedCodes) {
        const attempt = await vapiRequest(env, "POST", "/phone-number", {
          provider: "vapi",
          numberDesiredAreaCode: code,
          name: `${businessName || ownerName} Receptionist`,
          assistantId: null,
          serverUrl: CLOUDFLARE_WORKER_URL
        });
        if (attempt?.id) {
          console.log("Vapi US number provisioned via live-suggested code:", code);
          return attempt;
        }
        console.log(`Suggested code ${code} also unavailable:`, JSON.stringify(attempt));
        lastFailure = attempt;
      }
    }

    console.error("Vapi US number provisioning failed — full area-code sweep exhausted, no number available. Last error:", JSON.stringify(lastFailure));
    return { pending: true, reason: "us_pool_unavailable" };
  }

  // ── International — buy a Telnyx voice number, register in Vapi ──
  console.log(`International provisioning for country: ${country} (${contractorPhone})`);

  const autoProvisionable = await isTelnyxAutoProvisionable(country, env);
  if (!autoProvisionable) {
    console.log(`${country} requires Telnyx KYC documents — cannot auto-provision, flagging for manual setup.`);
    return { pending: true, country };
  }

  // Step A: find an available voice number in the customer's country
  const searchRes = await fetch(
    `https://api.telnyx.com/v2/available_phone_numbers?filter[country_code]=${country}&filter[features][]=voice&filter[limit]=5`,
    { headers: { "Authorization": `Bearer ${env.TELNYX_API_KEY}` } }
  );
  const searchData = await searchRes.json();
  const available = searchData?.data;
  if (!available || available.length === 0) {
    throw new Error(`No Telnyx voice numbers available in ${country} for ${contractorPhone}`);
  }
  const telnyxNumber = available[0].phone_number;
  console.log(`Telnyx number candidate for ${country}:`, telnyxNumber);

  // Step B: purchase the number
  // NOTE: /v2/phone_numbers has no POST-to-create route (it's for managing numbers
  // you already own) — ordering a new number goes through /v2/number_orders with a
  // phone_numbers array. Posting to /v2/phone_numbers 404s with Telnyx error 10005.
  const purchaseRes = await fetch("https://api.telnyx.com/v2/number_orders", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.TELNYX_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ phone_numbers: [{ phone_number: telnyxNumber }] })
  });
  const purchaseData = await purchaseRes.json();
  if (!purchaseData?.data?.id || purchaseData.data.status === "failed") {
    throw new Error(`Telnyx purchase failed for ${telnyxNumber}: ${JSON.stringify(purchaseData)}`);
  }
  console.log("Telnyx number purchased:", telnyxNumber, "order status:", purchaseData.data.status);

  // Step C: wait for Telnyx to propagate, then register with Vapi
  await sleep(3000);
  const vapiRes = await vapiRequest(env, "POST", "/phone-number", {
    provider: "telnyx",
    phoneNumber: telnyxNumber,
    telnyxApiKey: env.TELNYX_API_KEY,
    name: `${businessName || ownerName} Receptionist`,
    assistantId: null,
    serverUrl: CLOUDFLARE_WORKER_URL
  });
  if (!vapiRes?.id) {
    throw new Error(`Vapi Telnyx registration failed for ${telnyxNumber}: ${JSON.stringify(vapiRes)}`);
  }
  console.log("Vapi registered Telnyx number:", telnyxNumber, "id:", vapiRes.id, "country:", country);
  return vapiRes;
}

// ─── HELPER: NORMALIZE TRADE VALUES ──────────────────────────────────────────
// Maps website/API trade values to the correct Airtable select option for each table.

function normalizeLeadsTrade(trade) {
  const map = {
    "plumbing": "Plumbing",
    "hvac": "hvac",
    "electrical": "electrical",
    "roofing": "roofing",
    "landscaping": "landscaping",
    "garage door": "garage door",
    "garage doors": "garage door",
    "septic": "septic",
    "well water": "well water",
    "junk removal": "junk removal",
    "pressure washing": "pressure washing",
    "general": "general",
    "general contractor": "general",
    "handyman": "general",
    "painting": "",
    "pest control": "",
    "flooring": "",
  };
  return map[(trade || "").toLowerCase().trim()] ?? "";
}

function normalizeClientsTrade(trade) {
  const map = {
    "plumbing": "Plumbing",
    "hvac": "HVAC",
    "electrical": "Electrical",
    "roofing": "Roofing",
    "landscaping": "Landscaping",
    "garage door": "Garage Door",
    "garage doors": "Garage Door",
    "septic": "Septic",
    "well water": "Well Water",
    "junk removal": "Junk Removal",
    "pressure washing": "Pressure Washing",
    "general": "General",
    "general contractor": "General",
    "handyman": "General",
    "painting": "General",
    "pest control": "General",
    "flooring": "General",
  };
  return map[(trade || "").toLowerCase().trim()] ?? "";
}

// ════════════════════════════════════════════════════════════════════════════
// GOOGLE CALENDAR INTEGRATION
//   GET  /calendar/connect?clientRecordId={id}  — start OAuth, redirect to Google
//   GET  /calendar/callback?code&state          — exchange code, store tokens
//   POST /calendar/availability                 — open 1-hour slots (8am-6pm ET)
//   POST /calendar/book                         — create a confirmed event
// ════════════════════════════════════════════════════════════════════════════

const GOOGLE_REDIRECT_URI   = "https://nmln-automation.eric-04b.workers.dev/calendar/callback";
const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
const CALENDAR_TZ           = "America/New_York";
const BUSINESS_START_HOUR   = 8;   // 8am Eastern
const BUSINESS_END_HOUR     = 18;  // 6pm Eastern (last slot starts 17:00)
const SLOT_MS               = 60 * 60 * 1000;
const MAX_SLOTS             = 6;
const DEFAULT_CALENDAR_ID   = "primary";

// ─── GET /calendar/connect ────────────────────────────────────────────────────
function handleCalendarConnect(request, env) {
  const url = new URL(request.url);
  const clientRecordId = url.searchParams.get("clientRecordId") || "";
  if (!clientRecordId) {
    return new Response("Missing clientRecordId query parameter", { status: 400 });
  }

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_CALENDAR_SCOPE);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");        // always return a refresh_token
  authUrl.searchParams.set("state", clientRecordId);    // carry the client record id through

  return Response.redirect(authUrl.toString(), 302);
}

// ─── GET /calendar/callback ───────────────────────────────────────────────────
async function handleCalendarCallback(request, env) {
  const url = new URL(request.url);
  const code           = url.searchParams.get("code");
  const clientRecordId = url.searchParams.get("state") || "";
  const oauthError     = url.searchParams.get("error");

  if (oauthError) return calendarHtml(false, `Authorization was cancelled or failed: ${oauthError}`);
  if (!code || !clientRecordId) return calendarHtml(false, "Missing authorization code or client reference.");

  // Exchange the authorization code for access + refresh tokens.
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code"
    })
  });
  const token = await tokenRes.json();
  if (!tokenRes.ok || !token.access_token) {
    console.error("Google token exchange failed:", JSON.stringify(token));
    return calendarHtml(false, token.error_description || token.error || "Token exchange failed.");
  }

  // Save tokens on the client record. Google only returns refresh_token on the first
  // consent, so only overwrite it when one is actually returned.
  const fields = {
    "Google Access Token": token.access_token,
    "Google Calendar ID": DEFAULT_CALENDAR_ID,
    "Calendar Connected": true
  };
  if (token.refresh_token) fields["Google Refresh Token"] = token.refresh_token;

  const updated = await airtableUpdate(env, AIRTABLE_CLIENTS, clientRecordId, fields);
  if (updated?.error) {
    console.error("Airtable update failed on calendar connect:", JSON.stringify(updated));
    return calendarHtml(false, "Connected to Google, but could not save to your account. Please contact support.");
  }

  console.log("Calendar connected for client:", clientRecordId);
  return calendarHtml(true, "Your calendar is connected! You can close this tab.");
}

// ─── POST /calendar/availability ──────────────────────────────────────────────
async function handleCalendarAvailability(body, env) {
  const clientRecordId = body?.clientRecordId;
  if (!clientRecordId) return { available: false, reason: "missing_client_record_id" };

  const daysAhead = Number(body?.daysAhead) > 0 ? Number(body.daysAhead) : 5;

  const client = await getClientById(env, clientRecordId);
  if (!client) return { available: false, reason: "client_not_found" };
  if (client.fields["Calendar Connected"] !== true) {
    return { available: false, reason: "calendar_not_connected" };
  }

  const accessToken = await getGoogleAccessToken(env, client);
  if (!accessToken) return { available: false, reason: "no_access_token" };

  const calendarId = client.fields["Google Calendar ID"] || DEFAULT_CALENDAR_ID;

  const now = Date.now();
  const windowStart = new Date(now).toISOString();
  const windowEnd   = new Date(now + daysAhead * 24 * 60 * 60 * 1000).toISOString();
  const busy = await freeBusy(accessToken, calendarId, windowStart, windowEnd);

  // Walk each day, generate 1-hour slots in business hours, skip past + busy ones.
  const slots = [];
  for (let d = 0; d < daysAhead && slots.length < MAX_SLOTS; d++) {
    const dateStr = ymdInTz(now + d * 24 * 60 * 60 * 1000, CALENDAR_TZ);
    for (let h = BUSINESS_START_HOUR; h < BUSINESS_END_HOUR; h++) {
      const startMs = localTimeToUtcMs(dateStr, h, 0, CALENDAR_TZ);
      const endMs   = startMs + SLOT_MS;
      if (startMs <= now) continue;                                   // no past slots
      if (busy.some(b => startMs < b.endMs && endMs > b.startMs)) continue; // skip busy
      slots.push({ start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() });
      if (slots.length >= MAX_SLOTS) break;
    }
  }

  return { available: true, slots };
}

// ─── POST /calendar/book ──────────────────────────────────────────────────────
async function handleCalendarBook(body, env) {
  const { clientRecordId, startTime, endTime, callerName, callerPhone, serviceType, address } = body || {};
  if (!clientRecordId || !startTime || !endTime) {
    return { success: false, error: "clientRecordId, startTime and endTime are required" };
  }

  const client = await getClientById(env, clientRecordId);
  if (!client) return { success: false, error: "client_not_found" };
  if (client.fields["Calendar Connected"] !== true) {
    return { success: false, error: "calendar_not_connected" };
  }

  const accessToken = await getGoogleAccessToken(env, client);
  if (!accessToken) return { success: false, error: "no_access_token" };

  const calendarId = client.fields["Google Calendar ID"] || DEFAULT_CALENDAR_ID;

  const event = {
    summary: `${serviceType || "Appointment"} — ${callerName || "Customer"}`,
    description:
      `Booked by AI receptionist.\n` +
      `Name: ${callerName || ""}\n` +
      `Phone: ${callerPhone || ""}\n` +
      `Service: ${serviceType || ""}\n` +
      `Address: ${address || ""}`,
    start: { dateTime: startTime, timeZone: CALENDAR_TZ },
    end:   { dateTime: endTime,   timeZone: CALENDAR_TZ }
  };
  if (address) event.location = address;

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(event)
    }
  );
  const data = await res.json();
  if (!res.ok) {
    console.error("Calendar event insert failed:", JSON.stringify(data));
    return { success: false, error: data?.error?.message || "event_insert_failed" };
  }

  console.log("Appointment booked:", data.id, "for client:", clientRecordId);
  return { success: true, eventId: data.id };
}

// ─── HELPER: GET A CLIENT RECORD BY ID ───────────────────────────────────────
async function getClientById(env, recordId) {
  const res = await fetch(
    `https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${AIRTABLE_CLIENTS}/${recordId}`,
    { headers: { "Authorization": `Bearer ${env.AIRTABLE_TOKEN}` } }
  );
  if (!res.ok) {
    console.error("getClientById failed:", recordId, res.status);
    return null;
  }
  return await res.json();
}

// ─── HELPER: GOOGLE ACCESS TOKEN (refresh + persist) ─────────────────────────
// Access tokens live ~1 hour and we don't store an expiry, so refresh on every
// call when a refresh_token is present, then save the fresh access token back.
async function getGoogleAccessToken(env, client) {
  const refreshToken = client.fields["Google Refresh Token"];
  if (!refreshToken) {
    // No refresh token — fall back to whatever access token is stored (may be expired).
    return client.fields["Google Access Token"] || null;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    console.error("Google token refresh failed:", JSON.stringify(data));
    return client.fields["Google Access Token"] || null;
  }

  // Persist the refreshed access token for visibility/debugging.
  await airtableUpdate(env, AIRTABLE_CLIENTS, client.id, { "Google Access Token": data.access_token });
  return data.access_token;
}

// ─── HELPER: GOOGLE FREEBUSY ─────────────────────────────────────────────────
async function freeBusy(accessToken, calendarId, timeMinIso, timeMaxIso) {
  const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: timeMinIso, timeMax: timeMaxIso, items: [{ id: calendarId }] })
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("FreeBusy query failed:", JSON.stringify(data));
    return [];
  }
  const busy = data?.calendars?.[calendarId]?.busy || [];
  return busy.map(b => ({ startMs: Date.parse(b.start), endMs: Date.parse(b.end) }));
}

// ─── HELPER: SUCCESS / ERROR HTML PAGE ───────────────────────────────────────
function calendarHtml(ok, message) {
  const color = ok ? "#16a34a" : "#dc2626";
  const icon  = ok ? "✅" : "⚠️";
  const title = ok ? "Calendar Connected" : "Connection Problem";
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>` +
    `<body style="font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:48px 24px;color:#111">` +
    `<div style="font-size:56px">${icon}</div>` +
    `<h1 style="color:${color};margin:8px 0">${title}</h1>` +
    `<p style="font-size:18px;max-width:420px;margin:0 auto">${message}</p>` +
    `<p style="color:#888;margin-top:32px">NeverMissLeadsNow</p></body></html>`,
    { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

// ─── HELPER: TIMEZONE MATH (no external libs) ────────────────────────────────
// Offset (ms) of `timeZone` from UTC at a given instant. Positive west of UTC is
// returned as a negative number (e.g. America/New_York ≈ -5h / -4h in DST).
function tzOffsetMs(instantMs, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const p = dtf.formatToParts(new Date(instantMs))
    .reduce((acc, part) => (acc[part.type] = part.value, acc), {});
  // Intl can emit hour "24" at midnight; normalize to 0.
  const hour = p.hour === "24" ? 0 : +p.hour;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second);
  return asUTC - instantMs;
}

// Convert a wall-clock time (YYYY-MM-DD + hour:minute) in `timeZone` to a UTC ms instant.
function localTimeToUtcMs(dateStr, hour, minute, timeZone) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute, 0);
  // One offset correction is exact except inside the ~1h DST transition window.
  return guess - tzOffsetMs(guess, timeZone);
}

// YYYY-MM-DD for an instant, as seen in `timeZone`.
function ymdInTz(instantMs, timeZone) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(instantMs))
    .reduce((acc, part) => (acc[part.type] = part.value, acc), {});
  return `${p.year}-${p.month}-${p.day}`;
}

// ─── GET /leads/filter-mobile ─────────────────────────────────────────────────
// ?test=true  → dry-run 5 records, returns line types, no mutations
// (no param)  → full run: all records, batches of 50, deletes non-mobile
async function handleFilterMobile(request, env) {
  const url = new URL(request.url);
  const isTest = url.searchParams.get("test") === "true";

  // Ensure "Is Mobile" checkbox field exists before any reads/writes
  await ensureIsMobileField(env);

  if (isTest) {
    const isDebug = url.searchParams.get("debug") === "true";
    // Dry-run: fetch exactly 5 records, lookup only, no mutations
    const records = await airtableListByFormula(env, AIRTABLE_LEADS, `{Phone}!=""`, 5);
    const results = [];
    for (const record of records) {
      const phone = record.fields["Phone"] || "";
      const { lineType, raw } = await telnyxLookupRaw(env, phone);
      const entry = {
        recordId: record.id,
        businessName: record.fields["Business Name"] || "",
        phone,
        lineType,
        action: lineType === "mobile" ? "keep (set Is Mobile=true)" : "delete"
      };
      if (isDebug) entry.telnyxRaw = raw;
      results.push(entry);
      await sleep(150);
    }
    return Response.json({ test: true, count: results.length, results });
  }

  // Full run: process `limit` records per invocation to avoid CF 30-second wall-clock limit.
  // Run repeatedly until remaining=0.
  const chunkLimit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100);

  // Fetch one page of unprocessed records — those without Is Mobile already set.
  // (Deleting non-mobile is permanent; for kept records we check Is Mobile!=true
  //  so we can re-run safely without re-processing already-tagged records.)
  const formula = `AND({Phone}!="", {Is Mobile}!=1)`;
  const records = await airtableListByFormula(env, AIRTABLE_LEADS, formula, chunkLimit + 1);

  // Peek at one extra to know if more remain after this chunk
  const hasMore = records.length > chunkLimit;
  const chunk = records.slice(0, chunkLimit);

  let processed = 0, mobile_kept = 0, deleted = 0;

  for (const record of chunk) {
    const phone = record.fields["Phone"] || "";
    const lineType = await telnyxLookup(env, phone);
    if (lineType === "mobile") {
      await airtableUpdate(env, AIRTABLE_LEADS, record.id, { "Is Mobile": true });
      mobile_kept++;
    } else {
      await airtableDelete(env, AIRTABLE_LEADS, record.id);
      deleted++;
    }
    processed++;
    await sleep(50); // gentle pacing within chunk
  }

  return Response.json({ processed, mobile_kept, deleted, remaining: hasMore ? "yes — run again" : "none, all done" });
}

// ─── HELPER: TELNYX CARRIER LOOKUP ────────────────────────────────────────────
async function telnyxLookup(env, phone) {
  const { lineType } = await telnyxLookupRaw(env, phone);
  return lineType;
}

async function telnyxLookupRaw(env, phone) {
  try {
    const e164 = normalizePhone(phone) || phone;
    const res = await fetch(
      `https://api.telnyx.com/v2/number_lookup/${encodeURIComponent(e164)}?type=carrier`,
      { headers: { "Authorization": `Bearer ${env.TELNYX_API_KEY}` } }
    );
    const data = await res.json();
    // Telnyx returns line type as carrier.type (not carrier.line_type);
    // portability.line_type is a reliable secondary source.
    const lineType =
      data?.data?.carrier?.type ||
      data?.data?.portability?.line_type ||
      "unknown";
    console.log("Telnyx lookup", phone, "→", lineType, "status:", res.status);
    return { lineType, raw: data };
  } catch (err) {
    console.error("Telnyx lookup failed for", phone, ":", err.message);
    return { lineType: "unknown", raw: { error: err.message } };
  }
}

// ─── HELPER: ENSURE "Is Mobile" CHECKBOX FIELD EXISTS ─────────────────────────
async function ensureIsMobileField(env) {
  const metaRes = await fetch(
    `https://api.airtable.com/v0/meta/bases/${env.AIRTABLE_BASE}/tables`,
    { headers: { "Authorization": `Bearer ${env.AIRTABLE_TOKEN}` } }
  );
  if (!metaRes.ok) return; // metadata API unavailable — field likely already exists
  const meta = await metaRes.json();
  const leadsTable = meta?.tables?.find(t => t.name === AIRTABLE_LEADS);
  if (!leadsTable) return;

  const exists = leadsTable.fields?.some(f => f.name === "Is Mobile");
  if (exists) return;

  await fetch(
    `https://api.airtable.com/v0/meta/bases/${env.AIRTABLE_BASE}/tables/${leadsTable.id}/fields`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.AIRTABLE_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: "Is Mobile",
        type: "checkbox",
        options: { icon: "check", color: "greenBright" }
      })
    }
  );
  console.log("Created 'Is Mobile' checkbox field in Leads table");
}

// ─── HELPER: AIRTABLE LIST ALL (paginated through offset tokens) ───────────────
async function airtableListAll(env, table, formula) {
  const records = [];
  let offset = null;
  const qs = encodeURIComponent(formula);
  do {
    const offsetParam = offset ? `&offset=${encodeURIComponent(offset)}` : "";
    const res = await fetch(
      `https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${table}?filterByFormula=${qs}&pageSize=100${offsetParam}`,
      { headers: { "Authorization": `Bearer ${env.AIRTABLE_TOKEN}` } }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(`Airtable list failed: ${JSON.stringify(data)}`);
    records.push(...(data.records || []));
    offset = data.offset || null;
  } while (offset);
  return records;
}

// ─── GET /leads/delete-voip ───────────────────────────────────────────────────
// Fetches Is Mobile=true leads, Telnyx-lookups each phone, deletes VoIP records.
// ?test=true              → dry-run 5 records, show line types, no deletions.
// ?offset=<token>         → continue from Airtable cursor (returned as next_offset).
// Processes 50 per invocation. Re-run passing next_offset until remaining="done".
async function handleDeleteVoip(request, env) {
  const url = new URL(request.url);
  const isTest  = url.searchParams.get("test") === "true";
  const offsetIn = url.searchParams.get("offset") || null;
  const batchSize = 20; // 1 list + 20 Telnyx + 20 deletes = 41 subrequests, within CF 50-limit

  const formula = encodeURIComponent(`{Phone}!=""`);

  if (isTest) {
    const res = await fetch(
      `https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${AIRTABLE_LEADS}?filterByFormula=${encodeURIComponent('{Phone}!=""')}&pageSize=5`,
      { headers: { "Authorization": `Bearer ${env.AIRTABLE_TOKEN}` } }
    );
    const data = await res.json();
    const results = [];
    for (const record of (data.records || [])) {
      const phone = record.fields["Phone"] || "";
      const { lineType } = await telnyxLookupRaw(env, phone);
      results.push({
        recordId: record.id,
        businessName: record.fields["Business Name"] || "",
        phone,
        lineType,
        action: lineType !== "mobile" ? "would delete" : "keep"
      });
      await sleep(150);
    }
    return Response.json({ test: true, count: results.length, results });
  }

  // Fetch one page of 50 using Airtable's cursor pagination
  const offsetParam = offsetIn ? `&offset=${encodeURIComponent(offsetIn)}` : "";
  const res = await fetch(
    `https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${AIRTABLE_LEADS}?filterByFormula=${formula}&pageSize=${batchSize}${offsetParam}`,
    { headers: { "Authorization": `Bearer ${env.AIRTABLE_TOKEN}` } }
  );
  const data = await res.json();
  const records = data.records || [];
  const nextOffset = data.offset || null;

  let processed = 0, deleted_voip = 0, kept = 0;
  for (const record of records) {
    const phone = record.fields["Phone"] || "";
    const lineType = await telnyxLookup(env, phone);
    if (lineType !== "mobile") {
      await airtableDelete(env, AIRTABLE_LEADS, record.id);
      deleted_voip++;
    } else {
      kept++;
    }
    processed++;
    await sleep(100);
  }

  return Response.json({
    processed, deleted_voip, kept,
    remaining: nextOffset ? "yes" : "done",
    next_offset: nextOffset || null
  });
}

// ─── HELPER: SLEEP ────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── HELPER: META CONVERSIONS API — PURCHASE EVENT ───────────────────────────
async function sendMetaPurchaseEvent(env, phone, email, value, eventId) {
  const pixelId = "1382512557062444";
  const token   = env.META_CAPI_TOKEN;
  if (!token) return;

  async function sha256hex(str) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
  }

  // Normalize phone: digits only, include country code (US = 1xxxxxxxxxx)
  const digitsOnly = (phone || "").replace(/\D/g, "");
  const normalizedPhone = digitsOnly.startsWith("1") ? digitsOnly : "1" + digitsOnly;

  const userData = {};
  if (normalizedPhone.length >= 10) userData.ph = [await sha256hex(normalizedPhone)];
  if (email) userData.em = [await sha256hex(email.trim().toLowerCase())];

  const payload = {
    data: [{
      event_name:    "Purchase",
      event_time:    Math.floor(Date.now() / 1000),
      event_id:      eventId || undefined, // matches the client-side pixel event_id — see call site for why
      action_source: "website",
      user_data:     userData,
      custom_data:   { currency: "USD", value: value || 97 }
    }]
  };

  const res = await fetch(
    `https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${token}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
  );
  const data = await res.json();
  console.log("Meta CAPI Purchase:", JSON.stringify(data));
}
