// The full flow for one Instantly reply event. Dependencies are injected so tests can run it without network.

import { decide, precheck } from "./decide.js";
import { createHash } from "node:crypto";
import type { ClientContext, Decision, Draft, InstantlyReplyEvent } from "./types.js";

export function dedupeKey(event: InstantlyReplyEvent): string {
  const text = (event.reply_text || event.reply_text_snippet || "").trim();
  const h = createHash("sha256").update(`${event.timestamp || ""}|${text}`).digest("hex").slice(0, 16);
  return `${event.email_id}:${h}`;
}

export interface Deps {
  claimEvent(clientId: string, emailId: string): Promise<boolean>;
  getClientContext(clientId: string, event: InstantlyReplyEvent): Promise<ClientContext>;
  draftReply(event: InstantlyReplyEvent, ctx: ClientContext): Promise<Draft>;
  autoSentToday(clientId: string): Promise<number>;
  countAutoSend(clientId: string): Promise<void>;
  sendInstantlyReply(clientId: string, event: InstantlyReplyEvent, subject: string, body: string): Promise<void>;
  reportToDashboard(clientId: string, payload: Parameters<typeof import("./services.js").reportToDashboard>[1]): Promise<void>;
  notifyAgency(text: string): Promise<void>;
  sendingEnabled: boolean;
  /** Side by side test: draft and post to Slack only. */
  testMode?: boolean;
}

export async function handleReply(clientId: string, event: InstantlyReplyEvent, deps: Deps): Promise<Decision> {
  if (event.event_type !== "reply_received" || !event.email_id) {
    if (deps.testMode) {
      // Show exactly what Instantly sent so a field name mismatch is obvious.
      await deps.notifyAgency(
        `*[Test mode] ${clientId}*: ignored an Instantly event (event_type=${event.event_type}, email_id=${event.email_id ? "present" : "missing"}). Fields received: ${Object.keys(event).join(", ")}`,
      );
    }
    return { action: "ignore", reason: `event ${event.event_type}` };
  }

  // Dedupe first: one reply per inbound message, ever. Instantly may reuse email_id across a thread,
  // so the key also includes the reply time and a hash of the reply text.
  const key = dedupeKey(event);
  if (!(await deps.claimEvent(clientId, key))) {
    if (deps.testMode) await deps.notifyAgency(`*[Test mode] ${clientId}*: ${event.lead_email} ignored as a duplicate delivery of the same reply.`);
    return { action: "ignore", reason: "already handled" };
  }

  const ctx = await deps.getClientContext(clientId, event);
  const pre = precheck(event, ctx);
  if (pre) {
    if (deps.testMode) {
      await deps.notifyAgency(`*[Test mode] ${ctx.clientName}*: ${event.lead_email} would SKIP before drafting: ${pre.reason}`);
    }
    return pre;
  }

  const draft = await deps.draftReply(event, ctx);
  const decision = decide(event, ctx, draft, {
    sendingEnabled: deps.sendingEnabled,
    autoSentToday: await deps.autoSentToday(clientId),
  });

  const base = { emailId: event.email_id, leadEmail: event.lead_email, campaignId: event.campaign_id, reason: decision.reason };

  // Test mode: run side by side with the dashboard's own bot. Never send, never put a draft in Unibox.
  // Post what the new bot would have done to the agency Slack channel for comparison.
  if (deps.testMode) {
    const lead = (event.reply_text || event.reply_text_snippet || "").trim().slice(0, 500);
    const would =
      decision.action === "send" ? "would SEND" : decision.action === "draft_for_review" ? "would queue for REVIEW" : "would SKIP";
    await deps.notifyAgency(
      [
        `*[Test mode] ${ctx.clientName}*: ${event.lead_email} (${draft.classification}), ${would}: ${decision.reason}`,
        `> Lead: ${lead.replace(/\n/g, "\n> ")}`,
        draft.body ? `New bot draft:\n\`\`\`${draft.body}\`\`\`` : "",
        ctx.uniboxUrl ? `<${ctx.uniboxUrl}|Open in Unibox>` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    await deps.reportToDashboard(clientId, { ...base, type: "skipped", body: draft.body, reason: `test mode: ${would}: ${decision.reason}` });
    return decision;
  }

  if (decision.action === "send") {
    await deps.sendInstantlyReply(clientId, event, draft.subject || "Re:", draft.body!);
    await deps.countAutoSend(clientId);
    await deps.reportToDashboard(clientId, { ...base, type: "sent", body: draft.body });
  } else if (decision.action === "draft_for_review") {
    await deps.reportToDashboard(clientId, { ...base, type: "draft", body: draft.body });
    const link = ctx.uniboxUrl ? ` <${ctx.uniboxUrl}|Open in Unibox>` : "";
    await deps.notifyAgency(`Review draft for ${event.lead_email} at ${ctx.clientName} (${decision.reason}).${link}`);
  } else {
    await deps.reportToDashboard(clientId, { ...base, type: "skipped" });
  }
  return decision;
}
