---
name: dismiss
description: Mark a Baseline finding as not applicable, with the reason, so later runs on this project don't raise it again. Use when a finding is deliberate behaviour or a misunderstanding of the product.
argument-hint: <finding id> "<why it does not apply>"
allowed-tools: Bash(baseline:*)
---

Record the note with `baseline dismiss $ARGUMENTS`. If the id or the reason is missing, ask for
it first. Then confirm in one line, and mention that `baseline dismiss --list` shows every note.
