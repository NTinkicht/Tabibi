# Tabibi UI foundations

Status: approved by the owner on 2026-11-08 together with the reception console design.
Visual reference (owner and designers): https://claude.ai/artifact/RRe557S5McvDYnLFc7QLEm
(French LTR and Arabic RTL artboards, clickable). This file and
[`reception-console.md`](reception-console.md) are the source of truth for implementation;
the canvas is illustrative only.

## Principles

1. **Reception first.** The desk screen is used all day by one person under time pressure:
   one obvious primary action per row, everything else one click away, nothing hidden behind
   hover.
2. **Arabic and French are equal.** Every screen ships in both, Arabic is right-to-left.
   Layout is written once with CSS logical properties so it mirrors automatically.
3. **Honest state.** The UI shows only what the server committed. No optimistic success,
   no mock data in production builds, stale data is labelled as stale.
4. **Accessible as built.** WCAG 2.2 AA: real `<button>`/`<a>`/`<input>` + `<label>`,
   visible focus, 44 px minimum touch targets, text contrast ≥ 4.5:1.
5. **Low bandwidth.** No heavy UI framework. System of CSS custom properties plus small
   React components; self-hosted fonts with `font-display: swap`.

## Tokens

Implement as CSS custom properties in one stylesheet (e.g. `src/app/tokens.css`), imported
by the root layout. Components use the tokens, never raw hex values.

### Colour

| Token | Value | Use |
|---|---|---|
| `--tb-ground` | `#F4F6F3` | page background |
| `--tb-surface` | `#FFFFFF` | cards, rows, header |
| `--tb-surface-subtle` | `#F7F8F6` | stat tiles, inline control groups |
| `--tb-surface-sunken` | `#FAFBF9` | expanded row panel |
| `--tb-border` | `#E1E5E0` | card borders |
| `--tb-divider` | `#E7EAE6` | row dividers |
| `--tb-border-strong` | `#C9D1CB` | inputs, secondary buttons |
| `--tb-text` | `#17201D` | primary text |
| `--tb-text-secondary` | `#3B4641` | labels |
| `--tb-text-muted` | `#55625C` | meta text (≥ 4.5:1 on white) |
| `--tb-primary` | `#0F6E64` | primary buttons, brand, focus of "next" |
| `--tb-primary-strong` | `#0B5A52` | primary text on tint, hover |
| `--tb-primary-tint` | `#DDF0EC` | "called", "session open" chip |
| `--tb-primary-wash` | `#F1F8F6` | highlighted "next" row |
| `--tb-info` | `#1D4F91` | "arrived" chip text, focus ring |
| `--tb-info-tint` | `#E5EDF8` | "arrived" chip |
| `--tb-warning-text` | `#6B3B00` | delay, paused, notification alert |
| `--tb-warning-tint` | `#FCEFD9` | delay/paused chip, paused banner |
| `--tb-warning-border` | `#F0D3A6` | alert borders |
| `--tb-priority-text` | `#8A3300` | priority badge |
| `--tb-priority-tint` | `#FDE6D6` | priority badge |
| `--tb-danger` | `#A12D2D` | no-show, cancel, close session (outlined) |
| `--tb-danger-border` | `#E6C3C3` | danger outline |
| `--tb-disabled-bg` | `#EEF1ED` | disabled controls, neutral chip |
| `--tb-disabled-text` | `#5F6B66` | disabled controls |
| `--tb-inverse` | `#17201D` | undo/status bar background |

States must differ in lightness, not only hue (colour-blind safe): the in-consultation chip
is solid primary with white text; called is light teal; arrived is light blue; not-yet-arrived
is neutral grey.

### Type

- Families: `IBM Plex Sans` (Latin) and `IBM Plex Sans Arabic` (Arabic), weights 400/500/600/700,
  self-hosted (for example the `@fontsource/ibm-plex-sans` and `@fontsource/ibm-plex-sans-arabic`
  packages). Stack order follows the document language: Arabic pages put Plex Sans Arabic first.
- Base 15 px / 1.45. Scale: 12 (fine print), 13 (meta, labels), 14 (controls), 15 (body),
  16 (row names), 17 (section headings), 18–20 (page/doctor title), 26 (stat numbers),
  30 (ticket code on serving cards).
- Digits: Western digits (0–9) in both languages. Ticket codes, times and phone numbers are
  wrapped in `<bdi>` (phone inputs `dir="ltr"`) so they never reorder in RTL.

### Space, shape, elevation

- Spacing steps: 4, 8, 10, 12, 14, 16, 20, 24, 32 px. Page gutter 32 px, max content width 1440 px.
- Radius: 10 px controls, 12 px banners/tiles, 16 px cards, 999 px chips and segmented controls.
- No shadows; separation by 1 px borders on the ground colour.

### Components (shared)

- **Button**: primary (solid `--tb-primary`), secondary (white, strong border), danger
  (white, danger text and border), soft (priority tint), disabled (`--tb-disabled-*`,
  `cursor: not-allowed`, real `disabled` attribute). Min height 44 px, 14 px/600.
- **Chip**: pill, 13 px/600, never interactive.
- **Segmented control**: two or more `<button aria-pressed>` in a row; selected = 2 px primary
  border on `#E8F4F1`.
- **Inline reason panel**: text input with visible label "Motif (obligatoire)" / "السبب (مطلوب)";
  the actions it guards stay disabled until the trimmed value is non-empty; an audit hint line
  under it.
- **Status bar** (`role="status"`): dark inverse bar for the last committed action, with an
  optional action button.
- **Focus**: `outline: 3px solid var(--tb-info); outline-offset: 2px` on `:focus-visible`.

## Direction and language

- The root `<html>` carries `lang` (`ar`/`fr`) and `dir` (`rtl`/`ltr`) of the active locale
  (today the root layout hard-codes `lang="en"`). Use logical properties only
  (`margin-inline-start`, `padding-inline`, `text-align: start`, `inset-inline-end`).
- All copy lives in `src/modules/localization/*`; no literal UI strings in components.
- The language switch is a pair of links showing each language in its own script
  (`Français`, `العربية`), the current one marked `aria-current="page"`.
