# Optional Follow-up Prompts

Use the master instructions and project rules first. These prompts do not
override the approval boundary.

## Prototype processing improvements

> Re-read `architecture.md`, `rules.md`, `image_pipeline.md`, and
> `test_plan.md`. Improve only the isolated processor. Use synthetic tests,
> preserve source hashes, require safe timestamp recovery evidence, and do not
> modify production app files.

## Integration review (no edits outside this directory)

> Inspect the exact admin UI/API/auth/storage/deployment integration points.
> Produce a file-by-file proposed change list, role authorization design,
> resource access rules, failure modes, risk analysis, and regression test
> plan. Do not edit files outside `Admin Builder`; ask for approval first.

## Integration after approval

> Proceed only with the exact outside-folder files explicitly approved by the
> user. Implement server-side admin authorization for every endpoint,
> access-controlled downloads, separate derivative storage, provenance, and
> regression tests. Do not modify normal photo/evidence upload behavior.

## Visual regression investigation

> Compare an operator-approved synthetic or local source/result pair at native
> resolution. Identify the responsible processing stage; fix only that stage
> and add a regression test. Never recreate the scene to hide an issue.
