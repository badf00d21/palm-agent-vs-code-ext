---
name: Palm Agent
description: VS Code sidebar chat that borrows the host workbench; bubbles and a review card are the only custom surfaces.
colors:
  sidebar-bg: "var(--vscode-sideBar-background)"
  editor-bg: "var(--vscode-editor-background)"
  input-bg: "var(--vscode-input-background)"
  widget-bg: "var(--vscode-editorWidget-background)"
  foreground: "var(--vscode-foreground)"
  input-fg: "var(--vscode-input-foreground)"
  button-bg: "var(--vscode-button-background)"
  button-fg: "var(--vscode-button-foreground)"
  button-hover: "var(--vscode-button-hoverBackground)"
  button-secondary-bg: "var(--vscode-button-secondaryBackground)"
  button-secondary-fg: "var(--vscode-button-secondaryForeground)"
  button-secondary-hover: "var(--vscode-button-secondaryHoverBackground)"
  error: "var(--vscode-errorForeground)"
  link: "var(--vscode-textLink-foreground)"
  border: "var(--vscode-widget-border)"
  panel-border: "var(--vscode-panel-border)"
  focus: "var(--vscode-focusBorder)"
  list-hover: "var(--vscode-list-hoverBackground)"
typography:
  body:
    fontFamily: "var(--vscode-font-family)"
    fontSize: "var(--vscode-font-size)"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  label:
    fontFamily: "var(--vscode-font-family)"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: "0.04em"
  tool:
    fontFamily: "var(--vscode-editor-font-family)"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "normal"
rounded:
  sm: "6px"
  full: "50%"
spacing:
  xs: "4px"
  sm: "8px"
  md: "10px"
  lg: "12px"
components:
  button-primary:
    backgroundColor: "{colors.button-bg}"
    textColor: "{colors.button-fg}"
    rounded: "0"
    padding: "6px 12px"
  button-primary-disabled:
    backgroundColor: "{colors.button-bg}"
    textColor: "{colors.button-fg}"
    padding: "6px 12px"
  button-secondary:
    backgroundColor: "{colors.button-secondary-bg}"
    textColor: "{colors.button-secondary-fg}"
    rounded: "0"
    padding: "6px 12px"
  bubble-user:
    backgroundColor: "{colors.input-bg}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
  bubble-assistant:
    backgroundColor: "{colors.editor-bg}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
  bubble-tool:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
  bubble-review:
    backgroundColor: "{colors.widget-bg}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
  input-composer:
    backgroundColor: "{colors.input-bg}"
    textColor: "{colors.input-fg}"
    padding: "8px"
  suggest-item-hover:
    backgroundColor: "{colors.list-hover}"
    textColor: "{colors.foreground}"
    padding: "4px 6px"
---

# Design System: Palm Agent

## Overview

**Creative North Star: "The Hosted Workbench"**

The chat lives inside VS Code. Paint, type, focus rings, and primary buttons are the host's. Palm Agent maps interface roles onto `var(--vscode-*)` so Dark+, Light+, and custom themes stay coherent, with the StatusOrb exception documented below.

The layout is a Cursor-like sidebar: streaming prose, dim tool rows, a review card with Keep / Undo / Review. Custom craft is limited to 6px message cards and density. There is no marketing chrome, neon agent skin, or private color system.

**Key Characteristics:**
- Host tokens for interface chrome; StatusOrb keeps its deferred source palette
- 6px cards for messages and review; actions stay native VS Code buttons
- Flat surfaces now; shadow only later, and only on hover or focus
- Tool rows read as a log (editor mono, 12px); prose uses the workbench UI font

## Colors

Every color is a live VS Code theme variable. Hex is not the source of truth.

### Primary
- **Button fill** (`{colors.button-bg}`): Keep All, Undo All, Send, Stop, Review. Pair with `{colors.button-fg}`. Hover `{colors.button-hover}`.
- **Secondary fill** (`{colors.button-secondary-bg}`): New chat. Pair with `{colors.button-secondary-fg}`. Hover `{colors.button-secondary-hover}`.
- **Error** (`{colors.error}`): Assistant lines that start with `Error:`.

### Neutral
- **Sidebar ground** (`{colors.sidebar-bg}`): Full webview canvas.
- **Editor ground** (`{colors.editor-bg}`): Assistant bubble so streamed text sits on the same plane as the editor.
- **Input ground** (`{colors.input-bg}`): User bubble and composer textarea.
- **Widget ground** (`{colors.widget-bg}`): Review card and `@` suggestion list.
- **Foreground** (`{colors.foreground}`): Body text and role labels (at 70% opacity).
- **Input foreground** (`{colors.input-fg}`): Composer text only.
- **Hairline** (`{colors.border}`): Bubble and suggest borders; composer top rule (fallback `{colors.panel-border}`).
- **Link** (`{colors.link}`): Review file paths that open `vscode.diff`.
- **List hover** (`{colors.list-hover}`): Suggestion row hover / `aria-selected`.
- **Focus ring** (`{colors.focus}`): 1px outline on textarea, buttons, review toggles.

