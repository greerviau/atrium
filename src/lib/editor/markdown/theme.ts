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
  tableRow: "cm-table-row",
  tableHeaderRow: "cm-table-header-row",
  tableCell: "cm-table-cell",
  tableHeaderCell: "cm-table-header-cell",
  tableDelimiterLine: "cm-table-delimiter-line",
  tableAlignCenter: "cm-table-align-center",
  tableAlignRight: "cm-table-align-right",
  codeBlock: "cm-code-block",
  blockquote: "cm-blockquote",
  mermaidDiagram: "cm-mermaid-diagram",
  mermaidError: "cm-mermaid-error",
} as const;
