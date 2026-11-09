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

## 3. Create the `release` and `npm` environments on GitHub

The `release` environment is the approval gate: the workflow stops there until you
have checked the release plan summary.

1. Go to the repository's **Settings → Environments → New environment** and name it `release`.
2. Tick **Required reviewers** and add yourself.
3. Leave **Prevent self-review** unticked, or you can't approve your own releases.
4. Under **Deployment branches and tags**, choose **Selected branches and tags**
   and add `develop`.
5. Save, then create a second environment named `npm` with the same branch rule
   (step 4) and no reviewers. npm's trusted publisher checks for this name.

Without required reviewers on `release`, the workflow doesn't wait for approval.

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
   **Dry run**.
2. When **Plan release** finishes, check the summary, then approve under
   **Review deployments**. It should go green without pushing or publishing
   anything.
3. Run it again without **Dry run**, check the summary, approve, and check the
   new version on npm (with a provenance badge) and the new GitHub Release.

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
