---
name: theme
description: Switch Baseline's look between BR2049 (the default worn-terminal style), Light and a professional navy Dark, for the band above the prompt and the report.
argument-hint: <br2049 | light | dark>
allowed-tools: Bash(baseline:*)
---

Set the theme with `baseline config set theme $ARGUMENTS`. If no theme was given, ask with
AskUserQuestion: BR2049, Light or Dark. Confirm in one line. Reports already written keep their
theme until they are regenerated; the report page also has its own theme switch.
