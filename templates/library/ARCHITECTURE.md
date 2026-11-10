# Architecture

```text
{{name}}/
|- skills/            # one folder per skill, each with SKILL.md
|  |- <skill>/
|     |- SKILL.md
|     |- references/  # optional deep guidance
|     |- scripts/     # optional helpers
|     |- assets/      # optional templates
|- README.md          # index of public skills
|- .skanvilrc.json    # categories, validation rules, sync targets
```

Skills are created, edited and validated with the `skanvil` CLI.
