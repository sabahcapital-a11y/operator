/**
 * Slack Alert Formatter & Sender
 *
 * Posts a formatted alert message to a Slack webhook URL.
 * Configurable via SLACK_WEBHOOK_URL env var.
 * Falls back to console-only output if no webhook configured.
 */

/**
 * Format a Slack message payload for the webhook.
 * Uses Slack's Block Kit for rich formatting.
 */
function formatSlackPayload(
  subject: string,
  body: string,
  severity: string,
  screenshotUrl: string | null
): object {
  const severityEmoji =
    severity === "critical" ? "🔴" : severity === "warning" ? "🟡" : "🔵";

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${severityEmoji} ${subject}`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: body.split("\n").join("\n"),
      },
    },
  ];

  if (screenshotUrl) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `📸 <${screenshotUrl}|View Screenshot>`,
      },
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `⏰ ${new Date().toISOString()} · LeadGuard automated monitoring`,
      },
    ],
  });

  blocks.push({ type: "divider" });

  return {
    blocks,
    text: subject, // fallback for notifications
  };
}

/**
 * Send a formatted alert to Slack.
 *
 * Returns "sent" on success, "no-webhook" if not configured,
 * or "error: <message>" on failure.
 */
export async function sendSlackAlert(
  subject: string,
  body: string,
  severity: string,
  screenshotUrl: string | null
): Promise<string> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;

  if (!webhookUrl) {
    console.log("[slack] No SLACK_WEBHOOK_URL configured — writing to console:");
    console.log("──────────────────────────────────────────");
    console.log(`Subject: ${subject}`);
    console.log(`Severity: ${severity}`);
    console.log(body);
    if (screenshotUrl) console.log(`Screenshot: ${screenshotUrl}`);
    console.log("──────────────────────────────────────────");
    return "no-webhook (logged to console)";
  }

  const payload = formatSlackPayload(subject, body, severity, screenshotUrl);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      return "sent";
    } else {
      const responseText = await response.text();
      return `error: HTTP ${response.status} — ${responseText.slice(0, 100)}`;
    }
  } catch (err: any) {
    return `error: ${err.message || String(err)}`;
  }
}
