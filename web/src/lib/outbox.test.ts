import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { canEditHeld, HeldError, Outbox, reconcileCapture, sendCapture, type OutboxItem, type OutboxStorage } from "./outbox";

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
    // The server created it without confirming keywords: saved, so the caller must not keep the draft for a resave.
    const unverified = new HeldError("unverified", "Recall answered, but couldn't confirm this memory's keywords were saved.");
    expect(await new Outbox(broken, scripted(unverified).send).save(item("c"))).toBe("unconfirmed");
    const unsupported = new HeldError("unsupported", "This Recall server can't save keywords yet, so nothing was uploaded.");
    await expect(new Outbox(broken, scripted(unsupported).send).save(item("d"))).rejects.toThrow("can't save keywords");
  });

  it("tells the caller the memory is stored before the upload starts", async () => {
    const { storage, saved } = memoryStorage();
    const events: string[] = [];
    const outbox = new Outbox(storage, async (entry) => {
      events.push(`send ${entry.clientId} stored=${saved.has(entry.clientId)}`);
    });
    expect(await outbox.save(item("a"), () => events.push("stored"))).toBe("sent");
    expect(events).toEqual(["stored", "send a stored=true"]);
  });
});

/**
 * A fictional server behind `fetch`. `version` "old" ignores customKeywords and has no capability; "old-shape" also
 * omits the field from responses; "new" saves keywords and reconciles. Records are keyed by clientId.
 */
class FakeServer {
  version: "old" | "old-shape" | "new" = "new";
  offline = false;
  /** The next create reaches the server, then the response is lost. */
  dropNextResponse = false;
  readonly records = new Map<string, { id: number; body: string; customKeywords: string[]; photos: number; receipt: boolean; updatedAt: number }>();
  readonly calls: string[] = [];
  private clock = 1000;

  /** A later edit on another device: changes the record and its updatedAt. */
  edit(clientId: string, customKeywords: string[]): void {
    const record = this.records.get(clientId)!;
    record.customKeywords = customKeywords;
    record.updatedAt = ++this.clock;
  }

  readonly fetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const route = `${init.method ?? "GET"} ${path}`;
    this.calls.push(route);
    if (this.offline) throw new TypeError("Failed to fetch");
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    if (route === "GET /api/me") return json(this.version === "new" ? { aiEnabled: false, capabilities: ["keyword-capture"] } : { aiEnabled: false });
    if (route === "POST /api/memories") {
      const form = init.body as FormData;
      const clientId = String(form.get("clientId"));
      let record = this.records.get(clientId);
      const status = record ? 200 : 201;
      if (!record) {
        const keywords = this.version === "new" ? (form.getAll("customKeywords") as string[]) : [];
        record = {
          id: this.records.size + 1,
          body: String(form.get("body")),
          customKeywords: keywords,
          photos: form.getAll("photos").length,
          receipt: this.version === "new",
          updatedAt: ++this.clock,
        };
        this.records.set(clientId, record);
      }
      if (this.dropNextResponse) {
        this.dropNextResponse = false;
        throw new TypeError("Failed to fetch");
      }
      const { receipt: _receipt, customKeywords, ...shape } = record;
      return json(this.version === "old-shape" ? shape : { ...shape, customKeywords }, status);
    }
    if (route === "POST /api/memories/reconcile" && this.version === "new") {
      // Same contract as MemoryStore.reconcile: only untouched records or an explicit, current "add" are merged.
      const request = JSON.parse(String(init.body)) as { clientId: string; customKeywords: string[]; expectedUpdatedAt?: number | null; resolution?: string | null };
      const record = this.records.get(request.clientId);
      if (!record) return json({ status: "missing", memory: null });
      if (record.receipt) return json({ status: "already-saved", memory: record });
      const keys = new Set(record.customKeywords.map((keyword) => keyword.toLowerCase()));
      const missing = request.customKeywords.filter((keyword) => !keys.has(keyword.toLowerCase()));
      if (missing.length === 0 || request.resolution === "keep") {
        record.receipt = true;
        return json({ status: missing.length === 0 ? "reconciled" : "kept", memory: record });
      }
      const untouched = request.expectedUpdatedAt === record.updatedAt && (request.resolution === "add" || record.customKeywords.length === 0);
      if (!untouched) return json({ status: "conflict", memory: record, missingKeywords: missing });
      record.customKeywords = [...record.customKeywords, ...missing];
      record.updatedAt = ++this.clock;
      record.receipt = true;
      return json({ status: "reconciled", memory: record });
    }
    return json({ error: "not_found", message: "Unknown API route." }, 404);
  };

  creates(): number {
    return this.calls.filter((call) => call === "POST /api/memories").length;
  }
}

