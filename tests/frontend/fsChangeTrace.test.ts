import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { traceFsChange, setFsChangeTracingForTests } from "../../src/lib/ipc/fsChangeTrace";

// The diagnostic for issue #470 sits directly in the `fs:changed` path, so it
// has to be silent and non-throwing when it is off — which is always, unless
// someone has explicitly set the flag.
describe("fsChangeTrace", () => {
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    setFsChangeTracingForTests(undefined);
    info = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    info.mockRestore();
    setFsChangeTracingForTests(undefined);
  });

  it("logs nothing when the flag is unset", () => {
    traceFsChange("received", { path: "/a" });
    expect(info).not.toHaveBeenCalled();
  });

  it("logs the stage and detail when the flag is set", () => {
    localStorage.setItem("atrium.debug.fsChanges", "1");
    traceFsChange("routed", { accepted: false, path: "/a" });
    expect(info).toHaveBeenCalledWith("[atrium fs:changed] routed", { accepted: false, path: "/a" });
  });

  it("stays silent when localStorage itself throws", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    try {
      expect(() => traceFsChange("received", { path: "/a" })).not.toThrow();
      expect(info).not.toHaveBeenCalled();
    } finally {
      getItem.mockRestore();
    }
  });
});
