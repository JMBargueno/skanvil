# {{title}}

{{description}}

## Skills Index

{{sections}}

## Working With This Library

```bash
npx skanvil add                    # create a new skill
npx skanvil edit <skill> --rename <new-name>
npx skanvil list                   # list skills and their status
npx skanvil validate               # check conventions (also runs on prebuild)
npx skanvil doctor --fix           # repair index and frontmatter issues
npx skanvil sync ../app --target claude   # install skills into a project
```

Categories, validation rules and sync targets are configured in `.skanvilrc.json`.
