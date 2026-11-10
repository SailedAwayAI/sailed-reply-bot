// Shapes shared across the bot.

/** The subset of an Instantly webhook payload the bot relies on. Instantly sends more fields; unknown ones are ignored. */
export interface InstantlyReplyEvent {
  event_type: string;
  timestamp?: string;
  workspace?: string;
  campaign_id?: string;
  campaign_name?: string;
  lead_email?: string;
  email_account?: string; // the sending inbox that received the reply
  email_id?: string; // id of the reply email; used for dedupe and as reply_to_uuid
  reply_subject?: string;
  reply_text?: string;
  reply_text_snippet?: string;
  reply_html?: string;
  is_first?: boolean;
  [key: string]: unknown;
}

export type CampaignMode = "auto" | "manual" | "off";
export type BookingMode = "auto_book" | "calendar_link";

/** What the dashboard returns from its read only bot context endpoint for one client. */
export interface ClientContext {
  clientId: string;
  clientName: string;
  /** Campaign level settings keyed by Instantly campaign id. Missing campaign = use defaultMode. */
  campaigns: Record<string, { mode: CampaignMode; name?: string }>;
  defaultMode: CampaignMode;
  bookingMode: BookingMode;
  bookingLink?: string;
  dailyAutoCap: number;
  /** Brain documents, already tagged. Text only. */
  brain: Array<{ title: string; tag: string; text: string }>;
  /** Optional voice and rules the client set for the bot. */
  replyGuidelines?: string;
  senderName?: string;
  /** Lead's current dashboard status, so the bot does not reply to Lost / Not interested leads. */
  leadStatus?: string;
  /** Link to this conversation in the client Unibox, for review notices. */
  uniboxUrl?: string;
  /** Earlier messages in the thread, oldest first. */
  thread?: Array<{ from: "lead" | "us"; text: string; at?: string }>;
}

export type Classification =
  | "interested"
  | "question"
  | "meeting_request"
  | "not_interested"
  | "out_of_office"
  | "unsubscribe"
  | "wrong_person"
  | "other";

export interface Draft {
  classification: Classification;
  shouldReply: boolean;
  reason: string;
  subject?: string;
  body?: string;
  /** True if the draft needed a fact (price, offer, guarantee) that is not in the Brain. Forces manual review. */
  needsHuman: boolean;
}

export type Decision =
  | { action: "ignore"; reason: string }
  | { action: "skip"; reason: string }
  | { action: "draft_for_review"; reason: string }
  | { action: "send"; reason: string };
