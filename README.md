# Lookie GitHub Action

Triggers a Lookie review on a pull request, waits for it, prints the result to the log and writes a job summary. The review itself is posted to the pull request by the Lookie GitHub App, so the workflow needs no `GITHUB_TOKEN` permissions.

## Usage

1. Install the Lookie GitHub App on the repository.
2. Create an org API token in Lookie → Settings, choose its expiry, and store it as a repository or organisation secret, e.g. `LOOKIE_TOKEN`. Tokens can read and trigger reviews only.
3. Add a workflow:

```yaml
name: Lookie
on: pull_request

permissions: {}

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: sutilab/lookie-action@v1
        with:
          api-url: ${{ vars.LOOKIE_API_URL }}
          token: ${{ secrets.LOOKIE_TOKEN }}
```

Pin the action to a full commit SHA instead of `v1` if your policy requires it.

Pull requests from forks do not receive repository secrets, so the step fails there with a token error. Skip them with `if: github.event.pull_request.head.repo.full_name == github.repository` if that matters to you.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `token` | (required) | Org API token from Lookie → Settings. Masked in the log. |
| `api-url` | (required) | Lookie API URL from Lookie → Settings. Must be `https` (plain `http` only for `localhost`). The token is sent to this URL only, and redirects are refused. |
| `watcher` | `review` | Which watcher to run. Only `review` is available; `ci` is accepted but only logs a warning and requests nothing. |
| `pr-number` | the triggering PR | Pull request to review. Without it the action reads `pull_request.number` from the event payload (or `issue.number` for a comment on a pull request). Required for events that have no pull request, such as `workflow_dispatch`. |
| `wait` | `true` | Poll until the run finishes, then print the findings and write the job summary. With `false` the step ends once the run is queued. |
| `timeout-minutes` | `10` | How long to wait for the run when `wait` is `true`. |

## Outputs

| Output | Description |
| --- | --- |
| `run-id` | ID of the Lookie run. |
| `status` | `queued` when `wait` is `false`; otherwise the final status: `posted`, `skipped`, `failed` or `invalid_output`. |
| `errors` | Number of `error` findings (only when `wait` is `true`). |
| `warnings` | Number of `warning` findings (only when `wait` is `true`). |

To gate a merge on findings, use the outputs in a later step:

```yaml
      - uses: sutilab/lookie-action@v1
        id: lookie
        with:
          api-url: ${{ vars.LOOKIE_API_URL }}
          token: ${{ secrets.LOOKIE_TOKEN }}
      - if: steps.lookie.outputs.errors != '0'
        run: |
          echo "Lookie found ${{ steps.lookie.outputs.errors }} error(s)"
          exit 1
```

## What it does

1. `POST {api-url}/api/v1/runs` with `Authorization: Bearer <token>` and `{ "repo": "<owner/name>", "pr": <number>, "watcher": "review" }`. The API answers `202 { "id", "status": "queued" }`.
2. With `wait`, `GET {api-url}/api/v1/runs/{id}` every 3 s, doubling up to every 15 s, until the status is `posted`, `skipped`, `failed` or `invalid_output`, or `timeout-minutes` passes.
3. Logs the status, the finding counts, one line per finding and the review summary, and writes the same as a job summary (a table of findings by location, severity and title).

## When the step fails

Findings never fail the step: a review with errors in it still passes, and the counts are in the outputs for you to act on.

The step fails on:

- invalid inputs, or no pull request to review;
- `401` or `403`: the token was refused — create an org API token in Lookie → Settings;
- `404`: Lookie does not know the repository or pull request for that token's org (the GitHub App is not installed on it, or the token belongs to another org);
- `429`: the request is retried once after `Retry-After` (at most 60 s), then fails;
- other API errors and network errors (while polling, two transient errors in a row are tolerated);
- the run not finishing within `timeout-minutes`;
- a run whose status is `failed` (Lookie could not complete the review).

A run that ends `invalid_output` (the model's answer did not validate, so nothing was posted) passes with a warning; `skipped` passes.

## Development

```sh
pnpm --filter @lookie/action typecheck
pnpm --filter @lookie/action test
pnpm --filter @lookie/action build   # rebuilds dist/index.js; commit it
```

Actions run `dist/index.js` directly, so the bundle is committed. `dist/package.json` marks it as an ES module.
