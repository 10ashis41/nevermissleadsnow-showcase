const AIRTABLE_TABLE = "Leads";
const SALES_CALLBACK_ASSISTANT_ID = "936d390b-b88c-4f71-92bb-c79c6d446168";
const OWNER_MOBILE = "+18042535119";
const TELNYX_FROM = "+15402157422";

export default {
  async fetch(request, env, ctx) {

    // Only accept POST requests
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

    // Handle assistant-request — fires before call connects
    if (messageType === "assistant-request") {

      if (!callerNumber) {
        console.log("No caller number — returning default Sales Callback assistant");
        return Response.json({
          assistantId: SALES_CALLBACK_ASSISTANT_ID
        });
      }

      // Look up caller in Airtable Leads table
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
          // Mark Call Back Received = true without blocking response
          if (recordId) {
            ctx.waitUntil(
              fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${AIRTABLE_TABLE}/${recordId}`, {
                method: "PATCH",
                headers: {
                  "Authorization": `Bearer ${env.AIRTABLE_TOKEN}`,
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  fields: { "Call Back Received": true }
                })
              })
            );
          }

          return Response.json({
            assistantId: SALES_CALLBACK_ASSISTANT_ID,
            assistantOverrides: {
              variableValues: {
                businessName: record["Business Name"] || "",
                trade: record["Trade"] || "",
                website: record["Website"] || "",
                city: record["City"] || "",
                state: record["State"] || "",
                phone: callerNumber
              }
            }
          });

        } else {
          // Lead not found — alert Eric and connect anyway
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
                to: OWNER_MOBILE,
                text: `NMLN: Unknown caller ${callerNumber} called back Sales line. Not in Leads table. Consider adding manually.`
              })
            })
          );

          return Response.json({
            assistantId: SALES_CALLBACK_ASSISTANT_ID
          });
        }

      } catch (err) {
        console.error("Airtable lookup error:", err.message);
        return Response.json({
          assistantId: SALES_CALLBACK_ASSISTANT_ID
        });
      }
    }

    // Default response for all other event types
    return new Response("OK", { status: 200 });
  }
};
