# Release guide

How to publish a new version of `skill-library` to npm.

- **First time only:** set up npm and GitHub with
  [docs/10-releasing.md](docs/10-releasing.md).
- **Run a release:**
  - Open **Actions → Release → Run workflow**.
  - Leave the branch on `develop`.
  - Pick a **Version bump** (default `patch`):
    - `patch`: `1.2.3` → `1.2.4`, for bug fixes.
    - `minor`: `1.2.3` → `1.3.0`, for new features that don't break anything.
    - `major`: `1.2.3` → `2.0.0`, for breaking changes.
  - Pick a **Release type** (default `prerelease`, so you never release a stable
    version by accident):
    - `prerelease`: a release candidate, published to npm `next`.
      `1.2.3` + `minor` → `1.3.0-rc.0`.
    - `release`: a stable version, published to npm `latest`.
      `1.2.3` + `minor` → `1.3.0`.
  - Release candidates, step by step (keep the same **Version bump** each time):
    - `minor` + `prerelease`: `1.2.3` → `1.3.0-rc.0`.
    - `minor` + `prerelease` again: `1.3.0-rc.0` → `1.3.0-rc.1`, `1.3.0-rc.2`, ...
    - `minor` + `release`: `1.3.0-rc.2` → `1.3.0`.
    - A bigger bump on a candidate starts a new one: `major` + `prerelease` on
      `1.3.0-rc.2` → `2.0.0-rc.0`.
  - **Dry run** is ticked by default: it checks everything without pushing or
    publishing. Untick it to release for real.
  - **Prerelease identifier** (default `rc`) is only used for prereleases; `beta`
    gives `1.3.0-beta.0`.
  - Click **Run workflow**.
  - Wait for **Plan release** to finish, then open the run's summary. It shows:
    - What is published now: npm `latest` and `next`, the latest GitHub Release
      and git tag.
    - What this run will publish: the new version, tag and npm dist-tag.
    - Any blockers. With a blocker the run stops and nothing is published.
    - The changes since the last release and the files in the npm package.
  - If everything is correct, click **Review deployments**, tick `release` and
    **Approve and deploy**. To stop, click **Reject** instead.
  - Wait for the remaining jobs to go green.
  - Check the new version on [npm](https://www.npmjs.com/package/skill-library)
    and the new GitHub Release.
- **What the workflow does:**
  - Tests, typechecks and builds, and writes the release plan summary.
  - Stops on a blocker: the version or tag already exists, or a stable version
    isn't newer than npm `latest`.
  - Waits for your approval on the `release` environment.
  - Commits the new version to `develop` and pushes a `vX.Y.Z` tag. If `develop`
    moved since the plan, it stops instead.
  - Publishes that tag to npm with provenance. Prereleases go to the `next`
    dist-tag.
  - Creates a GitHub Release with generated notes.
- **If it fails:**
  - **Publish failed:** click **Re-run failed jobs**. It publishes the tag that
    was already pushed, without bumping again.
  - **"may not run releases":** only the repository owner can release, unless
    the `RELEASE_ACTORS` repository variable lists your GitHub login.
