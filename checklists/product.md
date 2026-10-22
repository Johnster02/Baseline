# Baseline product checklist

What any feature must not do to the people using it, whatever its spec says. A finding from this
list has verdict `product`, names the item in `checklistItem` (for example `W-01`), and describes
what was seen. It is an opinion backed by evidence, never a spec conflict.

Extend it per project with `baseline config set checklistExtra '["..."]'`.

## W: The work can be finished (usually critical or high)

- **W-01 Every journey reaches its end.** Each major flow the change belongs to can be completed.
  A control that stays greyed out once the work is done is a blocker.
- **W-02 A request reaches someone.** Anything a user sends lands in front of a person who can act
  on it: a list row, a notification, a queue. Sent into nowhere is a blocker.
- **W-03 Added later still counts.** Things added after the first submit flow through exactly as
  the originals did.
- **W-04 Every created thing can be filled in.** A row or item that can be added can also be given
  its details, by the same people.

## S: State reads true on every surface (high or medium)

- **S-01 Status words match the state.** Pending does not say "Confirmed"; cancelled does not look live.
- **S-02 One change, every surface.** After a change, every screen that shows the object shows the
  new value without a refresh.
- **S-03 Copy follows the state.** Prompts and empty states stop asking for what is already done.
- **S-04 Things say where they belong.** Items shown out of context name their parent.

## P: Twin surfaces agree (medium)

- **P-01 Same object, same actions.** If one screen can do something to an object, its twin
  screens can too, or say why not.
- **P-02 Shared fields can be edited from both sides** without overwriting each other.
- **P-03 Every role that needs a screen can open it.**
- **P-04 Unavailable options are unavailable everywhere.**

## D: Destructive and risky actions (high or medium)

- **D-01 Warn before work is lost.** Changing a type, removing a row or closing a form that would
  lose typed or saved work asks first.
- **D-02 Remove one, keep the rest.** Removing one item of many is possible, and the last one is guarded.
- **D-03 Unsaved edits block a send,** and sending money or a commitment is confirmed.

## U: The interface explains itself (medium or low)

- **U-01 Greyed controls say why.** Any disabled control shows its reason as visible text, not
  only a tooltip.
- **U-02 Busy while working.** A button that starts something shows a busy state and cannot be
  pressed twice.
- **U-03 Nothing clips.** Long names, many items and narrow screens wrap, scroll or collapse into a
  "+N more"; nothing is cut off or overlaps.
- **U-04 Every empty state explains itself** and says what to do next.
- **U-05 Errors say what to do,** in plain words, next to the thing that failed.
- **U-06 No dead ends.** Every screen has a way back or forward; no control does nothing.

## A: Access (medium)

- **A-01 Controls have names.** Buttons and fields can be found by their visible label or an
  accessible name.
- **A-02 Keyboard works.** The main flow can be done with the keyboard alone.
