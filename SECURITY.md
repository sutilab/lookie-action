# Security

Please report vulnerabilities privately through **Security → Report a vulnerability** on this
repository, not in a public issue.

## What this action does with your token

- The `token` input is masked in the workflow log.
- It is sent only to the `api-url` you configure. That URL must be `https` (plain `http` only to
  `localhost`), and HTTP redirects are refused, so the token cannot be forwarded to another host.
- The action reads only the triggering event's pull request number and `GITHUB_REPOSITORY`. It
  needs no `GITHUB_TOKEN` permissions (`permissions: {}` is enough).
- Use an org API token with an expiry, store it as a secret, and revoke it in Lookie → Settings if
  it may have leaked.
