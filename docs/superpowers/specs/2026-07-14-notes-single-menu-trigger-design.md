# Notes Single Menu Trigger Design

**Status:** Approved for written review

## Goal

Prevent more than one left-side Notes action-menu trigger from appearing at
the same time on desktop pointer devices.

## Root Cause

The current desktop CSS independently reveals a trigger for the selected note,
the hovered note, and the note containing keyboard focus. A zoomed page can
remain selected while a child title is focused, so both triggers become visible.

## Behavior

Desktop fine-pointer environments use one global display priority inside the
Notes outline:

1. Keep the trigger whose popup is open visible.
2. Otherwise show the trigger for the page or row under the pointer.
3. Otherwise show the trigger for the page or row containing keyboard focus.
4. Hide every other trigger.

Moving the pointer away restores the focused row's trigger. Selection alone
does not reveal a trigger. Coarse-pointer and touch environments keep their
existing always-discoverable trigger treatment because they have no hover state.

## Implementation

Express the priority in `notes.css` at the Notes outline boundary. Use CSS
`:has()` conditions to detect an open popup or hovered row and gate the lower
priority focus rule. Target each page or row's direct menu slot so one state
cannot reveal a different row's trigger.

Do not add React hover state or change `NotesBulletMenu`'s popup behavior. This
avoids rerendering the outline while the pointer moves and keeps the change
limited to visibility policy.

## Testing

Update the existing Notes workspace style-contract test to verify:

- selected page and selected row selectors no longer reveal triggers;
- an open popup has the highest-priority visibility rule;
- hover visibility only applies when no popup is open;
- focus visibility only applies when neither popup-open nor hover exists;
- coarse-pointer visibility remains unchanged.

Run the focused Notes workspace test, the full Notes frontend test set, lint,
and the production build. Manually inspect the running app with the onboarding
page selected and a child title focused to confirm only one trigger is visible.

## Out of Scope

- Changing menu commands or popup contents.
- Changing which note is selected or focused.
- Hiding all menu triggers on touch devices.
- Adding shared React state for hover ownership.
