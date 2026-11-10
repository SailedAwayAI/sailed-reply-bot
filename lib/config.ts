// All configuration comes from environment variables set in Vercel. Nothing secret lives in the code.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const config = {
  /** Shared secret Instantly must include as ?secret= on the webhook URL. */
  webhookSecret: () => required("WEBHOOK_SECRET"),
  anthropicApiKey: () => required("ANTHROPIC_API_KEY"),
  model: () => process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
  /** Base URL of the client dashboard, e.g. https://dash.sailedawayai.com */
  dashboardUrl: () => required("DASHBOARD_URL").replace(/\/$/, ""),
  /** Bearer token for the dashboard bot endpoints (read context, write events). */
  dashboardToken: () => required("DASHBOARD_BOT_TOKEN"),
  /** Agency Slack incoming webhook for review notices and errors. Optional. */
  agencySlackWebhook: () => process.env.AGENCY_SLACK_WEBHOOK_URL || "",
  /**
   * Map of client id to Instantly API key, as JSON: {"foundey":"...","marketsparx":"..."}.
   * Each client has its own Instantly workspace.
   */
  instantlyKeys: (): Record<string, string> => {
    const raw = required("INSTANTLY_KEYS_JSON");
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("INSTANTLY_KEYS_JSON is not valid JSON");
    }
  },
  /**
   * Global safety switch. Unless this is exactly "on", the bot never sends anything,
   * even for campaigns set to Auto; it only drafts for review. Start with it off.
   */
  sendingEnabled: () => process.env.SENDING_ENABLED === "on",
};
