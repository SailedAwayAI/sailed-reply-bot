// Pure decision rules. No network calls here, so every rule is covered by tests.

import type { ClientContext, Decision, Draft, InstantlyReplyEvent, CampaignMode } from "./types.js";

/** Lead statuses the bot must never reply to. Compared case insensitively. */
const DO_NOT_REPLY_STATUSES = ["lost", "not interested", "unsubscribed", "do not contact", "wrong person", "won"];

/** Classifications that never get a reply. */
const NO_REPLY_CLASSES = new Set(["not_interested", "out_of_office", "unsubscribe", "wrong_person"]);

export function campaignMode(ctx: ClientContext, campaignId?: string): CampaignMode {
  if (campaignId && ctx.campaigns[campaignId]) return ctx.campaigns[campaignId].mode;
  return ctx.defaultMode;
}

/** Step 1: before calling Claude. Cheap checks that rule an event out entirely. */
export function precheck(event: InstantlyReplyEvent, ctx: ClientContext): Decision | null {
  if (event.event_type !== "reply_received") return { action: "ignore", reason: `event ${event.event_type}` };
  if (!event.email_id) return { action: "ignore", reason: "no email_id" };
  if (!event.lead_email) return { action: "ignore", reason: "no lead_email" };
  const text = (event.reply_text || event.reply_text_snippet || "").trim();
  if (!text) return { action: "skip", reason: "empty reply" };

  const mode = campaignMode(ctx, event.campaign_id);
  if (mode === "off") return { action: "skip", reason: "reply bot off for this campaign" };

  const status = (ctx.leadStatus || "").toLowerCase();
  if (DO_NOT_REPLY_STATUSES.some((s) => status === s)) {
    return { action: "skip", reason: `lead status is ${ctx.leadStatus}` };
  }

  // Ignore replies older than 48 hours. Protects against Instantly re-firing old events.
  if (event.timestamp) {
    const ageMs = Date.now() - new Date(event.timestamp).getTime();
    if (Number.isFinite(ageMs) && ageMs > 48 * 3600 * 1000) {
      return { action: "skip", reason: "reply is older than 48 hours" };
    }
  }
  return null;
}

/** Step 2: after Claude drafted. Decide whether to send, queue for review, or skip. */
export function decide(
  event: InstantlyReplyEvent,
  ctx: ClientContext,
  draft: Draft,
  opts: { sendingEnabled: boolean; autoSentToday: number },
): Decision {
  if (NO_REPLY_CLASSES.has(draft.classification) || !draft.shouldReply || !draft.body) {
    return { action: "skip", reason: `no reply needed (${draft.classification}): ${draft.reason}` };
  }
  const mode = campaignMode(ctx, event.campaign_id);
  if (mode !== "auto") return { action: "draft_for_review", reason: "campaign is Manual" };
  if (!opts.sendingEnabled) return { action: "draft_for_review", reason: "global sending switch is off" };
  if (draft.needsHuman) return { action: "draft_for_review", reason: "draft needs a fact not in the Brain" };
  if (opts.autoSentToday >= ctx.dailyAutoCap) {
    return { action: "draft_for_review", reason: `daily auto cap of ${ctx.dailyAutoCap} reached` };
  }
  return { action: "send", reason: "campaign is Auto" };
}
