<!-- managed:linked-repos -->
## Linked Repositories
- sabahcapital-a11y/operator
<!-- /managed:linked-repos -->

# Silentbreak Workflow

## Branch Strategy

- **`main`** — production-ready code. Always deployable.
- **Feature branches** — all work happens on branches named `feature/<slug>` (e.g., `feature/phase-2-onboard`).
- Never commit directly to `main`.

## Pull Request Process

1. Create a feature branch from `main`.
2. Commit and push your work to the feature branch.
3. Open a Pull Request against `main`.
4. The **lead** reviews and merges PRs. No self-merging.
5. **Squash merge** — each PR becomes a single clean commit on `main`.

## Commit Conventions

- Write commits in the imperative: `Add onboarding crawler`, `Fix cookie banner timeout`.
- Keep commits atomic — one logical change per commit.
- Reference phase or task context in the PR description.

## Code Review

- PRs should include a brief description of what changed and why.
- The lead checks for correctness, consistency with the business plan, and code quality.
- Address review feedback in follow-up commits on the same branch.

## Working Directory

- The shared workspace is at `/home/team/shared/`.
- The main repo is `/home/team/shared/leadguard/`.
- The live site is at `/home/team/shared/site/` (TanStack Start, port 3000).
