# Ginger: notes for Claude

## Branch naming

Name every branch by the kind of change, with a short kebab-case description:

- `fix/<description>`: bug fixes (e.g. `fix/code-review-findings`)
- `feature/<description>`: new features (e.g. `feature/online-ordering`)
- `refactor/<description>`: restructuring without behavior change
- `docs/<description>`: README and other docs only
- `test/<description>`: tests only
- `chore/<description>`: tooling, dependencies, config

Don't use auto-generated names such as `claude/<random>`. If a session starts on
one, create a properly named branch from it before committing, and push that.
