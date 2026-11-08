# 10 — Releasing: one-time setup

What to set up once so the [Release workflow](../.github/workflows/release.yml)
can publish `skill-library` to npm. After that, every release is
**Actions → Release → Run workflow**.

## 1. Merge the workflow into `develop`

GitHub only shows a manually started workflow once its file is on the default
branch. Merge the PR that adds `.github/workflows/release.yml`.

## 2. Add a trusted publisher on npm

This lets GitHub Actions publish without an npm token.

1. Go to <https://www.npmjs.com/package/skill-library/access> and sign in.
2. Under **Trusted Publisher**, pick **GitHub Actions** and fill in:
   - Organization or user: `ianwijma`
   - Repository: `skill-library-skill`
   - Workflow filename: `release.yml`
   - Environment name: `npm`
3. Save.

## 3. Create the `npm` environment on GitHub

1. Go to the repository's **Settings → Environments → New environment** and name it `npm`.
2. Under **Deployment branches and tags**, choose **Selected branches and tags**
   and add `develop`.
3. Optional: tick **Required reviewers** and add yourself to approve each
   publish. The version commit and tag are already pushed when it asks.

## 4. Check the Actions settings

Under **Settings → Actions → General**, check that Actions are allowed. The
workflow sets its own permissions, so the **Workflow permissions** default can
stay on "Read repository contents".

## 5. Optional: allow other people to release

Only the repository owner can release by default. To allow others, add a
repository variable under **Settings → Secrets and variables → Actions →
Variables**: name `RELEASE_ACTORS`, value a list of GitHub logins
(`ianwijma otheruser`). They also need write access to the repository.

## 6. Tag the version that is already published

`0.1.0` is on npm without a git tag. Tag the commit it was published from, so the
first generated release notes start there:

```sh
git tag v0.1.0 <commit-sha>
git push origin v0.1.0
```

## 7. Try it

1. **Actions → Release → Run workflow**, branch `develop`, bump `patch`, tick
   **Dry run**. It should go green without pushing or publishing anything.
2. Run it again without **Dry run**. Check the new version on npm (with a
   provenance badge) and the new GitHub Release.

## 8. Lock down npm

Once a release from the workflow has worked:

1. On the package's **Settings** page on npmjs.com, set **Publishing access** to
   require two-factor authentication and disallow tokens.
2. Delete any npm access tokens you made for publishing by hand
   (<https://www.npmjs.com/settings/~/tokens>).

## Later: protecting `develop`

If you add a branch protection rule or ruleset that blocks direct pushes to
`develop`, add **GitHub Actions** to its bypass list. Otherwise the workflow
can't push the release commit.
