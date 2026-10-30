# Pi Pocket extension UI

Use the running app's theme tokens. These tokens come from `web/style.css` and the built-in Context Insight styles.

```json
{
  "colors": {
    "text": "var(--text)",
    "muted": "var(--muted)",
    "surface": "var(--card)",
    "border": "var(--line)",
    "warning": "var(--warn)",
    "error": "var(--err)",
    "success": "var(--ok)",
    "contextSystem": "#6366f1",
    "contextTools": "#f59e0b",
    "contextUser": "#22c55e",
    "contextInjection": "#a855f7",
    "contextSkill": "#f97316",
    "contextAnswers": "#3b82f6",
    "contextThinking": "#8b5cf6",
    "contextToolCalls": "#14b8a6",
    "contextToolResults": "#0ea5e9"
  },
  "spacing": { "small": "4px", "medium": "8px", "large": "12px", "panel": "14px" },
  "radius": { "control": "9px", "card": "12px" },
  "typography": { "body": "13px", "secondary": "12px", "title": "15px", "metric": "18px", "lineHeight": 1.45 },
  "touchTarget": "40px",
  "viewports": { "mobile": "390x844", "desktop": "1280x800" }
}
```

Panels use stacked bordered cards, compact headings, and tabular numeric metrics. Use the existing Preact/htm public extension API and `pocket.style`; do not add global styles outside the Pocket cascade layer.

Keep every control and chart within the phone viewport. Use scrolling within data tables and timelines where necessary. Use labels as well as colors. Make selected chart points, range controls, paging, errors, loading, and incomplete accounting visible. Do not present estimated or reconstructed information as measured or captured information.

Keep Chinese and English labels in the extension translation dictionary. Preserve the app's Back behavior for sheets and panels. A failed or cancelled request must not replace a newer session's data.
