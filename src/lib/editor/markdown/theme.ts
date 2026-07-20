/**
 * CSS class names applied by `decorations.ts`. The actual rules live in
 * `styles/markdown.css`; keeping the names here means decoration code and
 * stylesheet stay in sync through one shared source instead of duplicated
 * string literals.
 */
export const headingClass = (level: 1 | 2 | 3 | 4 | 5 | 6): string => `cm-heading-${level}`;

export const CLASS = {
  emphasis: "cm-em",
  strong: "cm-strong",
  strikethrough: "cm-strikethrough",
  inlineCode: "cm-inline-code",
  link: "cm-link",
  tableHeader: "cm-table-header",
  tableCell: "cm-table-cell",
  codeBlock: "cm-code-block",
} as const;
