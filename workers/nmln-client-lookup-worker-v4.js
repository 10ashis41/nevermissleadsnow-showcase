// nmln-client-lookup-worker-v4.js
// Change from v3: looks up by phoneNumber.number (the Vapi number that received the call)
// instead of customer.number (the caller's number).
// Each client now has their own dedicated Vapi number stored in Airtable as "forwarding_number"
//
// Two-table lookup (added for Kixie sales callbacks):
//   1. Clients table by forwarding_number (the receiving Vapi number) → production Receptionist (unchanged)
//   2. Fallback: Leads table by Phone (the caller's number) → Alex Sales Callback assistant, isLead=true
//   3. Found in neither → Alex with generic variables, isLead=true
// A Clients lookup ERROR still falls back to the Receptionist so a transient Airtable
// failure on a live client call never drops the caller into the sales pitch.

const CLIENTS_TABLE = "Clients";
const LEADS_TABLE = "Leads"; // tblSwmF9acRsqsUYo
const RECEPTIONIST_ASSISTANT_ID = "c344f0e6-bec5-4390-badf-340519eb9334";
const SALES_CALLBACK_ASSISTANT_ID = "936d390b-b88c-4f71-92bb-c79c6d446168"; // Alex
const OWNER_MOBILE = "+18042535119";
const TELNYX_FROM = "+15402157422";

// Mirrors the VOICES map in nmln-automation-worker.js — keep in sync if voices change
const VOICES = {
  asteria: { name: "Alex",   provider: "deepgram", voiceId: "asteria" },
  luna:    { name: "Luna",   provider: "deepgram", voiceId: "luna"    },
  athena:  { name: "Athena", provider: "deepgram", voiceId: "athena"  },
  orion:   { name: "Orion",  provider: "deepgram", voiceId: "orion"   },
};

