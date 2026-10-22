---
name: theme
description: Switch Baseline's look between BR2049 (the default worn-terminal style), Light and a professional navy Dark, for the band above the prompt and the report.
argument-hint: <br2049 | light | dark>
allowed-tools: Bash(baseline:*)
---

The user asked for: $ARGUMENTS

Map that to exactly one of `br2049`, `light` or `dark`. If it is none of them, or nothing was
given, ask with AskUserQuestion: BR2049, Light or Dark. Then run
`baseline config set theme <br2049|light|dark>` with that word only. Confirm in one line. Reports already written keep their
theme until they are regenerated; the report page also has its own theme switch.
