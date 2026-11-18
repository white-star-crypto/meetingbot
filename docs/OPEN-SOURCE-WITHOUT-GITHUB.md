# GitHub account blocked — what to do

GitHub does not require Google or Apple. It requires an email address it can
verify. If Outlook/QQ verification fails, try in this order:

1. **163.com / 126.com** — usually accepted and accessible in China.
2. **Proton Mail** — free, but sometimes requires a phone or waits.
3. **Gmail** — if you can create one without the blocked verification.
4. **GitHub mobile app / different network** — sometimes the email code arrives
   but the page/network times out.

Do not use disposable email services. GitHub often blocks them and the account
can be flagged later.

## Open source without GitHub

You do not need GitHub to publish the project.

### Gitee (recommended for China)

- phone registration, Chinese UI
- supports releases and issues
- can mirror to GitHub later
- https://gitee.com

### GitCode / AtomGit / CNB

Alternative domestic hosts:

- https://gitcode.com
- https://atomgit.com
- https://cnb.cool

### GitLab / Codeberg

International alternatives; email registration may be easier than GitHub:

- https://gitlab.com
- https://codeberg.org

### npm / release archive

An open-source project can ship:

- source zip
- `LICENSE`
- README
- release notes
- checksum

That is still open source, even without a social-coding host. GitHub is a
distribution and collaboration layer, not a license requirement.

## Suggested path

1. Publish on Gitee first; keep the Git history.
2. Put the source zip on a file host.
3. Later mirror to GitHub when the account works.
4. Do not use a fake identity or a purchased account.

If you want, the next practical step is to prepare a Gitee-ready repository:
README, LICENSE, `.gitignore`, release notes and a clean source archive.
