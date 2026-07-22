/**
 * Email Alert Formatter & Sender
 *
 * Formats and sends alert emails. Supports SMTP or a transactional email API.
 * Falls back to console-only output if no email config provided.
 *
 * Configuration via env vars:
 *   LEADGUARD_EMAIL_FROM      — from address (default: alerts@leadguard.dev)
 *   LEADGUARD_EMAIL_TO        — comma-separated recipients
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS — SMTP credentials
 *   MAILGUN_API_KEY / MAILGUN_DOMAIN — Mailgun API
 */

export interface EmailAlertInput {
  subject: string;
  body: string;
  severity: string;
  screenshotUrl: string | null;
  siteName: string;
  journeyName: string;
}

/**
 * Build an HTML email body for the alert.
 */
function buildHtmlBody(input: EmailAlertInput): string {
  const severityColor =
    input.severity === "critical"
      ? "#dc2626"
      : input.severity === "warning"
        ? "#d97706"
        : "#2563eb";

  const severityEmoji =
    input.severity === "critical" ? "🔴" : input.severity === "warning" ? "🟡" : "🔵";

  const bodyLines = input.body
    .split("\n")
    .map((line) => `<p style="margin:4px 0">${escapeHtml(line) || "&nbsp;"}</p>`)
    .join("");

  let screenshotHtml = "";
  if (input.screenshotUrl) {
    screenshotHtml = `
      <p style="margin-top:16px">
        <a href="${escapeHtml(input.screenshotUrl)}" 
           style="color:${severityColor}; text-decoration:underline">
          📸 View Screenshot
        </a>
      </p>`;
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:600px;margin:0 auto;padding:20px">
  <div style="border-left:4px solid ${severityColor};padding-left:16px;margin-bottom:24px">
    <h2 style="margin:0 0 8px 0;color:${severityColor}">${severityEmoji} ${escapeHtml(input.subject)}</h2>
    <p style="color:#6b7280;font-size:14px;margin:0">
      Site: ${escapeHtml(input.siteName)} · Journey: ${escapeHtml(input.journeyName)} · Severity: ${input.severity.toUpperCase()}
    </p>
  </div>
  <div style="background:#f9fafb;border-radius:8px;padding:16px;margin-bottom:16px">
    ${bodyLines}
  </div>
  ${screenshotHtml}
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
  <p style="color:#9ca3af;font-size:12px">
    ⏰ ${new Date().toISOString()} · LeadGuard automated monitoring
  </p>
</body>
</html>`;
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Send an alert email.
 *
 * Tries Mailgun first if configured, then SMTP, then falls back to console.
 * Returns a status string: "sent", "no-config", or "error: <message>".
 */
export async function sendEmailAlert(input: EmailAlertInput): Promise<string> {
  const from = process.env.LEADGUARD_EMAIL_FROM || "alerts@leadguard.dev";
  const to = process.env.LEADGUARD_EMAIL_TO;

  if (!to) {
    console.log("[email] No LEADGUARD_EMAIL_TO configured — writing to console:");
    console.log("──────────────────────────────────────────");
    console.log(`To: (not configured)`);
    console.log(`From: ${from}`);
    console.log(`Subject: ${input.subject}`);
    console.log(`Severity: ${input.severity}`);
    console.log(input.body);
    console.log("──────────────────────────────────────────");
    return "no-config (logged to console)";
  }

  const htmlBody = buildHtmlBody(input);

  // Try Mailgun first
  const mailgunKey = process.env.MAILGUN_API_KEY;
  const mailgunDomain = process.env.MAILGUN_DOMAIN;

  if (mailgunKey && mailgunDomain) {
    try {
      const formData = new URLSearchParams();
      formData.append("from", from);
      formData.append("to", to);
      formData.append("subject", input.subject);
      formData.append("text", input.body);
      formData.append("html", htmlBody);

      const auth = Buffer.from(`api:${mailgunKey}`).toString("base64");
      const response = await fetch(
        `https://api.mailgun.net/v3/${mailgunDomain}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: formData.toString(),
        }
      );

      if (response.ok) {
        return "sent (mailgun)";
      } else {
        const text = await response.text();
        return `error (mailgun): HTTP ${response.status} — ${text.slice(0, 100)}`;
      }
    } catch (err: any) {
      return `error (mailgun): ${err.message || String(err)}`;
    }
  }

  // Try SMTP
  const smtpHost = process.env.SMTP_HOST;
  if (smtpHost) {
    // For now, SMTP is not implemented — log the email and note it
    console.log("[email] SMTP configured but direct SMTP not yet implemented.");
    console.log("[email] Would send to:", to);
    console.log("──────────────────────────────────────────");
    console.log(`Subject: ${input.subject}`);
    console.log(input.body);
    console.log("──────────────────────────────────────────");
    return "no-config (SMTP not implemented — logged to console)";
  }

  // No transport configured — console fallback
  console.log("[email] No transport configured — writing to console:");
  console.log("──────────────────────────────────────────");
  console.log(`To: ${to}`);
  console.log(`From: ${from}`);
  console.log(`Subject: ${input.subject}`);
  console.log(`Severity: ${input.severity}`);
  console.log(input.body);
  if (input.screenshotUrl) console.log(`Screenshot: ${input.screenshotUrl}`);
  console.log("──────────────────────────────────────────");
  return "no-config (logged to console)";
}
