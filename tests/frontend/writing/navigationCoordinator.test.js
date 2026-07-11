import { describe, expect, it } from "vitest";
import { createNavigationCoordinator } from "../../../frontend/src/writing/navigationCoordinator.js";

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe("navigation coordinator", () => {
  it("waits for the save barrier before loading and committing a selection", async () => {
    const coordinator = createNavigationCoordinator();
    const save = deferred();
    const calls = [];
    const committed = [];

    const navigation = coordinator.run({
      flush: async () => {
        calls.push("flush");
        await save.promise;
      },
      load: async () => {
        calls.push("load");
        return { chapterId: "fresh-chapter" };
      },
      commit: (result) => committed.push(result.chapterId),
    });

    expect(calls).toEqual(["flush"]);
    save.resolve();
    await navigation;

    expect(calls).toEqual(["flush", "load"]);
    expect(committed).toEqual(["fresh-chapter"]);
  });

  it("ignores an older load after a newer navigation intent begins", async () => {
    const coordinator = createNavigationCoordinator();
    const load = deferred();
    const committed = [];

    const olderNavigation = coordinator.run({
      flush: async () => {},
      load: async () => load.promise,
      commit: (result) => committed.push(result),
    });

    await Promise.resolve();
    coordinator.begin();
    load.resolve("older story");

    await expect(olderNavigation).resolves.toBeNull();
    expect(committed).toEqual([]);
  });

  it("does not commit when a newer intent starts during the save barrier", async () => {
    const coordinator = createNavigationCoordinator();
    const save = deferred();
    const committed = [];

    const navigation = coordinator.run({
      flush: async () => save.promise,
      load: async () => "should not load",
      commit: (result) => committed.push(result),
    });

    coordinator.begin();
    save.resolve();

    await expect(navigation).resolves.toBeNull();
    expect(committed).toEqual([]);
  });
});