describe("keyword captures across server versions", () => {
  let server: FakeServer;
  const setup = (initial: OutboxItem[] = []) => {
    server = new FakeServer();
    vi.stubGlobal("fetch", server.fetch);
    const { storage, saved } = memoryStorage(initial);
    return { outbox: new Outbox(storage, sendCapture, reconcileCapture), saved };
  };
  const photo = { full: new Blob(["full"]), thumb: new Blob(["thumb"]) };
  const keyworded = (clientId: string, createdAt = 1): OutboxItem => ({
    clientId,
    body: `lights ${clientId}`,
    createdAt,
    photos: [photo],
    customKeywords: ["Christmas", "Garage"],
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends legacy queued items (no keyword field) to any server version", async () => {
    const legacy = { clientId: "legacy-0001", body: "old queued note", createdAt: 1, photos: [] } as OutboxItem;
    const { outbox, saved } = setup([legacy]);
    server.version = "old";
    await outbox.flush();
    expect(saved.size).toBe(0);
    expect(server.records.get("legacy-0001")).toMatchObject({ body: "old queued note", customKeywords: [] });
    expect(server.calls).toEqual(["POST /api/memories"]);
  });

  it("holds keyword captures for a server without the capability, uploading nothing and never retrying", async () => {
    const { outbox, saved } = setup();
    server.version = "old";
    expect(await outbox.save(keyworded("held-0001"))).toBe("held");
    expect(server.creates()).toBe(0);
    const stored = saved.get("held-0001")!;
    expect(stored).toMatchObject({ body: "lights held-0001", customKeywords: ["Christmas", "Garage"], held: { reason: "unsupported" } });
    expect(stored.photos).toEqual([photo]);
    expect(canEditHeld(stored)).toBe(true); // nothing can be on the server: editing is safe
    await outbox.flush();
    await outbox.flush();
    expect(server.calls).toEqual(["GET /api/me"]);
    // Still old: recovery keeps everything held with an explanation.
    expect(await outbox.recover("held-0001")).toBe("held");
    expect(saved.get("held-0001")!.held!.message).toMatch(/can't save keywords/);
    // After the server update the user recovers it: uploaded once, with its keywords.
    server.version = "new";
    expect(await outbox.recover("held-0001")).toBe("recovered");
    expect(server.records.get("held-0001")).toMatchObject({ customKeywords: ["Christmas", "Garage"], photos: 1 });
    expect(server.creates()).toBe(1);
    expect(saved.size).toBe(0);
  });

  /** A server that advertises support but answers without saved keywords (old shape or persistence mismatch). */
  const claimCapability = () => {
    const original = server.fetch;
    vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
      if (path === "/api/me" && server.version !== "new" && claiming) return new Response(JSON.stringify({ capabilities: ["keyword-capture"] }), { status: 200 });
      return original(path, init);
    });
  };
  let claiming = true;

  it("holds a successful response that lost the keywords, then reconciles an untouched record once", async () => {
    for (const version of ["old-shape", "old"] as const) {
      const { outbox, saved } = setup();
      claimCapability();
      server.version = version;
      expect(await outbox.save(keyworded("mismatch-01"))).toBe("held");
      const held = saved.get("mismatch-01")!;
      expect(held).toMatchObject({ held: { reason: "unverified", savedUpdatedAt: server.records.get("mismatch-01")!.updatedAt }, customKeywords: ["Christmas", "Garage"], uploadStarted: true });
      expect(canEditHeld(held)).toBe(false);
      await outbox.flush();
      expect(server.creates()).toBe(1);
      server.version = "new";
      expect(await outbox.recover("mismatch-01")).toBe("recovered");
      expect(server.records.size).toBe(1);
      expect(server.records.get("mismatch-01")!.customKeywords).toEqual(["Christmas", "Garage"]);
      expect(server.creates()).toBe(1);
      expect(saved.size).toBe(0);
    }
  });

  it("turns a recall edited since the capture into an explicit conflict: add or keep, never a silent merge", async () => {
    for (const resolution of ["add", "keep"] as const) {
      const { outbox, saved } = setup();
      claimCapability();
      server.version = "old";
      expect(await outbox.save(keyworded("conflict-01"))).toBe("held");
      server.edit("conflict-01", ["Shelf"]); // e.g. Garage added then removed elsewhere, Shelf kept
      server.version = "new";
      expect(await outbox.recover("conflict-01")).toBe("held");
      const conflicted = saved.get("conflict-01")!;
      expect(conflicted.held).toMatchObject({ reason: "conflict", conflict: { keywords: ["Shelf"], missing: ["Christmas", "Garage"] } });
      expect(server.records.get("conflict-01")!.customKeywords).toEqual(["Shelf"]);
      expect(canEditHeld(conflicted)).toBe(false);
      // Another edit before the user decides: "add" against the stale view becomes a fresh conflict, not an overwrite.
      server.edit("conflict-01", ["Shelf", "Porch"]);
      if (resolution === "add") {
        expect(await outbox.recover("conflict-01", "add")).toBe("held");
        expect(saved.get("conflict-01")!.held!.conflict!.keywords).toEqual(["Shelf", "Porch"]);
      }
      expect(await outbox.recover("conflict-01", resolution)).toBe("recovered");
      expect(server.records.get("conflict-01")!.customKeywords).toEqual(
        resolution === "add" ? ["Shelf", "Porch", "Christmas", "Garage"] : ["Shelf", "Porch"],
      );
      expect(server.records.size).toBe(1);
      expect(server.creates()).toBe(1);
      expect(saved.size).toBe(0);
    }
  });

  it("never downgrades a possibly-saved capture to never-uploaded when recovery meets an old server, even after a reload", async () => {
    const { outbox, saved } = setup();
    claimCapability();
    server.version = "old";
    expect(await outbox.save(keyworded("downgrade-01"))).toBe("held");
    claiming = false; // the server really lacks the capability now
    expect(await outbox.recover("downgrade-01")).toBe("held");
    const held = saved.get("downgrade-01")!;
    expect(held.held).toMatchObject({ reason: "unverified" });
    expect(held.held!.message).toMatch(/may already have this memory/);
    expect(canEditHeld(held)).toBe(false);
    // A reload (new outbox over the same storage) keeps the original clientId and the reconcilable state.
    const reloaded = new Outbox(memoryStorage([...saved.values()]).storage, sendCapture, reconcileCapture);
    await reloaded.flush();
    const restored = reloaded.snapshot().find((entry) => entry.clientId === "downgrade-01")!;
    expect(restored.held!.reason).toBe("unverified");
    expect(canEditHeld(restored)).toBe(false);
    expect(server.creates()).toBe(1);
    server.version = "new";
    claiming = true;
    expect(await reloaded.recover("downgrade-01")).toBe("recovered");
    expect(server.records.size).toBe(1);
    expect(server.records.get("downgrade-01")!.customKeywords).toEqual(["Christmas", "Garage"]);
    expect(server.creates()).toBe(1);
  });

  it("holds an interrupted upload followed by capability loss as reconcilable, then resolves it without a duplicate", async () => {
    const { outbox, saved } = setup();
    server.dropNextResponse = true;
    expect(await outbox.save(keyworded("interrupt-2"))).toBe("queued");
    expect(saved.get("interrupt-2")!.uploadStarted).toBe(true);
    server.version = "old"; // rolled back mid-retry, or a stale instance answers
    await outbox.flush();
    const held = saved.get("interrupt-2")!;
    expect(held.held!.reason).toBe("unverified");
    expect(canEditHeld(held)).toBe(false);
    expect(server.creates()).toBe(1);
    server.version = "new";
    expect(await outbox.recover("interrupt-2")).toBe("recovered");
    expect(server.records.size).toBe(1);
    expect(server.creates()).toBe(1);
  });

  it("never anchors on a retry's 200 response: a lost old-server response plus later add/remove stays an explicit conflict", async () => {
    // Shelf kept (removal of Garage only) and everything removed (no keywords left): both must not restore Garage.
    for (const later of [["Shelf"], []]) {
      for (const resolution of ["add", "keep"] as const) {
        const { outbox, saved } = setup();
        claimCapability();
        server.version = "old"; // a split rollout: the create lands on an old instance
        server.dropNextResponse = true;
        const capture: OutboxItem = { ...keyworded("lost-old-01"), customKeywords: ["Garage", "Porch"] };
        expect(await outbox.save(capture)).toBe("queued");
        server.edit("lost-old-01", ["Garage", "Shelf"]);
        server.edit("lost-old-01", later); // Garage removed on purpose
        await outbox.flush(); // the retry gets 200 with the edited record
        const held = saved.get("lost-old-01")!;
        expect(held.held).toMatchObject({ reason: "unverified", savedUpdatedAt: null });
        expect(canEditHeld(held)).toBe(false);
        // A reload keeps it held with its original clientId and all content.
        const reloaded = new Outbox(memoryStorage([...saved.values()]).storage, sendCapture, reconcileCapture);
        await reloaded.flush();
        expect(reloaded.snapshot()[0]).toMatchObject({ clientId: "lost-old-01", customKeywords: ["Garage", "Porch"], photos: [photo], held: { reason: "unverified" } });
        server.version = "new";
        expect(await reloaded.recover("lost-old-01")).toBe("held");
        expect(reloaded.snapshot()[0]!.held).toMatchObject({ reason: "conflict", conflict: { keywords: later, missing: ["Garage", "Porch"] } });
        expect(server.records.get("lost-old-01")!.customKeywords).toEqual(later);
        expect(await reloaded.recover("lost-old-01")).toBe("held"); // repeated recovery: still no silent merge
        expect(server.records.get("lost-old-01")!.customKeywords).toEqual(later);
        expect(await reloaded.recover("lost-old-01", resolution)).toBe("recovered");
        expect(server.records.get("lost-old-01")!.customKeywords).toEqual(resolution === "add" ? [...later, "Garage", "Porch"] : later);
        expect(server.records.size).toBe(1);
        expect(server.creates()).toBe(2); // the lost first create and its retry; recovery never creates again
      }
    }
  });

  it("asks before uploading again a possibly-saved capture the server no longer has (deleted elsewhere)", async () => {
    const { outbox, saved } = setup();
    claimCapability();
    server.version = "old";
    expect(await outbox.save(keyworded("deleted-01"))).toBe("held");
    server.records.delete("deleted-01"); // deleted on another device; its receipt goes with it
    server.version = "new";
    expect(await outbox.recover("deleted-01")).toBe("held");
    const held = saved.get("deleted-01")!;
    expect(held.held).toMatchObject({ reason: "missing" });
    expect(canEditHeld(held)).toBe(false);
    expect(await outbox.recover("deleted-01")).toBe("held"); // repeated recovery still doesn't re-create it
    expect(await outbox.recover("deleted-01", "keep")).toBe("held");
    expect(server.records.size).toBe(0);
    expect(server.creates()).toBe(1);
    // Only the user's explicit choice uploads it again, with the original clientId.
    expect(await outbox.recover("deleted-01", "upload")).toBe("recovered");
    expect(server.records.get("deleted-01")!.customKeywords).toEqual(["Christmas", "Garage"]);
    expect(server.creates()).toBe(2);
    expect(saved.size).toBe(0);
  });

  it("holds a refused retry for reconciliation when an earlier attempt may have saved it", async () => {
    const { storage, saved } = memoryStorage([{ ...item("refused-01"), uploadStarted: true }]);
    const outbox = new Outbox(storage, scripted(new ApiError(413, "too_large", "That upload is too large.")).send);
    await outbox.flush();
    expect(saved.get("refused-01")!.held!.reason).toBe("unverified");
    expect(saved.get("refused-01")!.error).toBeUndefined();
    expect(canEditHeld(saved.get("refused-01")!)).toBe(false);
  });

  it("retries an interrupted upload whose first request reached the server exactly once", async () => {
    const { outbox, saved } = setup();
    server.dropNextResponse = true;
    expect(await outbox.save(keyworded("interrupt-1"))).toBe("queued");
    expect(server.records.size).toBe(1);
    await outbox.flush();
    expect(saved.size).toBe(0);
    expect(server.records.size).toBe(1);
    expect(server.records.get("interrupt-1")!.customKeywords).toEqual(["Christmas", "Garage"]);
  });

  it("keeps keyword captures queued (not held) while offline", async () => {
    const { outbox, saved } = setup();
    server.offline = true;
    expect(await outbox.save(keyworded("offline-01"))).toBe("queued");
    expect(saved.get("offline-01")!.held).toBeUndefined();
    server.offline = false;
    await outbox.flush();
    expect(saved.size).toBe(0);
    expect(server.records.get("offline-01")!.customKeywords).toEqual(["Christmas", "Garage"]);
  });
});
