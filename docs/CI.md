# CI Integration Guide

This document explains how to integrate the wallet E2E tests into your CI/CD pipeline.

## Overview

The `wallet-e2e-tests` repository provides a reusable GitHub Actions workflow that can test any combination of `wallet-frontend` and `go-wallet-backend` versions. This enables:

- **Forward compatibility testing**: Test new frontend changes against stable backend versions
- **Backward compatibility testing**: Test new backend changes against stable frontend versions  
- **Cross-repository validation**: Ensure changes in one repo don't break the other

## Quick Start

### For wallet-frontend repository (or fork)

Create `.github/workflows/e2e.yml`:

```yaml
name: E2E Tests

on:
  push:
    branches: [master, develop]
  pull_request:
    branches: [master]

jobs:
  e2e:
    uses: sirosfoundation/wallet-e2e-tests/.github/workflows/e2e-tests.yml@main
    with:
      # Test this PR/commit against known-good backend versions
      frontend-ref: ${{ github.sha }}
      # Use this repo (works for forks too)
      frontend-repo: ${{ github.server_url }}/${{ github.repository }}.git
      backend-refs: '["main", "v1.0.0"]'
```

### For go-wallet-backend repository (or fork)

Create `.github/workflows/e2e.yml`:

```yaml
name: E2E Tests

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  e2e:
    uses: sirosfoundation/wallet-e2e-tests/.github/workflows/e2e-tests.yml@main
    with:
      # Test this PR/commit against known-good frontend versions
      backend-ref: ${{ github.sha }}
      # Use this repo (works for forks too)
      backend-repo: ${{ github.server_url }}/${{ github.repository }}.git
      frontend-refs: '["master", "v1.0.0"]'
```

## Workflow Inputs

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `frontend-ref` | string | `''` | Single git ref for wallet-frontend |
| `backend-ref` | string | `''` | Single git ref for go-wallet-backend |
| `frontend-refs` | string | `'[]'` | JSON array of frontend refs to test against |
| `backend-refs` | string | `'[]'` | JSON array of backend refs to test against |
| `frontend-repo` | string | `https://github.com/wwWallet/wallet-frontend.git` | Frontend repository URL |
| `backend-repo` | string | `https://github.com/sirosfoundation/go-wallet-backend.git` | Backend repository URL |
| `test-filter` | string | `''` | Playwright grep filter (e.g., `@prf`) |
| `timeout-minutes` | number | `30` | Job timeout |

## Usage Patterns

### Test against multiple backend versions

```yaml
jobs:
  e2e:
    uses: sirosfoundation/wallet-e2e-tests/.github/workflows/e2e-tests.yml@main
    with:
      frontend-ref: ${{ github.sha }}
      backend-refs: '["main", "v1.2.0", "v1.1.0"]'
```

This creates a matrix that tests your frontend change against each backend version.

### Test against multiple frontend versions

```yaml
jobs:
  e2e:
    uses: sirosfoundation/wallet-e2e-tests/.github/workflows/e2e-tests.yml@main
    with:
      backend-ref: ${{ github.sha }}
      frontend-refs: '["master", "v2.0.0", "v1.5.0"]'
```

### Test a specific combination

```yaml
jobs:
  e2e:
    uses: sirosfoundation/wallet-e2e-tests/.github/workflows/e2e-tests.yml@main
    with:
      frontend-ref: 'feature/new-ui'
      backend-ref: 'feature/new-api'
```

### Test with custom repositories (forks)

```yaml
jobs:
  e2e:
    uses: sirosfoundation/wallet-e2e-tests/.github/workflows/e2e-tests.yml@main
    with:
      frontend-ref: 'main'
      backend-ref: 'main'
      frontend-repo: 'https://github.com/myorg/wallet-frontend.git'
      backend-repo: 'https://github.com/myorg/go-wallet-backend.git'
```

### Run only specific tests

```yaml
jobs:
  e2e-quick:
    uses: sirosfoundation/wallet-e2e-tests/.github/workflows/e2e-tests.yml@main
    with:
      frontend-ref: ${{ github.sha }}
      backend-ref: 'main'
      test-filter: '@registration'  # Only run registration tests
```

## Available Test Tags

