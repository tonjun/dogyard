# Security policy

## Supported versions

DogYard is pre-1.0. Security fixes are made against the latest released minor
version only.

## Reporting a vulnerability

Please **do not** open a public issue. Use GitHub's private vulnerability
reporting: go to the repository's **Security** tab and choose **Report a
vulnerability**. Include the version, a description, and steps to reproduce.

You can expect an acknowledgement within a few days. Fixes are released as soon
as practical and credited to the reporter unless you prefer otherwise.

## Scope

DogYard executes the commands a flow defines, with the invoking user's
permissions and environment; running an untrusted flow is equivalent to running
an untrusted script and is not a vulnerability in itself. See
[docs/security.md](docs/security.md) for what is and is not protected. In scope:
flaws that let a flow, dataset, mock or trace file cause behavior beyond what
its documented fields describe (for example, path traversal out of the flow
folder through a documented field, or shell injection despite argv execution).
