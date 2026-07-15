# Graphite & Mist Whole-App Redesign

**Status:** Approved for implementation

## Goal

Apply the approved Graphite & Mist visual direction across Yonalist without
changing feature behavior, data contracts, information architecture, keyboard
commands, or the Workflowy-like Notes editing model.

The redesign must make the desktop app feel like one precise productivity tool:

- a stable graphite navigation layer;
- two quiet mist work surfaces for lists and detail content;
- one blue interaction accent;
- crisp, accessible controls and state feedback;
- compact discovery controls that leave space for user content;
- connected multi-selection ranges and untruncated command feedback.

## Approved Direction

Graphite & Mist replaces Soft Paper as the default light direction. It is an
evolution of the current application, not a new layout or a feature rewrite.

The approved visual companion showed:

- a dark graphite sidebar;
- a cool gray library or category pane;
- a near-white detail pane;
- blue used only for primary actions, focus, unread state, and selection;
- flatter pane hierarchy with thin separators instead of floating cards;
- a compact three-column Notes library header;
- one connected block for a contiguous Notes selection;
- full error text directly below the selection toolbar;
- consistent settings, notification, empty, loading, and error states.

The mockup's top window band is illustrative. The implementation keeps the
existing Tauri titlebar, drag regions, traffic-light clearance, pane toggles,
and pane-resize behavior. It does not add a second application titlebar.

The shell's current direct-child grid contract also remains intact. In
particular, `.feature-pane-slot { display: contents; }`, pane order, and the
kept-mounted Notes feature are not wrapped or reorganized. That contract
preserves pane placement, drafts, focus, scroll, and queued writes.

## Scope

The redesign covers:

- the app shell, sidebar, pane separators, resizers, and status bar;
- GitHub Inbox lists, issue and pull-request detail, create forms, comments,
  labels, filters, menus, and dialogs;
- Notifications navigation, list rows, unread state, and reason labels;
- Notes library navigation, search, filters, outline, selection toolbar,
  choosers, menus, tags, empty states, and editor feedback;
- Settings category navigation, forms, theme controls, reset progress, and
  supporting settings sections;
- shared buttons, inputs, text areas, checkboxes, radios, popovers, tooltips,
  menus, modals, focus rings, loading states, empty states, and errors;
- desktop, two-column, narrow-window, collapsed-pane, and maximized-detail
  layouts.

## Non-Goals

This work does not:

- change routing, feature ownership, data loading, persistence, or Tauri APIs;
- add, remove, or reorder user-visible features;
- change Notes selection, drag, indent, move, completion, tag, clipboard, or
  history semantics;
- box normal Notes outline rows or change their text and indentation metrics;
- add a new icon library, font package, CSS framework, animation library, or
  component system;
- redesign legacy optional themes beyond fixes required for shared geometry,
  accessibility, and state correctness;
- introduce a separate mobile product layout.

## Theme Identity and Compatibility

Add `graphite` as the primary light theme identifier and remove Soft Paper from
the visible theme choices. Graphite becomes the fresh-install and reset light
theme.

For compatibility, the theme loader treats a stored `soft-paper` value as
`graphite`. Existing users therefore receive the approved redesign without a
broken stored preference or a one-off migration command. The next explicit
theme selection persists the current identifier normally.

Keep the existing optional light and dark themes. Retune the current default
dark theme only where needed to form the dark counterpart of Graphite & Mist.
Yona, Yonal Light, Yonal Dark, Base Light, and Base Dark retain their identities.

Update the startup fallback colors in `main.tsx` with the Graphite defaults so
the first painted frame does not flash the retired Soft Paper palette.

Shared geometry and component-state rules apply to every theme. Theme-specific
surface, text, accent, and semantic colors remain token-driven so another theme
does not inherit Graphite's dark sidebar accidentally.

## Visual Tokens

Graphite light uses these reference values:

| Role | Value | Use |
| --- | --- | --- |
| App surround | `#d9dee5` | Window and separator ground |
| Sidebar | `#202630` | Primary navigation |
| Sidebar active | `#2d3643` | Active navigation row |
| List surface | `#eef1f5` | Library, categories, notifications |
| Detail surface | `#fbfcfd` | Reading, editing, settings |
| Card and input | `#ffffff` | Raised controls and focused content |
| Border | `#ccd3dc` | Dividers and passive outlines |
| Control border | `#aeb8c5` | Inputs and interactive outlines |
| Primary text | `#1f2732` | Main content |
| Secondary text | `#536171` | Metadata and helper text |
| Tertiary text | `#667383` | Small labels on light surfaces |
| Sidebar text | `#b8c2ce` | Normal sidebar content |
| Sidebar muted | `#8f9aa7` | Sidebar metadata |
| Accent | `#286cc9` | Primary action, focus, selection rail |
| Accent strong | `#1f5dab` | Hover and active action |
| Accent soft | `#e5eef9` | Selected rows and quiet emphasis |
| Danger | `#a43125` | Errors and destructive actions |
| Danger soft | `#fff0ed` | Error background |

