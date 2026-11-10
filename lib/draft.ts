// Drafts a reply with Claude using only the client's Brain.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { ClientContext, Draft, InstantlyReplyEvent } from "./types.js";

/** Keep only the lead's new text: drop quoted history ("> ..." lines and everything from "On ... wrote:"). */
export function latestReplyText(raw: string): string {
  const lines = raw.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*On .+wrote:\s*$/i.test(line) || /^\s*On .+(\d{4}|AM|PM).*$/i.test(line) && /wrote/i.test(line)) break;
    if (/^\s*-{2,}\s*Original Message/i.test(line) || /^\s*From:\s/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  const t = out.join("\n").trim();
  return t || raw.trim();
}

export function buildSystemPrompt(ctx: ClientContext): string {
  const brain = ctx.brain
    .map((d) => `<doc title="${d.title.replace(/"/g, "'")}" tag="${d.tag}">\n${d.text}\n</doc>`)
    .join("\n\n");
  const booking =
    ctx.bookingMode === "calendar_link" && ctx.bookingLink
      ? `When the lead wants to meet, send this booking link: ${ctx.bookingLink}. Do not propose specific times.`
      : `When the lead wants to meet, propose that they pick a time and offer to send times. Do not invent a calendar link.`;
  return [
    `You write email replies on behalf of ${ctx.clientName} to leads who answered a cold email.`,
    `Use ONLY facts found in the Brain documents below. Never invent prices, discounts, offers, guarantees, results, case studies or availability.`,
    `If answering well needs a fact that is not in the Brain, write the best safe reply you can without that fact and set needs_human to true.`,
    `Keep replies short (2 to 5 sentences), plain text, friendly and direct. No hyphens or dashes. No emojis. No subject line in the body.`,
    `The goal is a booked call. ${booking}`,
    ctx.senderName ? `Sign off as ${ctx.senderName}.` : `Do not add a signature; the sending inbox adds one.`,
    ctx.replyGuidelines ? `Client guidelines:\n${ctx.replyGuidelines}` : "",
    `Do not reply (should_reply false) to out of office notices, unsubscribe requests, clear rejections, or wrong person replies.`,
    `Always answer by calling the submit_reply tool exactly once. Do not write any other text.`,
    `When should_reply is true, body MUST contain the complete email text to send, written out in full (for example the actual proposed times or the booking link). Never describe what you would send instead of writing it, and never refer to a template by name.`,
    `<brain>\n${brain || "(empty)"}\n</brain>`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const TOOL = {
  name: "submit_reply",
  description: "Submit the classification and, if appropriate, the reply to send.",
  input_schema: {
    type: "object" as const,
    properties: {
      classification: {
        type: "string",
        enum: ["interested", "question", "meeting_request", "not_interested", "out_of_office", "unsubscribe", "wrong_person", "other"],
      },
      should_reply: { type: "boolean" },
      reason: { type: "string", description: "One short sentence explaining the choice." },
      body: { type: "string", description: "The reply text. Empty when should_reply is false." },
      needs_human: { type: "boolean", description: "True if a needed fact is missing from the Brain." },
    },
    required: ["classification", "should_reply", "reason", "needs_human"],
  },
};

export async function draftReply(event: InstantlyReplyEvent, ctx: ClientContext): Promise<Draft> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey() });
  const thread = (ctx.thread || [])
    .map((m) => `${m.from === "lead" ? "LEAD" : "US"}${m.at ? ` (${m.at})` : ""}: ${m.text}`)
    .join("\n\n");
  const latest = latestReplyText(event.reply_text || event.reply_text_snippet || "");

  const res = await client.messages.create({
    model: config.model(),
    max_tokens: 800,
    system: buildSystemPrompt(ctx),
    tools: [TOOL],
    tool_choice: { type: "auto" },
    messages: [
      {
        role: "user",
        content: `Earlier thread:\n${thread || "(none)"}\n\nLatest reply from the lead (${event.lead_email}):\n${latest}`,
      },
    ],
  });

  const block = res.content.find((b) => b.type === "tool_use");
  let i: Record<string, unknown>;
  if (block && block.type === "tool_use") {
    i = block.input as Record<string, unknown>;
  } else {
    // Fallback: the model answered in text. Try to read a JSON object, else treat the text as the draft for review.
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const m = text.match(/\{[\s\S]*\}/);
    try {
      i = m ? JSON.parse(m[0]) : {};
    } catch {
      i = {};
    }
    if (!i.classification) i = { classification: "other", should_reply: Boolean(text), reason: "model did not use the tool", body: text, needs_human: true };
  }
  const body = typeof i.body === "string" ? i.body.trim() : "";
  return {
    classification: (i.classification as Draft["classification"]) || "other",
    shouldReply: Boolean(i.should_reply) && body.length > 0,
    reason: String(i.reason || ""),
    body: body || undefined,
    subject: event.reply_subject?.startsWith("Re:") ? event.reply_subject : `Re: ${event.reply_subject || ""}`.trim(),
    needsHuman: Boolean(i.needs_human),
  };
}
