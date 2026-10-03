// nmln-demo-lookup-worker.js
// Handles assistant-request events for the NeverMissLeads demo line.
// Looks up the caller in the Airtable Leads table and injects business context
// into the Demo Receptionist assistant. Falls back gracefully if not found.

const AIRTABLE_TABLE = "Leads";
const DEMO_ASSISTANT_ID = "95af8a19-87f7-4a03-8a20-ee386fbdb099";
const ERIC_MOBILE = "+18042535119";
const TELNYX_FROM = "+15402157422";

function buildBusinessKnowledge(fields, businessName, trade, city, state, address) {
  let parts = [`${businessName} is a ${trade} contractor serving ${city}, ${state}.`];

  const rating = fields["Rating"];
  const reviewCount = fields["Review Count"];
  if (rating) {
    const reviewPart = reviewCount ? ` with ${reviewCount} reviews` : "";
    parts.push(`They have a ${rating}-star rating on Google${reviewPart}.`);
  }

  if (address) {
    parts.push(`Located at ${address}.`);
  }

  return parts.join(" ").replace(/  +/g, " ").trim();
}

export default {
  async fetch(request, env, ctx) {

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
    const callerNumber = body?.message?.call?.customer?.number;

    console.log("Event type:", messageType);
    console.log("Caller number:", callerNumber);

    if (messageType === "assistant-request") {

      if (!callerNumber) {
        console.log("No caller number — returning demo assistant with fallback variables");
        return Response.json({
          messageResponse: {
            assistantId: DEMO_ASSISTANT_ID,
            assistantOverrides: {
              variableValues: {
                businessName:    "your business",
                trade:           "home services",
                city:            "your area",
                state:           "",
                address:         "",
                businessHours:   "Monday through Friday, 8am to 6pm",
                businessKnowledge: "This business provides quality home services to local customers."
              }
            }
          }
        });
      }

      try {
        const formula = encodeURIComponent(`({Phone}="${callerNumber}")`);
        const airtableUrl = `https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${AIRTABLE_TABLE}?filterByFormula=${formula}`;

        const airtableRes = await fetch(airtableUrl, {
          headers: {
            "Authorization": `Bearer ${env.AIRTABLE_TOKEN}`,
            "Content-Type": "application/json"
          }
        });

        const airtableData = await airtableRes.json();
        const record = airtableData?.records?.[0]?.fields;
        const recordId = airtableData?.records?.[0]?.id;

        console.log("Airtable lead record:", JSON.stringify(record));

        if (record) {
          const getString = (val) => val?.name || val || "";
          const businessName    = getString(record["Business Name"]) || "your business";
          const trade           = getString(record["Trade"])         || "home services";
          const city            = getString(record["City"])          || "your area";
          const state           = getString(record["State"]);
          const address         = getString(record["Address"]);
          const businessHours   = getString(record["Business Hours"]) || "Monday through Friday, 8am to 6pm";
          const businessKnowledge = record["Business Knowledge"]
            ? record["Business Knowledge"]
            : buildBusinessKnowledge(record, businessName, trade, city, state, address);

          if (recordId) {
            ctx.waitUntil(
              fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${AIRTABLE_TABLE}/${recordId}`, {
                method: "PATCH",
                headers: {
                  "Authorization": `Bearer ${env.AIRTABLE_TOKEN}`,
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  fields: { "Called": true }
                })
              })
            );
          }

          return Response.json({
            messageResponse: {
              assistantId: DEMO_ASSISTANT_ID,
              assistantOverrides: {
                variableValues: {
                  businessName,
                  trade,
                  city,
                  state,
                  address,
                  businessHours,
                  businessKnowledge
                }
              }
            }
          });

        } else {
          console.log("Lead not found for number:", callerNumber);

          ctx.waitUntil(
            fetch("https://api.telnyx.com/v2/messages", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${env.TELNYX_API_KEY}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                from: TELNYX_FROM,
                to: ERIC_MOBILE,
                text: `Unknown caller ${callerNumber} just called the demo line — not in Leads table.`
              })
            })
          );

          return Response.json({
            messageResponse: {
              assistantId: DEMO_ASSISTANT_ID,
              assistantOverrides: {
                variableValues: {
                  businessName:    "your business",
                  trade:           "home services",
                  city:            "your area",
                  state:           "",
                  address:         "",
                  businessHours:   "Monday through Friday, 8am to 6pm",
                  businessKnowledge: "This business provides quality home services to local customers."
                }
              }
            }
          });
        }

      } catch (err) {
        console.error("Airtable lookup error:", err.message);
        return Response.json({
          messageResponse: {
            assistantId: DEMO_ASSISTANT_ID,
            assistantOverrides: {
              variableValues: {
                businessName:    "your business",
                trade:           "home services",
                city:            "your area",
                state:           "",
                address:         "",
                businessHours:   "Monday through Friday, 8am to 6pm",
                businessKnowledge: "This business provides quality home services to local customers."
              }
            }
          }
        });
      }
    }

    return new Response("OK", { status: 200 });
  }
};