The main contrast pairs meet WCAG AA for normal text. Reference ratios include:

- primary text on detail: 14.66:1;
- secondary text on detail: 6.17:1;
- tertiary text on detail: 4.71:1;
- normal sidebar text on sidebar: 8.43:1;
- muted sidebar text on sidebar: 5.32:1;
- white text on the blue accent: 5.15:1;
- danger text on danger soft: 6.22:1.

Add or normalize semantic tokens instead of hard-coding surface values in
components:

- `--control-border`;
- `--focus-ring`;
- `--sidebar-text-1`, `--sidebar-text-2`, and `--sidebar-text-3`;
- `--selection-rail` and `--selection-bg`;
- `--shadow-pane`, `--shadow-menu`, and `--shadow-modal`;
- notification reason foreground and background tokens;
- status success, warning, and error foreground/background/border tokens.

Use the existing system-first sans-serif stack. Do not depend on Avenir Next or
another unbundled font, because unavailable Korean glyphs create mixed metrics.

## Shape, Elevation, and Density

Use a compact radius scale:

- 4 px for small badges and inline controls;
- 5 px for buttons, inputs, row states, and toolbar items;
- 6 px for list selection and small panels;
- 8 px for menus, dialogs, and larger contained states.

Do not use pill shapes for ordinary controls. Reserve a fully rounded shape for
numeric counts, presence dots, and tags whose content semantics justify it.

Panes no longer cast a shared warm shadow or float as three separate cards.
Desktop pane tracks use a 1 px visual separator while preserving an overlapping
11 px resize target. Menus and modals keep restrained neutral shadows through
tokens. Hover states primarily change surface tone, not position or scale.

Target control heights:

- 28 px for icon-only and compact toolbar controls;
- 32 px for compact actions;
- 36 px for search, form inputs, and standard actions;
- at least 40 px for destructive confirmation actions.

## App Shell and Navigation

The shell remains three logical panes plus the status bar. Existing collapse,
maximize, and responsive placement behavior stays authoritative.

Desktop presentation:

- panes begin at the current titlebar-safe top position;
- the sidebar fills its pane with Graphite and extends visually beneath the
  native titlebar area;
- list and detail panes meet through thin dividers rather than wide gutters;
- resizer hit targets overlap the divider and visibly turn blue on hover or
  keyboard focus;
- the status bar uses the app surround with one top divider and compact text;
- no pane uses the previous hard-coded warm brown shadow.

Sidebar navigation:

- one workspace label appears beneath the Yonalist brand;
- active navigation uses a quiet graphite fill plus a 2 px blue leading rail;
- inactive icons and text use sidebar-specific tokens;
- badges use the blue accent with white text;
- Settings remains anchored near the bottom with a separator;
- all icons continue to come from `lucide-react`.

Do not add duplicate `Notes` labels. The sidebar identifies the feature, the
middle pane title identifies the library, and the detail breadcrumb identifies
the active page.

## List, Notification, and Category Panes

All middle-pane surfaces share a visual grammar:

- 18 px horizontal content padding on desktop;
- a compact title and primary action on one row when the action exists;
- a 36 px search control with a visible control border;
- compact view controls with an underline or leading rail for the active view;
- list rows separated by whitespace, not individual cards;
- the active row uses accent-soft plus a 2 px leading rail;
- metadata remains readable at 11 to 12 px with the secondary or tertiary text
  token;
- loading and empty states reserve the same content area as the final list.

GitHub Inbox row and date-header dimensions remain synchronized with the
virtualization constants. A visual padding or typography change must either
preserve the current 104 px or 80 px item heights and 34 px date header, or
update the measured constants and focused virtualization tests in the same
change.

For Notes, collapse the current tall discovery stack into:

1. title plus compact New Page action;
2. search;
3. a two-row, three-column grid containing all six existing views: All,
   Starred, Recent, Tags, Archive, and Trash;
4. the page list.

No library view is removed, renamed, or demoted into an overflow menu. The
visual companion showed one row to communicate the style, while the production
layout retains the complete feature set in the same compact grammar.

At the two-column breakpoint this header must not consume more than 144 px above
the scrollable page list.

Notification reason types use neutral outlined labels. Semantic reason colors
may remain available for small identifiers, but they must not compete with the
single blue unread and selection accent. Every Graphite token is explicitly
defined so colors do not leak from another theme.

