import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSaveCoordinator } from "../../../frontend/src/writing/saveCoordinator.js";

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function chapter(content, revision, storyId = "story", chapterId = "chapter") {
  return {
    id: chapterId,
    story_id: storyId,
    content,
    revision,
  };
}

function setupCoordinator() {
  const calls = [];
  const coordinator = createSaveCoordinator({
    saveChapter: (request) => {
      const nextCall = deferred();
      calls.push({ request, ...nextCall });
      return nextCall.promise;
    },
  });
  return { calls, coordinator };
}

describe("save coordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces edits during the debounce window", async () => {
    const { calls, coordinator } = setupCoordinator();
    coordinator.queueDraft("story", "chapter", "first", 0);
    coordinator.queueDraft("story", "chapter", "newest", 0);

    await vi.advanceTimersByTimeAsync(599);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].request.content).toBe("newest");

    const flushPromise = coordinator.flush("story", "chapter");
    calls[0].resolve(chapter("newest", 1));
    await expect(flushPromise).resolves.toMatchObject({ content: "newest", revision: 1 });
  });

  it("serializes a newer draft behind an in-flight request", async () => {
    const { calls, coordinator } = setupCoordinator();
    coordinator.queueDraft("story", "chapter", "first", 0);
    const flushPromise = coordinator.flush("story", "chapter");
    expect(calls).toHaveLength(1);

    coordinator.queueDraft("story", "chapter", "second", 0);
    calls[0].resolve(chapter("first", 1));
    await vi.runAllTicks();
    expect(calls).toHaveLength(2);
    expect(calls[1].request.content).toBe("second");
    expect(calls[1].request.revision).toBe(1);

    calls[1].resolve(chapter("second", 2));
    await expect(flushPromise).resolves.toMatchObject({ content: "second", revision: 2 });
    expect(coordinator.getDraft("story", "chapter")).toBeNull();
  });

  it("does not let an older save response clear a newer local draft", async () => {
    const { calls, coordinator } = setupCoordinator();
    coordinator.queueDraft("story", "chapter", "first", 0);
    const flushPromise = coordinator.flush("story", "chapter");
    coordinator.queueDraft("story", "chapter", "second", 0);

    calls[0].resolve(chapter("first", 1));
    await vi.runAllTicks();

    expect(coordinator.getDraft("story", "chapter")).toBe("second");
    expect(coordinator.getState("story", "chapter").inFlight).toMatchObject({
      content: "second",
      baseRevision: 1,
    });

    calls[1].resolve(chapter("second", 2));
    await flushPromise;
  });

  it("keeps independent chapter queues separate", async () => {
    const { calls, coordinator } = setupCoordinator();
    coordinator.queueDraft("story", "one", "one draft", 0);
    coordinator.queueDraft("story", "two", "two draft", 0);

    const firstFlush = coordinator.flush("story", "one");
    expect(calls).toHaveLength(1);
    expect(calls[0].request.chapterId).toBe("one");
    calls[0].resolve(chapter("one draft", 1, "story", "one"));
    await firstFlush;

    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(calls).toHaveLength(2);
    expect(calls[1].request.chapterId).toBe("two");
    calls[1].resolve(chapter("two draft", 1, "story", "two"));
    await coordinator.flush("story", "two");
  });

  it("loops the flush barrier when typing happens during a save", async () => {
    const { calls, coordinator } = setupCoordinator();
    coordinator.queueDraft("story", "chapter", "first", 0);
    const flushPromise = coordinator.flush("story", "chapter");
    coordinator.queueDraft("story", "chapter", "second", 0);
    calls[0].resolve(chapter("first", 1));
    await vi.runAllTicks();
    calls[1].resolve(chapter("second", 2));

    await expect(flushPromise).resolves.toMatchObject({ content: "second", revision: 2 });
  });

  it("preserves local content and records the server snapshot on conflict", async () => {
    const { calls, coordinator } = setupCoordinator();
    coordinator.queueDraft("story", "chapter", "local draft", 0);
    const flushPromise = coordinator.flush("story", "chapter");
    calls[0].reject({
      status: 409,
      code: "chapter_revision_conflict",
      chapter: chapter("server draft", 1),
    });

    await expect(flushPromise).rejects.toMatchObject({ code: "chapter_revision_conflict" });
    expect(coordinator.getDraft("story", "chapter")).toBe("local draft");
    expect(coordinator.getConfirmedChapter("story", "chapter")).toMatchObject({
      content: "server draft",
      revision: 1,
    });
    expect(coordinator.getState("story", "chapter").state).toBe("conflict");
  });

  it("keeps transient failures retryable", async () => {
    const { calls, coordinator } = setupCoordinator();
    coordinator.queueDraft("story", "chapter", "retry me", 0);
    const firstFlush = coordinator.flush("story", "chapter");
    calls[0].reject(new Error("temporary outage"));
    await expect(firstFlush).rejects.toThrow("temporary outage");
    expect(coordinator.getDraft("story", "chapter")).toBe("retry me");
    expect(coordinator.getState("story", "chapter").state).toBe("failed");

    const retryPromise = coordinator.retry("story", "chapter");
    expect(calls).toHaveLength(2);
    calls[1].resolve(chapter("retry me", 1));
    await expect(retryPromise).resolves.toMatchObject({ revision: 1 });
  });

  it("does not discard queued work when disposed without abandonment", () => {
    const { coordinator } = setupCoordinator();
    coordinator.queueDraft("story", "chapter", "keep me", 0);

    expect(coordinator.dispose()).toBe(false);
    expect(coordinator.getPendingDrafts()).toEqual([
      {
        storyId: "story",
        chapterId: "chapter",
        content: "keep me",
        baseRevision: 0,
      },
    ]);

    expect(coordinator.dispose({ abandon: true })).toBe(true);
    expect(coordinator.getPendingDrafts()).toEqual([]);
  });
});
