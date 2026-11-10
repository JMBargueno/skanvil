/**
 * Console output for commands.
 *
 * @module
 */
import pc from "picocolors";

/**
 * Prefixed console logger for a command (`[add] …`).
 *
 * @remarks In `--json` mode, informational output is silenced so stdout only carries the JSON
 * printed by {@link Output.data}. Warnings and errors still go to stderr. Colours follow
 * picocolors' detection and honour `NO_COLOR`.
 */
export class Output {
  /**
   * @param label - Command name used as prefix.
   * @param json - Machine-readable mode. @defaultValue `false`
   */
  constructor(
    readonly label: string,
    readonly json = false
  ) {}

  /** Prints an informational line (stdout, silenced in JSON mode). */
  info(message: string): void {
    if (!this.json) console.log(`[${this.label}] ${message}`);
  }

  /** Prints a success line in green (stdout, silenced in JSON mode). */
  success(message: string): void {
    if (!this.json) console.log(pc.green(`[${this.label}] ${message}`));
  }

  /** Prints a warning in yellow (stderr, always). */
  warn(message: string): void {
    console.warn(pc.yellow(`[${this.label}] ${message}`));
  }

  /** Prints an error in red (stderr, always). */
  error(message: string): void {
    console.error(pc.red(`[${this.label}] ${message}`));
  }

  /** Prints an unprefixed line (stdout, silenced in JSON mode). */
  print(message: string): void {
    if (!this.json) console.log(message);
  }

  /** Prints `value` as pretty JSON, only in JSON mode. */
  data(value: unknown): void {
    if (this.json) console.log(JSON.stringify(value, null, 2));
  }
}
