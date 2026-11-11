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

## Using These Skills From Code

`npm run build` (run automatically before publishing) generates typed exports, one function per skill:

```js
import { skills, getSkill } from "{{packageName}}";

for (const skill of skills) console.log(skill.name, skill.description);
const markdown = getSkill(skills[0].name).render(); // SKILL.md, rendered with default parameters
```

Skills can declare parameters in a `params.json` next to their `SKILL.md`; see the skanvil docs on parameters and exports.
