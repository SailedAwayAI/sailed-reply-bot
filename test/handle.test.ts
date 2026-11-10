import { test } from "node:test";
import assert from "node:assert/strict";
import { handleReply, type Deps } from "../lib/handle.js";
import type { ClientContext, Draft, InstantlyReplyEvent } from "../lib/types.js";

const now = new Date().toISOString();
const event = (over: Partial<InstantlyReplyEvent> = {}): InstantlyReplyEvent => ({
  event_type: "reply_received",
  email_id: "e1",
  lead_email: "lead@x.com",
  email_account: "inbox@client.com",
  campaign_id: "c1",
  reply_subject: "Quick question",
  reply_text: "Sounds interesting, how does it work?",
  timestamp: now,
  ...over,
});
const ctx = (over: Partial<ClientContext> = {}): ClientContext => ({
  clientId: "acme",
  clientName: "Acme",
  campaigns: { c1: { mode: "auto" } },
  defaultMode: "manual",
  bookingMode: "calendar_link",
  bookingLink: "https://cal.com/acme",
  dailyAutoCap: 25,
  brain: [{ title: "Offer", tag: "product information", text: "We book meetings." }],
  ...over,
});
const goodDraft: Draft = { classification: "question", shouldReply: true, reason: "asked how", body: "Happy to explain.", subject: "Re: Quick question", needsHuman: false };

function deps(over: Partial<Deps> & { ctx?: ClientContext; draft?: Draft; sent?: number } = {}) {
  const log: string[] = [];
  const seen = new Set<string>();
  const d: Deps = {
    claimEvent: async (_c, id) => (seen.has(id) ? false : (seen.add(id), true)),
    getClientContext: async () => over.ctx ?? ctx(),
    draftReply: async () => over.draft ?? goodDraft,
    autoSentToday: async () => over.sent ?? 0,
    countAutoSend: async () => void log.push("count"),
    sendInstantlyReply: async () => void log.push("SEND"),
    reportToDashboard: async (_c, p) => void log.push(`dash:${p.type}`),
    notifyAgency: async () => void log.push("slack"),
    sendingEnabled: true,
    ...over,
  };
  return { d, log };
}

test("auto campaign with sending on sends once", async () => {
  const { d, log } = deps();
  assert.equal((await handleReply("acme", event(), d)).action, "send");
  assert.deepEqual(log, ["SEND", "count", "dash:sent"]);
});

test("same email delivered twice is only handled once", async () => {
  const { d, log } = deps();
  await handleReply("acme", event(), d);
  assert.equal((await handleReply("acme", event(), d)).action, "ignore");
  assert.equal(log.filter((x) => x === "SEND").length, 1);
});

test("manual campaign drafts for review and notifies agency, never sends", async () => {
  const { d, log } = deps({ ctx: ctx({ campaigns: { c1: { mode: "manual" } } }) });
  assert.equal((await handleReply("acme", event(), d)).action, "draft_for_review");
  assert.deepEqual(log, ["dash:draft", "slack"]);
});

test("global sending switch off never sends", async () => {
  const { d, log } = deps({ sendingEnabled: false });
  assert.equal((await handleReply("acme", event(), d)).action, "draft_for_review");
  assert.ok(!log.includes("SEND"));
});

test("daily cap reached falls back to review", async () => {
  const { d, log } = deps({ sent: 25 });
  assert.equal((await handleReply("acme", event(), d)).action, "draft_for_review");
  assert.ok(!log.includes("SEND"));
});

test("needs a fact not in the Brain falls back to review", async () => {
  const { d, log } = deps({ draft: { ...goodDraft, needsHuman: true } });
  assert.equal((await handleReply("acme", event(), d)).action, "draft_for_review");
  assert.ok(!log.includes("SEND"));
});

test("out of office is skipped", async () => {
  const { d, log } = deps({ draft: { ...goodDraft, classification: "out_of_office", shouldReply: false, body: undefined } });
  assert.equal((await handleReply("acme", event(), d)).action, "skip");
  assert.ok(!log.includes("SEND"));
});

test("lost lead is skipped before Claude is called", async () => {
  let drafted = false;
  const { d } = deps({ ctx: ctx({ leadStatus: "Lost" }), draftReply: async () => ((drafted = true), goodDraft) });
  assert.equal((await handleReply("acme", event(), d)).action, "skip");
  assert.equal(drafted, false);
});

test("reply older than 48 hours is skipped (old events re-fired)", async () => {
  const { d, log } = deps();
  const old = new Date(Date.now() - 3 * 86400000).toISOString();
  assert.equal((await handleReply("acme", event({ timestamp: old }), d)).action, "skip");
  assert.ok(!log.includes("SEND"));
});

test("campaign switched off is skipped", async () => {
  const { d } = deps({ ctx: ctx({ campaigns: { c1: { mode: "off" } } }) });
  assert.equal((await handleReply("acme", event(), d)).action, "skip");
});

test("unknown campaign uses client default (manual)", async () => {
  const { d, log } = deps();
  assert.equal((await handleReply("acme", event({ campaign_id: "other" }), d)).action, "draft_for_review");
  assert.ok(!log.includes("SEND"));
});

test("non reply events are ignored", async () => {
  const { d, log } = deps();
  assert.equal((await handleReply("acme", event({ event_type: "lead_interested" }), d)).action, "ignore");
  assert.deepEqual(log, []);
});

test("test mode never sends and never drafts into Unibox, only Slack and a log entry", async () => {
  const { d, log } = deps({ testMode: true });
  assert.equal((await handleReply("acme", event(), d)).action, "send");
  assert.deepEqual(log, ["slack", "dash:skipped"]);
});

test("test mode also posts skips to Slack so nothing is silent", async () => {
  const { d, log } = deps({ testMode: true, ctx: ctx({ campaigns: { c1: { mode: "off" } } }) });
  assert.equal((await handleReply("acme", event(), d)).action, "skip");
  assert.deepEqual(log, ["slack"]);
});