// Look up a single record in an Airtable table by an exact field match.
async function lookupRecord(env, table, field, value) {
  const formula = encodeURIComponent(`({${field}}="${value}")`);
  const url = `https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${table}?filterByFormula=${formula}&maxRecords=1`;
  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${env.AIRTABLE_TOKEN}`,
      "Content-Type": "application/json"
    }
  });
  const data = await res.json();
  return data?.records?.[0] || null;
}

// Generic variables for an unidentified caller — keeps Alex able to pitch anyone.
function genericAlexVars(callerNumber) {
  return {
    businessName: "your business",
    trade: "home services",
    city: "your area",
    state: "",
    phone: callerNumber || "",
    isLead: true
  };
}

// ── Spam filtering — area-code blocklist + number blocklist + auto-block ──────
// Vapi provides no built-in spam signal (confirmed against their docs) — the
// caller's raw number is all you get. Three layers here:
//   1. Area-code blocklist (permanent, GET /admin/block-area) — instant reject.
//      Added 2026-07-15 after confirmed evidence (Vapi call export analysis):
//      45 of 85 recent calls to this line were from area code 720, ALL 45
//      unique numbers — a rotating-number spam pattern that per-number
//      blocking can never catch, since no single number repeats.
//   2. Manual number blocklist (permanent, GET /admin/block) — instant reject
//   3. Auto-block: if the same number calls AUTO_BLOCK_THRESHOLD times within
//      AUTO_BLOCK_WINDOW_SECONDS, it's promoted to the permanent number
//      blocklist too — catches non-rotating repeat spam that layer 1 misses.
// All three run before any Airtable lookup and before the "unknown caller"
// SMS alert to OWNER_MOBILE fires — that SMS firing on every robocall was the
// actual cause of "spam every few minutes" texts, not the calls ringing through.
const AUTO_BLOCK_THRESHOLD = 3;       // calls...
const AUTO_BLOCK_WINDOW_SECONDS = 600; // ...within this many seconds -> auto-block

// NANP (US/Canada) area code: digits 2-4 of a +1XXXXXXXXXX number.
function areaCodeOf(e164Number) {
  const digits = (e164Number || "").replace(/\D/g, "");
  if (digits.length === 11 && digits[0] === "1") return digits.slice(1, 4);
  if (digits.length === 10) return digits.slice(0, 3);
  return null;
}

async function isSpam(env, callerNumber) {
  if (!callerNumber) return false;

  const areaCode = areaCodeOf(callerNumber);
  if (areaCode && (await env.SPAM_FILTER.get(`block-area:${areaCode}`))) {
    console.log(`Blocked by area-code rule: ${callerNumber} (area code ${areaCode})`);
    return true;
  }

  const blockKey = `block:${callerNumber}`;
  if (await env.SPAM_FILTER.get(blockKey)) return true;

  const countKey = `count:${callerNumber}`;
  const current = parseInt((await env.SPAM_FILTER.get(countKey)) || "0", 10);
  const next = current + 1;

  if (next >= AUTO_BLOCK_THRESHOLD) {
    // Promote to permanent block — no expiration, stays until manually removed.
    await env.SPAM_FILTER.put(blockKey, new Date().toISOString());
    await env.SPAM_FILTER.delete(countKey);
    console.log(`Auto-blocked ${callerNumber} after ${next} calls in ${AUTO_BLOCK_WINDOW_SECONDS}s`);
    return true;
  }

  await env.SPAM_FILTER.put(countKey, String(next), { expirationTtl: AUTO_BLOCK_WINDOW_SECONDS });
  return false;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── Admin: manage the spam blocklist ──
    // GET /admin/block?number=%2B15551234567&key=ADMIN_KEY   — add number to blocklist
    // GET /admin/unblock?number=%2B15551234567&key=ADMIN_KEY — remove number
    // GET /admin/block-area?code=720&key=ADMIN_KEY           — block a whole area code
    // GET /admin/unblock-area?code=720&key=ADMIN_KEY         — remove an area-code block
    // GET /admin/blocklist?key=ADMIN_KEY                     — list current blocks (both kinds)
    if (request.method === "GET" && url.pathname.startsWith("/admin/")) {
      if (url.searchParams.get("key") !== env.ADMIN_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }
      const number = url.searchParams.get("number");
      const code = url.searchParams.get("code");

      if (url.pathname === "/admin/block" && number) {
        await env.SPAM_FILTER.put(`block:${number}`, new Date().toISOString());
        return Response.json({ blocked: number });
      }
      if (url.pathname === "/admin/unblock" && number) {
        await env.SPAM_FILTER.delete(`block:${number}`);
        return Response.json({ unblocked: number });
      }
      if (url.pathname === "/admin/block-area" && code) {
        await env.SPAM_FILTER.put(`block-area:${code}`, new Date().toISOString());
        return Response.json({ blockedAreaCode: code });
      }
      if (url.pathname === "/admin/unblock-area" && code) {
        await env.SPAM_FILTER.delete(`block-area:${code}`);
        return Response.json({ unblockedAreaCode: code });
      }
      if (url.pathname === "/admin/blocklist") {
        const numbers = await env.SPAM_FILTER.list({ prefix: "block:" });
        const areaCodes = await env.SPAM_FILTER.list({ prefix: "block-area:" });
        return Response.json({
          blockedNumbers: numbers.keys.map(k => k.name.replace("block:", "")),
          blockedAreaCodes: areaCodes.keys.map(k => k.name.replace("block-area:", ""))
        });
      }
      return new Response("Not found", { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response("Invalid JSON", { status: 400 });
    }

    const messageType = body?.message?.type;

    // ── Identify the client by the Vapi number that received the call ──
    // Each client has their own dedicated Vapi number stored as "forwarding_number".
    const receivingNumber = body?.message?.call?.phoneNumber?.number;
    const callerNumber = body?.message?.call?.customer?.number;

    console.log("Event type:", messageType);
    console.log("Receiving number (client's Vapi number):", receivingNumber);
    console.log("Caller number (homeowner/lead):", callerNumber);

    // Handle assistant-request — fires before call connects
    if (messageType === "assistant-request") {

      // ── 0. Spam check — before any Airtable lookups or SMS alerts ──
      if (await isSpam(env, callerNumber)) {
        console.log("Rejected spam call from:", callerNumber);
        return Response.json({ error: "This number is not accepting calls at this time." });
      }

      // ── 1. Clients table by forwarding_number → production Receptionist ──
      if (receivingNumber) {
        try {
          const clientRec = await lookupRecord(env, CLIENTS_TABLE, "forwarding_number", receivingNumber);
          if (clientRec) {
            const record = clientRec.fields;
            console.log("Matched client:", JSON.stringify(record["Business Name"]));

            // Apply the voice the business owner chose during signup.
            // Falls back to asteria (Alex) if not set or unrecognised.
            const voiceKey  = record["Voice"] || "asteria";
            const voiceInfo = VOICES[voiceKey] || VOICES["asteria"];
            console.log("Voice for this client:", voiceKey, "→", voiceInfo.name);

            return Response.json({
              assistantId: RECEPTIONIST_ASSISTANT_ID,
              assistantOverrides: {
                firstMessage: `${record["Business Name"] || "Hello"}, this is ${voiceInfo.name} — how can I help you?`,
                voice: { provider: voiceInfo.provider, voiceId: voiceInfo.voiceId },
                variableValues: {
                  businessName:           record["Business Name"] || "",
                  ownerName:              record["Owner Name"] || "",
                  businessHours:          record["Business Hours"] || "",
                  services:               record["Service Area"] || "",
                  address:                record["Address"] || "",
                  ownerEmergencyNumber:   record["Owner Mobile"] || "",
                  pricingPreference:      record["Pricing Preferences"] || "",
                  trade:                  record["Trade"] || "",
                  businessKnowledge:      record["Business Knowledge"] || "",
                  voiceName:              voiceInfo.name,
                  clientRecordId:         clientRec.id,
                  calendarConnected:      record["Calendar Connected"] === true
                }
              }
            });
          }
          console.log("Receiving number not a known client:", receivingNumber);
        } catch (err) {
          // A live client call must never fall through to the sales pitch on a transient
          // error — return the Receptionist (the pre-fallback default behavior).
          console.error("Clients lookup error — defaulting to Receptionist:", err.message);
          return Response.json({ assistantId: RECEPTIONIST_ASSISTANT_ID });
        }
      }

      // ── 2. Fallback: Leads table by caller's phone → Alex Sales Callback ──
      if (callerNumber) {
        try {
          const leadRec = await lookupRecord(env, LEADS_TABLE, "Phone", callerNumber);
          if (leadRec) {
            const f = leadRec.fields;
            console.log("Matched lead:", JSON.stringify(f["Business Name"]));

            // Mark Call Back Received without blocking the response
            ctx.waitUntil(
              fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${LEADS_TABLE}/${leadRec.id}`, {
                method: "PATCH",
                headers: {
                  "Authorization": `Bearer ${env.AIRTABLE_TOKEN}`,
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({ fields: { "Call Back Received": true } })
              })
            );

            return Response.json({
              assistantId: SALES_CALLBACK_ASSISTANT_ID,
              assistantOverrides: {
                variableValues: {
                  businessName: f["Business Name"] || "",
                  trade:        f["Trade"] || "",
                  city:         f["City"] || "",
                  state:        f["State"] || "",
                  phone:        callerNumber,
                  isLead:       true
                }
              }
            });
          }
          console.log("Caller not in Leads table:", callerNumber);
        } catch (err) {
          console.error("Leads lookup error — using generic Alex:", err.message);
        }
      }

      // ── 3. Found in neither table → Alex with generic variables ──
      console.log("No client/lead match — routing to Alex with generic variables");
      ctx.waitUntil(
        fetch("https://api.telnyx.com/v2/messages", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.TELNYX_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            from: TELNYX_FROM,
            to: OWNER_MOBILE,
            text: `NMLN: Unknown caller ${callerNumber || "(no number)"} reached the line — not in Clients or Leads. Routed to Alex with generic pitch.`
          })
        })
      );
      return Response.json({
        assistantId: SALES_CALLBACK_ASSISTANT_ID,
        assistantOverrides: { variableValues: genericAlexVars(callerNumber) }
      });
    }

    // Handle end-of-call-report — transfer failure alert
    if (messageType === "end-of-call-report") {
      const endedReason = body?.message?.call?.endedReason;

      if (endedReason === "transfer-failed") {
        ctx.waitUntil(
          fetch("https://api.telnyx.com/v2/messages", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.TELNYX_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              from: TELNYX_FROM,
              to: OWNER_MOBILE,
              text: `NMLN EMERGENCY TRANSFER MISSED: ${callerNumber} called — transfer FAILED. Call them back NOW: ${callerNumber}`
            })
          })
        );
      }
    }

    return new Response("OK", { status: 200 });
  }
};