## Detail and Reading Surfaces

Detail pages use the near-white detail surface and a consistent header:

- breadcrumb or eyebrow on the left;
- bounded icon actions on the right;
- one bottom divider;
- 28 px icon controls with visible focus states;
- readable content widths set by the feature, not a global card wrapper.

Issue content, forms, settings, and comments may use contained white surfaces
where grouping is necessary. Avoid nesting a rounded card inside every section.
Prefer spacing and a divider when the relationship is already clear.

Links and primary actions use blue. Starred or favorite state may retain a warm
semantic color, but that color cannot become a second general-purpose accent.

## Notes Editor Contract

The existing Workflowy-like editor grammar is preserved:

- the detail canvas remains quiet and unboxed;
- the document content width remains approximately 700 px;
- title and supporting note metrics stay at the approved Notes values;
- normal outline rows have no card background or border;
- bullets, indentation guides, supporting notes, collapse state, completed
  state, and drag behavior retain their current geometry;
- keyboard focus and caret navigation must not move a row vertically;
- draft, attachment, selection, history, and virtualization behavior is
  unchanged.

Only state styling changes:

- a contiguous selection renders as one connected block;
- the first selected row owns the top radius;
- middle rows have no vertical gap or radius;
- the last selected row owns the bottom radius;
- every selected row shares one blue leading rail and accent-soft background;
- drag handles become visible only for hover, focus, drag, or selection as they
  do today.

Expose a presentation-only first, middle, last, or single range position on the
rendered row so CSS can connect the block. Derive it from the existing visible
selection order. Do not add a second selection model or persist the marker.

## Multi-Selection Toolbar and Feedback

Keep the toolbar's existing commands, keyboard model, roving focus, and overflow
rules. Restyle and reflow it within the detail pane.

Desktop behavior:

- selected count is the first group and has a separator;
- common actions remain directly visible while space allows;
- destructive action stays last;
- icon and label alignment uses the 28 px compact control rhythm;
- availability is based on the detail pane width, not the window width.

Feedback behavior:

- the shared polite status and error region is directly below the action row;
- error text is never placed in a remote top-right toast;
- messages wrap to a second line instead of ellipsizing their meaning;
- the region uses semantic foreground, background, border, and an existing
  Lucide status icon;
- successful feedback may collapse after its existing timeout;
- errors remain until the next action, selection clear, or existing dismissal
  rule;
- the message `Indent requires a visible preceding sibling` is represented in
  user language that explains which selected item blocks the command.

At narrow detail widths, less common actions move into More before labels are
hidden. The status row spans the full pane width. A minimum 320 px detail pane
must not horizontally overflow.

## Settings and Shared Controls

Settings uses the same Detail header and control system. The appearance section
must keep theme labels on one line at the current supported desktop widths.

- mode selection uses a three-column segment or an equally compact radio group;
- light and dark theme selectors use a responsive grid with a minimum viable
  option width;
- labels align to a predictable column where space permits;
- control borders use `--control-border`, not the low-contrast passive divider;
- checkboxes and radios use the blue accent with a correct contrast foreground;
- reset and destructive controls keep danger semantics;
- saving, saved, failed, and reset progress states use the shared status tokens.

Do not replace accessible Base UI primitives or change their keyboard behavior.

## Empty, Loading, and Error States

Create one small CSS grammar that existing components can adopt without adding a
new framework:

- optional Lucide icon;
- concise title;
- one helper sentence;
- one primary recovery or creation action when available;
- bounded width, neutral surface, and a dashed or solid control-border outline;
- `role="status"` for loading and non-blocking empty feedback;
- `role="alert"` only for actionable failures that require immediate notice.

Prefer existing component markup when it already exposes the right semantics.
Extract a shared React component only if at least three independent surfaces
need the same structure after the first pass.

## Responsive Behavior

Keep the current desktop, two-column, and narrow breakpoints unless tests show a
specific component cannot fit.

Acceptance rules:

- the 3-pane desktop layout remains usable at 981 px and above;
- the existing two-column layout remains usable from 721 px through 980 px;
- the narrow layout remains usable at 320 px;
- collapsed sidebar, collapsed list, and maximized detail states continue to
  clear the native titlebar controls;
- keyboard pane resizing retains normal and Shift step sizes, minimum and
  maximum clamping, `aria-valuenow`, and persisted width behavior;
- no toolbar chooses its overflow mode from viewport width when its own pane can
  be narrower due to resizing;
- the Settings theme chooser does not wrap a two-word theme name onto two lines;
- list discovery controls leave a scrollable result area at 720 px viewport
  height;
