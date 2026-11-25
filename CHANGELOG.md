# Changelog

## [2.0.0](https://github.com/JMBargueno/skanvil/compare/v1.1.1...v2.0.0) (2026-11-25)


### ⚠ BREAKING CHANGES

* validation.requiredSections now includes "Error Recovery" by default. Existing v1.x libraries can configure validation.requiredSections explicitly in .skanvilrc.json or run "skanvil doctor --fix --scaffold-sections" to migrate.

### Features

* add quality lint, evals, feedback loop, multi-library sync, import and diff ([c536db5](https://github.com/JMBargueno/skanvil/commit/c536db56ba43268fc62e202d73607fbd1710a93c))

## [1.1.1](https://github.com/JMBargueno/skanvil/compare/v1.1.0...v1.1.1) (2026-11-11)


### Documentation

* add AI agent rules and simplify the setup prompt ([315f1ad](https://github.com/JMBargueno/skanvil/commit/315f1ad171553e6aa889acad246ea2b22e5e7c98))

## [1.1.0](https://github.com/JMBargueno/skanvil/compare/v1.0.0...v1.1.0) (2026-11-11)


### Features

* parametrized skills and typed package exports ([7f9ff65](https://github.com/JMBargueno/skanvil/commit/7f9ff659140591b5ccc56f867f831853d2573d44))


### Documentation

* add an AI agent setup prompt to getting started ([ee3adae](https://github.com/JMBargueno/skanvil/commit/ee3adae981baab3b5244b555024ac9122d47b56b))

## 1.0.0 (2026-11-10)


### Features

* add interactive wizard ([e3643f8](https://github.com/JMBargueno/skanvil/commit/e3643f8d5034ada4d0a0bf07e9b64270ca3a16fb))
* initial release of skanvil ([a3fa166](https://github.com/JMBargueno/skanvil/commit/a3fa166f1af05b3e60c9ca17a9adbc8826c0042d))


### Documentation

* use canonical JMBargueno casing in repository URLs ([139bd66](https://github.com/JMBargueno/skanvil/commit/139bd66ab267d8ada6557ea91d84e11df88a4803))
