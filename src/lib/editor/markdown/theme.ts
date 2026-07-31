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
  tableBox: "cm-table-box",
  tableScroll: "cm-table-scroll",
  tableRow: "cm-table-row",
  tableHeaderRow: "cm-table-header-row",
  tableCell: "cm-table-cell",
  tableCellNarrow: "cm-table-cell-narrow",
  tableHeaderCell: "cm-table-header-cell",
  tableDelimiterLine: "cm-table-delimiter-line",
  tableAlignCenter: "cm-table-align-center",
  tableAlignRight: "cm-table-align-right",
  tableRowSelected: "cm-table-row-selected",
  tableColSelected: "cm-table-col-selected",
  tableColSelectedTop: "cm-table-col-selected-top",
  tableColSelectedBottom: "cm-table-col-selected-bottom",
  tableRowSelectedStart: "cm-table-row-selected-start",
  tableRowSelectedEnd: "cm-table-row-selected-end",
  tableRowDragging: "cm-table-row-dragging",
  tableColDragging: "cm-table-col-dragging",
  codeBlock: "cm-code-block",
  codeBlockBox: "cm-code-block-box",
  blockquote: "cm-blockquote",
  mermaidDiagram: "cm-mermaid-diagram",
  mermaidError: "cm-mermaid-error",
  horizontalRule: "cm-hr",
  horizontalRuleEditing: "cm-hr-editing",
  setextUnderline: "cm-setext-underline",
  listBullet: "cm-list-bullet",
  listNumber: "cm-list-number",
  rawHtml: "cm-raw-html",
} as const;
