# Releasing

Versions follow [Semantic Versioning](https://semver.org/) and are kept in
`version-name` in `metadata.json`. The fork's versions start at 1.0.0 and are
independent of upstream's `v66`-style numbers.

- Patch (`1.0.1`): bug fixes only.
- Minor (`1.1.0`): new features or settings, or support for another GNOME version.
- Major (`2.0.0`): changes that need action from users, such as dropping a GNOME
  version or moving the settings or the cache.

## Publishing a version

1. Open a pull request that changes `version-name` and merge it once CI passes.
2. Tag the merge commit and push only that tag:

   ```bash
   git switch master && git pull
   git tag v1.1.0
   git push origin v1.1.0
   ```

The `Release` workflow then checks that the tag matches `version-name` and is on
`master`, reruns CI on the tagged commit, and creates a GitHub Release with the
zip, its SHA-256 and notes generated from the merged pull requests.

If the workflow fails, nothing is published. Fix the problem, delete the tag
(`git push origin :refs/tags/v1.1.0 && git tag -d v1.1.0`) and start again with
the fixed commit.

Do not use `git push --tags`: the `upstream` remote's tags would be pushed too.

## Installing a release

```bash
gnome-extensions install --force clipboard-indicator@wuxler.github.io.zip
```

Then log out and back in, and enable the extension if it is new.

## extensions.gnome.org

Releases are not uploaded to extensions.gnome.org.
