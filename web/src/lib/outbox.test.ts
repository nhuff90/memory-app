import { describe, expect, it } from "vitest";
import { ApiError } from "../api";
import { Outbox, type OutboxItem, type OutboxStorage } from "./outbox";

function memoryStorage(initial: OutboxItem[] = []) {
  const saved = new Map(initial.map((item) => [item.clientId, item]));
  const storage: OutboxStorage = {
    all: async () => [...saved.values()],
    put: async (item) => void saved.set(item.clientId, item),
    remove: async (clientId) => void saved.delete(clientId),
  };
  return { storage, saved };
}

const item = (clientId: string, createdAt = 1): OutboxItem => ({ clientId, body: `note ${clientId}`, createdAt, photos: [] });
const offline = () => new ApiError(0, "offline", "Can't reach Recall right now.");

/** A send function that fails or succeeds in the given order, then succeeds. */
function scripted(...outcomes: (Error | "ok")[]) {
  const calls: string[] = [];
  const send = async (entry: OutboxItem) => {
    calls.push(entry.clientId);
    const outcome = outcomes.shift() ?? "ok";
    if (outcome !== "ok") throw outcome;
  };
  return { send, calls };
}

describe("Outbox", () => {
  it("uploads right away when online and keeps nothing", async () => {
    const { storage, saved } = memoryStorage();
    const { send, calls } = scripted();
    const outbox = new Outbox(storage, send);
    let sent = 0;
    outbox.onSent(() => sent++);

    expect(await outbox.save(item("a"))).toBe("sent");
    expect(calls).toEqual(["a"]);
    expect(saved.size).toBe(0);
    expect(outbox.snapshot()).toEqual([]);
    expect(sent).toBe(1);
  });

  it("keeps a memory saved offline and retries it with the same id", async () => {
    const { storage, saved } = memoryStorage();
    const { send, calls } = scripted(offline(), offline());
    const outbox = new Outbox(storage, send);

    expect(await outbox.save(item("a"))).toBe("queued");
    expect([...saved.keys()]).toEqual(["a"]);
    await outbox.flush();
    expect(outbox.snapshot().map((entry) => entry.clientId)).toEqual(["a"]);
    await outbox.flush();
    expect(calls).toEqual(["a", "a", "a"]);
    expect(saved.size).toBe(0);
    expect(outbox.snapshot()).toEqual([]);
  });

  it("picks up where it left off after the app restarts, oldest first", async () => {
    const { storage } = memoryStorage([item("newer", 2), item("older", 1)]);
    const { send, calls } = scripted();
    const outbox = new Outbox(storage, send);
    await outbox.flush();
    expect(calls).toEqual(["older", "newer"]);
  });

  it("stops at the first network failure so the order is kept", async () => {
    const { storage } = memoryStorage([item("a", 1), item("b", 2)]);
    const { send, calls } = scripted(offline());
    await new Outbox(storage, send).flush();
    expect(calls).toEqual(["a"]);
  });

  it("waits, without an error, while signed out or when the server is struggling", async () => {
    const { storage } = memoryStorage([item("a")]);
    const { send } = scripted(new ApiError(401, "unauthorized", "Please log in."), new ApiError(503, "x", "Down"));
    const outbox = new Outbox(storage, send);
    await outbox.flush();
    await outbox.flush();
    expect(outbox.snapshot()).toEqual([item("a")]);
  });

  it("sets aside a memory the server refuses and carries on with the rest", async () => {
    const { storage, saved } = memoryStorage([item("a", 1), item("b", 2)]);
    const { send, calls } = scripted(new ApiError(413, "too_large", "That photo is too large."));
    const outbox = new Outbox(storage, send);

    await outbox.flush();
    expect(calls).toEqual(["a", "b"]);
    expect(outbox.snapshot()).toEqual([{ ...item("a", 1), error: "That photo is too large." }]);
    expect(saved.get("a")?.error).toBe("That photo is too large.");

    await outbox.flush();
    expect(calls).toEqual(["a", "b"]);
    await outbox.discard("a");
    expect(outbox.snapshot()).toEqual([]);
    expect(saved.size).toBe(0);
  });

  it("says when a new memory was refused", async () => {
    const { storage } = memoryStorage();
    const { send } = scripted(new ApiError(400, "bad_request", "Type something or add a photo first."));
    expect(await new Outbox(storage, send).save(item("a"))).toBe("rejected");
  });

  it("sends memories saved during an upload in the same pass", async () => {
    const { storage } = memoryStorage();
    const calls: string[] = [];
    let started!: () => void;
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const outbox = new Outbox(storage, async (entry) => {
      calls.push(entry.clientId);
      if (entry.clientId === "a") {
        started();
        await gate;
      }
    });

    const first = outbox.save(item("a", 1));
    await inFlight;
    const second = outbox.save(item("b", 2));
    release();
    expect(await first).toBe("sent");
    expect(await second).toBe("sent");
    expect(calls).toEqual(["a", "b"]);
  });

  it("uploads directly when the device can't store anything, and reports failures", async () => {
    const broken: OutboxStorage = {
      all: async () => [],
      put: async () => {
        throw new Error("QuotaExceededError");
      },
      remove: async () => {},
    };
    expect(await new Outbox(broken, scripted().send).save(item("a"))).toBe("sent");
    await expect(new Outbox(broken, scripted(offline()).send).save(item("b"))).rejects.toThrow("Can't reach Recall");
  });
});
