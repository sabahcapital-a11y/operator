/**
 * Form detector — identifies contact forms on a page.
 *
 * Detects:
 *   - Any <form> element with input fields for name/email/phone/message
 *   - Records form action, field names, submit button selector, CSRF/honeypot tokens
 */

import type { Page } from "playwright";

export interface DetectedForm {
  type: "contact_form";
  pageUrl: string;
  formAction: string | null;
  formMethod: string | null;
  fieldNames: string[];
  submitSelector: string | null;
  honeypotFields: string[];
  csrfTokenName: string | null;
  hasSubject: boolean;
  hasMessage: boolean;
}

/**
 * Analyze the current page for contact forms.
 */
export async function detectForms(page: Page, pageUrl: string): Promise<DetectedForm[]> {
  const forms: DetectedForm[] = [];

  const formCount = await page.locator("form").count();
  for (let i = 0; i < formCount; i++) {
    const form = page.locator("form").nth(i);

    // Skip hidden forms
    if (!(await form.isVisible({ timeout: 300 }).catch(() => false))) {
      continue;
    }

    const fields: string[] = [];
    const honeypotFields: string[] = [];
    let csrfTokenName: string | null = null;
    let hasSubject = false;
    let hasMessage = false;

    // Inspect all inputs
    const inputs = form.locator("input, textarea, select");
    const inputCount = await inputs.count();

    for (let j = 0; j < inputCount; j++) {
      const input = inputs.nth(j);
      const name = await input.getAttribute("name").catch(() => null);
      const id = await input.getAttribute("id").catch(() => null);
      const type = await input.getAttribute("type").catch(() => null);
      const placeholder = await input.getAttribute("placeholder").catch(() => null);
      const ariaLabel = await input.getAttribute("aria-label").catch(() => null);

      const identifier = name || id || "";

      // Detect honeypot fields (hidden from users but present for bots)
      if (type === "hidden" && identifier) {
        // Check if it looks like a honeypot (common names)
        const isHoneypot = /(?:honey|trap|bot|spam|url_site|website_url|confirm_email)/i.test(identifier);
        if (isHoneypot) {
          honeypotFields.push(identifier);
        }
        // Also collect CSRF tokens
        if (/csrf|_token|nonce/i.test(identifier)) {
          csrfTokenName = identifier;
        }
        continue;
      }

      if (!identifier && !placeholder && !ariaLabel) continue;

      // Classify field by name/id/placeholder
      const combined = `${identifier} ${placeholder || ""} ${ariaLabel || ""}`.toLowerCase();

      if (/\b(name|full.?name|first.?name|last.?name|your.?name)\b/i.test(combined)) {
        fields.push(identifier || `field-${j}`);
      } else if (/\b(email|e.?mail|your.?email)\b/i.test(combined)) {
        fields.push(identifier || `field-${j}`);
      } else if (/\b(phone|tel|telephone|mobile|contact.?number)\b/i.test(combined)) {
        fields.push(identifier || `field-${j}`);
      } else if (/\b(message|comment|enquiry|how.?can.?we.?help|description|question)\b/i.test(combined)) {
        fields.push(identifier || `field-${j}`);
        hasMessage = true;
      } else if (/\b(subject|topic)\b/i.test(combined)) {
        fields.push(identifier || `field-${j}`);
        hasSubject = true;
      } else if (type !== "hidden" && type !== "submit" && type !== "button" && type !== "checkbox" && type !== "radio") {
        // Generic visible input — might be a form field
        if (identifier) {
          fields.push(identifier);
        }
      }
    }

    // Only count as a contact form if it has at least name/email fields
    const hasNameField = fields.some((f) =>
      /\b(name|full.?name|first.?name)\b/i.test(f)
    );
    const hasEmailField = fields.some((f) =>
      /\b(email|e.?mail)\b/i.test(f)
    );

    if (!hasNameField && !hasEmailField) {
      // Not enough signals — skip this form
      continue;
    }

    // Find submit button
    let submitSelector: string | null = null;
    const submitBtn = form.locator(
      'button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Send"), button:has-text("Contact")'
    );
    if ((await submitBtn.count()) > 0) {
      const btn = submitBtn.first();
      const btnId = await btn.getAttribute("id").catch(() => null);
      const btnClass = await btn.getAttribute("class").catch(() => null);

      if (btnId) {
        submitSelector = `#${btnId}`;
      } else if (btnClass) {
        const firstClass = btnClass.split(" ")[0];
        submitSelector = `.${firstClass}`;
      } else {
        const btnText = await btn.textContent().catch(() => "Submit");
        submitSelector = `button:has-text("${btnText?.trim()}")`;
      }
    } else {
      // Fallback to first button in the form
      submitSelector = 'button[type="submit"], input[type="submit"]';
    }

    // Get form attributes
    const formAction = await form.getAttribute("action").catch(() => null);
    const formMethod = await form.getAttribute("method").catch(() => null);

    forms.push({
      type: "contact_form",
      pageUrl,
      formAction,
      formMethod: formMethod || "post",
      fieldNames: fields,
      submitSelector,
      honeypotFields,
      csrfTokenName,
      hasSubject,
      hasMessage,
    });
  }

  return forms;
}
