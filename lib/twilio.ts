import "server-only";

/**
 * Send SMS via Twilio REST API. No extra deps; uses fetch.
 * Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_PHONE (e164).
 */
export async function sendSms(toE164: string, body: string): Promise<{ sid?: string; error?: string }> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_PHONE;
  if (!sid || !token || !from) {
    return { error: "Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_FROM_PHONE" };
  }
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: toE164, From: from, Body: body }),
  });
  const data = (await res.json()) as { sid?: string; message?: string; error_message?: string };
  if (!res.ok) {
    return { error: data.error_message ?? data.message ?? `Twilio ${res.status}` };
  }
  return { sid: data.sid };
}
