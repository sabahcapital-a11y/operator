/**
 * White-label branding configuration.
 *
 * Controlled via environment variables:
 *   LEADGUARD_WHITE_LABEL=true   — enable white-label mode (hide Silentbreak branding)
 *   LEADGUARD_AGENCY_NAME="..."  — agency name to display in report header
 *
 * When white-label is on, all Silentbreak branding is replaced with the agency name.
 * The footer still shows "Powered by Silentbreak" unless LEADGUARD_WHITE_LABEL is
 * set to "true", in which case it shows "Powered by [Agency Name]".
 */

export interface WhiteLabelConfig {
  enabled: boolean;
  agencyName: string | null;
  /** Title shown in the report header */
  reportTitle(siteName: string): string;
  /** Footer branding line */
  footerBranding(): string;
  /** Logo placeholder — agency name when white-label, Silentbreak otherwise */
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
      const brand = agencyName || "Silentbreak";
      return `${brand} — Weekly Monitoring Report for ${siteName}`;
    },

    footerBranding(): string {
      if (enabled && agencyName) {
        return `Powered by ${agencyName} — Silent Funnel-Failure Monitoring`;
      }
      return "Powered by Silentbreak — Silent Funnel-Failure Monitoring";
    },

    logoText(): string {
      if (enabled && agencyName) {
        return agencyName;
      }
      return "Silentbreak";
    },

    logoSlogan(): string {
      return "Silent Funnel-Failure Monitoring";
    },
  };
}
