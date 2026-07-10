import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePolling } from "../src/api";

/** Temporarily overrides document.hidden; returns a restore function. */
function setDocumentHidden(getter: () => boolean): () => void {
  Object.defineProperty(document, "hidden", { configurable: true, get: getter });
  return () => {
    delete (document as { hidden?: boolean }).hidden;
  };
}

describe("usePolling", () => {
  it("loads immediately and clears loading on success", async () => {
    const fetcher = vi.fn().mockResolvedValue("first");

    const { result } = renderHook(() => usePolling(fetcher, 5000));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe("first");
    expect(result.current.error).toBeNull();
    expect(result.current.lastUpdated).toBeInstanceOf(Date);
  });

  it("refreshes on the interval without re-entering loading", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");

    const { result } = renderHook(() => usePolling(fetcher, 5000));
    await act(async () => {}); // flush the initial tick

    expect(result.current.data).toBe("first");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(result.current.data).toBe("second");
    expect(result.current.loading).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps stale data and sets error when a refresh fails", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce("good")
      .mockRejectedValueOnce(new Error("boom"));

    const { result } = renderHook(() => usePolling(fetcher, 5000));
    await act(async () => {});

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(result.current.data).toBe("good");
    expect(result.current.error).toBe("boom");
  });

  it("skips ticks while the document is hidden and resumes when visible", async () => {
    vi.useFakeTimers();
    let hidden = true;
    const restore = setDocumentHidden(() => hidden);
    const fetcher = vi.fn().mockResolvedValue("data");

    const { result } = renderHook(() => usePolling(fetcher, 5000));
    await act(async () => {});

    expect(fetcher).not.toHaveBeenCalled();

    hidden = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBe("data");
    restore();
  });

  it("stops polling after unmount", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue("data");

    const { unmount } = renderHook(() => usePolling(fetcher, 5000));
    await act(async () => {});
    expect(fetcher).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
