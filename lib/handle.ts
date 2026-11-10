// The full flow for one Instantly reply event. Dependencies are injected so tests can run it without network.

import { decide, precheck } from "./decide.js";
import type { ClientContext, Decision, Draft, InstantlyReplyEvent } from "./types.js";

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
}

export async function handleReply(clientId: string, event: InstantlyReplyEvent, deps: Deps): Promise<Decision> {
  if (event.event_type !== "reply_received" || !event.email_id) {
    return { action: "ignore", reason: `event ${event.event_type}` };
  }

  // Dedupe first: one reply per inbound email, ever.
  if (!(await deps.claimEvent(clientId, event.email_id))) {
    return { action: "ignore", reason: "already handled" };
  }

  const ctx = await deps.getClientContext(clientId, event);
  const pre = precheck(event, ctx);
  if (pre) return pre;

  const draft = await deps.draftReply(event, ctx);
  const decision = decide(event, ctx, draft, {
    sendingEnabled: deps.sendingEnabled,
    autoSentToday: await deps.autoSentToday(clientId),
  });

  const base = { emailId: event.email_id, leadEmail: event.lead_email, campaignId: event.campaign_id, reason: decision.reason };

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
