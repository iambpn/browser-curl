/**
 * Runs tasks with the same key one after another. Tasks with different keys
 * run at the same time.
 */

/** Lets only one task for each key run at a time, in the order the tasks arrive. */
export class KeyedLock {
  /** The end of the task chain of each key that has a task in progress. */
  readonly #chainEnds = new Map<string, Promise<void>>();

  /**
   * Runs a task when every earlier task with the same key has ended.
   *
   * @param key The key, such as a branch name.
   * @param task The work to run alone.
   * @returns What the task returns. A failed task does not stop later tasks.
   */
  async run<Result>(key: string, task: () => Promise<Result>): Promise<Result> {
    const previousEnd = this.#chainEnds.get(key) ?? Promise.resolve();
    let releaseKey: () => void = () => {};
    const taskEnd = new Promise<void>(function keepRelease(resolve) {
      releaseKey = resolve;
    });
    const chainEnd = previousEnd.then(() => taskEnd);
    this.#chainEnds.set(key, chainEnd);

    await previousEnd;
    try {
      return await task();
    } finally {
      releaseKey();
      if (this.#chainEnds.get(key) === chainEnd) {
        this.#chainEnds.delete(key);
      }
    }
  }
}