**The Host Paint Rule.** Do not introduce a hex, OKLCH, or brand accent. If a new surface needs color, pick an existing `--vscode-*` role.

**StatusOrb exception.** StatusOrb intentionally retains the source component's hex palette, gradient, and resting glow. The review-dock specification defers remapping it to theme roles, so it is exempt from the Host Paint and Resting-Flat rules until that follow-up.

## Typography

**Display Font:** none (no display role in the sidebar)
**Body Font:** VS Code UI font (`{typography.body}`)
**Label/Mono Font:** VS Code editor font for tool rows (`{typography.tool}`)

**Character:** Workbench UI type for conversation; editor mono for tool traces so they scan as log lines, not chat.

### Hierarchy
- **Body** (regular, host size, ~1.4): Assistant and user prose; `pre-wrap`, break long tokens.
- **Title** (inherit, host size): Review file-count toggle. No separate weight.
- **Label** (11px, uppercase, 0.04em, 70% opacity): `You` / `Agent` / `Tool` / `Review` / `Status` above each bubble.
- **Tool** (12px, editor family, 75% opacity; 55% while running): `read_file  path`.

**The Two Voices Rule.** Prose uses the UI font. Tool traces use the editor font. Do not invert them.

## Layout

Column flex: messages (`flex: 1`, overflow auto) over a pinned composer. Message stack padding `{spacing.lg}` (12px), gap `{spacing.md}` (10px). Composer is itself a column: textarea full width, then a wrapping action row aligned end — so a ~240px sidebar still fits. Composer padding and control gap `{spacing.sm}` (8px). Empty state is centered, max 32ch, 70% opacity. Suggestion list max-height 160px, 6px radius. Sidebar width is the VS Code view — no page breakpoints.

**The Sidebar Column Rule.** One column, composer glued to the bottom. Do not add a header brand bar or a second rail.

## Elevation & Depth

Surfaces are flat. Depth is which VS Code plane you sit on (sidebar / editor / input / widget), plus a 1px hairline. No `box-shadow` in the incumbent CSS.

Future lift is allowed only as a hover or focus response — not at rest, not on every bubble.

**The Resting-Flat Rule.** At rest, no shadow. A later hover/focus shadow must still use host colors, not a drop-shadow brand glow.

## Shapes

Message and review cards: gently curved 6px (`{rounded.sm}`), 1px `{colors.border}`. Primary actions and the composer textarea: square host chrome (no radius in CSS).

**The One Radius Rule.** 6px is the only custom radius. Buttons and the textarea stay square like VS Code.

## Components

### Buttons
- **Shape:** square host button (no radius)
- **Primary:** `{colors.button-bg}` / `{colors.button-fg}`, padding 6px 12px. Send, Stop, Keep All, Undo All, Review.
- **Secondary:** New chat uses `{colors.button-secondary-bg}` / `{colors.button-secondary-fg}`.
- **Hover / Focus:** `{colors.button-hover}` (or `{colors.button-secondary-hover}`); focus is 1px `{colors.focus}`
- **Disabled:** 50% opacity, default cursor
- **Ghost:** review header and file links — no fill; file links use `{colors.link}`

### Cards / Containers
- **Corner Style:** 6px on bubbles and the review card
- **Background:** user = input plane; assistant = editor plane; review / suggest = widget plane
- **Shadow Strategy:** none at rest (see Elevation)
- **Border:** 1px widget border
- **Internal Padding:** 8px 10px on bubbles

### Inputs / Fields
- **Style:** composer textarea, host input colors, 1px input border, 8px padding, no resize, 3 rows
- **Focus:** 1px `{colors.focus}`
- **Error / Disabled:** textarea is disabled while busy; assistant `Error:` lines use `{colors.error}`.

### Navigation
None inside the webview. Activity-bar icon and view title are VS Code chrome, not this system.

### Message bubble (signature)
Role label (label type) then body. User vs assistant vs tool vs review vs status vs waiting (85% opacity). Status is plain text, with no markdown. Tool running is dimmer (55%). Consecutive assistant deltas append in one bubble.

### Review card (signature)
Collapsible file list, native-looking actions: Undo All / Keep All / Review. Paths are links, not secondary buttons.

### Suggestion list (signature)
Widget-plane list under the textarea, 6px radius. Shown only after a non-empty `@` prefix. Rows are full-width ghost buttons; selected/hover uses `{colors.list-hover}`. `No files` only after the matching response is empty.

## Do's and Don'ts

### Do:
- **Do** paint with `var(--vscode-*)` roles already in this file.
- **Do** keep message cards at 6px and host buttons square.
- **Do** treat tool rows as a log (editor font, 12px, reduced opacity).
- **Do** keep the composer at the bottom of a single column.

### Don't:
- **Don't** ship a brand hex, gradient, or illustration in the chat.
- **Don't** add resting box-shadows to bubbles.
- **Don't** invent a display typeface or a header logo bar.
- **Don't** attach file-body chips as a visual pattern (product: `@` is path text only).
