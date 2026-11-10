# Release guide

How to publish a new version of `skill-library` to npm.

- **First time only:** set up npm and GitHub with
  [docs/10-releasing.md](docs/10-releasing.md).
- **Run a release:**
  - Open **Actions → Release → Run workflow**.
  - Leave the branch on `develop`.
  - Pick a **Version bump**. Each run bumps the current version in
    `package.json`; examples from `1.2.3`:
    - `patch`: `1.2.3` → `1.2.4`, for bug fixes.
    - `minor`: `1.2.3` → `1.3.0`, for new features that don't break anything.
    - `major`: `1.2.3` → `2.0.0`, for breaking changes.
    - `prepatch`: `1.2.3` → `1.2.4-rc.0`, the first release candidate of a patch.
    - `preminor`: `1.2.3` → `1.3.0-rc.0`, the first release candidate of a minor.
    - `premajor`: `1.2.3` → `2.0.0-rc.0`, the first release candidate of a major.
    - `prerelease`: `1.3.0-rc.0` → `1.3.0-rc.1`, the next release candidate.
  - For a `pre*` bump, set the **Prerelease identifier** (default `rc`; `beta`
    gives `1.3.0-beta.0`).
  - Release candidates, step by step:
    - Run `preminor` once to get `1.3.0-rc.0`.
    - Run `prerelease` for each next candidate: `1.3.0-rc.1`, `1.3.0-rc.2`, ...
    - Run `minor` to release it: `1.3.0-rc.2` → `1.3.0`.
    - Don't run `preminor` again on a candidate: that starts `1.4.0-rc.0`.
  - **Dry run** is ticked by default: it checks everything without pushing or
    publishing. Untick it to release for real.
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