- status and error messages wrap and remain fully readable;
- menus and dialogs stay inside the available viewport and retain keyboard
  focus containment.

Use CSS container queries for pane-owned responsive behavior when supported by
the existing browser target. If a component cannot become a container without
layout risk, feed its measured width through the existing pane-width mechanism
rather than add a global resize listener.

## Interaction and Motion

Motion remains restrained:

- 100 to 160 ms color, border, opacity, and shadow transitions;
- no hover translation on dense application controls or list rows;
- existing modal and popover entrance behavior may remain;
- loading indicators keep their current rotation;
- `prefers-reduced-motion: reduce` disables non-essential transitions and
  animation while preserving progress meaning.

## Accessibility

The redesign must preserve or improve:

- WCAG AA text and control contrast;
- a visible 2 px or equivalent focus indicator on every interactive control;
- distinction between hover, focus, selected, disabled, error, and busy states;
- current accessible names, toolbar roles, roving focus, live regions, dialog
  focus traps, and keyboard shortcuts;
- a 24 px minimum pointer target for compact desktop controls, with larger hit
  areas where layout permits;
- non-color cues for selection, unread state, errors, and active navigation;
- readable feedback at 200 percent zoom without clipped text.

Fix the current completed-filter pressed-state styling so the visual active
state follows `aria-pressed="true"`.

## Implementation Boundaries

Expected primary files:

- `src/styles.css` for tokens, shell geometry, shared surfaces, navigation,
  lists, status bar, detail headers, settings, and shared states;
- `src/features/notes/notes.css` for Notes library, editor state, connected
  selection, toolbar feedback, choosers, and pane-owned responsive rules;
- `src/hooks/useTheme.ts` and tests for the Graphite identifier, default, and
  Soft Paper compatibility;
- `src/components/SettingsPage.tsx` and focused tests for visible theme labels
  and control layout;
- `src/main.tsx` for the pre-React startup color fallback;
- `src/components/ui/form-controls.css`, existing popup/dialog styles, and
  `src/themes/base-ui-pure.css` where their specificity intentionally overrides
  global controls;
- existing feature components only where a semantic wrapper, status placement,
  or container boundary is required.

Preserve intentional GitHub label colors supplied inline by label components.
Those labels represent repository data and are not application accent colors.

Do not introduce a new design-system directory or a broad component rewrite.
Prefer token changes and focused selector corrections. Keep all icons in
`lucide-react`.

## Testing and Verification

Use strict RED/GREEN cycles for behavioral or DOM-structure changes. Pure CSS
token work receives focused source assertions only where the repository already
uses them; visual correctness is verified in the running app.

Automated coverage includes:

- fresh, stored, legacy Soft Paper, explicit Graphite, dark, and system theme
  resolution;
- Settings theme options and app reset behavior;
- Notes selection status semantics and untruncated message markup;
- selection toolbar pane-width or container-query breakpoints;
- completed-filter pressed-state styling;
- existing pane collapse, maximize, Notes editor, notification, settings, and
  shared control tests;
- keyboard pane resizing, step modifiers, clamping, ARIA values, and persisted
  widths;
- table-driven Inbox, Notifications, Notes, detail, and Settings semantics for
  loading, empty, actionable error, and recovery states;
- lint, type-check through the production build, and `git diff --check`.

Visual verification includes at least:

- Graphite light Notes with no selection;
- Graphite light Notes with a connected multi-selection and the full indent
  failure message;
- Graphite light Notifications, GitHub Inbox, issue detail, and Settings;
- default dark Notes and Settings;
- desktop widths at 1280 px and wider;
- breakpoint boundaries at 981 px, 980 px, 721 px, and 720 px;
- a 320 px narrow layout and 200 percent zoom;
- collapsed panes and maximized detail;
- keyboard focus, hover, disabled, error, empty, loading, and modal states;
- reduced-motion preference.

## Acceptance Criteria

The redesign is complete when:

1. A fresh or legacy Soft Paper installation opens in Graphite & Mist.
2. All existing application behavior and keyboard contracts continue to pass.
3. Normal Notes rows remain visually unboxed and preserve approved geometry.
4. Contiguous Notes selections read as one connected range.
5. Selection errors appear below the toolbar in full and never truncate.
6. The Notes library leaves a useful scroll area at supported window heights.
7. Settings theme controls remain readable and do not split theme labels.
8. Graphite light and default dark meet the stated contrast and focus rules.
9. Optional themes remain selectable and do not inherit Graphite-only colors.
10. Desktop, resized, two-column, narrow, collapsed, and maximized layouts have
    no clipped controls, horizontal overflow, or titlebar collisions.
11. The complete frontend test suite, lint, production build, Rust tests, and
    diff check pass.
