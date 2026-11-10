// Network calls: dashboard, Instantly, Slack, and the Redis store for dedupe and caps.

import { Redis } from "@upstash/redis";
import { config } from "./config.ts";
import type { ClientContext, InstantlyReplyEvent } from "./types.ts";

// ---------- Store (Upstash Redis via the Vercel Marketplace; reads UPSTASH_REDIS_REST_URL / _TOKEN) ----------

let redis: Redis | null = null;
function store(): Redis {
  if (!redis) redis = Redis.fromEnv();
  return redis;
}

/** Claims an email id. Returns false if another delivery already claimed it (Instantly retries, duplicates). */
export async function claimEvent(clientId: string, emailId: string): Promise<boolean> {
  const ok = await store().set(`seen:${clientId}:${emailId}`, Date.now(), { nx: true, ex: 60 * 60 * 24 * 30 });
  return ok === "OK";
}

function dayKey(clientId: string): string {
  const d = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return `auto:${clientId}:${d}`;
}

export async function autoSentToday(clientId: string): Promise<number> {
  return Number((await store().get(dayKey(clientId))) || 0);
}

export async function countAutoSend(clientId: string): Promise<void> {
  const k = dayKey(clientId);
  await store().incr(k);
  await store().expire(k, 60 * 60 * 48);
}

// ---------- Dashboard (source of truth for Brain and settings) ----------

async function dash(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${config.dashboardUrl()}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.dashboardToken()}`,
      "content-type": "application/json",
      ...(init?.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });
}

export async function getClientContext(clientId: string, event: InstantlyReplyEvent): Promise<ClientContext> {
  const q = new URLSearchParams({
    lead_email: event.lead_email || "",
    campaign_id: event.campaign_id || "",
    email_id: event.email_id || "",
  });
  const res = await dash(`/api/bot/clients/${encodeURIComponent(clientId)}/context?${q}`);
  if (!res.ok) throw new Error(`dashboard context ${res.status}`);
  return (await res.json()) as ClientContext;
}

/** Tell the dashboard what happened so Unibox shows the draft or the sent reply. */
export async function reportToDashboard(
  clientId: string,
  payload: {
    type: "draft" | "sent" | "skipped" | "error";
    emailId: string;
    leadEmail?: string;
    campaignId?: string;
    body?: string;
    reason: string;
  },
): Promise<void> {
  const res = await dash(`/api/bot/clients/${encodeURIComponent(clientId)}/events`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`dashboard events ${res.status}`);
}

// ---------- Instantly ----------

/** Sends the reply in the same thread via Instantly API v2. */
export async function sendInstantlyReply(clientId: string, event: InstantlyReplyEvent, subject: string, body: string): Promise<void> {
  const key = config.instantlyKeys()[clientId];
  if (!key) throw new Error(`no Instantly key for client ${clientId}`);
  if (!event.email_account || !event.email_id) throw new Error("missing email_account or email_id");
  const res = await fetch("https://api.instantly.ai/api/v2/emails/reply", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      eaccount: event.email_account,
      reply_to_uuid: event.email_id,
      subject,
      body: { text: body, html: body.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("") },
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Instantly reply ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------- Slack (agency channel only) ----------

export async function notifyAgency(text: string): Promise<void> {
  const url = config.agencySlackWebhook();
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => undefined);
}
