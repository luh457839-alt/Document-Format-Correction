---
name: document-format-project-workflow
description: Use when working in the Document Format Correction repository on implementation, refactoring, fixes, verification, review, handoff, or commit preparation tasks that must preserve project construction records and review findings.
---

# Document Format Project Workflow

## Core Rule

Keep every meaningful project change auditable. Before implementation, record the construction target. After implementation, record what changed and how it was verified. During review, record findings in the review log.

Use these project documents:

- Construction log: `docs/施工目标与变更记录.md`
- Review log: `docs/review问题与缺陷记录.md`

## Implementation Workflow

1. Read the latest relevant entries in both logs before changing files.
2. Append a new construction entry before implementation with status `planned`.
3. Include the goal, scope, intended files or subsystems, validation plan, and known constraints.
4. Implement the change.
5. Update the same construction entry to status `completed`, `blocked`, or `partial`.
6. Record the actual implementation, changed files, verification commands, results, and residual risks.
7. If defects or risks are found while implementing, also append them to the review log.

Do not make tracked code or documentation changes for implementation work without a matching construction entry.

## Review Workflow

1. Read the latest construction entry if the review relates to recent work.
2. Inspect the diff and relevant surrounding code.
3. Report findings first, ordered by severity.
4. Append each valid finding to `docs/review问题与缺陷记录.md`.
5. If there are no blocking findings, append a review entry stating no blocking issue was found and list residual risk.

Use these review statuses:

- `open`
- `accepted`
- `fixed`
- `deferred`
- `won't-fix`

## Handoff Workflow

1. Read both logs.
2. Summarize current tracked and untracked work separately.
3. Include completed validation, missing validation, unresolved review findings, ignored paths, and recommended next steps.
4. Do not create new implementation changes during handoff unless the user explicitly asks for implementation.

## Entry Standards

Use append-only records. If a record needs correction, add a short correction line with the current date instead of deleting history.

Each construction entry must include:

- Date/time
- Status
- Goal
- Scope
- Plan
- Implementation notes
- Validation
- Residual risks

Each review entry must include:

- Date/time
- Review target
- Severity
- Finding
- Evidence
- Recommendation
- Status
