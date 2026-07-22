/**
 * White-label branding configuration.
 *
 * Controlled via environment variables:
 *   LEADGUARD_WHITE_LABEL=true   — enable white-label mode (hide LeadGuard branding)
 *   LEADGUARD_AGENCY_NAME="..."  — agency name to display in report header
 *
 * When white-label is on, all LeadGuard branding is replaced with the agency name.
 * The footer still shows "Powered by LeadGuard" unless LEADGUARD_WHITE_LABEL is
 * set to "true", in which case it shows "Powered by [Agency Name]".
 */

export interface WhiteLabelConfig {
  enabled: boolean;
  agencyName: string | null;
  /** Title shown in the report header */
  reportTitle(siteName: string): string;
  /** Footer branding line */
  footerBranding(): string;
  /** Logo placeholder — agency name when white-label, LeadGuard otherwise */
  logoText(): string;
  /** Subtitle under the logo */
  logoSlogan(): string;
}

export function loadWhiteLabelConfig(): WhiteLabelConfig {
  const enabled = process.env.LEADGUARD_WHITE_LABEL === "true";
  const agencyName = process.env.LEADGUARD_AGENCY_NAME || null;

  return {
    enabled,
    agencyName,

    reportTitle(siteName: string): string {
      const brand = agencyName || "LeadGuard";
      return `${brand} — Weekly Monitoring Report for ${siteName}`;
    },

    footerBranding(): string {
      if (enabled && agencyName) {
        return `Powered by ${agencyName} — Silent Funnel-Failure Monitoring`;
      }
      return "Powered by LeadGuard — Silent Funnel-Failure Monitoring";
    },

    logoText(): string {
      if (enabled && agencyName) {
        return agencyName;
      }
      return "LeadGuard";
    },

    logoSlogan(): string {
      return "Silent Funnel-Failure Monitoring";
    },
  };
}
