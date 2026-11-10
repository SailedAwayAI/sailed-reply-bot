// Instantly webhook receiver. URL: https://<app>.vercel.app/api/instantly?client=<clientId>&secret=<WEBHOOK_SECRET>
// Subscribe only the reply_received event in each client's Instantly workspace.

import { timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { config } from "../lib/config.js";
import { draftReply } from "../lib/draft.js";
import { handleReply } from "../lib/handle.js";
import * as svc from "../lib/services.js";
import type { InstantlyReplyEvent } from "../lib/types.js";

function secretOk(given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(config.webhookSecret());
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (!secretOk(url.searchParams.get("secret"))) return new Response("unauthorized", { status: 401 });

  const clientId = url.searchParams.get("client") || "";
  if (!/^[a-z0-9_-]{2,64}$/i.test(clientId)) return new Response("bad client", { status: 400 });

  let event: InstantlyReplyEvent;
  try {
    event = (await request.json()) as InstantlyReplyEvent;
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // Answer Instantly right away; do the work in the background so Instantly does not time out and retry.
  waitUntil(
    handleReply(clientId, event, {
      ...svc,
      draftReply,
      sendingEnabled: config.sendingEnabled(),
    })
      .then((d) => console.log(JSON.stringify({ clientId, emailId: event.email_id, ...d })))
      .catch(async (err) => {
        console.error(clientId, event.email_id, err);
        await svc.notifyAgency(`Reply bot error for ${clientId} (${event.lead_email || "unknown lead"}): ${String(err).slice(0, 300)}`);
        if (event.email_id) {
          await svc
            .reportToDashboard(clientId, { type: "error", emailId: event.email_id, leadEmail: event.lead_email, reason: String(err).slice(0, 300) })
            .catch(() => undefined);
        }
      }),
  );
  return new Response("ok", { status: 200 });
}

export function GET(): Response {
  return new Response("reply bot is running", { status: 200 });
}
