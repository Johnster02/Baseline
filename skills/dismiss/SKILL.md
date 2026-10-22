---
name: dismiss
description: Mark a Baseline finding as not applicable, with the reason, so later runs on this project don't raise it again. Use when a finding is deliberate behaviour or a misunderstanding of the product.
argument-hint: <finding id> "<why it does not apply>"
allowed-tools: Bash(baseline:*)
---

The user asked: $ARGUMENTS

Work out the finding id (like `R-03`) and the reason. If either is missing, ask for it first.
Then run `baseline dismiss '<id>' '<reason>'`, single-quoting both and replacing any single
quote inside the reason with a typographic one (’), so nothing in it reaches the shell. Then confirm in one line, and mention that `baseline dismiss --list` shows every note.