| Tag | Description |
|-----|-------------|
| `@prf` | PRF (Pseudo-Random Function) extension tests |
| `@registration` | User registration flow tests |
| `@login` | Login flow tests |
| `@authenticated` | Authenticated user flow tests |
| `@api` | API compatibility tests |
| `@full-flow` | Complete registration + login + credential tests |
| `@diagnostics` | Diagnostic and debugging tests |

## Artifacts

The workflow uploads these artifacts on test failure:

- **test-results-{frontend}-{backend}**: Raw test results
- **playwright-report-{frontend}-{backend}**: HTML report with screenshots/traces

Download and open `playwright-report/index.html` to see detailed failure information.

## Versioning Strategy

### Recommended: Semantic Versioning

Tag your releases with semantic versions:

```bash
# In wallet-frontend
git tag v2.1.0
git push --tags

# In go-wallet-backend  
git tag v1.3.0
git push --tags
```

Then reference them in CI:

```yaml
backend-refs: '["main", "v1.3.0", "v1.2.0"]'
```

### Maintaining Compatibility

1. **Breaking changes**: Increment major version, update CI to test against new major
2. **New features**: Increment minor version, keep testing against previous minors
3. **Bug fixes**: Increment patch version, compatibility should be maintained

## Example: Complete CI Setup

### wallet-frontend/.github/workflows/e2e.yml

```yaml
name: E2E Tests

on:
  push:
    branches: [master, develop]
  pull_request:
    branches: [master]

concurrency:
  group: e2e-${{ github.ref }}
  cancel-in-progress: true

jobs:
  # Quick smoke test on every push
  smoke-test:
    uses: sirosfoundation/wallet-e2e-tests/.github/workflows/e2e-tests.yml@main
    with:
      frontend-ref: ${{ github.sha }}
      backend-ref: 'main'
      test-filter: '@registration'
      timeout-minutes: 15

  # Full compatibility matrix on PRs to master
  compatibility-matrix:
    if: github.event_name == 'pull_request'
    uses: sirosfoundation/wallet-e2e-tests/.github/workflows/e2e-tests.yml@main
    with:
      frontend-ref: ${{ github.sha }}
      backend-refs: '["main", "v1.2.0", "v1.1.0"]'
      timeout-minutes: 45
```

### go-wallet-backend/.github/workflows/e2e.yml

```yaml
name: E2E Tests

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

concurrency:
  group: e2e-${{ github.ref }}
  cancel-in-progress: true

jobs:
  # Quick smoke test on every push
  smoke-test:
    uses: sirosfoundation/wallet-e2e-tests/.github/workflows/e2e-tests.yml@main
    with:
      backend-ref: ${{ github.sha }}
      frontend-ref: 'master'
      test-filter: '@registration'
      timeout-minutes: 15

  # Full compatibility matrix on PRs to main
  compatibility-matrix:
    if: github.event_name == 'pull_request'
    uses: sirosfoundation/wallet-e2e-tests/.github/workflows/e2e-tests.yml@main
    with:
      backend-ref: ${{ github.sha }}
      frontend-refs: '["master", "v2.0.0", "v1.5.0"]'
      timeout-minutes: 45
```

## Local Testing

Before pushing, you can run the same tests locally:

```bash
# Clone the E2E test repo
git clone https://github.com/sirosfoundation/wallet-e2e-tests.git
cd wallet-e2e-tests

# Test specific versions
make setup-git \
  FRONTEND_REF=master \
  BACKEND_REF=main

# Run tests
make test

# Cleanup
make teardown
```

## Troubleshooting

### Workflow not found

Ensure the E2E test repository is public or your workflow has access:

```yaml
jobs:
  e2e:
    uses: sirosfoundation/wallet-e2e-tests/.github/workflows/e2e-tests.yml@main
    # Add secrets if needed for private repos
    secrets: inherit
```

### Tests timeout

Increase the timeout:

```yaml
with:
  timeout-minutes: 60
```

### Clone fails

If using a tag that doesn't exist yet, ensure you've pushed the tag:

```bash
git push origin v1.2.0
```

### Tests pass locally but fail in CI

Check for environment differences:
- Node.js version (CI uses v20)
- Go version (CI uses v1.22)
- Chrome version (CI installs latest)

## Support

- **Issues**: https://github.com/sirosfoundation/wallet-e2e-tests/issues
- **Test failures**: Check the uploaded artifacts for detailed reports
