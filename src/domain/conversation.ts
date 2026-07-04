/** A GitHub label with its own background color (hex, no leading #). */
export interface GitHubLabel {
  name: string;
  color: string;
}

/** One entry in an issue/PR/discussion conversation. */
export interface ConversationComment {
  id: string;
  author: string;
  avatarUrl?: string;
  authorAssociation?: string;
  created_at: string;
  body: string;
}

/**
 * Readable text color for a label swatch, matching GitHub's YIQ contrast
 * rule. Defaults to dark text for malformed colors.
 */
export function labelTextColor(hexColor: string): string {
  const hex = hexColor.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    return "#1f2328";
  }
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150 ? "#1f2328" : "#ffffff";
}

/** Display badge for a comment's author_association; null when not notable. */
export function authorAssociationLabel(
  association: string | undefined
): string | null {
  switch (association) {
    case "OWNER":
      return "Owner";
    case "MEMBER":
      return "Member";
    case "COLLABORATOR":
      return "Collaborator";
    case "CONTRIBUTOR":
      return "Contributor";
    default:
      return null;
  }
}
